"""Per-reader metrics and bootstrap intervals over readers (spec 9).

Each metric is computed for one reader's held-out ratings; the reported value
is the mean over readers, with a percentile bootstrap interval that resamples
readers. Conventions, chosen so every model is judged on the same readers:

- Spearman: undefined (excluded for every model) when the reader's held-out
  ratings are all equal; 0 when a model gives every held-out book the same
  score, since it then says nothing about the order.
- NDCG@k: gain 2^(rating - 1) - 1, so a 1-star book gains nothing; undefined
  when every held-out rating is 1. Tied predictions get the expected gain over
  every order of the tie (McSherry and Najork 2008), so tie-breaking cannot
  flatter a model.
- MAE: mean absolute error with predictions clipped to the 1 to 5 scale.
"""

from __future__ import annotations

import numpy as np
from scipy.stats import rankdata


def spearman(pred: np.ndarray, actual: np.ndarray) -> float:
    if len(actual) < 2 or np.all(actual == actual[0]):
        return float("nan")
    if np.all(pred == pred[0]):
        return 0.0
    a = rankdata(pred)
    b = rankdata(actual)
    a = a - a.mean()
    b = b - b.mean()
    return float((a * b).sum() / np.sqrt((a * a).sum() * (b * b).sum()))


def _gain(actual: np.ndarray) -> np.ndarray:
    return np.power(2.0, actual - 1.0) - 1.0


def ndcg(pred: np.ndarray, actual: np.ndarray, k: int) -> float:
    gains = _gain(actual)
    ideal = np.sort(gains)[::-1][:k]
    discounts = 1.0 / np.log2(np.arange(2, len(actual) + 2))
    idcg = float((ideal * discounts[: len(ideal)]).sum())
    if idcg == 0.0:
        return float("nan")
    # Positions of each tie group in descending predicted order; every book in
    # a group gets the group's mean gain at each of the group's positions.
    order = np.argsort(-pred, kind="stable")
    sorted_pred = pred[order]
    sorted_gain = gains[order]
    dcg = 0.0
    start = 0
    n = len(pred)
    while start < n and start < k:
        end = start
        while end + 1 < n and sorted_pred[end + 1] == sorted_pred[start]:
            end += 1
        mean_gain = sorted_gain[start : end + 1].mean()
        last = min(end, k - 1)
        dcg += mean_gain * discounts[start : last + 1].sum()
        start = end + 1
    return float(dcg / idcg)


def mae(pred: np.ndarray, actual: np.ndarray) -> float:
    return float(np.abs(np.clip(pred, 1.0, 5.0) - actual).mean())


METRICS = ("spearman", "ndcg", "mae")


def per_reader(preds: list[np.ndarray], actuals: list[np.ndarray], k: int) -> dict[str, np.ndarray]:
    """One value per reader for each metric (nan where undefined)."""
    return {
        "spearman": np.array([spearman(p, a) for p, a in zip(preds, actuals)]),
        "ndcg": np.array([ndcg(p, a, k) for p, a in zip(preds, actuals)]),
        "mae": np.array([mae(p, a) for p, a in zip(preds, actuals)]),
    }


def bootstrap_indices(n_readers: int, samples: int, seed: int) -> np.ndarray:
    """The same resamples are used for every model, so differences are paired."""
    return np.random.default_rng(seed).integers(0, n_readers, size=(samples, n_readers))


def summarise(values: np.ndarray, resamples: np.ndarray, interval: float) -> dict[str, float | int]:
    """Mean over readers where defined, with a percentile bootstrap interval."""
    defined = ~np.isnan(values)
    if not defined.any():
        return {"value": None, "low": None, "high": None, "readers": 0}
    filled = np.where(defined, values, 0.0)
    sums = filled[resamples].sum(axis=1)
    counts = defined[resamples].sum(axis=1)
    means = sums / np.maximum(counts, 1)
    tail = (1.0 - interval) / 2.0
    return {
        "value": float(values[defined].mean()),
        "low": float(np.quantile(means, tail)),
        "high": float(np.quantile(means, 1.0 - tail)),
        "readers": int(defined.sum()),
    }


def summarise_difference(
    a: np.ndarray, b: np.ndarray, resamples: np.ndarray, interval: float
) -> dict[str, float | int]:
    """Mean of a - b over readers where both are defined, with a paired interval."""
    diff = np.where(np.isnan(a) | np.isnan(b), np.nan, a - b)
    return summarise(diff, resamples, interval)
