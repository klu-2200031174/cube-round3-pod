import type { Observation } from "../lib/observation";
import type { PoLine } from "../lib/types";

export const po: PoLine = {
  unit_id: "UNIT-0001",
  org_id: "org_demo_alpha",
  po_number: "PO-7000",
  po_line: 2,
  supplier: "Supplier East (DUMMY)",
  sku: "SKU-BOTTLE-750",
  asin: "B0DUMMY622",
  product_title: "Steel Water Bottle",
  spec_colour: "blue",
  spec_variant: "750ml",
  spec_components: ["bottle", "lid"],
  cartons_ordered: 2,
  units_per_carton_ordered: 12,
  qty_ordered: 24,
};

/** An observation of a perfect delivery; tests override single fields to build each scenario. */
export function goodObs(over: Partial<Observation> = {}): Observation {
  return {
    photo_quality: "good",
    photo_quality_reason: "sharp and well lit",
    product_type: "water bottle",
    product_description: "a blue steel water bottle with a black lid",
    product_photos: [3],
    colour_seen: "blue",
    label_text: "Steel Water Bottle 750 ml",
    cartons_visible: 2,
    cartons_fully_visible: true,
    units_in_open_carton: 12,
    open_carton_fully_visible: true,
    count_photos: [1, 2],
    carton_damage: "none",
    carton_damage_types: [],
    carton_damage_reason: "cartons intact",
    carton_damage_photos: [1],
    unit_damage: "none",
    unit_damage_types: [],
    unit_damage_reason: "units intact",
    unit_damage_photos: [3],
    opened_unit_visible: true,
    parts_seen: ["bottle", "lid"],
    defect_present: "no",
    defect_description: "",
    defect_photos: [],
    ...over,
  };
}
