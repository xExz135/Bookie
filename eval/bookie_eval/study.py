"""The user study report (spec 9, FE-10, D-027).

Each participant held out STUDY_HELD_OUT_BOOKS of their own rated books; the
shipped model predicted them from the other ratings, next to B0. The metrics
are the offline evaluation's own (metrics.py), per reader, then the mean over
readers with a percentile bootstrap interval that resamples readers; the
model against B0 is a paired difference on the same resamples.

Also reported (spec 9): the share of Accurate against Not for me feedback on
live personal matches, with a Wilson interval.

    python -m bookie_eval study      # writes eval/results/study/

Honesty rule (spec 9): with few readers the intervals are wide; the report
gives the real number of readers and says so.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

from . import metrics
from .params import EVAL_DIR

RESULTS_DIR = EVAL_DIR / "results" / "study"


@dataclass
class Participant:
    actual: np.ndarray
    model: np.ndarray
    baseline: np.ndarray
    model_ids: list[str]
    model_version: str


def load(database_url: str) -> tuple[list[Participant], dict[str, int]]:
    """Participants with their held-out books, and the live personal feedback counts."""
    import psycopg  # only needed here, so tests run without a database

    with psycopg.connect(database_url) as conn, conn.cursor() as cur:
        cur.execute(
            """SELECT p.participant_id, p.actual_rating, p.score::float8, p.baseline_score::float8,
                      m.model_id::text, m.version
                 FROM study_predictions p JOIN model_versions m ON m.id = p.model_version_id
                ORDER BY p.participant_id, p.position"""
        )
        rows = cur.fetchall()
        cur.execute(
            """SELECT value::text, count(*) FROM feedback WHERE target = 'personal' GROUP BY value"""
        )
        feedback = {value: int(n) for value, n in cur.fetchall()}
    grouped: dict[str, list[tuple]] = {}
    for row in rows:
        grouped.setdefault(row[0], []).append(row)
    participants = [
        Participant(
            actual=np.array([r[1] for r in rs], dtype=float),
            model=np.array([r[2] for r in rs], dtype=float),
            baseline=np.array([r[3] for r in rs], dtype=float),
            model_ids=[r[4] for r in rs],
            model_version=rs[0][5],
        )
        for rs in grouped.values()
    ]
    return participants, feedback


def wilson(hits: int, n: int, z: float = 1.959964) -> dict[str, Any]:
    if n == 0:
        return {"hits": hits, "n": n, "value": None, "low": None, "high": None}
    p = hits / n
    denom = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / denom
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denom
    return {"hits": hits, "n": n, "value": p, "low": max(0.0, centre - half), "high": min(1.0, centre + half)}


def compute(participants: list[Participant], feedback: dict[str, int], params: dict[str, Any]) -> dict[str, Any]:
    m = params["metrics"]
    seed = params["study"]["seed"]
    n = len(participants)
    out: dict[str, Any] = {
        "readers": n,
        "heldOutBooks": int(sum(len(p.actual) for p in participants)),
        "modelVersions": sorted({p.model_version for p in participants}),
        "modelsUsed": sorted({mid for p in participants for mid in p.model_ids}),
        "method": {
            "metrics": "per-reader Spearman (undefined when the reader's held-out ratings are all equal; 0 for a constant prediction) and MAE with predictions clipped to 1 to 5, as in the offline evaluation",
            "interval": m["interval"],
            "bootstrapSamples": m["bootstrap_samples"],
            "seed": seed,
            "resampling": "readers, the same resamples for the model and B0 (paired)",
        },
        "feedback": wilson(feedback.get("accurate", 0), feedback.get("accurate", 0) + feedback.get("not_for_me", 0)),
    }
    if n == 0:
        out.update({"model": None, "baseline": None, "difference": None})
        return out
    actuals = [p.actual for p in participants]
    model = metrics.per_reader([p.model for p in participants], actuals, m["ndcg_k"])
    base = metrics.per_reader([p.baseline for p in participants], actuals, m["ndcg_k"])
    resamples = metrics.bootstrap_indices(n, m["bootstrap_samples"], seed)
    interval = m["interval"]
    out["model"] = {k: metrics.summarise(model[k], resamples, interval) for k in ("spearman", "mae")}
    out["baseline"] = {k: metrics.summarise(base[k], resamples, interval) for k in ("spearman", "mae")}
    out["difference"] = {
        k: metrics.summarise_difference(model[k], base[k], resamples, interval) for k in ("spearman", "mae")
    }
    return out


def _fmt(s: dict[str, Any] | None, signed: bool = False) -> str:
    if not s or s["value"] is None:
        return "n/a"
    f = "+.3f" if signed else ".3f"
    return f"{s['value']:{f}} [{s['low']:{f}}, {s['high']:{f}}] ({s['readers']} readers)"


def markdown(r: dict[str, Any]) -> str:
    lines = ["# User study (spec 9)", ""]
    lines.append(
        f"{r['readers']} readers, {r['heldOutBooks']} held-out books. Model release: "
        f"{', '.join(r['modelVersions']) or 'none'}; models that predicted: {', '.join(r['modelsUsed']) or 'none'}."
    )
    lines.append("")
    if r["readers"] == 0:
        lines.append("No reader has taken part yet.")
        lines.append("")
    elif r["readers"] < 30:
        lines.append(
            f"Spec 9 aims for about 30 readers; this report has {r['readers']}. The intervals are wide and no strong claim follows from them."
        )
        lines.append("")
    if r["model"]:
        lines += [
            "| Metric | Shipped model | B0 (average rating) | Model minus B0 (paired) |",
            "|---|---|---|---|",
            f"| Spearman (higher is better) | {_fmt(r['model']['spearman'])} | {_fmt(r['baseline']['spearman'])} | {_fmt(r['difference']['spearman'], True)} |",
            f"| MAE (lower is better) | {_fmt(r['model']['mae'])} | {_fmt(r['baseline']['mae'])} | {_fmt(r['difference']['mae'], True)} |",
            "",
        ]
    fb = r["feedback"]
    lines.append(
        "Feedback on live personal matches: "
        + (
            "none yet."
            if fb["value"] is None
            else f"{fb['hits']} of {fb['n']} said Accurate (share {fb['value']:.2f}, {int(r['method']['interval'] * 100)}% Wilson interval {fb['low']:.2f} to {fb['high']:.2f})."
        )
    )
    meth = r["method"]
    lines += [
        "",
        "## Method",
        "",
        f"- Each reader held out their own rated books, chosen at random among the books the model knows; the model predicted them from the other ratings only.",
        f"- Metrics: {meth['metrics']}.",
        f"- {int(meth['interval'] * 100)}% percentile bootstrap over {meth['resampling']}; {meth['bootstrapSamples']} resamples, seed {meth['seed']}.",
        "",
    ]
    return "\n".join(lines)


def write(results: dict[str, Any], out_dir: Path = RESULTS_DIR) -> Path:
    from .report import rounded

    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "results.json").write_text(json.dumps(rounded(results), indent=2) + "\n", "utf-8", newline="\n")
    (out_dir / "report.md").write_text(markdown(results), "utf-8", newline="\n")
    return out_dir
