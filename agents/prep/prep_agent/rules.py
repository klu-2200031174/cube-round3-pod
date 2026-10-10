"""Deterministic decision engine: observations in, verdicts out. The only place verdicts are produced.

Ported from the reference src/lib/rules.ts. Same observations in, same verdicts out.
Per reference check (a "part"):
  not applicable                  -> omitted (listed in payload.not_applicable)
  not photo-verifiable            -> omitted (listed in payload.not_verifiable), never PASS
  no / conflicting observation    -> UNCERTAIN
  cited photo unusable            -> UNCERTAIN (poor_image)
  cant_tell                       -> UNCERTAIN
  no photo cited, no evidence     -> UNCERTAIN (a verdict must point at a photo)
  low confidence                  -> UNCERTAIN
  met / not_met                   -> PASS / FAIL
Parts then roll up into one Evidence Contract check per requirement (any FAIL -> FAIL, else any UNCERTAIN ->
UNCERTAIN, else PASS).
"""
from __future__ import annotations

import re
from typing import Any

from shared.utils.records import check

from .rule_pack import CHECKS, CLAUSES, CONTRACT_KEYS, CheckDef, Requirements

CONFIDENCE_RANK = {"low": 0, "medium": 1, "high": 2}
# Contract confidence is a number; the model reports a label. Fixed mapping, documented in the README.
CONFIDENCE_VALUE = {"high": 0.9, "medium": 0.7, "low": 0.4}


def normalize_fnsku(s: str) -> str:
    return re.sub(r"[^A-Za-z0-9]", "", s or "").upper()


def _part(d: CheckDef, verdict: str, observed: str, *, photo: int | None = None, location: str | None = None,
          confidence: str | None = None, reason: str | None = None, extra: dict | None = None) -> dict[str, Any]:
    clause = CLAUSES[d.clause_key]
    p = {"check_id": d.id, "name": d.name, "verdict": verdict, "expected": d.expected, "observed": observed,
         "photo_index": photo, "location": location or None, "confidence": confidence,
         "uncertain_reason": reason if verdict == "UNCERTAIN" else None,
         "rule_clause": clause.clause, "rule_quote": clause.quote}
    if extra:
        p.update(extra)
    return p


def _usable(vision: dict, photo: int) -> bool | None:
    for q in vision["photo_quality"]:
        if q["photo_index"] == photo:
            return q["usable"]
    return None  # not rated: treated as usable, as in the reference


def _text_match(d: CheckDef, req: Requirements, vision: dict) -> dict[str, Any]:
    lr = vision["label_text_read"]
    if not req.expected_fnsku:
        return _part(d, "UNCERTAIN", "The work order gives no expected FNSKU, so the label cannot be matched.",
                     reason="rule_unavailable")
    if not lr["legible"] or not lr["value"]:
        return _part(d, "UNCERTAIN", f"The label text could not be read clearly (expected {req.expected_fnsku}). "
                     "Re-photograph the label in sharp focus.", photo=lr["photo_index"], location="FNSKU label",
                     confidence=lr["confidence"], reason="poor_image")
    if lr["photo_index"] is None:
        return _part(d, "UNCERTAIN", f"Read \"{lr['value']}\" but no photo was cited for it.",
                     confidence=lr["confidence"], reason="insufficient_evidence")
    if _usable(vision, lr["photo_index"]) is False:
        return _part(d, "UNCERTAIN", f"Photo {lr['photo_index']} with the label is not usable. Retake it.",
                     photo=lr["photo_index"], location="FNSKU label", confidence=lr["confidence"], reason="poor_image")
    if CONFIDENCE_RANK[lr["confidence"]] < 1:
        return _part(d, "UNCERTAIN", f"Read \"{lr['value']}\" with low confidence; expected {req.expected_fnsku}. "
                     "Re-photograph the label.", photo=lr["photo_index"], location="FNSKU label",
                     confidence=lr["confidence"], reason="poor_image")
    if normalize_fnsku(lr["value"]) == normalize_fnsku(req.expected_fnsku):
        return _part(d, "PASS", f"Label reads \"{lr['value']}\", matching the expected FNSKU {req.expected_fnsku}.",
                     photo=lr["photo_index"], location="FNSKU label", confidence=lr["confidence"])
    return _part(d, "FAIL", f"Label reads \"{lr['value']}\" but the expected FNSKU is {req.expected_fnsku}: mismatch.",
                 photo=lr["photo_index"], location="FNSKU label", confidence=lr["confidence"])


