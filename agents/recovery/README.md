# agents/recovery/ · Recovery Manager

**Owner:** Keerthan Reddy (`@Keerthanreddy01` · Member 5 · Recovery Manager)  
**System:** RECOVER (Integrated from Round 2)

---

## 1. Responsibility

Recovery Manager is Step 5 of the 5-stage commerce workflow (`Receiving → Prep | Pack → Returns → Recovery → Final Commerce Outcome`).

* **Camera**: Has no camera.
* **Reads (Inputs)**: Marketplace fee report / deduction lines (`inbound_defect_fee`, `lost_inbound`, `damaged_in_warehouse`, `refund_issued_item_not_returned`, `fulfilment_fee_weight_tier`).
* **Reads (Previous Evidence)**: All accumulated operational evidence records from previous stages (`previous_evidence[]`), including workflow overrides (`context.overrides`).
* **Produces**: An Agent Output enclosing an immutable Evidence Record with per-charge positions (`CONTRADICTS` / `SUPPORTS` / `SILENT`), claimable dollar figures, and explicit explanations for unclaimable fees.

---

## 2. Check Semantics & Decisions

In Recovery, check verdicts test the condition: **"this charge is supported by evidence"**:

| Check Verdict | Position | Meaning | Decision Outcome |
|---|---|---|---|
| `FAIL` | **`CONTRADICTS`** | Operational evidence refutes channel deduction | **`CLAIM_RECOMMENDED`** (attaches `evidence_refs`) |
| `PASS` | **`SUPPORTS`** | Operational evidence justifies channel fee | **`NO_CLAIM`** |
| `UNCERTAIN` | **`SILENT`** | Evidence is absent, insufficient, or ambiguous | **`NO_CLAIM` / `insufficient_evidence`** (never guess) |

A wrongly filed claim damages seller account standing. Therefore, missing or ambiguous evidence is **never** converted into a claim.

---

## 3. Important Causal Rules (Preserved from Round 2)

1. **Pre-Existing Dock Damage Precedence**:
   If Receiving dock recorded pre-existing physical damage (`unit_damage != none` or `carton_damage != none`), subsequent compliant packaging at Prep does **not** erase the dock defect. The inbound defect fee is supported (`NO_CLAIM`).
2. **Clean Receiving + Prep**:
   Clean receiving dock receipt (`PASS`) + compliant prep packaging (`PASS`) directly contradicts an `inbound_defect_fee` (`CLAIM_RECOMMENDED`).
3. **Lost Inbound**:
   Clean dock receiving proves the unit was successfully accepted into warehouse custody, refuting a channel inventory loss adjustment (`CLAIM_RECOMMENDED`).
4. **Damaged in Warehouse**:
   Clean dock receiving proves the unit arrived undamaged, confirming damage occurred subsequently in channel custody (`CLAIM_RECOMMENDED`).
5. **Refund Issued / Item Not Returned**:
   Returns intake record confirming item was received back into inventory refutes this charge (`CLAIM_RECOMMENDED`).
6. **Weight Tier Fees**:
   `fulfilment_fee_weight_tier` requires scale calibration/measurement data. Absent measured dimensions, it is classified as `SILENT` / `NO_CLAIM` (Finding F-07).
7. **Zero / Negative Amounts**:
   Amounts <= $0.00 are classified as `SILENT` / `NO_CLAIM` (Finding F-09).

---

## 4. Interface & Execution

Entry point is `agents.recovery.app:handle(request: dict) -> dict`.

### Run Standalone via HTTP:
```sh
.venv/Scripts/uvicorn agents.recovery.app:app --port 8105
curl http://localhost:8105/health
```

### Run Tests:
```sh
.venv/Scripts/pytest tests/integration/test_recovery_manager.py
.venv/Scripts/pytest tests/integration/test_agent_contracts.py
```
