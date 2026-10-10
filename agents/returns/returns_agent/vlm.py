"""Vision-language model providers.

- GroqProvider: Groq chat-completions (OpenAI-compatible) vision model, JSON mode. Default provider.
- GeminiProvider: Google Gemini REST API via the standard library (kept for A/B runs, LLM_PROVIDER=gemini).
- OfflineProvider: no network; always reports that it cannot see anything, so
  every check is UNCERTAIN and the case goes to review. Useful to exercise the
  UI / fail-open path without a key.
- ScriptedProvider: returns a fixed response (tests, replaying cached eval runs).
"""
from __future__ import annotations

import base64
import io
import json
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Callable

from .config import Settings
from .prompt import build_prompt, response_schema

GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"


class ModelError(Exception):
    """The model could not produce a usable answer. Callers must fail open."""


@dataclass
class ImageInput:
    data: bytes
    mime: str


@dataclass
class VLMResult:
    raw: dict[str, Any]
    model_version: str
    latency_ms: int
    usage: dict[str, Any] = field(default_factory=dict)


def downscale(img: ImageInput, max_side: int) -> ImageInput:
    """Shrink large photos to cut latency/cost. Optional: needs Pillow; otherwise unchanged."""
    try:
        from PIL import Image  # type: ignore
    except Exception:
        return img
    try:
        im = Image.open(io.BytesIO(img.data))
        if max(im.size) <= max_side:
            return img
        im.thumbnail((max_side, max_side))
        out = io.BytesIO()
        im.convert("RGB").save(out, format="JPEG", quality=88)
        return ImageInput(out.getvalue(), "image/jpeg")
    except Exception:
        return img


class Provider:
    name = "base"

    def inspect(self, order, images: list[ImageInput], operator_note: str = "") -> VLMResult:
        raise NotImplementedError


class GeminiProvider(Provider):
    name = "gemini"

    def __init__(self, settings: Settings, opener: Callable[..., Any] | None = None):
        if not settings.gemini_api_key:
            raise ModelError("GEMINI_API_KEY is not set (see .env.example)")
        self.s = settings
        self._open = opener or urllib.request.urlopen

    def _call(self, model: str, body: dict[str, Any], timeout: float) -> dict[str, Any]:
        req = urllib.request.Request(
            GEMINI_URL.format(model=model),
            data=json.dumps(body).encode("utf-8"),
            headers={"Content-Type": "application/json", "x-goog-api-key": self.s.gemini_api_key},
            method="POST",
        )
        with self._open(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))

    def inspect(self, order, images: list[ImageInput], operator_note: str = "") -> VLMResult:
        """One logical inspection = one successful model call.

        Latency is bounded: the whole attempt (all models, all retries) stops at
        MODEL_BUDGET_S; each request is capped at MODEL_TIMEOUT_S. An overloaded
        model is skipped straight away (the next model is often free) and only
        retried in a second pass. When the budget runs out the caller fails open.
        """
        images = [downscale(i, self.s.max_image_side) for i in images]
        parts: list[dict[str, Any]] = [{"text": build_prompt(order, len(images), operator_note)}]
        for idx, img in enumerate(images):
            parts.append({"text": f"image_index {idx}:"})
            parts.append({"inline_data": {"mime_type": img.mime, "data": base64.b64encode(img.data).decode("ascii")}})
        base_body = {
            "contents": [{"role": "user", "parts": parts}],
            "generationConfig": {"temperature": 0, "responseMimeType": "application/json"},
        }
        models = [self.s.gemini_model] + [m for m in self.s.gemini_fallback_models if m != self.s.gemini_model]
        deadline = time.monotonic() + self.s.model_budget_s
        errors: list[str] = []
        busy: list[str] = []          # models that were overloaded / timed out: worth one more try
        for pass_no, queue in enumerate((models, None)):
            if pass_no == 1:
                queue = busy
                if not queue or time.monotonic() + 2 >= deadline:
                    break
                time.sleep(2.0)
            for model in list(queue):
                for use_schema in (True, False):
                    if time.monotonic() >= deadline:
                        errors.append(f"gave up after {self.s.model_budget_s:.0f}s")
                        raise ModelError("; ".join(dict.fromkeys(errors)))
                    body = json.loads(json.dumps(base_body))
                    if use_schema:
                        body["generationConfig"]["responseSchema"] = response_schema()
                    outcome, value = self._attempt(model, body, errors, deadline)
                    if outcome == "ok":
                        return value
                    if outcome == "bad_request" and use_schema:
                        continue  # schema rejected by this model: retry once without it
                    if outcome == "busy" and pass_no == 0:
                        busy.append(model)
                    break  # next model
        raise ModelError("; ".join(dict.fromkeys(errors)) or "no model available")

    def _attempt(self, model: str, body: dict[str, Any], errors: list[str], deadline: float) -> tuple[str, Any]:
        timeout = max(1.0, min(self.s.model_timeout_s, deadline - time.monotonic()))
        t0 = time.monotonic()
        try:
            data = self._call(model, body, timeout)
        except urllib.error.HTTPError as e:
            raw = e.read().decode("utf-8", "replace")
            try:
                msg = json.loads(raw)["error"]["message"]
            except Exception:
                msg = raw[:200]
            errors.append(f"{model}: HTTP {e.code} {' '.join(msg.split())[:160]}")
            if e.code == 400:
                return "bad_request", None
            if e.code in (500, 502, 503, 504):
                return "busy", None
            return "next_model", None  # 401/403/404/429: try the fallback model
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            errors.append(f"{model}: {e}")
            return "busy", None
        latency = int((time.monotonic() - t0) * 1000)
        return "ok", VLMResult(parse_gemini(data), model, latency, data.get("usageMetadata", {}))


