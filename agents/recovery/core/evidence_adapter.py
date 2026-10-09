"""RECOVER Evidence Adapter.

Translates accumulated Round 3 upstream Evidence Records into structured
EvidenceItem and EvidenceFinding domain objects, faithfully preserving Round 2
interpretations (src/lib/evidence.ts) while respecting Round 3 schemas and overrides.
"""
from __future__ import annotations

from typing import Any

from shared.utils.stubs import effective_verdict

from .types import (
    EvidenceFinding,
    EvidenceItem,
    EvidenceState,
)


def _get_check(checks: list[dict[str, Any]], key_prefix: str) -> dict[str, Any] | None:
    """Find check by exact key or prefix."""
    for c in checks:
        k = c.get("check_key", "")
        if k == key_prefix or k.startswith(key_prefix):
            return c
    return None


def interpret_receiving_record(
    record: dict[str, Any],
    effective_v: str,
    charge_type: str,
) -> EvidenceItem:
    """Interprets Receiving (Dock Intake) evidence record (Round 2 src/lib/evidence.ts)."""
    rec_id = record.get("record_id", "RCV-UNKNOWN")
    subject = record.get("subject", {})
    unit_id = subject.get("subject_id") or subject.get("unit_id", "")
    org_id = subject.get("org_id", "")
    timestamp = record.get("captured_at") or record.get("produced_at", "")
    checks = record.get("checks", [])
    payload = record.get("payload", {})

    finding_lines: list[str] = []
    supporting: list[str] = []
    contradicting: list[str] = []
    missing: list[str] = []
    findings_detail: list[EvidenceFinding] = []
    state: EvidenceState = "PASS"
    decision_impact = ""

    # 1. Identity Match Check
    id_check = _get_check(checks, "identity_match")
    id_verdict = id_check.get("verdict") if id_check else None
    id_obs = str(id_check.get("observed", "")).lower() if id_check else ""

    if id_verdict == "PASS" or id_obs in ("yes", "pass", "matched"):
        finding_lines.append("Product identity confirmed at dock intake.")
        supporting.append("Identity match confirmed at receiving dock.")
        findings_detail.append(EvidenceFinding(
            id=f"fnd-rcv-id-{rec_id}",
            source="receiving",
            source_record_id=rec_id,
            finding="Product identity confirmed at dock intake.",
            charge_relevance="DIRECTLY_RELEVANT",
            relevance_explanation="Confirms physical unit received matches purchase order SKU/ASIN.",
            classification="SUPPORTS_CLAIM",
            impact="HIGH",
            is_pre_existing=False,
        ))
    elif id_verdict == "UNCERTAIN" or id_obs in ("uncertain", "unclear"):
        finding_lines.append("Product identity uncertain at receiving.")
        missing.append("Reliable identity confirmation at receiving")
        state = "UNCERTAIN"
        findings_detail.append(EvidenceFinding(
            id=f"fnd-rcv-id-{rec_id}",
            source="receiving",
            source_record_id=rec_id,
            finding="Product identity uncertain at receiving dock.",
            charge_relevance="DIRECTLY_RELEVANT",
            relevance_explanation="Cannot verify whether the received unit matches the charged catalog item.",
            classification="UNCERTAIN",
            impact="HIGH",
            is_pre_existing=False,
        ))
    elif id_verdict == "FAIL" or (id_obs and id_obs not in ("none", "")):
        finding_lines.append(f"Product identity mismatch at receiving: {id_obs or 'FAIL'}")
        contradicting.append(f"Identity mismatch at receiving: {id_obs or 'FAIL'}")
        state = "FAIL"
        findings_detail.append(EvidenceFinding(
            id=f"fnd-rcv-id-{rec_id}",
            source="receiving",
            source_record_id=rec_id,
            finding=f"Product identity mismatch ({id_obs or 'FAIL'}) at intake.",
            charge_relevance="DIRECTLY_RELEVANT",
            relevance_explanation="Identity mismatch prevents linking upstream evidence to charge.",
            classification="CONTRADICTS_CLAIM",
            impact="HIGH",
            is_pre_existing=True,
        ))

    # 2. Physical Unit Damage (Pre-existing Condition Rule)
    dmg_check = _get_check(checks, "unit_damage")
    dmg_verdict = dmg_check.get("verdict") if dmg_check else None
    dmg_obs = str(dmg_check.get("observed", "")).lower() if dmg_check else ""

    if dmg_verdict == "FAIL" or (dmg_obs and dmg_obs not in ("none", "pass", "no", "clean", "")):
        desc = dmg_obs if dmg_obs not in ("fail", "") else "unit physical damage noted"
        finding_lines.append(f"Unit damage noted at receiving: {desc}")
        contradicting.append(f"Pre-existing unit damage at receiving: {desc}")
        state = "FAIL"
        decision_impact = (
            f"Pre-existing damage ({desc}) recorded upon arrival justifies inbound defect fee. "
            "Downstream packaging compliance cannot negate prior damage."
        )
        findings_detail.append(EvidenceFinding(
            id=f"fnd-rcv-dmg-{rec_id}",
            source="receiving",
            source_record_id=rec_id,
            finding=f"Receiving damage logged: {desc}",
            charge_relevance="DIRECTLY_RELEVANT",
            relevance_explanation="Physical damage existed on carrier arrival. Downstream packaging compliance does not establish unit was undamaged.",
            classification="CONTRADICTS_CLAIM",
            impact="HIGH",
            is_pre_existing=True,
        ))
    elif dmg_verdict == "UNCERTAIN" or dmg_obs == "uncertain":
        finding_lines.append("Unit damage condition uncertain at receiving.")
        missing.append("Clear receiving unit damage assessment")
        state = "FAIL" if state == "FAIL" else "UNCERTAIN"
        findings_detail.append(EvidenceFinding(
            id=f"fnd-rcv-dmg-{rec_id}",
            source="receiving",
            source_record_id=rec_id,
            finding="Unit physical condition uncertain at intake.",
            charge_relevance="DIRECTLY_RELEVANT",
            relevance_explanation="Uncertain intake condition leaves causality unresolved.",
            classification="UNCERTAIN",
            impact="HIGH",
            is_pre_existing=False,
        ))
    else:
        finding_lines.append("No unit damage noted at receiving.")
        supporting.append("Clean arrival: no unit damage recorded at receiving")
        findings_detail.append(EvidenceFinding(
            id=f"fnd-rcv-dmg-{rec_id}",
            source="receiving",
            source_record_id=rec_id,
            finding="No unit damage noted at receiving intake.",
            charge_relevance="DIRECTLY_RELEVANT" if charge_type in ("inbound_defect_fee", "damaged_in_warehouse") else "CONTEXTUAL_ONLY",
            relevance_explanation="Intake inspection verified unit arrived free of visible physical damage.",
            classification="SUPPORTS_CLAIM",
            impact="HIGH",
            is_pre_existing=False,
        ))

    # 3. Carton Damage
    crt_check = _get_check(checks, "carton_damage")
    crt_verdict = crt_check.get("verdict") if crt_check else None
    crt_obs = str(crt_check.get("observed", "")).lower() if crt_check else ""
    if crt_verdict == "FAIL" or (crt_obs and crt_obs not in ("none", "pass", "no", "clean", "")):
        finding_lines.append(f"Carton damage noted at receiving: {crt_obs}")
        if charge_type in ("inbound_defect_fee", "damaged_in_warehouse"):
            contradicting.append(f"Pre-existing carton damage at receiving: {crt_obs}")
            state = "FAIL"
            findings_detail.append(EvidenceFinding(
                id=f"fnd-rcv-crt-{rec_id}",
                source="receiving",
                source_record_id=rec_id,
                finding=f"Carton damage noted: {crt_obs}",
                charge_relevance="DIRECTLY_RELEVANT",
                relevance_explanation="External carton damage indicates transit or handling stress prior to warehouse processing.",
                classification="CONTRADICTS_CLAIM",
                impact="MEDIUM",
                is_pre_existing=True,
            ))

    # 4. Quantity / Shortfall
    qty_check = _get_check(checks, "quantity")
    shortfall = payload.get("shortfall_units", 0)
    if (qty_check and qty_check.get("verdict") == "FAIL") or shortfall > 0:
        finding_lines.append(f"Quantity shortfall at receiving dock: {shortfall} units")
        if charge_type == "lost_inbound":
            supporting.append(f"Receiving shortfall logged: {shortfall} unit(s)")
            findings_detail.append(EvidenceFinding(
                id=f"fnd-rcv-qty-{rec_id}",
                source="receiving",
                source_record_id=rec_id,
                finding=f"Quantity shortfall: {shortfall} unit(s)",
                charge_relevance="DIRECTLY_RELEVANT",
                relevance_explanation="Receiving record confirms missing quantity from carrier shipment.",
                classification="SUPPORTS_CLAIM",
                impact="HIGH",
                is_pre_existing=False,
            ))

    # Reflect effective verdict if override downgraded or upgraded
    if effective_v == "FAIL" and state != "FAIL":
        state = "FAIL"
        contradicting.append("Receiving record effective verdict is FAIL (per override)")
    elif effective_v == "UNCERTAIN" and state == "PASS":
        state = "UNCERTAIN"

    if not decision_impact:
        if state == "FAIL":
            decision_impact = "Receiving record identifies pre-existing defect or mismatch that contradicts recovery."
        elif state == "UNCERTAIN":
            decision_impact = "Receiving record contains uncertain condition flags requiring human review."
        elif charge_type in ("inbound_defect_fee", "damaged_in_warehouse"):
            decision_impact = "Receiving evidence shows clean intake — contradicts defect/damage fee."
        else:
            decision_impact = "Receiving evidence provides baseline chain-of-custody verification."

    return EvidenceItem(
        id=f"ev-rcv-{rec_id}",
        source="receiving",
        record_id=rec_id,
        unit_id=unit_id,
        org_id=org_id,
        timestamp=timestamp,
        state=state,
        interpretation=" ".join(finding_lines),
        finding=" ".join(finding_lines),
        supporting=supporting,
        contradicting=contradicting,
        missing=missing,
        decision_impact=decision_impact,
        findings_detail=findings_detail,
        original_checks=checks,
    )


