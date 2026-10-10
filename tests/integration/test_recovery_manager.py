"""Integration tests specifically for RECOVER Recovery Manager.

Covers all 17 requirements specified in the integration rubric:
1. Valid Recovery Agent Output
2. Record ID starts with: RCY-
3. Same request_id produces the same record_id (idempotency)
4. Foreign tenant is rejected (tenancy isolation)
5. Upstream evidence_refs are preserved
6. Receiving pre-existing damage precedence
7. Clean Receiving + Prep evidence -> claim recommended
8. Warehouse damage causality
9. Returned item / refund-issued-item-not-returned
10. Weight-tier fee handling (Finding F-07)
11. Zero/negative fee handling (Finding F-09)
12. Override behavior (latest workflow override effective)
13. Missing evidence behavior -> never claim
14. Ambiguous evidence behavior -> never claim
15. CLAIM_RECOMMENDED validation
16. REVIEW_REQUIRED validation
17. NO_CLAIM validation
"""
import pytest

from orchestration.clients import AgentRejected, client_for
from shared.utils.hashing import verify
from shared.utils.records import build_output, build_record, check
from shared.utils.schema import errors
from tests.conftest import make_input


@pytest.fixture
def recovery_client():
    return client_for("recovery")


def make_upstream_record(stage: str, unit_id: str, org_id: str, verdict: str, checks_list: list[dict] = None) -> dict:
    """Helper to construct contract-valid upstream Evidence Records."""
    prefix = {"receiving": "RCV", "prep": "PRP", "pack": "PCK", "returns": "RTN"}[stage]
    req = {
        "workflow_id": f"WF-{org_id}-{unit_id}",
        "stage": stage,
        "subject": {"org_id": org_id, "subject_id": unit_id},
    }
    checks = checks_list or [check("c1", verdict, 0.95)]
    rec = build_record(
        req,
        agent_id=f"{stage}-test@1",
        record_id=f"{prefix}-{unit_id}",
        captured_at="2026-06-01T00:00:00Z",
        checks=checks,
        outcome="compliant" if verdict == "PASS" else "non_compliant",
        reason="test record",
        model={"name": "test", "version": "1"},
        verdict=verdict,
    )
    return rec


# 1. Valid Recovery Agent Output
def test_valid_recovery_agent_output(recovery_client, cases):
    case = next(c for c in cases if c["unit_id"] == "UNIT-0014")
    inp = make_input("recovery", case)
    out = recovery_client.run(inp, 30)

    assert errors("agent-output", out) == [], "Output must adhere to agent-output schema"
    assert out["stage"] == "recovery"
    assert verify(out["evidence"]), "Evidence content_hash must verify"


# 2. Record ID starts with: RCY-
def test_record_id_prefix(recovery_client, cases):
    case = next(c for c in cases if c["unit_id"] == "UNIT-0014")
    out = recovery_client.run(make_input("recovery", case), 30)
    rec_id = out["evidence"]["record_id"]

    assert rec_id.startswith("RCY-")
    assert rec_id == f"RCY-{case['unit_id']}"


# 3. Same request_id produces the same record_id (Idempotency)
def test_idempotency_same_request_same_record_id(recovery_client, cases):
    case = next(c for c in cases if c["unit_id"] == "UNIT-0014")
    inp1 = make_input("recovery", case)
    inp2 = make_input("recovery", case)

    out1 = recovery_client.run(inp1, 30)
    out2 = recovery_client.run(inp2, 30)

    assert out1["evidence"]["record_id"] == out2["evidence"]["record_id"]
    assert out1["evidence"]["content_hash"] == out2["evidence"]["content_hash"]


# 4. Foreign tenant is rejected
def test_foreign_tenant_rejected(recovery_client, cases):
    case = next(c for c in cases if c["unit_id"] == "UNIT-0014")
    foreign_org = "org_demo_bravo" if case["org_id"] == "org_demo_alpha" else "org_demo_alpha"

    # Mismatched subject org_id
    bad_req = make_input("recovery", {**case, "org_id": foreign_org})
    with pytest.raises(AgentRejected):
        recovery_client.run(bad_req, 30)


