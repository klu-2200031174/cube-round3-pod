"""Interactive API for the web UI: configure Groq, run any agent (or the whole chain) on your own data + photos,
parse fee reports, and aggregate everything for the dashboard charts.

All lab units live under the reserved tenant `org_lab` and the id prefix `LAB-`; nothing here can read or change the
organiser's demo tenants' rows. The agents are the real agents: the lab only supplies their inputs.
"""
from __future__ import annotations

import asyncio
import csv
import io
import json
import os
import re
import threading
import uuid
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Request

from shared.utils import groq_client, sample_data
from shared.utils.records import utcnow
from shared.utils.schema import errors as schema_errors

from .orchestrator import LIVE, bundle, load_flow, run_workflow, workflow_id_for

ROOT = Path(__file__).resolve().parents[1]
LAB_ORG = sample_data.LAB_ORG
MAX_FILES, MAX_BYTES = 8, 12 * 1024 * 1024
STAGES = ("receiving", "prep", "pack", "returns", "recovery")
router = APIRouter()
_STORE = None


def init(store) -> None:
    global _STORE
    _STORE = store


def _input_root() -> Path:
    return Path(os.environ.get("INPUT_DIR", ROOT / "data" / "input"))


# ------------------------------------------------------------------------------------------ config / Groq
@router.get("/api/config")
def config() -> dict:
    return {**groq_client.status(), "agents": {s: "groq" if s != "recovery" else "rules + groq explanations" for s in STAGES}}


@router.post("/api/config/groq")
def set_key(body: dict) -> dict:
    key = str(body.get("api_key", "")).strip()
    if not key or len(key) < 20 or any(c.isspace() for c in key):
        raise HTTPException(422, "that does not look like a Groq API key (they start with gsk_ and have no spaces)")
    groq_client.set_runtime_key(key)
    return groq_client.status()


@router.post("/api/config/groq/test")
async def test_key() -> dict:
    """Checks the key against Groq and that the configured model exists. Never returns the key."""
    def work() -> dict:
        s = groq_client.Settings.from_env()
        if not groq_client.has_key():
            return {"ok": False, "error": "No API key set yet."}
        try:
            models = groq_client.list_models(s)
        except groq_client.GroqError as exc:
            return {"ok": False, "error": str(exc)}
        out: dict[str, Any] = {"ok": True, "model": s.model, "model_available": s.model in models,
                               "models": [m for m in models if not any(x in m for x in ("whisper", "tts", "guard", "orpheus"))][:40]}
        if not out["model_available"]:
            alt = next((m for m in [*s.fallbacks] if m in models), None)
            out["note"] = (f"{s.model} is not available to this key. Falling back to {alt}." if alt else
                           f"{s.model} is not available to this key; set GROQ_MODEL to one of the listed models.")
        return out
    return await asyncio.to_thread(work)


# ------------------------------------------------------------------------------------------ reference data
@router.get("/api/catalogue")
def catalogue() -> list[dict]:
    from agents.returns.returns_agent import reference
    return [{"sku": s, "title": i["title"], "category": i.get("category"), "parts": [p["name"] for p in i.get("parts", [])],
             "visual_description": i.get("visual_description", ""), "lookalikes": i.get("lookalike_skus", [])}
            for s, i in sorted(reference.catalogue().items()) if not s.startswith("LAB-")]


@router.get("/api/units")
def units() -> list[dict]:
    cases = {(c["org_id"], c["unit_id"]): c for c in json.loads((ROOT / "data" / "sample" / "cases.json").read_text())}
    out = []
    for r in sample_data.rows("receiving"):
        if r["org_id"] == LAB_ORG:
            continue
        c = cases.get((r["org_id"], r["unit_id"]), {})
        fees = [f for f in sample_data.rows("fees") if f["unit_id"] == r["unit_id"] and f["org_id"] == r["org_id"]]
        out.append({"unit_id": r["unit_id"], "org_id": r["org_id"], "sku": r["sku"], "title": r["product_title"],
                    "route": c.get("route", "unknown"), "returned": bool(c.get("returned")),
                    "fees": len(fees), "fee_total": round(sum(float(f["amount_usd"] or 0) for f in fees), 2)})
    return out


