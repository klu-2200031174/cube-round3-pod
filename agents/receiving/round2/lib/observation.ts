import { z } from "zod";

// What the vision model reports. BLIND by design: the model is never shown the PO line, so it
// can't echo it back (failure mode F1, seen on the first real LLaVA run: shown "Cotton Bath Towel
// ×24", it "saw" a towel and 24 units in a photo of one bottle). It only describes the photos;
// lib/match.ts and lib/decide.ts compare that description with the PO. Kept flat because small
// local models follow flat schemas far more reliably than nested ones.

const triState = z.enum(["yes", "no", "unclear"]);
const damageStatus = z.enum(["none", "damaged", "unclear"]);
const damageType = z.enum(["crushing", "water", "tears"]);
const count = z.number().int().min(0).max(10000).nullable();
const photos = z.array(z.number().int().min(1)).max(20);

export const ObservationSchema = z.object({
  photo_quality: z.enum(["good", "poor", "unusable"]),
  photo_quality_reason: z.string(),

  product_type: z.string(), // short noun phrase, e.g. "water bottle"; "unclear" if not identifiable
  product_description: z.string(),
  product_photos: photos,
  colour_seen: z.string().nullable(),
  label_text: z.string().nullable(), // every word/number readable on labels or the product

  cartons_visible: count,
  cartons_fully_visible: z.boolean(),
  units_in_open_carton: count,
  open_carton_fully_visible: z.boolean(),
  count_photos: photos,

  carton_damage: damageStatus,
  carton_damage_types: z.array(damageType),
  carton_damage_reason: z.string(),
  carton_damage_photos: photos,

  unit_damage: damageStatus,
  unit_damage_types: z.array(damageType),
  unit_damage_reason: z.string(),
  unit_damage_photos: photos,

  opened_unit_visible: z.boolean(), // is at least one unit shown out of its packaging?
  parts_seen: z.array(z.string()), // separate parts/accessories visible with the unit

  defect_present: triState,
  defect_description: z.string(),
  defect_photos: photos,
});

export type Observation = z.infer<typeof ObservationSchema>;

/** JSON schema handed to Ollama's `format` field so decoding is constrained to this shape. */
export const observationJsonSchema = z.toJSONSchema(ObservationSchema);
