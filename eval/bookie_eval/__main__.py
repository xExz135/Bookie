"""Command line of the offline evaluation (BE-14).

    python -m bookie_eval            # extract the snapshot if missing, then run (what `pnpm eval` does)
    python -m bookie_eval extract    # re-read the database and the trait cache into a new snapshot
    python -m bookie_eval run        # run on the existing snapshot only
    python -m bookie_eval export     # run, then export the models for the API (BE-13)
    python -m bookie_eval parity     # rewrite the Python/TypeScript parity fixture (D-006)
    python -m bookie_eval study      # the user study report from the database (FE-10, D-027)

Results go to eval/results/offline/ and are committed: they hold numbers only.
"""

from __future__ import annotations

import os

# One thread per numeric library, so sums happen in the same order on every run (EVAL-1).
for _var in ("OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS", "OMP_NUM_THREADS"):
    os.environ.setdefault(_var, "1")

import argparse  # noqa: E402
import hashlib  # noqa: E402
import platform  # noqa: E402
import sys  # noqa: E402
import time  # noqa: E402
from pathlib import Path  # noqa: E402

import numpy as np  # noqa: E402
import scipy  # noqa: E402

from . import experiment, export, parity, report, snapshot, study  # noqa: E402
from .params import DEFAULT_PARAMS, EVAL_DIR, load_params  # noqa: E402

RESULTS_DIR = EVAL_DIR / "results" / "offline"


def harness_checksum(params_path: Path) -> str:
    """Checksum of the code and parameters that produce the numbers."""
    h = hashlib.sha256()
    for path in sorted((EVAL_DIR / "bookie_eval").glob("*.py")) + [params_path]:
        h.update(path.name.encode())
        h.update(path.read_bytes().replace(b"\r\n", b"\n"))
    return h.hexdigest()


def run(params_path: Path, snapshot_dir: Path, out_dir: Path, export_to: Path | None = None, do_export: bool = False) -> dict:
    params = load_params(params_path)
    snap = snapshot.load(snapshot_dir)
    started = time.perf_counter()
    fitted: dict = {}
    results = experiment.run(snap, params, log=lambda m: print(f"  {m}", flush=True), fitted=fitted)
    results["provenance"] = {
        "harnessChecksum": harness_checksum(params_path),
        "params": params,
        "snapshot": {
            "checksum": snapshot.manifest_checksum(snap.manifest),
            **{k: v for k, v in snap.manifest.items() if k != "files"},
        },
        "libraries": {"python": platform.python_version(), "numpy": np.__version__, "scipy": scipy.__version__},
    }
    report.write(results, out_dir)
    print(f"Done in {time.perf_counter() - started:.0f} s. Results in {out_dir}")
    if do_export:
        folder = export.export(snap, params, results, fitted, export_to)
        print(f"Models exported to {folder}")
    return results


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="bookie_eval", description=__doc__)
    parser.add_argument("command", nargs="?", default="all", choices=["all", "extract", "run", "export", "parity", "study"])
    parser.add_argument("--params", type=Path, default=DEFAULT_PARAMS)
    parser.add_argument("--snapshot", type=Path, default=None, help="snapshot folder (default under data/derived/eval)")
    parser.add_argument("--out", type=Path, default=RESULTS_DIR)
    parser.add_argument("--models-out", type=Path, default=None, help="release folder root (default data/derived/models)")
    args = parser.parse_args(argv)

    if args.command == "parity":
        print(f"Parity fixture written to {parity.write()}")
        return 0
    params = load_params(args.params)
    if args.command == "study":
        participants, feedback = study.load(snapshot._database_url())
        results = study.compute(participants, feedback, params)
        out = study.write(results)
        print(study.markdown(results))
        print(f"Written to {out}")
        return 0
    snapshot_dir = args.snapshot or snapshot.default_dir(params)
    if args.command == "extract" or (args.command == "all" and not (snapshot_dir / "manifest.json").exists()):
        print(f"Extracting the snapshot to {snapshot_dir}")
        manifest = snapshot.extract(params, snapshot_dir)
        print(f"  {manifest['counts']}; trait files {manifest['traitFiles']}")
        if args.command == "extract":
            return 0
    if not (snapshot_dir / "manifest.json").exists():
        print(f"No snapshot in {snapshot_dir}. Run `pnpm eval extract` first.", file=sys.stderr)
        return 1
    print(f"Running on {snapshot_dir}")
    run(args.params, snapshot_dir, args.out, args.models_out, do_export=args.command == "export")
    return 0


if __name__ == "__main__":
    sys.exit(main())
