"""Pack Manager engine: does the open box contain exactly what the customer ordered?

  Groq vision  ->  DESCRIBES what is in the box (blind to the order: it cannot echo the order back)
  this module  ->  deterministically matches the description to the order lines and decides

Decision: SEAL | STOP & FIX | UNCERTAIN.  UNCERTAIN is valid and is never turned into SEAL:
  * photo unusable / poor, contents hidden, counts cut off, low-confidence items  -> UNCERTAIN (a person looks)
  * a visible, definite problem (missing, wrong item/colour/variant, wrong quantity, extra item) -> STOP & FIX
  * everything matched, nothing doubtful                                          -> SEAL

Order line: {"sku", "name", "colour", "variant", "quantity"}  (name falls back to the catalogue title for the SKU).
"""
from __future__ import annotations

import json
import time
from functools import lru_cache
from pathlib import Path
from typing import Any, Callable

from shared.utils import groq_client
from shared.utils.textmatch import (COLOUR_FAMILIES, PACKAGING, is_placeholder, match_colour, match_variant,
                                    product_words, words)

PROMPT_VERSION = "pck-prompt/1.0-blind-groq"
REPO_ROOT = Path(__file__).resolve().parents[2]
CATALOGUE = REPO_ROOT / "agents" / "returns" / "reference" / "catalogue.json"
DUNNAGE = PACKAGING | {"paper", "bubble", "invoice", "slip", "receipt", "flyer", "insert", "dunnage", "filler", "air",
                       "pillow", "tissue", "foam", "padding", "peanut", "label", "note", "card", "leaflet", "wrapper"}
COLOUR_WORDS = {w for fam in COLOUR_FAMILIES for w in fam}

SYSTEM = """You are the OBSERVATION component of a warehouse packing-verification system.
You look at photographs of an OPEN package before it is sealed and report, literally, what physical items are inside.
You are NOT told what was ordered, and you must not guess. A separate rules engine compares your report with the order.

Rules:
1. Describe only what you can actually see. Never assume or "complete" a set.
2. List each distinct product separately (a black t-shirt and a red t-shirt are two entries). Count identical units.
3. If a stack/pile hides units, or part of the box is cut off, set count_fully_visible=false. A partial count is honest.
4. Give each item's colour and any size/variant/label text you can read (e.g. "500ml", "XL", "3-pack").
5. Packing material (paper, bubble wrap, air pillows, invoices, flyers) is NOT an item: list it under packaging_or_dunnage.
6. If the photo is blurry, dark, glary, cropped, or the contents are not visible, say so in photo_quality. UNCERTAIN is a correct answer.
7. Output ONE JSON object only. No prose, no markdown fences."""

SHAPE = """{
  "photo_quality": "good" | "poor" | "unusable",
  "photo_quality_reason": string,
  "contents_fully_visible": boolean,      // is the whole interior of the box visible?
  "items": [
    { "name": string,                      // plain product name, e.g. "t-shirt", "cap", "usb cable"
      "colour": string | null,
      "variant_or_size": string | null,    // size / volume / pack size, as printed or evident
      "label_text": string | null,         // any readable text on the item or its package
      "count": int | null,                 // number of identical units you can see
      "count_fully_visible": boolean,
      "photo": int | null,                 // which photo number shows it
      "confidence": "high" | "medium" | "low" }
  ],
  "packaging_or_dunnage": [string],
  "notes": string
}"""


class VisionError(Exception):
    pass


# ------------------------------------------------------------------------------------------ catalogue
@lru_cache(maxsize=1)
def catalogue() -> dict[str, dict]:
    try:
        return {i["sku"]: i for i in json.loads(CATALOGUE.read_text(encoding="utf-8"))["items"]}
    except Exception:
        return {}


def parse_lines(text: str) -> list[dict]:
    """'SKU-A:2;SKU-B:1' -> order lines (names come from the catalogue)."""
    out: dict[str, int] = {}
    for part in filter(None, (text or "").split(";")):
        sku, _, qty = part.partition(":")
        out[sku.strip()] = out.get(sku.strip(), 0) + int(qty or 1)
    return [{"sku": k, "quantity": v} for k, v in out.items()]