# 5. Upstream evidence_refs are preserved
def test_upstream_evidence_refs_preserved(recovery_client, cases):
    case = next(c for c in cases if c["unit_id"] == "UNIT-0014")
    rcv_rec = make_upstream_record("receiving", case["unit_id"], case["org_id"], "PASS")
    prp_rec = make_upstream_record("prep", case["unit_id"], case["org_id"], "PASS")

    inp = make_input("recovery", case, previous=[rcv_rec, prp_rec])
    out = recovery_client.run(inp, 30)
    ev = out["evidence"]

    assert set(ev["upstream_refs"]) == {rcv_rec["record_id"], prp_rec["record_id"]}


# 6. Receiving pre-existing damage precedence
def test_receiving_pre_existing_damage_precedence(recovery_client):
    unit_id, org_id = "UNIT-0014", "org_demo_alpha"
    # Dock intake noted physical damage (verdict FAIL)
    rcv_dmg_check = check("unit_damage", "FAIL", 0.9, observed="dented_corner", detail="box crushed at dock")
    rcv_rec = make_upstream_record("receiving", unit_id, org_id, "FAIL", [rcv_dmg_check])
    # Downstream Prep was fully compliant (PASS)
    prp_rec = make_upstream_record("prep", unit_id, org_id, "PASS")

    fee_line = {
        "line_id": "LINE-DMG-01",
        "charge_type": "inbound_defect_fee",
        "amount_usd": 25.00,
        "quantity": 1,
        "posted_date": "2026-06-05",
    }
    case = {"unit_id": unit_id, "org_id": org_id, "route": "fba", "returned": False}
    inp = {**make_input("recovery", case, previous=[rcv_rec, prp_rec]), "fee_lines": [fee_line]}

    out = recovery_client.run(inp, 30)
    ev = out["evidence"]
    charge_eval = ev["payload"]["charges"][0]

    # Pre-existing dock damage means the defect fee is supported by dock arrival condition
    assert charge_eval["position"] == "SUPPORTS"
    assert charge_eval["decision"] == "NO_CLAIM"
    assert rcv_rec["record_id"] in charge_eval["evidence_record_ids"]


# 7. Clean Receiving + Prep evidence -> claim recommended
def test_clean_receiving_and_prep_recommends_claim(recovery_client):
    unit_id, org_id = "UNIT-0014", "org_demo_alpha"
    rcv_rec = make_upstream_record("receiving", unit_id, org_id, "PASS", [
        check("unit_damage", "PASS", 0.95, observed="none"),
        check("identity_match", "PASS", 0.95, observed="yes"),
    ])
    prp_rec = make_upstream_record("prep", unit_id, org_id, "PASS", [
        check("polybag_sealed", "PASS", 0.95, observed="yes"),
        check("fnsku_label_placement", "PASS", 0.95, observed="compliant"),
    ])

    fee_line = {
        "line_id": "LINE-DEFECT-01",
        "charge_type": "inbound_defect_fee",
        "amount_usd": 30.00,
        "quantity": 1,
        "posted_date": "2026-06-05",
    }
    case = {"unit_id": unit_id, "org_id": org_id, "route": "fba", "returned": False}
    inp = {**make_input("recovery", case, previous=[rcv_rec, prp_rec]), "fee_lines": [fee_line]}

    out = recovery_client.run(inp, 30)
    ev = out["evidence"]
    charge_eval = ev["payload"]["charges"][0]

    assert charge_eval["position"] == "CONTRADICTS"
    assert charge_eval["decision"] == "CLAIM_RECOMMENDED"
    assert ev["payload"]["claimable_usd"] == 30.00
    assert prp_rec["record_id"] in charge_eval["evidence_record_ids"]


# 8. Warehouse damage causality
def test_warehouse_damage_causality(recovery_client):
    unit_id, org_id = "UNIT-0014", "org_demo_alpha"
    # Clean receipt at dock proves damage occurred subsequently in channel warehouse
    rcv_rec = make_upstream_record("receiving", unit_id, org_id, "PASS", [
        check("unit_damage", "PASS", 0.95, observed="none"),
    ])
    fee_line = {
        "line_id": "LINE-WH-01",
        "charge_type": "damaged_in_warehouse",
        "amount_usd": 50.00,
        "quantity": 1,
        "posted_date": "2026-06-05",
    }
    case = {"unit_id": unit_id, "org_id": org_id, "route": "fba", "returned": False}
    inp = {**make_input("recovery", case, previous=[rcv_rec]), "fee_lines": [fee_line]}

    out = recovery_client.run(inp, 30)
    ev = out["evidence"]
    charge_eval = ev["payload"]["charges"][0]

    assert charge_eval["position"] == "CONTRADICTS"
    assert charge_eval["decision"] == "CLAIM_RECOMMENDED"
    assert ev["payload"]["claimable_usd"] == 50.00


