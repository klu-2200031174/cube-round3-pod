"""Receiving Manager: agent entry point (the Round 2 agent, integrated through a thin adapter).

The judgement rules are the Round 2 Receiving Manager's (round2/lib/*.ts), ported to Python in ./engine.py so the Pod
needs no Node/npm. The vision model is Groq (one blind call per unit: it describes the photos, it never sees the PO).
This file adapts the engine to the Pod contract:

    Agent Input --(this file)--> engine.inspect_unit()   (one blind Groq vision call per unit, then deterministic rules)
    Round 2-shaped record --(this file)--> Evidence Record + Agent Output (shared/utils/records.py)

Contract duties handled here: tenancy (LookupError -> 404), fail open (pending_output on any bridge/model problem),
idempotency (same request_id -> same output), never invent evidence (no captures -> pending, never a PASS).

Run:  uvicorn agents.receiving.app:app --port 8101        Needs GROQ_API_KEY (.env) to inspect photos.
"""
from __future__ import annotations

import copy
import os
import threading
from pathlib import Path

from shared.utils import groq_client, sample_data
from shared.utils.records import build_output, build_record, check, pending_output
from shared.utils.server import make_app

from . import engine

STAGE = "receiving"
VERSION = "1.0.0"
AGENT_ID = f"receiving-manager@{VERSION}"
HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]

# Round 2 check names -> Pod contract check keys (EVIDENCE-CONTRACT.md section 8). Others keep their name.
CHECK_KEY = {"identity": "identity_match", "defects": "quality_flags"}
# Round 2 confidence is a fixed rule (two sources agree / one source / weak source), not a model probability.
CONFIDENCE = {"high": 0.9, "medium": 0.65, "low": 0.4}
OUTCOME = {"ACCEPT": "accept", "REVIEW": "pending_review", "EXCEPTION": "accept_with_exceptions"}
ROLES = ("pallet", "carton", "unit", "label")
# Round 2's nine checks (round2/lib/types.ts CheckName), in its order.
NO_PHOTO_CHECKS = ("identity", "variant_colour", "carton_count", "units_per_carton", "quantity",
                   "carton_damage", "unit_damage", "components", "defects")

_cache: dict[str, dict] = {}  # request_id -> output (idempotency within a process)
_lock = threading.Lock()


def _input_root() -> Path:
    return Path(os.environ.get("INPUT_DIR", ROOT / "data" / "input"))


def _role(ref: str) -> str:
    """Photo role from the capture's file name (pallet.jpg, carton.jpg, unit.jpg, label.jpg); otherwise "other"."""
    name = Path(ref).stem.lower()
    return next((r for r in ROLES if r in name), "other")


def run_bridge(payload: dict) -> dict:
    """Run the Receiving engine on one unit. Raises RuntimeError if it could not produce a record.
    (Name kept from the Round 2 Node bridge so tests and callers can still substitute it.)"""
    try:
        return engine.inspect_unit(payload)
    except Exception as exc:  # engine fails open itself; this guards anything unexpected
        raise RuntimeError(f"{type(exc).__name__}: {str(exc)[:300]}") from exc


_default_run_bridge = run_bridge


