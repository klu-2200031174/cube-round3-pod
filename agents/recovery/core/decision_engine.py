"""RECOVER Decision Engine.

Conservative, precision-first recovery decision logic ported from Keerthan's Round 2
decision engine (src/lib/decision-engine.ts). Implements cross-stage causal precedence,
pre-existing condition detection, and strict condition-relevance matching across
upstream operational stages.
"""
from __future__ import annotations

from typing import Any

from .types import (
    ChargeAnalysis,
    ChargeRecord,
    EvidenceFinding,
    EvidenceItem,
    FailureMode,
    MatchStrategy,
    Position,
    RecoveryDecision,
)

RECOVERABLE_CHARGE_TYPES = {
    "inbound_defect_fee",
    "lost_inbound",
    "damaged_in_warehouse",
    "refund_issued_item_not_returned",
}

NON_RECOVERABLE_CHARGE_TYPES = {
    "fulfilment_fee_weight_tier",
}


def determine_match_strategy(
    charge: ChargeRecord,
    evidence: list[EvidenceItem],
) -> tuple[MatchStrategy, str, str]:
    """Determines matching strategy and confidence based on upstream evidence presence."""
    if not charge.unit_id:
        return "unmatched", "none", "No unit_id present on the charge record."

    matched_by_unit = any(e.unit_id == charge.unit_id for e in evidence)
    if matched_by_unit:
        return (
            "unit_id_exact",
            "high",
            f"unit_id {charge.unit_id} found in upstream operational evidence.",
        )

    if charge.order_id:
        matched_by_order = any(e.source in ("pack", "returns") for e in evidence)
        if matched_by_order:
            return (
                "order_id_asin",
                "medium",
                f"Matched via order_id {charge.order_id}.",
            )

    if evidence:
        return (
            "partial_match",
            "medium",
            "Upstream evidence available for workflow context.",
        )

    return "unmatched", "none", "No reliable upstream identity found for this charge."


