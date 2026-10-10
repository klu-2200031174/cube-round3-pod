# Run the complete project (Groq-powered, interactive)

```bash
python -m venv .venv && source .venv/bin/activate      # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env        # then put your key in:  GROQ_API_KEY=gsk_...
python scripts/run_app.py   # opens http://127.0.0.1:8100
```
No key yet? Start anyway and paste it in **Groq settings** (kept in memory only). Click **Test connection** first.

## What you get (Pod 13 control center, sky-blue / white)
Open the app: a landing page ("From supplier dock to final claim") with an **Open control center** button, then a sidebar console:

| Page | What it does |
|---|---|
| Overview | KPIs, the 5-agent flow with live verdict bars, outcome + status charts, latest workflows |
| Live Run | Numbered step cards 01–05: your own Receiving data/photos → Prep (FBA) or Pack (merchant) → Returns (optional) → Recovery fee-line rows → **Start processing** |
| Orchestration | Animated agent graph, Gantt timeline (bars that overlap ran at the same time), orchestrator event log, click a node for its evidence, **Replay** at 0.25×/1×/3× |
| Workflows | Filter chips (ALL / IN_PROGRESS / BLOCKED / FAILED / RECOVERY_REQUIRED / COMPLETED), search, **+ Run Workflow** popup (Demo cases), click a row for the full evidence trail |
| Units | Every unit with route, returned flag, fee lines and outcome; Run / Re-open |
| Review Queue | UNCERTAIN results that need a person; record a decision (override) and the workflow resumes |
| Recovery | Charges reviewed, claims recommended, claimable value, silent; filters; fee-report analyser |
| Evidence | Every hashed record; open one for checks, photo sha256 and raw JSON |
| Agents | The five integrated agents, their checks, Groq role, **Open console** per agent |
| Failures | Workflows that did not complete, with **Retry** |
| Analytics | 9 charts (outcomes, verdicts per agent, failing checks, claims by type/time, AI vs replay, latency, confidence) |
| Pod / System | Architecture, health check, Groq key + Test connection |

## How Groq is used (all 5 agents)
Groq only **observes/explains**; deterministic code **decides** (UNCERTAIN is never turned into PASS).
Default model `qwen/qwen3.8-27b` (max 3 images per call; extra photos are tiled into numbered sheets). Change with `GROQ_MODEL`.

## Tests
`python -m pytest` — includes `tests/e2e/test_lab.py`, which drives every agent through the real HTTP path against a **fake** Groq server.
Not verified: a live call to api.groq.com (my build environment could not reach it) — use *Test connection* on your first run.

## Changes vs the original repo
Gemini → Groq in Prep/Returns; Receiving ported from Node/TypeScript to Python (`agents/receiving/engine.py`, same rules; original TS left untouched);
Pack rewritten (`agents/pack/engine.py`; the old filename-based fake fallback was removed — old file kept as `app.py.orig`);
Recovery keeps rule-based decisions + Groq-written explanations; new UI in `orchestration/static/`; lab API in `orchestration/lab.py`.

## Parallel orchestration
Live Run has a **Run independent agents in parallel** switch (on by default). The orchestrator schedules by dependency:
Receiving ∥ Prep-or-Pack run at the same time; Returns waits for Pack (it compares against what Pack sealed); Recovery waits for all.
Decisions and the final outcome are identical to sequential mode (tested); only wall-clock time changes. API: `POST /workflows {"parallel": true}`,
`POST /api/lab/run` with `async=1&parallel=1`, then poll `GET /api/lab/live/<workflow_id>`.
