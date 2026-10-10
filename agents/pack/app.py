"""Pack Manager: agent entry point.

Open package photo(s) + the order  ->  Groq vision DESCRIBES the contents (blind to the order)  ->  deterministic
matching (engine.py)  ->  SEAL | STOP & FIX | UNCERTAIN, with an Evidence Record.

Only merchant-fulfilled / 3PL units reach Pack (route == "mfn"); Amazon packs FBA boxes.
  * photos present + GROQ_API_KEY        -> real inspection (model.name = the Groq model)
  * photos present, no key / model error -> pending record (UNCERTAIN, needs a person). Never a guess.
  * no photos at all                     -> replays the organiser's sample CSV row, labelled `csv-replay-stub`
                                            (so the sample workflows still run end to end without images).
Run:  uvicorn agents.pack.app:app --port 8103
"""
from __future__ import annotations

import hashlib
import json
import os
import time
from pathlib import Path

from fastapi import File, Form, UploadFile
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from shared.utils import groq_client, sample_data
from shared.utils.records import build_output, build_record, check, error_obj, pending_output, utcnow
from shared.utils.server import make_app
from shared.utils.stubs import STUB_MODEL, photos as stub_photos

from . import engine

STAGE = "pack"
VERSION = "1.0.0"
AGENT_ID = f"pack-manager@{VERSION}"
ROOT = Path(__file__).resolve().parents[2]
OUTCOME = {"SEAL": "seal", "STOP & FIX": "stop_and_fix", "UNCERTAIN": "pending_review"}
VERDICT = {"SEAL": "PASS", "STOP & FIX": "FAIL", "UNCERTAIN": "UNCERTAIN"}


def parse_lines(text: str) -> dict[str, int]:
    out: dict[str, int] = {}
    for part in filter(None, text.split(";")):
        sku, _, qty = part.partition(":")
        out[sku] = out.get(sku, 0) + int(qty or 1)
    return out


def _input_root() -> Path:
    return Path(os.environ.get("INPUT_DIR", ROOT / "data" / "input"))


def _load_photos(inputs: list[dict]) -> tuple[list[dict], list[dict], list[str]]:
    root, used, photos, problems = _input_root().resolve(), [], [], []
    for inp in inputs:
        if inp.get("kind") not in (None, "image"):
            continue
        ref = str(inp.get("ref", ""))
        path = (root / ref).resolve()
        if root not in path.parents or not path.is_file():
            problems.append(f"{ref}: not found under the input folder")
            continue
        data = path.read_bytes()
        sha = hashlib.sha256(data).hexdigest()
        if inp.get("sha256") and inp["sha256"] != sha:
            problems.append(f"{ref}: bytes do not match the sha256 the orchestrator recorded")
            continue
        if groq_client.sniff_mime(data) is None:
            problems.append(f"{ref}: not a JPEG/PNG/WebP image")
            continue
        used.append({"ref": ref, "sha256": sha, "kind": "image"})
        photos.append({"role": Path(ref).stem, "ref": ref, "path": str(path)})
    return used, photos, problems


def _order_lines(row: dict) -> list[dict]:
    if row.get("order_json"):
        return json.loads(row["order_json"])
    return engine.parse_lines(row["order_lines"])


def _replay_sample(request: dict, r: dict) -> dict:
    """No photos: replay the organiser's CSV row (a stub, labelled as one). Never claims a visual inspection."""
    refs = [p["ref"] for p in stub_photos(r)]
    want, got = parse_lines(r["order_lines"]), parse_lines(r["observed_in_box"])
    missing = sorted(k for k in want if k not in got)
    short = sorted(k for k in want if k in got and got[k] != want[k])
    extra = sorted(k for k in got if k not in want)
    checks = [
        check("items_present", "FAIL" if missing else "PASS", None, expected=sorted(want), observed=sorted(got),
              detail=f"missing: {missing}" if missing else "", evidence_refs=refs),
        check("quantities_correct", "FAIL" if short else "PASS", None, expected=want,
              observed={k: got[k] for k in want if k in got}, evidence_refs=refs),
        check("no_extra_items", "FAIL" if extra else "PASS", None, expected=[], observed=extra, evidence_refs=refs),
    ]
    out = "seal" if all(c["verdict"] == "PASS" for c in checks) else "stop_and_fix"
    record = build_record(
        request, agent_id=AGENT_ID, record_id=r["record_id"], captured_at=r["captured_at"], operator_id=r["operator_id"],
        unit_scope="order", refs={"order_id": r["order_id"]}, checks=checks, outcome=out, model=STUB_MODEL,
        inputs=stub_photos(r), reason=f"sample row replay (no photo supplied); {out}",
        payload={"channel": r["channel"], "order_lines": r["order_lines"], "observed_in_box": r["observed_in_box"],
                 "operator_verdict": r["operator_verdict"], "agent_agrees_with_operator": r["operator_verdict"] == out})
    return build_output(record)