def enrich(line: dict) -> dict:
    """Fill name/colour from the catalogue; infer colour from the name when it is not given."""
    item = catalogue().get(line.get("sku", ""), {})
    name = (line.get("name") or item.get("title") or line.get("sku") or "item").strip()
    colour = (line.get("colour") or "").strip() or None
    if colour is None:
        found = [w for w in words(name) if w in COLOUR_WORDS]
        colour = found[0] if found else None
    try:
        qty = int(line.get("quantity", 1))
    except (TypeError, ValueError):
        qty = 1
    return {"sku": line.get("sku") or name.upper().replace(" ", "-"), "name": name, "colour": colour,
            "variant": (line.get("variant") or "").strip() or None, "quantity": max(qty, 0),
            "words": set(product_words(name)) or set(words(name)),
            "lookalikes": item.get("lookalike_skus", [])}


# ------------------------------------------------------------------------------------------ vision
def _int(v: Any) -> int | None:
    if isinstance(v, bool) or v is None:
        return None
    try:
        n = int(float(v))
    except (TypeError, ValueError):
        return None
    return n if 0 <= n <= 1000 else None


def normalise(raw: dict) -> dict:
    if not isinstance(raw, dict) or "items" not in raw or not isinstance(raw["items"], list):
        raise VisionError("model answer has no items list; not a usable observation")
    q = str(raw.get("photo_quality", "poor")).strip().lower()
    q = q if q in ("good", "poor", "unusable") else "poor"
    items = []
    for it in raw["items"]:
        if not isinstance(it, dict):
            continue
        name = str(it.get("name") or "").strip()
        if not name:
            continue
        conf = str(it.get("confidence", "low")).strip().lower()
        items.append({
            "name": name,
            "colour": (str(it["colour"]).strip() or None) if it.get("colour") is not None else None,
            "variant_or_size": (str(it["variant_or_size"]).strip() or None) if it.get("variant_or_size") is not None else None,
            "label_text": (str(it["label_text"]).strip() or None) if it.get("label_text") is not None else None,
            "count": _int(it.get("count")),
            "count_fully_visible": it.get("count_fully_visible") is True,
            "photo": _int(it.get("photo")),
            "confidence": conf if conf in ("high", "medium", "low") else "low",
        })
    dun = raw.get("packaging_or_dunnage")
    return {"photo_quality": q, "photo_quality_reason": str(raw.get("photo_quality_reason") or "").strip(),
            "contents_fully_visible": raw.get("contents_fully_visible") is True, "items": items,
            "packaging_or_dunnage": [str(d) for d in dun if isinstance(d, (str, int, float))] if isinstance(dun, list) else [],
            "notes": str(raw.get("notes") or "").strip()}


def observe(photos: list[dict], chat_fn: Callable[..., Any] | None = None) -> tuple[dict, str, int, str]:
    chat = chat_fn or groq_client.chat
    imgs = []
    for p in photos:
        data = Path(p["path"]).read_bytes() if p.get("path") else p["bytes"]
        imgs.append(groq_client.Image(data, groq_client.sniff_mime(data) or "image/jpeg", p.get("role", "")))
    prompt = (f"There are {len(imgs)} photo(s) of ONE open package. List every physical item inside.\n"
              f"Return JSON exactly in this shape:\n{SHAPE}")
    try:
        res = chat(SYSTEM, prompt, imgs, json_mode=True, max_tokens=2500)
    except groq_client.GroqError as exc:
        raise VisionError(str(exc)) from exc
    return normalise(res.json), res.text, res.latency_ms, res.model


# ------------------------------------------------------------------------------------------ matching
def _is_dunnage(name: str) -> bool:
    w = product_words(name) or words(name)
    return bool(w) and all(x in DUNNAGE for x in w)


def _score(line: dict, det: dict) -> tuple[float, str, str]:
    dwords = set(product_words(f'{det["name"]} {det.get("label_text") or ""}')) | set(words(det["name"]))
    shared = line["words"] & dwords
    overlap = len(shared) / max(len(line["words"]), 1)
    colour = match_colour(line["colour"], det["colour"]) if line["colour"] else "not_in_spec"
    variant = "not_in_spec"
    if line["variant"]:
        variant = match_variant(line["variant"], " ".join(filter(None, [det.get("variant_or_size"), det.get("label_text")])) or None)
    return overlap, colour, variant


