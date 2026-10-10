// Core domain types for the Receiving Manager.
// Field names deliberately mirror data/receiving_sample.csv so other pods can join on unit_id.

export type Verdict = "PASS" | "FAIL" | "UNCERTAIN";

/**
 * Overall outcome for a unit.
 * ACCEPT    — every check PASS.
 * EXCEPTION — at least one check FAIL (raise with supplier).
 * REVIEW    — no FAIL, but at least one UNCERTAIN (a human must look).
 * An overall ACCEPT is never produced while any check is FAIL or UNCERTAIN.
 */
export type Overall = "ACCEPT" | "EXCEPTION" | "REVIEW";

/** `pending` = the model call failed or timed out; the capture is saved anyway (fail open). */
export type RecordStatus = "complete" | "pending";

export type DamageType = "crushing" | "water" | "tears";

export type CheckName =
  | "identity"
  | "variant_colour"
  | "carton_count"
  | "units_per_carton"
  | "quantity"
  | "carton_damage"
  | "unit_damage"
  | "components"
  | "defects";

/** What the purchase-order line says should arrive (the "expected" side). */
export interface PoLine {
  unit_id: string;
  org_id: string;
  po_number: string;
  po_line: number;
  supplier: string;
  sku: string;
  asin: string;
  product_title: string;
  spec_colour: string; // "n/a" when colour is not part of the spec
  spec_variant: string;
  spec_components: string[];
  cartons_ordered: number;
  units_per_carton_ordered: number;
  qty_ordered: number;
}

/** Counts typed in by the operator at the dock. Optional; the photos are the other source. */
export interface OperatorCounts {
  cartons_received?: number;
  units_per_carton_counted?: number;
}

export type PhotoRole = "pallet" | "carton" | "unit" | "label" | "other";

export interface PhotoInput {
  role: PhotoRole;
  /** Where the photo is stored (storage path or local file path). */
  ref: string;
  bytes: Buffer;
}

export interface PhotoEvidence {
  index: number; // 1-based, matches the label on the contact sheet the model saw
  role: PhotoRole;
  ref: string;
  sha256: string;
}

/**
 * How much evidence stands behind a PASS or FAIL. A fixed rule, not a model probability
 * (small local models give no calibrated scores); the eval reports accuracy per level.
 *   high   — two independent sources agree (operator count confirmed by the photo count).
 *   medium — one direct source: an operator count, or the model on a good photo.
 *   low    — one weak source: a model-only count (failure mode F2) or a FAIL kept from a poor photo.
 *   null   — the verdict is UNCERTAIN. No judgement was made, so there is nothing to be confident in.
 */
export type Confidence = "high" | "medium" | "low";

export interface Check {
  name: CheckName;
  verdict: Verdict;
  confidence: Confidence | null;
  expected: string | number | string[] | null;
  observed: string | number | string[] | null;
  /** Which source produced `observed`: the model, the operator, or code deriving it from other checks. */
  source: "model" | "operator" | "derived" | "none";
  /** 1-based photo indexes the model cited, when it cited any. */
  photo_refs: number[];
  reason: string;
}
