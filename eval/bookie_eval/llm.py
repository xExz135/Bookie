"""The LLM evaluation (BE-15, spec 9, D-028): trait extraction and summary faithfulness.

Reads only the committed files in eval/llm/ (labels, IDs and model output; no
review text), so it reproduces anywhere, including CI:

- set.json: the evaluation books (a seeded sample of the catalog).
- hand-traits.json: the owner's hand labels (D-028 update), imported from the
  labelling workbook by `label-import`. When present, they are the trait
  reference, and the reference model is scored against them too (how well an
  LLM labeller agrees with a person).
- reference-traits.json: labels from a stronger model following
  traits-instructions.md; the trait reference while there are no hand labels.
- traits/<model>.json: each measured model's traits and token use per book.
- claims.json: a seeded sample of golden-summary claims, each judged
  supported or not supported by the reference model (claims-instructions.md).

Trait metrics, per trait, over the books whose reference value is known:
- pace, tone, content intensity (one value each): accuracy, and macro-F1 over the
  values the reference uses. A model answering "unknown", or failing, is wrong.
- themes (up to five): per-theme F1 over books, macro-averaged over the themes the
  reference uses; also the mean Jaccard overlap per book.
- overall: the mean of the four macro-F1 scores.
Intervals: 95% percentile bootstrap over books, seeded, the same resamples for
both models, so their difference is paired.

    python -m bookie_eval llm            # writes eval/results/llm/
    python -m bookie_eval llm --check    # fail when a metric dropped beyond its threshold (EVAL-4)
    python -m bookie_eval llm --accept   # make the current metrics the baseline
"""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any

import numpy as np

from .params import EVAL_DIR

LLM_DIR = EVAL_DIR / "llm"
RESULTS_DIR = EVAL_DIR / "results" / "llm"
BASELINE = LLM_DIR / "baseline.json"
SINGLE = ("pace", "tone", "contentIntensity")
TRAITS = SINGLE + ("themes",)


def _read(path: Path) -> Any:
    return json.loads(path.read_text("utf-8")) if path.exists() else None


def load(directory: Path = LLM_DIR) -> dict[str, Any] | None:
    """The committed files, or None when the evaluation has not been run yet."""
    manifest = _read(directory / "manifest.json")
    if manifest is None:
        return None
    models = manifest["models"]
    return {
        "manifest": manifest,
        "set": _read(directory / "set.json"),
        "hand": _read(directory / "hand-traits.json"),
        "reference": _read(directory / "reference-traits.json"),
        "outputs": {
            role: _read(directory / "traits" / f"{models[role]}.json") for role in ("small", "large")
        },
        "claims": _read(directory / "claims.json"),
    }


def _f1(tp: float, fp: float, fn: float) -> float:
    return 0.0 if tp == 0 else 2 * tp / (2 * tp + fp + fn)


def single_metrics(ref: list[str], pred: list[str], idx: np.ndarray) -> tuple[float, float]:
    """Accuracy and macro-F1 over the given books (indexes into ref and pred)."""
    r = [ref[i] for i in idx]
    p = [pred[i] for i in idx]
    if not r:
        return float("nan"), float("nan")
    acc = sum(a == b for a, b in zip(r, p)) / len(r)
    f1s = []
    for c in sorted(set(r)):
        tp = sum(a == c and b == c for a, b in zip(r, p))
        fp = sum(a != c and b == c for a, b in zip(r, p))
        fn = sum(a == c and b != c for a, b in zip(r, p))
        f1s.append(_f1(tp, fp, fn))
    return acc, float(np.mean(f1s))