def match(lines: list[dict], obs: dict) -> dict:
    """Assign each detected item to the best order line; derive missing / wrong / extra / quantity findings."""
    dets = [d for d in obs["items"] if not is_placeholder(d["name"]) and not _is_dunnage(d["name"])]
    ignored = [d["name"] for d in obs["items"] if d not in dets]
    rank = {"match": 0, "not_in_spec": 0, "unknown": 1, "mismatch": 2}
    assigned: dict[int, list[dict]] = {i: [] for i in range(len(lines))}
    unmatched: list[dict] = []
    for d in dets:
        cands = []
        for i, ln in enumerate(lines):
            overlap, colour, variant = _score(ln, d)
            if overlap >= 0.5:
                cands.append((rank[colour] + rank[variant], -overlap, i, colour, variant))
        if not cands:
            unmatched.append(d)
            continue
        cands.sort()
        _, _, i, colour, variant = cands[0]
        assigned[i].append({**d, "_colour": colour, "_variant": variant})

    visible_all = obs["contents_fully_visible"] and obs["photo_quality"] == "good"
    results, wrong, extra, uncertain_extra = [], [], [], []
    for i, ln in enumerate(lines):
        got = assigned[i]
        good, bad, unsure = [], [], []
        for d in got:
            if "mismatch" in (d["_colour"], d["_variant"]):
                bad.append(d)
            elif "unknown" in (d["_colour"], d["_variant"]) or d["confidence"] == "low":
                unsure.append(d)
            else:
                good.append(d)
        counted = sum(d["count"] or 0 for d in good)
        partial = any(d["count"] is None or not d["count_fully_visible"] for d in good)
        r = {"sku": ln["sku"], "name": ln["name"], "colour": ln["colour"], "variant": ln["variant"],
             "expected_qty": ln["quantity"], "observed_qty": counted, "status": "ok", "detail": ""}
        for d in bad:
            wrong.append({"expected": f'{ln["name"]}' + (f' ({ln["colour"]})' if ln["colour"] else ""),
                          "detected": " ".join(filter(None, [d["colour"], d["name"], d.get("variant_or_size")])),
                          "qty": d["count"], "sku": ln["sku"]})
        if bad and not good:
            r["status"] = "wrong_item"
            r["detail"] = "Expected " + r["name"] + (f' ({ln["colour"]})' if ln["colour"] else "") + \
                "; detected " + "; ".join(" ".join(filter(None, [d["colour"], d["name"], d.get("variant_or_size")])) for d in bad) + "."
        elif not got:
            if visible_all:
                r["status"], r["detail"] = "missing", "Not found in the box; the whole interior is visible."
            else:
                r["status"], r["detail"] = "uncertain", "Not seen, but the photo does not show the whole box clearly, so it may be hidden."
        elif unsure and not good:
            r["status"], r["detail"] = "uncertain", "A matching item was seen but its colour/variant/identity is not clear enough to confirm."
        elif partial:
            if counted > ln["quantity"]:
                r["status"], r["detail"] = "wrong_quantity", f"At least {counted} visible, {ln['quantity']} ordered."
            else:
                r["status"], r["detail"] = "uncertain", f"{counted} counted but the count is not fully visible (stacked or cut off); {ln['quantity']} ordered."
        elif counted != ln["quantity"]:
            r["status"] = "wrong_quantity"
            r["detail"] = f"{'Short' if counted < ln['quantity'] else 'Over'} by {abs(ln['quantity'] - counted)}: counted {counted}, ordered {ln['quantity']}."
        else:
            r["detail"] = f"{counted} of {ln['quantity']} confirmed."
        if r["status"] == "ok" and unsure:
            r["status"], r["detail"] = "uncertain", r["detail"] + " Another matching item is unclear."
        r["detected"] = [{"name": d["name"], "colour": d["colour"], "variant_or_size": d.get("variant_or_size"),
                          "count": d["count"], "confidence": d["confidence"], "photo": d["photo"]} for d in got]
        results.append(r)
    for d in unmatched:
        rec = {"detected": " ".join(filter(None, [d["colour"], d["name"], d.get("variant_or_size")])), "qty": d["count"],
               "confidence": d["confidence"], "photo": d["photo"]}
        (uncertain_extra if d["confidence"] == "low" else extra).append(rec)
    return {"lines": results, "wrong_items": wrong, "extra_items": extra, "possible_extra_items": uncertain_extra,
            "ignored_packaging": ignored + obs["packaging_or_dunnage"]}


