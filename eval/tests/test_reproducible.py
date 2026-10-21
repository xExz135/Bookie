"""EVAL-1: one command, fixed seeds, the same numbers every time."""

import json

import tomllib

from bookie_eval.__main__ import main


def _write_params(tmp_path, params):
    # The CLI reads a TOML file; write the test parameters as one.
    lines = []
    for section, values in params.items():
        for sub, body in ([(None, values)] if not any(isinstance(v, dict) for v in values.values()) else values.items()):
            if sub is None:
                lines.append(f"[{section}]")
                items = body
            else:
                lines.append(f"[{section}.{sub}]")
                items = body
            for key, value in items.items():
                lines.append(f"{key} = {json.dumps(value)}")
    path = tmp_path / "params.toml"
    path.write_text("\n".join(lines), "utf-8")
    assert tomllib.loads(path.read_text("utf-8")) == params
    return path


def test_eval_1_two_runs_give_identical_files(tmp_path, snapshot_dir, params):
    params_path = _write_params(tmp_path, params)
    outs = [tmp_path / "run1", tmp_path / "run2"]
    for out in outs:
        assert main(["run", "--params", str(params_path), "--snapshot", str(snapshot_dir), "--out", str(out)]) == 0
    for name in ("results.json", "report.md", "learning-curve.png", "calibration.png"):
        assert (outs[0] / name).read_bytes() == (outs[1] / name).read_bytes(), name

    results = json.loads((outs[0] / "results.json").read_text("utf-8"))
    # EVAL-2: every model has validation and test numbers, and the run names its inputs.
    for model in ("B0", "B1", "B2", "B3", "B4"):
        assert set(results["models"][model]) == {"validation", "test"}
    assert results["provenance"]["params"]["split"]["seed"] == params["split"]["seed"]
    assert len(results["provenance"]["snapshot"]["checksum"]) == 64
    assert "Shipped model" in (outs[0] / "report.md").read_text("utf-8")


def test_a_tampered_snapshot_is_refused(tmp_path, snapshot_dir, params):
    params_path = _write_params(tmp_path, params)
    (snapshot_dir / "traits.json").write_text("[]", "utf-8")
    try:
        main(["run", "--params", str(params_path), "--snapshot", str(snapshot_dir), "--out", str(tmp_path / "x")])
    except RuntimeError as error:
        assert "checksum" in str(error)
    else:
        raise AssertionError("a changed snapshot file must be refused")
