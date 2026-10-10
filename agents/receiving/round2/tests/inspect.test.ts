import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { canonicalJson, verifyRecord } from "../lib/evidence";
import { inspectUnit } from "../lib/inspect";
import type { PhotoInput } from "../lib/types";
import { VisionError, type VisionProvider } from "../lib/vision/provider";
import { goodObs, po } from "./helpers";

async function photo(role: PhotoInput["role"], colour: string): Promise<PhotoInput> {
  const bytes = await sharp({ create: { width: 800, height: 600, channels: 3, background: colour } }).jpeg().toBuffer();
  return { role, ref: `fixtures/test_${role}.jpg`, bytes };
}

// VisionProvider.observe takes no PO line at all: the model is blind to what's expected.
const fake = (impl: VisionProvider["observe"]): VisionProvider => ({ provider: "fake", model: "fake-1", observe: impl });

describe("inspectUnit", () => {
  it("makes exactly one model call per unit, with one composed image", async () => {
    let calls = 0;
    let roles: string[] = [];
    const provider = fake(async (sheet, r) => {
      calls++;
      roles = r;
      const meta = await sharp(sheet).metadata();
      expect(meta.width).toBe(1280); // 2 columns × 640
      return { observation: goodObs(), raw_output: "{}", latency_ms: 5 };
    });
    const rec = await inspectUnit({
      po, provider, operator_id: "op_test",
      photos: [await photo("pallet", "#884"), await photo("carton", "#488"), await photo("unit", "#448")],
      counts: { cartons_received: 2, units_per_carton_counted: 12 },
    });
    expect(calls).toBe(1);
    expect(roles).toEqual(["pallet", "carton", "unit"]);
    expect(rec.status).toBe("complete");
    expect(rec.overall).toBe("ACCEPT");
    expect(rec.summary).toMatchObject({ qty_received: 24, identity_match: "yes", carton_damage: "none", quality_flags: [] });
    expect(rec.photos.map((p) => p.index)).toEqual([1, 2, 3]);
    expect(verifyRecord(rec)).toBe(true);
  });

  it("fails open: model timeout still produces a pending record", async () => {
    const provider = fake(async () => {
      throw new VisionError("Ollama timed out after 120000 ms", null, 120000);
    });
    const rec = await inspectUnit({ po, provider, operator_id: "op_test", photos: [await photo("unit", "#444")] });
    expect(rec.status).toBe("pending");
    expect(rec.overall).toBe("REVIEW");
    expect(rec.model.error).toContain("timed out");
    expect(rec.photos).toHaveLength(1);
    expect(verifyRecord(rec)).toBe(true);
  });

  it("fails open on unexpected errors and on zero photos", async () => {
    const boom = fake(async () => {
      throw new Error("socket hang up");
    });
    expect((await inspectUnit({ po, provider: boom, operator_id: "o", photos: [await photo("unit", "#000")] })).status).toBe("pending");
    expect((await inspectUnit({ po, provider: boom, operator_id: "o", photos: [] })).model.error).toBe("No photos supplied");
  });

  it("CSV-compatible summary flags wrong colour and missing components", async () => {
    const provider = fake(async () => ({
      observation: goodObs({ colour_seen: "red", parts_seen: ["bottle"] }),
      raw_output: "{}",
      latency_ms: 1,
    }));
    const rec = await inspectUnit({ po, provider, operator_id: "o", photos: [await photo("unit", "#123")] });
    expect(rec.summary.quality_flags).toEqual(["wrong_colour", "missing_components"]);
    expect(rec.overall).toBe("EXCEPTION");
  });

  it("drops photo citations that point at photos that don't exist", async () => {
    const provider = fake(async () => ({ observation: goodObs({ product_photos: [1, 2, 2, 7] }), raw_output: "{}", latency_ms: 1 }));
    const rec = await inspectUnit({ po, provider, operator_id: "o", photos: [await photo("unit", "#123")] });
    expect(rec.checks.find((c) => c.name === "identity")!.photo_refs).toEqual([1]);
  });

  it("content hash detects edits", async () => {
    const provider = fake(async () => ({ observation: goodObs(), raw_output: "{}", latency_ms: 1 }));
    const rec = await inspectUnit({ po, provider, operator_id: "o", photos: [await photo("unit", "#123")] });
    expect(verifyRecord({ ...rec, overall: "ACCEPT", operator_id: "someone_else" })).toBe(false);
    expect(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe('{"a":[2,{"c":2,"d":1}],"b":1}');
  });

  it("lists issues: FAILs first, then UNCERTAINs, one per non-PASS check", async () => {
    const provider = fake(async () => ({
      observation: goodObs({ carton_damage: "damaged", carton_damage_types: ["water"], defect_present: "unclear" }),
      raw_output: "{}",
      latency_ms: 1,
    }));
    const rec = await inspectUnit({ po, provider, operator_id: "o", photos: [await photo("carton", "#555")], counts: { cartons_received: 1 } });
    expect(rec.issues.map((i) => `${i.verdict}:${i.check}`)).toEqual([
      // operator says 1 carton, photo shows 2 → conflicting counts are UNCERTAIN, not FAIL
      "FAIL:carton_damage", "UNCERTAIN:carton_count", "UNCERTAIN:quantity", "UNCERTAIN:defects",
    ]);
    expect(rec.issues.length).toBe(rec.checks.filter((c) => c.verdict !== "PASS").length);
    expect(verifyRecord(rec)).toBe(true);
  });
});
