import { describe, expect, it } from "vitest";
import { decide, overallVerdict } from "../lib/decide";
import type { Check, CheckName, Verdict } from "../lib/types";
import { goodObs, po } from "./helpers";

const v = (checks: Check[], name: CheckName): Verdict => checks.find((c) => c.name === name)!.verdict;

describe("test scenarios from the problem statement", () => {
  it("correct shipment → every check PASS, ACCEPT", () => {
    const checks = decide(po, goodObs(), { cartons_received: 2, units_per_carton_counted: 12 });
    expect(checks.every((c) => c.verdict === "PASS")).toBe(true);
    expect(overallVerdict(checks)).toBe("ACCEPT");
  });

  it("short shipment → quantity FAIL with shortfall", () => {
    const checks = decide(po, goodObs({ units_in_open_carton: 11 }), { cartons_received: 2, units_per_carton_counted: 11 });
    const q = checks.find((c) => c.name === "quantity")!;
    expect(q.verdict).toBe("FAIL");
    expect(q.observed).toBe(22);
    expect(q.reason).toContain("short by 2");
    expect(overallVerdict(checks)).toBe("EXCEPTION");
  });

  it("extra units → quantity FAIL", () => {
    const checks = decide(po, goodObs({ cartons_visible: 3 }), { cartons_received: 3, units_per_carton_counted: 12 });
    expect(v(checks, "carton_count")).toBe("FAIL");
    expect(checks.find((c) => c.name === "quantity")!.reason).toContain("12 extra");
  });

  it("wrong SKU → identity FAIL", () => {
    const checks = decide(po, goodObs({ product_type: "lunch box", product_description: "a plastic lunch box", label_text: null }));
    expect(v(checks, "identity")).toBe("FAIL");
    expect(overallVerdict(checks)).toBe("EXCEPTION");
  });

  it("wrong colour → variant_colour FAIL, identity untouched", () => {
    const checks = decide(po, goodObs({ colour_seen: "red" }));
    expect(v(checks, "variant_colour")).toBe("FAIL");
    expect(v(checks, "identity")).toBe("PASS");
  });

  it("wrong variant → variant_colour FAIL", () => {
    expect(v(decide(po, goodObs({ label_text: "Steel Water Bottle 500 ml" })), "variant_colour")).toBe("FAIL");
  });

  it.each(["crushing", "water", "tears"] as const)("%s on carton → carton_damage FAIL naming the type", (t) => {
    const c = decide(po, goodObs({ carton_damage: "damaged", carton_damage_types: [t] })).find((x) => x.name === "carton_damage")!;
    expect(c.verdict).toBe("FAIL");
    expect(c.observed).toEqual([t]);
  });

  it("torn unit packaging → unit_damage FAIL", () => {
    expect(v(decide(po, goodObs({ unit_damage: "damaged", unit_damage_types: ["tears"] })), "unit_damage")).toBe("FAIL");
  });

  it("missing components → components FAIL", () => {
    const checks = decide(po, goodObs({ parts_seen: ["bottle"] }));
    expect(v(checks, "components")).toBe("FAIL");
  });

  it("ambiguous case → UNCERTAIN, REVIEW, never ACCEPT", () => {
    const checks = decide(po, goodObs({ product_type: "unclear", carton_damage: "unclear" }));
    expect(v(checks, "identity")).toBe("UNCERTAIN");
    expect(v(checks, "carton_damage")).toBe("UNCERTAIN");
    expect(overallVerdict(checks)).toBe("REVIEW");
  });
});

