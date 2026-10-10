"""The single batched inspection prompt and its response schema.

One model call per inspection covers identity, components, observed state,
damage and condition grade together (engineering rule: batch model calls).
The model only reports what it SEES; verdicts and disposition are computed
deterministically afterwards (checks.py / rules.py).
"""
from __future__ import annotations

import json
from typing import Any

from . import reference

OBSERVED_STATES = ["factory_sealed", "opened_unused", "signs_of_use", "damaged", "empty_box", "uncertain"]

EVIDENCE_ITEM = {
    "type": "OBJECT",
    "properties": {
        "image_index": {"type": "INTEGER"},
        "observation": {"type": "STRING"},
    },
    "required": ["image_index", "observation"],
}


def response_schema() -> dict[str, Any]:
    grades = reference.grade_names() + ["UNCERTAIN"]
    return {
        "type": "OBJECT",
        "properties": {
            "image_quality": {"type": "ARRAY", "items": {
                "type": "OBJECT",
                "properties": {
                    "image_index": {"type": "INTEGER"},
                    "usable": {"type": "BOOLEAN"},
                    "issue": {"type": "STRING"},
                },
                "required": ["image_index", "usable"],
            }},
            "identity": {"type": "OBJECT", "properties": {
                "verdict": {"type": "STRING", "enum": ["MATCH", "MISMATCH", "UNCERTAIN"]},
                "observed_product": {"type": "STRING"},
                "best_matching_sku": {"type": "STRING"},
                "visible_identifiers": {"type": "ARRAY", "items": {"type": "STRING"}},
                "confidence": {"type": "NUMBER"},
                "evidence": {"type": "ARRAY", "items": EVIDENCE_ITEM},
            }, "required": ["verdict", "observed_product", "confidence", "evidence"]},
            "components": {"type": "ARRAY", "items": {
                "type": "OBJECT",
                "properties": {
                    "part": {"type": "STRING"},
                    "status": {"type": "STRING", "enum": ["PRESENT", "ABSENT", "NOT_VISIBLE"]},
                    "confidence": {"type": "NUMBER"},
                    "evidence": {"type": "ARRAY", "items": EVIDENCE_ITEM},
                },
                "required": ["part", "status", "confidence", "evidence"],
            }},
            "unexpected_items": {"type": "ARRAY", "items": {"type": "STRING"}},
            "observed_state": {"type": "STRING", "enum": OBSERVED_STATES},
            "damage": {"type": "ARRAY", "items": {
                "type": "OBJECT",
                "properties": {
                    "description": {"type": "STRING"},
                    "severity": {"type": "STRING", "enum": ["minor", "moderate", "severe"]},
                    "image_index": {"type": "INTEGER"},
                },
                "required": ["description", "severity", "image_index"],
            }},
            "condition": {"type": "OBJECT", "properties": {
                "grade": {"type": "STRING", "enum": grades},
                "confidence": {"type": "NUMBER"},
                "rationale": {"type": "STRING"},
                "evidence": {"type": "ARRAY", "items": EVIDENCE_ITEM},
            }, "required": ["grade", "confidence", "rationale", "evidence"]},
        },
        "required": ["image_quality", "identity", "components", "observed_state", "damage", "condition"],
    }


def build_prompt(order: reference.Order, n_images: int, operator_note: str = "") -> str:
    cat = reference.catalogue()
    item = cat.get(order.ordered_sku, {})
    lookalikes = [cat[s] for s in item.get("lookalike_skus", []) if s in cat]
    scale = reference.condition_scale()

    def item_card(it: dict[str, Any]) -> dict[str, Any]:
        return {k: it.get(k) for k in ("sku", "title", "visual_description", "distinguishing_features")}

    grade_lines = "\n".join(f'- "{g["grade"]}": {g["definition"]}' for g in scale["grades"])
    unacceptable = scale["unacceptable"]
    parts = [p["name"] for p in item.get("parts", [])]

    return f"""You are the visual inspector for a returns processing centre. You receive {n_images} photo(s) of ONE returned package, numbered image_index 0..{n_images - 1} in the order given.

Report ONLY what is visible in these photos. Never assume a part is present or absent because it usually is. Never invent labels, text, or damage. Every evidence item must cite the image_index where you saw it. If the photos do not show enough to decide, answer UNCERTAIN / NOT_VISIBLE - that is a correct, valued answer, not a failure.

ORDERED PRODUCT (what the customer was sold):
{json.dumps(item_card(item), indent=2)}

LOOK-ALIKE PRODUCTS (commonly confused; check distinguishing features):
{json.dumps([item_card(l) for l in lookalikes], indent=2) if lookalikes else "none listed"}

TASKS
1. image_quality: for each image, is it usable for inspection (in focus, lit, subject visible)?
2. identity: does the returned item match the ORDERED PRODUCT?
   - MATCH only if visible features are consistent with it AND nothing visible contradicts it.
   - MISMATCH if a different product (including a look-alike) or no product at all (empty box) is visible.
   - UNCERTAIN if the photos cannot distinguish it (e.g. from a look-alike).
   best_matching_sku: the SKU from the lists above that best matches what you see, or "" if none.
3. components: report EXACTLY these expected parts, one entry each, using these names: {json.dumps(parts)}
   - PRESENT: you can see it.
   - ABSENT: the photos show the full package contents / the place the part belongs, and it is not there.
   - NOT_VISIBLE: the photos do not show enough to know.
   unexpected_items: anything in the package that is not an expected part.
4. observed_state: one of {OBSERVED_STATES}.
5. damage: every visible defect (scratch, dent, crack, stain, tear, missing seal...) with severity:
   minor = cosmetic only; moderate = clearly visible wear/damage but usable; severe = unusable, broken, dirty/contaminated.
6. condition: grade the PHYSICAL CONDITION of the item that is present using ONLY this published scale (do not invent grades; missing parts are handled by task 3, do not downgrade for them):
{grade_lines}
- "{unacceptable['grade']}": {unacceptable['definition']}
- "UNCERTAIN": the photos do not support a reliable grade.

Confidence values are 0.0-1.0 and must reflect how strongly the photos support the answer.
{('Operator note (unverified, may be wrong): ' + operator_note) if operator_note else ''}
Return JSON only, matching the response schema."""