def _checks_from(res: dict, refs: list[str]) -> list[dict]:
    m = res["match"]
    lines = m["lines"]
    label = lambda l: f'{l["name"]}' + (f' ({l["colour"]})' if l["colour"] else "")  # noqa: E731
    v = res["verdicts"]
    conf = res.get("confidence")

    def detail(statuses: tuple[str, ...]) -> str:
        return " ".join(f'{l["name"]}: {l["detail"]}' for l in lines if l["status"] in statuses)

    unexpected = m["extra_items"] + m["possible_extra_items"]
    return [
        check("items_present", v["items_present"], conf, expected=[f'{l["expected_qty"]} × {label(l)}' for l in lines],
              observed=[f'{l["observed_qty"] if l["observed_qty"] is not None else "?"} × {l["name"]}' for l in lines],
              detail=detail(("missing", "uncertain")) if v["items_present"] != "PASS" else "All ordered items were seen.",
              evidence_refs=refs, uncertain_reason="occluded"),
        check("quantities_correct", v["quantities_correct"], conf, expected={l["name"]: l["expected_qty"] for l in lines},
              observed={l["name"]: l["observed_qty"] for l in lines},
              detail=detail(("wrong_quantity", "uncertain")) if v["quantities_correct"] != "PASS" else "Counts match the order.",
              evidence_refs=refs, uncertain_reason="insufficient_evidence"),
        check("variants_correct", v["variants_correct"], conf, expected=[label(l) for l in lines],
              observed=[d["detected"] for d in m["wrong_items"]] or "as ordered",
              detail=detail(("wrong_item",)) if v["variants_correct"] != "PASS" else "Colours/variants match.",
              evidence_refs=refs, uncertain_reason="insufficient_evidence"),
        check("no_extra_items", v["no_extra_items"], conf, expected=[], observed=[e["detected"] for e in unexpected],
              detail=("Unexpected: " + ", ".join(e["detected"] for e in unexpected)) if v["no_extra_items"] != "PASS" else "Nothing extra in the box.",
              evidence_refs=refs, uncertain_reason="insufficient_evidence"),
    ]


_DEFAULT_OBSERVE = engine.observe


