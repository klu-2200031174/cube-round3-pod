"""Returns Manager: Pod adapter around the Round 2 Returns agent.

Agent Input  ->  Round 2 pipeline (one batched vision call -> deterministic checks -> rule table)  ->  Agent Output.

The judgement logic lives in `returns_agent/` (carried over from Round 2, see PROVENANCE.md). This file only:
  * finds the order for the subject (org-scoped: another org's unit is refused, never answered),
  * loads this stage's captures from `inputs[]` and verifies their sha256,
  * runs the agent (fail open: a model error still produces a `pending` record that keeps the captures),
  * reads Pack's evidence, when the unit has any, to say whether what came back is what was shipped,
  * maps the result onto the shared Evidence Record contract.

Run on its own:  uvicorn agents.returns.app:app --port 8104
"""
from __future__ import annotations

import hashlib
import os
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from shared.utils.records import build_output, build_record, check, error_obj
from shared.utils.server import make_app

# The orchestrator does not enforce timeouts for in-process agents, so keep the model inside the stage budget.
os.environ.setdefault("MODEL_TIMEOUT_S", "20")
os.environ.setdefault("MODEL_BUDGET_S", "25")

from .returns_agent import AGENT_NAME, AGENT_VERSION, reference  # noqa: E402
from .returns_agent.checks import UNCERTAIN, build_checks  # noqa: E402
from .returns_agent.config import REPO_ROOT, Settings  # noqa: E402
from .returns_agent.rules import decide  # noqa: E402
from .returns_agent.vlm import ImageInput, ModelError, make_provider  # noqa: E402

STAGE = "returns"
AGENT_ID = f"{AGENT_NAME}@{AGENT_VERSION}"
PROMPT_VERSION = "rtn-prompt-2"
MAX_IMAGES = 8
CHECK_KEYS = {"image_quality": "image_quality", "identity": "identity_match",
              "completeness": "completeness", "condition": "condition"}

_provider = None


def _get_provider():
    """Built lazily so a missing API key only matters when there is a photo to inspect."""
    global _provider
    if _provider is None:
        _provider = make_provider(Settings.from_env())
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
    root, used, imgs, problems, mtimes = _input_root(), [], [], [], []
    for inp in inputs:
        if inp.get("kind") not in (None, "image"):
            continue
        ref = str(inp.get("ref", ""))
        path = (root / ref).resolve()
        if root.resolve() not in path.parents or not path.is_file():
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
            problems.append(f"{ref}: more than {MAX_IMAGES} photos; ignored")
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
    return f"RTN-{unit}-{hashlib.sha256(request['request_id'].encode()).hexdigest()[:6].upper()}"


def _effective_verdict(request: dict, record: dict) -> str:
    latest = [o for o in request.get("context", {}).get("overrides", [])
              if o.get("supersedes", {}).get("record_id") == record["record_id"]]
    return latest[-1]["new_verdict"] if latest else record["decision"]["verdict"]


def _shipped_skus(pack: dict) -> list[str] | None:
    """What Pack recorded as physically in the box at seal. None when its record does not say."""
    for c in pack.get("checks", []):
        if c.get("check_key") in ("items_present", "contents_match", "items_in_box") and isinstance(c.get("observed"), list):
            return [str(x) for x in c["observed"]]
    observed = (pack.get("payload") or {}).get("observed_in_box")
    if isinstance(observed, list):
        return [str(x) for x in observed]
    if isinstance(observed, dict):
        return [str(k) for k in observed]
    return None


