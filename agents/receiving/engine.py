"""Receiving Manager engine: a Python port of the Round 2 agent (agents/receiving/round2/lib/*.ts), driven by Groq.

Why a port: the Round 2 agent is a Next.js/TypeScript project (Node, npm, sharp, Supabase). Running it from the Pod
needed `npm ci` plus a Gemini key. This module keeps the SAME judgement rules and swaps the vision call for Groq,
so the whole Pod is one `pip install` away from running.

Division of labour (unchanged from Round 2):
  * Groq (vision) only DESCRIBES the photos. It is BLIND to the purchase order, so it cannot echo the PO back.
  * match.py-style word matching + decide() compare that description with the PO line and any operator counts.
  * UNCERTAIN is a first-class verdict: unclear / poor photos / conflicting counts never become a PASS.

inspect_unit(payload) returns a dict shaped like the Round 2 EvidenceRecord (receiving-evidence/0.2), which
agents/receiving/app.py maps onto the Pod's Evidence Record contract.
"""
from __future__ import annotations

import hashlib
import re
import time
from pathlib import Path
from typing import Any, Callable

from shared.utils import groq_client

PROMPT_VERSION = "rcv-prompt/0.3-blind-groq"
CONTRACT_VERSION = "receiving-evidence/0.2"

SYSTEM_PROMPT = """You are a warehouse receiving inspector. You describe photos of a supplier delivery exactly as they are.

Rules:
- Describe ONLY what is visible. Never assume or guess what "should" be there.
- If something cannot be seen clearly, say "unclear" (or null for counts and text). That is a correct answer.
- Photos are labelled "photo #1", "photo #2", ... Cite photo numbers for what you report.
- Count only what you can actually see. If cartons or units are hidden or cut off, set the matching "fully_visible" flag to false.
- Damage types: crushing (dents, collapsed corners, bent boxes), water (stains, darkened or warped cardboard, wet marks), tears (rips, holes, torn tape or packaging).
- Answer with ONE JSON object only, in the required shape. No prose, no markdown."""

SHAPE = """{
  "photo_quality": "good" | "poor" | "unusable",
  "photo_quality_reason": string,
  "product_type": string,            // 1-3 plain words e.g. "water bottle"; "unclear" if not identifiable
  "product_description": string,     // one sentence
  "product_photos": [int],
  "colour_seen": string | null,      // main colour of the product itself (not the box)
  "label_text": string | null,       // every word/number readable on labels, boxes or the product
  "cartons_visible": int | null,
  "cartons_fully_visible": boolean,
  "units_in_open_carton": int | null,
  "open_carton_fully_visible": boolean,
  "count_photos": [int],
  "carton_damage": "none" | "damaged" | "unclear",
  "carton_damage_types": ["crushing" | "water" | "tears"],
  "carton_damage_reason": string,
  "carton_damage_photos": [int],
  "unit_damage": "none" | "damaged" | "unclear",
  "unit_damage_types": ["crushing" | "water" | "tears"],
  "unit_damage_reason": string,
  "unit_damage_photos": [int],
  "opened_unit_visible": boolean,    // true only if a unit is shown out of its packaging
  "parts_seen": [string],            // separate parts/accessories visible with the unit
  "defect_present": "yes" | "no" | "unclear",
  "defect_description": string,
  "defect_photos": [int]
}"""


def build_user_prompt(roles: list[str]) -> str:
    listing = ", ".join(f"#{i + 1} {r}" for i, r in enumerate(roles))
    return f"""There are {len(roles)} photo(s): {listing}.

Describe the delivery:
1. photo_quality: good / poor (blurry, dark, partly cut off) / unusable, with a reason.
2. product_type: what the product is, in 1-3 plain words. "unclear" if you can't tell.
3. product_description: one sentence describing the product.
4. colour_seen: the main colour of the product itself (not the box), or null.
5. label_text: copy every word and number you can read on labels, boxes or the product (sizes, volumes, counts, names). null if none.
6. cartons_visible: how many whole cartons you can count; units_in_open_carton: how many units inside an opened carton. null if not shown.
7. carton_damage and unit_damage: none / damaged / unclear, with types and photo numbers.
8. opened_unit_visible: true only if a unit is shown out of its packaging. parts_seen: each separate part or accessory visible with it (e.g. "lid", "scoop", "manual").
9. defect_present: any other obvious defect (broken, cracked, stained, misprinted): yes / no / unclear.

Return JSON exactly in this shape:
{SHAPE}"""