def decide_inbound_defect(
    charge: ChargeRecord,
    evidence: list[EvidenceItem],
    findings: list[EvidenceFinding],
    failure_modes: list[FailureMode],
) -> tuple[Position, RecoveryDecision, str, float, list[str]]:
    """Evaluates inbound_defect_fee with Round 2 causal precedence & pre-existing defect rules."""
    rcv_ev = [e for e in evidence if e.source == "receiving"]
    prep_ev = [e for e in evidence if e.source == "prep"]

    # Rule A: Missing critical receiving intake evidence
    if not rcv_ev:
        failure_modes.append("missing_upstream_evidence")
        return (
            "SILENT",
            "REVIEW_REQUIRED",
            "Missing receiving intake record. Cannot establish arrival condition of unit.",
            0.0,
            [],
        )

    # Rule B: Pre-existing Condition Precedence Rule
    # If receiving recorded pre-existing physical damage or obvious defect on arrival,
    # subsequent packaging compliance at prep does NOT negate the intake defect.
    pre_existing_defect = next(
        (
            f for f in findings
            if f.source == "receiving" and f.is_pre_existing
            and f.classification == "CONTRADICTS_CLAIM" and f.impact == "HIGH"
        ),
        None,
    )
    if pre_existing_defect:
        rcv_ids = [e.record_id for e in rcv_ev]
        return (
            "SUPPORTS",
            "NO_CLAIM",
            (
                f"Receiving evidence recorded pre-existing intake defect ({pre_existing_defect.finding}). "
                "Later packaging compliance does not establish that the unit was free from pre-existing receiving damage. "
                "Inbound defect fee is supported by dock arrival condition."
            ),
            0.0,
            rcv_ids,
        )

    # Rule C: Uncertain Receiving Arrival or Identity Condition
    uncertain_rcv = next(
        (f for f in findings if f.source == "receiving" and f.classification in ("UNCERTAIN", "MISSING")),
        None,
    )
    if uncertain_rcv or any(e.state == "UNCERTAIN" for e in rcv_ev):
        failure_modes.append("insufficient_evidence")
        return (
            "SILENT",
            "REVIEW_REQUIRED",
            "Receiving arrival condition or product identity was marked uncertain. Causal origin of defect cannot be determined without manual inspection.",
            0.0,
            [e.record_id for e in rcv_ev],
        )

    # Rule D: Missing Prep Record
    if not prep_ev:
        failure_modes.append("incomplete_evidence_chain")
        return (
            "SILENT",
            "REVIEW_REQUIRED",
            "Receiving dock intake was clean, but no prep record was found. Cannot verify packaging compliance without prep evidence.",
            0.0,
            [e.record_id for e in rcv_ev],
        )

    # Rule E: Direct Prep Operational Defect (missing polybag, warning, label, or Prep FAIL)
    prep_rec = prep_ev[0]
    direct_prep_defect = next(
        (f for f in findings if f.source == "prep" and f.classification == "CONTRADICTS_CLAIM" and f.impact == "HIGH"),
        None,
    )
    if direct_prep_defect or any(e.state == "FAIL" for e in prep_ev):
        defect_desc = direct_prep_defect.finding if direct_prep_defect else "packaging defect"
        return (
            "SUPPORTS",
            "NO_CLAIM",
            f"Prep evidence confirms operational non-compliance ({defect_desc}). The inbound defect fee is supported by prep inspection records.",
            0.0,
            [prep_rec.record_id],
        )

    # Rule F: Uncertain Prep Flags
    uncertain_prep = [f for f in findings if f.source == "prep" and f.classification == "UNCERTAIN"]
    if uncertain_prep or any(e.state == "UNCERTAIN" for e in prep_ev):
        failure_modes.append("insufficient_evidence")
        flags = "; ".join(f.finding for f in uncertain_prep) if uncertain_prep else "inspection uncertain"
        return (
            "SILENT",
            "REVIEW_REQUIRED",
            f"Prep evidence contains uncertain inspection flags ({flags}). Automatic claim recommendation blocked pending human review.",
            0.0,
            [prep_rec.record_id],
        )

    # Rule G: Clean Receiving + Clean Prep Compliance -> Confident Claim Recommended
    rcv_clean = all(e.state == "PASS" for e in rcv_ev)
    prep_clean = all(e.state == "PASS" for e in prep_ev)

    if rcv_clean and prep_clean:
        contributing_ids = [prep_rec.record_id] + [e.record_id for e in rcv_ev]
        return (
            "CONTRADICTS",
            "CLAIM_RECOMMENDED",
            "Receiving evidence verifies unit arrived without damage, and prep evidence verifies full compliance with all packaging and labeling requirements. Available upstream records contradict the defect fee.",
            charge.amount_usd,
            contributing_ids,
        )

    failure_modes.append("insufficient_evidence")
    return (
        "SILENT",
        "REVIEW_REQUIRED",
        "Insufficient clear evidence across receiving and prep to make an automated recovery recommendation.",
        0.0,
        [e.record_id for e in evidence],
    )


def decide_lost_inbound(
    charge: ChargeRecord,
    evidence: list[EvidenceItem],
    findings: list[EvidenceFinding],
    failure_modes: list[FailureMode],
) -> tuple[Position, RecoveryDecision, str, float, list[str]]:
    """Evaluates lost_inbound charges against dock receiving custody."""
    rcv_ev = [e for e in evidence if e.source == "receiving"]

    if not rcv_ev:
        failure_modes.append("missing_upstream_evidence")
        return (
            "SILENT",
            "REVIEW_REQUIRED",
            "No receiving record found to confirm whether unit was received before being marked lost.",
            0.0,
            [],
        )

    # Receiving arrival condition damaged or uncertain
    if any(e.state in ("UNCERTAIN", "FAIL") for e in rcv_ev):
        failure_modes.append("insufficient_evidence")
        return (
            "SILENT",
            "REVIEW_REQUIRED",
            "Receiving arrival condition was uncertain or damaged prior to loss; requires human review to verify inventory receipt status.",
            0.0,
            [e.record_id for e in rcv_ev],
        )

    # Clean receiving receipt confirms unit was safely accepted at warehouse
    if all(e.state == "PASS" for e in rcv_ev):
        return (
            "CONTRADICTS",
            "CLAIM_RECOMMENDED",
            "Receiving evidence confirms the unit was successfully received into the warehouse. Channel inventory adjustment marks unit as lost. Reimbursement claim supported.",
            charge.amount_usd,
            [e.record_id for e in rcv_ev],
        )

    return (
        "SILENT",
        "REVIEW_REQUIRED",
        "Uncertain receiving status for lost inbound unit.",
        0.0,
        [e.record_id for e in rcv_ev],
    )


