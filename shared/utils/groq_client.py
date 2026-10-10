"""Groq client shared by all five agents (standard library only, plus Pillow for contact sheets).

Groq exposes an OpenAI-compatible chat-completions API:  POST {base}/chat/completions
Vision models accept images as `image_url` parts (data: URIs work).  The current Groq vision model
(`qwen/qwen3.8-27b`, checked against console.groq.com/docs/vision) accepts at most 3 images per request, so
`pack_images()` tiles extra photos into numbered contact sheets instead of silently dropping them.

Design rules (same as the rest of the Pod):
  * The model only OBSERVES. Verdicts come from deterministic rule code in each agent.
  * Every failure is a GroqError; callers fail open (pending / UNCERTAIN), never guess.
  * The API key is read from the environment / .env and is never logged or returned to a client.

Environment:
  GROQ_API_KEY            required for any model call
  GROQ_MODEL              default qwen/qwen3.8-27b
  GROQ_FALLBACK_MODELS    comma list tried in order after the primary
  GROQ_BASE_URL           default https://api.groq.com/openai/v1   (tests point this at a local fake)
  GROQ_TIMEOUT_S          per HTTP call, default 40
  GROQ_BUDGET_S           whole inspection incl. retries and fallbacks, default 75
"""
from __future__ import annotations

import base64
import io
import json
import os
import re
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_BASE = "https://api.groq.com/openai/v1"
DEFAULT_MODEL = "qwen/qwen3.8-27b"
DEFAULT_FALLBACKS = "qwen/qwen3.6-27b,meta-llama/llama-4-scout-17b-16e-instruct"
MAX_IMAGES_PER_REQUEST = 3


class GroqError(Exception):
    """The model could not produce a usable answer. Callers must fail open."""


@dataclass
class Image:
    data: bytes
    mime: str = "image/jpeg"
    label: str = ""          # e.g. "photo 2 (carton)"


@dataclass
class GroqResult:
    text: str
    model: str
    latency_ms: int
    attempts: int = 1
    usage: dict[str, Any] = field(default_factory=dict)
    json: dict[str, Any] | None = None


# ------------------------------------------------------------------------------------------ settings
def load_dotenv(path: Path | None = None) -> None:
    """Minimal .env loader (KEY=VALUE). Real environment variables win."""
    path = path or REPO_ROOT / ".env"
    if not path.is_file():
        return
    for raw in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key, value = key.strip(), value.strip().strip('"').strip("'")
        if key and value and not os.environ.get(key):
            os.environ[key] = value


def api_key() -> str:
    load_dotenv()
    return os.environ.get("GROQ_API_KEY", "").strip()


def has_key() -> bool:
    return bool(api_key())


def set_runtime_key(key: str) -> None:
    """Used by the UI's 'connect Groq' box. Held in process memory only; never written to disk."""
    os.environ["GROQ_API_KEY"] = key.strip()


def mask(key: str) -> str:
    return f"{key[:4]}…{key[-4:]}" if len(key) > 10 else ("set" if key else "")


@dataclass
class Settings:
    base_url: str
    model: str
    fallbacks: list[str]
    timeout_s: float
    budget_s: float

    @classmethod
    def from_env(cls) -> "Settings":
        load_dotenv()
        fb = os.environ.get("GROQ_FALLBACK_MODELS", DEFAULT_FALLBACKS)
        return cls(
            base_url=os.environ.get("GROQ_BASE_URL", DEFAULT_BASE).rstrip("/"),
            model=os.environ.get("GROQ_MODEL", DEFAULT_MODEL).strip() or DEFAULT_MODEL,
            fallbacks=[m.strip() for m in fb.split(",") if m.strip()],
            timeout_s=float(os.environ.get("GROQ_TIMEOUT_S", "40")),
            budget_s=float(os.environ.get("GROQ_BUDGET_S", "75")),
        )


