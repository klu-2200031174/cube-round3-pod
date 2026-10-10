"""Optional HTTP front door for the orchestrator (useful for a deployed demo).

  uvicorn orchestration.api:app --port 8100
  POST /workflows                 {"org_id": "org_demo_alpha", "unit_id": "UNIT-0002"}   -> Workflow State (runs it)
  GET  /workflows/{id}            -> Workflow State
  GET  /workflows/{id}/evidence   -> the workflow plus all its evidence records
  POST /workflows/{id}/resume     -> continue after a halt / decision / failure
  POST /workflows/{id}/overrides  {"record_id": "...", "new_verdict": "PASS", "actor": "...", "reason": "..."}
  GET  /health                    -> orchestrator and every agent in the flow
No authentication is included. Add it before you deploy anywhere public.
"""
from __future__ import annotations

import os
from pathlib import Path

from fastapi import FastAPI, HTTPException

from shared.utils import sample_data

from .clients import HttpClient, client_for, load_manifest
from .orchestrator import apply_override, bundle, default_flow_path, flow_stages, load_flow, resume, run_workflow
from .store import EvidenceConflict, FileStore
from . import lab

from fastapi.middleware.cors import CORSMiddleware

ROOT = Path(__file__).resolve().parents[1]
app = FastAPI(title="CUBE Round 3 orchestrator")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
FLOW = os.environ.get("ORCH_FLOW") or default_flow_path()
STORE = FileStore()
lab.init(STORE)
app.include_router(lab.router)


@app.get("/health")
def health() -> dict:
    agents = {}
    for stage in flow_stages(load_flow(FLOW)):
        client = client_for(stage)
        try:
            agents[stage] = client.health() if isinstance(client, HttpClient) else {"status": "ok", "mode": "inproc"}
        except Exception as exc:
            agents[stage] = {"status": "down", "error": str(exc)[:200], "owner": load_manifest(stage)["owner"]}
    ok = all(a["status"] == "ok" for a in agents.values())
    return {"status": "ok" if ok else "degraded", "flow": load_flow(FLOW)["flow_id"], "agents": agents}


@app.post("/workflows")
def create(body: dict) -> dict:
    org, subject = body.get("org_id"), body.get("subject_id") or body.get("unit_id")
    if not org or not subject:
        raise HTTPException(422, "org_id and unit_id (or subject_id) are required")
    case = {"org_id": org, "unit_id": subject, "route": body.get("route") or sample_data.route(subject, org),
            "returned": body.get("returned", sample_data.has("returns", subject, org))}
    return run_workflow(case, load_flow(FLOW), STORE, None, bool(body.get("parallel")))


def _get(workflow_id: str) -> dict:
    wf = STORE.load_workflow(workflow_id)
    if wf is None:
        raise HTTPException(404, f"no workflow {workflow_id}")
    return wf


@app.get("/workflows/{workflow_id}")
def get(workflow_id: str) -> dict:
    return _get(workflow_id)


@app.get("/workflows/{workflow_id}/evidence")
def evidence(workflow_id: str) -> dict:
    return bundle(_get(workflow_id), STORE)


@app.post("/workflows/{workflow_id}/resume")
def resume_workflow(workflow_id: str) -> dict:
    _get(workflow_id)
    return resume(workflow_id, load_flow(FLOW), STORE)


@app.post("/workflows/{workflow_id}/overrides")
def override(workflow_id: str, body: dict) -> dict:
    _get(workflow_id)
    try:
        return apply_override(workflow_id, STORE, record_id=body.get("record_id", ""), new_verdict=body.get("new_verdict", ""),
                              actor=body.get("actor", ""), reason=body.get("reason", ""), new_outcome=body.get("new_outcome"))
    except (ValueError, EvidenceConflict) as exc:
        raise HTTPException(422, str(exc)) from exc


@app.get("/api/cases")
def list_cases() -> list[dict]:
    p = ROOT / "data" / "sample" / "cases.json"
    if p.exists():
        import json
        return json.loads(p.read_text(encoding="utf-8"))
    return []


@app.get("/api/workflows")
def list_workflows() -> list[dict]:
    wf_dir = STORE.root / "workflows"
    if not wf_dir.exists():
        return []
    import json
    out = []
    for f in sorted(wf_dir.glob("*.json")):
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
            fo = data.get("final_outcome", {})
            out.append({
                "workflow_id": data.get("workflow_id"),
                "subject_id": data.get("subject_id"),
                "org_id": data.get("org_id"),
                "status": data.get("status"),
                "outcome": fo.get("outcome"),
                "verdict": fo.get("verdict"),
                "claimable_usd": fo.get("claimable_usd"),
                "reason": fo.get("reason"),
                "stages": [sr.get("stage") for sr in data.get("stage_results", [])],
                "effective_verdicts": fo.get("effective_verdicts", {})
            })
        except Exception:
            pass
    return out


@app.get("/api/evidence/{record_id}")
def get_evidence(record_id: str) -> dict:
    rec = STORE.get_evidence(record_id)
    if rec is None:
        raise HTTPException(404, f"no evidence {record_id}")
    return rec


from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

STATIC_DIR = ROOT / "orchestration" / "static"
if STATIC_DIR.exists():
    app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="orchestrator_static")
    if (STATIC_DIR / "vendor").exists():
        app.mount("/vendor", StaticFiles(directory=str(STATIC_DIR / "vendor")), name="vendor_static")

    @app.get("/")
    def index():
        return FileResponse(STATIC_DIR / "index.html")

    @app.get("/ui")
    def ui():
        return FileResponse(STATIC_DIR / "index.html")

    @app.get("/login")
    def login():
        return FileResponse(STATIC_DIR / "index.html")

    @app.get("/style.css")
    def style_css():
        return FileResponse(STATIC_DIR / "style.css")

    @app.get("/app.js")
    def app_js():
        return FileResponse(STATIC_DIR / "app.js")

    @app.get("/pages.js")
    def pages_js():
        return FileResponse(STATIC_DIR / "pages.js")

