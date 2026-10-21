import itertools

import numpy as np
import pytest

from bookie_eval import metrics


def test_spearman_orders_and_conventions():
    actual = np.array([1.0, 2.0, 3.0, 4.0, 5.0])
    assert metrics.spearman(actual, actual) == pytest.approx(1.0)
    assert metrics.spearman(-actual, actual) == pytest.approx(-1.0)
    # Ties use average ranks.
    assert metrics.spearman(np.array([1, 1, 2, 3, 4.0]), actual) == pytest.approx(0.9746794)
    # A model that cannot order says nothing: 0, not undefined.
    assert metrics.spearman(np.full(5, 3.0), actual) == 0.0
    # All held-out ratings equal: undefined for every model.
    assert np.isnan(metrics.spearman(actual, np.full(5, 4.0)))


def _brute_force_ndcg(pred, actual, k):
    """Average NDCG over every order of tied predictions."""
    gains = np.power(2.0, actual - 1.0) - 1.0
    ideal = np.sort(gains)[::-1][:k]
    disc = 1.0 / np.log2(np.arange(2, len(actual) + 2))
    idcg = (ideal * disc[: len(ideal)]).sum()
    values = []
    for perm in itertools.permutations(range(len(pred))):
        p = np.array(perm)
        # Keep only orders consistent with descending prediction.
        if np.all(np.diff(pred[p]) <= 0):
            values.append((gains[p][:k] * disc[:k][: len(p)]).sum() / idcg)
    return float(np.mean(values))


def test_ndcg_perfect_reversed_and_ties():
    actual = np.array([5.0, 4.0, 2.0, 1.0, 3.0])
    assert metrics.ndcg(actual, actual, 10) == pytest.approx(1.0)
    assert metrics.ndcg(-actual, actual, 10) < 1.0
    tied = np.array([2.0, 2.0, 1.0, 1.0, 2.0])
    for k in (2, 3, 10):
        assert metrics.ndcg(tied, actual, k) == pytest.approx(_brute_force_ndcg(tied, actual, k))
    # Constant predictions earn the expected gain of a random order, not a lucky one.
    flat = np.full(5, 3.0)
    assert metrics.ndcg(flat, actual, 3) == pytest.approx(_brute_force_ndcg(flat, actual, 3))
    # Only 1-star books: nothing to rank.
    assert np.isnan(metrics.ndcg(actual, np.ones(5), 10))


def test_mae_clips_to_the_scale():
    assert metrics.mae(np.array([0.0, 6.0]), np.array([1.0, 5.0])) == 0.0
    assert metrics.mae(np.array([2.0, 4.0]), np.array([1.0, 5.0])) == 1.0


def test_bootstrap_interval_is_paired_and_deterministic():
    rng = np.random.default_rng(0)
    a = rng.normal(0.3, 0.2, size=500)
    b = a - 0.05 + rng.normal(0, 0.01, size=500)
    resamples = metrics.bootstrap_indices(500, 400, seed=1)
    s = metrics.summarise(a, resamples, 0.95)
    assert s["low"] < s["value"] < s["high"]
    assert s == metrics.summarise(a, metrics.bootstrap_indices(500, 400, seed=1), 0.95)
    d = metrics.summarise_difference(a, b, resamples, 0.95)
    # Paired: the interval is narrow because the noise is shared.
    assert 0.04 < d["low"] < d["value"] < d["high"] < 0.06
    # Undefined readers are left out, and counted.
    a[:10] = np.nan
    assert metrics.summarise(a, resamples, 0.95)["readers"] == 490
