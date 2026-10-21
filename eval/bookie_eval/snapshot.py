"""The data the evaluation runs on, frozen in files (EVAL-1).

`extract` reads the dev database (catalog, dataset ratings, embeddings) and the
trait cache written by `traits:extract`, and writes one snapshot folder under
data/derived/eval/ (git-ignored: it holds dataset reader IDs, D-004). Every run
reads the snapshot, never the database, so the numbers depend only on the
snapshot, the parameters and the seed. The manifest records a checksum of
every file; results name the manifest's checksum.
"""

from __future__ import annotations

import hashlib
import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

from .params import REPO_ROOT

TRAIT_KEYS = ("pace", "tone", "contentIntensity", "themes")


@dataclass
class Snapshot:
    """Books are indexed 0..n_books-1, readers 0..n_readers-1."""

    books: list[dict[str, Any]]
    reader_ids: list[str]
    reader: np.ndarray  # int32, one per rating
    book: np.ndarray  # int32, one per rating
    rating: np.ndarray  # int8, 1 to 5
    embeddings: np.ndarray  # float32 [n_books, d], unit length; zero row = missing
    has_embedding: np.ndarray  # bool [n_books]
    genre_names: list[str]
    genre_shares: np.ndarray  # float32 [n_books, n_genres], each row sums to 1 or 0
    traits: list[dict[str, Any] | None]  # per book; None = not extracted
    manifest: dict[str, Any]

    @property
    def n_books(self) -> int:
        return len(self.books)

    @property
    def n_readers(self) -> int:
        return len(self.reader_ids)


def default_dir(params: dict[str, Any]) -> Path:
    return REPO_ROOT / "data" / "derived" / "eval" / f"snapshot-top{params['data']['top_editions']}"


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def manifest_checksum(manifest: dict[str, Any]) -> str:
    """One checksum for the whole snapshot: the files' checksums and the counts."""
    body = json.dumps({"files": manifest["files"], "counts": manifest["counts"]}, sort_keys=True)
    return hashlib.sha256(body.encode()).hexdigest()


def save(directory: Path, snap_parts: dict[str, Any], info: dict[str, Any]) -> dict[str, Any]:
    """Writes the files of a snapshot and its manifest. Used by extract and by tests."""
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "books.json").write_text(json.dumps(snap_parts["books"], indent=1), "utf-8", newline="\n")
    (directory / "readers.json").write_text(json.dumps(snap_parts["reader_ids"]), "utf-8", newline="\n")
    np.savez_compressed(
        directory / "ratings.npz",
        reader=snap_parts["reader"].astype(np.int32),
        book=snap_parts["book"].astype(np.int32),
        rating=snap_parts["rating"].astype(np.int8),
    )
    np.save(directory / "embeddings.npy", snap_parts["embeddings"].astype(np.float32))
    np.save(directory / "genres.npy", snap_parts["genre_shares"].astype(np.float32))
    (directory / "genre_names.json").write_text(json.dumps(snap_parts["genre_names"]), "utf-8", newline="\n")
    (directory / "traits.json").write_text(json.dumps(snap_parts["traits"], indent=1), "utf-8", newline="\n")
    files = {
        name: _sha256(directory / name)
        for name in (
            "books.json",
            "readers.json",
            "ratings.npz",
            "embeddings.npy",
            "genres.npy",
            "genre_names.json",
            "traits.json",
        )
    }
    has_embedding = np.linalg.norm(snap_parts["embeddings"], axis=1) > 0
    manifest = {
        **info,
        "counts": {
            "books": len(snap_parts["books"]),
            "readers": len(snap_parts["reader_ids"]),
            "ratings": int(len(snap_parts["rating"])),
            "booksWithEmbedding": int(has_embedding.sum()),
            "booksWithTraits": int(sum(t is not None for t in snap_parts["traits"])),
        },
        "files": files,
    }
    (directory / "manifest.json").write_text(json.dumps(manifest, indent=2), "utf-8", newline="\n")
    return manifest


def load(directory: Path) -> Snapshot:
    manifest = json.loads((directory / "manifest.json").read_text("utf-8"))
    for name, digest in manifest["files"].items():
        if _sha256(directory / name) != digest:
            raise RuntimeError(f"{directory / name} does not match its checksum in manifest.json")
    ratings = np.load(directory / "ratings.npz")
    embeddings = np.load(directory / "embeddings.npy")
    return Snapshot(
        books=json.loads((directory / "books.json").read_text("utf-8")),
        reader_ids=json.loads((directory / "readers.json").read_text("utf-8")),
        reader=ratings["reader"],
        book=ratings["book"],
        rating=ratings["rating"],
        embeddings=embeddings,
        has_embedding=np.linalg.norm(embeddings, axis=1) > 0,
        genre_names=json.loads((directory / "genre_names.json").read_text("utf-8")),
        genre_shares=np.load(directory / "genres.npy"),
        traits=json.loads((directory / "traits.json").read_text("utf-8")),
        manifest=manifest,
    )


def _database_url() -> str:
    url = os.environ.get("DATABASE_URL")
    env_file = REPO_ROOT / ".env"
    if not url and env_file.exists():
        for line in env_file.read_text("utf-8").splitlines():
            key, _, value = line.partition("=")
            if key.strip() == "DATABASE_URL":
                url = value.strip().strip('"').strip("'")
    if not url:
        raise RuntimeError("DATABASE_URL is not set (root .env or environment).")
    return url


