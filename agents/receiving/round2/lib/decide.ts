import type { Check, Confidence, OperatorCounts, Overall, PhotoRole, PoLine, Verdict } from "./types";
import type { Observation } from "./observation";
import { isPlaceholder, matchColour, matchIdentity, matchVariant, missingComponents, type MatchStatus } from "./match";

// Deterministic decision layer. The model reports what it sees; this file compares that
// (and any operator counts) against the PO line. Rules:
//  - No usable observation            → every visual check is UNCERTAIN, never PASS.
//  - The model never sees the PO (blind prompt); lib/match.ts compares its description.
//  - Model says "unclear" / nothing matchable → UNCERTAIN.
//  - Photo quality "poor"             → a PASS is downgraded to UNCERTAIN (we don't vouch for
//                                       goods we couldn't see properly); a FAIL is kept, because
//                                       a visible problem in a poor photo is still a problem, and
//                                       EXCEPTIONs go to a human anyway.
//  - Operator and photo counts differ → UNCERTAIN (conflicting evidence is insufficient evidence).
//  - Self-contradictory model output  → UNCERTAIN.
//  - Only packaging described (no product visible) → identity UNCERTAIN, never a wrong-SKU FAIL (F7).
//  - "No damage" on a carton or unit that isn't in the photos → UNCERTAIN (failure mode F3: on a
//    photo of a bare bottle LLaVA answered carton damage "none", which read as a carton PASS).

/** A check before its confidence is settled; count checks set theirs, the rest get it in decide(). */
type Draft = Omit<Check, "confidence"> & { confidence?: Confidence | null };

const statusVerdict = (s: MatchStatus): Verdict => (s === "match" ? "PASS" : s === "mismatch" ? "FAIL" : "UNCERTAIN");

function noObservationReason(obs: Observation | null): string {
  if (!obs) return "No model observation (model unavailable or output invalid); needs review.";
  return `Photos unusable: ${obs.photo_quality_reason || "no reason given"}.`;
}

function applyPhotoQuality(check: Draft, obs: Observation): Draft {
  if (obs.photo_quality === "poor" && check.verdict === "PASS" && check.source === "model") {
    return {
      ...check,
      verdict: "UNCERTAIN",
      reason: `${check.reason} Downgraded from PASS: photo quality poor (${obs.photo_quality_reason}).`,
    };
  }
  return check;
}

function identityCheck(po: PoLine, obs: Observation | null): Draft {
  const base = { name: "identity" as const, expected: `${po.sku} · ${po.product_title}` };
  if (!obs || obs.photo_quality === "unusable") {
    return { ...base, verdict: "UNCERTAIN", observed: null, source: "none", photo_refs: [], reason: noObservationReason(obs) };
  }
  const m = matchIdentity(po.product_title, po.sku, { type: obs.product_type, description: obs.product_description, label: obs.label_text });
  const reason =
    m.status === "match"
      ? `Seen "${obs.product_type}"; shares "${m.shared.join(", ")}" with the PO line.`
      : m.status === "mismatch"
        ? `Seen "${obs.product_type}" (${obs.product_description}); no product word in common with "${po.product_title}".`
        : m.packagingOnly
          ? `Only packaging was seen ("${obs.product_type}"); the product itself isn't visible and no label names it.`
          : "The model couldn't tell what the product is.";
  return { ...base, verdict: statusVerdict(m.status), observed: obs.product_type, source: "model", photo_refs: obs.product_photos, reason };
}

export interface VariantColourResult {
  colour: MatchStatus | "not_in_spec";
  variant: MatchStatus;
}

export function variantColourStatus(po: PoLine, obs: Observation): VariantColourResult {
  const colourInSpec = po.spec_colour.trim().toLowerCase() !== "n/a";
  return {
    colour: colourInSpec ? matchColour(po.spec_colour, obs.colour_seen) : "not_in_spec",
    variant: matchVariant(po.spec_variant, obs.label_text),
  };
}

