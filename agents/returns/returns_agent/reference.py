"""Reference data: catalogue, published condition scale, disposition rules, orders.

Orders are org-scoped. The organiser sample (data/sample/returns_sample.csv) and
agents/returns/reference/demo_orders.csv are both loaded as order sources.
"""
from __future__ import annotations

import csv
import json
from dataclasses import dataclass
from functools import lru_cache
from typing import Any

from .config import DATA_DIR, REFERENCE_DIR


def _norm(s: str) -> str:
    return " ".join(s.lower().replace("_", " ").replace("-", " ").split())


@dataclass(frozen=True)
class Order:
    org_id: str
    client_id: str
    order_id: str
    unit_id: str
    ordered_sku: str
    ordered_asin: str
    source: str
    sample_parts_list: tuple[str, ...] = ()

    def to_dict(self) -> dict[str, Any]:
        return {
            "org_id": self.org_id, "client_id": self.client_id, "order_id": self.order_id,
            "unit_id": self.unit_id, "ordered_sku": self.ordered_sku,
            "ordered_asin": self.ordered_asin, "source": self.source,
        }


@lru_cache(maxsize=1)
def catalogue() -> dict[str, dict[str, Any]]:
    data = json.loads((REFERENCE_DIR / "catalogue.json").read_text(encoding="utf-8"))
    return {item["sku"]: item for item in data["items"]}


@lru_cache(maxsize=1)
def condition_scale() -> dict[str, Any]:
    return json.loads((REFERENCE_DIR / "condition_scale.json").read_text(encoding="utf-8"))


def grade_names() -> list[str]:
    scale = condition_scale()
    return [g["grade"] for g in scale["grades"]] + [scale["unacceptable"]["grade"]]


def grade_rank(grade: str) -> int | None:
    scale = condition_scale()
    for g in scale["grades"] + [scale["unacceptable"]]:
        if g["grade"] == grade:
            return g["rank"]
    return None


@lru_cache(maxsize=1)
def disposition_rules() -> dict[str, Any]:
    return json.loads((REFERENCE_DIR / "disposition_rules.json").read_text(encoding="utf-8"))


@lru_cache(maxsize=1)
def _all_orders() -> tuple[Order, ...]:
    orders: list[Order] = []
    sample = DATA_DIR / "returns_sample.csv"
    if sample.exists():
        with sample.open(newline="", encoding="utf-8") as fh:
            for row in csv.DictReader(fh):
                orders.append(Order(
                    org_id=row["org_id"], client_id=f"seller_{row['org_id'].split('_')[-1]}_01",
                    order_id=row["order_id"], unit_id=row["unit_id"],
                    ordered_sku=row["ordered_sku"], ordered_asin=row["ordered_asin"],
                    source="data/sample/returns_sample.csv",
                    sample_parts_list=tuple(p.strip() for p in row["parts_list"].split(";") if p.strip()),
                ))
    demo = REFERENCE_DIR / "demo_orders.csv"
    if demo.exists():
        with demo.open(newline="", encoding="utf-8") as fh:
            for row in csv.DictReader(fh):
                orders.append(Order(
                    org_id=row["org_id"], client_id=row["client_id"], order_id=row["order_id"],
                    unit_id=row["unit_id"], ordered_sku=row["ordered_sku"],
                    ordered_asin=row["ordered_asin"], source="agents/returns/reference/demo_orders.csv",
                ))
    return tuple(orders)


_LAB_ORDERS: list[Order] = []   # interactive-lab orders (tenant org_lab only), in memory


def register_lab_order(order: Order, item: dict[str, Any] | None = None) -> None:
    """Register an ad-hoc order (and optionally its catalogue entry) for the interactive lab."""
    if order.org_id != "org_lab":
        raise ValueError("lab orders must belong to org_lab")
    _LAB_ORDERS[:] = [o for o in _LAB_ORDERS if o.unit_id != order.unit_id]
    _LAB_ORDERS.append(order)
    if item:
        catalogue()[item["sku"]] = item


def _orders() -> tuple[Order, ...]:
    return _all_orders() + tuple(_LAB_ORDERS)


def orders_for_org(org_id: str) -> list[Order]:
    return [o for o in _orders() if o.org_id == org_id]


def get_order(org_id: str, order_id: str) -> Order | None:
    """Org-scoped lookup: an order belonging to another org is reported as not found."""
    for o in _orders():
        if o.org_id == org_id and o.order_id == order_id:
            return o
    return None


def get_order_by_unit(org_id: str, unit_id: str) -> Order | None:
    """Org-scoped lookup by unit (the Pod's subject_id). Another org's unit is reported as not found."""
    for o in _orders():
        if o.org_id == org_id and o.unit_id == unit_id:
            return o
    return None


def unit_exists_anywhere(unit_id: str) -> bool:
    return any(o.unit_id == unit_id for o in _orders())


def expected_parts(sku: str) -> list[dict[str, Any]]:
    item = catalogue().get(sku)
    return list(item["parts"]) if item else []


def match_part(name: str, parts: list[dict[str, Any]]) -> dict[str, Any] | None:
    n = _norm(name)
    for p in parts:
        if _norm(p["name"]) == n:
            return p
    for p in parts:
        pn = _norm(p["name"])
        if pn in n or n in pn:
            return p
    return None


def reference_findings() -> list[dict[str, str]]:
    """Contradictions between reference sources. Reported, never silently resolved."""
    findings: list[dict[str, str]] = []
    cat = catalogue()
    asin_to_skus: dict[str, set[str]] = {}
    for o in _all_orders():
        asin_to_skus.setdefault(o.ordered_asin, set()).add(o.ordered_sku)
        item = cat.get(o.ordered_sku)
        if item is None:
            findings.append({"kind": "unknown_sku", "detail": f"{o.order_id}: SKU {o.ordered_sku} is not in the catalogue"})
            continue
        if item["asin"] != o.ordered_asin:
            findings.append({"kind": "asin_mismatch", "detail": f"{o.order_id}: order ASIN {o.ordered_asin} != catalogue ASIN {item['asin']} for {o.ordered_sku}"})
        if o.sample_parts_list:
            cat_parts = sorted(_norm(p["name"]) for p in item["parts"])
            csv_parts = sorted(_norm(p) for p in o.sample_parts_list)
            if cat_parts != csv_parts:
                findings.append({"kind": "parts_list_mismatch", "detail": f"{o.order_id}: sample parts {csv_parts} != catalogue parts {cat_parts}"})
    for asin, skus in sorted(asin_to_skus.items()):
        if len(skus) > 1:
            findings.append({"kind": "asin_shared_by_skus", "detail": f"ASIN {asin} is used by different SKUs {sorted(skus)} in the order data"})
    return findings