describe("uncertainty handling", () => {
  it("no observation (model down) → all visual checks UNCERTAIN, operator counts still decided", () => {
    const checks = decide(po, null, { cartons_received: 1, units_per_carton_counted: 12 });
    for (const n of ["identity", "variant_colour", "carton_damage", "unit_damage", "components", "defects"] as const) {
      expect(v(checks, n)).toBe("UNCERTAIN");
    }
    expect(v(checks, "carton_count")).toBe("FAIL");
    expect(overallVerdict(checks)).toBe("EXCEPTION");
  });

  it("unusable photos → no visual PASS", () => {
    const checks = decide(po, goodObs({ photo_quality: "unusable", photo_quality_reason: "black image" }));
    expect(checks.some((c) => c.verdict === "PASS")).toBe(false);
  });

  it("poor photos downgrade model PASS to UNCERTAIN but keep FAIL", () => {
    const checks = decide(po, goodObs({ photo_quality: "poor", carton_damage: "damaged", carton_damage_types: ["water"] }));
    expect(v(checks, "identity")).toBe("UNCERTAIN");
    expect(v(checks, "carton_damage")).toBe("FAIL");
  });

  it("poor photos do not downgrade operator counts", () => {
    const checks = decide(po, goodObs({ photo_quality: "poor", cartons_visible: null }), { cartons_received: 2 });
    expect(v(checks, "carton_count")).toBe("PASS");
  });

  it("operator and photo count disagree → UNCERTAIN, quantity UNCERTAIN", () => {
    const checks = decide(po, goodObs({ cartons_visible: 1 }), { cartons_received: 2 });
    expect(v(checks, "carton_count")).toBe("UNCERTAIN");
    expect(v(checks, "quantity")).toBe("UNCERTAIN");
  });

  it("partial photo count is not used as a count", () => {
    const checks = decide(po, goodObs({ cartons_visible: 1, cartons_fully_visible: false }));
    expect(v(checks, "carton_count")).toBe("UNCERTAIN");
  });

  it("self-contradictory damage output → UNCERTAIN", () => {
    expect(v(decide(po, goodObs({ carton_damage: "none", carton_damage_types: ["water"] })), "carton_damage")).toBe("UNCERTAIN");
  });

  it('placeholder entries like "none" in parts_seen are ignored (seen in real LLaVA output)', () => {
    expect(v(decide(po, goodObs({ parts_seen: ["none", "lid"] })), "components")).toBe("PASS");
    expect(v(decide(po, goodObs({ parts_seen: ["none"] })), "components")).toBe("FAIL"); // lid not seen
  });

  it("F1 regression: a bottle checked against a towel PO line is an identity FAIL", () => {
    const towel = { ...po, sku: "SKU-TOWEL-BLU", product_title: "Cotton Bath Towel", spec_variant: "bath", spec_components: ["towel"] };
    const checks = decide(towel, goodObs());
    expect(v(checks, "identity")).toBe("FAIL");
    expect(v(checks, "variant_colour")).toBe("UNCERTAIN"); // blue matches, "bath" isn't on any label
  });

  it("variant with no label evidence → UNCERTAIN, not PASS", () => {
    expect(v(decide(po, goodObs({ label_text: null })), "variant_colour")).toBe("UNCERTAIN");
  });

  it("components not judgeable → UNCERTAIN", () => {
    expect(v(decide(po, goodObs({ opened_unit_visible: false })), "components")).toBe("UNCERTAIN");
  });

  it("colour 'n/a' in spec is ignored", () => {
    const naPo = { ...po, spec_colour: "n/a" };
    expect(v(decide(naPo, goodObs({ colour_seen: null })), "variant_colour")).toBe("PASS");
  });
});

describe("overall never masks a component", () => {
  const verdicts: Verdict[] = ["PASS", "FAIL", "UNCERTAIN"];
  it("exhaustive over 3 checks", () => {
    for (const a of verdicts) for (const b of verdicts) for (const c of verdicts) {
      const checks = [a, b, c].map((verdict) => ({ verdict }) as Check);
      const o = overallVerdict(checks);
      if (o === "ACCEPT") expect([a, b, c].every((x) => x === "PASS")).toBe(true);
      if ([a, b, c].includes("FAIL")) expect(o).toBe("EXCEPTION");
      else if ([a, b, c].includes("UNCERTAIN")) expect(o).toBe("REVIEW");
    }
  });
});

