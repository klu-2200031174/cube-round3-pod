"""The observation step: one batched vision call per unit, and validation of what comes back.

Ported from the reference src/lib/vision.ts (prompt, response shape, JSON extraction) and
src/lib/ai/providers/gemini.ts (Gemini REST call). The model only reports what it sees
(met / not_met / cant_tell per check, which photo, where, the visible evidence, photo usability and the
FNSKU label text). It never returns a verdict: rules.py decides.

Providers:
  GroqProvider      Groq chat-completions (OpenAI-compatible) with a vision model, JSON mode, bounded latency.
                    Groq accepts at most 3 images per request; extra photos are tiled into numbered contact sheets.
  GeminiProvider    the original Google Gemini REST provider, kept for A/B runs (LLM_PROVIDER=gemini).
  ScriptedProvider  returns a fixed response (tests, replaying recorded answers).
"""
from __future__ import annotations

import base64
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from .rule_pack import CLAUSES, Requirements, observable

GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
REPO_ROOT = Path(__file__).resolve().parents[3]
STATUSES = ("met", "not_met", "cant_tell")
CONFIDENCES = ("high", "medium", "low")


class ModelError(Exception):
    """The model could not produce a usable answer. The caller fails open."""


@dataclass
class ImageInput:
    data: bytes
    mime: str


@dataclass
class VisionResult:
    raw: dict[str, Any]
    model_version: str
    latency_ms: int
    attempts: int = 1
    usage: dict[str, Any] = field(default_factory=dict)


# ----------------------------------------------------------------------------------------------- prompt
SYSTEM = "\n".join([
    "You are the OBSERVATION component of an automated warehouse prep-inspection system.",
    "Your ONLY job is to report, strictly and literally, what is visible in the photographs.",
    "You do NOT decide pass or fail; a separate deterministic rules engine does that from your observations.",
    "",
    "Hard rules:",
    "1. Describe only what you can actually see. Never assume, infer, or guess what is likely.",
    '2. For each check choose status: "met" (you can clearly SEE the requirement satisfied), "not_met" (you can '
    'clearly SEE it violated or absent), or "cant_tell" (the area is not shown, is blurry/glary/cropped/dark, or '
    'you are unsure). When in any doubt, use "cant_tell".',
    '3. Use confidence "high" only when the relevant area is clearly visible and in focus; use "low" if anything '
    "is ambiguous.",
    '4. Cite which photo (photo_index, as labelled before each image, starting at 1) and where in it (location, '
    'e.g. "lower-right corner"). If the area is not shown in any photo, use "cant_tell" with photo_index null.',
    '5. The "evidence" field must describe the specific visible thing you based the status on. If you cannot point '
    'to something visible, use "cant_tell" with empty evidence.',
    "6. For the label, transcribe the FNSKU/barcode text EXACTLY as printed. If unreadable, set legible=false and "
    "value null. Never invent or auto-correct characters.",
    "7. Rate each photo usable=false if it is blurry, glary, cropped, too dark, out of frame, or too low-resolution "
    "to judge; list the issues.",
    "8. Output ONLY a single JSON object. No prose, no markdown fences.",
])

EXAMPLE = """{
  "photo_quality": [
    { "photo_index": 1, "usable": true, "issues": [] },
    { "photo_index": 2, "usable": false, "issues": ["blurry", "glare"] }
  ],
  "label_text_read": { "value": "X001ABC123", "photo_index": 3, "legible": true, "confidence": "high" },
  "observations": [
    { "check_id": "polybag_present", "status": "met", "confidence": "high", "photo_index": 1,
      "location": "whole frame", "evidence": "The product is fully enclosed in a clear poly bag; all four sealed edges are visible." }
  ]
}"""


def build_prompt(req: Requirements, n_photos: int) -> str:
    lines = []
    for c in observable(req):
        line = f'  - "{c.id}": {c.name}. Rule: {CLAUSES[c.clause_key].quote}'
        if c.id == "handling_marks_present":
            # The reference never told the model WHICH marks the work order requires.
            marks = ", ".join(f'"{m}"' for m in req.handling_marks)
            line += (f" Required marks for this unit: {marks}. Use \"met\" only if EVERY required mark is visible; "
                     'also list the marks you can see in "marks_seen".')
        if c.id == "original_barcode_covered":
            line += (' Use "met" if every manufacturer barcode (UPC/EAN) you can see is covered or defaced; '
                     '"not_met" if one is still scannable; "cant_tell" if the sides that could carry one are not shown.')
        lines.append(line)
    return "\n".join([
        f"Product: SKU {req.sku}.",
        f"Expected FNSKU label text: {req.expected_fnsku or '(not given)'}.",
        f"There are {n_photos} photo(s). Each image follows a text part 'photo_index N:'.",
        "",
        "Observe these checks (use these exact check_id values):",
        *lines,
        "",
        "Also: read the FNSKU label text, and rate every photo's usability.",
        "",
        "Return JSON exactly in this shape (values are illustrative):",
        EXAMPLE,
    ])