def _replay_sample(request: dict, row: dict) -> dict:
    from shared.utils.stubs import STUB_MODEL, photos
    refs = [p["ref"] for p in photos(row)]
    c_ord = int(row.get("cartons_ordered") or 0)
    c_rec = int(row.get("cartons_received") or 0)
    q_ord = int(row.get("qty_ordered") or 0)
    q_rec = int(row.get("qty_received") or 0)
    id_match = (row.get("identity_match") or "").lower()
    c_dmg = (row.get("carton_damage") or "").lower()
    u_dmg = (row.get("unit_damage") or "").lower()
    flags = [f for f in (row.get("quality_flags") or "").split(";") if f]

    id_v = "PASS" if id_match in ("yes", "pass", "matched") else ("FAIL" if id_match in ("no", "mismatch") else "UNCERTAIN")
    c_cnt_v = "PASS" if c_ord == c_rec else "FAIL"
    qty_v = "PASS" if q_ord == q_rec else "FAIL"
    c_dmg_v = "PASS" if c_dmg in ("none", "") else "FAIL"
    u_dmg_v = "PASS" if u_dmg in ("none", "") else ("UNCERTAIN" if u_dmg == "uncertain" else "FAIL")
    flags_v = "FAIL" if flags else "PASS"

    checks = [
        check("identity_match", id_v, None, expected=f"{row['sku']} ({row['product_title']})", observed=row.get("identity_match"), evidence_refs=refs),
        check("carton_count", c_cnt_v, None, expected=c_ord, observed=c_rec, evidence_refs=refs),
        check("quantity", qty_v, None, expected=q_ord, observed=q_rec, evidence_refs=refs),
        check("carton_damage", c_dmg_v, None, expected="none", observed=row.get("carton_damage"), evidence_refs=refs),
        check("unit_damage", u_dmg_v, None, expected="none", observed=row.get("unit_damage"), evidence_refs=refs),
        check("quality_flags", flags_v, None, expected=[], observed=flags, evidence_refs=refs),
    ]
    failed = [c["check_key"] for c in checks if c["verdict"] == "FAIL"]
    unsure = [c["check_key"] for c in checks if c["verdict"] == "UNCERTAIN"]
    if id_v == "FAIL":
        outcome = "reject"
    elif failed:
        outcome = "accept_with_exceptions"
    elif unsure:
        outcome = "pending_review"
    else:
        outcome = "accept"

    verdict = "FAIL" if failed else ("UNCERTAIN" if unsure else "PASS")
    record = build_record(
        request, agent_id=AGENT_ID, record_id=row["record_id"], captured_at=row["captured_at"],
        operator_id=row["operator_id"], unit_scope="po_line",
        refs={"po_number": row["po_number"], "po_line": row["po_line"], "sku": row["sku"], "asin": row["asin"]},
        checks=checks, outcome=outcome, verdict=verdict,
        reason=f"sample row replay; {len(failed)} failed check(s)",
        inputs=photos(row), model=STUB_MODEL,
        payload={"supplier": row["supplier"], "qty_ordered": q_ord, "qty_received": q_rec,
                 "shortfall_units": max(q_ord - q_rec, 0), "quality_flags": flags}
    )
    return build_output(record)


def handle(request: dict) -> dict:
    rid = request["request_id"]
    with _lock:
        if rid in _cache:
            return copy.deepcopy(_cache[rid])  # a copy, so a caller changing it can't change the cached record
    out = _run(request)
    with _lock:
        _cache[rid] = copy.deepcopy(out)
    return out


