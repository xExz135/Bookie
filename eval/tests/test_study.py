"""The user study report (spec 9, FE-10, D-027) on synthetic participants."""

from __future__ import annotations

import numpy as np

from bookie_eval import study
from bookie_eval.params import load_params


def participant(actual, model, baseline):
    return study.Participant(
        actual=np.array(actual, dtype=float),
        model=np.array(model, dtype=float),
        baseline=np.array(baseline, dtype=float),
        model_ids=["B3"] * len(actual),
        model_version="2026-10-21.6533ea0e",
    )


def test_model_against_baseline_is_paired_and_reproducible():
    params = load_params()
    rng = np.random.default_rng(3)
    people = []
    for _ in range(12):
        actual = rng.integers(1, 6, size=5).astype(float)
        people.append(participant(actual, actual + rng.normal(0, 0.4, 5), np.full(5, 3.9) + rng.normal(0, 0.05, 5)))
    r = study.compute(people, {"accurate": 7, "not_for_me": 3}, params)
    assert r["readers"] == 12 and r["heldOutBooks"] == 60
    # A model that tracks the ratings beats a near-constant baseline on both metrics.
    assert r["model"]["spearman"]["value"] > r["baseline"]["spearman"]["value"]
    assert r["difference"]["spearman"]["low"] > 0
    assert r["difference"]["mae"]["high"] < 0
    assert r == study.compute(people, {"accurate": 7, "not_for_me": 3}, params)
    assert r["feedback"]["hits"] == 7 and r["feedback"]["n"] == 10
    assert abs(r["feedback"]["low"] - 0.3968) < 1e-3


def test_a_reader_with_all_equal_ratings_has_no_spearman():
    params = load_params()
    people = [participant([4, 4, 4, 4, 4], [3, 4, 5, 2, 1], [4, 4, 4, 4, 4]), participant([1, 2, 3, 4, 5], [1, 2, 3, 4, 5], [3, 3, 3, 3, 3])]
    r = study.compute(people, {}, params)
    assert r["model"]["spearman"]["readers"] == 1
    assert r["model"]["spearman"]["value"] == 1.0
    # B0 gives every book the same score here: Spearman 0 (says nothing about the order).
    assert r["baseline"]["spearman"]["value"] == 0.0
    assert r["model"]["mae"]["readers"] == 2
    assert r["feedback"]["value"] is None


def test_no_participants_yet_still_reports():
    r = study.compute([], {}, load_params())
    assert r["readers"] == 0 and r["model"] is None
    md = study.markdown(r)
    assert "0 readers" in md and "No reader has taken part yet." in md and "none yet" in md
    few = study.compute([participant([1, 2, 3, 4, 5], [2, 2, 3, 4, 4], [3, 3, 3, 3, 3])], {}, load_params())
    assert "about 30 readers; this report has 1" in study.markdown(few)
