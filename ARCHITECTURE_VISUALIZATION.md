# CUBE Pod 13: System Architecture & Visual Blueprint

This document provides a complete technical walkthrough and visual architecture of **CUBE Pod 13** — the autonomous multi-agent commerce automation platform.

---

## 1. High-Level System Topology

```mermaid
graph TB
    subgraph ClientLayer ["Client & Edge Layer (Vercel)"]
        UI["Modern Web Application<br/>(Vanilla ES6 + Canvas Charts)"]
        LiveView["Live Run & Stage Consoles"]
        DAGView["Real-time DAG & Gantt Visualizer"]
    end

    subgraph OrchestrationLayer ["Cloud Backend (Render - Port $PORT)"]
        Orch["FastAPI Orchestrator<br/>(orchestration.api:app)"]
        FlowEngine["DAG Wave Scheduler<br/>(flow.json · Sequential / Parallel)"]
        EvStore["Cryptographic Evidence Store<br/>(FileStore · SHA-256 Immutable Audit Trail)"]
        LabRouter["Interactive Lab & Pipeline Router<br/>(orchestration.lab.py)"]
    end

    subgraph AgentsLayer ["Specialized Microservices (Localhost HTTP / In-Proc)"]
        A1["1 · Receiving Manager<br/>Port 8101<br/>Dock Inspection & PO Match"]
        A2["2 · Prep Manager<br/>Port 8102<br/>FBA Packaging & Labelling"]
        A3["3 · Pack Manager<br/>Port 8103<br/>Open-Box Order Verification"]
        A4["4 · Returns Manager<br/>Port 8104<br/>Identity, Completeness & Disposition"]
        A5["5 · Recovery Hub<br/>Port 8105<br/>Carrier Fee Auditing & Claims"]
    end

    subgraph LLMLayer ["AI Inference (Groq LPUs)"]
        Groq["Groq Cloud API<br/>Model: qwen/qwen3.8-27b<br/>Vision OCR + Spatial Reasoning"]
    end

    UI -->|HTTPS / JSON & Multipart| Orch
    LiveView --> Orch
    DAGView --> Orch
    Orch --> FlowEngine
    FlowEngine --> EvStore
    FlowEngine --> LabRouter

    FlowEngine -->|HTTP :8101| A1
    FlowEngine -->|HTTP :8102| A2
    FlowEngine -->|HTTP :8103| A3
    FlowEngine -->|HTTP :8104| A4
    FlowEngine -->|HTTP :8105| A5

    A1 -->|Vision Requests| Groq
    A2 -->|Vision Requests| Groq
    A3 -->|Vision Requests| Groq
    A4 -->|Vision Requests| Groq
    A5 -->|Audit Narrative| Groq
```

---

## 2. The 5 Specialized AI Agents: Capabilities & Rule Engines

```mermaid
classDiagram
    class ReceivingManager {
        +Dock inspection
        +Purchase Order vs Actual matching
        +Carton & unit quantity counting
        +Transit defect & damage detection
        +OCR carton barcode validation
    }
    class PrepManager {
        +Authoritative standard: fba@1 rules engine
        +Polybag presence & airtight seal check
        +Suffocation warning presence & OCR legibility
        +FNSKU placement: flat surface vs curved/seam edge
        +Pre-existing manufacturer barcode covered
        +Expiration date visibility
        +Handling marks (Fragile, Glass, This Way Up)
        +Thickness limit handling (1.5 mil non-verifiable)
    }
    class PackManager {
        +Open-box pre-seal verification
        +SKU line-item detection & verification
        +Variant matching: color, size, specification
        +Over-pack & under-pack quantity alerts
        +Verdict: SEAL vs STOP & FIX
    }
    class ReturnsManager {
        +Product identity verification vs ordered item
        +Accessory & Component Bill of Materials check
        +Explicit missing components identification
        +Standard Amazon condition grading scale
        +Automated disposition recommendation
        +RESTOCK | REFURBISH | LIQUIDATE | DISPOSE
    }
    class RecoveryHub {
        +Autonomous fee & dispute auditor
        +Parse Amazon / carrier settlement fee reports
        +Cross-audit charges against earlier evidence
        +Positions: SUPPORTS, CONTRADICTS, SILENT
        +Cryptographic claim amount calculation
        +AI claim dispute narrative generation
    }

    ReceivingManager ..> PrepManager : FBA Route
    ReceivingManager ..> PackManager : MFN / 3PL Route
    PackManager ..> ReturnsManager : Returned Units
    PrepManager ..> RecoveryHub : Evidence Records
    PackManager ..> RecoveryHub : Evidence Records
    ReturnsManager ..> RecoveryHub : Evidence Records
```

---

## 3. DAG Pipeline Scheduling: Parallel Execution Waves

When processing a shipment unit, the orchestrator calculates dependencies using a Directed Acyclic Graph (DAG) and schedules tasks in overlapping waves:

```mermaid
gantt
    title Parallel Execution Waves (Elapsed Time in Seconds)
    dateFormat X
    axisFormat %s s

    section Wave 1 (Independent)
    Receiving Manager (Dock Inspection) :active, w1_rec, 0, 4
    Prep Manager (FBA Packaging & Labelling) :active, w1_prep, 0, 3

    section Wave 2 (Needs Pack Evidence)
    Returns Manager (Returned Item BOM & Condition) :crit, w2_ret, 4, 9

    section Wave 3 (Needs All Evidence)
    Recovery Hub (Fee Audit & Reimbursement Claims) :done, w3_rec, 9, 11
```

### Dependency Rules:
1. **Wave 1 (`Receiving ∥ Prep` or `Receiving ∥ Pack`)**: Independent photographs and independent domain rules. Run simultaneously over Groq's high-throughput LPU inference.
2. **Wave 2 (`Returns`)**: Compares what came back against what Pack originally sealed; starts after Pack evidence is registered.
3. **Wave 3 (`Recovery`)**: Recovery audits every fee line against all prior records (dock condition, prep compliance, pack records, and return inspection). It waits for all stages to produce their immutable evidence.

---

## 4. Cryptographic Evidence Chain (Immutable Audit Vault)

Every decision produced by any agent is committed to an immutable record conforming to the strict CUBE Evidence Contract:

```mermaid
graph LR
    subgraph Capture ["Raw Inputs"]
        P1["Carton Photo"]
        P2["Label Photo"]
        P3["Seam Photo"]
    end

    subgraph HashLayer ["Cryptographic Hashing"]
        H1["SHA-256: 7f8a..."]
        H2["SHA-256: 3b1c..."]
        H3["SHA-256: a9e2..."]
    end

    subgraph Record ["Immutable Evidence Record"]
        V["Verdict: PASS / FAIL / UNCERTAIN"]
        Det["Rule-based Visual Checks"]
        Chg["Content Hash: e4b29c..."]
        PChg["Parent Hash: b18f3a..."]
    end

    subgraph Audit ["Carrier / Platform Audit"]
        Claim["Autonomous Reimbursement Claim"]
        Dispute["Inbound Defect Fee Disproved"]
    end

    P1 --> H1
    P2 --> H2
    P3 --> H3
    H1 --> Record
    H2 --> Record
    H3 --> Record
    Record --> Audit
```

- **Strict Idempotency**: Running the same payload twice produces identical content hashes. Re-runs never overwrite past evidence.
- **Auditable Lineage**: If a human operator overrides a verdict in the Review Queue, a new revision is appended with `actor`, `reason`, and cryptographic pointer to the previous record. Original evidence is never modified.

---

## 5. End-to-End Operational Lifecycle

```mermaid
sequenceDiagram
    autonumber
    actor Operator as Warehouse Operator
    participant UI as Vercel Frontend UI
    participant Orch as Orchestrator (Render)
    participant Agent as Specialized Agents
    participant Groq as Groq Vision API
    participant Store as Evidence Store

    Operator->>UI: Selects SKU & uploads inspection photos
    UI->>Orch: POST /api/lab/run (FormData + Photos + Parameters)
    Orch->>Store: Hashes photos (SHA-256) & registers inputs
    
    par Wave 1 Parallel Execution
        Orch->>Agent: POST /run (Receiving payload)
        Agent->>Groq: Multimodal OCR & damage prompt
        Groq-->>Agent: Structured JSON analysis
        Agent-->>Orch: Verdict + checks + rationale
    and
        Orch->>Agent: POST /run (Prep / Pack payload)
        Agent->>Groq: Packaging, FNSKU, suffocation warning analysis
        Groq-->>Agent: Structured compliance verdict
        Agent-->>Orch: Evidence record
    end

    opt Customer Return Present
        Orch->>Agent: POST /run (Returns payload + Pack evidence)
        Agent->>Groq: Accessory BOM match & condition assessment
        Groq-->>Agent: Condition grade & disposition recommendation
        Agent-->>Orch: Returns evidence record
    end

    Orch->>Agent: POST /run (Recovery: Fee lines + All evidence records)
    Agent-->>Orch: Claimable reimbursement amounts + dispute letter
    
    Orch->>Store: Finalizes bundle & workflow state
    Orch-->>UI: Workflow complete (Live Gantt + Evidence Vault + Outcomes)
    UI-->>Operator: Displays instant pass/fail, fee claims & disposition
```

---

## 6. Infrastructure & Deployment Architecture

| Component | Platform | URL / Endpoint | Purpose |
|---|---|---|---|
| **Frontend UI** | **Vercel** | `https://cube-round3-pod.vercel.app` | Reactive dashboard, live camera upload, real-time DAG monitor |
| **Backend API** | **Render** | `https://cube-round3-pod-pb6w.onrender.com` | Microservices host, DAG orchestrator, Swagger API docs |
| **Health Check** | Render | `/health` | Live status across all 5 agent microservices |
| **Inference Engine** | **Groq Cloud** | `https://api.groq.com/openai/v1` | `qwen/qwen3.8-27b` multimodal vision model with sub-second execution |
| **Code Repository** | **GitHub** | `https://github.com/HarshKumar5822/cube-round3-pod` | Complete version-controlled codebase with 100% test coverage |
