import json

import numpy as np

from bookie_eval import experiment
from bookie_eval.models import (
    PACES,
    book_features,
    components,
    derived_questionnaire,
    b1_scores,
    fit_population,
)
from bookie_eval.splits import split


def test_splits_are_disjoint_sized_and_keep_evaluated_readers_out_of_the_population(snap, params):
    splits, population = split(snap, params)
    assert len(splits) == params["data"]["eval_readers"]
    evaluated = {s.reader for s in splits}
    assert not evaluated & set(population.reader.tolist())
    for s in splits:
        n = len(s.train_books) + len(s.val_books) + len(s.test_books)
        assert n >= params["data"]["min_ratings"]
        all_books = np.concatenate([s.train_books, s.val_books, s.test_books])
        assert len(np.unique(all_books)) == n  # no book in two splits
        assert len(s.test_books) == int(np.floor(0.2 * n + 0.5))
    # Same seed, same split.
    again, _ = split(snap, params)
    assert all(np.array_equal(a.test_books, b.test_books) for a, b in zip(splits, again))


def test_model_2_unknown_preferences_and_traits_add_nothing(snap, params):
    feats = book_features(snap, params)
    books = np.array([0, 1, 2, 4, 5])
    # Every rating equal: no preference has evidence, so every answer is unknown.
    q = derived_questionnaire(feats, books, np.zeros(5), params)
    assert not q["liked"].any() and not q["disliked"].any() and not q["avoid"].any()
    assert q["pace"] is None
    targets = np.arange(snap.n_books)
    assert np.all(b1_scores(feats, q, 3.7, targets, params) == 3.7)

    # A known pace preference moves only books whose pace is known.
    q["pace"] = PACES.index("fast")
    scores = b1_scores(feats, q, 3.0, targets, params)
    unknown = feats.pace[targets] < 0
    assert unknown.any()
    assert np.all(scores[unknown] == 3.0)
    assert np.all(scores[~unknown] != 3.0)


def test_b3_without_similar_rated_books_is_the_baseline(snap, params):
    _, population = split(snap, params)
    pop = fit_population(population, snap.n_books, params)
    pop.similarity[:] = 0.0
    feats = book_features(snap, params)
    c = components(feats, pop, np.array([1, 2, 3]), np.array([5.0, 4.0, 5.0]), np.array([10, 11]), params)
    b_u = (np.array([5.0, 4.0, 5.0]) - pop.mean - pop.item_bias[[1, 2, 3]]).sum() / (pop.reader_shrinkage + 3)
    assert c.b3.shape == (len(pop.weight_shrinkage_grid), 2)
    assert np.allclose(c.b3, np.clip(pop.mean + b_u + pop.item_bias[[10, 11]], 1, 5))


def test_no_leakage_test_ratings_never_reach_training_tuning_or_selection(snap, params):
    """Scrambling every held-out test rating changes test numbers only."""
    first = experiment.run(snap, params, log=lambda m: None)
    rng = np.random.default_rng(3)
    splits, _ = split(snap, params)
    for s in splits:
        s.test_ratings[:] = rng.integers(1, 6, size=len(s.test_ratings))

    original_split = experiment.split
    experiment.split = lambda *_: (splits, split(snap, params)[1])
    try:
        second = experiment.run(snap, params, log=lambda m: None)
    finally:
        experiment.split = original_split
    assert first["tuned"] == second["tuned"]
    assert first["selection"] == second["selection"]
    for m in first["models"]:
        assert first["models"][m]["validation"] == second["models"][m]["validation"]
    assert json.dumps(first["models"]["B4"]["test"]) != json.dumps(second["models"]["B4"]["test"])


def test_learned_models_find_the_signal_in_synthetic_data(snap, params):
    r = experiment.run(snap, params, log=lambda m: None)
    test = {m: r["models"][m]["test"]["spearman"]["value"] for m in r["models"]}
    # The synthetic ratings depend on embedding similarity, co-rating structure and a
    # book effect. B2 sees only the first (it ignores how good a book is in general),
    # so it finds real signal without having to beat B0; B3 and the blend beat B0.
    assert test["B2"] > 0.2
    assert test["B3"] > test["B0"]
    assert test["B4"] > test["B0"]
    assert test["B4"] >= test["B2"]
    assert r["selection"]["shipped"] in ("B2", "B3", "B4")
    assert r["calibration"]["model"] == r["selection"]["shipped"]
    assert [p["profileSize"] for p in r["learningCurve"]["points"]] == [5, 10, 20]
