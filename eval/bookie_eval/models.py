"""Reference implementations of B0 to B4 (spec 7), as the harness evaluates them.

BE-13 exports these to the database and scores them in TypeScript with a
parity test (D-006), so every step here is a small, explicit calculation.

A model sees a reader's *profile* (their rated books and ratings) and scores
*target* books on the 1 to 5 scale. Each model is built from a few components
computed once per reader and target set:

- B0 global average rating: the book's average rating in the population,
  shrunk toward the global mean.
- B1 questionnaire and trait match (v1): reader mean plus fixed-weight
  matches between the reader's questionnaire and the book's genres, pace and
  themes. Offline readers have no questionnaire, so one is derived from the
  profile (D-023); unknown answers and unknown book traits add nothing (MODEL-2).
- B2 taste vector: profile embeddings weighted by (rating - reader mean),
  cosine similarity to the book, mapped to the scale by a regression fitted on
  the validation split. The traits-only ablation does the same with one-hot
  trait vectors.
- B3 item-based collaborative filtering with baseline correction: population
  item similarities, applied to the reader's own ratings (fold-in, no
  retraining), as the API will do for a new reader. The neighbours' weighted
  average is damped (divided by the weights' sum plus a constant chosen on the
  validation split), because similarities between popular books are small and
  one weak neighbour would otherwise decide a prediction.
- B4 hybrid: a linear blend of B2 and B3 fitted on the validation split; the
  questionnaire-prior ablation adds B1 to the blend.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import numpy as np
from scipy import sparse

from .snapshot import Snapshot
from .splits import Population

TRAIT_VOCABULARY = {
    "pace": ["slow", "moderate", "fast"],
    "tone": ["dark", "light", "serious", "humorous", "hopeful", "melancholic", "tense", "romantic"],
    "contentIntensity": ["low", "moderate", "high"],
    "themes": [
        "love and romance",
        "family",
        "friendship",
        "coming of age",
        "grief and loss",
        "war and conflict",
        "identity",
        "power and politics",
        "crime and justice",
        "survival",
        "faith and religion",
        "social class and inequality",
        "adventure and quest",
        "mental health",
        "addiction",
        "violence",
        "tragedy",
    ],
}
PACES = TRAIT_VOCABULARY["pace"]
THEMES = TRAIT_VOCABULARY["themes"]

MODEL_IDS = ("B0", "B1", "B2", "B3", "B4")
ABLATION_IDS = ("B2", "B2-traits", "B4", "B4+prior")


def clip(x: np.ndarray) -> np.ndarray:
    return np.clip(x, 1.0, 5.0)


@dataclass
class BookFeatures:
    embeddings: np.ndarray  # [n, d] unit rows, zero = missing
    trait_vectors: np.ndarray  # [n, 31] unit rows, zero = no known trait
    genres: np.ndarray  # bool [n, n_genres]
    pace: np.ndarray  # int [n], index into PACES, -1 = unknown
    themes: np.ndarray  # bool [n, len(THEMES)]
    has_traits: np.ndarray  # bool [n]


def book_features(snapshot: Snapshot, params: dict[str, Any]) -> BookFeatures:
    n = snapshot.n_books
    sizes = [len(TRAIT_VOCABULARY[k]) for k in ("pace", "tone", "contentIntensity", "themes")]
    offsets = np.cumsum([0, *sizes])
    vectors = np.zeros((n, offsets[-1]))
    pace = np.full(n, -1, dtype=np.int64)
    themes = np.zeros((n, len(THEMES)), dtype=bool)
    for i, t in enumerate(snapshot.traits):
        if t is None:
            continue
        for j, key in enumerate(("pace", "tone", "contentIntensity")):
            if t[key] in TRAIT_VOCABULARY[key]:
                vectors[i, offsets[j] + TRAIT_VOCABULARY[key].index(t[key])] = 1.0
        for theme in t["themes"]:
            if theme in THEMES:
                vectors[i, offsets[3] + THEMES.index(theme)] = 1.0
                themes[i, THEMES.index(theme)] = True
        if t["pace"] in PACES:
            pace[i] = PACES.index(t["pace"])
    norms = np.linalg.norm(vectors, axis=1, keepdims=True)
    vectors = np.divide(vectors, norms, out=np.zeros_like(vectors), where=norms > 0)
    return BookFeatures(
        embeddings=snapshot.embeddings.astype(np.float64),
        trait_vectors=vectors,
        genres=snapshot.genre_shares >= params["models"]["b1"]["genre_share"],
        pace=pace,
        themes=themes,
        has_traits=np.array([t is not None for t in snapshot.traits]),
    )


@dataclass
class PopulationModel:
    """What B0 and B3 learn from the population (never from evaluated readers)."""

    mean: float
    item_bias: np.ndarray  # [n_books]
    similarity: np.ndarray  # [n_books, n_books], diagonal 0
    reader_shrinkage: float
    neighbours: int
    weight_shrinkage_grid: tuple[float, ...]


def fit_population(population: Population, n_books: int, params: dict[str, Any]) -> PopulationModel:
    lam_i = params["models"]["baseline"]["item_shrinkage"]
    lam_u = params["models"]["baseline"]["reader_shrinkage"]
    r, u, i = population.rating, population.reader, population.book
    mu = float(r.mean())
    n_i = np.bincount(i, minlength=n_books)
    n_u = np.bincount(u, minlength=population.n_readers)
    b_i = np.bincount(i, weights=r - mu, minlength=n_books) / (lam_i + n_i)
    b_u = np.zeros(population.n_readers)
    for _ in range(2):  # two alternating passes are enough for biases
        b_u = np.bincount(u, weights=r - mu - b_i[i], minlength=population.n_readers) / (lam_u + n_u)
        b_i = np.bincount(i, weights=r - mu - b_u[u], minlength=n_books) / (lam_i + n_i)

    # Pearson-baseline similarity over co-rating readers, shrunk by support.
    z = r - mu - b_u[u] - b_i[i]
    shape = (population.n_readers, n_books)
    Z = sparse.csr_matrix((z, (u, i)), shape=shape)
    B = sparse.csr_matrix((np.ones_like(z), (u, i)), shape=shape)
    Z2 = sparse.csr_matrix((z * z, (u, i)), shape=shape)
    numerator = (Z.T @ Z).toarray()
    sq = (Z2.T @ B).toarray()  # sq[a, b] = sum of z_a^2 over readers who rated a and b
    support = (B.T @ B).toarray()
    denominator = np.sqrt(sq * sq.T)
    sim = np.divide(numerator, denominator, out=np.zeros_like(numerator), where=denominator > 0)
    sim *= support / (support + params["models"]["b3"]["similarity_shrinkage"])
    np.fill_diagonal(sim, 0.0)
    return PopulationModel(
        mean=mu,
        item_bias=b_i,
        similarity=sim,
        reader_shrinkage=lam_u,
        neighbours=params["models"]["b3"]["neighbours"],
        weight_shrinkage_grid=tuple(params["models"]["b3"]["weight_shrinkage_grid"]),
    )


@dataclass
class Components:
    """Everything the models need for one reader and one set of target books."""

    reader_mean: float
    b0: np.ndarray
    b1: np.ndarray
    cos_embedding: np.ndarray
    cos_traits: np.ndarray
    b3: np.ndarray  # [len(weight_shrinkage_grid), n_targets]


def _cosine_to_taste(vectors: np.ndarray, books: np.ndarray, weights: np.ndarray, targets: np.ndarray) -> np.ndarray:
    taste = weights @ vectors[books]
    norm = np.linalg.norm(taste)
    if norm == 0.0:
        return np.zeros(len(targets))
    return vectors[targets] @ (taste / norm)


def derived_questionnaire(
    feats: BookFeatures, books: np.ndarray, deviations: np.ndarray, params: dict[str, Any]
) -> dict[str, Any]:
    """Liked and disliked genres, a preferred pace and themes to avoid, from ratings.

    Anything without enough evidence stays unknown (None or False), like an
    unanswered question.
    """
    p = params["models"]["b1"]
    threshold, min_books = p["preference_threshold"], p["min_books"]

    def lean(mask: np.ndarray) -> np.ndarray:
        """Mean deviation per column over the books that have it; nan if too few."""
        counts = mask.sum(axis=0)
        sums = (mask * deviations[:, None]).sum(axis=0)
        return np.where(counts >= min_books, sums / np.maximum(counts, 1), np.nan)

    genre_lean = lean(feats.genres[books])
    pace_mask = feats.pace[books][:, None] == np.arange(len(PACES))[None, :]
    pace_lean = lean(pace_mask)
    theme_lean = lean(feats.themes[books])
    with np.errstate(invalid="ignore"):
        liked = genre_lean >= threshold
        disliked = genre_lean <= -threshold
        avoid = theme_lean <= -threshold
        pace_ok = pace_lean >= threshold
    preferred = int(np.nanargmax(np.where(pace_ok, pace_lean, np.nan))) if pace_ok.any() else None
    return {"liked": liked, "disliked": disliked, "pace": preferred, "avoid": avoid}


def b1_scores(
    feats: BookFeatures,
    questionnaire: dict[str, Any],
    reader_mean: float,
    targets: np.ndarray,
    params: dict[str, Any],
) -> np.ndarray:
    p = params["models"]["b1"]
    g = feats.genres[targets]
    score = reader_mean + p["weight_genre"] * (
        (g & questionnaire["liked"]).sum(axis=1) - (g & questionnaire["disliked"]).sum(axis=1)
    )
    if questionnaire["pace"] is not None:
        known = feats.pace[targets] >= 0
        match = np.where(feats.pace[targets] == questionnaire["pace"], 1.0, -1.0)
        score = score + p["weight_pace"] * np.where(known, match, 0.0)
    score = score - p["weight_theme_avoid"] * (feats.themes[targets] & questionnaire["avoid"]).sum(axis=1)
    return clip(score)


def b3_scores(pop: PopulationModel, books: np.ndarray, ratings: np.ndarray, targets: np.ndarray) -> np.ndarray:
    """B3 for each damping value in the grid: shape [grid, targets]."""
    b_u = float((ratings - pop.mean - pop.item_bias[books]).sum() / (pop.reader_shrinkage + len(books)))
    residual = ratings - pop.mean - b_u - pop.item_bias[books]
    base = pop.mean + b_u + pop.item_bias[targets]
    sims = pop.similarity[np.ix_(targets, books)]
    sims = np.where(sims > 0, sims, 0.0)
    if len(books) > pop.neighbours:
        # The k most similar rated books per target (stable, so ties are deterministic).
        order = np.argsort(-sims, axis=1, kind="stable")[:, : pop.neighbours]
        keep = np.zeros_like(sims, dtype=bool)
        np.put_along_axis(keep, order, True, axis=1)
        sims = np.where(keep, sims, 0.0)
    weight = sims.sum(axis=1)
    numerator = sims @ residual
    rows = []
    for damping in pop.weight_shrinkage_grid:
        denominator = weight + damping
        rows.append(np.divide(numerator, denominator, out=np.zeros(len(targets)), where=denominator > 0))
    return clip(base[None, :] + np.array(rows))


def components(
    feats: BookFeatures,
    pop: PopulationModel,
    books: np.ndarray,
    ratings: np.ndarray,
    targets: np.ndarray,
    params: dict[str, Any],
) -> Components:
    reader_mean = float(ratings.mean())
    deviations = ratings - reader_mean
    questionnaire = derived_questionnaire(feats, books, deviations, params)
    return Components(
        reader_mean=reader_mean,
        b0=clip(pop.mean + pop.item_bias[targets]),
        b1=b1_scores(feats, questionnaire, reader_mean, targets, params),
        cos_embedding=_cosine_to_taste(feats.embeddings, books, deviations, targets),
        cos_traits=_cosine_to_taste(feats.trait_vectors, books, deviations, targets),
        b3=b3_scores(pop, books, ratings, targets),
    )


# --- Tuned parts: least squares on validation rows -------------------------


def _lstsq(x: np.ndarray, y: np.ndarray) -> np.ndarray:
    return np.linalg.lstsq(x, y, rcond=None)[0]


def _mapping_design(c: Components, cos: np.ndarray) -> np.ndarray:
    return np.column_stack([np.ones(len(cos)), np.full(len(cos), c.reader_mean), cos])


@dataclass
class Tuned:
    """Fitted coefficients (the B2 mappings and the B4 blends)."""

    b3_index: int  # chosen damping in the grid
    b3_damping: float
    b2: np.ndarray  # [intercept, reader mean, cosine]
    b2_traits: np.ndarray
    b4: np.ndarray  # [intercept, B2, B3]
    b4_prior: np.ndarray  # [intercept, B2, B3, B1]

    def as_dict(self) -> dict[str, dict[str, float]]:
        return {
            "B3": {"weightDamping": self.b3_damping},
            "B2": {"intercept": self.b2[0], "readerMean": self.b2[1], "cosine": self.b2[2]},
            "B2-traits": {
                "intercept": self.b2_traits[0],
                "readerMean": self.b2_traits[1],
                "cosine": self.b2_traits[2],
            },
            "B4": {"intercept": self.b4[0], "B2": self.b4[1], "B3": self.b4[2]},
            "B4+prior": {
                "intercept": self.b4_prior[0],
                "B2": self.b4_prior[1],
                "B3": self.b4_prior[2],
                "B1": self.b4_prior[3],
            },
        }


def fit_tuned(rows: list[tuple[Components, np.ndarray]], grid: tuple[float, ...]) -> Tuned:
    """rows: (components for a reader's validation books, their actual ratings)."""
    from .metrics import spearman

    # B3's damping: the best mean per-reader Spearman (the selection metric), first on ties.
    per_value = [np.nanmean([spearman(c.b3[g], actual) for c, actual in rows]) for g in range(len(grid))]
    b3_index = int(np.argmax(per_value))
    y = np.concatenate([actual for _, actual in rows])
    b2 = _lstsq(np.vstack([_mapping_design(c, c.cos_embedding) for c, _ in rows]), y)
    b2t = _lstsq(np.vstack([_mapping_design(c, c.cos_traits) for c, _ in rows]), y)
    b2_pred = np.concatenate([clip(_mapping_design(c, c.cos_embedding) @ b2) for c, _ in rows])
    b3 = np.concatenate([c.b3[b3_index] for c, _ in rows])
    b1 = np.concatenate([c.b1 for c, _ in rows])
    ones = np.ones(len(y))
    b4 = _lstsq(np.column_stack([ones, b2_pred, b3]), y)
    b4p = _lstsq(np.column_stack([ones, b2_pred, b3, b1]), y)
    return Tuned(b3_index=b3_index, b3_damping=float(grid[b3_index]), b2=b2, b2_traits=b2t, b4=b4, b4_prior=b4p)


def predict(model: str, c: Components, tuned: Tuned) -> np.ndarray:
    if model == "B0":
        return c.b0
    if model == "B1":
        return c.b1
    b3 = c.b3[tuned.b3_index]
    if model == "B3":
        return b3
    b2 = clip(_mapping_design(c, c.cos_embedding) @ tuned.b2)
    if model == "B2":
        return b2
    if model == "B2-traits":
        return clip(_mapping_design(c, c.cos_traits) @ tuned.b2_traits)
    if model == "B4":
        return clip(tuned.b4[0] + tuned.b4[1] * b2 + tuned.b4[2] * b3)
    if model == "B4+prior":
        p = tuned.b4_prior
        return clip(p[0] + p[1] * b2 + p[2] * b3 + p[3] * c.b1)
    raise ValueError(f"unknown model {model}")