def theme_metrics(ref: list[set[str]], pred: list[set[str]], idx: np.ndarray) -> tuple[float, float]:
    """Macro-F1 over the reference's themes, and the mean Jaccard overlap per book."""
    r = [ref[i] for i in idx]
    p = [pred[i] for i in idx]
    if not r:
        return float("nan"), float("nan")
    themes = sorted(set().union(*r)) if r else []
    f1s = []
    for t in themes:
        tp = sum(t in a and t in b for a, b in zip(r, p))
        fp = sum(t not in a and t in b for a, b in zip(r, p))
        fn = sum(t in a and t not in b for a, b in zip(r, p))
        f1s.append(_f1(tp, fp, fn))
    jac = [len(a & b) / len(a | b) if (a | b) else 1.0 for a, b in zip(r, p)]
    return (float(np.mean(f1s)) if f1s else float("nan")), float(np.mean(jac))


def _interval(values: list[float], interval: float) -> tuple[float | None, float | None]:
    v = [x for x in values if not math.isnan(x)]
    if len(v) < 2:
        return None, None
    tail = (1 - interval) / 2
    return float(np.quantile(v, tail)), float(np.quantile(v, 1 - tail))


def _estimate(value: float, samples: list[float], interval: float, n: int) -> dict[str, Any]:
    low, high = _interval(samples, interval)
    return {"value": None if math.isnan(value) else value, "low": low, "high": high, "books": n}


def wilson(hits: int, n: int, z: float = 1.959964) -> dict[str, Any]:
    if n == 0:
        return {"hits": hits, "n": n, "value": None, "low": None, "high": None}
    p = hits / n
    denom = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / denom
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denom
    return {"hits": hits, "n": n, "value": p, "low": max(0.0, centre - half), "high": min(1.0, centre + half)}


def _book_cost(row: dict[str, Any], price: dict[str, float] | None) -> float | None:
    if price is None:
        return None
    return (row.get("inputTokens", 0) * price["input"] + row.get("outputTokens", 0) * price["output"]) / 1e6


