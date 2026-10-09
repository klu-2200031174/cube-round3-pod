"""RECOVER Recovery Manager · Core Type Definitions (Python Port).

Derived from Keerthan's Round 2 Recovery Manager (src/lib/types.ts).
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

# --- Evidence States (from organizer spec) ---
EvidenceState = Literal["PASS", "FAIL", "UNCERTAIN"]

# --- Recovery Decision States (Round 2 core decisions) ---
RecoveryDecision = Literal["CLAIM_RECOMMENDED", "REVIEW_REQUIRED", "NO_CLAIM"]

# --- Position on Fee Line (Round 3 / Round 2 mapping) ---
# CONTRADICTS -> refutes charge -> claim recommended (verdict FAIL)
# SUPPORTS    -> justifies charge -> no claim (verdict PASS)
# SILENT      -> absent / insufficient -> cannot claim (verdict UNCERTAIN)
Position = Literal["CONTRADICTS", "SUPPORTS", "SILENT"]

# --- Match Strategy ---
MatchStrategy = Literal[
    "unit_id_exact",
    "order_id_asin",
    "asin_shipment",
    "sku_date_proximity",
    "partial_match",
    "unmatched",
]

# --- Failure Modes ---
FailureMode = Literal[
    "missing_unit_identifier",
    "ambiguous_unit_match",
    "missing_upstream_evidence",
    "contradictory_upstream_evidence",
    "unsupported_charge_type",
    "malformed_charge_record",
    "incomplete_evidence_chain",
    "insufficient_evidence",
    "model_dependency_failure",
    "duplicate_charge",
]

# --- Finding Classification & Relevance ---
FindingRelevance = Literal["DIRECTLY_RELEVANT", "PARTIALLY_RELEVANT", "CONTEXTUAL_ONLY"]
FindingImpact = Literal["HIGH", "MEDIUM", "LOW"]
FindingClassification = Literal["SUPPORTS_CLAIM", "CONTRADICTS_CLAIM", "UNCERTAIN", "MISSING"]


@dataclass
class EvidenceFinding:
    id: str
    source: Literal["receiving", "prep", "pack", "returns"]
    source_record_id: str
    finding: str
    charge_relevance: FindingRelevance
    relevance_explanation: str
    classification: FindingClassification
    impact: FindingImpact
    is_pre_existing: bool = False


@dataclass
class EvidenceItem:
    id: str
    source: Literal["receiving", "prep", "pack", "returns"]
    record_id: str
    unit_id: str
    org_id: str
    timestamp: str
    state: EvidenceState
    interpretation: str
    finding: str
    supporting: list[str] = field(default_factory=list)
    contradicting: list[str] = field(default_factory=list)
    missing: list[str] = field(default_factory=list)
    decision_impact: str = ""
    findings_detail: list[EvidenceFinding] = field(default_factory=list)
    original_checks: list[dict[str, Any]] = field(default_factory=list)


@dataclass
class ChargeRecord:
    line_id: str
    report_type: str
    unit_id: str
    org_id: str
    sku: str
    fnsku: str
    fba_shipment_id: str
    order_id: str
    charge_type: str
    quantity: float
    amount_usd: float
    posted_date: str


@dataclass
class ChargeAnalysis:
    charge: ChargeRecord
    match_strategy: MatchStrategy
    match_confidence: str
    match_explanation: str
    evidence: list[EvidenceItem]
    evidence_findings: list[EvidenceFinding]
    position: Position
    decision: RecoveryDecision
    reasoning: str
    claim_amount: float
    evidence_record_ids: list[str]
    failure_modes: list[FailureMode] = field(default_factory=list)
