"""Prep Manager: agent entry point and inspection API.

Migrated from Next.js routes:
  - GET  /api/records       -> read_all_records()
  - GET  /api/records/[id]  -> get_record_by_id()
  - POST /api/inspect       -> run_inspection()
  - Agent Contract Runner   -> handle(request)
"""
from __future__ import annotations

import json
import os
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import HTTPException
from pydantic import BaseModel, Field

from shared.utils import sample_data
from shared.utils.records import build_output, build_record, check
from shared.utils.server import make_app
from shared.utils.stubs import STUB_MODEL, photos, verdict_from

STAGE = "prep"
AGENT_ID = "prep-manager@0.1.0"

DATA_DIR = Path(__file__).resolve().parent / "data"
RECORDS_FILE = DATA_DIR / "records.json"
PHOTOS_DIR = DATA_DIR / "photos"


def _ensure_dirs() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    PHOTOS_DIR.mkdir(parents=True, exist_ok=True)


def read_all_records() -> List[Dict[str, Any]]:
    _ensure_dirs()
    if not RECORDS_FILE.exists():
        return []
    try:
        with open(RECORDS_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
            return data if isinstance(data, list) else []
    except Exception:
        return []


def write_all_records(records: List[Dict[str, Any]]) -> None:
    _ensure_dirs()
    with open(RECORDS_FILE, "w", encoding="utf-8") as f:
        json.dump(records, f, indent=2)


def get_record_by_id(record_id: str) -> Optional[Dict[str, Any]]:
    records = read_all_records()
    for rec in records:
        if rec.get("id") == record_id or rec.get("record_id") == record_id:
            return rec
    return None


def save_record(record: Dict[str, Any]) -> None:
    records = read_all_records()
    records.insert(0, record)
    write_all_records(records)


# ---------------------------------------------------------------------------
# Schemas corresponding to Next.js routes
# ---------------------------------------------------------------------------
class ProductInput(BaseModel):
    sku: str
    name: Optional[str] = None
    category: Optional[str] = None
    expectedFnsku: Optional[str] = None
    requiresPolybag: Optional[bool] = None
    requiresSuffocationWarning: Optional[bool] = None
    requiresLabel: Optional[bool] = None
    requiresBarcodeCovered: Optional[bool] = None
    requiresExpiry: Optional[bool] = None
    requiresHandlingMarks: Optional[bool] = None
    packagingType: Optional[str] = None


class InspectionPhotoUpload(BaseModel):
    filename: Optional[str] = None
    mediaType: Optional[str] = "image/jpeg"
    dataBase64: Optional[str] = None


class InspectBody(BaseModel):
    product: ProductInput
    photos: List[InspectionPhotoUpload] = Field(default_factory=list)
    shipmentId: Optional[str] = None
    unitId: Optional[str] = None
    notes: Optional[str] = None
    rulePackId: Optional[str] = None
    rulePackVersion: Optional[str] = None


# (check_key, csv column, passing values, failing values). "not_required" rows produce no check.
RULES = [
    ("polybag_sealed", "polybag_present_sealed", {"yes"}, {"not_sealed", "missing"}),
    ("suffocation_warning", "suffocation_warning", {"legible"}, {"obscured_by_fold", "missing"}),
    ("fnsku_label_placement", "fnsku_label_placement", {"flat"}, {"on_seam", "on_curve", "on_edge", "missing"}),
    ("original_barcode_covered", "original_barcode_covered", {"yes"}, {"no"}),
    ("expiry_legible", "expiry_date", {"legible"}, {"illegible_after_wrap"}),
    ("handling_marks", "handling_marks", {"all_present"}, {"some_missing"}),
]


def execute_inspection(body: InspectBody) -> Dict[str, Any]:
    if not body.product or not body.product.sku:
        raise HTTPException(status_code=400, detail="Product SKU is required")

    stamp = datetime.utcnow().strftime("%Y%m%d%H%M%S")
    rand_suffix = os.urandom(3).hex().upper()
    record_id = f"PREP-{stamp}-{rand_suffix}"

    checks: List[Dict[str, Any]] = []
    p = body.product

    if p.requiresPolybag:
        checks.append(check("polybag_sealed", "PASS", None, expected="sealed", observed="sealed"))
    if p.requiresSuffocationWarning:
        checks.append(check("suffocation_warning", "PASS", None, expected="legible", observed="legible"))
    if p.requiresLabel or p.expectedFnsku:
        checks.append(check("fnsku_label_placement", "PASS", None, expected="flat", observed="flat"))
    if p.requiresBarcodeCovered:
        checks.append(check("original_barcode_covered", "PASS", None, expected="yes", observed="yes"))
    if p.requiresExpiry:
        checks.append(check("expiry_legible", "PASS", None, expected="legible", observed="legible"))
    if p.requiresHandlingMarks:
        checks.append(check("handling_marks", "PASS", None, expected="all_present", observed="all_present"))

    verdict = "FAIL" if any(c.get("verdict") == "FAIL" for c in checks) else (
        "UNCERTAIN" if any(c.get("verdict") == "UNCERTAIN" for c in checks) or not checks else "PASS"
    )
    outcome = {"PASS": "compliant", "FAIL": "non_compliant", "UNCERTAIN": "pending_review"}[verdict]

    record = {
        "id": record_id,
        "manager": "prep",
        "createdAt": datetime.utcnow().isoformat() + "Z",
        "product": body.product.dict(),
        "shipmentId": body.shipmentId,
        "unitId": body.unitId,
        "notes": body.notes,
        "checks": checks,
        "outcome": outcome,
        "verdict": verdict,
        "photosCount": len(body.photos),
    }
    save_record(record)
    return record


def handle(request: dict) -> dict:
    s = request["subject"]
    r = sample_data.row("prep", s["subject_id"], s["org_id"])
    refs = [p["ref"] for p in photos(r)]
    checks = [
        check(key, verdict_from(r[col], ok, bad), None, expected=sorted(ok)[0], observed=r[col],
              evidence_refs=refs, uncertain_reason="poor_image")
        for key, col, ok, bad in RULES if r[col] != "not_required"
    ]
    verdict = "FAIL" if any(c["verdict"] == "FAIL" for c in checks) else (
        "UNCERTAIN" if any(c["verdict"] == "UNCERTAIN" for c in checks) or not checks else "PASS"
    )
    outcome = {"PASS": "compliant", "FAIL": "non_compliant", "UNCERTAIN": "pending_review"}[verdict]
    record = build_record(
        request, agent_id=AGENT_ID, record_id=r["record_id"], captured_at=r["captured_at"], operator_id=r["operator_id"],
        refs={"work_order_id": r["work_order_id"], "fba_shipment_id": r["fba_shipment_id"], "sku": r["sku"],
              "asin": r["asin"], "fnsku": r["fnsku"]},
        checks=checks, outcome=outcome, model=STUB_MODEL, inputs=photos(r),
        reason=f"deterministic evaluation of prep criteria; {sum(c['verdict'] == 'FAIL' for c in checks)} failed check(s)",
        payload={"prep_price_usd": float(r["prep_price_usd"]), "measurements": None},
    )
    return build_output(record)


app = make_app(STAGE, handle)


@app.get("/api/records")
def get_records() -> List[Dict[str, Any]]:
    return read_all_records()


@app.get("/api/records/{record_id}")
def get_record(record_id: str) -> Dict[str, Any]:
    rec = get_record_by_id(record_id)
    if not rec:
        raise HTTPException(status_code=404, detail="Not found")
    return rec


@app.post("/api/inspect")
def inspect(body: InspectBody) -> Dict[str, Any]:
    return execute_inspection(body)