def compute(data: dict[str, Any], params: dict[str, Any]) -> dict[str, Any]:
    llm = params["llm"]
    interval = params["metrics"]["interval"]
    rng = np.random.default_rng(llm["seed"])
    hand = data.get("hand")
    # The trait reference: the owner's hand labels when imported (D-028 update), else the reference model.
    ref_books = hand["books"] if hand else data["reference"]["books"] if data["reference"] else {}
    order = [b["editionId"] for b in data["set"]["books"]]
    outputs = dict(data["outputs"])
    if hand and data["reference"]:
        # Scored like a model: how well an LLM labeller agrees with the person.
        outputs["reference"] = data["reference"]
    # Books with a valid reference label and an answer (or failure) from the small model,
    # the model Bookie uses. The others are optional (free tier: the large model may not have run).
    books = [
        e
        for e in order
        if e in ref_books
        and "error" not in ref_books[e]
        and outputs.get("small") is not None
        and e in outputs["small"]["books"]
    ]
    # Another model is scored only when it answered every one of these books, so that every
    # comparison is paired on the same books.
    roles = ["small"] + [
        r for r in ("large", "reference")
        if outputs.get(r) is not None and books and all(e in outputs[r]["books"] for e in books)
    ]
    n = len(books)
    resamples = rng.integers(0, n, size=(llm["bootstrap_samples"], n)) if n else np.zeros((0, 0), dtype=int)

    def rows_of(role: str) -> list[dict[str, Any]]:
        # A book the reference model has no answer for counts as failed, like an invalid answer.
        return [outputs[role]["books"].get(e, {"error": "missing"}) for e in books]

    def values(role: str, trait: str) -> list[Any]:
        rows = rows_of(role)
        if trait == "themes":
            return [set(r.get("themes", [])) if "error" not in r else set() for r in rows]
        return [r.get(trait, "unknown") if "error" not in r else "failed" for r in rows]

    results: dict[str, Any] = {"books": n, "models": {}, "difference": {}}
    per_role: dict[str, dict[str, Any]] = {}
    for role in roles:
        model = data["manifest"]["models"].get(role) or outputs[role].get("model")
        traits: dict[str, Any] = {}
        overall_samples = np.zeros(len(resamples))
        overall_value = []
        for trait in TRAITS:
            if trait == "themes":
                ref = [set(ref_books[e]["themes"]) for e in books]
                pred = values(role, trait)
                known = np.arange(n)
                f1, jac = theme_metrics(ref, pred, known)
                samples = [theme_metrics(ref, pred, s) for s in resamples]
                f1_s = [x[0] for x in samples]
                jac_s = [x[1] for x in samples]
                traits[trait] = {
                    "macroF1": _estimate(f1, f1_s, interval, n),
                    "jaccard": _estimate(jac, jac_s, interval, n),
                }
            else:
                ref_all = [ref_books[e][trait] for e in books]
                pred_all = values(role, trait)
                known = np.array([i for i, r in enumerate(ref_all) if r != "unknown"], dtype=int)
                acc, f1 = single_metrics(ref_all, pred_all, known)
                samples = []
                for s in resamples:
                    ks = np.array([i for i in s if ref_all[i] != "unknown"], dtype=int)
                    samples.append(single_metrics(ref_all, pred_all, ks))
                f1_s = [x[1] for x in samples]
                traits[trait] = {
                    "accuracy": _estimate(acc, [x[0] for x in samples], interval, len(known)),
                    "macroF1": _estimate(f1, f1_s, interval, len(known)),
                    "referenceUnknown": n - len(known),
                    "answeredUnknown": sum(1 for i in known if pred_all[i] == "unknown"),
                }
            v = traits[trait]["macroF1"]["value"]
            overall_value.append(float("nan") if v is None else v)
            overall_samples = overall_samples + np.nan_to_num(np.array(f1_s, dtype=float)) / len(TRAITS)
        rows = rows_of(role)
        # Answers reused from traits:extract carry no token record: their cost is unknown, not zero.
        recorded = bool(rows) and all("inputTokens" in r and "outputTokens" in r for r in rows)
        price = llm["prices"].get(model) if recorded else None
        costs = [_book_cost(r, price) for r in rows]
        per_role[role] = {"overall": overall_samples, "costs": costs}
        results["models"][role] = {
            "model": model,
            "traits": traits,
            # Undefined unless every trait has a score.
            "overallMacroF1": _estimate(
                float(np.mean(overall_value)) if n else float("nan"), list(overall_samples), interval, n
            ),
            "failed": sum(1 for r in rows if "error" in r),
            "retried": sum(1 for r in rows if r.get("attempts", 1) > 1),
            "costPerBookUsd": None if price is None else float(np.mean(costs)) if costs else None,
            "tokensPerBook": {
                "input": float(np.mean([r["inputTokens"] for r in rows])) if recorded else None,
                "output": float(np.mean([r["outputTokens"] for r in rows])) if recorded else None,
            },
            "tokensRecorded": recorded,
            "priced": price is not None,
        }
    small, large = results["models"]["small"], results["models"].get("large")
    if n and large and small["overallMacroF1"]["value"] and large["overallMacroF1"]["value"]:
        diff = per_role["small"]["overall"] - per_role["large"]["overall"]
        results["difference"] = {
            "overallMacroF1SmallMinusLarge": _estimate(
                small["overallMacroF1"]["value"] - large["overallMacroF1"]["value"], list(diff), interval, n
            ),
            "smallShareOfLargeScore": small["overallMacroF1"]["value"] / large["overallMacroF1"]["value"],
            "smallShareOfLargeCost": (
                small["costPerBookUsd"] / large["costPerBookUsd"]
                if small["costPerBookUsd"] and large["costPerBookUsd"]
                else None
            ),
        }
    results["claims"] = _claims(data["claims"])
    results["provenance"] = {
        "manifest": data["manifest"],
        # "hand": the owner's labels are the trait reference; "model": the reference model's are.
        "traitReference": "hand" if hand else "model",
        "handLabelled": {"labelled": hand["labelled"], "of": hand["of"]} if hand else None,
        "referenceModel": data["reference"]["model"] if data["reference"] else None,
        "referenceInstructionsSha256": data["reference"]["instructionsSha256"] if data["reference"] else None,
        "seed": llm["seed"],
        "bootstrapSamples": llm["bootstrap_samples"],
        "interval": interval,
        "prices": llm["prices"],
    }
    return results