# ------------------------------------------------------------------------------------------ observation
class VisionError(Exception):
    pass


_TRI = {"yes", "no", "unclear"}
_DMG = {"none", "damaged", "unclear"}
_TYPES = {"crushing", "water", "tears"}


def _int_or_none(v: Any) -> int | None:
    if isinstance(v, bool) or v is None:
        return None
    try:
        n = int(float(v))
    except (TypeError, ValueError):
        return None
    return n if 0 <= n <= 10000 else None


def _photos(v: Any) -> list[int]:
    if not isinstance(v, list):
        return []
    out = []
    for x in v:
        n = _int_or_none(x)
        if n is not None and n >= 1:
            out.append(n)
    return out[:20]


def _bool(v: Any) -> bool:
    return v is True or (isinstance(v, str) and v.strip().lower() in ("true", "yes"))


def _enum(v: Any, allowed: set[str], default: str) -> str:
    s = str(v).strip().lower() if v is not None else ""
    return s if s in allowed else default


def normalise_observation(raw: dict[str, Any]) -> dict[str, Any]:
    """Validate the model's answer leniently: a malformed field degrades to 'unclear'/null, never to a PASS."""
    if not isinstance(raw, dict) or "product_type" not in raw:
        raise VisionError("model answer has no product_type; not a usable observation")
    q = _enum(raw.get("photo_quality"), {"good", "poor", "unusable"}, "poor")

    def types(v: Any) -> list[str]:
        return [t for t in (str(x).strip().lower() for x in (v or []) if isinstance(x, (str, int, float))) if t in _TYPES]

    def text(v: Any) -> str:
        return str(v).strip() if v is not None else ""

    parts = raw.get("parts_seen")
    label = raw.get("label_text")
    colour = raw.get("colour_seen")
    return {
        "photo_quality": q, "photo_quality_reason": text(raw.get("photo_quality_reason")),
        "product_type": text(raw.get("product_type")) or "unclear",
        "product_description": text(raw.get("product_description")),
        "product_photos": _photos(raw.get("product_photos")),
        "colour_seen": text(colour) or None if colour is not None else None,
        "label_text": text(label) or None if label is not None else None,
        "cartons_visible": _int_or_none(raw.get("cartons_visible")),
        "cartons_fully_visible": _bool(raw.get("cartons_fully_visible")),
        "units_in_open_carton": _int_or_none(raw.get("units_in_open_carton")),
        "open_carton_fully_visible": _bool(raw.get("open_carton_fully_visible")),
        "count_photos": _photos(raw.get("count_photos")),
        "carton_damage": _enum(raw.get("carton_damage"), _DMG, "unclear"),
        "carton_damage_types": types(raw.get("carton_damage_types")),
        "carton_damage_reason": text(raw.get("carton_damage_reason")),
        "carton_damage_photos": _photos(raw.get("carton_damage_photos")),
        "unit_damage": _enum(raw.get("unit_damage"), _DMG, "unclear"),
        "unit_damage_types": types(raw.get("unit_damage_types")),
        "unit_damage_reason": text(raw.get("unit_damage_reason")),
        "unit_damage_photos": _photos(raw.get("unit_damage_photos")),
        "opened_unit_visible": _bool(raw.get("opened_unit_visible")),
        "parts_seen": [text(p) for p in parts if isinstance(p, (str, int, float))] if isinstance(parts, list) else [],
        "defect_present": _enum(raw.get("defect_present"), _TRI, "unclear"),
        "defect_description": text(raw.get("defect_description")),
        "defect_photos": _photos(raw.get("defect_photos")),
    }


# ------------------------------------------------------------------------------------------ matching
from shared.utils.textmatch import (  # noqa: E402  deterministic word matching, shared with the Pack Manager
    COLOUR_FAMILIES, PACKAGING, is_packaging_only, is_placeholder, match_colour, match_identity, match_variant,
    missing_components, product_words, words)


# ------------------------------------------------------------------------------------------ decisions
def _status_verdict(s: str) -> str:
    return "PASS" if s == "match" else ("FAIL" if s == "mismatch" else "UNCERTAIN")


