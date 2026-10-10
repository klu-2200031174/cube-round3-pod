"""Returns Manager on the Pod's own fixtures: real captures, recorded model answers, Pack hand-off, failure, tenancy.

The model is replaced by recorded Gemini answers for real return photos (tests/fixtures/returns/), so these
tests need no API key and are deterministic. The photo bytes are fake; only their hashes matter here.
"""
import hashlib
import json
from pathlib import Path

import pytest

from agents.returns import app as returns
from agents.returns.returns_agent.vlm import ModelError, ScriptedProvider
from shared.utils.hashing import verify
from shared.utils.schema import errors

FIX = Path(__file__).resolve().parents[1] / "fixtures" / "returns"
ORG, UNIT = "org_demo_alpha", "UNIT-9105"  # demo order ORD-HOME-91005: flip-lid water bottle


def recorded(name):
    c = json.loads((FIX / f"{name}.json").read_text())
    return ScriptedProvider(c["raw"], c["model_version"])


@pytest.fixture
def capture(tmp_path, monkeypatch):
    """One return photo in <INPUT_DIR>/<unit>/returns/, as the orchestrator would discover it."""
    monkeypatch.setenv("INPUT_DIR", str(tmp_path))
    folder = tmp_path / UNIT / "returns"
    folder.mkdir(parents=True)
    data = b"\xff\xd8\xff\xe0" + b"synthetic-test-photo" * 10
    (folder / "1.jpg").write_bytes(data)
    return {"ref": f"{UNIT}/returns/1.jpg", "kind": "image", "sha256": hashlib.sha256(data).hexdigest()}


def make_request(inputs, previous=None, org=ORG, unit=UNIT):
    wf = f"WF-{org}-{unit}"
    return {"schema_version": "1.0", "request_id": f"{wf}:returns", "workflow_id": wf, "stage": "returns",
            "subject": {"org_id": org, "subject_id": unit, "route": "mfn"}, "inputs": inputs,
            "previous_evidence": previous or [], "context": {"overrides": [], "case": {}}}


def pack_record(shipped, verdict="PASS", unit=UNIT):
    return {"record_id": f"PCK-{unit}", "stage": "pack", "decision": {"verdict": verdict, "outcome": "seal"},
            "checks": [{"check_key": "items_present", "verdict": verdict, "confidence": None, "observed": shipped}],
            "payload": {}}


def run(monkeypatch, provider, request):
    monkeypatch.setattr(returns, "_provider", provider)
    out = returns.handle(request)
    assert errors("agent-output", out) == [], "output must satisfy the shared contract"
    assert verify(out["evidence"]), "content_hash must match the record body"
    return out, out["evidence"]


def test_correct_item_is_restocked_with_photo_evidence(monkeypatch, capture):
    out, ev = run(monkeypatch, recorded("model_bottle_match"), make_request([capture]))
    assert out["verdict"] == "PASS" and ev["decision"]["outcome"] == "restock"
    assert ev["decision"]["needs_human"] is False
    checks = {c["check_key"]: c for c in ev["checks"]}
    assert {"image_quality", "identity_match", "completeness", "condition"} <= set(checks)
    assert checks["identity_match"]["evidence_refs"] == [capture["ref"]], "verdicts must cite the exact photo"
    assert ev["inputs"] == [capture], "the record names the exact bytes it judged"
    assert ev["payload"]["condition_grade"] == "Used - Like New"
    assert ev["model"]["calls"] == 1, "one batched model call per unit"


def test_wrong_item_fails_identity_and_goes_to_a_person(monkeypatch, capture):
    out, ev = run(monkeypatch, recorded("model_bottle_wrong_item"), make_request([capture]))
    assert out["verdict"] == "FAIL" and ev["decision"]["outcome"] == "pending_review"
    assert ev["decision"]["needs_human"] is True


def test_suspected_swap_when_pack_sealed_the_right_item(monkeypatch, capture):
    pack = pack_record(["SKU-WATERBOTTLE-FLIP"])
    out, ev = run(monkeypatch, recorded("model_bottle_wrong_item"), make_request([capture], [pack]))
    swap = next(c for c in ev["checks"] if c["check_key"] == "matches_pack_record")
    assert swap["verdict"] == "FAIL" and swap["evidence_refs"] == [pack["record_id"]]
    assert ev["upstream_refs"] == [pack["record_id"]], "the Pack record it relied on is listed"
    assert ev["payload"]["pack_cross_check"]["finding"].startswith("suspected swap")


def test_matching_return_agrees_with_pack(monkeypatch, capture):
    out, ev = run(monkeypatch, recorded("model_bottle_match"), make_request([capture], [pack_record(["SKU-WATERBOTTLE-FLIP"])]))
    assert next(c for c in ev["checks"] if c["check_key"] == "matches_pack_record")["verdict"] == "PASS"
    assert out["verdict"] == "PASS"


def test_model_failure_fails_open_and_keeps_the_photo(monkeypatch, capture):
    out, ev = run(monkeypatch, ScriptedProvider(ModelError("503 overloaded")), make_request([capture]))
    assert out["status"] == ev["status"] == "pending" and out["verdict"] == "UNCERTAIN"
    assert ev["error"]["code"] == "model_error" and ev["error"]["retryable"] is True
    assert ev["inputs"] == [capture], "a model failure must still keep the capture"
    assert out["next_step_recommendation"]["action"] == "retry"


def test_no_photos_is_uncertain_not_a_guess(monkeypatch):
    out, ev = run(monkeypatch, recorded("model_bottle_match"), make_request([]))
    assert out["verdict"] == "UNCERTAIN" and ev["decision"]["outcome"] == "pending_review"
    assert ev["model"]["calls"] == 0, "no photo, no model call"


def test_tampered_photo_is_not_used(monkeypatch, capture):
    bad = dict(capture, sha256="0" * 64)
    out, ev = run(monkeypatch, recorded("model_bottle_match"), make_request([bad]))
    assert out["verdict"] == "UNCERTAIN" and ev["inputs"] == []
    assert "sha256" in ev["payload"]["input_problems"][0]


def test_other_org_is_refused(monkeypatch, capture):
    monkeypatch.setattr(returns, "_provider", recorded("model_bottle_match"))
    with pytest.raises(LookupError):
        returns.handle(make_request([capture], org="org_demo_bravo"))


def test_same_request_same_record_id(monkeypatch, capture):
    req = make_request([capture])
    _, a = run(monkeypatch, recorded("model_bottle_match"), req)
    _, b = run(monkeypatch, recorded("model_bottle_match"), req)
    assert a["record_id"] == b["record_id"]
