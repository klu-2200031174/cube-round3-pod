# agents/returns/  ·  Returns Manager

**Owner:** Aashritha Jammula ([@klu-2200031174](https://github.com/klu-2200031174)) · **Origin:** Round 2 Returns Manager, see [`PROVENANCE.md`](PROVENANCE.md)

This is the real Returns Manager, not the organiser stub. It inspects photos of a returned item and decides what happens to it, with every verdict tied to the photo it came from.

| | |
|---|---|
| **Reads (inputs)** | Return photos from `data/input/<unit>/returns/` (JPEG / PNG / WebP, up to 8), each verified against the `sha256` the orchestrator recorded |
| **Reads (previous evidence)** | **Pack** (what was sealed into the box), when the unit has it |
| **Reference data** | Order for the unit (`data/sample/returns_sample.csv` + `reference/demo_orders.csv`), catalogue parts list and look-alikes (`reference/catalogue.json`), Amazon's published condition scale (`reference/condition_scale.json`), disposition rule table (`reference/disposition_rules.json`) |
| **Produces** | `image_quality`, `identity_match`, `completeness`, `condition`, and `matches_pack_record` when Pack evidence exists |
| **`decision.outcome`** | `restock`, `refurbish`, `liquidate`, `dispose`, `pending_review` |
| **Model** | Gemini (one batched vision call per unit, temperature 0, JSON schema output); fallback models when the primary is overloaded |

## How a decision is made

```text
photos ──► 1 vision call: the model only REPORTS what it sees (product, parts, damage, grade proposal) with image_index evidence
       ──► deterministic checks (returns_agent/checks.py): evidence must cite a usable photo, or the check is UNCERTAIN
       ──► ordered rule table (returns_agent/rules.py, R01…R99): first match wins → disposition + rule_id
       ──► Pack cross-check: is what came back what was shipped?
       ──► Evidence Record (shared contract)
```

- **The model never decides.** It describes; fixed rules decide. Same observations in, same disposition out.
- **No guessing.** No photo, an unusable photo, low confidence, or a part that cannot be seen gives `UNCERTAIN` (with an `uncertain_reason`) and `pending_review`, never a silent PASS.
- **Condition** uses Amazon's published grades only (New, Used - Like New, Used - Very Good, Used - Good, Used - Acceptable, Unacceptable).
- **Hygiene items** (cosmetics, wired earphones, combs) are disposed unless factory-sealed or New (rule R08).

## Pack cross-check (`matches_pack_record`)

Only added when Pack evidence exists and the returned item's identity is decided. Uses the **latest override** of the Pack record.

| What came back | Pack sealed | Check | Meaning |
|---|---|---|---|
| The ordered SKU | The ordered SKU | PASS | Consistent |
| A different item | The ordered SKU | **FAIL**, `needs_human` | Suspected swap / wrong-item return: a person reviews before any refund or claim |
| A different item | That same different item | PASS | Packing error upstream, not the customer |
| The ordered SKU | Something else | UNCERTAIN (`conflicting_evidence`) | The two records disagree |

## Failure behaviour

| Situation | What the agent returns |
|---|---|
| Model down / overloaded / no API key | `status: pending`, `UNCERTAIN`, `error.code: model_error` (retryable), the photos still listed in `inputs` with their hashes. Next step: `retry`. |
| No photos captured | `completed`, `UNCERTAIN`, `pending_review`, 0 model calls |
| Photo bytes do not match the recorded `sha256` | That photo is not used; the problem is listed in `payload.input_problems` |
| Unit belongs to another org, or is unknown | `LookupError` → HTTP 404 / `agent_rejected`. Never answered. |
| Same `request_id` twice | Same `record_id` |

## Run

```sh
# in-process (default): the orchestrator imports agents.returns.app
make case UNIT=UNIT-0003 ORG=org_demo_bravo

# as its own service
.venv/bin/uvicorn agents.returns.app:app --port 8104
curl localhost:8104/health
```

Set `GEMINI_API_KEY` in the repo's `.env` (git-ignored) to inspect photos. Optional: `GEMINI_MODEL`, `GEMINI_FALLBACK_MODELS`, `MODEL_TIMEOUT_S` (default 20), `MODEL_BUDGET_S` (default 25, kept inside the stage's 30 s budget).

## Tests

`tests/integration/test_returns_agent.py` runs the agent on its own fixtures: recorded Gemini answers for real return photos (correct item, wrong item), the Pack hand-off (match and suspected swap), model failure, no photos, a tampered photo, tenancy and idempotency. No API key needed.

The shared contract tests (`tests/integration/test_agent_contracts.py`) also run it on every returned sample unit.

## Limits

- The Round 2 sample has **no photos**, so every sample returned unit is honestly `UNCERTAIN` / `pending_review` until real captures are added in `data/input/<unit>/returns/`.
- Identity is visual only (no barcode decoding). Look-alikes that differ only in unreadable text come out `UNCERTAIN`.
- Condition is judged from the outside; function is not tested.
- `matches_pack_record` depends on Pack listing the SKUs it sealed (`items_present.observed`). If Pack's record does not say, the check is left out and the reason is in `payload.pack_cross_check`.
- `cost_usd` is not computed (left `null`).