# 9. Returned item / refund-issued-item-not-returned
def test_refund_issued_item_not_returned_with_returns_receipt(recovery_client):
    unit_id, org_id = "UNIT-0014", "org_demo_alpha"
    rtn_rec = make_upstream_record("returns", unit_id, org_id, "PASS", [
        check("identity_match", "PASS", 0.95, observed="yes"),
    ])
    fee_line = {
        "line_id": "LINE-RTN-01",
        "charge_type": "refund_issued_item_not_returned",
        "amount_usd": 40.00,
        "quantity": 1,
        "posted_date": "2026-06-05",
    }
    case = {"unit_id": unit_id, "org_id": org_id, "route": "fba", "returned": True}
    inp = {**make_input("recovery", case, previous=[rtn_rec]), "fee_lines": [fee_line]}

    out = recovery_client.run(inp, 30)
    ev = out["evidence"]
    charge_eval = ev["payload"]["charges"][0]

    assert charge_eval["position"] == "CONTRADICTS"
    assert charge_eval["decision"] == "CLAIM_RECOMMENDED"
    assert rtn_rec["record_id"] in charge_eval["evidence_record_ids"]


# 10. Weight-tier fee handling (Finding F-07)
def test_weight_tier_fee_handling(recovery_client):
    unit_id, org_id = "UNIT-0014", "org_demo_alpha"
    fee_line = {
        "line_id": "LINE-WT-01",
        "charge_type": "fulfilment_fee_weight_tier",
        "amount_usd": 12.50,
        "quantity": 1,
        "posted_date": "2026-06-05",
    }
    case = {"unit_id": unit_id, "org_id": org_id, "route": "fba", "returned": False}
    inp = {**make_input("recovery", case), "fee_lines": [fee_line]}

    out = recovery_client.run(inp, 30)
    ev = out["evidence"]
    charge_eval = ev["payload"]["charges"][0]

    assert charge_eval["position"] == "SILENT"
    assert charge_eval["decision"] == "NO_CLAIM"
    assert ev["payload"]["claimable_usd"] == 0.0


# 11. Zero/negative fee handling (Finding F-09)
def test_zero_amount_fee_handling(recovery_client):
    unit_id, org_id = "UNIT-0014", "org_demo_alpha"
    fee_line = {
        "line_id": "LINE-ZERO-01",
        "charge_type": "inbound_defect_fee",
        "amount_usd": 0.00,
        "quantity": 1,
        "posted_date": "2026-06-05",
    }
    case = {"unit_id": unit_id, "org_id": org_id, "route": "fba", "returned": False}
    inp = {**make_input("recovery", case), "fee_lines": [fee_line]}

    out = recovery_client.run(inp, 30)
    ev = out["evidence"]
    charge_eval = ev["payload"]["charges"][0]

    assert charge_eval["position"] == "SILENT"
    assert charge_eval["decision"] == "NO_CLAIM"


# 12. Override behavior (latest workflow override effective)
def test_recovery_override_flips_verdict(recovery_client):
    unit_id, org_id = "UNIT-0014", "org_demo_alpha"
    rcv_rec = make_upstream_record("receiving", unit_id, org_id, "PASS")
    prp_rec = make_upstream_record("prep", unit_id, org_id, "PASS")

    fee_line = {
        "line_id": "LINE-OVR-01",
        "charge_type": "inbound_defect_fee",
        "amount_usd": 20.00,
        "quantity": 1,
        "posted_date": "2026-06-05",
    }
    case = {"unit_id": unit_id, "org_id": org_id, "route": "fba", "returned": False}

    # Base: clean Prep -> CONTRADICTS
    base_inp = {**make_input("recovery", case, previous=[rcv_rec, prp_rec]), "fee_lines": [fee_line]}
    base_out = recovery_client.run(base_inp, 30)
    assert base_out["evidence"]["payload"]["charges"][0]["position"] == "CONTRADICTS"

    # Override: human supervisor overrides Prep from PASS to FAIL
    override = {
        "override_id": "OVR-TEST-01",
        "supersedes": {"record_id": prp_rec["record_id"], "override_id": None},
        "target": "decision",
        "actor": "supervisor_qa",
        "at": "2026-06-06T10:00:00Z",
        "reason": "barcode exposed upon secondary review",
        "original_verdict": "PASS",
        "previous_verdict": "PASS",
        "new_verdict": "FAIL",
    }
    ovr_inp = {
        **make_input("recovery", case, previous=[rcv_rec, prp_rec], overrides=[override]),
        "fee_lines": [fee_line],
    }
    ovr_out = recovery_client.run(ovr_inp, 30)
    assert ovr_out["evidence"]["payload"]["charges"][0]["position"] == "SUPPORTS"
    assert ovr_out["evidence"]["payload"]["charges"][0]["decision"] == "NO_CLAIM"


