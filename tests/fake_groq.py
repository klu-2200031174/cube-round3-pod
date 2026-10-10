"""A tiny fake of Groq's OpenAI-compatible endpoint, FOR TESTS ONLY.

It lets the test-suite drive the real code path (HTTP request -> JSON mode -> parsing -> rules -> evidence) without a
network or an API key. It never ships as an agent and nothing in the app talks to it unless GROQ_BASE_URL points here.

`FakeGroq.scenario` tweaks what the "model" says, e.g. {"pack": "wrong_cap"}.
"""
from __future__ import annotations

import json
import re
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any


def _prep(user: str, sc: str) -> dict:
    ids = re.findall(r'^\s+- "([a-z_]+)":', user, re.M)
    obs = []
    for cid in ids:
        status = "met"
        if sc == "label_on_seam" and cid == "fnsku_placement":
            status = "not_met"
        if sc == "ambiguous":
            status = "cant_tell"
        obs.append({"check_id": cid, "status": status, "confidence": "low" if status == "cant_tell" else "high",
                    "photo_index": None if status == "cant_tell" else 1, "location": "whole frame",
                    "evidence": "" if status == "cant_tell" else f"visible evidence for {cid}"})
    return {"photo_quality": [{"photo_index": 1, "usable": True, "issues": []}],
            "label_text_read": {"value": "X00DUMMY", "photo_index": 1, "legible": True, "confidence": "high"},
            "observations": obs}


def _returns(user: str, sc: str) -> dict:
    sku = re.search(r'"sku": "([^"]+)"', user).group(1)
    parts = json.loads(re.search(r"using these names: (\[.*?\])", user).group(1))
    status = lambda p: "ABSENT" if (sc == "missing_part" and p == parts[-1] and len(parts) > 1) else "PRESENT"  # noqa: E731
    wrong = sc == "wrong_item"
    return {"image_quality": [{"image_index": 0, "usable": True, "issue": ""}],
            "identity": {"verdict": "MISMATCH" if wrong else "MATCH", "observed_product": "a different product" if wrong else "the ordered product",
                         "best_matching_sku": "" if wrong else sku, "visible_identifiers": [], "confidence": 0.9,
                         "evidence": [{"image_index": 0, "observation": "product visible"}]},
            "components": [{"part": p, "status": status(p), "confidence": 0.9, "evidence": [{"image_index": 0, "observation": f"{p} {status(p).lower()}"}]} for p in parts],
            "unexpected_items": [], "observed_state": "damaged" if sc == "damaged" else "opened_unused",
            "damage": [{"description": "crushed corner", "severity": "severe", "image_index": 0}] if sc == "damaged" else [],
            "condition": {"grade": "Unacceptable" if sc == "damaged" else "Used - Like New", "confidence": 0.85,
                          "rationale": "as observed", "evidence": [{"image_index": 0, "observation": "overall look"}]}}


def _receiving(sc: str) -> dict:
    base = {"photo_quality": "good", "photo_quality_reason": "", "product_type": "water bottle",
            "product_description": "a blue 750 ml water bottle", "product_photos": [1], "colour_seen": "blue",
            "label_text": "750ml bottle", "cartons_visible": 1, "cartons_fully_visible": True, "units_in_open_carton": 24,
            "open_carton_fully_visible": True, "count_photos": [1], "carton_damage": "none", "carton_damage_types": [],
            "carton_damage_reason": "", "carton_damage_photos": [], "unit_damage": "none", "unit_damage_types": [],
            "unit_damage_reason": "", "unit_damage_photos": [], "opened_unit_visible": True, "parts_seen": ["lid"],
            "defect_present": "no", "defect_description": "", "defect_photos": []}
    if sc == "short_damaged":
        base.update(units_in_open_carton=22, carton_damage="damaged", carton_damage_types=["crushing"],
                    carton_damage_reason="collapsed corner", carton_damage_photos=[1])
    if sc == "blurry":
        base.update(photo_quality="unusable", photo_quality_reason="out of focus")
    return base


def _pack(sc: str) -> dict:
    it = lambda n, c, k: {"name": n, "colour": c, "variant_or_size": None, "label_text": None, "count": k,  # noqa: E731
                          "count_fully_visible": True, "photo": 1, "confidence": "high"}
    items = [it("t-shirt", "black", 2), it("cap", "red" if sc == "wrong_cap" else "blue", 1)]
    if sc == "extra":
        items.append(it("mug", "white", 1))
    if sc == "missing":
        items = items[:1]
    q = "unusable" if sc == "blurry" else "good"
    return {"photo_quality": q, "photo_quality_reason": "blurry" if q != "good" else "", "contents_fully_visible": q == "good",
            "items": [] if q != "good" else items, "packaging_or_dunnage": ["packing paper"], "notes": ""}


def _recovery(user: str) -> dict:
    facts = json.loads(user.split("FACTS (one per charge):\n", 1)[1])
    notes = []
    for f in facts:
        ids = ", ".join(f["evidence_record_ids"]) or "no records"
        if f["position"] == "CONTRADICTS":
            t = f"Charge {f['line_id']} of ${f['amount_usd']:.2f} is contradicted by {ids}. We request reversal of ${f['claim_amount_usd']:.2f}."
        else:
            t = f"Charge {f['line_id']} cannot be claimed on the available evidence."
        notes.append({"line_id": f["line_id"], "text": t})
    return {"notes": notes}


class FakeGroq:
    def __init__(self) -> None:
        self.scenario: dict[str, str] = {}
        self.calls: list[dict[str, Any]] = []
        self.delay = 0.0
        self.fail_models: set[str] = set()
        self.status_for_model: dict[str, int] = {}
        outer = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a): ...

            def _send(self, code: int, obj: Any) -> None:
                body = json.dumps(obj).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self):  # /models
                if self.headers.get("Authorization") != "Bearer test-key-0123456789abcdef":
                    return self._send(401, {"error": {"message": "invalid key"}})
                self._send(200, {"data": [{"id": "qwen/qwen3.8-27b"}, {"id": "whisper-large-v3"}, {"id": "qwen/qwen3.6-27b"}]})

            def do_POST(self):
                if self.headers.get("Authorization") != "Bearer test-key-0123456789abcdef":
                    return self._send(401, {"error": {"message": "invalid key"}})
                req = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                outer.calls.append(req)
                time.sleep(outer.delay)
                model = req["model"]
                if model in outer.status_for_model:
                    return self._send(outer.status_for_model[model], {"error": {"message": "simulated failure"}})
                system = req["messages"][0]["content"]
                user = req["messages"][1]["content"]
                text = user if isinstance(user, str) else " ".join(p["text"] for p in user if p["type"] == "text")
                sc = outer.scenario
                if "receiving inspector" in system:
                    out = _receiving(sc.get("receiving", "ok"))
                elif "OBSERVATION component of an automated warehouse prep" in system:
                    out = _prep(text, sc.get("prep", "ok"))
                elif "packing-verification" in system:
                    out = _pack(sc.get("pack", "ok"))
                elif "visual inspector" in system:
                    out = _returns(text, sc.get("returns", "ok"))
                elif "dispute notes" in system:
                    out = _recovery(text)
                else:
                    return self._send(400, {"error": {"message": "unknown fake prompt"}})
                self._send(200, {"model": model, "choices": [{"message": {"content": json.dumps(out)}}],
                                 "usage": {"prompt_tokens": 100, "completion_tokens": 50}})

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self.server.server_port}/openai/v1"

    def start(self) -> "FakeGroq":
        self.thread.start()
        return self

    def stop(self) -> None:
        self.server.shutdown()