function variantColourCheck(po: PoLine, obs: Observation | null): Draft {
  const colourInSpec = po.spec_colour.trim().toLowerCase() !== "n/a";
  const base = {
    name: "variant_colour" as const,
    expected: colourInSpec ? `${po.spec_colour} · ${po.spec_variant}` : po.spec_variant,
  };
  if (!obs || obs.photo_quality === "unusable") {
    return { ...base, verdict: "UNCERTAIN", observed: null, source: "none", photo_refs: [], reason: noObservationReason(obs) };
  }
  const st = variantColourStatus(po, obs);
  const parts: MatchStatus[] = [st.variant, ...(st.colour === "not_in_spec" ? [] : [st.colour])];
  const verdict: Verdict = parts.includes("mismatch") ? "FAIL" : parts.includes("unknown") ? "UNCERTAIN" : "PASS";

  const notes: string[] = [];
  if (st.colour !== "not_in_spec") {
    notes.push(
      st.colour === "match" ? `colour "${obs.colour_seen}" matches ${po.spec_colour}`
        : st.colour === "mismatch" ? `wrong colour: "${obs.colour_seen}", spec is ${po.spec_colour}`
          : `colour not determinable (seen: ${obs.colour_seen ?? "nothing"})`,
    );
  }
  notes.push(
    st.variant === "match" ? `label shows "${po.spec_variant}"`
      : st.variant === "mismatch" ? `wrong variant: label reads "${obs.label_text}", spec is ${po.spec_variant}`
        : `variant "${po.spec_variant}" not confirmed by any label text`,
  );
  const observed = [colourInSpec ? obs.colour_seen ?? "colour not seen" : null, obs.label_text ?? "no label text"].filter(Boolean).join(" · ");
  return { ...base, verdict, observed, source: "model", photo_refs: obs.product_photos, reason: `${notes.join("; ")}.` };
}

/** Shared logic for carton count and units-per-carton: operator count first, photo count as corroboration. */
function countCheck(
  name: "carton_count" | "units_per_carton",
  expected: number,
  operator: number | undefined,
  modelCount: number | null | undefined,
  modelFullyVisible: boolean,
  photoRefs: number[],
): { check: Draft; value: number | null } {
  const label = name === "carton_count" ? "cartons" : "units per carton";
  const modelUsable = modelCount != null && modelFullyVisible;

  if (operator != null) {
    if (modelUsable && modelCount !== operator) {
      return {
        value: null,
        check: {
          name, expected, verdict: "UNCERTAIN", confidence: null, source: "operator",
          observed: `operator ${operator} / photo ${modelCount}`,
          photo_refs: photoRefs,
          reason: `Operator counted ${operator} ${label} but the photos show ${modelCount}; conflicting evidence, recount needed.`,
        },
      };
    }
    const corroboration = modelUsable
      ? " Photo count agrees."
      : modelCount != null
        ? ` Photos show only part of it (${modelCount} visible), so the photo count isn't used.`
        : " No photo count available.";
    return {
      value: operator,
      check: {
        name, expected, observed: operator, source: "operator", photo_refs: photoRefs,
        verdict: operator === expected ? "PASS" : "FAIL",
        // Two independent sources agreeing beats one.
        confidence: modelUsable ? "high" : "medium",
        reason: `Operator counted ${operator} ${label}, ${expected} ordered.${corroboration}`,
      },
    };
  }

  if (modelUsable) {
    return {
      value: modelCount,
      check: {
        name, expected, observed: modelCount, source: "model", photo_refs: photoRefs,
        verdict: modelCount === expected ? "PASS" : "FAIL",
        // Model-only counts are the weakest evidence we produce (failure mode F2: an invented carton).
        confidence: "low",
        reason: `Photos show ${modelCount} ${label}, ${expected} ordered. No operator count to cross-check.`,
      },
    };
  }

  return {
    value: null,
    check: {
      name, expected, observed: modelCount ?? null, source: modelCount != null ? "model" : "none", photo_refs: modelCount != null ? photoRefs : [],
      verdict: "UNCERTAIN",
      reason:
        modelCount != null
          ? `Photos show ${modelCount} ${label} but not all of them are visible, and there's no operator count.`
          : `No operator count and no reliable photo count for ${label}.`,
    },
  };
}

