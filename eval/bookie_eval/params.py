"""Loads eval/params.toml. Every number the harness uses comes from there."""

from __future__ import annotations

import tomllib
from pathlib import Path
from typing import Any

EVAL_DIR = Path(__file__).resolve().parent.parent
REPO_ROOT = EVAL_DIR.parent
DEFAULT_PARAMS = EVAL_DIR / "params.toml"


def load_params(path: Path = DEFAULT_PARAMS) -> dict[str, Any]:
    with path.open("rb") as f:
        return tomllib.load(f)
