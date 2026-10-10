"""The prep rule pack: clauses, the check catalogue, and which checks a work order makes applicable.

Ported from the reference src/lib/prepRequirements.ts and src/lib/rulePacks/ (pack "fba", version "1").
The clause quotes are the reference's own paraphrase of FBA-style prep rules, not Amazon's verbatim text
(see README "Limits"). Rules are data: the decision engine (rules.py) only reads from here.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable

RULE_PACK_ID = "fba"
RULE_PACK_VERSION = "1"
RULE_PACK_NAME = "Amazon FBA Prep & Labeling"
RULE_PACK_SOURCE = ("Marketplace Prep & Labeling Requirements as encoded in the organiser-provided reference "
                    "Prep Manager (rule pack fba@1). Paraphrased clauses, not verbatim Amazon text.")


@dataclass(frozen=True)
class Clause:
    clause: str
    title: str
    quote: str


CLAUSES: dict[str, Clause] = {
    "polybag": Clause("§2.1 Poly-bagging", "Poly-bag required",
                      "Units that are not already in sealed retail-ready packaging must be placed inside a transparent "
                      "poly bag so that the FNSKU label can be applied to the bag."),
    "seal": Clause("§2.2 Sealing", "Poly-bag sealed",
                   "Poly bags must be completely sealed. The product must not be able to fall out of the bag."),
    "suffocation": Clause("§2.3 Suffocation warning", "Suffocation warning",
                          "Any poly bag with an opening of 5 inches (12.7 cm) or larger, measured when laid flat, must "
                          "carry a suffocation warning printed on the bag or on an attached label."),
    "fnsku": Clause("§3.1 FNSKU label", "FNSKU label applied",
                    "Each unit must have a single scannable FNSKU barcode label applied to the exterior of the unit or "
                    "its poly bag."),
    "placement": Clause("§3.2 Label placement", "FNSKU on a flat, scannable surface",
                        "The FNSKU label must be placed on a flat surface. Do not place the barcode across a curved "
                        "surface, seam, corner or edge where it cannot be scanned reliably."),
    "match": Clause("§3.3 Correct FNSKU", "FNSKU matches the product",
                    "The FNSKU printed on the label must correspond to the product it is applied to. A unit bearing "
                    "the wrong FNSKU is mislabeled."),
    "cover": Clause("§3.4 Original barcodes", "Original manufacturer barcode covered",
                    "Any pre-existing scannable barcode on the exterior (for example the manufacturer UPC or EAN) must "
                    "be covered or rendered unscannable so that only the FNSKU is scanned."),
    "expiry": Clause("§4.1 Expiration dates", "Expiry date visible",
                     "For products that carry an expiration date, the date must be printed on each individual unit and "
                     "must remain visible after prep. A poly bag must not obscure the expiration date."),
    "handling": Clause("§4.2 Handling marks", "Required handling marks present",
                       "Fragile units, and units requiring special handling, must display the required handling marking "
                       "(for example 'Fragile') on the exterior so it is visible during handling."),
    "thickness": Clause("§2.4 Bag material", "Bag thickness / material",
                        "Poly bags must be made of durable material at least 1.5 mil thick."),
}

# Display names for the work order's handling-mark codes.
MARK_NAMES = {"fragile": "Fragile", "this_way_up": "This Way Up", "liquid": "Liquid", "glass": "Glass",
              "keep_dry": "Keep Dry", "heavy": "Heavy"}


@dataclass
class Requirements:
    """What the work order asks for this unit (the reference's ProductInput)."""
    sku: str
    expected_fnsku: str
    name: str
    requires_polybag: bool
    requires_suffocation_warning: bool
    has_expiry: bool
    handling_marks: list[str] = field(default_factory=list)   # display names, e.g. ["Fragile", "This Way Up"]
    cover_original_barcode: bool = True


@dataclass(frozen=True)
class CheckDef:
    id: str                 # reference check id (what the model observes)
    contract_key: str       # the Evidence Contract check_key it rolls up into
    name: str
    clause_key: str
    verifiable: bool        # can a photo verify it?
    applies_to: Callable[[Requirements], bool]
    expected: str


# Ordered catalogue of every check (reference CHECK_CATALOG), each mapped to a contract check_key.
CHECKS: list[CheckDef] = [
    CheckDef("polybag_present", "polybag_sealed", "Poly-bag present", "polybag", True,
             lambda r: r.requires_polybag, "The unit is enclosed in a transparent poly bag."),
    CheckDef("polybag_sealed", "polybag_sealed", "Poly-bag sealed", "seal", True,
             lambda r: r.requires_polybag, "The poly bag is fully sealed with no open side."),
    CheckDef("suffocation_warning_present", "suffocation_warning", "Suffocation warning present", "suffocation", True,
             lambda r: r.requires_suffocation_warning,
             "A suffocation warning is printed on the bag or an attached label."),
    CheckDef("suffocation_warning_legible", "suffocation_warning", "Suffocation warning legible", "suffocation", True,
             lambda r: r.requires_suffocation_warning, "The suffocation warning text is fully visible and readable."),
    CheckDef("fnsku_present", "fnsku_label_placement", "FNSKU label present", "fnsku", True,
             lambda r: True, "A scannable FNSKU barcode label is applied to the unit."),
    CheckDef("fnsku_placement", "fnsku_label_placement", "FNSKU placement", "placement", True,
             lambda r: True, "The FNSKU label lies flat, not across a curve, seam, corner or edge."),
    CheckDef("fnsku_text_match", "fnsku_text_match", "FNSKU text matches product", "match", True,
             lambda r: True, "The printed FNSKU equals the expected code for this product."),
    CheckDef("original_barcode_covered", "original_barcode_covered", "Original barcode covered", "cover", True,
             lambda r: r.cover_original_barcode, "The manufacturer barcode is covered or unscannable."),
    CheckDef("expiry_visible", "expiry_legible", "Expiry date visible", "expiry", True,
             lambda r: r.has_expiry, "The expiration date is printed on the unit and still visible."),
    CheckDef("handling_marks_present", "handling_marks", "Handling marks present", "handling", True,
             lambda r: bool(r.handling_marks), "The required handling marking is displayed on the exterior."),
    CheckDef("bag_thickness_material", "bag_thickness_material", "Bag thickness / material", "thickness", False,
             lambda r: r.requires_polybag, "Bag is a durable material at least 1.5 mil thick."),
]

# Contract check_keys in the order they appear in the record (same keys the organiser stub emitted, plus
# fnsku_text_match, which the reference checks separately).
CONTRACT_KEYS = ["polybag_sealed", "suffocation_warning", "fnsku_label_placement", "fnsku_text_match",
                 "original_barcode_covered", "expiry_legible", "handling_marks"]


def observable(req: Requirements) -> list[CheckDef]:
    """Checks the model is asked to observe: verifiable, applicable, and not the derived text match."""
    return [c for c in CHECKS if c.verifiable and c.id != "fnsku_text_match" and c.applies_to(req)]


def _flag(value: str | None) -> bool:
    return str(value or "").strip().lower() in ("true", "yes", "1", "y")


def requirements_from_work_order(row: dict) -> Requirements:
    """Map a work-order row (data/sample/prep_sample.csv) onto the rule pack's requirements.

    The wo_* flags are the work order's own (dummy) flags. The sample has no column for covering the original
    barcode, so it is always required (any barcode other than the FNSKU must not be scannable).
    """
    marks = [m.strip().lower() for m in str(row.get("wo_handling_marks") or "").split(";") if m.strip()]
    return Requirements(
        sku=row.get("sku", ""),
        expected_fnsku=(row.get("fnsku") or "").strip(),
        name=row.get("sku", ""),
        requires_polybag=_flag(row.get("wo_polybag")),
        requires_suffocation_warning=_flag(row.get("wo_suffocation_warning")),
        has_expiry=_flag(row.get("wo_expiry_date")),
        handling_marks=[MARK_NAMES.get(m, m.replace("_", " ").title()) for m in marks],
        cover_original_barcode=True,
    )
