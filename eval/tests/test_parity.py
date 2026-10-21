"""D-006: the committed parity fixture is what the Python scoring gives today.

The API's parity test scores the same fixture in TypeScript and must agree
within the fixture's tolerance, so the two implementations cannot drift apart.
"""

import json

import numpy as np

from bookie_eval import parity


def test_the_committed_fixture_is_current():
    committed = json.loads(parity.FIXTURE.read_text("utf-8"))
    assert committed == json.loads(json.dumps(parity.fixture())), "run `pnpm eval parity` and commit the file"


def test_fixture_covers_every_model_and_the_edge_cases():
    f = parity.fixture()
    names = [c["name"] for c in f["cases"]]
    assert len(names) == 5
    for case in f["cases"]:
        for model in ("B0", "B1", "B2", "B3", "B4"):
            assert len(case["expected"][model]) == len(case["targets"])
    # Books outside the release get no B3 or B4 score, but B0, B1 and B2 still apply.
    typical = f["cases"][0]
    outside = [i for i, t in enumerate(typical["targets"]) if t not in f["release"]["knownBooks"]]
    assert outside and all(typical["expected"]["B3"][i] is None for i in outside)
    assert all(typical["expected"]["B2"][i] is not None for i in outside)


def test_model_2_without_answers_b1_is_the_reader_mean():
    case = parity.fixture()["cases"][2]
    mean = np.mean([p["rating"] for p in case["profile"]])
    assert np.allclose(case["expected"]["B1"], mean)


def test_model_1_same_inputs_same_scores():
    a, b = parity.fixture(), parity.fixture()
    assert a == b