def _pack_cross_check(request: dict, order, identity: dict) -> tuple[dict | None, dict]:
    """Compare what came back with what Pack says was shipped. Returns (check or None, payload note)."""
    packs = [r for r in request.get("previous_evidence", []) if r.get("stage") == "pack"]
    if not packs:
        return None, {"available": False, "reason": "no Pack evidence for this unit (e.g. FBA route)"}
    pack = packs[-1]
    note: dict[str, Any] = {"available": True, "pack_record_id": pack["record_id"],
                            "pack_effective_verdict": _effective_verdict(request, pack),
                            "pack_outcome": pack["decision"].get("outcome")}
    shipped = _shipped_skus(pack)
    note["shipped_skus"] = shipped
    if shipped is None:
        note["reason"] = "Pack's record does not list the contents it sealed"
        return None, note
    if identity["verdict"] == UNCERTAIN:
        note["reason"] = "identity of the returned item is UNCERTAIN, so it cannot be compared"
        return None, note
    returned = order.ordered_sku if identity["verdict"] == "PASS" else (identity.get("value") or {}).get("best_matching_sku")
    note["returned_sku"] = returned
    refs = [pack["record_id"]]
    if identity["verdict"] == "PASS" and order.ordered_sku in shipped:
        note["finding"] = "returned item matches what was shipped"
        return check("matches_pack_record", "PASS", None, expected=shipped, observed=returned,
                     detail="The returned item is the SKU Pack sealed into the box.", evidence_refs=refs), note
    if identity["verdict"] == "PASS":
        note["finding"] = "conflict: the ordered SKU came back but Pack did not record shipping it"
        return check("matches_pack_record", UNCERTAIN, None, expected=shipped, observed=returned,
                     detail="Returned item is the ordered SKU, but Pack's record does not list it as shipped.",
                     evidence_refs=refs, uncertain_reason="conflicting_evidence"), note
    if returned and returned in shipped:
        note["finding"] = "packing error upstream: the wrong item was shipped and that item came back"
        return check("matches_pack_record", "PASS", None, expected=shipped, observed=returned,
                     detail=f"The item that came back ({returned}) is what Pack shipped; the error happened at packing, "
                            "not on the customer side.", evidence_refs=refs), note
    note["finding"] = "suspected swap: what came back is not what Pack shipped"
    return check("matches_pack_record", "FAIL", None, expected=shipped, observed=returned or "unidentified item",
                 detail="Pack sealed the ordered item, but a different item came back. Possible wrong-item return; "
                        "a person must review before any refund or claim.", evidence_refs=refs), note


def _to_contract_checks(checks: list[dict], used: list[dict]) -> list[dict]:
    refs = [u["ref"] for u in used]
    out = []
    for c in checks:
        key = CHECK_KEYS.get(c["check_key"], c["check_key"])
        ev_refs = sorted({refs[e["image_index"]] for e in c.get("evidence", []) if 0 <= e.get("image_index", -1) < len(refs)})
        if c["check_key"] == "image_quality":
            ev_refs = refs
        value = c.get("value") or {}
        expected = observed = None
        if c["check_key"] == "identity":
            expected, observed = value.get("expected_sku"), value.get("best_matching_sku") or value.get("model_verdict")
        elif c["check_key"] == "completeness":
            expected = [p["part"] for p in value.get("components", [])]
            observed = {"missing": value.get("missing", []), "not_visible": value.get("unverified", [])}
        elif c["check_key"] == "condition":
            expected, observed = "a grade on Amazon's published condition scale", value.get("grade") or "UNCERTAIN"
        reason = None
        if c["verdict"] == UNCERTAIN:
            reason = "poor_image" if c["check_key"] == "image_quality" else (
                "occluded" if c["check_key"] == "completeness" and value.get("unverified") else "insufficient_evidence")
        out.append(check(key, c["verdict"], c.get("confidence"), expected=expected, observed=observed,
                         detail=c.get("detail", ""), evidence_refs=ev_refs, uncertain_reason=reason))
    return out


def _unjudged_facts(n_usable: int, model_failed: bool) -> dict:
    return {"model_failed": model_failed, "usable_images": n_usable, "identity": UNCERTAIN, "completeness": UNCERTAIN,
            "missing": [], "unverified": [], "condition": UNCERTAIN, "grade": None, "grade_rank": None,
            "observed_state": "uncertain", "max_damage": None, "hygiene_sensitive": False}


