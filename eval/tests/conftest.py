"""A small synthetic snapshot, so the harness is tested without the dataset (D-004)."""

from __future__ import annotations

import copy
from pathlib import Path

import numpy as np
import pytest

from bookie_eval import snapshot
from bookie_eval.models import PACES, THEMES, TRAIT_VOCABULARY
from bookie_eval.params import load_params

N_BOOKS = 60
N_READERS = 400
DIM = 16


def synthetic_parts(seed: int = 7) -> dict:
    """Ratings that depend on reader-book similarity in a latent space the
    embeddings partly reveal, plus a book effect: learned models should beat B0."""
    rng = np.random.default_rng(seed)
    latent_b = rng.normal(size=(N_BOOKS, 6))
    latent_r = rng.normal(size=(N_READERS, 6))
    book_effect = rng.normal(scale=0.4, size=N_BOOKS)
    reader_effect = rng.normal(scale=0.4, size=N_READERS)
    emb = np.hstack([latent_b, rng.normal(scale=0.5, size=(N_BOOKS, DIM - 6))])
    emb /= np.linalg.norm(emb, axis=1, keepdims=True)
    emb[3] = 0.0  # one book without an embedding

    readers, books, ratings = [], [], []
    for r in range(N_READERS):
        n = int(rng.integers(8, 45))
        chosen = np.sort(rng.choice(N_BOOKS, size=n, replace=False))
        score = 3.6 + reader_effect[r] + book_effect[chosen] + 0.6 * latent_b[chosen] @ latent_r[r] / 2.5
        score += rng.normal(scale=0.5, size=n)
        readers += [r] * n
        books += chosen.tolist()
        ratings += np.clip(np.rint(score), 1, 5).astype(int).tolist()

    shares = rng.dirichlet(np.ones(10) * 0.5, size=N_BOOKS)
    traits = []
    for b in range(N_BOOKS):
        if b % 10 == 9:
            traits.append(None)  # not extracted
            continue
        traits.append(
            {
                "pace": "unknown" if b % 7 == 0 else PACES[int(latent_b[b, 0] > 0) + int(latent_b[b, 0] > 1)],
                "tone": TRAIT_VOCABULARY["tone"][b % 8],
                "contentIntensity": TRAIT_VOCABULARY["contentIntensity"][b % 3],
                "themes": sorted({THEMES[int(abs(latent_b[b, 1]) * 5) % 17], THEMES[b % 17]}),
            }
        )
    return {
        "books": [{"editionId": f"e{b}", "workId": f"w{b}", "title": f"Book {b}", "ratingCount": 1000 - b} for b in range(N_BOOKS)],
        "reader_ids": [f"r{r}" for r in range(N_READERS)],
        "reader": np.array(readers),
        "book": np.array(books),
        "rating": np.array(ratings),
        "embeddings": emb,
        "genre_shares": shares,
        "genre_names": [f"genre {g}" for g in range(10)],
        "traits": traits,
    }


@pytest.fixture
def params() -> dict:
    p = copy.deepcopy(load_params())
    p["data"]["eval_readers"] = 150
    p["metrics"]["bootstrap_samples"] = 200
    p["metrics"]["learning_curve"] = [5, 10, 20]
    p["models"]["b3"]["similarity_shrinkage"] = 10.0
    return p


@pytest.fixture
def snapshot_dir(tmp_path: Path) -> Path:
    directory = tmp_path / "snapshot"
    snapshot.save(directory, synthetic_parts(), {"source": "synthetic test data"})
    return directory


@pytest.fixture
def snap(snapshot_dir: Path) -> snapshot.Snapshot:
    return snapshot.load(snapshot_dir)
