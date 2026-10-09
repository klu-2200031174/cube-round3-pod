"""Receiving Manager adapter: our own fixtures, no API key (the Round 2 call is replaced by a recorded-shape fake)."""
import hashlib
import uuid

import pytest

from agents.receiving import app as rcv
from shared.utils.hashing import verify
from shared.utils.schema import errors

UNIT, ORG = "UNIT-0007", "org_demo_alpha"


def _input(inputs=None, org=ORG):
    wf = f"WF-{org}-{UNIT}"
    return {"schema_version": "1.0", "request_id": f"{wf}:receiving:{uuid.uuid4().hex}", "workflow_id": wf,
            "stage": "receiving", "subject": {"org_id": org, "subject_id": UNIT, "route": "mfn"},
            "inputs": inputs or [], "previous_evidence": [], "context": {"overrides": []}}


@pytest.fixture
def capture(tmp_path, monkeypatch):
    """One carton photo under a temporary input root, as the orchestrator would pass it."""
    monkeypatch.setenv("INPUT_DIR", str(tmp_path))
    f = tmp_path / UNIT / "receiving" / "carton.jpg"
    f.parent.mkdir(parents=True)
    f.write_bytes(b"\xff\xd8 fake jpeg bytes")
    return {"ref": f"{UNIT}/receiving/carton.jpg", "kind": "image", "sha256": hashlib.sha256(f.read_bytes()).hexdigest()}


def _round2_record(capture, status="complete"):
    """The shape round2/lib/evidence.ts buildRecord() produces (receiving-evidence/0.2)."""
    def c(name, verdict, conf, refs=(1,)):
        return {"name": name, "verdict": verdict, "confidence": conf, "expected": 6, "observed": 9,
                "source": "model", "photo_refs": list(refs), "reason": f"{name} reason"}
    return {"contract_version": "receiving-evidence/0.2", "status": status, "overall": "EXCEPTION",
            "photos": [{"index": 1, "role": "carton", "ref": capture["ref"], "sha256": capture["sha256"]}],
            "checks": [c("identity", "UNCERTAIN", None), c("variant_colour", "FAIL", "medium"),
                       c("carton_count", "UNCERTAIN", None, ()), c("units_per_carton", "FAIL", "low"),
                       c("quantity", "UNCERTAIN", None, ()), c("carton_damage", "PASS", "medium"),
                       c("unit_damage", "PASS", "medium"), c("components", "UNCERTAIN", None), c("defects", "PASS", "medium")],
            "summary": {"qty_received": None, "quality_flags": ["wrong_colour"]},
            "model": {"provider": "gemini", "model": "gemini-3.5-flash-lite", "prompt_version": "rcv-prompt/0.2-blind",
                      "latency_ms": 3200, "error": None if status == "complete" else "Gemini returned HTTP 503",
                      "raw_output": "{...}"}}


def _assert_valid(out):
    assert errors("agent-output", out) == []
    assert verify(out["evidence"]), "content_hash must match the record body"
    assert out["verdict"] == out["evidence"]["decision"]["verdict"]


def test_photographed_unit_maps_round2_record_to_the_contract(capture, monkeypatch):
    calls = []
    monkeypatch.setattr(rcv, "run_bridge", lambda p: calls.append(p) or _round2_record(capture))
    out = rcv.handle(_input([capture]))
    _assert_valid(out)
    ev = out["evidence"]
    keys = [c["check_key"] for c in ev["checks"]]
    assert keys[0] == "identity_match" and keys[-1] == "quality_flags" and len(keys) == 9
    assert out["verdict"] == "FAIL" and ev["decision"]["outcome"] == "accept_with_exceptions"
    assert ev["model"]["calls"] == 1 and ev["model"]["name"] == "gemini-3.5-flash-lite"
    assert ev["inputs"][0]["sha256"] == capture["sha256"]
    upc = next(c for c in ev["checks"] if c["check_key"] == "units_per_carton")
    assert upc["confidence"] == 0.4 and upc["evidence_refs"] == [capture["ref"]]
    assert all(c.get("uncertain_reason") for c in ev["checks"] if c["verdict"] == "UNCERTAIN")
    assert "raw_output" not in ev["payload"]["round2_record"]["model"]
    # The PO goes to Round 2; the photo is passed by path with its role.
    assert calls[0]["po_row"]["unit_id"] == UNIT and calls[0]["photos"][0]["role"] == "carton"


def test_no_photos_is_uncertain_for_a_human_never_a_pass(monkeypatch):
    monkeypatch.setattr(rcv, "run_bridge", lambda p: pytest.fail("no model call without photos"))
    out = rcv.handle(_input())
    _assert_valid(out)
    ev = out["evidence"]
    assert out["verdict"] == "UNCERTAIN" and ev["decision"]["needs_human"] is True
    assert {c["verdict"] for c in ev["checks"]} == {"UNCERTAIN"} and len(ev["checks"]) == 9
    assert ev["model"]["calls"] == 0 and ev["decision"]["outcome"] == "pending_review"


def test_other_tenant_is_refused():
    with pytest.raises(LookupError):
        rcv.handle(_input(org="org_demo_bravo"))


def test_bridge_failure_fails_open_to_pending(capture, monkeypatch):
    def boom(_):
        raise RuntimeError("Round 2 agent timed out after 90s")
    monkeypatch.setattr(rcv, "run_bridge", boom)
    out = rcv.handle(_input([capture]))
    _assert_valid(out)
    assert out["status"] == "pending" and out["verdict"] == "UNCERTAIN" and "timed out" in out["error"]["message"]


def test_round2_model_error_stays_pending(capture, monkeypatch):
    monkeypatch.setattr(rcv, "run_bridge", lambda p: _round2_record(capture, status="pending"))
    out = rcv.handle(_input([capture]))
    _assert_valid(out)
    assert out["status"] == "pending" and "503" in out["error"]["message"]


def test_changed_capture_bytes_are_rejected(capture, monkeypatch):
    rec = _round2_record(capture)
    rec["photos"][0]["sha256"] = "0" * 64
    monkeypatch.setattr(rcv, "run_bridge", lambda p: rec)
    out = rcv.handle(_input([capture]))
    _assert_valid(out)
    assert out["status"] == "error" and "sha256" in out["error"]["message"]


def test_same_request_same_output_even_if_a_caller_mutates_it(capture, monkeypatch):
    monkeypatch.setattr(rcv, "run_bridge", lambda p: _round2_record(capture))
    req = _input([capture])
    first = rcv.handle(req)
    first["evidence"]["checks"] = []
    assert len(rcv.handle(req)["evidence"]["checks"]) == 9