# 13. Missing evidence behavior -> never claim
def test_missing_evidence_never_claims(recovery_client):
    unit_id, org_id = "UNIT-0014", "org_demo_alpha"
    fee_line = {
        "line_id": "LINE-NOEV-01",
        "charge_type": "inbound_defect_fee",
        "amount_usd": 15.00,
        "quantity": 1,
        "posted_date": "2026-06-05",
    }
    case = {"unit_id": unit_id, "org_id": org_id, "route": "fba", "returned": False}
    # No upstream evidence passed
    inp = {**make_input("recovery", case, previous=[]), "fee_lines": [fee_line]}

    out = recovery_client.run(inp, 30)
    ev = out["evidence"]
    charge_eval = ev["payload"]["charges"][0]

    assert charge_eval["position"] == "SILENT"
    assert charge_eval["decision"] == "REVIEW_REQUIRED"
    assert ev["payload"]["claimable_usd"] == 0.0


# 14. Ambiguous evidence behavior -> never claim
def test_ambiguous_evidence_never_claims(recovery_client):
    unit_id, org_id = "UNIT-0014", "org_demo_alpha"
    rcv_rec = make_upstream_record("receiving", unit_id, org_id, "UNCERTAIN", [
        check("identity_match", "UNCERTAIN", 0.5, observed="uncertain", uncertain_reason="poor_image"),
    ])
    prp_rec = make_upstream_record("prep", unit_id, org_id, "PASS")

    fee_line = {
        "line_id": "LINE-AMB-01",
        "charge_type": "inbound_defect_fee",
        "amount_usd": 18.00,
        "quantity": 1,
        "posted_date": "2026-06-05",
    }
    case = {"unit_id": unit_id, "org_id": org_id, "route": "fba", "returned": False}
    inp = {**make_input("recovery", case, previous=[rcv_rec, prp_rec]), "fee_lines": [fee_line]}

    out = recovery_client.run(inp, 30)
    ev = out["evidence"]
    charge_eval = ev["payload"]["charges"][0]

    assert charge_eval["position"] == "SILENT"
    assert charge_eval["decision"] == "REVIEW_REQUIRED"
    assert ev["payload"]["claimable_usd"] == 0.0


# 15. CLAIM_RECOMMENDED validation
def test_claim_recommended_outcome(recovery_client):
    unit_id, org_id = "UNIT-0014", "org_demo_alpha"
    rcv_rec = make_upstream_record("receiving", unit_id, org_id, "PASS")
    prp_rec = make_upstream_record("prep", unit_id, org_id, "PASS")

    fee_line = {
        "line_id": "LINE-CLAIM-01",
        "charge_type": "inbound_defect_fee",
        "amount_usd": 45.00,
        "quantity": 1,
        "posted_date": "2026-06-05",
    }
    case = {"unit_id": unit_id, "org_id": org_id, "route": "fba", "returned": False}
    inp = {**make_input("recovery", case, previous=[rcv_rec, prp_rec]), "fee_lines": [fee_line]}

    out = recovery_client.run(inp, 30)
    assert out["verdict"] == "FAIL"
    assert out["evidence"]["decision"]["outcome"] == "claim_recommended"
    assert out["evidence"]["payload"]["claimable_usd"] == 45.00


