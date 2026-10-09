import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "csv-parse/sync";
import type { PoLine } from "./types";

// Loads the EXPECTED side (PO line + catalogue spec) from the organisers' sample CSV.
// The CSV's observed/verdict columns (identity_match, carton_damage, ...) are ignored here:
// they are dummy example values, not rules (engineering rule 5).

type Row = Record<string, string>;

export function rowToPoLine(r: Row): PoLine {
  return {
    unit_id: r.unit_id,
    org_id: r.org_id,
    po_number: r.po_number,
    po_line: Number(r.po_line),
    supplier: r.supplier,
    sku: r.sku,
    asin: r.asin,
    product_title: r.product_title,
    spec_colour: r.spec_colour,
    spec_variant: r.spec_variant,
    spec_components: r.spec_components.split(";").map((s) => s.trim()).filter(Boolean),
    cartons_ordered: Number(r.cartons_ordered),
    units_per_carton_ordered: Number(r.units_per_carton_ordered),
    qty_ordered: Number(r.qty_ordered),
  };
}

// The organisers' shared data/ folder at the repo root (this file lives in submissions/<user>/agent/lib/).
export const SAMPLE_CSV = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../data/receiving_sample.csv");

export function loadPoLines(csvPath = SAMPLE_CSV): PoLine[] {
  const rows = parse(readFileSync(csvPath, "utf8"), { columns: true, skip_empty_lines: true }) as Row[];
  return rows.map(rowToPoLine);
}
