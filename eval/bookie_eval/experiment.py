"""Runs the offline evaluation and returns every reported number (spec 9, EVAL-1, EVAL-2).

Order of work:
1. Split readers; fit the population model (B0, B3) on non-evaluated readers.
2. For each evaluated reader, compute components from their profile (the
   train split) for their validation and test books.
3. Tune B3's damping, B2's mapping and B4's blend on validation. Validation numbers for the
   tuned models use two-fold cross-fitting over readers, so a model is never
   scored on the rows it was fitted on; the final coefficients use all of
   validation and are applied unchanged to test.
4. Choose the shipped model: best mean per-reader Spearman on validation,
   ties broken by NDCG (owner's choice, D-023). Test is not looked at.
5. Report validation and test for every model, the paired difference from
   B0, the ablations, the learning curve and the calibration of the shipped
   model, all with bootstrap intervals over readers.
"""

from __future__ import annotations

from typing import Any

import numpy as np

from . import metrics
from .models import (
    ABLATION_IDS,
    MODEL_IDS,
    BookFeatures,
    Components,
    PopulationModel,
    Tuned,
    book_features,
    components,
    fit_population,
    fit_tuned,
    predict,
)
from .snapshot import Snapshot
from .splits import ReaderSplit, split

ALL_MODELS = tuple(dict.fromkeys((*MODEL_IDS, *ABLATION_IDS)))


def _summaries(
    per_model: dict[str, list[np.ndarray]],
    actuals: list[np.ndarray],
    params: dict[str, Any],
    resamples: np.ndarray,
) -> tuple[dict[str, Any], dict[str, dict[str, np.ndarray]]]:
    k = params["metrics"]["ndcg_k"]
    interval = params["metrics"]["interval"]
    values = {m: metrics.per_reader(preds, actuals, k) for m, preds in per_model.items()}
    out = {
        m: {name: metrics.summarise(v[name], resamples, interval) for name in metrics.METRICS}
        for m, v in values.items()
    }
    return out, values


def _differences(values: dict[str, dict[str, np.ndarray]], resamples: np.ndarray, interval: float) -> dict[str, Any]:
    """Each model minus B0, paired over readers. For MAE, negative is better."""
    return {
        m: {
            name: metrics.summarise_difference(values[m][name], values["B0"][name], resamples, interval)
            for name in metrics.METRICS
        }
        for m in values
        if m != "B0"
    }


def _choose(validation: dict[str, Any]) -> tuple[str, list[dict[str, Any]]]:
    ranking = sorted(
        (
            {
                "model": m,
                "spearman": validation[m]["spearman"]["value"],
                "ndcg": validation[m]["ndcg"]["value"],
            }
            for m in MODEL_IDS
        ),
        key=lambda r: (-(r["spearman"] or -np.inf), -(r["ndcg"] or -np.inf), r["model"]),
    )
    return ranking[0]["model"], ranking


def _calibration(preds: np.ndarray, actual: np.ndarray, width: float) -> dict[str, Any]:
    edges = np.arange(1.0, 5.0 + width / 2, width)
    which = np.clip(np.digitize(preds, edges[1:-1]), 0, len(edges) - 2)
    bins = []
    for b in range(len(edges) - 1):
        mask = which == b
        n = int(mask.sum())
        bins.append(
            {
                "from": float(edges[b]),
                "to": float(edges[b + 1]),
                "count": n,
                "meanPredicted": float(preds[mask].mean()) if n else None,
                "meanActual": float(actual[mask].mean()) if n else None,
            }
        )
    counts = np.array([b["count"] for b in bins])
    gaps = np.array([abs(b["meanPredicted"] - b["meanActual"]) if b["count"] else 0.0 for b in bins])
    return {
        "binWidth": width,
        "bins": bins,
        # Expected calibration error: the count-weighted gap between predicted and actual.
        "expectedCalibrationError": float((counts * gaps).sum() / counts.sum()),
    }