def response_schema(req: Requirements) -> dict[str, Any]:
    ids = [c.id for c in observable(req)]
    conf = {"type": "STRING", "enum": list(CONFIDENCES)}
    return {
        "type": "OBJECT",
        "properties": {
            "photo_quality": {"type": "ARRAY", "items": {"type": "OBJECT", "properties": {
                "photo_index": {"type": "INTEGER"}, "usable": {"type": "BOOLEAN"},
                "issues": {"type": "ARRAY", "items": {"type": "STRING"}}}, "required": ["photo_index", "usable"]}},
            "label_text_read": {"type": "OBJECT", "properties": {
                "value": {"type": "STRING", "nullable": True}, "photo_index": {"type": "INTEGER", "nullable": True},
                "legible": {"type": "BOOLEAN"}, "confidence": conf}, "required": ["legible", "confidence"]},
            "observations": {"type": "ARRAY", "items": {"type": "OBJECT", "properties": {
                "check_id": {"type": "STRING", "enum": ids or ["none"]},
                "status": {"type": "STRING", "enum": list(STATUSES)}, "confidence": conf,
                "photo_index": {"type": "INTEGER", "nullable": True}, "location": {"type": "STRING"},
                "evidence": {"type": "STRING"}, "marks_seen": {"type": "ARRAY", "items": {"type": "STRING"}}},
                "required": ["check_id", "status", "confidence"]}},
        },
        "required": ["photo_quality", "label_text_read", "observations"],
    }


# ------------------------------------------------------------------------------------------- validation
def extract_json(text: str) -> dict[str, Any]:
    """The first JSON object in the model text (fenced or not)."""
    t = text.strip()
    if "```" in t:
        inner = t.split("```", 2)[1]
        t = inner[4:] if inner.lower().startswith("json") else inner
    start, end = t.find("{"), t.rfind("}")
    if start < 0 or end < start:
        raise ModelError("no JSON object found in model output")
    try:
        obj = json.loads(t[start:end + 1])
    except json.JSONDecodeError as exc:
        raise ModelError(f"model output was not valid JSON: {exc}") from exc
    if not isinstance(obj, dict):
        raise ModelError("model output JSON was not an object")
    return obj


def _index(v: Any, n: int) -> int | None:
    """A 1-based photo index that exists, else None."""
    if isinstance(v, bool) or not isinstance(v, int):
        return None
    return v if 1 <= v <= n else None


