# Provenance: Returns Manager

| | |
|---|---|
| **Round 2 repository** | https://github.com/klu-2200031174/cube26-rtn-0094-klu-2200031174 |
| **Commit** | `b22cd36` (final Round 2 submission, `main`) |
| **Author** | Aashritha Jammula (@klu-2200031174) |

## What came from Round 2 (unchanged logic)

| Pod path | Round 2 path |
|---|---|
| `returns_agent/checks.py` | `returns_agent/checks.py` |
| `returns_agent/rules.py` | `returns_agent/rules.py` |
| `returns_agent/prompt.py` | `returns_agent/prompt.py` |
| `returns_agent/vlm.py` | `returns_agent/vlm.py` |
| `reference/catalogue.json`, `condition_scale.json`, `disposition_rules.json`, `demo_orders.csv` | `reference/` |

## What changed for the Pod

| File | Change | Why |
|---|---|---|
| `returns_agent/config.py` | Reads the Pod's `.env` and the shared `DATA_DIR` (`data/sample`) | One configuration for the whole Pod |
| `returns_agent/reference.py` | Added `get_order_by_unit()` (org-scoped) | The Pod's subject is a `unit_id`, not an `order_id` |
| `returns_agent/__init__.py` | Version 0.2.0 | Marks the Pod integration |
| `app.py` (new) | Adapter: Agent Input → Round 2 pipeline → Evidence Record; Pack cross-check; fail-open `pending` record | The shared contract |

## Not carried over

The Round 2 web UI, SQLite store, HTTP server and evaluation harness. In the Pod the orchestrator owns storage, workflow state and overrides. The Round 2 evaluation (50 units) stays in the Round 2 repository.
