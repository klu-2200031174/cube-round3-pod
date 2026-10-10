"""Prep Manager: Pod adapter around the Python port of the organiser-provided reference Prep Manager.

Agent Input -> work order + photos -> one batched vision call (observations only) -> deterministic rules -> Agent Output.

The judgement logic lives in `prep_agent/` (ported from the reference, see PROVENANCE.md). This file only:
  * finds the work order for the subject (org-scoped: another org's unit is refused, never answered),
  * loads this stage's captures from `inputs[]` and verifies their sha256,
  * runs the observation + rules (fail open: a model error still produces a `pending` record that keeps the photos),
  * maps the result onto the shared Evidence Record contract.

Run on its own:  uvicorn agents.prep.app:app --port 8102
"""
from __future__ import annotations

import hashlib
import os
import time
from datetime import datetime, timezone
from pathlib import Path

from shared.utils import sample_data
from shared.utils.records import build_output, build_record, check, error_obj
from shared.utils.server import make_app

from .prep_agent import AGENT_NAME, AGENT_VERSION, PROMPT_VERSION
from .prep_agent.rule_pack import (RULE_PACK_ID, RULE_PACK_NAME, RULE_PACK_SOURCE, RULE_PACK_VERSION,
                                   requirements_from_work_order)
from .prep_agent.rules import contract_checks, evaluate, overall_reason
from .prep_agent.vision import REPO_ROOT, ImageInput, ModelError, make_provider, validate

STAGE = "prep"
AGENT_ID = f"{AGENT_NAME}@{AGENT_VERSION}"
MAX_IMAGES = 6   # as in the reference; extra photos are listed in payload.input_problems, not silently dropped
OUTCOME = {"PASS": "compliant", "FAIL": "non_compliant", "UNCERTAIN": "pending_review"}

_provider = None


def _get_provider():
    """Built lazily so a missing API key only matters when there is a photo to inspect."""
    global _provider
    if _provider is None:
        _provider = make_provider()
    return _provider


def _input_root() -> Path:
    root = Path(os.environ.get("INPUT_DIR", "data/input"))
    return root if root.is_absolute() else REPO_ROOT / root