def validate(raw: dict[str, Any], req: Requirements, n_photos: int) -> tuple[dict[str, Any], list[str]]:
    """Normalise the model's answer item by item. Returns (clean, problems).

    The reference parsed the whole answer with one strict schema, so a single malformed item threw away every
    observation. Here a bad item is dropped and noted; the check it was about becomes UNCERTAIN downstream.
    """
    if not any(k in raw for k in ("photo_quality", "label_text_read", "observations")):
        raise ModelError("model answer has none of photo_quality / label_text_read / observations")
    problems: list[str] = []
    wanted = {c.id for c in observable(req)}

    quality = []
    for q in raw.get("photo_quality") or []:
        idx = _index(q.get("photo_index"), n_photos) if isinstance(q, dict) else None
        if idx is None or not isinstance(q.get("usable"), bool):
            problems.append(f"photo_quality item ignored: {json.dumps(q)[:120]}")
            continue
        issues = [str(i) for i in q.get("issues") or [] if isinstance(i, (str, int, float))]
        quality.append({"photo_index": idx, "usable": q["usable"], "issues": issues})

    lr = raw.get("label_text_read") if isinstance(raw.get("label_text_read"), dict) else {}
    if not lr:
        problems.append("label_text_read missing")
    value = lr.get("value")
    label = {
        "value": value.strip() if isinstance(value, str) and value.strip() else None,
        "photo_index": _index(lr.get("photo_index"), n_photos),
        "legible": lr.get("legible") is True,
        "confidence": lr.get("confidence") if lr.get("confidence") in CONFIDENCES else "low",
    }
    if lr.get("photo_index") is not None and label["photo_index"] is None:
        problems.append(f"label_text_read cites photo {lr.get('photo_index')!r}, which does not exist")

    observations = []
    for o in raw.get("observations") or []:
        if not isinstance(o, dict) or o.get("check_id") not in wanted:
            problems.append(f"observation ignored (unknown or unrequested check): {json.dumps(o)[:120]}")
            continue
        if o.get("status") not in STATUSES:
            problems.append(f"{o['check_id']}: status {o.get('status')!r} is not met/not_met/cant_tell; ignored")
            continue
        idx = _index(o.get("photo_index"), n_photos)
        if o.get("photo_index") is not None and idx is None:
            problems.append(f"{o['check_id']}: cites photo {o.get('photo_index')!r}, which does not exist")
        marks = o.get("marks_seen")
        observations.append({
            "check_id": o["check_id"], "status": o["status"],
            "confidence": o.get("confidence") if o.get("confidence") in CONFIDENCES else "low",
            "photo_index": idx, "location": str(o.get("location") or ""), "evidence": str(o.get("evidence") or ""),
            "marks_seen": [str(m) for m in marks] if isinstance(marks, list) else None,
        })
    return {"photo_quality": quality, "label_text_read": label, "observations": observations}, problems


# -------------------------------------------------------------------------------------------- providers
def load_dotenv(path: Path | None = None) -> None:
    """Minimal .env loader (KEY=VALUE lines). Existing environment variables win."""
    path = path or REPO_ROOT / ".env"
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key, value = key.strip(), value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


@dataclass
class Settings:
    api_key: str
    model: str = "gemini-3.6-flash"
    fallback_models: list[str] = field(default_factory=list)
    timeout_s: float = 20.0      # per HTTP call
    budget_s: float = 25.0       # whole inspection, all models and retries (inside the stage's 30 s)

    @classmethod
    def from_env(cls) -> "Settings":
        load_dotenv()
        fallbacks = os.environ.get("GEMINI_FALLBACK_MODELS", "gemini-3.5-flash,gemini-3.1-flash-lite")
        return cls(
            api_key=os.environ.get("GEMINI_API_KEY", "").strip(),
            model=os.environ.get("GEMINI_MODEL", "gemini-3.6-flash").strip() or "gemini-3.6-flash",
            fallback_models=[m.strip() for m in fallbacks.split(",") if m.strip()],
            timeout_s=float(os.environ.get("PREP_MODEL_TIMEOUT_S", os.environ.get("MODEL_TIMEOUT_S", "20"))),
            budget_s=float(os.environ.get("PREP_MODEL_BUDGET_S", os.environ.get("MODEL_BUDGET_S", "25"))),
        )


class Provider:
    name = "base"

    def inspect(self, req: Requirements, images: list[ImageInput]) -> VisionResult:
        raise NotImplementedError