def interpret_prep_record(
    record: dict[str, Any],
    effective_v: str,
    charge_type: str,
) -> EvidenceItem:
    """Interprets Prep (FBA Preparation & Labeling) evidence record (Round 2 src/lib/evidence.ts)."""
    rec_id = record.get("record_id", "PRP-UNKNOWN")
    subject = record.get("subject", {})
    unit_id = subject.get("subject_id") or subject.get("unit_id", "")
    org_id = subject.get("org_id", "")
    timestamp = record.get("captured_at") or record.get("produced_at", "")
    checks = record.get("checks", [])

    finding_lines: list[str] = []
    supporting: list[str] = []
    contradicting: list[str] = []
    missing: list[str] = []
    findings_detail: list[EvidenceFinding] = []
    state: EvidenceState = "PASS"
    decision_impact = ""

    # Evaluate Prep checks
    poly_c = _get_check(checks, "polybag")
    suff_c = _get_check(checks, "suffocation_warning")
    lbl_c = _get_check(checks, "fnsku_label") or _get_check(checks, "label")
    bc_c = _get_check(checks, "original_barcode") or _get_check(checks, "barcode")
    hnd_c = _get_check(checks, "handling_marks")

    # 1. Polybag Check
    if poly_c:
        v = poly_c.get("verdict")
        obs = str(poly_c.get("observed", ""))
        if v == "PASS":
            finding_lines.append("Polybag present and sealed as required.")
            supporting.append("Polybag requirement verified compliant")
            findings_detail.append(EvidenceFinding(
                id=f"fnd-prp-poly-{rec_id}",
                source="prep",
                source_record_id=rec_id,
                finding="Polybag present and sealed.",
                charge_relevance="PARTIALLY_RELEVANT" if charge_type == "inbound_defect_fee" else "CONTEXTUAL_ONLY",
                relevance_explanation="Confirms secondary packaging compliance. Does not establish absence of pre-existing unit damage.",
                classification="SUPPORTS_CLAIM",
                impact="MEDIUM",
            ))
        elif v == "FAIL":
            finding_lines.append(f"Polybag defect: {obs or 'non-compliant'}")
            contradicting.append(f"Prep defect — polybag: {obs or 'non-compliant'}")
            state = "FAIL"
            findings_detail.append(EvidenceFinding(
                id=f"fnd-prp-poly-{rec_id}",
                source="prep",
                source_record_id=rec_id,
                finding=f"Polybag defect: {obs or 'non-compliant'}",
                charge_relevance="DIRECTLY_RELEVANT",
                relevance_explanation="Missing or unsealed polybag violates prep requirement and justifies inbound defect fee.",
                classification="CONTRADICTS_CLAIM",
                impact="HIGH",
            ))
        elif v == "UNCERTAIN":
            finding_lines.append("Polybag condition uncertain.")
            missing.append("Clear polybag verification")
            state = "UNCERTAIN"
            findings_detail.append(EvidenceFinding(
                id=f"fnd-prp-poly-{rec_id}",
                source="prep",
                source_record_id=rec_id,
                finding="Polybag inspection uncertain.",
                charge_relevance="DIRECTLY_RELEVANT",
                relevance_explanation="Uncertain polybag inspection flag cannot confirm compliance.",
                classification="UNCERTAIN",
                impact="HIGH",
            ))

    # 2. Suffocation Warning Check
    if suff_c:
        v = suff_c.get("verdict")
        obs = str(suff_c.get("observed", ""))
        if v == "PASS":
            finding_lines.append("Suffocation warning present and legible.")
            supporting.append("Suffocation warning verified compliant")
            findings_detail.append(EvidenceFinding(
                id=f"fnd-prp-suff-{rec_id}",
                source="prep",
                source_record_id=rec_id,
                finding="Suffocation warning present and legible.",
                charge_relevance="PARTIALLY_RELEVANT" if charge_type == "inbound_defect_fee" else "CONTEXTUAL_ONLY",
                relevance_explanation="Safety warning verified. Supports packaging compliance.",
                classification="SUPPORTS_CLAIM",
                impact="MEDIUM",
            ))
        elif v == "FAIL":
            finding_lines.append("Required suffocation warning missing or non-compliant.")
            contradicting.append("Missing suffocation warning on polybag")
            state = "FAIL"
            findings_detail.append(EvidenceFinding(
                id=f"fnd-prp-suff-{rec_id}",
                source="prep",
                source_record_id=rec_id,
                finding="Suffocation warning missing.",
                charge_relevance="DIRECTLY_RELEVANT",
                relevance_explanation="Safety warning defect directly justifies inbound defect charge.",
                classification="CONTRADICTS_CLAIM",
                impact="HIGH",
            ))
        elif v == "UNCERTAIN":
            finding_lines.append(f"Suffocation warning uncertain ({obs}).")
            missing.append("Legible suffocation warning view")
            state = "FAIL" if state == "FAIL" else "UNCERTAIN"
            findings_detail.append(EvidenceFinding(
                id=f"fnd-prp-suff-{rec_id}",
                source="prep",
                source_record_id=rec_id,
                finding="Suffocation warning obscured or uncertain.",
                charge_relevance="DIRECTLY_RELEVANT",
                relevance_explanation="Obscured warning violates Amazon safety standards.",
                classification="UNCERTAIN",
                impact="HIGH",
            ))

    # 3. Label Check
    if lbl_c:
        v = lbl_c.get("verdict")
        obs = str(lbl_c.get("observed", ""))
        if v == "PASS":
            finding_lines.append("FNSKU label placed compliant.")
            supporting.append("FNSKU label placement verified compliant")
            findings_detail.append(EvidenceFinding(
                id=f"fnd-prp-lbl-{rec_id}",
                source="prep",
                source_record_id=rec_id,
                finding=f"FNSKU label placed: {obs or 'compliant'}",
                charge_relevance="PARTIALLY_RELEVANT" if charge_type == "inbound_defect_fee" else "CONTEXTUAL_ONLY",
                relevance_explanation="Verifies FNSKU label was affixed. Supports packaging compliance.",
                classification="SUPPORTS_CLAIM",
                impact="MEDIUM",
            ))
        elif v == "FAIL":
            finding_lines.append("FNSKU label missing or misplaced.")
            contradicting.append("Missing or misplaced FNSKU label at prep")
            state = "FAIL"
            findings_detail.append(EvidenceFinding(
                id=f"fnd-prp-lbl-{rec_id}",
                source="prep",
                source_record_id=rec_id,
                finding="FNSKU label missing or misplaced.",
                charge_relevance="DIRECTLY_RELEVANT",
                relevance_explanation="Missing product identification label directly justifies defect fee.",
                classification="CONTRADICTS_CLAIM",
                impact="HIGH",
            ))
        elif v == "UNCERTAIN":
            finding_lines.append("FNSKU label placement uncertain.")
            missing.append("Clear FNSKU label verification")
            state = "FAIL" if state == "FAIL" else "UNCERTAIN"
            findings_detail.append(EvidenceFinding(
                id=f"fnd-prp-lbl-{rec_id}",
                source="prep",
                source_record_id=rec_id,
                finding="FNSKU label placement uncertain.",
                charge_relevance="DIRECTLY_RELEVANT",
                relevance_explanation="Uncertain label placement requires human inspection review.",
                classification="UNCERTAIN",
                impact="HIGH",
            ))

    # 4. Original Barcode Check
    if bc_c:
        v = bc_c.get("verdict")
        obs = str(bc_c.get("observed", ""))
        if v == "PASS":
            finding_lines.append("Original barcode covered.")
            supporting.append("Original barcode properly covered")
        elif v == "FAIL":
            finding_lines.append("Original manufacturer barcode not covered.")
            contradicting.append("Original barcode exposed (risk of mis-scan at FC)")
            state = "FAIL"
            findings_detail.append(EvidenceFinding(
                id=f"fnd-prp-bc-{rec_id}",
                source="prep",
                source_record_id=rec_id,
                finding="Original barcode not covered.",
                charge_relevance="DIRECTLY_RELEVANT",
                relevance_explanation="Uncovered barcode creates scanning errors at fulfillment center.",
                classification="CONTRADICTS_CLAIM",
                impact="HIGH",
            ))
        elif v == "UNCERTAIN":
            finding_lines.append("Original barcode coverage uncertain.")
            missing.append("Barcode coverage verification")
            state = "FAIL" if state == "FAIL" else "UNCERTAIN"

    # 5. Handling marks
    if hnd_c and hnd_c.get("verdict") == "FAIL":
        contradicting.append("Missing required handling marks")

    # Override takes precedence
    if effective_v == "FAIL":
        state = "FAIL"
        finding_lines.append("Prep evidence shows defect / non-compliance (effective verdict FAIL).")
        contradicting.append("Prep effective verdict is FAIL")
        findings_detail.append(EvidenceFinding(
            id=f"fnd-prp-eff-{rec_id}",
            source="prep",
            source_record_id=rec_id,
            finding="Prep evidence shows defect / non-compliance.",
            charge_relevance="DIRECTLY_RELEVANT",
            relevance_explanation="Prep inspection records or override show unit non-compliant with inbound prep requirements.",
            classification="CONTRADICTS_CLAIM",
            impact="HIGH",
        ))
    elif effective_v == "UNCERTAIN" and state == "PASS":
        state = "UNCERTAIN"
        missing.append("Prep effective verdict is UNCERTAIN")

    if not decision_impact:
        if state == "FAIL":
            decision_impact = "Prep non-compliance found — inbound defect fee may be justified."
        elif state == "UNCERTAIN":
            decision_impact = "Prep inspection flags uncertain — manual review required."
        else:
            decision_impact = "Packaging compliance verified. Note: prep compliance verifies packaging only, not absence of pre-existing unit damage."

    return EvidenceItem(
        id=f"ev-prp-{rec_id}",
        source="prep",
        record_id=rec_id,
        unit_id=unit_id,
        org_id=org_id,
        timestamp=timestamp,
        state=state,
        interpretation=" ".join(finding_lines) if finding_lines else f"Prep inspection verdict: {effective_v}",
        finding=" ".join(finding_lines) if finding_lines else f"Prep verdict {effective_v}",
        supporting=supporting,
        contradicting=contradicting,
        missing=missing,
        decision_impact=decision_impact,
        findings_detail=findings_detail,
        original_checks=checks,
    )


