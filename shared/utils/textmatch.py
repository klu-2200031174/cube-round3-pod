"""Small deterministic text matching shared by the agents (product words, colour families, variants).

Deliberately simple word matching: every decision can be explained in one sentence and reproduced by hand.
Ported from the Round 2 Receiving Manager (lib/match.ts) and reused by the Pack Manager.
"""
from __future__ import annotations

import re
from typing import Any

PLACEHOLDER = re.compile(r"^\s*(none|n/?a|nothing|null|unknown|unclear|not visible|-|)\s*\.?\s*$", re.I)


def is_placeholder(s: str | None) -> bool:
    return s is None or bool(PLACEHOLDER.match(s))


STOP = {"the", "and", "with", "for", "set", "pack", "pcs", "piece", "pieces", "unit", "units", "item", "items", "product",
        "one", "two", "three", "box", "carton", "package", "packaging", "sku", "inside", "some"}
COLOUR_FAMILIES = [
    ["blue", "navy", "azure", "cobalt", "royal"], ["red", "maroon", "crimson", "burgundy", "scarlet"],
    ["green", "olive", "lime", "emerald"], ["black", "jet"], ["white", "offwhite"],
    ["cream", "ivory", "beige", "offwhite", "eggshell"], ["grey", "gray", "silver", "charcoal", "graphite"],
    ["yellow", "gold", "mustard"], ["pink", "rose", "magenta"], ["purple", "violet", "lilac", "lavender"],
    ["orange", "amber"], ["brown", "tan", "chocolate"],
]
COLOUR_WORDS = {w for fam in COLOUR_FAMILIES for w in fam}
PACKAGING = {"boxe", "boxed", "cardboard", "corrugated", "shipping", "shipper", "parcel", "packed", "mailer", "envelope",
             "container", "wrap", "wrapped", "wrapping", "master", "outer", "inner", "small", "large", "big", "sealed",
             "open", "opened", "closed", "multiple", "several", "stack", "stacked", "pile", "bundle", "pallet", "tape",
             "taped", "barcode", "sticker", "goods", "merchandise", "contents"}


def _singular(w: str) -> str:
    if len(w) > 4 and w.endswith("ies"):
        return w[:-3] + "y"
    if len(w) > 3 and w.endswith("s") and not w.endswith("ss"):
        return w[:-1]
    return w


def words(s: str | None) -> list[str]:
    if not s:
        return []
    t = re.sub(r"off[\s-]white", "offwhite", s.lower())
    return [_singular(w) for w in re.split(r"[^a-z0-9]+", t) if w]


def product_words(s: str | None) -> list[str]:
    return [w for w in words(s) if len(w) >= 3 and w not in STOP and w not in COLOUR_WORDS and not w[0].isdigit()]


def is_packaging_only(t: str) -> bool:
    return all(w in PACKAGING for w in product_words(t))


def match_identity(title: str, sku: str, seen_type: str, seen_desc: str, label: str | None) -> dict[str, Any]:
    if is_placeholder(seen_type):
        return {"status": "unknown", "shared": [], "packaging_only": False}
    expected = set(product_words(title)) | set(product_words(re.sub(r"^SKU-", "", sku, flags=re.I)))
    if is_packaging_only(seen_type):
        on_label = {w for w in product_words(label) if w not in PACKAGING}
        shared = sorted(expected & on_label)
        return {"status": "match" if shared else "unknown", "shared": shared, "packaging_only": True}
    observed = set(product_words(f"{seen_type} {seen_desc} {label or ''}"))
    shared = sorted(expected & observed)
    return {"status": "match" if shared else "mismatch", "shared": shared, "packaging_only": False}


def _colour_fams(s: str | None) -> set[int]:
    fams: set[int] = set()
    for w in words(s):
        for i, f in enumerate(COLOUR_FAMILIES):
            if w in f:
                fams.add(i)
    return fams


def match_colour(spec: str, seen: str | None) -> str:
    if is_placeholder(seen):
        return "unknown"
    want, got = _colour_fams(spec), _colour_fams(seen)
    if not want or not got:
        return "unknown"
    return "match" if want & got else "mismatch"


MEASURE = re.compile(r"(\d+(?:\.\d+)?)(ml|l|oz|kg|g|ft|cm|m|pc|pack)\b")


def _compact(s: str) -> str:
    t = re.sub(r"(\d)\s*[-\s]?\s*(ml|l|oz|kg|g|ft|cm|m|pcs?|pack|pieces?)\b", r"\1\2", s.lower())
    return re.sub(r"pcs\b|pieces?\b", "pc", t)


def match_variant(spec: str, label_text: str | None) -> str:
    if is_placeholder(label_text):
        return "unknown"
    label, want = _compact(label_text or ""), _compact(spec)
    if re.sub(r"[^a-z0-9]", "", want) in re.sub(r"[^a-z0-9]", "", label):
        return "match"
    wm = MEASURE.findall(want)
    if not wm:
        return "unknown"
    for num, unit in wm:
        same = [m for m in MEASURE.findall(label) if m[1] == unit]
        if same and not any(float(m[0]) == float(num) for m in same):
            return "mismatch"
    return "unknown"


def missing_components(expected: list[str], seen: list[str]) -> list[str]:
    seen_words = {w for s in seen if not is_placeholder(s) for w in product_words(s)}
    out = []
    for c in expected:
        cw = product_words(c)
        if cw and not any(w in seen_words for w in cw):
            out.append(c)
    return out