def handle(request: dict) -> dict:
    t0 = time.monotonic()
    s = request["subject"]
    order = reference.get_order_by_unit(s["org_id"], s["subject_id"])
    if order is None:
        # Tenancy: a unit that belongs to another org (or does not exist) is refused, never answered.
        raise LookupError(f"unknown returned unit {s['subject_id']} in {s['org_id']}")

    used, imgs, problems, captured_at = _load_images(request.get("inputs", []))
    item = reference.catalogue().get(order.ordered_sku, {})
    refs = {"order_id": order.order_id, "sku": order.ordered_sku, "asin": order.ordered_asin}
    rules_version = reference.disposition_rules()["version"]
    base_payload = {"title": item.get("title"), "rules_version": rules_version,
                    "condition_scale": reference.condition_scale()["scale_id"], "order_source": order.source,
                    "input_problems": problems}
    common = dict(agent_id=AGENT_ID, record_id=_record_id(request), refs=refs, unit_scope="unit",
                  client_id=order.client_id, inputs=used)

    if not imgs:
        # Nothing to look at: a judgement is impossible, and the record says so instead of guessing.
        facts = _unjudged_facts(0, model_failed=False)
        d = decide(facts)
        reason = "no return photos were captured for this unit" if not problems else "; ".join(problems)
        checks = [check("image_quality", UNCERTAIN, 0.0, expected="at least one usable photo of the returned item",
                        observed="no usable photos", detail=reason, uncertain_reason="insufficient_evidence")]
        record = build_record(
            request, **common, captured_at=captured_at or _now(), checks=checks, outcome=d["disposition"],
            reason=f"{d['rule_id']}: {d['rule_text']} ({reason})", needs_human=True,
            model={"name": "rules", "version": rules_version, "provider": None, "prompt_version": None, "calls": 0,
                   "cost_usd": 0},
            latency_ms=int((time.monotonic() - t0) * 1000),
            payload={**base_payload, "rule_id": d["rule_id"], "disposition": d["disposition"], "condition_grade": None,
                     "pack_cross_check": {"available": False, "reason": "not inspected"}})
        return build_output(record)

    try:
        res = _get_provider().inspect(order, imgs, "")
    except ModelError as exc:
        # Fail open: the captures are kept (inputs + sha256), nothing is guessed, and the stage can be retried.
        facts = _unjudged_facts(len(imgs), model_failed=True)
        d = decide(facts)
        msg = str(exc)[:500]
        record = build_record(
            request, **common, captured_at=captured_at or _now(), checks=[], outcome=d["disposition"],
            reason=f"{d['rule_id']}: vision model unavailable; photos saved, retry the stage",
            status="pending", verdict=UNCERTAIN, needs_human=True,
            model={"name": "unavailable", "version": "0", "provider": "groq", "prompt_version": PROMPT_VERSION,
                   "calls": 0, "cost_usd": None},
            latency_ms=int((time.monotonic() - t0) * 1000),
            error=error_obj("model_error", msg, retryable=True, stage=STAGE, agent_id=AGENT_ID),
            payload={**base_payload, "rule_id": d["rule_id"], "disposition": d["disposition"]})
        return build_output(record, next_step="retry", reason="vision model unavailable; photos are saved")

    r2_checks, facts = build_checks(res.raw, order, len(imgs), res.model_version, res.latency_ms)
    d = decide(facts)
    checks = _to_contract_checks(r2_checks, used)
    by = {c["check_key"]: c for c in r2_checks}
    pack_check, pack_note = _pack_cross_check(request, order, by["identity"])
    if pack_check:
        checks.append(pack_check)
    needs_human = d["needs_human_review"] or (pack_check is not None and pack_check["verdict"] == "FAIL")
    confs = [c["confidence"] for c in checks if isinstance(c.get("confidence"), (int, float))]
    record = build_record(
        request, **common, captured_at=captured_at or _now(), checks=checks, outcome=d["disposition"],
        reason=f"{d['rule_id']}: {d['rule_text']}", needs_human=needs_human,
        confidence=round(min(confs), 3) if confs else None,
        model={"name": res.model_version, "version": res.model_version, "provider": "groq",
               "prompt_version": PROMPT_VERSION, "calls": 1, "cost_usd": None},
        latency_ms=int((time.monotonic() - t0) * 1000),
        payload={**base_payload, "rule_id": d["rule_id"], "disposition": d["disposition"],
                 "rules_evaluated": d["rules_evaluated"],
                 "condition_grade": (by["condition"].get("value") or {}).get("grade"),
                 "observed_state": facts.get("observed_state"),
                 "components": (by["completeness"].get("value") or {}).get("components", []),
                 "damage": (by["condition"].get("value") or {}).get("damage", []),
                 "model_latency_ms": res.latency_ms, "usage": res.usage, "pack_cross_check": pack_note})
    return build_output(record)


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


app = make_app(STAGE, handle)
