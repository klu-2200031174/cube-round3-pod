# Provenance: Prep Manager

## Source Repository
* **Participant**: Member 2 (Prep Manager) / Dheeraj Chandra
* **Round 2 Repository**: [cube26-prp-0319-manvith111](https://github.com/manvith111/cube26-prp-0319-manvith111)
* **Round 2 System**: **OpsConsole — Prep Manager**
* **Round 3 Target**: `agents/prep/`

---

## Architectural Adaptation

This component migrates the Round 2 Prep Manager inspection engine and records APIs into the target Python architecture (`agents/prep/app.py`).

### Endpoints Integrated
- `GET /api/records`: lists all evidence records from persistent store.
- `GET /api/records/{record_id}`: fetches individual inspection record by ID.
- `POST /api/inspect`: runs full prep compliance inspection against product criteria.
- `POST /run` (`handle()`): official Round 3 Agent Contract runner for Prep stage.