class GeminiProvider(Provider):
    name = "google"

    def __init__(self, settings: Settings, opener: Callable[..., Any] | None = None):
        if not settings.api_key:
            raise ModelError("GEMINI_API_KEY is not set (see .env.example)")
        self.s = settings
        self._open = opener or urllib.request.urlopen

    def _body(self, req: Requirements, images: list[ImageInput], with_schema: bool) -> dict[str, Any]:
        # Each image is preceded by its label so photo_index in the answer is unambiguous.
        parts: list[dict[str, Any]] = [{"text": build_prompt(req, len(images))}]
        for i, img in enumerate(images, start=1):
            parts.append({"text": f"photo_index {i}:"})
            parts.append({"inline_data": {"mime_type": img.mime, "data": base64.b64encode(img.data).decode("ascii")}})
        config: dict[str, Any] = {"temperature": 0, "maxOutputTokens": 8192, "responseMimeType": "application/json"}
        if with_schema:
            config["responseSchema"] = response_schema(req)
        return {"systemInstruction": {"parts": [{"text": SYSTEM}]},
                "contents": [{"role": "user", "parts": parts}], "generationConfig": config}

    def _call(self, model: str, body: dict[str, Any], timeout: float) -> dict[str, Any]:
        request = urllib.request.Request(
            GEMINI_URL.format(model=urllib.parse.quote(model, safe="")), data=json.dumps(body).encode("utf-8"),
            headers={"Content-Type": "application/json", "x-goog-api-key": self.s.api_key}, method="POST")
        with self._open(request, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))

    def inspect(self, req: Requirements, images: list[ImageInput]) -> VisionResult:
        """One logical inspection = one successful call. Bounded: each call <= timeout_s, all of it <= budget_s.

        Order: the primary model, then each fallback. A 400 is retried once without the response schema
        (some models reject it); 429/401/403/404 move to the next model; 5xx and network errors move on too.
        """
        deadline = time.monotonic() + self.s.budget_s
        models = [self.s.model] + [m for m in self.s.fallback_models if m != self.s.model]
        errors: list[str] = []
        attempts = 0
        for model in models:
            for with_schema in (True, False):
                remaining = deadline - time.monotonic()
                if remaining < 1.0:
                    errors.append(f"gave up after {self.s.budget_s:.0f}s")
                    raise ModelError("; ".join(dict.fromkeys(errors)))
                attempts += 1
                t0 = time.monotonic()
                try:
                    data = self._call(model, self._body(req, images, with_schema), min(self.s.timeout_s, remaining))
                except urllib.error.HTTPError as exc:
                    detail = exc.read().decode("utf-8", "replace")
                    try:
                        detail = json.loads(detail)["error"]["message"]
                    except Exception:
                        detail = detail[:200]
                    errors.append(f"{model}: HTTP {exc.code} {' '.join(str(detail).split())[:160]}")
                    if exc.code == 400 and with_schema:
                        continue
                    break
                except (urllib.error.URLError, TimeoutError, OSError) as exc:
                    errors.append(f"{model}: {exc}")
                    break
                latency = int((time.monotonic() - t0) * 1000)
                try:
                    raw = parse_gemini(data)
                except ModelError as exc:
                    errors.append(f"{model}: {exc}")
                    break
                return VisionResult(raw, model, latency, attempts, data.get("usageMetadata", {}))
        raise ModelError("; ".join(dict.fromkeys(errors)) or "no model available")


def parse_gemini(data: dict[str, Any]) -> dict[str, Any]:
    block = (data.get("promptFeedback") or {}).get("blockReason")
    if block:
        raise ModelError(f"request blocked by the model ({block})")
    try:
        text = "".join(p.get("text", "") for p in data["candidates"][0]["content"]["parts"])
    except (KeyError, IndexError, TypeError) as exc:
        raise ModelError("model returned no content") from exc
    if not text.strip():
        raise ModelError("model returned an empty response")
    return extract_json(text)


class ScriptedProvider(Provider):
    """Returns a fixed answer, or raises it if it is an exception. Counts calls."""
    name = "scripted"

    def __init__(self, response: dict[str, Any] | Callable[..., dict[str, Any]] | Exception,
                 model_version: str = "scripted"):
        self.response, self.model_version, self.calls = response, model_version, 0

    def inspect(self, req: Requirements, images: list[ImageInput]) -> VisionResult:
        self.calls += 1
        if isinstance(self.response, Exception):
            raise self.response
        raw = self.response(req, images) if callable(self.response) else self.response
        return VisionResult(json.loads(json.dumps(raw)), self.model_version, 1)


class GroqProvider(Provider):
    name = "groq"

    def __init__(self, chat_fn: Callable[..., Any] | None = None):
        from shared.utils import groq_client
        self._g = groq_client
        self._chat = chat_fn or groq_client.chat
        if chat_fn is None and not groq_client.has_key():
            raise ModelError("GROQ_API_KEY is not set (see .env.example)")

    def inspect(self, req: Requirements, images: list[ImageInput]) -> VisionResult:
        user = "\n".join([
            build_prompt(req, len(images)),
            "",
            "Photos are labelled 'photo #N'. If a 'contact sheet' is shown, every tile carries its own photo number: "
            "use that number as photo_index.",
            "",
            self._g.schema_hint(response_schema(req)),
        ])
        try:
            res = self._chat(SYSTEM, user, [self._g.Image(i.data, i.mime) for i in images], json_mode=True, max_tokens=4096)
        except self._g.GroqError as exc:
            raise ModelError(str(exc)) from exc
        return VisionResult(res.json, res.model, res.latency_ms, res.attempts, res.usage)


def make_provider() -> Provider:
    if os.environ.get("LLM_PROVIDER", "groq").strip().lower() == "gemini":
        return GeminiProvider(Settings.from_env())
    return GroqProvider()