# 16. REVIEW_REQUIRED validation
def test_review_required_outcome(recovery_client):
    unit_id, org_id = "UNIT-0014", "org_demo_alpha"
    rcv_rec = make_upstream_record("receiving", unit_id, org_id, "PASS")
    # Missing prep for inbound defect fee -> REVIEW_REQUIRED
    fee_line = {
        "line_id": "LINE-REV-01",
        "charge_type": "inbound_defect_fee",
        "amount_usd": 20.00,
        "quantity": 1,
        "posted_date": "2026-06-05",
    }
    case = {"unit_id": unit_id, "org_id": org_id, "route": "fba", "returned": False}
    inp = {**make_input("recovery", case, previous=[rcv_rec]), "fee_lines": [fee_line]}

    out = recovery_client.run(inp, 30)
    assert out["evidence"]["payload"]["charges"][0]["decision"] == "REVIEW_REQUIRED"


# 17. NO_CLAIM validation
def test_no_claim_outcome(recovery_client):
    unit_id, org_id = "UNIT-0014", "org_demo_alpha"
    fee_line = {
        "line_id": "LINE-NOCLAIM-01",
        "charge_type": "fulfilment_fee_weight_tier",
        "amount_usd": 15.00,
        "quantity": 1,
        "posted_date": "2026-06-05",
    }
    case = {"unit_id": unit_id, "org_id": org_id, "route": "fba", "returned": False}
    inp = {**make_input("recovery", case), "fee_lines": [fee_line]}

    out = recovery_client.run(inp, 30)
    assert out["evidence"]["payload"]["charges"][0]["decision"] == "NO_CLAIM"
    assert out["evidence"]["payload"]["claimable_usd"] == 0.0


# 18. Explicit fee lines are strictly used
def test_explicit_fee_lines_used(recovery_client):
    fee_lines = [
        {
            "line_id": "FEE-EXP-001",
            "charge_type": "fulfilment_fee_weight_tier",
            "amount_usd": 42.50,
            "quantity": 2,
            "posted_date": "2026-07-01",
        }
    ]
    case = {"unit_id": "UNIT-0014", "org_id": "org_demo_alpha", "route": "fba", "returned": False}
    inp = {**make_input("recovery", case), "fee_lines": fee_lines}

    out = recovery_client.run(inp, 30)
    charges = out["evidence"]["payload"]["charges"]
    assert len(charges) == 1
    assert charges[0]["line_id"] == "FEE-EXP-001"
    assert charges[0]["amount_usd"] == 42.50
    assert charges[0]["charge_type"] == "fulfilment_fee_weight_tier"


# 19. Explicit empty fee lines take precedence and do NOT load sample data
def test_explicit_empty_fee_lines_precedence(recovery_client, cases):
    # UNIT-0014 has 4 fee lines in organiser synthetic sample data (fee_report_sample.csv)
    case = next(c for c in cases if c["unit_id"] == "UNIT-0014")
    inp = {
        "schema_version": "1.0",
        "request_id": "req-no-fee-test",
        "workflow_id": f"WF-{case['org_id']}-{case['unit_id']}",
        "stage": "recovery",
        "subject": {"org_id": case["org_id"], "subject_id": case["unit_id"]},
        "inputs": [],
        "fee_lines": [],  # Explicit empty fee report provided
        "previous_evidence": [],
    }

    out = recovery_client.run(inp, 30)
    ev = out["evidence"]

    # Explicit empty fee lines strictly take precedence over standard sample data
    assert ev["payload"]["charges"] == [], "Explicit empty fee lines must take precedence"
    assert ev["payload"]["claimable_usd"] == 0.0
    assert ev["checks"] == []
    assert ev["decision"]["verdict"] == "UNCERTAIN"
    assert ev["decision"]["outcome"] == "insufficient_evidence"


# 19b. Missing fee-report data never fabricates claims
def test_missing_fee_report_data_never_fabricates_claims(recovery_client, cases):
    # UNIT-0001 has no fee lines in fee_report_sample.csv
    case = next(c for c in cases if c["unit_id"] == "UNIT-0001")
    inp = {
        "schema_version": "1.0",
        "request_id": f"WF-{case['org_id']}-{case['unit_id']}:recovery",
        "workflow_id": f"WF-{case['org_id']}-{case['unit_id']}",
        "stage": "recovery",
        "subject": {"org_id": case["org_id"], "subject_id": case["unit_id"], "route": case["route"]},
        "inputs": [],
        "previous_evidence": [],
    }

    out = recovery_client.run(inp, 30)
    ev = out["evidence"]

    # Must return contract-compliant insufficient evidence without fabricating claims
    assert ev["payload"]["charges"] == []
    assert ev["payload"]["claimable_usd"] == 0.0
    assert ev["checks"] == []
    assert ev["decision"]["verdict"] == "UNCERTAIN"
    assert ev["decision"]["outcome"] == "insufficient_evidence"