def run(snapshot: Snapshot, params: dict[str, Any], log=print, fitted: dict[str, Any] | None = None) -> dict[str, Any]:
    """Every reported number. Pass `fitted` to also get the fitted models (for the export)."""
    seed = params["split"]["seed"]
    interval = params["metrics"]["interval"]
    samples = params["metrics"]["bootstrap_samples"]

    splits, population = split(snapshot, params)
    log(f"{len(splits)} evaluated readers; population of {len(population.rating)} ratings")
    feats: BookFeatures = book_features(snapshot, params)
    pop: PopulationModel = fit_population(population, snapshot.n_books, params)
    log("population model fitted")

    val_rows: list[tuple[Components, np.ndarray]] = []
    test_rows: list[tuple[Components, np.ndarray]] = []
    for s in splits:
        val_rows.append((components(feats, pop, s.train_books, s.train_ratings, s.val_books, params), s.val_ratings))
        test_rows.append((components(feats, pop, s.train_books, s.train_ratings, s.test_books, params), s.test_ratings))
    log("components computed")

    # Two-fold cross-fitting for validation numbers of the tuned models.
    folds = np.random.default_rng([seed, 1]).permutation(len(splits)) % 2
    grid = pop.weight_shrinkage_grid
    fold_tuned = [fit_tuned([r for r, f in zip(val_rows, folds) if f != k], grid) for k in (0, 1)]
    tuned: Tuned = fit_tuned(val_rows, grid)

    val_preds = {m: [predict(m, c, fold_tuned[f]) for (c, _), f in zip(val_rows, folds)] for m in ALL_MODELS}
    test_preds = {m: [predict(m, c, tuned) for c, _ in test_rows] for m in ALL_MODELS}
    val_actual = [a for _, a in val_rows]
    test_actual = [a for _, a in test_rows]

    resamples = metrics.bootstrap_indices(len(splits), samples, seed)
    validation, _ = _summaries(val_preds, val_actual, params, resamples)
    test, test_values = _summaries(test_preds, test_actual, params, resamples)
    shipped, ranking = _choose(validation)
    log(f"shipped by validation Spearman: {shipped}")
    if fitted is not None:
        fitted.update(features=feats, population=pop, tuned=tuned, shipped=shipped)

    curve = _learning_curve(splits, feats, pop, tuned, params)
    shipped_test = np.concatenate(test_preds[shipped])
    calibration = _calibration(shipped_test, np.concatenate(test_actual), params["metrics"]["calibration_bin_width"])

    target_books = np.concatenate([s.test_books for s in splits])
    profile_books = [s.train_books for s in splits]
    return {
        "data": {
            "books": snapshot.n_books,
            "booksWithEmbedding": int(snapshot.has_embedding.sum()),
            "booksWithTraits": int(feats.has_traits.sum()),
            "qualifyingReaders": int(
                (np.bincount(snapshot.reader, minlength=snapshot.n_readers) >= params["data"]["min_ratings"]).sum()
            ),
            "evaluatedReaders": len(splits),
            "populationReaders": int(len(np.unique(population.reader))),
            "populationRatings": int(len(population.rating)),
            "ratings": {
                "train": int(sum(len(s.train_books) for s in splits)),
                "validation": int(sum(len(s.val_books) for s in splits)),
                "test": int(sum(len(s.test_books) for s in splits)),
            },
            "medianProfileSize": float(np.median([len(b) for b in profile_books])),
            "testBooksWithEmbedding": float(snapshot.has_embedding[target_books].mean()),
            "testBooksWithTraits": float(feats.has_traits[target_books].mean()),
        },
        "selection": {
            "metric": "mean per-reader Spearman on validation, ties broken by NDCG@k",
            "shipped": shipped,
            "validationRanking": ranking,
        },
        "models": {
            m: {"validation": validation[m], "test": test[m]} for m in MODEL_IDS
        },
        "differenceFromB0OnTest": {m: d for m, d in _differences(test_values, resamples, interval).items() if m in MODEL_IDS},
        "ablations": {
            "description": {
                "B2": "embeddings only",
                "B2-traits": "traits only (one-hot trait vectors in place of embeddings)",
                "B4": "hybrid without the questionnaire prior",
                "B4+prior": "hybrid with the derived questionnaire (B1) as a prior",
            },
            "validation": {m: validation[m] for m in ABLATION_IDS},
            "test": {m: test[m] for m in ABLATION_IDS},
        },
        "learningCurve": curve,
        "calibration": {"model": shipped, "split": "test", **calibration},
        "tuned": tuned.as_dict(),
        "population": {"globalMean": pop.mean},
    }


def _learning_curve(
    splits: list[ReaderSplit],
    feats: BookFeatures,
    pop: PopulationModel,
    tuned: Tuned,
    params: dict[str, Any],
) -> dict[str, Any]:
    """Test metrics when the profile holds only k of the reader's train ratings."""
    seed = params["split"]["seed"]
    out: dict[str, Any] = {"split": "test", "points": []}
    for k in params["metrics"]["learning_curve"]:
        chosen = [s for s in splits if len(s.train_books) >= k]
        if not chosen:
            out["points"].append({"profileSize": k, "readers": 0, "models": {}})
            continue
        rows = []
        for s in chosen:
            pick = np.random.default_rng([seed, s.reader, k]).permutation(len(s.train_books))[:k]
            c = components(feats, pop, s.train_books[pick], s.train_ratings[pick], s.test_books, params)
            rows.append((c, s.test_ratings))
        preds = {m: [predict(m, c, tuned) for c, _ in rows] for m in MODEL_IDS}
        resamples = metrics.bootstrap_indices(len(rows), params["metrics"]["bootstrap_samples"], seed + k)
        summary, _ = _summaries(preds, [a for _, a in rows], params, resamples)
        out["points"].append({"profileSize": k, "readers": len(rows), "models": summary})
    return out
