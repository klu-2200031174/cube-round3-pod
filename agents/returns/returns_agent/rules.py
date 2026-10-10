"""Deterministic disposition rules. Same facts in -> same disposition out.

Rules are evaluated in order; the first match wins. Rule ids and their
plain-language descriptions live in reference/disposition_rules.json and are
copied into every evidence record so the decision can be audited.
"""
from __future__ import annotations

from typing import Any, Callable

from . import reference

UNCERTAIN, FAIL, PASS = "UNCERTAIN", "FAIL", "PASS"

GOOD_RANK = 2       # Used - Good
LIKE_NEW_RANK = 4   # Used - Like New
NEW_RANK = 5


def _used(f: dict[str, Any]) -> bool:
    return f["observed_state"] in ("signs_of_use", "damaged") or (f["grade_rank"] is not None and f["grade_rank"] < LIKE_NEW_RANK)


def _sealed(f: dict[str, Any]) -> bool:
    """Factory-sealed / New. Hygiene items are only restockable in this state, so the
    decision does not hinge on the fuzzy line between 'opened' and 'lightly used'."""
    return f["observed_state"] == "factory_sealed" or f["grade_rank"] == NEW_RANK


PREDICATES: dict[str, Callable[[dict[str, Any]], bool]] = {
    "R01_MODEL_UNAVAILABLE": lambda f: f.get("model_failed", False),
    "R02_NO_USABLE_IMAGES": lambda f: f["usable_images"] == 0,
    "R03_IDENTITY_FAIL": lambda f: f["identity"] == FAIL,
    "R04_IDENTITY_UNCERTAIN": lambda f: f["identity"] == UNCERTAIN,
    "R05_CONDITION_UNCERTAIN": lambda f: f["condition"] == UNCERTAIN,
    "R06_UNACCEPTABLE_SEVERE": lambda f: f["condition"] == FAIL and f["max_damage"] == "severe",
    "R07_UNACCEPTABLE": lambda f: f["condition"] == FAIL,
    "R08_HYGIENE_USED": lambda f: f["hygiene_sensitive"] and not _sealed(f),
    "R09_COMPLETENESS_UNCERTAIN": lambda f: f["completeness"] == UNCERTAIN,
    "R09B_UNVERIFIED_PARTS_MATTER": lambda f: _unverified_changes_outcome(f),
    "R10_MISSING_CORE_PART": lambda f: any(not m["replaceable"] for m in f["missing"]),
    "R11_MISSING_MULTIPLE": lambda f: len(f["missing"]) >= 2,
    "R12_MISSING_ONE_REPLACEABLE": lambda f: len(f["missing"]) == 1 and f["grade_rank"] >= GOOD_RANK,
    "R13_MISSING_ONE_LOW_GRADE": lambda f: len(f["missing"]) == 1,
    "R14_COMPLETE_NEW": lambda f: f["completeness"] == PASS and f["grade_rank"] == NEW_RANK,
    "R15_COMPLETE_LIKE_NEW": lambda f: f["completeness"] == PASS and f["grade_rank"] == LIKE_NEW_RANK,
    "R16_COMPLETE_WEAR": lambda f: f["completeness"] == PASS and f["grade_rank"] in (2, 3),
    "R17_COMPLETE_ACCEPTABLE": lambda f: f["completeness"] == PASS and f["grade_rank"] == 1,
    "R99_FALLBACK": lambda f: True,
}


def _unverified_changes_outcome(f: dict[str, Any]) -> bool:
    """Some parts are confirmed missing and others could not be seen. If the
    disposition would differ depending on whether the unseen parts are there,
    the evidence does not support a decision: send it to a human."""
    unverified = f.get("unverified") or []
    if f["completeness"] != FAIL or not unverified or f.get("_nested"):
        return False
    base = dict(f, unverified=[], _nested=True)
    worst = dict(base, missing=list(f["missing"]) + list(unverified))
    return decide(base)["disposition"] != decide(worst)["disposition"]


def decide(facts: dict[str, Any]) -> dict[str, Any]:
    cfg = reference.disposition_rules()
    trace = []
    for rule in cfg["rules"]:
        pred = PREDICATES[rule["id"]]
        matched = bool(pred(facts))
        trace.append({"rule_id": rule["id"], "matched": matched})
        if matched:
            return {
                "disposition": rule["disposition"],
                "rule_id": rule["id"],
                "rule_text": rule["when"],
                "rules_version": cfg["version"],
                "needs_human_review": rule["disposition"] == "pending_review",
                "rules_evaluated": trace,
            }
    raise RuntimeError("rule table has no fallback")  # unreachable: R99 always matches