# 19c. Normal orchestrated request accesses fee report without entering stub pathway
def test_orchestrated_request_accesses_fee_report_with_real_agents(recovery_client, cases):
    case = next(c for c in cases if c["unit_id"] == "UNIT-0014")
    # Real upstream evidence records (none ending in -stub@0)
    real_rcv = {
        "record_id": "RCV-0014",
        "agent_id": "receiving-manager@1.0.0",
        "stage": "receiving",
        "subject": {"org_id": case["org_id"], "subject_id": case["unit_id"]},
        "decision": {"verdict": "PASS", "outcome": "accepted"},
        "checks": [{"check_key": "identity_match", "verdict": "PASS", "observed": "matched"}],
        "payload": {},
    }
    real_prp = {
        "record_id": "PRP-0014",
        "agent_id": "prep-manager@1.0.0",
        "stage": "prep",
        "subject": {"org_id": case["org_id"], "subject_id": case["unit_id"]},
        "decision": {"verdict": "PASS", "outcome": "compliant"},
        "checks": [{"check_key": "packaging_intact", "verdict": "PASS", "observed": "intact"}],
        "payload": {},
    }
    inp = {
        "schema_version": "1.0",
        "request_id": f"WF-{case['org_id']}-{case['unit_id']}:recovery",
        "workflow_id": f"WF-{case['org_id']}-{case['unit_id']}",
        "stage": "recovery",
        "subject": {"org_id": case["org_id"], "subject_id": case["unit_id"], "route": "fba"},
        "inputs": [],
        "previous_evidence": [real_rcv, real_prp],
        "context": {"overrides": [], "case": case},
    }

    out = recovery_client.run(inp, 30)
    ev = out["evidence"]

    # Successfully loaded 4 fee lines for UNIT-0014 from standard fee report
    assert len(ev["payload"]["charges"]) == 4
    pos = {c["charge_type"]: c["position"] for c in ev["payload"]["charges"]}
    assert pos["inbound_defect_fee"] == "CONTRADICTS"
    assert ev["payload"]["claimable_usd"] == 2.0
    assert ev["decision"]["verdict"] == "FAIL"  # Condition failed -> claim recommended
    assert ev["decision"]["outcome"] == "claim_recommended"


# 19d. Real upstream evidence and reviewer overrides are respected without stub pathway
def test_real_upstream_evidence_and_reviewer_overrides_respected(recovery_client, cases):
    case = next(c for c in cases if c["unit_id"] == "UNIT-0014")
    real_rcv = {
        "record_id": "RCV-0014",
        "agent_id": "receiving-manager@1.0.0",
        "stage": "receiving",
        "subject": {"org_id": case["org_id"], "subject_id": case["unit_id"]},
        "decision": {"verdict": "PASS", "outcome": "accepted"},
        "checks": [{"check_key": "identity_match", "verdict": "PASS", "observed": "matched"}],
        "payload": {},
    }
    real_prp = {
        "record_id": "PRP-0014",
        "agent_id": "prep-manager@1.0.0",
        "stage": "prep",
        "subject": {"org_id": case["org_id"], "subject_id": case["unit_id"]},
        "decision": {"verdict": "PASS", "outcome": "compliant"},
        "checks": [{"check_key": "packaging_intact", "verdict": "PASS", "observed": "intact"}],
        "payload": {},
    }
    override = {
        "override_id": "OVR-001",
        "supersedes": {"record_id": "PRP-0014", "override_id": None},
        "target": "decision",
        "actor": "operator_reviewer",
        "at": "2026-01-01T00:00:00Z",
        "reason": "seal broken observed on manual inspection",
        "original_verdict": "PASS",
        "previous_verdict": "PASS",
        "new_verdict": "FAIL",
    }
    inp = {
        "schema_version": "1.0",
        "request_id": f"WF-{case['org_id']}-{case['unit_id']}:recovery",
        "workflow_id": f"WF-{case['org_id']}-{case['unit_id']}",
        "stage": "recovery",
        "subject": {"org_id": case["org_id"], "subject_id": case["unit_id"], "route": "fba"},
        "inputs": [],
        "previous_evidence": [real_rcv, real_prp],
        "context": {"overrides": [override], "case": case},
    }

    out = recovery_client.run(inp, 30)
    ev = out["evidence"]
    pos = {c["charge_type"]: c["position"] for c in ev["payload"]["charges"]}
    # With Prep overridden to FAIL, inbound_defect_fee is now supported by evidence (no claim)
    assert pos["inbound_defect_fee"] == "SUPPORTS"


