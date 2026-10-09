import { describe, expect, it } from "vitest";
import { agreement, byConfidence, consensus, scoreCheck, scoreOverall, type EvalCase, type Labels, type Miss } from "../lib/eval";
import type { EvidenceRecord } from "../lib/evidence";
import type { Check, CheckName, Confidence, Overall, Verdict } from "../lib/types";

function rec(id: string, overall: Overall, checks: [CheckName, Verdict, Confidence | null][]): EvidenceRecord {
  return {
    unit_id: id,
    overall,
    checks: checks.map(([name, verdict, confidence]) => ({ name, verdict, confidence, reason: `${name} ${verdict}` }) as Check),
  } as EvidenceRecord;
}
const ec = (id: string, r: EvidenceRecord, labels: Labels): EvalCase => ({ case_id: id, record: r, labels });

describe("scoreCheck", () => {
  it("counts TP/FN/FP/TN, abstentions and forced verdicts separately", () => {
    const cases = [
      ec("a", rec("a", "EXCEPTION", [["carton_damage", "FAIL", "medium"]]), { carton_damage: "FAIL" }), // TP
      ec("b", rec("b", "ACCEPT", [["carton_damage", "PASS", "medium"]]), { carton_damage: "FAIL" }), // FN
      ec("c", rec("c", "EXCEPTION", [["carton_damage", "FAIL", "low"]]), { carton_damage: "PASS" }), // FP
      ec("d", rec("d", "ACCEPT", [["carton_damage", "PASS", "medium"]]), { carton_damage: "PASS" }), // TN
      ec("e", rec("e", "REVIEW", [["carton_damage", "UNCERTAIN", null]]), { carton_damage: "FAIL" }), // abstain on fail
      ec("f", rec("f", "REVIEW", [["carton_damage", "UNCERTAIN", null]]), { carton_damage: "UNCERTAIN" }), // correct abstain
      ec("g", rec("g", "ACCEPT", [["carton_damage", "PASS", "medium"]]), { carton_damage: "UNCERTAIN" }), // forced
      ec("h", rec("h", "ACCEPT", [["carton_damage", "PASS", "medium"]]), {}), // unlabelled → ignored
    ];
    const misses: Miss[] = [];
    const s = scoreCheck("carton_damage", cases, misses);
    expect(s).toMatchObject({ n: 7, tp: 1, fn: 1, fp: 1, tn: 1, abstain_on_fail: 1, abstain_on_pass: 0, correct_abstain: 1, forced: 1 });
    expect(s.decided_accuracy).toBe(0.5);
    expect(s.coverage).toBe(0.8);
    expect(s.fail_recall).toBe(0.5);
    expect(misses.map((m) => `${m.case_id}:${m.kind}`)).toEqual(["b:FN", "c:FP", "e:abstain", "g:forced"]);
  });

  it("reports null rates rather than 0% when there is nothing to divide", () => {
    const s = scoreCheck("identity", [], []);
    expect(s.decided_accuracy).toBeNull();
    expect(s.fail_recall).toBeNull();
  });
});

describe("scoreOverall", () => {
  it("flags ACCEPT over a labelled FAIL as a masked failure", () => {
    const o = scoreOverall([
      ec("a", rec("a", "ACCEPT", []), { identity: "PASS", carton_damage: "FAIL" }),
      ec("b", rec("b", "EXCEPTION", []), { identity: "FAIL" }),
    ]);
    expect(o.masked_failures).toBe(1);
    expect(o.exact).toBe(1);
    expect(o.confusion.EXCEPTION.ACCEPT).toBe(1);
  });
});

describe("byConfidence", () => {
  it("groups committed verdicts on clear-cut labels by confidence", () => {
    const b = byConfidence([
      ec("a", rec("a", "ACCEPT", [["identity", "PASS", "high"], ["defects", "PASS", "low"]]), { identity: "PASS", defects: "FAIL" }),
    ]);
    expect(b.high).toEqual({ n: 1, correct: 1 });
    expect(b.low).toEqual({ n: 1, correct: 0 });
  });
});

describe("two labellers", () => {
  const a = new Map<string, Labels>([["x", { identity: "PASS", defects: "FAIL" }], ["y", { identity: "FAIL", defects: "PASS" }]]);
  const b = new Map<string, Labels>([["x", { identity: "PASS", defects: "UNCERTAIN" }], ["y", { identity: "FAIL", defects: "PASS" }]]);

  it("consensus keeps agreed labels and reports the dropped ones", () => {
    const { truth, dropped } = consensus(a, b);
    expect(truth.get("x")).toEqual({ identity: "PASS" });
    expect(dropped).toEqual([{ case_id: "x", check: "defects", a: "FAIL", b: "UNCERTAIN" }]);
  });

  it("single labeller → labels used as-is", () => {
    expect(consensus(a, null).truth).toBe(a);
  });

  it("agreement: perfect agreement on identity gives κ = 1", () => {
    const g = agreement(a, b).find((x) => x.check === "identity")!;
    expect(g).toMatchObject({ both_labelled: 2, agreed: 2 });
    expect(g.kappa).toBe(1);
  });
});
