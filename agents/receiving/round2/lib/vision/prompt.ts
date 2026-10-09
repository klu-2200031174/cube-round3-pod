// Bump whenever the prompt text changes; it's written into every evidence record and the eval
// report, so results are always traceable to the exact prompt that produced them.
//   0.1       — showed the PO line; the model echoed it back (failure mode F1).
//   0.2-blind — the model never sees the PO; it only describes. Code does the comparing.
export const PROMPT_VERSION = "rcv-prompt/0.2-blind";

export const SYSTEM_PROMPT = `You are a warehouse receiving inspector. You describe photos of a supplier delivery exactly as they are.

Rules:
- Describe ONLY what is visible. Never assume or guess what "should" be there.
- If something cannot be seen clearly, say "unclear" (or null for counts and text). That is a correct answer.
- Photos are labelled "#1", "#2", ... Cite photo numbers for what you report.
- Count only what you can actually see. If cartons or units are hidden or cut off, set the matching "fully_visible" flag to false.
- Damage types: crushing (dents, collapsed corners, bent boxes), water (stains, darkened or warped cardboard, wet marks), tears (rips, holes, torn tape or packaging).
- Answer in the required JSON format only.`;

export function buildUserPrompt(photoRoles: string[]): string {
  return `The image is a contact sheet of ${photoRoles.length} photo(s): ${photoRoles.map((r, i) => `#${i + 1} ${r}`).join(", ")}.

Describe the delivery:
1. photo_quality: good / poor (blurry, dark, partly cut off) / unusable, with a reason.
2. product_type: what the product is, in 1-3 plain words (e.g. "water bottle", "bath towel", "usb cable"). "unclear" if you can't tell.
3. product_description: one sentence describing the product.
4. colour_seen: the main colour of the product itself (not the box), or null.
5. label_text: copy every word and number you can read on labels, boxes or the product (sizes, volumes, counts, names). null if none.
6. cartons_visible: how many whole cartons you can count; units_in_open_carton: how many units inside an opened carton. null if not shown.
7. carton_damage and unit_damage: none / damaged / unclear, with types and photo numbers.
8. opened_unit_visible: true only if a unit is shown out of its packaging. parts_seen: each separate part or accessory visible with it (e.g. "lid", "scoop", "manual").
9. defect_present: any other obvious defect (broken, cracked, stained, misprinted): yes / no / unclear.`;
}