def interpret_pack_record(
    record: dict[str, Any],
    effective_v: str,
    charge_type: str,
) -> EvidenceItem:
    """Interprets Pack (Outbound Fulfillment) evidence record (Round 2 src/lib/evidence.ts)."""
    rec_id = record.get("record_id", "PCK-UNKNOWN")
    subject = record.get("subject", {})
    unit_id = subject.get("subject_id") or subject.get("unit_id", "")
    org_id = subject.get("org_id", "")
    timestamp = record.get("captured_at") or record.get("produced_at", "")
    checks = record.get("checks", [])

    finding_lines: list[str] = []
    supporting: list[str] = []
    contradicting: list[str] = []
    missing: list[str] = []
    findings_detail: list[EvidenceFinding] = []
    state: EvidenceState = "PASS"

    if effective_v == "PASS":
        finding_lines.append("Pack station sealed the box — contents matched.")
        supporting.append("Pack station verified box contents and sealed order")
        findings_detail.append(EvidenceFinding(
            id=f"fnd-pck-vdt-{rec_id}",
            source="pack",
            source_record_id=rec_id,
            finding="Pack operator verdict: seal.",
            charge_relevance="DIRECTLY_RELEVANT" if charge_type == "refund_issued_item_not_returned" else "CONTEXTUAL_ONLY",
            relevance_explanation="Confirms unit was packed and dispatched for outbound delivery.",
            classification="SUPPORTS_CLAIM",
            impact="MEDIUM",
        ))
    elif effective_v == "FAIL":
        finding_lines.append("Pack station flagged issue — stop_and_fix.")
        contradicting.append("Pack verification caught a packing error (stop_and_fix)")
        state = "FAIL"
        findings_detail.append(EvidenceFinding(
            id=f"fnd-pck-vdt-{rec_id}",
            source="pack",
            source_record_id=rec_id,
            finding="Pack operator flagged stop_and_fix issue.",
            charge_relevance="DIRECTLY_RELEVANT",
            relevance_explanation="Pack station caught an operational packaging discrepancy.",
            classification="CONTRADICTS_CLAIM",
            impact="HIGH",
        ))
    else:
        state = "UNCERTAIN"
        missing.append("Pack verification uncertain")

    decision_impact = (
        "Pack evidence confirms what was shipped — relevant for return verification."
        if charge_type == "refund_issued_item_not_returned"
        else "Pack evidence provides downstream chain-of-custody context."
    )

    return EvidenceItem(
        id=f"ev-pck-{rec_id}",
        source="pack",
        record_id=rec_id,
        unit_id=unit_id,
        org_id=org_id,
        timestamp=timestamp,
        state=state,
        interpretation=" ".join(finding_lines),
        finding=" ".join(finding_lines),
        supporting=supporting,
        contradicting=contradicting,
        missing=missing,
        decision_impact=decision_impact,
        findings_detail=findings_detail,
        original_checks=checks,
    )


