"""Receiving Manager: agent entry point (the Round 2 agent, integrated through a thin adapter).

The agent itself is the Round 2 Receiving Manager in ./round2, copied UNCHANGED (see PROVENANCE.md).
This file only adapts it to the Pod contract:

    Agent Input --(this file)--> bridge.ts --> round2/lib/inspect.ts: inspectUnit()  (one blind Gemini call per unit)
    Round 2 evidence record --(this file)--> Evidence Record + Agent Output (shared/utils/records.py)

Contract duties handled here: tenancy (LookupError -> 404), fail open (pending_output on any bridge/model problem),
idempotency (same request_id -> same output), never invent evidence (no captures -> pending, never a PASS).

Run:  uvicorn agents.receiving.app:app --port 8101
Needs Node 20+ and, once:  cd agents/receiving/round2 && npm ci
"""
from __future__ import annotations

import copy
import json
import os
import subprocess
import threading
from pathlib import Path

from shared.utils import sample_data
from shared.utils.records import build_output, build_record, check, pending_output
from shared.utils.server import make_app

STAGE = "receiving"
VERSION = "1.0.0"
AGENT_ID = f"receiving-manager@{VERSION}"
HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
TSX = HERE / "round2" / "node_modules" / "tsx" / "dist" / "cli.mjs"

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


def _env() -> dict:
    """Process env, plus GEMINI_* from the repo's .env when not already set (.env is git-ignored)."""
    env = dict(os.environ)
    dotenv = ROOT / ".env"
    if dotenv.is_file():
        for line in dotenv.read_text(encoding="utf-8").splitlines():
            key, sep, value = line.partition("=")
            if sep and key.strip().startswith("GEMINI_") and not env.get(key.strip()):
                env[key.strip()] = value.strip()
    return env


def run_bridge(payload: dict) -> dict:
    """Run the unchanged Round 2 agent on one unit. Raises RuntimeError if it could not produce a record."""
    if not TSX.is_file():
        raise RuntimeError("Round 2 dependencies are not installed (cd agents/receiving/round2 && npm ci)")
    timeout = float(os.environ.get("RECEIVING_BRIDGE_TIMEOUT_S", "90"))
    try:
        proc = subprocess.run(["node", str(TSX), str(HERE / "bridge.ts")], input=json.dumps(payload),
                              capture_output=True, text=True, encoding="utf-8", timeout=timeout, cwd=HERE, env=_env())
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError(f"Round 2 agent timed out after {timeout:.0f}s") from exc
    except OSError as exc:
        raise RuntimeError(f"could not start node ({exc})") from exc
    if proc.returncode != 0:
        raise RuntimeError((proc.stderr.strip() or f"bridge exited with {proc.returncode}")[-300:])
    return json.loads(proc.stdout)


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
    if not captures:
        # Nothing to look at: every check is UNCERTAIN and a person is asked, never a PASS (same convention as Returns).
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

    counts = (request.get("context") or {}).get("operator_counts") or {}
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


app = make_app(STAGE, handle, VERSION)