function quantityCheck(po: PoLine, cartons: number | null, perCarton: number | null): Draft {
  const base = { name: "quantity" as const, expected: po.qty_ordered, source: "derived" as const, photo_refs: [] };
  if (cartons == null || perCarton == null) {
    return {
      ...base, verdict: "UNCERTAIN", observed: null,
      reason: "Total can't be derived: carton count or units per carton is uncertain.",
    };
  }
  const received = cartons * perCarton;
  const diff = received - po.qty_ordered;
  return {
    ...base,
    observed: received,
    verdict: diff === 0 ? "PASS" : "FAIL",
    reason:
      `${cartons} cartons × ${perCarton} units = ${received}, ${po.qty_ordered} ordered` +
      (diff < 0 ? ` (short by ${-diff}).` : diff > 0 ? ` (${diff} extra).` : ".") +
      " Assumes every carton holds the same count as the one that was opened.",
  };
}

function damageCheck(
  name: "carton_damage" | "unit_damage",
  obs: Observation | null,
  photoRoles: PhotoRole[] = [],
): Draft {
  const base = { name, expected: "none" };
  if (!obs || obs.photo_quality === "unusable") {
    return { ...base, verdict: "UNCERTAIN", observed: null, source: "none", photo_refs: [], reason: noObservationReason(obs) };
  }
  const status = name === "carton_damage" ? obs.carton_damage : obs.unit_damage;
  const types = name === "carton_damage" ? obs.carton_damage_types : obs.unit_damage_types;
  const said = name === "carton_damage" ? obs.carton_damage_reason : obs.unit_damage_reason;
  // Models often answer the reason field with a bare "none"; say what that means instead.
  const reason = isPlaceholder(said) ? `No ${name === "carton_damage" ? "carton" : "product"} damage reported by the model.` : said;
  const photo_refs = name === "carton_damage" ? obs.carton_damage_photos : obs.unit_damage_photos;
  const common = { ...base, source: "model" as const, photo_refs };

  if (status === "none" && types.length > 0) {
    return {
      ...common, verdict: "UNCERTAIN", observed: types,
      reason: `Model output contradicts itself: status "none" but lists ${types.join(", ")}. ${reason}`,
    };
  }
  if (status === "damaged") {
    return { ...common, verdict: "FAIL", observed: types.length ? types : ["unspecified"], reason };
  }
  if (status === "unclear") return { ...common, verdict: "UNCERTAIN", observed: null, reason };
  // A PASS vouches for the thing's condition, so the thing has to be in the photos.
  const shown =
    name === "carton_damage"
      ? (obs.cartons_visible ?? 0) > 0 || photoRoles.some((r) => r === "carton" || r === "pallet")
      : !isPlaceholder(obs.product_type);
  if (!shown) {
    return {
      ...common, verdict: "UNCERTAIN", observed: null,
      reason: name === "carton_damage"
        ? "No carton in the photos, so its condition can't be vouched for."
        : "The product can't be made out in the photos, so its condition can't be vouched for.",
    };
  }
  return { ...common, verdict: "PASS", observed: "none", reason };
}

function componentsCheck(po: PoLine, obs: Observation | null): Draft {
  const base = { name: "components" as const, expected: po.spec_components };
  if (!obs || obs.photo_quality === "unusable") {
    return { ...base, verdict: "UNCERTAIN", observed: null, source: "none", photo_refs: [], reason: noObservationReason(obs) };
  }
  const seen = obs.parts_seen.filter((p) => !isPlaceholder(p));
  const common = { ...base, source: "model" as const, photo_refs: obs.product_photos, observed: seen };
  if (!obs.opened_unit_visible) {
    return { ...common, verdict: "UNCERTAIN", reason: "No unit is shown out of its packaging, so components can't be checked." };
  }
  // The product itself counts as seen (a "towel" spec component is satisfied by seeing a towel).
  const missing = missingComponents(po.spec_components, [...seen, obs.product_type]);
  if (missing.length > 0) {
    return { ...common, verdict: "FAIL", reason: `Opened unit shown, but not seen: ${missing.join(", ")}. Seen: ${seen.join(", ") || "nothing listed"}.` };
  }
  return { ...common, verdict: "PASS", reason: `All expected components seen: ${po.spec_components.join(", ")}.` };
}

