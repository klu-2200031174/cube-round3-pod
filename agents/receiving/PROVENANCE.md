# Provenance: Receiving Manager

| | |
|---|---|
| **Participant** | A P Bhargav Ravi Teja ([@Bhargav200](https://github.com/Bhargav200)), Receiving Manager |
| **Round 2 repository** | [Bhargav200/cube26-rcv-0263-https-github.com-bhargav200](https://github.com/Bhargav200/cube26-rcv-0263-https-github.com-bhargav200) |
| **Source folder** | `submissions/Bhargav200/agent/` |
| **Source commit** | `ec8fd82` (main, final Round 2 state). Its `agent/` folder is identical to `0398106`; the only later change deleted a file outside `agent/`. |
| **Round 2 deployment** | https://cube26-rcv-0263-https-github-com-bh.vercel.app |

## What was copied, and how

`round2/` is the Round 2 `agent/` folder **copied unchanged** (`git archive` of that folder, 48 files). No Round 2 file was edited for Round 3. Check it with:

```sh
diff -r agents/receiving/round2 <round2-checkout>/submissions/Bhargav200/agent   # no output = identical
```

`round2/node_modules` is installed locally with `npm ci` and is not committed.

## What is new for Round 3 (the integration layer only)

| File | Purpose |
|---|---|
| `app.py` | Replaces the organiser stub. Agent Input → Round 2 → Evidence Record / Agent Output (`shared/utils/records.py`). Tenancy, idempotency, fail-open, no-photo handling. |
| `bridge.ts` | Lets Python call the Round 2 TypeScript: reads JSON on stdin, calls `round2/lib/inspect.ts: inspectUnit()`, prints the Round 2 record. |
| `agent.json`, `README.md`, `PROVENANCE.md` | Description, run instructions, this file. |
| `tests/integration/test_receiving_agent.py` | Receiving-specific tests (no API key needed). |

## Mapping Round 2 → Pod contract

| Round 2 (`receiving-evidence/0.2`) | Pod contract v1.0 |
|---|---|
| check `identity` / `defects` | `identity_match` / `quality_flags`; the other 7 keep their names |
| `confidence` high / medium / low (fixed rule) | 0.9 / 0.65 / 0.4 |
| `reason`, `photo_refs` | `detail`, `evidence_refs` (input refs) |
| `overall` ACCEPT / REVIEW / EXCEPTION | `accept` / `pending_review` / `accept_with_exceptions` (`reject` when identity FAILs) |
| `status: pending` (model failed) | `pending_output()`: status pending, UNCERTAIN, error recorded |
| the full record | kept in `payload.round2_record` (without the raw model text) |
