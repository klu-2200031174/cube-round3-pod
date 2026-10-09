// Deterministic comparison of the model's blind description against the PO line.
// Deliberately simple word matching: every decision can be explained in one sentence and
// reproduced by hand. Its misses (synonyms like "tumbler" for "bottle") are measured in the eval.

export type MatchStatus = "match" | "mismatch" | "unknown";

const PLACEHOLDER = /^\s*(none|n\/?a|nothing|null|unknown|unclear|not visible|-|)\s*\.?\s*$/i;
export const isPlaceholder = (s: string | null | undefined) => s == null || PLACEHOLDER.test(s);

const STOP = new Set([
  "the", "and", "with", "for", "set", "pack", "pcs", "piece", "pieces", "unit", "units", "item", "items",
  "product", "one", "two", "three", "box", "carton", "package", "packaging", "sku", "inside", "some",
]);

// Colour families: any two words in the same family count as the same colour.
const COLOUR_FAMILIES: string[][] = [
  ["blue", "navy", "azure", "cobalt", "royal"],
  ["red", "maroon", "crimson", "burgundy", "scarlet"],
  ["green", "olive", "lime", "emerald"],
  ["black", "jet"],
  ["white", "offwhite"],
  ["cream", "ivory", "beige", "offwhite", "eggshell"],
  ["grey", "gray", "silver", "charcoal", "graphite"],
  ["yellow", "gold", "mustard"],
  ["pink", "rose", "magenta"],
  ["purple", "violet", "lilac", "lavender"],
  ["orange", "amber"],
  ["brown", "tan", "chocolate"],
];
const COLOUR_WORDS = new Set(COLOUR_FAMILIES.flat());

function singular(w: string): string {
  if (w.length > 4 && w.endsWith("ies")) return `${w.slice(0, -3)}y`;
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

export function words(s: string | null | undefined): string[] {
  if (!s) return [];
  return s
    .toLowerCase()
    .replace(/off[\s-]white/g, "offwhite")
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map(singular);
}

/** Meaningful product words: no stopwords, no colours, no numbers, 3+ letters. */
function productWords(s: string | null | undefined): string[] {
  return words(s).filter((w) => w.length >= 3 && !STOP.has(w) && !COLOUR_WORDS.has(w) && !/^\d/.test(w));
}

export interface IdentityMatch {
  status: MatchStatus;
  shared: string[];
  /** The model described only packaging ("cardboard carton", "small boxes"), not the product. */
  packagingOnly: boolean;
}

// Words that describe the outside of goods (packaging, quantity, look) rather than what the
// product is. Failure mode F7: on closed cartons the model answered product_type "cardboard
// carton" or "small boxes", which shares no word with any PO title and so read as a wrong SKU.
// Entries are in the singular form `words()` produces ("boxes" → "boxe").
const PACKAGING = new Set([
  "boxe", "boxed", "cardboard", "corrugated", "shipping", "shipper", "parcel", "packed", "mailer",
  "envelope", "container", "wrap", "wrapped", "wrapping", "master", "outer", "inner", "small", "large",
  "big", "sealed", "open", "opened", "closed", "multiple", "several", "stack", "stacked", "pile",
  "bundle", "pallet", "tape", "taped", "barcode", "sticker", "goods", "merchandise", "contents",
]);

/** True when a description names only packaging, e.g. "cardboard carton", "small boxed items", "box". */
export function isPackagingOnly(type: string): boolean {
  return productWords(type).every((w) => PACKAGING.has(w));
}

/** Is what the model saw the product on the PO line? Match on shared product words. */
export function matchIdentity(productTitle: string, sku: string, seen: { type: string; description: string; label: string | null }): IdentityMatch {
  if (isPlaceholder(seen.type)) return { status: "unknown", shared: [], packagingOnly: false };
  const expected = new Set([...productWords(productTitle), ...productWords(sku.replace(/^SKU-/i, ""))]);
  if (isPackagingOnly(seen.type)) {
    // Only the outside was seen. A printed label can still name the product and confirm it;
    // nothing seen can prove it's the wrong product, so there is no mismatch from packaging.
    const onLabel = new Set(productWords(seen.label).filter((w) => !PACKAGING.has(w)));
    const shared = [...expected].filter((w) => onLabel.has(w));
    return { status: shared.length ? "match" : "unknown", shared, packagingOnly: true };
  }
  const observed = new Set(productWords(`${seen.type} ${seen.description} ${seen.label ?? ""}`));
  const shared = [...expected].filter((w) => observed.has(w));
  return { status: shared.length ? "match" : "mismatch", shared, packagingOnly: false };
}

function colourFamilies(s: string | null | undefined): Set<number> {
  const fams = new Set<number>();
  for (const w of words(s)) COLOUR_FAMILIES.forEach((f, i) => f.includes(w) && fams.add(i));
  return fams;
}

/** Spec colour vs colour seen. "unknown" when the model named no recognisable colour. */
export function matchColour(spec: string, seen: string | null): MatchStatus {
  if (isPlaceholder(seen)) return "unknown";
  const want = colourFamilies(spec);
  const got = colourFamilies(seen);
  if (want.size === 0 || got.size === 0) return "unknown";
  return [...want].some((f) => got.has(f)) ? "match" : "mismatch";
}

const MEASURE = /(\d+(?:\.\d+)?)(ml|l|oz|kg|g|ft|cm|m|pc|pack)\b/g;
const compact = (s: string) =>
  s.toLowerCase().replace(/(\d)\s*[-\s]?\s*(ml|l|oz|kg|g|ft|cm|m|pcs?|pack|pieces?)\b/g, "$1$2").replace(/pcs\b|pieces?\b/g, "pc");

/**
 * Spec variant (e.g. "750ml", "3-pack", "1kg vanilla", "bath") vs label text the model read.
 * match    — the spec variant is printed on the label.
 * mismatch — the label prints a different measurement in the same unit (e.g. 500ml vs 750ml).
 * unknown  — nothing on the label settles it (typical for variants like "standard" or "bath").
 */
export function matchVariant(spec: string, labelText: string | null): MatchStatus {
  if (isPlaceholder(labelText)) return "unknown";
  const label = compact(labelText!);
  const want = compact(spec);
  if (label.replace(/[^a-z0-9]/g, "").includes(want.replace(/[^a-z0-9]/g, ""))) return "match";
  const wantMeasures = [...want.matchAll(MEASURE)];
  if (wantMeasures.length === 0) return "unknown";
  for (const [, num, unit] of wantMeasures) {
    const sameUnit = [...label.matchAll(MEASURE)].filter((m) => m[2] === unit);
    if (sameUnit.length > 0 && !sameUnit.some((m) => Number(m[1]) === Number(num))) return "mismatch";
  }
  return "unknown";
}

/** Which expected components (e.g. "candle x3", "usb cable") have no matching word in what was seen. */
export function missingComponents(expected: string[], seen: string[]): string[] {
  const seenWords = new Set(seen.filter((s) => !isPlaceholder(s)).flatMap(productWords));
  return expected.filter((c) => {
    const cw = productWords(c);
    return cw.length > 0 && !cw.some((w) => seenWords.has(w));
  });
}