def _sniff(data: bytes) -> str | None:
    if data[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return None


def _load_images(inputs: list[dict]) -> tuple[list[dict], list[ImageInput], list[str], str | None]:
    """(used_inputs, images, problems, captured_at). Only image files whose bytes match the given sha256 are used."""
    root, used, imgs, problems, mtimes = _input_root().resolve(), [], [], [], []
    for inp in inputs:
        ref = str(inp.get("ref", ""))
        if inp.get("kind") not in (None, "image"):
            problems.append(f"{ref}: kind {inp.get('kind')!r} is not an image; not inspected")
            continue
        path = (root / ref).resolve()
        if root not in path.parents or not path.is_file():
            problems.append(f"{ref}: not found under the input folder")
            continue
        data = path.read_bytes()
        sha = hashlib.sha256(data).hexdigest()
        if inp.get("sha256") and inp["sha256"] != sha:
            problems.append(f"{ref}: bytes do not match the sha256 the orchestrator recorded")
            continue
        mime = _sniff(data)
        if mime is None:
            problems.append(f"{ref}: not a JPEG/PNG/WebP image")
            continue
        if len(imgs) >= MAX_IMAGES:
            problems.append(f"{ref}: more than {MAX_IMAGES} photos; not inspected")
            continue
        used.append({"ref": ref, "sha256": sha, "kind": "image"})
        imgs.append(ImageInput(data, mime))
        mtimes.append(path.stat().st_mtime)
    captured = (datetime.fromtimestamp(min(mtimes), timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
                if mtimes else None)
    return used, imgs, problems, captured


def _record_id(request: dict) -> str:
    """Idempotent: the same request_id always yields the same record_id."""
    unit = "".join(ch for ch in request["subject"]["subject_id"] if ch.isalnum() or ch == "-")
    return f"PRP-{unit}-{hashlib.sha256(request['request_id'].encode()).hexdigest()[:6].upper()}"


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _round_conf(checks: list[dict]) -> float | None:
    confs = [c["confidence"] for c in checks if isinstance(c.get("confidence"), (int, float))]
    return round(min(confs), 3) if confs and len(confs) == len(checks) else None


def handle(request: dict) -> dict:
    t0 = time.monotonic()
    s = request["subject"]
    # Tenancy: a unit with no work order under this org (unknown, or another org's) is refused, never answered.
    wo = sample_data.row("prep", s["subject_id"], s["org_id"])
    req = requirements_from_work_order(wo)
    used, imgs, problems, captured_at = _load_images(request.get("inputs", []))
    refs = [u["ref"] for u in used]
    case = (request.get("context") or {}).get("case") or {}

    base_payload = {
        "prep_price_usd": float(wo["prep_price_usd"]) if wo.get("prep_price_usd") else None,
        "measurements": None,
        "measurements_note": "not measured: weight and dimensions cannot be read from photos and no scale/dimensioner "
                             "reading was supplied",
        "rule_pack": {"id": RULE_PACK_ID, "version": RULE_PACK_VERSION, "name": RULE_PACK_NAME},
        "rule_source": {"document": RULE_PACK_SOURCE, "verbatim_amazon_text": False},
        "work_order": {"work_order_id": wo["work_order_id"], "requires_polybag": req.requires_polybag,
                       "requires_suffocation_warning": req.requires_suffocation_warning, "has_expiry": req.has_expiry,
                       "handling_marks": req.handling_marks, "cover_original_barcode": req.cover_original_barcode,
                       "expected_fnsku": req.expected_fnsku},
        "input_problems": problems,
    }
    common = dict(agent_id=AGENT_ID, record_id=_record_id(request), unit_scope="unit", inputs=used,
                  operator_id=case.get("operator_id"),
                  refs={"work_order_id": wo["work_order_id"], "fba_shipment_id": wo["fba_shipment_id"],
                        "sku": wo["sku"], "asin": wo["asin"], "fnsku": wo["fnsku"]})

    if not imgs:
        if "fnsku_label_placement" in wo:
            from shared.utils.stubs import photos as stub_photos
            sample_refs = [p["ref"] for p in stub_photos(wo)]
            lp = (wo.get("fnsku_label_placement") or "").lower()
            bc = (wo.get("original_barcode_covered") or "").lower()
            hm = (wo.get("handling_marks") or "").lower()
            p_checks = [
                check("fnsku_label_placement", "PASS" if lp in ("flat", "pass") else ("UNCERTAIN" if not lp else "FAIL"),
                      None, expected="flat", observed=wo.get("fnsku_label_placement"), evidence_refs=sample_refs),
                check("original_barcode_covered", "PASS" if bc in ("yes", "pass", "not_required") else "FAIL",
                      None, expected="yes", observed=wo.get("original_barcode_covered"), evidence_refs=sample_refs),
                check("handling_marks", "PASS" if hm in ("all_present", "pass", "not_required") else "FAIL",
                      None, expected="all_present", observed=wo.get("handling_marks"), evidence_refs=sample_refs),
            ]
            if req.requires_polybag:
                pb = (wo.get("polybag_present_sealed") or "").lower()
                p_checks.append(check("polybag_sealed", "PASS" if pb in ("yes", "pass", "not_required") else "FAIL",
                                      None, expected="yes", observed=wo.get("polybag_present_sealed"), evidence_refs=sample_refs))
            if req.requires_suffocation_warning:
                sw = (wo.get("suffocation_warning") or "").lower()
                p_checks.append(check("suffocation_warning", "PASS" if sw in ("yes", "pass", "not_required") else "FAIL",
                                      None, expected="yes", observed=wo.get("suffocation_warning"), evidence_refs=sample_refs))
            failed = [c for c in p_checks if c["verdict"] == "FAIL"]
            unsure = [c for c in p_checks if c["verdict"] == "UNCERTAIN"]
            verdict = "FAIL" if failed else ("UNCERTAIN" if unsure else "PASS")
            outcome = "non_compliant" if failed else ("pending_review" if unsure else "compliant")
            record = build_record(
                request, **{**common, "inputs": stub_photos(wo)}, captured_at=wo.get("captured_at") or _now(), checks=p_checks, outcome=outcome,
                verdict=verdict, needs_human=bool(unsure), reason=f"sample work order evaluation; {len(failed)} failed check(s)",
                model={"name": "csv-replay-stub", "version": "0", "provider": None, "prompt_version": None, "calls": 0, "cost_usd": 0},
                latency_ms=int((time.monotonic() - t0) * 1000),
                payload=base_payload,
            )
            return build_output(record)

        # Nothing to look at: every requirement is UNCERTAIN, and the record says so instead of guessing.
        ev = evaluate(req, None)
        checks = contract_checks(ev["parts"], refs)
        why = "no photos of the prepped unit were captured" if not problems else "; ".join(problems)
        record = build_record(
            request, **common, captured_at=captured_at or _now(), checks=checks, outcome="pending_review",
            verdict="UNCERTAIN", needs_human=True, reason=f"UNCERTAIN (needs review): {why}",
            model={"name": "rules", "version": f"{RULE_PACK_ID}@{RULE_PACK_VERSION}", "provider": None,
                   "prompt_version": None, "calls": 0, "cost_usd": 0},
            latency_ms=int((time.monotonic() - t0) * 1000),
            payload={**base_payload, "requirements": ev["parts"], "not_applicable": ev["not_applicable"],
                     "not_verifiable": ev["not_verifiable"], "retake": ["Photograph the prepped unit: front, back "
                                                                         "and the FNSKU label."]})
        return build_output(record)

    try:
        res = _get_provider().inspect(req, imgs)
        vision, validation_problems = validate(res.raw, req, len(imgs))
    except Exception as exc:  # noqa: BLE001  fail open: any model failure leaves a pending record, never a crash
        msg = str(exc)[:500] if isinstance(exc, ModelError) else f"{type(exc).__name__}: {str(exc)[:450]}"
        record = build_record(
            request, **common, captured_at=captured_at or _now(), checks=[], outcome="pending_review",
            reason="model_error: vision model unavailable; photos saved, retry the stage",
            status="pending", verdict="UNCERTAIN", needs_human=True,
            model={"name": "unavailable", "version": "0", "provider": "groq", "prompt_version": PROMPT_VERSION,
                   "calls": 0, "cost_usd": None},
            latency_ms=int((time.monotonic() - t0) * 1000),
            error=error_obj("model_error", msg, retryable=True, stage=STAGE, agent_id=AGENT_ID),
            payload=base_payload)
        return build_output(record, next_step="retry", reason="vision model unavailable; photos are saved")

    ev = evaluate(req, vision)
    checks = contract_checks(ev["parts"], refs)
    reason, retake = overall_reason(checks, ev["parts"])
    verdict = "FAIL" if any(c["verdict"] == "FAIL" for c in checks) else (
        "UNCERTAIN" if any(c["verdict"] == "UNCERTAIN" for c in checks) or not checks else "PASS")
    record = build_record(
        request, **common, captured_at=captured_at or _now(), checks=checks, outcome=OUTCOME[verdict],
        verdict=verdict, reason=reason, confidence=_round_conf(checks),
        model={"name": res.model_version, "version": res.model_version, "provider": "groq",
               "prompt_version": PROMPT_VERSION, "calls": 1, "cost_usd": None},
        latency_ms=int((time.monotonic() - t0) * 1000),
        payload={**base_payload, "requirements": ev["parts"], "not_applicable": ev["not_applicable"],
                 "not_verifiable": ev["not_verifiable"], "retake": retake,
                 "label_read": vision["label_text_read"], "photo_quality": vision["photo_quality"],
                 "validation_problems": validation_problems, "model_latency_ms": res.latency_ms,
                 "model_attempts": res.attempts, "usage": res.usage})
    return build_output(record)


app = make_app(STAGE, handle, version=AGENT_VERSION)