def decide_damaged_in_warehouse(
    charge: ChargeRecord,
    evidence: list[EvidenceItem],
    findings: list[EvidenceFinding],
    failure_modes: list[FailureMode],
) -> tuple[Position, RecoveryDecision, str, float, list[str]]:
    """Evaluates damaged_in_warehouse against dock intake condition."""
    # Pre-existing condition rule: if unit arrived damaged at dock, damage wasn't internal warehouse
    pre_existing_defect = next(
        (
            f for f in findings
            if f.source == "receiving" and f.is_pre_existing
            and f.classification == "CONTRADICTS_CLAIM" and f.impact == "HIGH"
        ),
        None,
    )
    if pre_existing_defect:
        rcv_ids = [e.record_id for e in evidence if e.source == "receiving"]
        return (
            "SUPPORTS",
            "NO_CLAIM",
            f"Receiving record shows damage pre-existed warehouse custody ({pre_existing_defect.finding}). Defect cannot be attributed to internal warehouse operations.",
            0.0,
            rcv_ids,
        )

    rcv_ev = [e for e in evidence if e.source == "receiving"]
    if not rcv_ev:
        failure_modes.append("missing_upstream_evidence")
        return (
            "SILENT",
            "REVIEW_REQUIRED",
            "No receiving record found to establish baseline condition prior to warehouse damage.",
            0.0,
            [],
        )

    if any(e.state == "UNCERTAIN" for e in rcv_ev):
        failure_modes.append("insufficient_evidence")
        return (
            "SILENT",
            "REVIEW_REQUIRED",
            "Receiving intake condition is uncertain. Cannot confirm whether damage occurred during inbound transit or warehouse storage.",
            0.0,
            [e.record_id for e in rcv_ev],
        )

    if all(e.state == "PASS" for e in rcv_ev):
        return (
            "CONTRADICTS",
            "CLAIM_RECOMMENDED",
            "Receiving evidence confirms the unit arrived undamaged at the dock. Damage occurred subsequently while in channel warehouse custody. Reimbursement claim supported.",
            charge.amount_usd,
            [e.record_id for e in rcv_ev],
        )

    return (
        "SILENT",
        "REVIEW_REQUIRED",
        "Insufficient evidence to determine causality for warehouse damage.",
        0.0,
        [e.record_id for e in rcv_ev],
    )


def decide_refund_not_returned(
    charge: ChargeRecord,
    evidence: list[EvidenceItem],
    findings: list[EvidenceFinding],
    failure_modes: list[FailureMode],
) -> tuple[Position, RecoveryDecision, str, float, list[str]]:
    """Evaluates refund_issued_item_not_returned against returns and pack records."""
    rtn_ev = [e for e in evidence if e.source == "returns"]

    if rtn_ev and any(e.state == "PASS" for e in rtn_ev):
        return (
            "CONTRADICTS",
            "CLAIM_RECOMMENDED",
            "Returns intake evidence confirms the physical item was returned into warehouse inventory. Channel charge for 'refund issued, item not returned' is directly refuted. Reimbursement recommended.",
            charge.amount_usd,
            [e.record_id for e in rtn_ev],
        )

    pack_ev = [e for e in evidence if e.source == "pack"]
    if pack_ev:
        failure_modes.append("incomplete_evidence_chain")
        return (
            "SILENT",
            "REVIEW_REQUIRED",
            "Outbound pack station confirms shipment, but no reverse logistics return record was found. Cannot determine if customer returned the product without returns evidence.",
            0.0,
            [e.record_id for e in pack_ev],
        )

    failure_modes.append("missing_upstream_evidence")
    return (
        "SILENT",
        "REVIEW_REQUIRED",
        "No return or outbound pack records found for this order. Insufficient data to verify return status.",
        0.0,
        [],
    )