def _claims(c: dict[str, Any] | None) -> dict[str, Any] | None:
    if not c:
        return None
    judged = [x for x in c["claims"] if x.get("label")]
    out: dict[str, Any] = {
        "summaryModel": c["summaryModel"],
        "judgeModel": c["judgeModel"],
        "sampled": len(c["claims"]),
        "judged": len(judged),
        "supported": wilson(sum(1 for x in judged if x["label"] == "supported"), len(judged)),
        "byKind": {
            kind: wilson(
                sum(1 for x in judged if x["kind"] == kind and x["label"] == "supported"),
                sum(1 for x in judged if x["kind"] == kind),
            )
            for kind in ("praise", "complaint")
        },
        "summaries": {
            "books": len(c["summaries"]),
            "invalidTwice": sum(1 for s in c["summaries"] if s.get("error")),
            "retriedOnce": sum(1 for s in c["summaries"] if (s.get("attempts") or 1) > 1),
        },
    }
    return out


def headline(results: dict[str, Any]) -> dict[str, float]:
    """The metrics the regression check compares (EVAL-4)."""
    out: dict[str, float] = {}
    # The measured models only: the reference model's labels are made once and do not change.
    for role in ("small", "large"):
        m = results["models"].get(role)
        if m is None:
            continue
        if m["overallMacroF1"]["value"] is not None:
            out[f"{role}.overallMacroF1"] = m["overallMacroF1"]["value"]
        for trait in SINGLE:
            v = m["traits"][trait]["accuracy"]["value"]
            if v is not None:
                out[f"{role}.{trait}.accuracy"] = v
    claims = results.get("claims")
    if claims and claims["supported"]["value"] is not None:
        out["claims.supportedRate"] = claims["supported"]["value"]
    return out


def check(results: dict[str, Any], baseline: dict[str, Any] | None, params: dict[str, Any]) -> list[str]:
    """Problems: metrics that dropped beyond their threshold from the accepted baseline."""
    if baseline is None:
        return []
    max_drop = params["llm"]["regression"]["max_drop"]
    current = headline(results)
    problems = []
    for name, before in baseline["metrics"].items():
        now = current.get(name)
        if now is None:
            problems.append(f"{name}: missing now (was {before:.3f})")
        elif before - now > max_drop:
            problems.append(f"{name}: {now:.3f}, down {before - now:.3f} from {before:.3f} (allowed {max_drop})")
    return problems


def _fmt(e: dict[str, Any] | None, places: int = 3) -> str:
    if not e or e.get("value") is None:
        return "n/a"
    if e.get("low") is None:
        return f"{e['value']:.{places}f}"
    return f"{e['value']:.{places}f} [{e['low']:.{places}f}, {e['high']:.{places}f}]"


