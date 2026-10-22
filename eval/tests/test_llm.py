"""The LLM evaluation scoring (BE-15, D-028) on synthetic committed files."""

from __future__ import annotations

import copy
import json

import numpy as np

from bookie_eval import llm
from bookie_eval.params import load_params

PACES = ["slow", "moderate", "fast"]
TONES = ["dark", "light", "tense", "hopeful"]
INTENSITY = ["low", "moderate", "high"]
THEMES = ["family", "survival", "friendship", "war and conflict", "identity"]


def synthetic(n: int = 60, noise: float = 0.3, seed: int = 4) -> dict:
    rng = np.random.default_rng(seed)
    ids = [f"book-{i:03d}" for i in range(n)]
    reference, small, large = {}, {}, {}
    for i, e in enumerate(ids):
        ref = {
            "pace": PACES[i % 3] if i % 10 else "unknown",
            "tone": TONES[i % 4],
            "contentIntensity": INTENSITY[(i // 2) % 3],
            "themes": sorted({THEMES[i % 5], THEMES[(i * 3) % 5]}),
        }
        reference[e] = ref
        # The small model copies the reference exactly; the large one is noisy.
        small[e] = {**copy.deepcopy(ref), "attempts": 1, "inputTokens": 9000, "outputTokens": 300}
        noisy = copy.deepcopy(ref)
        if rng.random() < noise:
            noisy["tone"] = TONES[(i + 1) % 4]
        if rng.random() < noise:
            noisy["themes"] = [THEMES[(i + 2) % 5]]
        large[e] = {**noisy, "attempts": 1, "inputTokens": 9000, "outputTokens": 300}
    large[ids[1]] = {"error": "invalid_output", "inputTokens": 9000, "outputTokens": 600}
    claims = [
        {"key": f"c{i}", "editionId": ids[i], "kind": "praise" if i % 2 else "complaint", "text": "x",
         "citedDatasetReviewIds": ["r"], "label": "supported" if i % 5 else "not_supported", "reason": "r", "error": None}
        for i in range(40)
    ]
    return {
        "manifest": {
            "traitPromptVersion": "traits-v1",
            "summaryPromptVersion": "summary-v1",
            "models": {"small": "gemini-3.5-flash-lite", "large": "gemini-3.6-flash", "summary": "gemini-3.5-flash-lite", "reference": "gemini-3.8-flash"},
        },
        "set": {"books": [{"editionId": e, "goodreadsBookId": str(i), "title": e} for i, e in enumerate(ids)]},
        "reference": {"model": "gemini-3.8-flash", "instructionsSha256": "abc", "books": reference},
        "outputs": {
            "small": {"model": "gemini-3.5-flash-lite", "books": small},
            "large": {"model": "gemini-3.6-flash", "books": large},
        },
        "claims": {
            "summaryModel": "gemini-3.5-flash-lite", "judgeModel": "gemini-3.8-flash", "seed": 1,
            "summaries": [{"editionId": ids[0], "error": None, "attempts": 2, "claims": 8}],
            "claims": claims,
        },
    }


def test_a_model_that_matches_the_reference_scores_one_and_beats_a_noisy_one():
    params = load_params()
    r = llm.compute(synthetic(), params)
    small, large = r["models"]["small"], r["models"]["large"]
    assert r["books"] == 60
    assert small["overallMacroF1"]["value"] == 1.0
    assert small["traits"]["pace"]["accuracy"]["value"] == 1.0
    # Books the reference does not know are left out of that trait.
    assert small["traits"]["pace"]["referenceUnknown"] == 6
    assert large["overallMacroF1"]["value"] < 1.0
    assert large["failed"] == 1
    d = r["difference"]
    assert d["overallMacroF1SmallMinusLarge"]["low"] > 0
    assert d["smallShareOfLargeScore"] > 1.0
    # Same tokens: the share of cost is the price ratio, except the failed book's extra output.
    assert 0.3 < d["smallShareOfLargeCost"] < 0.6
    assert r == llm.compute(synthetic(), params)


def test_claim_support_rate_with_wilson_interval():
    r = llm.compute(synthetic(), load_params())
    c = r["claims"]
    assert c["judged"] == 40
    assert c["supported"]["hits"] == 32 and c["supported"]["n"] == 40
    assert c["supported"]["low"] < 0.8 < c["supported"]["high"]
    assert c["summaries"] == {"books": 1, "invalidTwice": 0, "retriedOnce": 1}


def test_regression_check_fails_only_on_a_drop_beyond_the_threshold():
    params = load_params()
    good = llm.compute(synthetic(noise=0.1), params)
    baseline = {"metrics": llm.headline(good)}
    assert llm.check(good, baseline, params) == []
    assert llm.check(good, None, params) == []
    worse = llm.compute(synthetic(noise=0.9), params)
    problems = llm.check(worse, baseline, params)
    assert any(p.startswith("large.overallMacroF1") for p in problems)
    assert not any(p.startswith("small.") for p in problems)


def test_report_says_the_labels_come_from_a_model(tmp_path):
    r = llm.compute(synthetic(), load_params())
    md = llm.markdown(r)
    assert "a model, not hand labels" in md
    assert "32 of 40 sampled claims" in md
    out = llm.write(r, tmp_path)
    assert json.loads((out / "results.json").read_text("utf-8"))["books"] == 60


def test_no_outputs_yet(tmp_path):
    assert llm.load(tmp_path) is None


def test_hand_labels_become_the_trait_reference_and_score_the_reference_model():
    """D-028 update: the owner's labels replace the reference model's for traits."""
    data = synthetic()
    ids = [b["editionId"] for b in data["set"]["books"]]
    # The person labelled 40 of the 60 books; on 10 of them the reference model disagrees on tone.
    hand = {e: copy.deepcopy(data["reference"]["books"][e]) for e in ids[:40]}
    for e in ids[:10]:
        data["reference"]["books"][e]["tone"] = "light" if hand[e]["tone"] != "light" else "dark"
    data["hand"] = {"labelled": 40, "of": 60, "books": hand}
    r = llm.compute(data, load_params())
    assert r["books"] == 40
    assert r["provenance"]["traitReference"] == "hand"
    # The small model copied the reference model's original labels, which equal the person's.
    assert r["models"]["small"]["traits"]["tone"]["accuracy"]["value"] == 1.0
    assert r["models"]["reference"]["traits"]["tone"]["accuracy"]["value"] == 30 / 40
    # The regression check still watches the measured models only.
    assert not any(k.startswith("reference.") for k in llm.headline(r))
    md = llm.markdown(r)
    assert "the owner's hand labels (40 of 60 books labelled" in md
    assert "(reference labeller)" in md


def test_without_hand_labels_nothing_changes():
    data = synthetic()
    data["hand"] = None
    r = llm.compute(data, load_params())
    assert r["provenance"]["traitReference"] == "model"
    assert set(r["models"]) == {"small", "large"}


def test_the_small_model_alone_is_scored_when_the_large_model_has_not_run():
    """D-028 update: the large model is optional on the free tier; comparisons stay paired."""
    data = synthetic()
    ids = [b["editionId"] for b in data["set"]["books"]]
    data["outputs"]["large"]["books"] = {e: data["outputs"]["large"]["books"][e] for e in ids[:30]}
    r = llm.compute(data, load_params())
    assert r["books"] == 60
    assert set(r["models"]) == {"small"}
    assert r["difference"] == {}
    assert "large.overallMacroF1" not in llm.headline(r)
    assert "no small-versus-large comparison yet" in llm.markdown(r)


def test_answers_reused_without_tokens_have_an_unknown_cost_not_zero():
    data = synthetic()
    for row in data["outputs"]["small"]["books"].values():
        row.pop("inputTokens", None)
        row.pop("outputTokens", None)
    r = llm.compute(data, load_params())
    small = r["models"]["small"]
    assert small["tokensRecorded"] is False
    assert small["costPerBookUsd"] is None
    assert r["difference"]["smallShareOfLargeCost"] is None
    assert "not recorded" in llm.markdown(r)
