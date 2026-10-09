import { describe, expect, it } from "vitest";
import { matchColour, matchIdentity, matchVariant, missingComponents } from "../lib/match";

describe("matchIdentity", () => {
  const seen = (type: string, description = "", label: string | null = null) => ({ type, description, label });
  it("matches on a shared product word", () => {
    expect(matchIdentity("Steel Water Bottle", "SKU-BOTTLE-750", seen("water bottle")).status).toBe("match");
    expect(matchIdentity("Ceramic Mug 11oz, set of 2", "SKU-MUG-11", seen("mugs")).status).toBe("match");
  });
  it("mismatches when nothing is shared (the F1 case)", () => {
    expect(matchIdentity("Cotton Bath Towel", "SKU-TOWEL-BLU", seen("water bottle", "a blue bottle", "750ml")).status).toBe("mismatch");
  });
  it("ignores colour words so a blue bottle doesn't 'match' a blue towel", () => {
    expect(matchIdentity("Blue Towel", "SKU-X", seen("blue bottle")).status).toBe("mismatch");
  });
  it("unclear type → unknown", () => {
    expect(matchIdentity("Steel Water Bottle", "SKU-BOTTLE-750", seen("unclear")).status).toBe("unknown");
  });
});

describe("matchColour", () => {
  it.each([
    ["blue", "navy blue", "match"],
    ["grey", "gray", "match"],
    ["cream", "off-white", "match"],
    ["white", "red", "mismatch"],
    ["blue", null, "unknown"],
    ["blue", "shiny", "unknown"],
  ] as const)("%s vs %s → %s", (spec, seen, want) => expect(matchColour(spec, seen)).toBe(want));
});

describe("matchVariant", () => {
  it.each([
    ["750ml", "STEEL BOTTLE 750 ML", "match"],
    ["3-pack", "Soy candles 3 pack", "match"],
    ["500pc", "500 pieces jigsaw", "match"],
    ["1kg vanilla", "Whey 1 kg vanilla flavour", "match"],
    ["750ml", "500ml bottle", "mismatch"],
    ["6ft", "leash 4 ft", "mismatch"],
    ["bath", "cotton towel", "unknown"],
    ["750ml", null, "unknown"],
  ] as const)("%s vs %s → %s", (spec, label, want) => expect(matchVariant(spec, label)).toBe(want));
});

describe("missingComponents", () => {
  it("finds the part not seen", () => {
    expect(missingComponents(["tub", "scoop"], ["tub"])).toEqual(["scoop"]);
    expect(missingComponents(["lamp", "usb cable", "manual"], ["lamp", "cable", "manual"])).toEqual([]);
    expect(missingComponents(["candle x3", "gift box"], ["candles"])).toEqual(["gift box"]);
  });
});

describe("F7: packaging is not the product", () => {
  const seen = (type: string, label: string | null = null) => ({ type, description: `${type} on a table`, label });

  it.each(["cardboard carton", "small boxes", "boxed items", "small boxed items", "box", "sealed parcel"])(
    '"%s" → unknown, never a wrong-SKU mismatch',
    (type) => {
      const m = matchIdentity("Phone Charger 20W", "SKU-CHARGER-20W", seen(type));
      expect(m).toMatchObject({ status: "unknown", packagingOnly: true });
    },
  );

  it("a printed label naming the product still confirms it", () => {
    expect(matchIdentity("Phone Charger 20W", "SKU-CHARGER-20W", seen("cardboard carton", "USB-C Charger 20W")).status).toBe("match");
  });

  it("a real product description is still judged (F1 regression stays a mismatch)", () => {
    expect(matchIdentity("Cotton Bath Towel", "SKU-TOWEL-BLU", seen("water bottle")).status).toBe("mismatch");
    expect(matchIdentity("Kitchen Blender", "SKU-BLENDER", seen("pet supplies")).status).toBe("mismatch");
  });
});

