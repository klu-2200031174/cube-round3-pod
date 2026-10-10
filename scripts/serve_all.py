"""Serve all 5 agent microservices and the orchestrator on localhost.

Usage:
    python scripts/serve_all.py

Ports:
    8100: Orchestrator  (http://127.0.0.1:8100/docs)
    8101: Receiving     (http://127.0.0.1:8101/docs)
    8102: Prep          (http://127.0.0.1:8102/docs)
    8103: Pack          (http://127.0.0.1:8103/docs)
    8104: Returns       (http://127.0.0.1:8104/docs)
    8105: Recovery      (http://127.0.0.1:8105/docs)
"""
from __future__ import annotations

import importlib
import os
import sys
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import httpx
import uvicorn

SERVICES = [
    ("receiving", "agents.receiving.app:app", 8101),
    ("prep", "agents.prep.app:app", 8102),
    ("pack", "agents.pack.app:app", 8103),
    ("returns", "agents.returns.app:app", 8104),
    ("recovery", "agents.recovery.app:app", 8105),
    ("orchestrator", "orchestration.api:app", 8100),
]


def run_service(app_target: str, port: int, servers: list[uvicorn.Server], host: str = "127.0.0.1") -> None:
    module_name, app_name = app_target.split(":")
    mod = importlib.import_module(module_name)
    app = getattr(mod, app_name)
    config = uvicorn.Config(app, host=host, port=port, log_level="warning")
    server = uvicorn.Server(config)
    servers.append(server)
    server.run()


def main():
    port_orch = int(os.environ.get("PORT", 8100))
    host_orch = "0.0.0.0" if (os.environ.get("RENDER") or os.environ.get("PORT")) else "127.0.0.1"

    services = [
        ("receiving", "agents.receiving.app:app", 8101, "127.0.0.1"),
        ("prep", "agents.prep.app:app", 8102, "127.0.0.1"),
        ("pack", "agents.pack.app:app", 8103, "127.0.0.1"),
        ("returns", "agents.returns.app:app", 8104, "127.0.0.1"),
        ("recovery", "agents.recovery.app:app", 8105, "127.0.0.1"),
        ("orchestrator", "orchestration.api:app", port_orch, host_orch),
    ]

    # Configure orchestrator to talk to agents over HTTP
    os.environ["ORCH_MODE"] = "http"
    for name, _, port, _ in services:
        if name != "orchestrator":
            os.environ[f"{name.upper()}_URL"] = f"http://127.0.0.1:{port}"

    print("=" * 65)
    print(f"  STARTING ALL 5 AGENT SERVICES + ORCHESTRATOR (PORT {port_orch})")
    print("=" * 65)

    servers: list[uvicorn.Server] = []
    threads: list[threading.Thread] = []

    for name, target, port, host in services:
        t = threading.Thread(target=run_service, args=(target, port, servers, host), daemon=True)
        t.start()
        threads.append(t)

    # Wait for services to be ready
    print("\nWaiting for services to become healthy...")
    ready = False
    for _ in range(50):
        try:
            r = httpx.get(f"http://127.0.0.1:{port_orch}/health", timeout=1.0)
            if r.status_code == 200 and r.json().get("status") == "ok":
                ready = True
                break
        except Exception:
            pass
        time.sleep(0.1)

    if ready:
        print("\nAll 5 agents and orchestrator are ONLINE and HEALTHY!")
    else:
        print("\nServices initialized.")

    print("\n" + "-" * 65)
    print("  Endpoints & Interactive Swagger UI Documentation:")
    print("-" * 65)
    print("  [0] Orchestrator: http://127.0.0.1:8100  (Docs: http://127.0.0.1:8100/docs)")
    print("  [1] Receiving:    http://127.0.0.1:8101  (Docs: http://127.0.0.1:8101/docs)")
    print("  [2] Prep:         http://127.0.0.1:8102  (Docs: http://127.0.0.1:8102/docs)")
    print("  [3] Pack:         http://127.0.0.1:8103  (Docs: http://127.0.0.1:8103/docs)")
    print("  [4] Returns:      http://127.0.0.1:8104  (Docs: http://127.0.0.1:8104/docs)")
    print("  [5] Recovery:     http://127.0.0.1:8105  (Docs: http://127.0.0.1:8105/docs)")
    print("-" * 65)
    print("\nQuick Test Examples:")
    print("  Check Health:   curl http://127.0.0.1:8100/health")
    print('  Run Workflow:   curl -X POST http://127.0.0.1:8100/workflows -H "Content-Type: application/json" -d "{\\"org_id\\":\\"org_demo_alpha\\",\\"unit_id\\":\\"UNIT-0014\\"}"')
    print("\nPress Ctrl+C to stop all servers.\n")

    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print("\nShutting down all servers...")
        for s in servers:
            s.should_exit = True
        print("Done.")


if __name__ == "__main__":
    main()