def _observed(d: CheckDef, req: Requirements, vision: dict) -> dict[str, Any]:
    found = [o for o in vision["observations"] if o["check_id"] == d.id]
    if not found:
        return _part(d, "UNCERTAIN", "No observation was returned for this check.", reason="insufficient_evidence")
    if len({o["status"] for o in found}) > 1:
        return _part(d, "UNCERTAIN", "The model returned contradictory observations for this check.",
                     reason="conflicting_evidence")
    o = found[0]
    photo, loc, conf, ev = o["photo_index"], o["location"], o["confidence"], o["evidence"].strip()
    if photo is not None and _usable(vision, photo) is False:
        return _part(d, "UNCERTAIN", f"Photo {photo} is not usable for this check: {ev.rstrip('.') or 'retake needed'}.",
                     photo=photo, location=loc, confidence=conf, reason="poor_image")
    if o["status"] == "cant_tell":
        return _part(d, "UNCERTAIN", ev or "Not determinable from the photos provided.", photo=photo, location=loc,
                     confidence=conf, reason="occluded" if photo is not None else "insufficient_evidence")
    if not ev:
        return _part(d, "UNCERTAIN", "No visible evidence was cited, so it is treated as uncertain.", photo=photo,
                     location=loc, confidence=conf, reason="insufficient_evidence")
    if photo is None:
        return _part(d, "UNCERTAIN", f"No photo was cited for this observation: {ev}", location=loc,
                     confidence=conf, reason="insufficient_evidence")
    if CONFIDENCE_RANK[conf] < 1:
        return _part(d, "UNCERTAIN", f"Low-confidence observation: {ev}", photo=photo, location=loc,
                     confidence=conf, reason="insufficient_evidence")
    extra = None
    if d.id == "handling_marks_present" and o.get("marks_seen") is not None:
        seen = {normalize_fnsku(m) for m in o["marks_seen"]}
        missing = [m for m in req.handling_marks if not any(normalize_fnsku(m) in s for s in seen)]
        extra = {"marks_required": req.handling_marks, "marks_seen": o["marks_seen"], "marks_missing": missing}
        if o["status"] == "met" and missing:
            return _part(d, "UNCERTAIN", f"Reported as met, but {', '.join(missing)} not among the marks seen: {ev}",
                         photo=photo, location=loc, confidence=conf, reason="conflicting_evidence", extra=extra)
    return _part(d, "PASS" if o["status"] == "met" else "FAIL", ev, photo=photo, location=loc, confidence=conf,
                 extra=extra)


def evaluate(req: Requirements, vision: dict | None) -> dict[str, Any]:
    """Judge every reference check. `vision` is the validated model answer, or None when no photo was usable."""
    parts, not_applicable, not_verifiable = [], [], []
    for d in CHECKS:
        if not d.applies_to(req):
            not_applicable.append(d.id)
            continue
        if not d.verifiable:
            not_verifiable.append({"check_id": d.id, "name": d.name, "rule_clause": CLAUSES[d.clause_key].clause,
                                   "note": "Physical property that cannot be judged from a photograph; verify by "
                                           "hand or spec sheet."})
            continue
        if vision is None:
            parts.append(_part(d, "UNCERTAIN", "No usable photo of the prepped unit.", reason="insufficient_evidence"))
        elif d.id == "fnsku_text_match":
            parts.append(_text_match(d, req, vision))
        else:
            parts.append(_observed(d, req, vision))
    return {"parts": parts, "not_applicable": not_applicable, "not_verifiable": not_verifiable}


def _roll(verdicts: list[str]) -> str:
    if "FAIL" in verdicts:
        return "FAIL"
    if "UNCERTAIN" in verdicts or not verdicts:
        return "UNCERTAIN"
    return "PASS"


def contract_checks(parts: list[dict], refs: list[str]) -> list[dict[str, Any]]:
    """One contract check per requirement, citing the photo refs its parts used.

    refs[i] is the ref of photo_index i+1. A part that cites no photo was looked for in every photo, so an
    UNCERTAIN check with no specific photo cites all of them; PASS / FAIL always cite a specific photo.
    """
    by_key: dict[str, list[dict]] = {}
    keys = {d.id: d.contract_key for d in CHECKS}
    for p in parts:
        by_key.setdefault(keys[p["check_id"]], []).append(p)
    out = []
    for key in CONTRACT_KEYS:
        ps = by_key.get(key)
        if not ps:
            continue
        verdict = _roll([p["verdict"] for p in ps])
        cited = sorted({refs[p["photo_index"] - 1] for p in ps
                        if p["photo_index"] is not None and 0 < p["photo_index"] <= len(refs)})
        evidence_refs = cited or (list(refs) if verdict == "UNCERTAIN" else [])
        deciding = [p for p in ps if p["verdict"] == verdict]
        confs = [CONFIDENCE_VALUE[p["confidence"]] for p in deciding if p["confidence"] in CONFIDENCE_VALUE]
        # Confidence belongs to a PASS / FAIL the model saw; an UNCERTAIN is a rule outcome, so it has none.
        confidence = min(confs) if verdict != "UNCERTAIN" and confs and len(confs) == len(deciding) else None
        reasons = [p["uncertain_reason"] for p in deciding if p.get("uncertain_reason")]
        reason = next((r for r in ("conflicting_evidence", "poor_image", "occluded", "rule_unavailable",
                                   "insufficient_evidence") if r in reasons), "insufficient_evidence")
        detail = " ".join(f"{p['name']}: {p['verdict']} - {p['observed']}" for p in ps)
        out.append(check(
            key, verdict, confidence,
            expected=" ".join(p["expected"] for p in ps),
            observed={p["check_id"]: p["observed"] for p in ps},
            detail=f"{detail} ({', '.join(sorted({p['rule_clause'] for p in ps}))})"[:1000],
            evidence_refs=evidence_refs, uncertain_reason=reason))
    return out


def overall_reason(checks: list[dict], parts: list[dict]) -> tuple[str, list[str]]:
    """(reason, retake list) in the reference's words."""
    def loc(p: dict) -> str:
        return f" (photo {p['photo_index']}{', ' + p['location'] if p['location'] else ''})" if p["photo_index"] else ""

    fails = [p for p in parts if p["verdict"] == "FAIL"]
    unsure = [p for p in parts if p["verdict"] == "UNCERTAIN"]
    if fails:
        f = fails[0]
        return f"FAIL: {f['name']}: {f['observed']}{loc(f)}", []
    if unsure or not checks:
        retake = [f"{p['name']}: {p['observed']}{loc(p)}" for p in unsure]
        return (f"UNCERTAIN (needs review): {len(unsure)} required check{'s' if len(unsure) != 1 else ''} "
                "could not be confirmed."), retake
    return "PASS: every required check passed with cited visual evidence.", []