function defectsCheck(obs: Observation | null): Draft {
  const base = { name: "defects" as const, expected: "none" };
  if (!obs || obs.photo_quality === "unusable") {
    return { ...base, verdict: "UNCERTAIN", observed: null, source: "none", photo_refs: [], reason: noObservationReason(obs) };
  }
  return {
    ...base,
    // "defect present: yes" is the failing answer here.
    verdict: obs.defect_present === "yes" ? "FAIL" : obs.defect_present === "no" ? "PASS" : "UNCERTAIN",
    observed: obs.defect_present === "no" ? "none" : obs.defect_description || null,
    source: "model",
    photo_refs: obs.defect_photos,
    reason: obs.defect_description || (obs.defect_present === "no" ? "No obvious defects seen." : "Couldn't tell."),
  };
}

/** Runs every check. `obs` is null when the model call failed (fail open → record saved as pending). */
export function decide(po: PoLine, obs: Observation | null, counts: OperatorCounts = {}, photoRoles: PhotoRole[] = []): Check[] {
  const usable = obs != null && obs.photo_quality !== "unusable";
  const cartons = countCheck(
    "carton_count", po.cartons_ordered, counts.cartons_received,
    usable ? obs.cartons_visible : null, usable ? obs.cartons_fully_visible : false, usable ? obs.count_photos : [],
  );
  const perCarton = countCheck(
    "units_per_carton", po.units_per_carton_ordered, counts.units_per_carton_counted,
    usable ? obs.units_in_open_carton : null, usable ? obs.open_carton_fully_visible : false, usable ? obs.count_photos : [],
  );

  const drafts: Draft[] = [
    identityCheck(po, obs),
    variantColourCheck(po, obs),
    cartons.check,
    perCarton.check,
    quantityCheck(po, cartons.value, perCarton.value),
    damageCheck("carton_damage", obs, photoRoles),
    damageCheck("unit_damage", obs, photoRoles),
    componentsCheck(po, obs),
    defectsCheck(obs),
  ];
  const checks = (obs ? drafts.map((c) => applyPhotoQuality(c, obs)) : drafts).map((c) => withConfidence(c, obs));

  // The total is only as good as the weaker of the two counts it multiplies.
  const q = checks.find((c) => c.name === "quantity")!;
  if (q.verdict !== "UNCERTAIN") q.confidence = weakest(checks.filter((c) => c.name === "carton_count" || c.name === "units_per_carton"));
  return checks;
}

const RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };

function weakest(checks: Check[]): Confidence | null {
  const levels = checks.map((c) => c.confidence).filter((x): x is Confidence => x != null);
  return levels.length ? levels.reduce((a, b) => (RANK[b] < RANK[a] ? b : a)) : null;
}

/** Settles confidence by the fixed rule documented on the Confidence type. */
function withConfidence(c: Draft, obs: Observation | null): Check {
  if (c.verdict === "UNCERTAIN") return { ...c, confidence: null };
  if (c.confidence !== undefined) return { ...c, confidence: c.confidence };
  // Model checks: a verdict kept from a poor photo (only FAILs survive the downgrade) is weak.
  if (c.source === "model") return { ...c, confidence: obs?.photo_quality === "good" ? "medium" : "low" };
  return { ...c, confidence: "medium" };
}

/** Any FAIL → EXCEPTION; otherwise any UNCERTAIN → REVIEW; only all-PASS → ACCEPT. */
export function overallVerdict(checks: Check[]): Overall {
  if (checks.some((c) => c.verdict === "FAIL")) return "EXCEPTION";
  if (checks.some((c) => c.verdict === "UNCERTAIN")) return "REVIEW";
  return "ACCEPT";
}