def handle(request: dict) -> dict:
    t0 = time.monotonic()
    s = request["subject"]
    row = sample_data.row("pack", s["subject_id"], s["org_id"])      # LookupError -> 404 (tenancy)
    used, photos, problems = _load_photos(request.get("inputs", []))
    if not photos:
        if problems:
            return pending_output(request, code="upstream_missing", retryable=False, agent_id=AGENT_ID, message="; ".join(problems))
        if "observed_in_box" not in row:   # an interactive-lab order has no recorded contents to replay
            return pending_output(request, code="upstream_missing", retryable=False, agent_id=AGENT_ID,
                                  message="no photo of the open box was supplied; nothing was judged")
        return _replay_sample(request, row)

    if not groq_client.has_key() and engine.observe is _DEFAULT_OBSERVE:
        return pending_output(request, code="model_error", agent_id=AGENT_ID,
                              message="GROQ_API_KEY is not set, so the box photo was saved but not inspected")
    res = engine.inspect_order({"order_lines": _order_lines(row), "photos": photos})
    refs = [u["ref"] for u in used]
    unit = "".join(ch for ch in s["subject_id"] if ch.isalnum() or ch == "-")
    rid = f"PCK-{unit}-{hashlib.sha256(request['request_id'].encode()).hexdigest()[:6].upper()}"
    m = res["model"]
    common = dict(agent_id=AGENT_ID, record_id=rid, captured_at=row.get("captured_at") or utcnow(), operator_id=row.get("operator_id"),
                  unit_scope="order", refs={"order_id": row["order_id"]}, inputs=used,
                  latency_ms=int((time.monotonic() - t0) * 1000))
    if res["status"] != "complete":
        record = build_record(request, **common, checks=[], outcome="pending_review", status="pending", verdict="UNCERTAIN",
                              needs_human=True, reason=f"model_error: {m['error']}; photos saved, retry the stage",
                              model={"name": "unavailable", "version": "0", "provider": "groq",
                                     "prompt_version": engine.PROMPT_VERSION, "calls": 0, "cost_usd": None},
                              error=error_obj("model_error", str(m["error"])[:500], retryable=True, stage=STAGE, agent_id=AGENT_ID),
                              payload={"order_lines": res["expected"], "input_problems": problems})
        return build_output(record, next_step="retry", reason="vision model unavailable; photos are saved")
    decision = res["decision"]
    record = build_record(
        request, **common, checks=_checks_from(res, refs), outcome=OUTCOME[decision], verdict=VERDICT[decision],
        reason=res["reason"], confidence=res["confidence"],
        model={"name": m["model"], "version": m["model"], "provider": "groq", "prompt_version": m["prompt_version"],
               "calls": 1, "cost_usd": None},
        payload={"channel": row.get("channel"), "decision_label": decision, "order_lines": res["expected"],
                 "lines": res["match"]["lines"], "wrong_items": res["match"]["wrong_items"],
                 "extra_items": res["match"]["extra_items"], "possible_extra_items": res["match"]["possible_extra_items"],
                 "observation": res["observation"], "input_problems": problems})
    return build_output(record)


app = make_app(STAGE, handle, VERSION)
_PACK_STATIC = Path(__file__).resolve().parent / "static"


@app.post("/api/verify")
async def verify_package(expected_order: str = Form(...), image: UploadFile | None = File(None),
                         images: list[UploadFile] | None = File(None)):
    """Stand-alone check (no workflow): expected_order = JSON [{"sku"|"name", "quantity", "colour"?}] + one or more photos."""
    try:
        try:
            order = json.loads(expected_order)
            assert isinstance(order, list)
        except Exception:
            return JSONResponse(status_code=400, content={"error": "expected_order must be a JSON array"})
        files = [f for f in ([image] if image else []) + list(images or []) if f is not None]
        photos = []
        for i, f in enumerate(files, start=1):
            data = await f.read()
            if groq_client.sniff_mime(data) is None:
                return JSONResponse(status_code=400, content={"error": f"{f.filename}: not a JPEG/PNG/WebP image"})
            photos.append({"role": f"photo{i}", "ref": f.filename or f"photo{i}", "bytes": data})
        if photos and not groq_client.has_key():
            return JSONResponse(status_code=503, content={"error": "GROQ_API_KEY is not set"})
        res = engine.inspect_order({"order_lines": order, "photos": photos})
        m = res["match"]
        return {
            "decision": res["decision"], "reasoning": res["reason"], "confidence_score": round((res["confidence"] or 0) * 100),
            "detected_items": [d for l in m["lines"] for d in l["detected"]],
            "missing_items": [{"sku": l["sku"], "quantity": l["expected_qty"]} for l in m["lines"] if l["status"] == "missing"],
            "wrong_items": m["wrong_items"], "extra_items": m["extra_items"], "lines": m["lines"],
            "verdicts": res["verdicts"], "model": res["model"]["model"], "status": res["status"],
        }
    except Exception as exc:  # noqa: BLE001
        return JSONResponse(status_code=500, content={"error": str(exc)})


if _PACK_STATIC.exists():
    app.mount("/", StaticFiles(directory=str(_PACK_STATIC), html=True), name="pack_static")
