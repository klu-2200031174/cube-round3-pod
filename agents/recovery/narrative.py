"""Recovery Manager: human-readable claim explanations written by Groq, bounded by the rules engine.

The DECISION (SUPPORTS / CONTRADICTS / SILENT), the claim amount and the cited evidence all come from the
deterministic engine (core/decision_engine.py). Groq only turns those facts into readable text:

  * CONTRADICTS  -> a short dispute paragraph a seller can paste into a case, citing the evidence record ids
  * SUPPORTS     -> why the charge looks valid (no claim)
  * SILENT       -> exactly why it cannot be claimed (insufficient evidence)

Safeguards: the model is given only the engine's facts; its answer is rejected (and a deterministic template
used instead) if it mentions a dollar amount that is not one of the supplied amounts, or cites a record id that
was not supplied. No key / model error -> template text. The verdicts never depend on this module.
"""
from __future__ import annotations

import re
from typing import Any, Callable

from shared.utils import groq_client

SYSTEM = """You write short, factual dispute notes for an e-commerce seller's fee-recovery tool.
You are given FACTS produced by a rules engine. Rules:
- Use ONLY the facts provided. Never invent evidence, dates, amounts, photos or record ids.
- Do not change any verdict or amount. Quote amounts exactly as given.
- For CONTRADICTS: 2-4 sentences stating the charge, the contradicting evidence (cite record ids) and the amount requested.
- For SUPPORTS: 1-2 sentences saying the evidence supports the charge, so no claim.
- For SILENT: 1-2 sentences saying the evidence is insufficient, so the charge cannot be claimed. Do not speculate.
Return ONE JSON object: {"notes": [{"line_id": string, "text": string}]} with one entry per charge, in the given order."""

_AMOUNT = re.compile(r"\$\s?\d[\d,]*(?:\.\d+)?")
_RECORD = re.compile(r"\b(?:RCV|PRP|PCK|RTN|RCY)-[A-Za-z0-9._-]+")


def _money(x: float) -> str:
    return f"${x:,.2f}"


def template(c: dict) -> str:
    ids = ", ".join(c.get("evidence_record_ids") or []) or "none"
    amt = _money(float(c.get("amount_usd") or 0))
    if c["position"] == "CONTRADICTS":
        return (f"Charge {c['line_id']} ({c['charge_type']}, {amt}) is contradicted by operational evidence "
                f"({ids}). {c['reason']} Requesting reversal of {_money(float(c.get('claim_amount_usd', c.get('amount_usd', 0)) or 0))}.")
    if c["position"] == "SUPPORTS":
        return f"Charge {c['line_id']} ({c['charge_type']}, {amt}) is supported by the evidence ({ids}); no claim. {c['reason']}"
    return (f"Charge {c['line_id']} ({c['charge_type']}, {amt}) cannot be claimed: the available records are silent or "
            f"insufficient. {c['reason']}")


def _valid(text: str, c: dict) -> bool:
    allowed = {_money(float(c.get("amount_usd") or 0)), _money(float(c.get("claim_amount_usd") or 0))}
    allowed |= {a.replace(",", "") for a in list(allowed)}
    for m in _AMOUNT.findall(text):
        if m.replace(" ", "") not in {a.replace(" ", "") for a in allowed} and m.replace(" ", "").replace(",", "") not in {a.replace(",", "") for a in allowed}:
            return False
    ids = set(c.get("evidence_record_ids") or [])
    return all(r.rstrip(".,;:") in ids for r in _RECORD.findall(text)) and bool(text.strip())


def build(charges: list[dict], chat_fn: Callable[..., Any] | None = None) -> dict[str, Any]:
    """charges: engine output per charge (line_id, charge_type, amount_usd, claim_amount_usd, position, reason, evidence_record_ids)."""
    notes = {c["line_id"]: template(c) for c in charges}
    out = {"source": "template", "model": None, "latency_ms": None, "notes": notes, "rejected": []}
    if not charges or (chat_fn is None and not groq_client.has_key()):
        return out
    facts = [{k: c.get(k) for k in ("line_id", "charge_type", "amount_usd", "claim_amount_usd", "position", "reason",
                                    "evidence_record_ids")} for c in charges]
    prompt = "FACTS (one per charge):\n" + __import__("json").dumps(facts, indent=1)
    try:
        res = (chat_fn or groq_client.chat)(SYSTEM, prompt, None, json_mode=True, max_tokens=1500, temperature=0.2)
    except groq_client.GroqError as exc:
        out["error"] = str(exc)[:300]
        return out
    got = {str(n.get("line_id")): str(n.get("text") or "") for n in (res.json or {}).get("notes", []) if isinstance(n, dict)}
    used = 0
    for c in charges:
        text = got.get(c["line_id"], "")
        if _valid(text, c):
            notes[c["line_id"]] = text.strip()
            used += 1
        else:
            out["rejected"].append(c["line_id"])
    if used:
        out.update(source="groq", model=res.model, latency_ms=res.latency_ms)
    return out
