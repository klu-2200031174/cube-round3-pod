"""Read the synthetic Round 2 sample CSVs (used by the organiser stub agents and the tests).

Your real agent will not read these. It reads captures and upstream records.
Tenancy: every lookup is scoped by org_id. A unit that exists only under another org
raises LookupError, which the server turns into a 404 (never a cross-tenant answer).
"""
from __future__ import annotations

import csv
import os
from functools import lru_cache
from pathlib import Path

DEFAULT_DIR = Path(__file__).resolve().parents[2] / "data" / "sample"
FILES = {
    "receiving": "receiving_sample.csv",
    "prep": "prep_sample.csv",
    "pack": "pack_sample.csv",
    "returns": "returns_sample.csv",
    "fees": "fee_report_sample.csv",
}


def data_dir() -> Path:
    return Path(os.environ.get("DATA_DIR", DEFAULT_DIR))


@lru_cache(maxsize=None)
def _rows(kind: str, directory: str) -> tuple[dict, ...]:
    with open(Path(directory) / FILES[kind], newline="") as fh:
        return tuple(csv.DictReader(fh))


# Interactive-lab overlay: rows the UI registers at runtime for ad-hoc units. They live under the reserved tenant
# `org_lab` only, so they can never be read across tenants, and they vanish when the process restarts.
LAB_ORG = "org_lab"
_LAB: dict[str, list[dict]] = {k: [] for k in FILES}


def register_lab_row(kind: str, row: dict) -> None:
    if row.get("org_id") != LAB_ORG:
        raise ValueError(f"lab rows must belong to {LAB_ORG}")
    _LAB[kind] = [r for r in _LAB[kind] if not (r.get("unit_id") == row.get("unit_id") and r.get("line_id") == row.get("line_id"))]
    _LAB[kind].append(row)


def clear_lab(unit_id: str | None = None) -> None:
    for kind in _LAB:
        _LAB[kind] = [r for r in _LAB[kind] if unit_id is not None and r.get("unit_id") != unit_id]


def rows(kind: str) -> tuple[dict, ...]:
    return _rows(kind, str(data_dir())) + tuple(_LAB.get(kind, ()))


def row(kind: str, unit_id: str, org_id: str) -> dict:
    """The single row for a unit under an org, or LookupError."""
    for r in rows(kind):
        if r["unit_id"] == unit_id and r["org_id"] == org_id:
            return r
    raise LookupError(f"no {kind} record for {unit_id} in {org_id}")


def has(kind: str, unit_id: str, org_id: str) -> bool:
    try:
        row(kind, unit_id, org_id)
        return True
    except LookupError:
        return False


def fee_lines(unit_id: str, org_id: str) -> list[dict]:
    return [r for r in rows("fees") if r["unit_id"] == unit_id and r["org_id"] == org_id]


def route(unit_id: str, org_id: str) -> str:
    """fba if a prep record exists, mfn if a pack record exists, else unknown.

    Round 2 sample: a unit has a Prep record or a Pack record, never both,
    and 9 units have neither (see docs/decisions.md, finding F-12).
    """
    if has("prep", unit_id, org_id):
        return "fba"
    if has("pack", unit_id, org_id):
        return "mfn"
    return "unknown"
