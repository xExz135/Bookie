"""The served scoring rules in Python, and the parity fixture (D-006, MODEL-1).

`served_scores` is exactly what the API computes for one reader and a set of
target books, given a release. `fixture()` builds a small synthetic release
and reader cases (no dataset data), with the scores Python gives; the file is
committed as eval/parity/model-parity.json. The TypeScript scorer must
reproduce every score within 1e-6 (apps/api parity test), and a Python test
checks the committed file is current.

Differences from the evaluation, all because a live reader is not a dataset reader:
- B1 uses the reader's real questionnaire (questionnaire_from_answers).
- B3 (and so B4) uses only the reader's ratings of books the release knows;
  it is never asked about a book outside the release.
- B0 for a book outside the release is the global mean (no item offset).
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import numpy as np

from .models import (
    PACES,
    THEMES,
    BookFeatures,
    PopulationModel,
    b1_scores,
    b2_scores,
    b3_scores,
    clip,
    questionnaire_from_answers,
)
from .params import EVAL_DIR, load_params

FIXTURE = EVAL_DIR / "parity" / "model-parity.json"
TOLERANCE = 1e-6


def served_scores(
    release: dict[str, Any], profile: list[tuple[str, float]], answers: dict[str, Any], targets: list[str]
) -> dict[str, list[float | None]]:
    """Scores of every model for the targets; None where a model does not apply (B3, B4 off-release)."""
    p = release["parameters"]
    books = release["books"]
    known = {e: i for i, e in enumerate(release["knownBooks"])}
    # Every book mentioned gets a column: known books first, then the rest.
    ids = list(dict.fromkeys([*release["knownBooks"], *[e for e, _ in profile], *targets]))
    col = {e: i for i, e in enumerate(ids)}
    dim = len(next(v for b in books.values() if (v := b.get("embedding")) is not None))
    emb = np.zeros((len(ids), dim))
    genres = np.zeros((len(ids), len(p["B1"]["genreNames"])), dtype=bool)
    pace = np.full(len(ids), -1)
    themes = np.zeros((len(ids), len(THEMES)), dtype=bool)
    for e, i in col.items():
        b = books.get(e, {})
        if b.get("embedding") is not None:
            emb[i] = b["embedding"]
        shares = b.get("genreShares", {})
        genres[i] = [shares.get(g, 0.0) >= p["B1"]["genreShare"] for g in p["B1"]["genreNames"]]
        if b.get("pace") in PACES:
            pace[i] = PACES.index(b["pace"])
        for t in b.get("themes", []):
            themes[i, THEMES.index(t)] = True
    feats = BookFeatures(
        embeddings=emb,
        trait_vectors=np.zeros((len(ids), 1)),
        genres=genres,
        pace=pace,
        themes=themes,
        has_traits=pace >= 0,
    )
    b1_params = {
        "models": {
            "b1": {
                "weight_genre": p["B1"]["weightGenre"],
                "weight_pace": p["B1"]["weightPace"],
                "weight_theme_avoid": p["B1"]["weightThemeAvoid"],
                "sensitivity_weights": p["B1"]["sensitivityWeights"],
                "theme_map": p["B1"]["themeMap"],
            }
        }
    }
    item_bias = np.zeros(len(ids))
    for e, bias in release["itemBias"].items():
        item_bias[col[e]] = bias
    sim = np.zeros((len(ids), len(ids)))
    for a, b, s in release["neighbours"]:
        sim[col[a], col[b]] = s
    pop = PopulationModel(
        mean=p["B3"]["globalMean"],
        item_bias=item_bias,
        similarity=sim,
        reader_shrinkage=p["B3"]["readerShrinkage"],
        neighbours=p["B3"]["neighbours"],
        weight_shrinkage_grid=(p["B3"]["weightDamping"],),
    )

    t = np.array([col[e] for e in targets])
    pb = np.array([col[e] for e, _ in profile])
    pr = np.array([r for _, r in profile], dtype=np.float64)
    reader_mean = float(pr.mean())
    questionnaire = questionnaire_from_answers(answers, p["B1"]["genreNames"], b1_params)
    b0 = clip(p["B0"]["globalMean"] + item_bias[t])
    b1 = b1_scores(feats, questionnaire, reader_mean, t, b1_params)
    c2 = p["B2"]
    b2 = b2_scores(emb, pb, pr, t, np.array([c2["intercept"], c2["readerMean"], c2["cosine"]]))
    in_release = np.array([e in known for e, _ in profile])
    target_known = np.array([e in known for e in targets])
    b3 = np.full(len(t), np.nan)
    if in_release.any() and target_known.any():
        b3[target_known] = b3_scores(pop, pb[in_release], pr[in_release], t[target_known])[0]
    c4 = p["B4"]
    b4 = np.where(target_known, clip(c4["intercept"] + c4["b2"] * b2 + c4["b3"] * np.nan_to_num(b3)), np.nan)

    def out(x: np.ndarray) -> list[float | None]:
        return [None if np.isnan(v) else float(v) for v in x]

    return {"B0": out(b0), "B1": out(b1), "B2": out(b2), "B3": out(b3), "B4": out(b4)}


def _synthetic_release(params: dict[str, Any]) -> dict[str, Any]:
    rng = np.random.default_rng(42)
    known = [f"00000000-0000-4000-8000-{i:012d}" for i in range(1, 9)]
    outside = ["00000000-0000-4000-8000-000000000101", "00000000-0000-4000-8000-000000000102"]
    genre_names = ["fantasy, paranormal", "romance", "young-adult"]
    emb = rng.normal(size=(len(known) + 2, 6))
    emb /= np.linalg.norm(emb, axis=1, keepdims=True)
    books: dict[str, Any] = {}
    for i, e in enumerate(known + outside):
        books[e] = {
            # The second book outside the release has no embedding.
            "embedding": None if e == outside[1] else emb[i].tolist(),
            "genreShares": dict(zip(genre_names, rng.dirichlet(np.ones(3)).tolist())),
            "pace": [*PACES, "unknown"][i % 4],
            "themes": sorted({THEMES[(3 * i) % 17], THEMES[(5 * i + 1) % 17], "violence" if i % 3 == 0 else THEMES[i % 17]}),
        }
    sim = rng.normal(scale=0.2, size=(8, 8))
    sim = (sim + sim.T) / 2
    np.fill_diagonal(sim, 0.0)
    neighbours = [[known[a], known[b], float(sim[a, b])] for a in range(8) for b in range(8) if sim[a, b] > 0]
    b1 = params["models"]["b1"]
    return {
        "knownBooks": known,
        "books": books,
        "itemBias": dict(zip(known, rng.normal(scale=0.4, size=8).tolist())),
        "neighbours": neighbours,
        "parameters": {
            "B0": {"globalMean": 3.9},
            "B1": {
                "weightGenre": b1["weight_genre"],
                "weightPace": b1["weight_pace"],
                "weightThemeAvoid": b1["weight_theme_avoid"],
                "genreShare": b1["genre_share"],
                "genreNames": genre_names,
                "sensitivityWeights": b1["sensitivity_weights"],
                "themeMap": b1["theme_map"],
            },
            "B2": {"intercept": 0.85, "readerMean": 0.78, "cosine": 3.0},
            "B3": {"globalMean": 3.9, "readerShrinkage": 10.0, "neighbours": 3, "weightDamping": 0.5},
            "B4": {"intercept": 0.15, "b2": 0.1, "b3": 0.95},
        },
    }


NO_ANSWERS = {"likedGenres": [], "dislikedGenres": [], "pace": None, "themesToAvoid": []}


def fixture() -> dict[str, Any]:
    release = _synthetic_release(load_params())
    known, outside = release["knownBooks"], [e for e in release["books"] if e not in release["knownBooks"]]
    answered = {
        "likedGenres": ["fantasy, paranormal"],
        "dislikedGenres": ["romance"],
        "pace": "fast",
        "themesToAvoid": [
            {"theme": "Graphic violence and physical harm", "sensitivity": "high"},
            {"theme": "Grief and bereavement", "sensitivity": "low"},
        ],
    }
    cases = [
        ("typical reader, every answer given", [(known[0], 5), (known[1], 4), (known[2], 2), (known[3], 3), (known[4], 5)], answered, known[5:] + outside),
        ("every rating equal: no taste direction", [(known[0], 4), (known[1], 4), (known[2], 4)], answered, known[3:]),
        ("no answers: unknown preferences add nothing (MODEL-2)", [(known[0], 2), (known[1], 5), (known[6], 3)], NO_ANSWERS, known[2:6]),
        ("rated books outside the release and without an embedding", [(known[0], 5), (outside[0], 1), (outside[1], 4), (known[7], 2)], answered, known[1:5]),
        ("more rated books than neighbours", [(known[i], r) for i, r in zip(range(6), [5, 1, 4, 2, 5, 3])], NO_ANSWERS, known[6:] + outside[:1]),
    ]
    out = []
    for name, profile, answers, targets in cases:
        out.append(
            {
                "name": name,
                "profile": [{"editionId": e, "rating": r} for e, r in profile],
                "answers": answers,
                "targets": targets,
                "expected": served_scores(release, profile, answers, targets),
            }
        )
    return {
        "about": "Parity fixture (D-006): synthetic, no dataset data. Generated by `pnpm eval parity`; do not edit.",
        "tolerance": TOLERANCE,
        "release": release,
        "cases": out,
    }


def write(path: Path = FIXTURE) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(fixture(), indent=1) + "\n", "utf-8", newline="\n")
    return path