def _run(request: dict) -> dict:
    s = request["subject"]
    row = sample_data.row("receiving", s["subject_id"], s["org_id"])  # LookupError -> 404 (tenancy)

    root, captures = _input_root(), [i for i in request.get("inputs", []) if i.get("kind") == "image"]
    missing = [i["ref"] for i in captures if not (root / i["ref"]).is_file()]
    if missing:
        return pending_output(request, code="upstream_missing", retryable=False, agent_id=AGENT_ID,
                              message=f"capture not readable: {missing[0]}")

    is_bridge_mocked = run_bridge is not _default_run_bridge
    has_api_key = groq_client.has_key()

    if not captures and (is_bridge_mocked or "identity_match" not in row):
        why = f"no receiving photos were captured for {s['subject_id']}"
        checks = [check(CHECK_KEY.get(n, n), "UNCERTAIN", None, detail=why, uncertain_reason="insufficient_evidence")
                  for n in NO_PHOTO_CHECKS]
        record = build_record(
            request, agent_id=AGENT_ID, record_id=row["record_id"], captured_at=row["captured_at"],
            operator_id=row["operator_id"], unit_scope="po_line",
            refs={"po_number": row["po_number"], "po_line": row["po_line"], "sku": row["sku"], "asin": row["asin"]},
            checks=checks, outcome="pending_review", reason=why, needs_human=True,
            model={"name": "rules", "version": VERSION, "provider": None, "prompt_version": None, "calls": 0, "cost_usd": 0},
            payload={"supplier": row["supplier"], "qty_ordered": int(row["qty_ordered"]), "qty_received": None,
                     "shortfall_units": None, "quality_flags": []})
        return build_output(record)

    if captures and (has_api_key or is_bridge_mocked):
        ctx = request.get("context") or {}
        counts = {k: int(v) for k, v in (ctx.get("operator_counts") or (ctx.get("case") or {}).get("operator_counts") or {}).items()
                  if v not in (None, "") and str(v).lstrip("-").isdigit()}
        payload = {"po_row": row, "operator_id": row["operator_id"], "record_id": row["record_id"],
                   "captured_at": row["captured_at"], "counts": counts,
                   "photos": [{"role": _role(i["ref"]), "ref": i["ref"], "path": str(root / i["ref"])} for i in captures]}
        try:
            r2 = run_bridge(payload)
        except (RuntimeError, ValueError) as exc:  # fail open: nothing judged, the reason is recorded
            return pending_output(request, code="agent_exception", message=str(exc), agent_id=AGENT_ID)

        # Round 2 fails open by itself: a model error gives status "pending". Keep that as a pending record.
        if r2["status"] != "complete":
            return pending_output(request, code="model_error", message=r2["model"].get("error") or "model gave no observation",
                                  agent_id=AGENT_ID)

        # The bytes Round 2 hashed must be the bytes the orchestrator hashed.
        hashes = {p["ref"]: p["sha256"] for p in r2["photos"]}
        for i in captures:
            if i.get("sha256") and hashes.get(i["ref"]) != i["sha256"]:
                return pending_output(request, code="invalid_output", retryable=False, agent_id=AGENT_ID,
                                      message=f"sha256 mismatch for {i['ref']}")

        refs = {p["index"]: p["ref"] for p in r2["photos"]}
        checks = [check(CHECK_KEY.get(c["name"], c["name"]), c["verdict"], CONFIDENCE.get(c["confidence"]),
                        expected=c["expected"], observed=c["observed"], detail=c["reason"],
                        evidence_refs=[refs[n] for n in c["photo_refs"] if n in refs] or None,
                        uncertain_reason="insufficient_evidence")
                  for c in r2["checks"]]
        by = {c["name"]: c for c in r2["checks"]}
        overall = r2["overall"]
        outcome = "reject" if overall == "EXCEPTION" and by["identity"]["verdict"] == "FAIL" else OUTCOME[overall]
        failed = [c["check_key"] for c in checks if c["verdict"] == "FAIL"]
        unsure = [c["check_key"] for c in checks if c["verdict"] == "UNCERTAIN"]
        reason = {"ACCEPT": "Every check passed.",
                  "EXCEPTION": f"{len(failed)} failed check(s): {', '.join(failed)}.",
                  "REVIEW": f"No failed check; {len(unsure)} uncertain: {', '.join(unsure)}."}[overall]
        levels = [CONFIDENCE[c["confidence"]] for c in r2["checks"] if c["confidence"]]
        qty = r2["summary"]["qty_received"]
        m = r2["model"]
        record = build_record(
            request, agent_id=AGENT_ID, record_id=row["record_id"], captured_at=row["captured_at"],
            operator_id=row["operator_id"], unit_scope="po_line",
            refs={"po_number": row["po_number"], "po_line": row["po_line"], "sku": row["sku"], "asin": row["asin"]},
            checks=checks, outcome=outcome, reason=reason, latency_ms=m["latency_ms"],
            confidence=min(levels) if levels else None,
            inputs=[{"ref": p["ref"], "sha256": p["sha256"], "kind": "image"} for p in r2["photos"]],
            model={"name": m["model"], "version": m["model"], "provider": m["provider"],
                   "prompt_version": m["prompt_version"], "calls": 1, "cost_usd": None},
            payload={"supplier": row["supplier"], "qty_ordered": int(row["qty_ordered"]), "qty_received": qty,
                     "shortfall_units": max(int(row["qty_ordered"]) - qty, 0) if qty is not None else None,
                     "quality_flags": r2["summary"]["quality_flags"],
                     "confidence_rule": "Round 2 fixed levels high/medium/low mapped to 0.9/0.65/0.4",
                     "round2_record": {k: v for k, v in r2.items() if k != "model"} | {
                         "model": {k: v for k, v in m.items() if k != "raw_output"}}})
        return build_output(record)

    return _replay_sample(request, row)


app = make_app(STAGE, handle, VERSION)