def _read_traits(params: dict[str, Any], edition_ids: list[str]) -> tuple[list[Any], dict[str, int]]:
    folder = (
        REPO_ROOT
        / "data"
        / "derived"
        / "traits"
        / params["data"]["trait_model"]
        / params["data"]["trait_prompt_version"]
    )
    out: list[Any] = []
    counts = {"extracted": 0, "failed": 0, "missing": 0}
    for edition_id in edition_ids:
        file = folder / f"{edition_id}.json"
        if not file.exists():
            out.append(None)
            counts["missing"] += 1
            continue
        record = json.loads(file.read_text("utf-8"))
        if "error" in record:
            out.append(None)
            counts["failed"] += 1
            continue
        t = record["traits"]
        # Values only; "unknown" stays unknown (MODEL-2).
        out.append(
            {
                "pace": t["pace"]["value"],
                "tone": t["tone"]["value"],
                "contentIntensity": t["contentIntensity"]["value"],
                "themes": sorted(v["value"] for v in t["themes"]),
            }
        )
        counts["extracted"] += 1
    return out, counts


def extract(params: dict[str, Any], directory: Path) -> dict[str, Any]:
    """Reads the database and the trait cache and writes a snapshot."""
    import psycopg  # only needed here, so tests run without a database

    data = params["data"]
    with psycopg.connect(_database_url()) as conn, conn.cursor() as cur:
        # The most-rated editions, as `embed:books` orders them, one per work.
        cur.execute(
            """
            SELECT e.id::text, e.work_id::text, e.title, f.rating_count
            FROM editions e
            LEFT JOIN review_fetches f
              ON f.edition_id = e.id AND f.reviews_version = 1
             AND f.source_id = (SELECT id FROM review_sources WHERE key = 'goodreads_dataset')
            ORDER BY f.rating_count DESC NULLS LAST, e.id
            LIMIT %s
            """,
            (data["top_editions"],),
        )
        books: list[dict[str, Any]] = []
        seen_works: set[str] = set()
        for edition_id, work_id, title, rating_count in cur.fetchall():
            if work_id in seen_works:
                continue
            seen_works.add(work_id)
            books.append(
                {"editionId": edition_id, "workId": work_id, "title": title, "ratingCount": rating_count}
            )
        index = {b["editionId"]: i for i, b in enumerate(books)}
        ids = list(index)

        # Dataset ratings only (live sources have no reader IDs we may use).
        cur.execute(
            """
            SELECT r.reviewer_external_id, r.edition_id::text, r.rating
            FROM reviews r
            WHERE r.rating IS NOT NULL AND r.reviewer_external_id IS NOT NULL
              AND r.source_id = (SELECT id FROM review_sources WHERE key = 'goodreads_dataset')
              AND r.edition_id = ANY(%s::uuid[])
            ORDER BY r.reviewer_external_id, r.edition_id
            """,
            (ids,),
        )
        reader_index: dict[str, int] = {}
        readers: list[int] = []
        book_col: list[int] = []
        ratings: list[int] = []
        for reviewer, edition_id, rating in cur:
            r = reader_index.setdefault(reviewer, len(reader_index))
            readers.append(r)
            book_col.append(index[edition_id])
            ratings.append(rating)

        cur.execute(
            """
            SELECT edition_id::text, embedding::text FROM book_embeddings
            WHERE embedding_model = %s AND edition_id = ANY(%s::uuid[])
            """,
            (data["embedding_model"], ids),
        )
        embeddings = np.zeros((len(books), 768), dtype=np.float32)
        for edition_id, vector in cur.fetchall():
            v = np.array(json.loads(vector), dtype=np.float64)
            embeddings[index[edition_id]] = v / np.linalg.norm(v)

        cur.execute("SELECT id, name FROM genres ORDER BY id")
        genre_rows = cur.fetchall()
        genre_col = {gid: i for i, (gid, _) in enumerate(genre_rows)}
        cur.execute(
            "SELECT edition_id::text, genre_id, votes FROM edition_genres WHERE edition_id = ANY(%s::uuid[])",
            (ids,),
        )
        votes = np.zeros((len(books), len(genre_rows)), dtype=np.float64)
        for edition_id, genre_id, v in cur.fetchall():
            votes[index[edition_id], genre_col[genre_id]] = v
        totals = votes.sum(axis=1, keepdims=True)
        shares = np.divide(votes, totals, out=np.zeros_like(votes), where=totals > 0)

    traits, trait_counts = _read_traits(params, ids)
    parts = {
        "books": books,
        "reader_ids": list(reader_index),
        "reader": np.array(readers, dtype=np.int32),
        "book": np.array(book_col, dtype=np.int32),
        "rating": np.array(ratings, dtype=np.int8),
        "embeddings": embeddings,
        "genre_shares": shares,
        "genre_names": [name for _, name in genre_rows],
        "traits": traits,
    }
    info = {
        "source": "dev database (Goodreads dataset, D-004) and the trait cache",
        "topEditions": data["top_editions"],
        "embeddingModel": data["embedding_model"],
        "traitModel": data["trait_model"],
        "traitPromptVersion": data["trait_prompt_version"],
        "traitFiles": trait_counts,
    }
    return save(directory, parts, info)