def markdown(r: dict[str, Any]) -> str:
    small = r["models"]["small"]
    p = r["provenance"]
    shown = [(small, "small")]
    if "large" in r["models"]:
        shown.append((r["models"]["large"], "large"))
    if "reference" in r["models"]:
        shown.append((r["models"]["reference"], "reference labeller"))
    if p.get("traitReference") == "hand":
        h = p["handLabelled"]
        source = (
            f"Trait reference: the owner's hand labels ({h['labelled']} of {h['of']} books labelled; D-028), so trait "
            "scores are accuracy against a person. "
            + (
                "The reference model is scored against them too: how well an LLM labeller agrees with the person. "
                if "reference" in r["models"]
                else "The reference model has not labelled every book, so it is not scored. "
            )
            + f"Claims are judged by {p['referenceModel']}."
        )
    else:
        source = (
            f"Reference labels: {p['referenceModel']} following `eval/llm/traits-instructions.md` "
            "(a model, not hand labels: the owner's choice, D-028). Scores measure agreement with that reference."
        )
    lines = [
        "# LLM evaluation (spec 9: trait extraction and summary faithfulness)",
        "",
        source,
        "",
        f"## Trait extraction ({r['books']} books)",
        "",
        "| Trait | Metric | " + " | ".join(f"{m['model']} ({label})" for m, label in shown) + " |",
        "|---|---|" + "---|" * len(shown),
    ]
    row = lambda name, metric, cell: f"| {name} | {metric} | " + " | ".join(cell(m) for m, _ in shown) + " |"  # noqa: E731
    for trait in TRAITS:
        metrics = ["accuracy", "macroF1"] if trait in SINGLE else ["macroF1", "jaccard"]
        for metric in metrics:
            lines.append(row(trait, metric, lambda m: _fmt(m["traits"][trait][metric])))
    lines.append(row("all four", "mean macro-F1", lambda m: _fmt(m["overallMacroF1"])))
    def cost(m: dict[str, Any]) -> str:
        if not m.get("tokensRecorded", True):
            return "not recorded"
        return "n/a" if m["costPerBookUsd"] is None else f"${m['costPerBookUsd']:.5f}"

    lines.append(row("", "cost per book (list price)", cost))
    lines.append(row("", "failed (invalid twice)", lambda m: str(m["failed"])))
    if "large" not in r["models"]:
        lines += [
            "",
            "The large model has not answered every one of these books, so there is no small-versus-large "
            "comparison yet (free tier: run `llm-eval traits large` until it has).",
        ]
    if not small.get("tokensRecorded", True):
        lines += [
            "",
            "The small model's answers were reused from `traits:extract`, which does not record tokens, so "
            "their cost is not reported.",
        ]
    d = r.get("difference") or {}
    if d:
        lines += [
            "",
            f"Small minus large, mean macro-F1 (paired): {_fmt(d['overallMacroF1SmallMinusLarge'])}. "
            f"The small model reaches {d['smallShareOfLargeScore']:.2f} of the large model's score"
            + (f" at {d['smallShareOfLargeCost']:.2f} of its cost." if d.get("smallShareOfLargeCost") else "."),
        ]
    c = r.get("claims")
    lines += ["", "## Summary faithfulness", ""]
    if c and c["judged"]:
        s = c["supported"]
        lines.append(
            f"{s['hits']} of {s['n']} sampled claims from {c['summaryModel']} summaries were judged supported by their cited reviews "
            f"by {c['judgeModel']} (share {s['value']:.2f}, 95% Wilson interval {s['low']:.2f} to {s['high']:.2f})."
        )
        for kind, w in c["byKind"].items():
            if w["n"]:
                lines.append(f"- {kind}: {w['hits']} of {w['n']} supported.")
        lines += [
            "",
            "The citation check in code verifies that every cited review exists in the evidence set (RES-5), and retries "
            f"invalid output once: {c['summaries']['retriedOnce']} of {c['summaries']['books']} summaries were retried, "
            f"{c['summaries']['invalidTwice']} failed twice. It cannot tell whether a review supports a claim, so every "
            "claim judged not supported here had passed it.",
        ]
    else:
        lines.append("No claims judged yet.")
    p = r["provenance"]
    lines += [
        "",
        "## Method",
        "",
        f"- Prompt versions: traits {p['manifest']['traitPromptVersion']}, summary {p['manifest']['summaryPromptVersion']}; every model saw the same evidence, chosen as the pipeline chooses it.",
        "- A model's \"unknown\" or failed answer counts as wrong where the reference knows the trait.",
        f"- {int(p['interval'] * 100)}% percentile bootstrap over books, {p['bootstrapSamples']} resamples, seed {p['seed']}; the same resamples for both models.",
        "- Cost: recorded tokens (thinking tokens count as output) at paid-tier list prices from `eval/params.toml`; the free tier costs nothing.",
        "",
    ]
    return "\n".join(lines)


def write(results: dict[str, Any], out_dir: Path = RESULTS_DIR) -> Path:
    from .report import rounded

    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "results.json").write_text(json.dumps(rounded(results), indent=2) + "\n", "utf-8", newline="\n")
    (out_dir / "report.md").write_text(markdown(results), "utf-8", newline="\n")
    return out_dir
