"""Turn raw model observations into PASS / FAIL / UNCERTAIN checks.

This layer is deterministic and is where "never guess" is enforced:
- evidence citing a non-existent or unusable image is discarded;
- a claim with no remaining evidence cannot be PASS or FAIL;
- a claim below its confidence threshold becomes UNCERTAIN;
- an expected part the model did not report is NOT_VISIBLE (never assumed present);
- internally contradictory answers become UNCERTAIN.
"""
from __future__ import annotations

from typing import Any

from . import reference

PASS, FAIL, UNCERTAIN = "PASS", "FAIL", "UNCERTAIN"


def _conf(x: Any) -> float:
    try:
        v = float(x)
    except (TypeError, ValueError):
        return 0.0
    return max(0.0, min(1.0, v))


def _clean_evidence(items: Any, usable: set[int], n_images: int) -> tuple[list[dict[str, Any]], int]:
    """Keep evidence that points at a real, usable image. Returns (kept, dropped_count)."""
    kept, dropped = [], 0
    for ev in items or []:
        if not isinstance(ev, dict):
            dropped += 1
            continue
        idx = ev.get("image_index")
        obs = str(ev.get("observation", "")).strip()
        if isinstance(idx, int) and 0 <= idx < n_images and idx in usable and obs:
            kept.append({"image_index": idx, "observation": obs})
        else:
            dropped += 1
    return kept, dropped