def interpret_returns_record(
    record: dict[str, Any],
    effective_v: str,
    charge_type: str,
) -> EvidenceItem:
    """Interprets Returns (Reverse Logistics) evidence record (Round 2 src/lib/evidence.ts)."""
    rec_id = record.get("record_id", "RTN-UNKNOWN")
    subject = record.get("subject", {})
    unit_id = subject.get("subject_id") or subject.get("unit_id", "")
    org_id = subject.get("org_id", "")
    timestamp = record.get("captured_at") or record.get("produced_at", "")
    checks = record.get("checks", [])
    payload = record.get("payload", {})

    finding_lines: list[str] = []
    supporting: list[str] = []
    contradicting: list[str] = []
    missing: list[str] = []
    findings_detail: list[EvidenceFinding] = []
    state: EvidenceState = "PASS"

    id_check = _get_check(checks, "identity_match")
    id_verdict = id_check.get("verdict") if id_check else None

    # Returns record shows item came back
    if effective_v == "PASS" or (id_verdict == "PASS"):
        finding_lines.append("Returned item identity confirmed.")
        supporting.append("Return intake confirmed item identity match")
        findings_detail.append(EvidenceFinding(
            id=f"fnd-rtn-id-{rec_id}",
            source="returns",
            source_record_id=rec_id,
            finding="Returned item identity confirmed.",
            charge_relevance="DIRECTLY_RELEVANT",
            relevance_explanation="Physical proof that the customer returned the exact item.",
            classification="SUPPORTS_CLAIM",
            impact="HIGH",
        ))
    elif effective_v == "FAIL" or id_verdict == "FAIL":
        finding_lines.append("Return identity mismatch or defect.")
        contradicting.append("Identity mismatch or defect on return")
        state = "FAIL"
        findings_detail.append(EvidenceFinding(
            id=f"fnd-rtn-id-{rec_id}",
            source="returns",
            source_record_id=rec_id,
            finding="Return identity mismatch.",
            charge_relevance="DIRECTLY_RELEVANT",
            relevance_explanation="Item returned does not match customer order.",
            classification="CONTRADICTS_CLAIM",
            impact="HIGH",
        ))
    else:
        state = "UNCERTAIN"
        missing.append("Return condition uncertain")

    decision_impact = (
        "Return record exists — item was returned, directly contradicting the charge."
        if charge_type == "refund_issued_item_not_returned"
        else "Return evidence provides unit condition context."
    )

    return EvidenceItem(
        id=f"ev-rtn-{rec_id}",
        source="returns",
        record_id=rec_id,
        unit_id=unit_id,
        org_id=org_id,
        timestamp=timestamp,
        state=state,
        interpretation=" ".join(finding_lines),
        finding=" ".join(finding_lines),
        supporting=supporting,
        contradicting=contradicting,
        missing=missing,
        decision_impact=decision_impact,
        findings_detail=findings_detail,
        original_checks=checks,
    )


def extract_evidence_items(
    request: dict[str, Any],
    charge_type: str,
) -> list[EvidenceItem]:
    """Extracts all upstream evidence items from request['previous_evidence'], applying overrides."""
    items: list[EvidenceItem] = []
    prev_list = request.get("previous_evidence", [])

    for rec in prev_list:
        stage = rec.get("stage")
        eff_v = effective_verdict(request, rec)

        if stage == "receiving":
            items.append(interpret_receiving_record(rec, eff_v, charge_type))
        elif stage == "prep":
            items.append(interpret_prep_record(rec, eff_v, charge_type))
        elif stage == "pack":
            items.append(interpret_pack_record(rec, eff_v, charge_type))
        elif stage == "returns":
            items.append(interpret_returns_record(rec, eff_v, charge_type))

    # Sort by timestamp
    items.sort(key=lambda x: x.timestamp or "")
    return items