def _no_obs_reason(obs: dict | None) -> str:
    if not obs:
        return "No model observation (model unavailable or output invalid); needs review."
    return f"Photos unusable: {obs.get('photo_quality_reason') or 'no reason given'}."


def _uncertain_none(name: str, expected: Any, obs: dict | None) -> dict:
    return {"name": name, "expected": expected, "verdict": "UNCERTAIN", "observed": None, "source": "none",
            "photo_refs": [], "reason": _no_obs_reason(obs), "confidence": None}


def _identity(po: dict, obs: dict | None) -> dict:
    exp = f"{po['sku']} · {po['product_title']}"
    if not obs or obs["photo_quality"] == "unusable":
        return _uncertain_none("identity", exp, obs)
    m = match_identity(po["product_title"], po["sku"], obs["product_type"], obs["product_description"], obs["label_text"])
    if m["status"] == "match":
        reason = f'Seen "{obs["product_type"]}"; shares "{", ".join(m["shared"])}" with the PO line.'
    elif m["status"] == "mismatch":
        reason = f'Seen "{obs["product_type"]}" ({obs["product_description"]}); no product word in common with "{po["product_title"]}".'
    elif m["packaging_only"]:
        reason = f'Only packaging was seen ("{obs["product_type"]}"); the product itself isn\'t visible and no label names it.'
    else:
        reason = "The model couldn't tell what the product is."
    return {"name": "identity", "expected": exp, "verdict": _status_verdict(m["status"]), "observed": obs["product_type"],
            "source": "model", "photo_refs": obs["product_photos"], "reason": reason}


def variant_colour_status(po: dict, obs: dict) -> dict:
    in_spec = po["spec_colour"].strip().lower() != "n/a"
    return {"colour": match_colour(po["spec_colour"], obs["colour_seen"]) if in_spec else "not_in_spec",
            "variant": match_variant(po["spec_variant"], obs["label_text"])}


def _variant_colour(po: dict, obs: dict | None) -> dict:
    in_spec = po["spec_colour"].strip().lower() != "n/a"
    exp = f'{po["spec_colour"]} · {po["spec_variant"]}' if in_spec else po["spec_variant"]
    if not obs or obs["photo_quality"] == "unusable":
        return _uncertain_none("variant_colour", exp, obs)
    st = variant_colour_status(po, obs)
    parts = [st["variant"]] + ([] if st["colour"] == "not_in_spec" else [st["colour"]])
    verdict = "FAIL" if "mismatch" in parts else ("UNCERTAIN" if "unknown" in parts else "PASS")
    notes = []
    if st["colour"] != "not_in_spec":
        notes.append(f'colour "{obs["colour_seen"]}" matches {po["spec_colour"]}' if st["colour"] == "match"
                     else f'wrong colour: "{obs["colour_seen"]}", spec is {po["spec_colour"]}' if st["colour"] == "mismatch"
                     else f'colour not determinable (seen: {obs["colour_seen"] or "nothing"})')
    notes.append(f'label shows "{po["spec_variant"]}"' if st["variant"] == "match"
                 else f'wrong variant: label reads "{obs["label_text"]}", spec is {po["spec_variant"]}' if st["variant"] == "mismatch"
                 else f'variant "{po["spec_variant"]}" not confirmed by any label text')
    observed = " · ".join(x for x in [(obs["colour_seen"] or "colour not seen") if in_spec else None, obs["label_text"] or "no label text"] if x)
    return {"name": "variant_colour", "expected": exp, "verdict": verdict, "observed": observed, "source": "model",
            "photo_refs": obs["product_photos"], "reason": "; ".join(notes) + "."}


