"""Exports the evaluated models as a release the API loads and serves (BE-13, D-006, D-024).

A release is one folder under data/derived/models/<version>/ (git-ignored: it
is derived from the dataset, D-004):

- release.json: the version, the shipped model, every model's parameters and
  its validation and test results (EVAL-2), the books the population models
  know, and a checksum of each data file.
- item_bias.csv: each known book's average-rating offset (B0 and B3).
- neighbours.csv: every positive item similarity (B3), both directions.

Floats are written with full precision (repr), so the API scores with exactly
the numbers that were evaluated. `pnpm --filter @bookie/api models:load` loads it.
"""

from __future__ import annotations

import csv
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np

from .report import rounded
from .models import MODEL_IDS, PACES, THEMES, PopulationModel, Tuned
from .params import REPO_ROOT
from .snapshot import Snapshot


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def release_version(snapshot_checksum: str, harness_checksum: str, today: str | None = None) -> str:
    """'2026-10-21.3f9a12c0': the export date and a hash of the data and the code."""
    digest = hashlib.sha256(f"{snapshot_checksum}:{harness_checksum}".encode()).hexdigest()[:8]
    return f"{today or datetime.now(timezone.utc).strftime('%Y-%m-%d')}.{digest}"


def model_parameters(
    params: dict[str, Any], pop: PopulationModel, tuned: Tuned, genre_names: list[str], embedding_model: str
) -> dict[str, dict[str, Any]]:
    """What the TypeScript scorer needs for each model, nothing else."""
    b1 = params["models"]["b1"]
    return {
        "B0": {"globalMean": pop.mean},
        "B1": {
            "weightGenre": b1["weight_genre"],
            "weightPace": b1["weight_pace"],
            "weightThemeAvoid": b1["weight_theme_avoid"],
            "genreShare": b1["genre_share"],
            "genreNames": genre_names,
            "sensitivityWeights": b1["sensitivity_weights"],
            "themeMap": b1["theme_map"],
            "paces": PACES,
            "themes": THEMES,
        },
        "B2": {
            "intercept": float(tuned.b2[0]),
            "readerMean": float(tuned.b2[1]),
            "cosine": float(tuned.b2[2]),
            "embeddingModel": embedding_model,
        },
        "B3": {
            "globalMean": pop.mean,
            "readerShrinkage": pop.reader_shrinkage,
            "neighbours": pop.neighbours,
            "weightDamping": tuned.b3_damping,
        },
        "B4": {"intercept": float(tuned.b4[0]), "b2": float(tuned.b4[1]), "b3": float(tuned.b4[2])},
    }


def export(
    snapshot: Snapshot,
    params: dict[str, Any],
    results: dict[str, Any],
    fitted: dict[str, Any],
    out_root: Path | None = None,
) -> Path:
    pop: PopulationModel = fitted["population"]
    tuned: Tuned = fitted["tuned"]
    prov = results["provenance"]
    version = release_version(prov["snapshot"]["checksum"], prov["harnessChecksum"])
    folder = (out_root or REPO_ROOT / "data" / "derived" / "models") / version
    folder.mkdir(parents=True, exist_ok=True)
    ids = [b["editionId"] for b in snapshot.books]

    with (folder / "item_bias.csv").open("w", newline="", encoding="utf-8") as f:
        w = csv.writer(f, lineterminator="\n")
        w.writerow(["edition_id", "item_bias"])
        for edition_id, bias in zip(ids, pop.item_bias):
            w.writerow([edition_id, repr(float(bias))])
    rows, cols = np.nonzero(pop.similarity > 0)
    with (folder / "neighbours.csv").open("w", newline="", encoding="utf-8") as f:
        w = csv.writer(f, lineterminator="\n")
        w.writerow(["edition_id", "neighbour_id", "similarity"])
        for i, j in zip(rows, cols):
            w.writerow([ids[i], ids[j], repr(float(pop.similarity[i, j]))])

    parameters = model_parameters(params, pop, tuned, snapshot.genre_names, params["data"]["embedding_model"])
    release = {
        "version": version,
        "shipped": fitted["shipped"],
        "selection": results["selection"]["metric"],
        "seed": params["split"]["seed"],
        "snapshotChecksum": prov["snapshot"]["checksum"],
        "harnessChecksum": prov["harnessChecksum"],
        "books": len(ids),
        "neighbourPairs": int(len(rows)),
        "models": {
            m: {"parameters": parameters[m], "metrics": rounded(results["models"][m])} for m in MODEL_IDS
        },
        "files": {name: _sha256(folder / name) for name in ("item_bias.csv", "neighbours.csv")},
    }
    (folder / "release.json").write_text(json.dumps(release, indent=2), "utf-8", newline="\n")
    return folder
