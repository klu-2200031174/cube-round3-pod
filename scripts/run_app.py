"""One command to run everything: the 5 agents, the orchestrator and the interactive UI.

    python scripts/run_app.py            ->  http://127.0.0.1:8100
Reads GROQ_API_KEY from .env (or paste it in the UI: Groq settings).
"""
import os, sys, threading, time, webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT)); os.chdir(ROOT)
from shared.utils import groq_client  # noqa: E402

groq_client.load_dotenv()
port = int(os.environ.get("PORT", "8100"))
print("=" * 60, f"\n  CUBE Commerce Managers  ->  http://127.0.0.1:{port}")
print("  Groq:", "key found [OK]" if groq_client.has_key() else "NO KEY yet - add GROQ_API_KEY to .env or paste it in the UI", "\n" + "=" * 60)
if os.environ.get("NO_BROWSER") != "1":
    threading.Thread(target=lambda: (time.sleep(1.5), webbrowser.open(f"http://127.0.0.1:{port}")), daemon=True).start()
import uvicorn  # noqa: E402
uvicorn.run("orchestration.api:app", host="127.0.0.1", port=port, log_level="warning")