# 20. Real / non-sample subject is not rejected merely because absent from sample_data
def test_real_non_sample_subject_not_rejected(recovery_client):
    real_subject_id = "REAL-PROD-UNIT-9999"
    real_org_id = "org_production_tenant"
    fee_lines = [
        {
            "line_id": "FEE-PROD-01",
            "charge_type": "fulfilment_fee_weight_tier",
            "amount_usd": 18.00,
            "quantity": 1,
            "posted_date": "2026-08-15",
        }
    ]
    inp = {
        "schema_version": "1.0",
        "request_id": f"WF-{real_org_id}-{real_subject_id}:recovery",
        "workflow_id": f"WF-{real_org_id}-{real_subject_id}",
        "stage": "recovery",
        "subject": {"org_id": real_org_id, "subject_id": real_subject_id, "route": "fba"},
        "inputs": [],
        "previous_evidence": [],
        "fee_lines": fee_lines,
    }

    out = recovery_client.run(inp, 30)
    ev = out["evidence"]
    assert ev["record_id"] == f"RCY-{real_subject_id}"
    assert ev["subject"]["org_id"] == real_org_id
    assert ev["subject"]["subject_id"] == real_subject_id
    assert len(ev["payload"]["charges"]) == 1
    assert ev["payload"]["charges"][0]["line_id"] == "FEE-PROD-01"


# 21. Cross-tenant requests are still rejected according to Round 3 contract
def test_cross_tenant_requests_properly_rejected(recovery_client):
    # a. Sample subject under wrong tenant
    bad_sample_inp = {
        "schema_version": "1.0",
        "request_id": "WF-wrong:recovery",
        "workflow_id": "WF-org_demo_bravo-UNIT-0014",
        "stage": "recovery",
        "subject": {"org_id": "org_demo_bravo", "subject_id": "UNIT-0014"},
        "inputs": [],
        "previous_evidence": [],
    }
    with pytest.raises(AgentRejected):
        recovery_client.run(bad_sample_inp, 30)

    # b. Non-sample subject with mismatched context case org_id
    bad_ctx_inp = {
        "schema_version": "1.0",
        "request_id": "WF-ctx-mismatch:recovery",
        "workflow_id": "WF-org_a-PROD-1",
        "stage": "recovery",
        "subject": {"org_id": "org_a", "subject_id": "PROD-1"},
        "context": {"case": {"org_id": "org_b"}},
        "inputs": [],
        "previous_evidence": [],
    }
    with pytest.raises(AgentRejected):
        recovery_client.run(bad_ctx_inp, 30)

    # c. Upstream evidence from a foreign tenant
    foreign_rec = {
        "schema_version": "1.0",
        "record_id": "RCV-PROD-1",
        "workflow_id": "WF-org_foreign-PROD-1",
        "stage": "receiving",
        "agent_id": "receiving@1",
        "subject": {"org_id": "org_foreign", "subject_id": "PROD-1"},
        "status": "completed",
        "captured_at": "2026-01-01T00:00:00Z",
        "produced_at": "2026-01-01T00:00:00Z",
        "model": {"name": "test", "version": "1"},
        "inputs": [],
        "checks": [],
        "decision": {"verdict": "PASS", "outcome": "accept", "reason": "ok"},
        "upstream_refs": [],
        "content_hash": "a" * 64,
    }
    bad_prev_inp = {
        "schema_version": "1.0",
        "request_id": "WF-prev-mismatch:recovery",
        "workflow_id": "WF-org_a-PROD-1",
        "stage": "recovery",
        "subject": {"org_id": "org_a", "subject_id": "PROD-1"},
        "inputs": [],
        "previous_evidence": [foreign_rec],
    }
    with pytest.raises(AgentRejected):
        recovery_client.run(bad_prev_inp, 30)