def build_checks(raw: dict[str, Any], order: reference.Order, n_images: int,
                 model_version: str, latency_ms: int) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Return (checks, facts). facts carries the derived values the rules need."""
    th = reference.disposition_rules()["thresholds"]
    item = reference.catalogue().get(order.ordered_sku, {})
    parts = reference.expected_parts(order.ordered_sku)

    def check(key: str, verdict: str, confidence: float, detail: str, evidence: list, value: Any = None, **extra) -> dict[str, Any]:
        c = {"check_key": key, "verdict": verdict, "confidence": round(confidence, 3), "detail": detail,
             "evidence": evidence, "model_version": model_version, "latency_ms": latency_ms}
        if value is not None:
            c["value"] = value
        c.update(extra)
        return c

    # --- image quality -------------------------------------------------
    usable: set[int] = set()
    issues: list[str] = []
    reported = {q.get("image_index"): q for q in raw.get("image_quality") or [] if isinstance(q, dict)}
    for i in range(n_images):
        q = reported.get(i)
        if q is None or q.get("usable", True):
            usable.add(i)
        else:
            issues.append(f"image {i}: {q.get('issue') or 'unusable'}")
    iq_verdict = PASS if usable else UNCERTAIN
    checks = [check("image_quality", iq_verdict, 1.0 if usable else 0.0,
                    f"{len(usable)}/{n_images} photos usable" + (f"; {'; '.join(issues)}" if issues else ""),
                    [], value={"usable_images": sorted(usable), "issues": issues})]

    # --- identity -----------------------------------------------------
    ident = raw.get("identity") or {}
    ev, dropped = _clean_evidence(ident.get("evidence"), usable, n_images)
    conf = _conf(ident.get("confidence"))
    mv = str(ident.get("verdict", "UNCERTAIN")).upper()
    best = str(ident.get("best_matching_sku") or "")
    reasons = []
    if mv == "MATCH" and best and best != order.ordered_sku:
        verdict, reasons = UNCERTAIN, [f"model said MATCH but best matching SKU was {best}"]
    elif mv in ("MATCH", "MISMATCH") and not ev:
        verdict, reasons = UNCERTAIN, ["no image evidence supports the identity claim"]
    elif mv in ("MATCH", "MISMATCH") and conf < th["identity_min_confidence"]:
        verdict, reasons = UNCERTAIN, [f"confidence {conf:.2f} below threshold {th['identity_min_confidence']}"]
    elif mv == "MATCH":
        verdict = PASS
    elif mv == "MISMATCH":
        verdict = FAIL
    else:
        verdict = UNCERTAIN
    observed = str(ident.get("observed_product", "")).strip()
    detail = f"Expected {order.ordered_sku} ({item.get('title', 'unknown')}); observed: {observed or 'n/a'}"
    if best:
        detail += f"; best catalogue match: {best}"
    if reasons:
        detail += "; " + "; ".join(reasons)
    if dropped:
        detail += f"; {dropped} evidence item(s) discarded (invalid/unusable image reference)"
    checks.append(check("identity", verdict, conf, detail, ev, value={
        "expected_sku": order.ordered_sku, "expected_asin": order.ordered_asin,
        "model_verdict": mv, "best_matching_sku": best or None,
        "visible_identifiers": [str(x) for x in ident.get("visible_identifiers") or []]}))

    # --- completeness -------------------------------------------------
    reported_parts: dict[str, dict[str, Any]] = {}
    for comp in raw.get("components") or []:
        if not isinstance(comp, dict):
            continue
        p = reference.match_part(str(comp.get("part", "")), parts)
        if p and p["name"] not in reported_parts:
            reported_parts[p["name"]] = comp
    components, missing, unverified = [], [], []
    for p in parts:
        comp = reported_parts.get(p["name"])
        if comp is None:
            status, c, pev, note = "NOT_VISIBLE", 0.0, [], "not reported by model"
        else:
            status = str(comp.get("status", "NOT_VISIBLE")).upper()
            c = _conf(comp.get("confidence"))
            pev, _ = _clean_evidence(comp.get("evidence"), usable, n_images)
            note = ""
            if status in ("PRESENT", "ABSENT") and (not pev or c < th["component_min_confidence"]):
                note = f"downgraded from {status}: " + ("no valid evidence" if not pev else f"confidence {c:.2f}")
                status = "NOT_VISIBLE"
            if status not in ("PRESENT", "ABSENT", "NOT_VISIBLE"):
                status = "NOT_VISIBLE"
        components.append({"part": p["name"], "status": status, "confidence": round(c, 3),
                           "essential": p["essential"], "replaceable": p["replaceable"],
                           "evidence": pev, **({"note": note} if note else {})})
        if status == "ABSENT":
            missing.append(p["name"])
        elif status == "NOT_VISIBLE":
            unverified.append(p["name"])
    if not parts:
        comp_verdict = UNCERTAIN  # no parts list for this SKU: nothing to verify against, never a vacuous PASS
    elif missing:
        comp_verdict = FAIL
    elif unverified:
        comp_verdict = UNCERTAIN
    else:
        comp_verdict = PASS
    comp_conf = min([c["confidence"] for c in components], default=0.0)
    cdetail = (f"{len(parts) - len(missing) - len(unverified)}/{len(parts)} expected parts confirmed present"
               if parts else f"No parts list in the catalogue for {order.ordered_sku}; completeness cannot be verified")
    if missing:
        cdetail += f"; missing: {', '.join(missing)}"
    if unverified:
        cdetail += f"; not verifiable from photos: {', '.join(unverified)}"
    unexpected = [str(x) for x in raw.get("unexpected_items") or []]
    if unexpected:
        cdetail += f"; unexpected items: {', '.join(unexpected)}"
    comp_ev = [dict(e, part=c["part"]) for c in components for e in c["evidence"]]
    checks.append(check("completeness", comp_verdict, comp_conf, cdetail, comp_ev, value={
        "components": components, "missing": missing, "unverified": unverified, "unexpected_items": unexpected}))

    # --- condition ----------------------------------------------------
    cond = raw.get("condition") or {}
    grade = str(cond.get("grade", "UNCERTAIN"))
    cconf = _conf(cond.get("confidence"))
    cev, cdropped = _clean_evidence(cond.get("evidence"), usable, n_images)
    damage = []
    for d in raw.get("damage") or []:
        if isinstance(d, dict) and d.get("image_index") in usable and str(d.get("description", "")).strip():
            damage.append({"description": str(d["description"]).strip(),
                           "severity": d.get("severity") if d.get("severity") in ("minor", "moderate", "severe") else "moderate",
                           "image_index": d["image_index"]})
    creasons = []
    if grade not in reference.grade_names():
        if grade != "UNCERTAIN":
            creasons.append(f"'{grade}' is not on the published scale")
        grade_out, cverdict = None, UNCERTAIN
    elif not cev:
        creasons.append("no image evidence supports the grade")
        grade_out, cverdict = None, UNCERTAIN
    elif cconf < th["condition_min_confidence"]:
        creasons.append(f"confidence {cconf:.2f} below threshold {th['condition_min_confidence']}")
        grade_out, cverdict = None, UNCERTAIN
    else:
        grade_out = grade
        cverdict = FAIL if grade == reference.condition_scale()["unacceptable"]["grade"] else PASS
    observed_state = raw.get("observed_state") if raw.get("observed_state") in (
        "factory_sealed", "opened_unused", "signs_of_use", "damaged", "empty_box", "uncertain") else "uncertain"
    cdet = (f"Grade: {grade_out or 'UNCERTAIN'} (model proposed '{grade}'); observed state: {observed_state}; "
            f"{str(cond.get('rationale', '')).strip()}")
    if creasons:
        cdet += "; " + "; ".join(creasons)
    if cdropped:
        cdet += f"; {cdropped} evidence item(s) discarded"
    checks.append(check("condition", cverdict, cconf, cdet, cev, value={
        "grade": grade_out, "model_grade": grade, "scale": reference.condition_scale()["scale_id"],
        "observed_state": observed_state, "damage": damage}))

    facts = {
        "usable_images": len(usable),
        "identity": verdict,
        "completeness": comp_verdict,
        "missing": [c for c in components if c["status"] == "ABSENT"],
        "unverified": [c for c in components if c["status"] == "NOT_VISIBLE"],
        "condition": cverdict,
        "grade": grade_out,
        "grade_rank": reference.grade_rank(grade_out) if grade_out else None,
        "observed_state": observed_state,
        "max_damage": max((d["severity"] for d in damage), key=["minor", "moderate", "severe"].index, default=None),
        "hygiene_sensitive": bool(item.get("hygiene_sensitive")),
    }
    return checks, facts