# ------------------------------------------------------------------------------------------ fee report parsing
CHARGE_MAP = [
    (("packag", "prep", "label", "inbound defect", "defect"), "inbound_defect_fee"),
    (("lost", "missing"), "lost_inbound"),
    (("damage",), "damaged_in_warehouse"),
    (("not returned", "refund"), "refund_issued_item_not_returned"),
    (("weight", "fulfil", "fulfill", "size tier", "dimension"), "fulfilment_fee_weight_tier"),
]
KNOWN = {t for _, t in CHARGE_MAP}
KEYS = {"line_id": ("charge_id", "line_id", "id", "charge"), "charge_type": ("charge_type", "reason", "type", "description"),
        "amount_usd": ("amount_usd", "amount", "fee", "total"), "fba_shipment_id": ("fba_shipment_id", "shipment", "shipment_id"),
        "order_id": ("order_id", "order"), "sku": ("sku",), "unit_id": ("unit_id", "unit"), "posted_date": ("posted_date", "date"),
        "report_type": ("report_type",), "fnsku": ("fnsku",), "quantity": ("quantity", "qty")}


def _charge_type(text: str) -> str:
    t = (text or "").strip().lower()
    if t in KNOWN:
        return t
    for needles, ctype in CHARGE_MAP:
        if any(n in t for n in needles):
            return ctype
    return t.replace(" ", "_") or "unknown"


def _normalise(raw: dict[str, Any], i: int, default_unit: str, default_org: str) -> dict:
    low = {str(k).strip().lower().replace(" ", "_"): v for k, v in raw.items()}
    out: dict[str, Any] = {}
    for dest, names in KEYS.items():
        for n in names:
            if low.get(n) not in (None, ""):
                out[dest] = low[n]
                break
    amt = re.sub(r"[^0-9.\-]", "", str(out.get("amount_usd", "0"))) or "0"
    return {"line_id": str(out.get("line_id") or f"CHG-{i:03d}"), "report_type": out.get("report_type", "fee_report"),
            "unit_id": str(out.get("unit_id") or default_unit), "org_id": default_org, "sku": str(out.get("sku", "")),
            "fnsku": str(out.get("fnsku", "")), "fba_shipment_id": str(out.get("fba_shipment_id", "")),
            "order_id": str(out.get("order_id", "")), "charge_type": _charge_type(str(out.get("charge_type", ""))),
            "reason_text": str(out.get("charge_type", "")), "quantity": out.get("quantity", 1), "amount_usd": float(amt),
            "posted_date": str(out.get("posted_date", ""))[:10]}


def parse_fee_report(text: str, default_unit: str, default_org: str) -> list[dict]:
    """JSON array | CSV with a header | 'Key: value' blocks separated by blank lines -> normalised charge lines."""
    text = (text or "").strip()
    if not text:
        return []
    rows: list[dict] = []
    if text[0] in "[{":
        data = json.loads(text)
        rows = data if isinstance(data, list) else [data]
    elif "," in text.splitlines()[0] and any(k in text.splitlines()[0].lower() for k in ("charge", "amount", "reason", "fee")):
        rows = list(csv.DictReader(io.StringIO(text)))
    else:
        for block in re.split(r"\n\s*\n", text):
            row = {}
            for line in block.splitlines():
                k, sep, v = line.partition(":")
                if sep:
                    row[k.strip()] = v.strip()
            if row:
                rows.append(row)
    if not rows:
        raise ValueError("could not find any charges (use CSV with a header, a JSON array, or 'Key: value' blocks)")
    return [_normalise(r, i, default_unit, default_org) for i, r in enumerate(rows, start=1) if isinstance(r, dict)]


