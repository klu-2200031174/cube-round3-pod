# agents/receiving/  ·  Receiving Manager

**Owner:** [@Bhargav200](https://github.com/Bhargav200). **Real agent, not a stub:** the Round 2 Receiving Manager, copied unchanged into `round2/` and connected through a thin adapter. Origin: [PROVENANCE.md](PROVENANCE.md).

| | |
|---|---|
| **Reads (inputs)** | Photos at the point of receipt, `data/input/<unit>/receiving/` (`pallet`, `carton`, `unit`, `label` in the file name set the role), and the PO line for the unit (`data/sample/receiving_sample.csv`, scoped by `org_id`) |
| **Reads (previous evidence)** | nothing: first in the chain |
| **Produces** | 9 checks: `identity_match`, `variant_colour`, `carton_count`, `units_per_carton`, `quantity`, `carton_damage`, `unit_damage`, `components`, `quality_flags` |
| **`decision.outcome`** | `accept` (all PASS), `accept_with_exceptions` (a FAIL), `reject` (identity FAIL), `pending_review` (UNCERTAIN, no photos, or model failure) |
| **Model** | Gemini 3.5 Flash-Lite, **one call per unit**, **blind to the PO** (prompt `rcv-prompt/0.2-blind`) |

## How it decides

1. All photos of the unit are stitched into one labelled contact sheet and sent in **one** model call. The model only *describes* what it sees; it is never shown the PO (Round 2 finding: shown the PO, it echoed it back).
2. Deterministic code compares that description with the PO line. Every verdict has a one-line reason, the photo it is based on and a confidence from a fixed rule (two sources agree / one source / a weak source).
3. **UNCERTAIN is a real answer.** A poor photo, conflicting counts, only packaging visible, or "no damage" on something not in the photo all give UNCERTAIN, never PASS.
4. **Fail open.** No photos: all 9 checks UNCERTAIN and `needs_human`. Model error or timeout: a `pending` record with the error, never a guess. Wrong `org_id`: refused (404).

## Run

```sh
cd agents/receiving/round2 && npm ci && cd ../../..     # once; needs Node 20+
# GEMINI_API_KEY=... in .env (never commit it)
python -m orchestration.run --unit UNIT-0007 --org org_demo_alpha
uvicorn agents.receiving.app:app --port 8101            # optional: HTTP mode (GET /health, POST /run)
```

## Demo units with photos

| Unit | PO line | Photo |
|---|---|---|
| UNIT-0007 | USB-C Cable, 4 × 6 | open carton marked QTY 9 |
| UNIT-0014 | LED Desk Lamp, 2 × 12 | open carton with water damage inside |
| UNIT-0001 | Cotton Bath Towel, 1 × 24 | carton with water stain and a hole |

The photos are real deliveries contributed by neighbours who consented to publication. They have no real PO, so these units are expected to raise exceptions.

## Known limits (measured in the Round 2 eval)

- Small punctures in a unit can be missed (F8).
- The carton's colour can be read as the product's colour (F10).
- Model-only counts are low confidence; an operator count (`context.operator_counts`) makes them medium or high.
- Eval: 16 held-out cases from 13 photos. 0 masked failures; carton damage caught 9 of 9 with 0 false alarms. Details are in the Round 2 repo's `eval-report.md`.