def _count_check(name: str, expected: int, operator: int | None, model_count: int | None, model_full: bool,
                 photo_refs: list[int]) -> tuple[dict, int | None]:
    label = "cartons" if name == "carton_count" else "units per carton"
    usable = model_count is not None and model_full
    if operator is not None:
        if usable and model_count != operator:
            return ({"name": name, "expected": expected, "verdict": "UNCERTAIN", "confidence": None, "source": "operator",
                     "observed": f"operator {operator} / photo {model_count}", "photo_refs": photo_refs,
                     "reason": f"Operator counted {operator} {label} but the photos show {model_count}; conflicting evidence, recount needed."}, None)
        corro = (" Photo count agrees." if usable else
                 f" Photos show only part of it ({model_count} visible), so the photo count isn't used." if model_count is not None
                 else " No photo count available.")
        return ({"name": name, "expected": expected, "observed": operator, "source": "operator", "photo_refs": photo_refs,
                 "verdict": "PASS" if operator == expected else "FAIL", "confidence": "high" if usable else "medium",
                 "reason": f"Operator counted {operator} {label}, {expected} ordered.{corro}"}, operator)
    if usable:
        return ({"name": name, "expected": expected, "observed": model_count, "source": "model", "photo_refs": photo_refs,
                 "verdict": "PASS" if model_count == expected else "FAIL", "confidence": "low",
                 "reason": f"Photos show {model_count} {label}, {expected} ordered. No operator count to cross-check."}, model_count)
    return ({"name": name, "expected": expected, "observed": model_count, "source": "model" if model_count is not None else "none",
             "photo_refs": photo_refs if model_count is not None else [], "verdict": "UNCERTAIN",
             "reason": (f"Photos show {model_count} {label} but not all of them are visible, and there's no operator count."
                        if model_count is not None else f"No operator count and no reliable photo count for {label}.")}, None)


def _quantity(po: dict, cartons: int | None, per: int | None) -> dict:
    base = {"name": "quantity", "expected": po["qty_ordered"], "source": "derived", "photo_refs": []}
    if cartons is None or per is None:
        return {**base, "verdict": "UNCERTAIN", "observed": None,
                "reason": "Total can't be derived: carton count or units per carton is uncertain."}
    got = cartons * per
    diff = got - po["qty_ordered"]
    tail = f" (short by {-diff})." if diff < 0 else f" ({diff} extra)." if diff > 0 else "."
    return {**base, "observed": got, "verdict": "PASS" if diff == 0 else "FAIL",
            "reason": f'{cartons} cartons × {per} units = {got}, {po["qty_ordered"]} ordered{tail} Assumes every carton holds the same count as the one that was opened.'}


def _damage(name: str, obs: dict | None, roles: list[str]) -> dict:
    if not obs or obs["photo_quality"] == "unusable":
        return _uncertain_none(name, "none", obs)
    carton = name == "carton_damage"
    status = obs["carton_damage" if carton else "unit_damage"]
    types = obs["carton_damage_types" if carton else "unit_damage_types"]
    said = obs["carton_damage_reason" if carton else "unit_damage_reason"]
    reason = f"No {'carton' if carton else 'product'} damage reported by the model." if is_placeholder(said) else said
    refs = obs["carton_damage_photos" if carton else "unit_damage_photos"]
    common = {"name": name, "expected": "none", "source": "model", "photo_refs": refs}
    if status == "none" and types:
        return {**common, "verdict": "UNCERTAIN", "observed": types,
                "reason": f'Model output contradicts itself: status "none" but lists {", ".join(types)}. {reason}'}
    if status == "damaged":
        return {**common, "verdict": "FAIL", "observed": types or ["unspecified"], "reason": reason}
    if status == "unclear":
        return {**common, "verdict": "UNCERTAIN", "observed": None, "reason": reason}
    shown = ((obs["cartons_visible"] or 0) > 0 or any(r in ("carton", "pallet") for r in roles)) if carton \
        else not is_placeholder(obs["product_type"])
    if not shown:
        return {**common, "verdict": "UNCERTAIN", "observed": None,
                "reason": "No carton in the photos, so its condition can't be vouched for." if carton
                else "The product can't be made out in the photos, so its condition can't be vouched for."}
    return {**common, "verdict": "PASS", "observed": "none", "reason": reason}


def _components(po: dict, obs: dict | None) -> dict:
    exp = po["spec_components"]
    if not obs or obs["photo_quality"] == "unusable":
        return _uncertain_none("components", exp, obs)
    seen = [p for p in obs["parts_seen"] if not is_placeholder(p)]
    common = {"name": "components", "expected": exp, "source": "model", "photo_refs": obs["product_photos"], "observed": seen}
    if not obs["opened_unit_visible"]:
        return {**common, "verdict": "UNCERTAIN", "reason": "No unit is shown out of its packaging, so components can't be checked."}
    missing = missing_components(exp, seen + [obs["product_type"]])
    if missing:
        return {**common, "verdict": "FAIL",
                "reason": f'Opened unit shown, but not seen: {", ".join(missing)}. Seen: {", ".join(seen) or "nothing listed"}.'}
    return {**common, "verdict": "PASS", "reason": f'All expected components seen: {", ".join(exp)}.'}


