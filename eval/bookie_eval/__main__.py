"""Command line of the offline evaluation (BE-14).

    python -m bookie_eval            # extract the snapshot if missing, then run (what `pnpm eval` does)
    python -m bookie_eval extract    # re-read the database and the trait cache into a new snapshot
    python -m bookie_eval run        # run on the existing snapshot only
    python -m bookie_eval export     # run, then export the models for the API (BE-13)
    python -m bookie_eval parity     # rewrite the Python/TypeScript parity fixture (D-006)
    python -m bookie_eval study      # the user study report from the database (FE-10, D-027)
    python -m bookie_eval llm        # the LLM evaluation from eval/llm/ (BE-15); --check fails on a regression
    python -m bookie_eval label-sheet  # the hand-labelling workbook (BE-15, local only)

Results go to eval/results/offline/ and are committed: they hold numbers only.
"""

from __future__ import annotations

import os

# One thread per numeric library, so sums happen in the same order on every run (EVAL-1).
for _var in ("OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS", "OMP_NUM_THREADS"):
    os.environ.setdefault(_var, "1")

import argparse  # noqa: E402
import json  # noqa: E402
import hashlib  # noqa: E402
import platform  # noqa: E402
import sys  # noqa: E402
import time  # noqa: E402
from pathlib import Path  # noqa: E402

import numpy as np  # noqa: E402
import scipy  # noqa: E402

from . import experiment, export, llm, parity, report, snapshot, study  # noqa: E402
from .params import DEFAULT_PARAMS, EVAL_DIR, REPO_ROOT, load_params  # noqa: E402

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


def run_llm(params: dict, check: bool, accept: bool) -> int:
    data = llm.load()
    if data is None:
        print("No LLM evaluation outputs in eval/llm/ yet (run `pnpm --filter @bookie/api llm-eval all`).")
        return 0
    results = llm.compute(data, params)
    if check:
        baseline = json.loads(llm.BASELINE.read_text("utf-8")) if llm.BASELINE.exists() else None
        problems = llm.check(results, baseline, params)
        if baseline is None:
            print("No accepted baseline yet (eval/llm/baseline.json): nothing to compare.")
        for p in problems:
            print(f"Regression: {p}", file=sys.stderr)
        if not problems:
            print(f"LLM regression check passed ({len(llm.headline(results))} metrics).")
        return 1 if problems else 0
    out = llm.write(results)
    print(llm.markdown(results))
    if accept:
        llm.BASELINE.write_text(
            json.dumps({"metrics": report.rounded(llm.headline(results))}, indent=2, sort_keys=True) + "\n",
            "utf-8",
            newline="\n",
        )
        print(f"Baseline written to {llm.BASELINE}")
    print(f"Written to {out}")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="bookie_eval", description=__doc__)
    parser.add_argument("command", nargs="?", default="all", choices=["all", "extract", "run", "export", "parity", "study", "llm", "label-sheet"])
    parser.add_argument("--params", type=Path, default=DEFAULT_PARAMS)
    parser.add_argument("--snapshot", type=Path, default=None, help="snapshot folder (default under data/derived/eval)")
    parser.add_argument("--out", type=Path, default=RESULTS_DIR)
    parser.add_argument("--models-out", type=Path, default=None, help="release folder root (default data/derived/models)")
    parser.add_argument("--check", action="store_true", help="llm: fail when a metric dropped below the baseline")
    parser.add_argument("--accept", action="store_true", help="llm: make the current metrics the baseline")
    args = parser.parse_args(argv)

    if args.command == "parity":
        print(f"Parity fixture written to {parity.write()}")
        return 0
    params = load_params(args.params)
    if args.command == "label-sheet":
        from . import labelling

        folder = REPO_ROOT / "data" / "derived" / "llm-eval" / "labelling"
        if not (folder / "books.json").exists():
            print("Run `pnpm --filter @bookie/api llm-eval sheet` first.", file=sys.stderr)
            return 1
        n = labelling.build(folder / "books.json", folder / "bookie-trait-labels.xlsx")
        print(f"Workbook for {n} books: {folder / 'bookie-trait-labels.xlsx'}")
        return 0
    if args.command == "llm":
        return run_llm(params, check=args.check, accept=args.accept)
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