class GroqProvider(Provider):
    name = "groq"

    def __init__(self, settings: Settings | None = None, chat_fn: Callable[..., Any] | None = None):
        from shared.utils import groq_client
        self._g = groq_client
        self._chat = chat_fn or groq_client.chat
        self.s = settings
        if chat_fn is None and not groq_client.has_key():
            raise ModelError("GROQ_API_KEY is not set (see .env.example)")

    def inspect(self, order, images: list[ImageInput], operator_note: str = "") -> VLMResult:
        user = "\n".join([
            build_prompt(order, len(images), operator_note),
            "",
            "The images are labelled 'photo #N' with N starting at 1. If a 'contact sheet' is shown, every tile carries "
            "its own photo number. Use image_index = N - 1 (so photo #1 is image_index 0) everywhere an image_index is asked for.",
            "",
            self._g.schema_hint(response_schema()),
        ])
        try:
            res = self._chat("You are a careful visual inspector. Report only what is visible.", user,
                             [self._g.Image(i.data, i.mime) for i in images], json_mode=True, max_tokens=4096)
        except self._g.GroqError as exc:
            raise ModelError(str(exc)) from exc
        return VLMResult(res.json, res.model, res.latency_ms, res.usage)


def parse_gemini(data: dict[str, Any]) -> dict[str, Any]:
    try:
        cand = data["candidates"][0]
        text = "".join(p.get("text", "") for p in cand["content"]["parts"])
    except (KeyError, IndexError, TypeError) as e:
        reason = (data.get("promptFeedback") or {}).get("blockReason") or "no candidates"
        raise ModelError(f"model returned no content ({reason})") from e
    return parse_json_text(text)


def parse_json_text(text: str) -> dict[str, Any]:
    t = text.strip()
    if t.startswith("```"):
        t = t.strip("`")
        t = t[t.find("{"):]
    start, end = t.find("{"), t.rfind("}")
    if start < 0 or end < 0:
        raise ModelError("model output was not JSON")
    try:
        obj = json.loads(t[start:end + 1])
    except json.JSONDecodeError as e:
        raise ModelError(f"model output was not valid JSON: {e}") from e
    if not isinstance(obj, dict):
        raise ModelError("model output JSON was not an object")
    return obj


class OfflineProvider(Provider):
    name = "offline"

    def inspect(self, order, images, operator_note: str = "") -> VLMResult:
        return VLMResult(
            raw={
                "image_quality": [{"image_index": i, "usable": True, "issue": ""} for i in range(len(images))],
                "identity": {"verdict": "UNCERTAIN", "observed_product": "offline mode - no model inspection",
                             "best_matching_sku": "", "confidence": 0.0, "evidence": []},
                "components": [], "unexpected_items": [], "observed_state": "uncertain", "damage": [],
                "condition": {"grade": "UNCERTAIN", "confidence": 0.0, "rationale": "offline mode", "evidence": []},
            },
            model_version="offline", latency_ms=0,
        )


class ScriptedProvider(Provider):
    name = "scripted"

    def __init__(self, response: dict[str, Any] | Callable[..., dict[str, Any]] | Exception, model_version: str = "scripted"):
        self.response = response
        self.model_version = model_version
        self.calls = 0

    def inspect(self, order, images, operator_note: str = "") -> VLMResult:
        self.calls += 1
        if isinstance(self.response, Exception):
            raise self.response
        raw = self.response(order, images) if callable(self.response) else self.response
        return VLMResult(json.loads(json.dumps(raw)), self.model_version, 1)


def make_provider(settings: Settings) -> Provider:
    if settings.provider == "offline":
        return OfflineProvider()
    if settings.provider == "groq":
        return GroqProvider(settings)
    if settings.provider == "gemini":
        return GeminiProvider(settings)
    raise ModelError(f"unknown LLM_PROVIDER '{settings.provider}'")
