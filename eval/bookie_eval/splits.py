"""Who is evaluated and how their ratings are split (spec 9).

- Readers with at least `min_ratings` ratings qualify; `eval_readers` of them
  are drawn with the seed. Only their ratings are split.
- Every other reader is the *population*: the only data B0 and B3 learn from.
  An evaluated reader's ratings never reach the population, so nothing from a
  held-out rating can influence that reader's prediction (no leakage).
- Each evaluated reader's ratings are shuffled with a seed of their own:
  `test_fraction` is the test split, `validation_fraction` the validation
  split (used only for tuning and choosing the model), the rest is the
  *profile* the models see, like the ratings a reader gives the app.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import numpy as np

from .snapshot import Snapshot


@dataclass(frozen=True)
class ReaderSplit:
    reader: int
    train_books: np.ndarray
    train_ratings: np.ndarray
    val_books: np.ndarray
    val_ratings: np.ndarray
    test_books: np.ndarray
    test_ratings: np.ndarray


@dataclass(frozen=True)
class Population:
    """Ratings of readers who are not evaluated."""

    reader: np.ndarray
    book: np.ndarray
    rating: np.ndarray
    n_readers: int


def _half_up(x: float) -> int:
    return int(np.floor(x + 0.5))


def split(snapshot: Snapshot, params: dict[str, Any]) -> tuple[list[ReaderSplit], Population]:
    seed = params["split"]["seed"]
    counts = np.bincount(snapshot.reader, minlength=snapshot.n_readers)
    qualifying = np.flatnonzero(counts >= params["data"]["min_ratings"])
    size = min(params["data"]["eval_readers"], len(qualifying))
    chosen = np.sort(np.random.default_rng(seed).choice(qualifying, size=size, replace=False))

    is_eval = np.zeros(snapshot.n_readers, dtype=bool)
    is_eval[chosen] = True
    in_population = ~is_eval[snapshot.reader]
    population = Population(
        reader=snapshot.reader[in_population],
        book=snapshot.book[in_population],
        rating=snapshot.rating[in_population].astype(np.float64),
        n_readers=snapshot.n_readers,
    )

    # Ratings are stored sorted by reader, so each reader's rows are one slice.
    order = np.argsort(snapshot.reader, kind="stable")
    starts = np.searchsorted(snapshot.reader[order], chosen, side="left")
    ends = np.searchsorted(snapshot.reader[order], chosen, side="right")
    splits: list[ReaderSplit] = []
    for reader, start, end in zip(chosen, starts, ends):
        rows = order[start:end]
        # Sorted by book first, so the shuffle depends only on the seed and the reader.
        rows = rows[np.argsort(snapshot.book[rows], kind="stable")]
        rows = rows[np.random.default_rng([seed, int(reader)]).permutation(len(rows))]
        n = len(rows)
        n_test = max(1, _half_up(params["split"]["test_fraction"] * n))
        n_val = max(1, _half_up(params["split"]["validation_fraction"] * n))
        test, val, train = rows[:n_test], rows[n_test : n_test + n_val], rows[n_test + n_val :]
        splits.append(
            ReaderSplit(
                reader=int(reader),
                train_books=snapshot.book[train],
                train_ratings=snapshot.rating[train].astype(np.float64),
                val_books=snapshot.book[val],
                val_ratings=snapshot.rating[val].astype(np.float64),
                test_books=snapshot.book[test],
                test_ratings=snapshot.rating[test].astype(np.float64),
            )
        )
    return splits, population