def analyze_charge(
    charge: ChargeRecord,
    evidence: list[EvidenceItem],
) -> ChargeAnalysis:
    """Performs full conservative, precision-first recovery analysis on a single fee line."""
    strategy, confidence, explanation = determine_match_strategy(charge, evidence)
    findings = [f for e in evidence for f in e.findings_detail]
    failure_modes: list[FailureMode] = []

    # 1. Zero or negative amount check (Round 3 Finding F-09 / Round 2 rule)
    if charge.amount_usd <= 0:
        return ChargeAnalysis(
            charge=charge,
            match_strategy=strategy,
            match_confidence=confidence,
            match_explanation=explanation,
            evidence=evidence,
            evidence_findings=findings,
            position="SILENT",
            decision="NO_CLAIM",
            reasoning="amount is 0.00: nothing to claim, or the amount is missing (finding F-09)",
            claim_amount=0.0,
            evidence_record_ids=[],
            failure_modes=[],
        )

    # 2. Standard fulfilment fee weight tier (Round 3 Finding F-07 / Round 2 rule)
    if charge.charge_type in NON_RECOVERABLE_CHARGE_TYPES:
        return ChargeAnalysis(
            charge=charge,
            match_strategy=strategy,
            match_confidence=confidence,
            match_explanation=explanation,
            evidence=evidence,
            evidence_findings=findings,
            position="SILENT",
            decision="NO_CLAIM",
            reasoning=f'Charge type "{charge.charge_type}" is a standard fulfilment fee. Recovery requires evidence of a weight/tier measurement error, which upstream operational evidence does not cover (finding F-07).',
            claim_amount=0.0,
            evidence_record_ids=[],
            failure_modes=[],
        )

    # 3. Unmatched check
    if strategy == "unmatched":
        failure_modes.append("missing_upstream_evidence")
        return ChargeAnalysis(
            charge=charge,
            match_strategy=strategy,
            match_confidence=confidence,
            match_explanation=explanation,
            evidence=evidence,
            evidence_findings=findings,
            position="SILENT",
            decision="REVIEW_REQUIRED",
            reasoning="No upstream evidence found for this unit. Cannot assess recovery without evidence.",
            claim_amount=0.0,
            evidence_record_ids=[],
            failure_modes=failure_modes,
        )

    # 4. Unknown / Unsupported charge type
    if charge.charge_type not in RECOVERABLE_CHARGE_TYPES:
        failure_modes.append("unsupported_charge_type")
        return ChargeAnalysis(
            charge=charge,
            match_strategy=strategy,
            match_confidence=confidence,
            match_explanation=explanation,
            evidence=evidence,
            evidence_findings=findings,
            position="SILENT",
            decision="REVIEW_REQUIRED",
            reasoning=f'Unknown charge type "{charge.charge_type}". Cannot determine recovery eligibility without known rules.',
            claim_amount=0.0,
            evidence_record_ids=[],
            failure_modes=failure_modes,
        )

    # 5. Empty evidence
    if not evidence:
        failure_modes.append("missing_upstream_evidence")
        return ChargeAnalysis(
            charge=charge,
            match_strategy=strategy,
            match_confidence=confidence,
            match_explanation=explanation,
            evidence=evidence,
            evidence_findings=findings,
            position="SILENT",
            decision="REVIEW_REQUIRED",
            reasoning="Unit matched but no upstream evidence records found. Insufficient evidence to support or refute the charge.",
            claim_amount=0.0,
            evidence_record_ids=[],
            failure_modes=failure_modes,
        )

    # 6. Charge-specific decision rules
    if charge.charge_type == "inbound_defect_fee":
        pos, dec, reason, claim_amt, ids = decide_inbound_defect(
            charge, evidence, findings, failure_modes
        )
    elif charge.charge_type == "lost_inbound":
        pos, dec, reason, claim_amt, ids = decide_lost_inbound(
            charge, evidence, findings, failure_modes
        )
    elif charge.charge_type == "damaged_in_warehouse":
        pos, dec, reason, claim_amt, ids = decide_damaged_in_warehouse(
            charge, evidence, findings, failure_modes
        )
    elif charge.charge_type == "refund_issued_item_not_returned":
        pos, dec, reason, claim_amt, ids = decide_refund_not_returned(
            charge, evidence, findings, failure_modes
        )
    else:
        failure_modes.append("unsupported_charge_type")
        pos, dec, reason, claim_amt, ids = (
            "SILENT",
            "REVIEW_REQUIRED",
            f'No decision rule for charge type "{charge.charge_type}".',
            0.0,
            [],
        )

    return ChargeAnalysis(
        charge=charge,
        match_strategy=strategy,
        match_confidence=confidence,
        match_explanation=explanation,
        evidence=evidence,
        evidence_findings=findings,
        position=pos,
        decision=dec,
        reasoning=reason,
        claim_amount=claim_amt,
        evidence_record_ids=ids,
        failure_modes=failure_modes,
    )