def _defects(obs: dict | None) -> dict:
    if not obs or obs["photo_quality"] == "unusable":
        return _uncertain_none("defects", "none", obs)
    dp = obs["defect_present"]
    return {"name": "defects", "expected": "none", "verdict": "FAIL" if dp == "yes" else "PASS" if dp == "no" else "UNCERTAIN",
            "observed": "none" if dp == "no" else (obs["defect_description"] or None), "source": "model",
            "photo_refs": obs["defect_photos"],
            "reason": obs["defect_description"] or ("No obvious defects seen." if dp == "no" else "Couldn't tell.")}


_RANK = {"low": 0, "medium": 1, "high": 2}


def decide(po: dict, obs: dict | None, counts: dict | None = None, roles: list[str] | None = None) -> list[dict]:
    counts, roles = counts or {}, roles or []
    usable = obs is not None and obs["photo_quality"] != "unusable"
    c_chk, c_val = _count_check("carton_count", po["cartons_ordered"], counts.get("cartons_received"),
                                obs["cartons_visible"] if usable else None, obs["cartons_fully_visible"] if usable else False,
                                obs["count_photos"] if usable else [])
    u_chk, u_val = _count_check("units_per_carton", po["units_per_carton_ordered"], counts.get("units_per_carton_counted"),
                                obs["units_in_open_carton"] if usable else None,
                                obs["open_carton_fully_visible"] if usable else False, obs["count_photos"] if usable else [])
    drafts = [_identity(po, obs), _variant_colour(po, obs), c_chk, u_chk, _quantity(po, c_val, u_val),
              _damage("carton_damage", obs, roles), _damage("unit_damage", obs, roles), _components(po, obs), _defects(obs)]
    out = []
    for c in drafts:
        # Poor photo: a PASS from the model is downgraded (we don't vouch for goods we couldn't see properly).
        if obs and obs["photo_quality"] == "poor" and c["verdict"] == "PASS" and c["source"] == "model":
            c = {**c, "verdict": "UNCERTAIN",
                 "reason": f'{c["reason"]} Downgraded from PASS: photo quality poor ({obs["photo_quality_reason"]}).'}
        if c["verdict"] == "UNCERTAIN":
            c = {**c, "confidence": None}
        elif "confidence" not in c:
            c = {**c, "confidence": ("medium" if obs and obs["photo_quality"] == "good" else "low") if c["source"] == "model" else "medium"}
        out.append(c)
    q = next(c for c in out if c["name"] == "quantity")
    if q["verdict"] != "UNCERTAIN":
        lv = [c["confidence"] for c in out if c["name"] in ("carton_count", "units_per_carton") and c["confidence"]]
        q["confidence"] = min(lv, key=lambda x: _RANK[x]) if lv else None
    return out


def overall_verdict(checks: list[dict]) -> str:
    if any(c["verdict"] == "FAIL" for c in checks):
        return "EXCEPTION"
    if any(c["verdict"] == "UNCERTAIN" for c in checks):
        return "REVIEW"
    return "ACCEPT"


def summarise(checks: list[dict], po: dict, obs: dict | None) -> dict:
    by = {c["name"]: c for c in checks}

    def num(c: dict) -> int | None:
        return c["observed"] if c["verdict"] != "UNCERTAIN" and isinstance(c["observed"], int) and not isinstance(c["observed"], bool) else None

    def dmg(c: dict) -> str:
        return "none" if c["verdict"] == "PASS" else "uncertain" if c["verdict"] == "UNCERTAIN" else (
            ";".join(c["observed"]) if isinstance(c["observed"], list) else str(c["observed"]))

    flags: list[str] = []
    if by["variant_colour"]["verdict"] == "FAIL" and obs:
        st = variant_colour_status(po, obs)
        if st["colour"] == "mismatch":
            flags.append("wrong_colour")
        if st["variant"] == "mismatch":
            flags.append("wrong_variant")
    if by["components"]["verdict"] == "FAIL":
        flags.append("missing_components")
    if by["defects"]["verdict"] == "FAIL":
        flags.append("obvious_defect")
    ident = by["identity"]["verdict"]
    return {"cartons_received": num(by["carton_count"]), "units_per_carton_counted": num(by["units_per_carton"]),
            "qty_received": num(by["quantity"]), "identity_match": "yes" if ident == "PASS" else "no" if ident == "FAIL" else "uncertain",
            "carton_damage": dmg(by["carton_damage"]), "unit_damage": dmg(by["unit_damage"]), "quality_flags": flags}