# ------------------------------------------------------------------------------------------ run
def _sniff_ext(data: bytes) -> str | None:
    return {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp"}.get(groq_client.sniff_mime(data) or "")


async def _save_photos(form, key: str, unit: str, stage: str, roles: list[str] | None = None) -> int:
    files = [f for f in form.getlist(key) if hasattr(f, "read")][:MAX_FILES]
    folder = _input_root() / unit / stage
    n = 0
    for i, f in enumerate(files, start=1):
        data = await f.read()
        if len(data) > MAX_BYTES:
            raise HTTPException(413, f"{f.filename}: larger than {MAX_BYTES // 1048576} MB")
        ext = _sniff_ext(data)
        if ext is None:
            raise HTTPException(415, f"{f.filename}: only JPEG, PNG or WebP photos are accepted")
        role = (roles[i - 1] if roles and i - 1 < len(roles) else "other")
        role = role if role in ("pallet", "carton", "unit", "label") else "other"
        folder.mkdir(parents=True, exist_ok=True)
        name = f"{role}-{i}{ext}" if stage == "receiving" else f"photo-{i}{ext}"
        (folder / name).write_bytes(data)
        n += 1
    return n


def _need(d: dict, key: str) -> Any:
    if key not in d or d[key] in (None, ""):
        raise HTTPException(422, f"missing '{key}'")
    return d[key]


def _int(v: Any, name: str, lo: int = 0) -> int:
    try:
        n = int(float(v))
    except (TypeError, ValueError):
        raise HTTPException(422, f"'{name}' must be a whole number") from None
    if n < lo:
        raise HTTPException(422, f"'{name}' must be at least {lo}")
    return n


def _csv_list(v: Any) -> str:
    return ";".join(str(x).strip() for x in v if str(x).strip()) if isinstance(v, list) else str(v or "")


def _register(stage: str, unit: str, data: dict, now: str) -> None:
    common = {"unit_id": unit, "org_id": LAB_ORG, "operator_id": "op_lab", "captured_at": now, "photo_refs": ""}
    if stage == "receiving":
        po = data.get("po") or data
        sku = str(_need(po, "sku")).strip()
        cartons = _int(po.get("cartons_ordered", 1), "cartons_ordered", 1)
        per = _int(po.get("units_per_carton_ordered", 1), "units_per_carton_ordered", 1)
        qty = _int(po.get("qty_ordered", cartons * per), "qty_ordered", 1)
        sample_data.register_lab_row("receiving", {
            **common, "record_id": f"RCV-{unit}", "po_number": str(po.get("po_number") or "PO-LAB"), "po_line": "1",
            "supplier": str(po.get("supplier") or "Supplier (lab)"), "sku": sku, "asin": str(po.get("asin") or "B0LAB00000"),
            "product_title": str(_need(po, "product_title")), "spec_colour": str(po.get("spec_colour") or "n/a"),
            "spec_variant": str(po.get("spec_variant") or ""), "spec_components": _csv_list(po.get("spec_components")),
            "cartons_ordered": str(cartons), "units_per_carton_ordered": str(per), "qty_ordered": str(qty)})
    elif stage == "prep":
        wo = data.get("work_order") or data
        sample_data.register_lab_row("prep", {
            **common, "record_id": f"PRP-{unit}", "work_order_id": "WO-LAB", "fba_shipment_id": "FBA-LAB",
            "sku": str(_need(wo, "sku")), "asin": str(wo.get("asin") or "B0LAB00000"), "fnsku": str(wo.get("fnsku") or ""),
            "prep_price_usd": str(wo.get("prep_price_usd") or ""), "wo_polybag": str(bool(wo.get("polybag"))),
            "wo_suffocation_warning": str(bool(wo.get("suffocation_warning"))), "wo_expiry_date": str(bool(wo.get("has_expiry"))),
            "wo_handling_marks": _csv_list([str(m).lower().replace(" ", "_") for m in (wo.get("handling_marks") or [])])})
    elif stage == "pack":
        lines = (data.get("order") if isinstance(data, dict) else data) or []
        if not lines:
            raise HTTPException(422, "the order needs at least one line")
        clean = []
        for ln in lines:
            name = str(ln.get("name") or ln.get("sku") or "").strip()
            if not name:
                raise HTTPException(422, "every order line needs a name or SKU")
            clean.append({"sku": str(ln.get("sku") or "").strip() or name.upper().replace(" ", "-"), "name": name,
                          "colour": str(ln.get("colour") or "").strip(), "variant": str(ln.get("variant") or "").strip(),
                          "quantity": _int(ln.get("quantity", 1), "quantity", 1)})
        sample_data.register_lab_row("pack", {**common, "record_id": f"PCK-{unit}", "order_id": f"ORD-{unit}", "channel": "lab",
                                              "order_json": json.dumps(clean)})
    elif stage == "returns":
        from agents.returns.returns_agent import reference
        prod = data.get("product") or data
        sku = str(prod.get("sku") or "").strip()
        item = reference.catalogue().get(sku)
        if item is None or prod.get("title"):        # custom product defined in the form
            title = str(_need(prod, "title")).strip()
            sku = sku if sku and item is None else f"LAB-{unit[4:]}"
            parts = [{"name": str(p).strip(), "essential": True, "replaceable": False}
                     for p in (prod.get("parts") or []) if str(p).strip()]
            item = {"sku": sku, "asin": "B0LAB00000", "title": title, "category": "lab",
                    "visual_description": str(prod.get("visual_description") or title),
                    "distinguishing_features": [str(x) for x in prod.get("features") or []], "parts": parts,
                    "lookalike_skus": [], "hygiene_sensitive": bool(prod.get("hygiene_sensitive"))}
        reference.register_lab_order(reference.Order(
            org_id=LAB_ORG, client_id="seller_lab_01", order_id=f"ORD-{unit}", unit_id=unit, ordered_sku=item["sku"],
            ordered_asin=item["asin"], source="interactive lab"), item)
    elif stage == "recovery":
        for i, ln in enumerate(data.get("fee_lines") or [], start=1):
            sample_data.register_lab_row("fees", {**ln, "unit_id": unit, "org_id": LAB_ORG, "line_id": ln.get("line_id") or f"CHG-{i:03d}"})


@router.post("/api/lab/run")
async def lab_run(request: Request) -> dict:
    """multipart: stage (receiving|prep|pack|returns|pipeline), data (JSON), photos | photos_<stage>, roles (JSON list)."""
    form = await request.form()
    stage = str(form.get("stage", ""))
    if stage not in (*STAGES[:4], "pipeline"):
        raise HTTPException(422, "stage must be receiving, prep, pack, returns or pipeline")
    try:
        data = json.loads(str(form.get("data") or "{}"))
        roles = json.loads(str(form.get("roles") or "[]"))
    except json.JSONDecodeError as exc:
        raise HTTPException(422, f"data is not valid JSON: {exc}") from exc
    unit = f"LAB-{uuid.uuid4().hex[:8].upper()}"
    now = utcnow()
    stages = list(STAGES[:4]) if stage == "pipeline" else [stage]
    route, returned = "mfn", False
    try:
        if stage == "pipeline":
            route = data.get("route", "fba")
            if route not in ("fba", "mfn", "all"):
                raise HTTPException(422, "route must be fba, mfn or all")
            returned = bool(data.get("returns"))
        for st in stages:
            sd = data.get(st) if stage == "pipeline" else data
            if stage == "pipeline" and (st == "prep" and route not in ("fba", "all") or st == "pack" and route not in ("mfn", "all")
                                        or st == "returns" and not returned):
                continue
            if stage == "pipeline" and not sd:
                raise HTTPException(422, f"the {st} step needs its data")
            _register(st, unit, sd, now)
        if stage == "pipeline":
            lines = parse_fee_report(data["fees"], unit, LAB_ORG) if isinstance(data.get("fees"), str) and data["fees"].strip() \
                else [_normalise(x, i, unit, LAB_ORG) for i, x in enumerate(data.get("fees") or [], start=1)]
            _register("recovery", unit, {"fee_lines": lines}, now)
        photo_counts = {}
        for st in stages:
            key = f"photos_{st}" if stage == "pipeline" else "photos"
            r = roles.get(st) if isinstance(roles, dict) else roles
            photo_counts[st] = await _save_photos(form, key, unit, st, r if isinstance(r, list) else None)
    except HTTPException:
        sample_data.clear_lab(unit)
        raise
    except (ValueError, KeyError, TypeError) as exc:
        sample_data.clear_lab(unit)
        raise HTTPException(422, str(exc)) from exc
    if stage != "pipeline" and photo_counts.get(stage, 0) == 0:
        raise HTTPException(422, "add at least one photo; the agents never guess without evidence")

    if stage == "pipeline":
        flow = load_flow()
    else:   # a one-stage flow: the same orchestrator, just a single step
        flow = {"flow_id": f"lab-{stage}", "steps": [{"stage": stage}], "defaults": {"timeout_s": 90, "retries": 0}}
    case = {"org_id": LAB_ORG, "unit_id": unit, "route": route if stage == "pipeline" else ("fba" if stage == "prep" else "mfn"),
            "returned": returned if stage == "pipeline" else stage == "returns"}
    counts = ((data.get("receiving") or {}).get("counts") if stage == "pipeline" else data.get("counts")) or {}
    if counts:
        case["operator_counts"] = counts
    parallel = str(form.get("parallel", "")).lower() in ("1", "true", "yes")
    if str(form.get("async", "")) == "1":      # start in the background; the UI polls /api/lab/live/<workflow_id>
        threading.Thread(target=run_workflow, args=(case, flow, _STORE, None, parallel), daemon=True).start()
        return {"unit_id": unit, "workflow_id": workflow_id_for(case), "photos": photo_counts, "parallel": parallel}
    wf = await asyncio.to_thread(run_workflow, case, flow, _STORE, None, parallel)
    return {"unit_id": unit, "photos": photo_counts, **bundle(wf, _STORE)}


@router.get("/api/lab/live/{workflow_id}")
def lab_live(workflow_id: str) -> dict:
    """What is running right now: per-stage state, timings and verdicts. Final results come from /workflows/<id>/evidence."""
    live = LIVE.get(workflow_id)
    wf = _STORE.load_workflow(workflow_id)
    if live is None and wf is None:
        return {"known": False, "done": False, "stages": {}}
    stages = {k: v for k, v in (live or {}).items() if not k.startswith("_")}
    if live is None and wf is not None:          # an older workflow: rebuild timings from the stored state (second precision)
        from .orchestrator import stage_live
        stages = {sr["stage"]: stage_live(sr) for sr in wf["stage_results"]}
        live = {"_done": True, "_parallel": any(t["event"] == "wave_started" and "parallel" in (t.get("detail") or "") for t in wf.get("transitions", []))}
    return {"known": True, "now": __import__("time").time(), "done": bool((live or {}).get("_done")), "parallel": bool((live or {}).get("_parallel")), "stages": stages,
            "status": (wf or {}).get("status"), "transitions": [t for t in (wf or {}).get("transitions", []) if t["event"] in ("wave_started", "stage_completed", "stage_error", "retry", "halted")][-30:],
            "server_time": utcnow()}


@router.post("/api/lab/recovery")
async def lab_recovery(body: dict) -> dict:
    """Parse a fee/reimbursement report and match each charge against a workflow's evidence (or none)."""
    from agents.recovery import app as recovery
    wf_id = str(body.get("workflow_id") or "").strip()
    wf = _STORE.load_workflow(wf_id) if wf_id else None
    if wf_id and wf is None:
        raise HTTPException(404, f"no workflow {wf_id}")
    org, unit = (wf["org_id"], wf["subject_id"]) if wf else (LAB_ORG, f"LAB-{uuid.uuid4().hex[:8].upper()}")
    try:
        lines = parse_fee_report(str(body.get("report") or ""), unit, org) if body.get("report") else \
            [_normalise(x, i, unit, org) for i, x in enumerate(body.get("fee_lines") or [], start=1)]
    except (ValueError, json.JSONDecodeError) as exc:
        raise HTTPException(422, str(exc)) from exc
    if not lines:
        raise HTTPException(422, "no charges to analyse")
    prev = [e for rid in (wf["evidence_references"] if wf else []) if (e := _STORE.get_evidence(rid)) and e["stage"] != "recovery"]
    request = {"schema_version": "1.0", "request_id": f"lab-recovery-{uuid.uuid4().hex}", "workflow_id": wf["workflow_id"] if wf else f"WF-{org}-{unit}",
               "stage": "recovery", "subject": {"org_id": org, "subject_id": unit, "route": (wf or {}).get("context", {}).get("route", "unknown")},
               "inputs": [], "previous_evidence": prev,
               "context": {"overrides": (wf or {}).get("overrides", []), "case": (wf or {}).get("context", {}), "fee_lines": lines}}
    bad = schema_errors("agent-input", request)
    if bad:
        raise HTTPException(422, "; ".join(bad[:3]))
    out = await asyncio.to_thread(recovery.handle, request)
    return {"workflow_id": wf_id or None, "parsed_charges": lines, "evidence_used": [e["record_id"] for e in prev], "output": out}


# ------------------------------------------------------------------------------------------ analytics
def _all_workflows() -> list[dict]:
    d = _STORE.root / "workflows"
    out = []
    for f in sorted(d.glob("*.json")) if d.exists() else []:
        try:
            out.append(json.loads(f.read_text(encoding="utf-8")))
        except Exception:
            continue
    return out


@router.get("/api/analytics")
def analytics() -> dict:
    wfs = _all_workflows()
    outcomes, status = Counter(), Counter()
    stage_verdicts: dict[str, Counter] = {s: Counter() for s in STAGES}
    stage_outcomes: dict[str, Counter] = {s: Counter() for s in STAGES}
    fails: Counter = Counter()
    positions, claim_by_type, charge_by_type = Counter(), defaultdict(float), defaultdict(float)
    providers, latency, confs = Counter(), defaultdict(list), Counter()
    cumulative: dict[str, float] = defaultdict(float)
    recent, claimable_total, units_lab = [], 0.0, 0
    for wf in wfs:
        fo = wf.get("final_outcome") or {}
        outcomes[fo.get("outcome") or "IN_PROGRESS"] += 1
        status[wf.get("status", "?")] += 1
        if wf["org_id"] == LAB_ORG:
            units_lab += 1
        if fo.get("claimable_usd"):
            claimable_total += float(fo["claimable_usd"])
        for sr in wf.get("stage_results", []):
            if sr["state"] == "skipped" or not sr.get("record_id"):
                continue
            st = sr["stage"]
            stage_verdicts[st][sr.get("verdict") or "?"] += 1
            stage_outcomes[st][sr.get("outcome") or "?"] += 1
            ev = _STORE.get_evidence(sr["record_id"])
            if not ev:
                continue
            m = ev.get("model") or {}
            providers[("Groq AI" if (m.get("provider") or "") in ("groq", "rules+groq") else
                       "Sample CSV replay" if m.get("name") == "csv-replay-stub" else "Rules engine")] += 1
            if ev.get("latency_ms") and (m.get("provider") or "") in ("groq", "rules+groq"):
                latency[st].append(ev["latency_ms"])
            c = ev["decision"].get("confidence")
            if isinstance(c, (int, float)):
                confs[min(int(c * 10), 9)] += 1
            for ck in ev.get("checks", []):
                if ck["verdict"] == "FAIL":
                    fails[f"{st}: {ck['check_key']}"] += 1
            if st == "recovery":
                for ch in (ev.get("payload") or {}).get("charges", []):
                    positions[ch["position"]] += 1
                    charge_by_type[ch["charge_type"]] += float(ch.get("amount_usd") or 0)
                    if ch["position"] == "CONTRADICTS":
                        claim_by_type[ch["charge_type"]] += float(ch.get("claim_amount_usd") or ch.get("amount_usd") or 0)
                day = str(ev.get("captured_at", ""))[:7]
                cumulative[day] += float((ev.get("payload") or {}).get("claimable_usd") or 0)
        recent.append({"workflow_id": wf["workflow_id"], "unit_id": wf["subject_id"], "org_id": wf["org_id"],
                       "status": wf.get("status"), "outcome": fo.get("outcome"), "claimable_usd": fo.get("claimable_usd"),
                       "stages": [sr["stage"] for sr in wf.get("stage_results", []) if sr["state"] != "skipped"],
                       "created_at": (wf.get("timestamps") or {}).get("created_at")})
    recent.sort(key=lambda r: r.get("created_at") or "", reverse=True)
    months = sorted(k for k in cumulative if k)
    run, line = 0.0, []
    for k in months:
        run += cumulative[k]
        line.append({"month": k, "claimable": round(cumulative[k], 2), "cumulative": round(run, 2)})
    return {
        "kpis": {"workflows": len(wfs), "lab_units": units_lab, "claimable_usd": round(claimable_total, 2),
                 "clean": outcomes.get("CLEAN", 0), "exceptions": outcomes.get("EXCEPTION", 0),
                 "claims": outcomes.get("CLAIM_RECOMMENDED", 0), "needs_review": outcomes.get("NEEDS_REVIEW", 0),
                 "incomplete": outcomes.get("INCOMPLETE", 0), "ai_records": providers.get("Groq AI", 0),
                 "groq_ready": groq_client.has_key()},
        "outcomes": dict(outcomes), "status": dict(status),
        "stage_verdicts": {s: dict(c) for s, c in stage_verdicts.items()},
        "stage_outcomes": {s: dict(c) for s, c in stage_outcomes.items()},
        "top_failing_checks": fails.most_common(10), "recovery_positions": dict(positions),
        "claimable_by_type": {k: round(v, 2) for k, v in claim_by_type.items()},
        "charges_by_type": {k: round(v, 2) for k, v in charge_by_type.items()},
        "claims_timeline": line, "providers": dict(providers),
        "latency_ms": {s: round(sum(v) / len(v)) for s, v in latency.items() if v},
        "confidence_hist": [confs.get(i, 0) for i in range(10)], "recent": recent[:25],
    }


# ------------------------------------------------------------------------------------------ control-centre views
def _wf_rows() -> list[dict]:
    rows = []
    for wf in _all_workflows():
        fo = wf.get("final_outcome") or {}
        live = [sr for sr in wf.get("stage_results", []) if sr["state"] != "skipped"]
        last = next((sr["stage"] for sr in reversed(live) if sr["state"] != "pending"), None) or (live[0]["stage"] if live else None)
        rows.append({"workflow_id": wf["workflow_id"], "unit_id": wf["subject_id"], "org_id": wf["org_id"],
                     "route": (wf.get("context") or {}).get("route", "unknown"), "returned": bool((wf.get("context") or {}).get("returned")),
                     "current_stage": last, "status": wf.get("status"), "outcome": fo.get("outcome"), "claimable_usd": fo.get("claimable_usd"),
                     "reason": fo.get("reason"), "needs_human": fo.get("needs_human"), "errors": len(wf.get("errors", [])),
                     "created_at": (wf.get("timestamps") or {}).get("created_at"), "stages": [sr["stage"] for sr in live]})
    rows.sort(key=lambda r: r.get("created_at") or "", reverse=True)
    return rows


@router.get("/api/workflow-list")
def workflow_list() -> list[dict]:
    return _wf_rows()


@router.get("/api/review-queue")
def review_queue() -> list[dict]:
    """Records where an agent asked for a person (needs_human) and no override has settled it."""
    out = []
    for wf in _all_workflows():
        if wf.get("status") not in ("BLOCKED", "RECOVERY_REQUIRED", "IN_PROGRESS", "COMPLETED"):
            continue
        settled = {o["supersedes"]["record_id"] for o in wf.get("overrides", [])}
        for sr in wf.get("stage_results", []):
            rid = sr.get("record_id")
            if sr["state"] == "skipped" or not rid or rid in settled:
                continue
            if sr.get("needs_human") and sr.get("verdict") == "UNCERTAIN":
                ev = _STORE.get_evidence(rid) or {}
                unsure = [c["check_key"] for c in ev.get("checks", []) if c["verdict"] == "UNCERTAIN"]
                out.append({"workflow_id": wf["workflow_id"], "unit_id": wf["subject_id"], "org_id": wf["org_id"], "stage": sr["stage"],
                            "record_id": rid, "outcome": sr.get("outcome"), "reason": (ev.get("decision") or {}).get("reason", ""),
                            "uncertain_checks": unsure, "workflow_status": wf.get("status")})
    return out


@router.get("/api/failures")
def failures() -> list[dict]:
    out = []
    for wf in _all_workflows():
        if wf.get("status") == "FAILED" or any(sr["state"] == "error" for sr in wf.get("stage_results", [])) or wf.get("errors"):
            errs = wf.get("errors", [])
            out.append({"workflow_id": wf["workflow_id"], "unit_id": wf["subject_id"], "status": wf.get("status"),
                        "reason": wf.get("status_reason"), "errors": [{"stage": e.get("stage"), "code": e.get("code"), "message": e.get("message"),
                                                                       "retryable": e.get("retryable")} for e in errs][:5]})
    return out


@router.get("/api/evidence-list")
def evidence_list() -> list[dict]:
    d = _STORE.root / "evidence"
    out = []
    for f in sorted(d.glob("*.json")) if d.exists() else []:
        try:
            e = json.loads(f.read_text(encoding="utf-8"))
        except Exception:
            continue
        out.append({"record_id": e["record_id"], "stage": e["stage"], "unit_id": e["subject"]["subject_id"], "org_id": e["subject"]["org_id"],
                    "verdict": e["decision"]["verdict"], "outcome": e["decision"]["outcome"], "model": (e.get("model") or {}).get("name"),
                    "photos": len(e.get("inputs") or []), "produced_at": e.get("produced_at"), "hash": (e.get("content_hash") or "")[:12]})
    out.sort(key=lambda r: r.get("produced_at") or "", reverse=True)
    return out[:400]


@router.get("/api/agents")
def agents() -> list[dict]:
    out = []
    for i, st in enumerate(STAGES, start=1):
        m = json.loads((ROOT / "agents" / st / "agent.json").read_text())
        out.append({"n": i, "stage": st, "agent_id": m["agent_id"], "owner": m.get("owner"), "mode": m.get("mode"),
                    "implementation": m.get("implementation"), "ai": "Groq vision + rules" if st != "recovery" else "Rules + Groq explanations",
                    "checks": {"receiving": ["identity_match", "carton_count", "quantity", "carton_damage", "unit_damage", "quality_flags"],
                               "prep": ["polybag_sealed", "suffocation_warning", "fnsku_label_placement", "original_barcode_covered", "expiry_legible", "handling_marks"],
                               "pack": ["items_present", "quantities_correct", "variants_correct", "no_extra_items"],
                               "returns": ["identity_match", "completeness", "condition"], "recovery": ["charge_<line_id>"]}[st]})
    return out


@router.get("/api/charges")
def charges() -> list[dict]:
    out = []
    d = _STORE.root / "evidence"
    for f in sorted(d.glob("RCY-*.json")) if d.exists() else []:
        try:
            e = json.loads(f.read_text(encoding="utf-8"))
        except Exception:
            continue
        for ch in (e.get("payload") or {}).get("charges", []):
            out.append({"line_id": ch["line_id"], "type": ch["charge_type"], "amount_usd": ch.get("amount_usd"), "position": ch["position"],
                        "decision": ch.get("decision"), "claim_usd": ch.get("claim_amount_usd") or 0, "unit_id": e["subject"]["subject_id"],
                        "record_id": e["record_id"], "evidence": ch.get("evidence_record_ids", []), "why": ch.get("explanation") or ch.get("reason")})
    return out