describe("the portal's worked example", () => {
  // PO: BLUE-BOTTLE-001, 24 expected, variant blue. Observed: 22 units, blue, damaged carton.
  // Portal's answer: quantity FAIL, variant PASS, damage FAIL → EXCEPTION.
  it("22 of 24, blue, damaged carton → quantity FAIL, variant PASS, damage FAIL, EXCEPTION", () => {
    const examplePo = { ...po, sku: "BLUE-BOTTLE-001", spec_colour: "blue", spec_variant: "750ml" };
    const checks = decide(
      examplePo,
      goodObs({ carton_damage: "damaged", carton_damage_types: ["crushing"], cartons_visible: null, units_in_open_carton: null }),
      { cartons_received: 2, units_per_carton_counted: 11 },
    );
    expect(v(checks, "quantity")).toBe("FAIL");
    expect(checks.find((c) => c.name === "quantity")!.reason).toContain("short by 2");
    expect(v(checks, "variant_colour")).toBe("PASS");
    expect(v(checks, "carton_damage")).toBe("FAIL");
    expect(overallVerdict(checks)).toBe("EXCEPTION");
  });
});

describe("confidence (a fixed rule, not a model score)", () => {
  const conf = (checks: Check[], name: CheckName) => checks.find((c) => c.name === name)!.confidence;

  it("UNCERTAIN never carries a confidence", () => {
    for (const c of decide(po, null)) if (c.verdict === "UNCERTAIN") expect(c.confidence).toBeNull();
  });

  it("operator count confirmed by the photo → high; operator only → medium", () => {
    expect(conf(decide(po, goodObs(), { cartons_received: 2 }), "carton_count")).toBe("high");
    expect(conf(decide(po, goodObs({ cartons_visible: null }), { cartons_received: 2 }), "carton_count")).toBe("medium");
  });

  it("model-only count → low, and the derived quantity is only as strong as its weakest input", () => {
    const checks = decide(po, goodObs(), { units_per_carton_counted: 12 });
    expect(conf(checks, "carton_count")).toBe("low");
    expect(conf(checks, "units_per_carton")).toBe("high");
    expect(conf(checks, "quantity")).toBe("low");
  });

  it("model check on a good photo → medium; a FAIL kept from a poor photo → low", () => {
    expect(conf(decide(po, goodObs()), "identity")).toBe("medium");
    const poor = decide(po, goodObs({ photo_quality: "poor", carton_damage: "damaged", carton_damage_types: ["water"] }));
    expect(v(poor, "carton_damage")).toBe("FAIL");
    expect(conf(poor, "carton_damage")).toBe("low");
  });

  it("every PASS and FAIL has a confidence", () => {
    for (const c of decide(po, goodObs({ label_text: "500 ml" }), { cartons_received: 1 })) {
      if (c.verdict !== "UNCERTAIN") expect(c.confidence).not.toBeNull();
    }
  });
});

describe("F3: no vouching for what isn't in the photos", () => {
  it("carton damage 'none' with no carton photo and no carton counted → UNCERTAIN (seen in real LLaVA output)", () => {
    const checks = decide(po, goodObs({ cartons_visible: null }), {}, ["unit"]);
    expect(v(checks, "carton_damage")).toBe("UNCERTAIN");
  });

  it("a carton photo or a counted carton is enough to vouch for it", () => {
    expect(v(decide(po, goodObs({ cartons_visible: null }), {}, ["carton"]), "carton_damage")).toBe("PASS");
    expect(v(decide(po, goodObs({ cartons_visible: 1 }), {}, ["unit"]), "carton_damage")).toBe("PASS");
  });

  it("unit damage 'none' when the product can't be made out → UNCERTAIN", () => {
    expect(v(decide(po, goodObs({ product_type: "unclear" })), "unit_damage")).toBe("UNCERTAIN");
  });

  it("visible damage is still a FAIL even without a carton-role photo", () => {
    expect(v(decide(po, goodObs({ cartons_visible: null, carton_damage: "damaged", carton_damage_types: ["tears"] }), {}, ["unit"]), "carton_damage")).toBe("FAIL");
  });
});

describe("F7 in the decision", () => {
  it("closed carton described as packaging → identity UNCERTAIN with a reason that says so", () => {
    const c = decide(po, goodObs({ product_type: "cardboard carton", product_description: "a closed shipping carton", label_text: null })).find((x) => x.name === "identity")!;
    expect(c.verdict).toBe("UNCERTAIN");
    expect(c.reason).toMatch(/Only packaging was seen/);
  });
});