# ------------------------------------------------------------------------------------------ po row
def row_to_po(r: dict) -> dict:
    return {"unit_id": r["unit_id"], "org_id": r["org_id"], "po_number": r["po_number"], "po_line": int(r["po_line"] or 0),
            "supplier": r.get("supplier", ""), "sku": r["sku"], "asin": r.get("asin", ""), "product_title": r["product_title"],
            "spec_colour": r.get("spec_colour") or "n/a", "spec_variant": r.get("spec_variant") or "",
            "spec_components": [s.strip() for s in (r.get("spec_components") or "").split(";") if s.strip()],
            "cartons_ordered": int(r["cartons_ordered"]), "units_per_carton_ordered": int(r["units_per_carton_ordered"]),
            "qty_ordered": int(r["qty_ordered"])}


# ------------------------------------------------------------------------------------------ vision
def observe(photos: list[dict], chat_fn: Callable[..., Any] | None = None) -> tuple[dict, str, int, str]:
    """One Groq call for all photos (blind to the PO). Returns (observation, raw_text, latency_ms, model)."""
    chat = chat_fn or groq_client.chat
    imgs = []
    for p in photos:
        data = Path(p["path"]).read_bytes() if p.get("path") else p["bytes"]
        imgs.append(groq_client.Image(data, groq_client.sniff_mime(data) or "image/jpeg", p["role"]))
    try:
        res = chat(SYSTEM_PROMPT, build_user_prompt([p["role"] for p in photos]), imgs, json_mode=True, max_tokens=3000)
    except groq_client.GroqError as exc:
        raise VisionError(str(exc)) from exc
    try:
        return normalise_observation(res.json), res.text, res.latency_ms, res.model
    except VisionError:
        raise


def inspect_unit(payload: dict, chat_fn: Callable[..., Any] | None = None) -> dict:
    """payload: {po_row, photos:[{role,ref,path|bytes}], counts?, operator_id, record_id, captured_at}.
    Never raises for model problems: the record is returned with status 'pending' and every visual check UNCERTAIN."""
    po = row_to_po(payload["po_row"])
    photos = payload.get("photos") or []
    counts = payload.get("counts") or {}
    evid = []
    for i, p in enumerate(photos, start=1):
        data = Path(p["path"]).read_bytes() if p.get("path") else p["bytes"]
        evid.append({"index": i, "role": p["role"], "ref": p["ref"], "sha256": hashlib.sha256(data).hexdigest()})

    obs: dict | None = None
    raw: str | None = None
    latency: int | None = None
    model_name = "unavailable"
    error: str | None = None
    if not photos:
        error = "No photos supplied"
    else:
        t0 = time.monotonic()
        try:
            obs, raw, latency, model_name = observe(photos, chat_fn)
        except VisionError as exc:
            error, latency = str(exc), int((time.monotonic() - t0) * 1000)
        except OSError as exc:
            error = f"could not read a photo: {exc}"

    roles = [p["role"] for p in photos]
    checks = decide(po, obs, counts, roles)
    for c in checks:   # drop photo numbers the model invented
        c["photo_refs"] = sorted({i for i in c["photo_refs"] if 1 <= i <= len(photos)})
    return {
        "contract_version": CONTRACT_VERSION, "stage": "receiving", "record_id": payload["record_id"],
        "unit_id": po["unit_id"], "org_id": po["org_id"], "status": "complete" if obs else "pending",
        "overall": overall_verdict(checks), "expected": po, "summary": summarise(checks, po, obs),
        "checks": checks, "photos": evid, "operator_counts": counts, "operator_id": payload.get("operator_id"),
        "captured_at": payload.get("captured_at"), "observation": obs,
        "model": {"provider": "groq", "model": model_name, "prompt_version": PROMPT_VERSION, "latency_ms": latency,
                  "error": error, "raw_output": raw},
    }
