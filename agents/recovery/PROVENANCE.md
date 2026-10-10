# Provenance: Recovery Manager

## Source Repository
* **Participant**: Keerthan Reddy (Member 5 · Recovery Manager)
* **Round 2 Repository**: [cube26-rcy-0041-keerthanreddy01](https://github.com/Keerthanreddy01/cube26-rcy-0041-keerthanreddy01)
* **Round 2 System**: **RECOVER** (Evidence-First Recovery Intelligence Engine)
* **Round 3 Target**: `agents/recovery/`

---

## Architectural Adaptation

This component is an **integration and adaptation** of the Round 2 Recovery Manager into the Round 3 Pod architecture, strictly preserving the business rules while complying with the official Round 3 Agent Contract.

### Source Files Reused and Adapted
1. `src/lib/decision-engine.ts`:
   - Ported to `agents/recovery/core/decision_engine.py`.
   - Reused rules:
     - Cross-stage causal precedence (Dock intake damage precedence over Prep packaging compliance).
     - Pre-existing condition logic (Receiving dock damage refutes internal warehouse custody liability).
     - Causal decision rules for `inbound_defect_fee`, `lost_inbound`, `damaged_in_warehouse`, and `refund_issued_item_not_returned`.
     - Standard fee exclusions (`fulfilment_fee_weight_tier` non-claimable without measurement data, per Finding F-07).
     - Zero/negative fee line exclusions (Finding F-09).
     - Deterministic decision states: `CLAIM_RECOMMENDED`, `REVIEW_REQUIRED`, `NO_CLAIM`.
2. `src/lib/evidence.ts`:
   - Ported to `agents/recovery/core/evidence_adapter.py`.
   - Reused semantic interpretation across Receiving, Prep, Pack, and Returns checks.
   - Preserved `EvidenceFinding` extraction with classification and impact.
3. `src/lib/types.ts`:
   - Ported to `agents/recovery/core/types.py`.
   - Retained core domain types: `EvidenceState`, `RecoveryDecision`, `Position`, `FailureMode`, `EvidenceFinding`.

### Non-Reused / Excluded Components
* Frontend UI dashboard (`src/app/page.tsx`, `globals.css`, `layout.tsx`).
* Next.js route handlers and mock upstream endpoints (`src/app/api/**`).
* Client state management (`src/lib/store.ts`).
* Node.js build configurations (`package.json`, `tsconfig.json`, `next.config.ts`, `vercel.json`).
