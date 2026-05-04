"""Smoke tests for the geoflow Python bindings.

Run with `maturin develop` first so the extension module is importable, then
`pytest crates/geoflow-py/tests`.
"""
from __future__ import annotations

from pathlib import Path

import pytest

geoflow = pytest.importorskip("geoflow")

FIXTURE = (
    Path(__file__).resolve().parents[3]
    / "tests"
    / "fixtures"
    / "ags"
    / "minimal_valid.ags"
)


def test_read_minimal_valid_ags() -> None:
    f = geoflow.read_ags(str(FIXTURE))
    names = f.group_names()
    assert "PROJ" in names
    assert "LOCA" in names
    assert f.row_count("LOCA") is not None
    assert f.row_count("__nonexistent__") is None


def test_validate_returns_dicts() -> None:
    f = geoflow.read_ags(str(FIXTURE))
    diags = f.validate()
    assert isinstance(diags, list)
    for d in diags:
        assert {"rule_id", "severity", "message"}.issubset(d.keys())


def test_round_trip_to_ags() -> None:
    f = geoflow.read_ags(str(FIXTURE))
    text = f.to_ags()
    again = geoflow.parse_ags(text)
    assert again.group_names() == f.group_names()


def test_to_diggs_returns_xml_and_report() -> None:
    f = geoflow.read_ags(str(FIXTURE))
    xml, report = f.to_diggs()
    assert xml.startswith("<?xml")
    assert '"unmapped_groups"' in report or "unmapped_groups" in report


def test_fix_applies_changes() -> None:
    # Use a string with trailing whitespace
    text = '"GROUP","PROJ"\n"HEADING","PROJ_ID"\n"UNIT",""\n"TYPE","ID"\n"DATA","P1  "\n'
    f = geoflow.parse_ags(text)
    applied = f.fix()
    assert "normalize-whitespace" in applied
    assert "P1  " not in f.to_ags()
    assert "P1" in f.to_ags()


def test_installed_pack_refs() -> None:
    refs = geoflow.installed_pack_refs()
    assert isinstance(refs, list)
    assert any("ags:standard" in r for r in refs)