# ------------------------------------------------------------------------------------------ images
def sniff_mime(data: bytes) -> str | None:
    if data[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return None


def downscale(img: Image, max_side: int = 1600) -> Image:
    """Shrink large photos (cheaper, faster). Pillow optional: without it the image is sent as is."""
    try:
        from PIL import Image as PILImage
    except Exception:  # pragma: no cover
        return img
    try:
        im = PILImage.open(io.BytesIO(img.data))
        if max(im.size) <= max_side:
            return img
        im.thumbnail((max_side, max_side))
        out = io.BytesIO()
        im.convert("RGB").save(out, format="JPEG", quality=88)
        return Image(out.getvalue(), "image/jpeg", img.label)
    except Exception:
        return img


def _sheet(images: list[tuple[int, Image]], side: int = 1536) -> Image:
    """Tile several photos into one JPEG; every tile carries its photo number burned into the corner."""
    from PIL import Image as PILImage, ImageDraw, ImageFont

    n = len(images)
    cols = 1 if n == 1 else 2
    rows = (n + cols - 1) // cols
    cell_w, cell_h = side // cols, side // max(rows, 1) if rows > 1 else side
    sheet = PILImage.new("RGB", (cell_w * cols, cell_h * rows), "white")
    try:
        font = ImageFont.load_default(size=max(28, cell_w // 14))
    except TypeError:  # older Pillow
        font = ImageFont.load_default()
    for k, (idx, img) in enumerate(images):
        try:
            tile = PILImage.open(io.BytesIO(img.data)).convert("RGB")
        except Exception:
            tile = PILImage.new("RGB", (cell_w, cell_h), "grey")
        tile.thumbnail((cell_w - 8, cell_h - 8))
        x, y = (k % cols) * cell_w + 4, (k // cols) * cell_h + 4
        sheet.paste(tile, (x, y))
        draw = ImageDraw.Draw(sheet)
        tag = f"#{idx}"
        draw.rectangle([x, y, x + len(tag) * max(18, cell_w // 22) + 14, y + max(36, cell_w // 12)], fill=(14, 116, 190))
        draw.text((x + 8, y + 2), tag, fill="white", font=font)
    out = io.BytesIO()
    sheet.save(out, format="JPEG", quality=85)
    return Image(out.getvalue(), "image/jpeg")


def _cap(k: int, img: Image) -> str:
    return f"photo #{k}" + (f" ({img.label})" if img.label else "")


def pack_images(images: list[Image], limit: int = MAX_IMAGES_PER_REQUEST) -> tuple[list[Image], list[str]]:
    """<= limit images go through as they are. More are tiled into `limit` numbered contact sheets.

    Returns (images to send, one caption per image telling the model which photo numbers it holds).
    """
    imgs = [downscale(i) for i in images]
    if len(imgs) <= limit:
        return imgs, [_cap(k, im) for k, im in enumerate(imgs, start=1)]
    # Keep the first (limit-1) photos individually at full detail; tile the remainder into the last sheet(s).
    keep = limit - 1
    singles = imgs[:keep]
    rest = [(k, imgs[k - 1]) for k in range(keep + 1, len(imgs) + 1)]
    out = list(singles)
    caps = [_cap(k, imgs[k - 1]) for k in range(1, keep + 1)]
    out.append(_sheet(rest))
    caps.append("contact sheet with photos " + ", ".join(f"#{k}" for k, _ in rest) + " (each tile is numbered)")
    return out, caps


def to_json_schema(node: Any) -> Any:
    """Turn the Gemini-style response schemas some agents already define ("OBJECT", "STRING"...) into plain JSON Schema,
    so the same shape can be spelled out in a Groq prompt (Groq JSON mode needs the shape described in the prompt)."""
    if isinstance(node, dict):
        out = {}
        for k, v in node.items():
            if k == "type" and isinstance(v, str):
                out[k] = v.lower()
            elif k == "nullable":
                continue
            else:
                out[k] = to_json_schema(v)
        return out
    if isinstance(node, list):
        return [to_json_schema(x) for x in node]
    return node


def schema_hint(schema: dict[str, Any]) -> str:
    return ("Answer with ONE JSON object (no prose, no markdown fences) that validates against this JSON Schema:\n"
            + json.dumps(to_json_schema(schema), separators=(",", ":")))


# ------------------------------------------------------------------------------------------ parsing
_THINK = re.compile(r"<think>.*?</think>", re.S | re.I)


def extract_json(text: str) -> dict[str, Any]:
    t = _THINK.sub("", text or "").strip()
    if "```" in t:
        inner = t.split("```", 2)[1]
        t = inner[4:] if inner.lower().startswith("json") else inner
    start, end = t.find("{"), t.rfind("}")
    if start < 0 or end < start:
        raise GroqError("no JSON object found in model output")
    try:
        obj = json.loads(t[start:end + 1])
    except json.JSONDecodeError as exc:
        raise GroqError(f"model output was not valid JSON: {exc}") from exc
    if not isinstance(obj, dict):
        raise GroqError("model output JSON was not an object")
    return obj


# ------------------------------------------------------------------------------------------ transport
Opener = Callable[..., Any]


def _post(url: str, body: dict[str, Any], key: str, timeout: float, opener: Opener | None = None) -> dict[str, Any]:
    req = urllib.request.Request(
        url, data=json.dumps(body).encode("utf-8"), method="POST",
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {key}",
                 "User-Agent": "cube-pod/1.0"})
    with (opener or urllib.request.urlopen)(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _http_detail(exc: urllib.error.HTTPError) -> str:
    raw = exc.read().decode("utf-8", "replace")
    try:
        raw = json.loads(raw)["error"]["message"]
    except Exception:
        raw = raw[:200]
    return " ".join(str(raw).split())[:200]


def chat(system: str, user_text: str, images: list[Image] | None = None, *, json_mode: bool = True,
         max_tokens: int = 4096, temperature: float = 0.1, settings: Settings | None = None,
         opener: Opener | None = None) -> GroqResult:
    """One logical call = one successful completion.

    Order: primary model, then each fallback. Per model, optional parameters the model may reject
    (reasoning_effort, response_format) are dropped on a 400 and the same model is retried once.
    429 / 5xx / network errors move on to the next model. The whole thing is bounded by budget_s.
    """
    s = settings or Settings.from_env()
    key = api_key()
    if not key:
        raise GroqError("GROQ_API_KEY is not set (put it in .env or paste it in the app's Connect Groq box)")

    content: list[dict[str, Any]] = [{"type": "text", "text": user_text}]
    if images:
        sent, captions = pack_images(images)
        for img, cap in zip(sent, captions):
            content.append({"type": "text", "text": f"{cap}:"})
            b64 = base64.b64encode(img.data).decode("ascii")
            content.append({"type": "image_url", "image_url": {"url": f"data:{img.mime};base64,{b64}"}})
    messages = [{"role": "system", "content": system},
                {"role": "user", "content": content if images else user_text}]

    models = [s.model] + [m for m in s.fallbacks if m != s.model]
    deadline = time.monotonic() + s.budget_s
    errors: list[str] = []
    attempts = 0
    for model in models:
        optional = {"reasoning_effort": "none"}          # instruct mode: no hidden thinking tokens
        use_json = json_mode
        for _ in range(3):
            remaining = deadline - time.monotonic()
            if remaining < 1.0:
                errors.append(f"gave up after {s.budget_s:.0f}s")
                raise GroqError("; ".join(dict.fromkeys(errors)))
            body: dict[str, Any] = {"model": model, "messages": messages, "temperature": temperature,
                                    "max_completion_tokens": max_tokens, **optional}
            if use_json:
                body["response_format"] = {"type": "json_object"}
            attempts += 1
            t0 = time.monotonic()
            try:
                data = _post(f"{s.base_url}/chat/completions", body, key, min(s.timeout_s, remaining), opener)
            except urllib.error.HTTPError as exc:
                detail = _http_detail(exc)
                errors.append(f"{model}: HTTP {exc.code} {detail}")
                if exc.code == 400 and optional:
                    optional = {}                        # model rejected reasoning_effort: retry without it
                    continue
                if exc.code == 400 and use_json:
                    use_json = False                     # model rejected JSON mode: retry without it
                    continue
                if exc.code in (401, 403):
                    raise GroqError(f"Groq rejected the API key (HTTP {exc.code}). Check GROQ_API_KEY.") from exc
                break                                    # 404 / 429 / 5xx / other 400: next model
            except (urllib.error.URLError, TimeoutError, OSError) as exc:
                errors.append(f"{model}: {exc}")
                break
            latency = int((time.monotonic() - t0) * 1000)
            try:
                text = data["choices"][0]["message"]["content"] or ""
            except (KeyError, IndexError, TypeError) as exc:
                errors.append(f"{model}: response had no content")
                break
            text = _THINK.sub("", text).strip()
            if not text:
                errors.append(f"{model}: empty response")
                break
            res = GroqResult(text, data.get("model") or model, latency, attempts, data.get("usage") or {})
            if json_mode:
                try:
                    res.json = extract_json(text)
                except GroqError as exc:
                    errors.append(f"{model}: {exc}")
                    break
            return res
    raise GroqError("; ".join(dict.fromkeys(errors)) or "no model available")


def list_models(settings: Settings | None = None, opener: Opener | None = None) -> list[str]:
    s = settings or Settings.from_env()
    key = api_key()
    if not key:
        raise GroqError("GROQ_API_KEY is not set")
    req = urllib.request.Request(f"{s.base_url}/models", headers={"Authorization": f"Bearer {key}", "User-Agent": "cube-pod/1.0"})
    try:
        with (opener or urllib.request.urlopen)(req, timeout=min(s.timeout_s, 20)) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raise GroqError(f"HTTP {exc.code} {_http_detail(exc)}") from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise GroqError(f"unreachable: {exc}") from exc
    return sorted(m.get("id", "") for m in data.get("data", []) if m.get("id"))


def status() -> dict[str, Any]:
    """Safe-to-show configuration: never includes the key itself."""
    s = Settings.from_env()
    k = api_key()
    return {"provider": "groq", "key_set": bool(k), "key_hint": mask(k), "model": s.model,
            "fallback_models": s.fallbacks, "base_url": s.base_url}