# ------------------------------------------------------------------------------------------ decision
def decide(lines: list[dict], obs: dict | None) -> dict:
    """Pure function: (order lines, observation or None) -> structured verdicts + SEAL / STOP & FIX / UNCERTAIN."""
    if obs is None or obs["photo_quality"] == "unusable" or not obs["items"] and obs["photo_quality"] != "good":
        why = ("No usable observation of the box." if obs is None
               else f'Photo unusable: {obs["photo_quality_reason"] or "contents cannot be seen"}.')
        return {"decision": "UNCERTAIN", "reason": why, "verdicts": {k: "UNCERTAIN" for k in
                ("items_present", "quantities_correct", "variants_correct", "no_extra_items")},
                "match": {"lines": [{"sku": l["sku"], "name": l["name"], "colour": l["colour"], "variant": l["variant"],
                                     "expected_qty": l["quantity"], "observed_qty": None, "status": "uncertain",
                                     "detail": why, "detected": []} for l in lines],
                          "wrong_items": [], "extra_items": [], "possible_extra_items": [], "ignored_packaging": []}}
    m = match(lines, obs)
    st = [r["status"] for r in m["lines"]]
    v_present = "FAIL" if "missing" in st else ("UNCERTAIN" if any(s == "uncertain" and not r["detected"] for s, r in zip(st, m["lines"])) else "PASS")
    v_qty = "FAIL" if "wrong_quantity" in st else ("UNCERTAIN" if any(s == "uncertain" and r["detected"] for s, r in zip(st, m["lines"])) else "PASS")
    v_var = "FAIL" if ("wrong_item" in st or m["wrong_items"]) else "PASS"
    v_extra = "FAIL" if m["extra_items"] else ("UNCERTAIN" if m["possible_extra_items"] else "PASS")
    verdicts = {"items_present": v_present, "quantities_correct": v_qty, "variants_correct": v_var, "no_extra_items": v_extra}
    if obs["photo_quality"] == "poor":
        # We don't vouch for a box we couldn't see properly; visible FAILs stand.
        verdicts = {k: ("UNCERTAIN" if v == "PASS" else v) for k, v in verdicts.items()}
    vals = set(verdicts.values())
    decision = "STOP & FIX" if "FAIL" in vals else ("UNCERTAIN" if "UNCERTAIN" in vals else "SEAL")
    problems = []
    for r in m["lines"]:
        if r["status"] not in ("ok",):
            problems.append(f'{r["name"]}: {r["detail"]}')
    for e in m["extra_items"]:
        problems.append(f'Unexpected extra item: {e["detected"]}' + (f' ×{e["qty"]}' if e["qty"] else "") + ".")
    for e in m["possible_extra_items"]:
        problems.append(f'Possible extra item (low confidence): {e["detected"]}.')
    if decision == "SEAL":
        reason = "Every ordered item, quantity and variant is confirmed and nothing extra is in the box."
    else:
        reason = " ".join(problems) or "Photo quality is too poor to vouch for the box."
    return {"decision": decision, "reason": reason, "verdicts": verdicts, "match": m}


def inspect_order(payload: dict, chat_fn: Callable[..., Any] | None = None) -> dict:
    """payload: {order_lines:[...], photos:[{role,ref,path|bytes}]}. Never raises for model problems."""
    lines = [enrich(l) for l in payload["order_lines"]]
    photos = payload.get("photos") or []
    obs = raw = None
    latency = None
    model = "unavailable"
    error = None
    if not photos:
        error = "No photos supplied"
    else:
        t0 = time.monotonic()
        try:
            obs, raw, latency, model = observe(photos, chat_fn)
        except VisionError as exc:
            error, latency = str(exc), int((time.monotonic() - t0) * 1000)
        except OSError as exc:
            error = f"could not read a photo: {exc}"
    d = decide(lines, obs)
    confs = {"high": 0.9, "medium": 0.65, "low": 0.4}
    items = (obs or {}).get("items") or []
    confidence = min((confs[i["confidence"]] for i in items), default=None) if d["decision"] != "UNCERTAIN" else None
    return {"status": "complete" if obs else "pending", "decision": d["decision"], "reason": d["reason"],
            "verdicts": d["verdicts"], "match": d["match"], "observation": obs, "confidence": confidence,
            "expected": [{"sku": l["sku"], "name": l["name"], "colour": l["colour"], "variant": l["variant"],
                          "quantity": l["quantity"]} for l in lines],
            "model": {"provider": "groq", "model": model, "prompt_version": PROMPT_VERSION, "latency_ms": latency,
                      "error": error, "raw_output": raw}}
