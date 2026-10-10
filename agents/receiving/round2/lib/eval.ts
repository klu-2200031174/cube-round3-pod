import type { EvidenceRecord } from "./evidence";
import type { CheckName, Confidence, Overall, Verdict } from "./types";

// Pure scoring for the eval: human labels in, per-check counts out. No I/O here, so every
// number in the eval report can be reproduced from the saved records and the label files.
//
// "Positive" means FAIL (a problem is present), because the costly mistake at receiving is a
// problem that slips through. So:
//   TP  label FAIL, agent FAIL      caught
//   FN  label FAIL, agent PASS      missed problem (the dangerous one)
//   FP  label PASS, agent FAIL      false alarm
//   TN  label PASS, agent PASS
// UNCERTAIN is scored separately, never folded into right or wrong:
//   abstained       label PASS/FAIL, agent UNCERTAIN (safe, but a human has to look)
//   correct_abstain label UNCERTAIN, agent UNCERTAIN
//   forced          label UNCERTAIN, agent PASS/FAIL (claimed more than the photos show)

export const CHECKS: CheckName[] = [
  "identity", "variant_colour", "carton_count", "units_per_carton", "quantity",
  "carton_damage", "unit_damage", "components", "defects",
];

export type Labels = Partial<Record<CheckName, Verdict>>;

export interface CheckScore {
  check: CheckName;
  n: number;
  tp: number; fp: number; fn: number; tn: number;
  abstain_on_pass: number; abstain_on_fail: number;
  correct_abstain: number; forced: number;
  /** Of the verdicts the agent committed to on clear-cut cases, how many were right. null if none. */
  decided_accuracy: number | null;
  /** Share of clear-cut cases where the agent committed to PASS or FAIL. */
  coverage: number | null;
  fail_precision: number | null;
  fail_recall: number | null;
}

export interface Miss {
  case_id: string;
  check: CheckName;
  label: Verdict;
  agent: Verdict;
  kind: "FN" | "FP" | "forced" | "abstain";
  reason: string;
}

export interface Agreement {
  check: CheckName;
  both_labelled: number;
  agreed: number;
  kappa: number | null;
}

export interface EvalCase {
  case_id: string;
  record: EvidenceRecord;
  labels: Labels;
}

const ratio = (a: number, b: number) => (b === 0 ? null : a / b);

export function overallFromLabels(labels: Labels): Overall | null {
  const vs = CHECKS.map((c) => labels[c]).filter((v): v is Verdict => v != null);
  if (vs.length === 0) return null;
  if (vs.includes("FAIL")) return "EXCEPTION";
  if (vs.includes("UNCERTAIN")) return "REVIEW";
  return "ACCEPT";
}

export function scoreCheck(check: CheckName, cases: EvalCase[], misses: Miss[] = []): CheckScore {
  const s: CheckScore = {
    check, n: 0, tp: 0, fp: 0, fn: 0, tn: 0, abstain_on_pass: 0, abstain_on_fail: 0, correct_abstain: 0, forced: 0,
    decided_accuracy: null, coverage: null, fail_precision: null, fail_recall: null,
  };
  for (const { case_id, record, labels } of cases) {
    const label = labels[check];
    const got = record.checks.find((c) => c.name === check);
    if (!label || !got) continue;
    s.n++;
    const agent = got.verdict;
    const miss = (kind: Miss["kind"]) => misses.push({ case_id, check, label, agent, kind, reason: got.reason });
    if (label === "UNCERTAIN") {
      if (agent === "UNCERTAIN") s.correct_abstain++;
      else { s.forced++; miss("forced"); }
    } else if (agent === "UNCERTAIN") {
      if (label === "PASS") s.abstain_on_pass++; else s.abstain_on_fail++;
      miss("abstain");
    } else if (label === "FAIL") {
      if (agent === "FAIL") s.tp++; else { s.fn++; miss("FN"); }
    } else {
      if (agent === "PASS") s.tn++; else { s.fp++; miss("FP"); }
    }
  }
  const decided = s.tp + s.tn + s.fp + s.fn;
  const clear = decided + s.abstain_on_pass + s.abstain_on_fail;
  s.decided_accuracy = ratio(s.tp + s.tn, decided);
  s.coverage = ratio(decided, clear);
  s.fail_precision = ratio(s.tp, s.tp + s.fp);
  s.fail_recall = ratio(s.tp, s.tp + s.fn);
  return s;
}

/** Accuracy of committed verdicts (on clear-cut labels) grouped by the record's confidence level. */
export function byConfidence(cases: EvalCase[]): Record<Confidence | "none", { n: number; correct: number }> {
  const out = { high: { n: 0, correct: 0 }, medium: { n: 0, correct: 0 }, low: { n: 0, correct: 0 }, none: { n: 0, correct: 0 } };
  for (const { record, labels } of cases) {
    for (const c of record.checks) {
      const label = labels[c.name];
      if (!label || label === "UNCERTAIN" || c.verdict === "UNCERTAIN") continue;
      const bucket = out[c.confidence ?? "none"];
      bucket.n++;
      if (c.verdict === label) bucket.correct++;
    }
  }
  return out;
}

export interface OverallScore {
  n: number;
  exact: number;
  /** Agent said ACCEPT while the labels contain a FAIL. Must be 0. */
  masked_failures: number;
  confusion: Record<Overall, Record<Overall, number>>;
}

export function scoreOverall(cases: EvalCase[]): OverallScore {
  const blank = () => ({ ACCEPT: 0, EXCEPTION: 0, REVIEW: 0 });
  const out: OverallScore = { n: 0, exact: 0, masked_failures: 0, confusion: { ACCEPT: blank(), EXCEPTION: blank(), REVIEW: blank() } };
  for (const { record, labels } of cases) {
    const truth = overallFromLabels(labels);
    if (!truth) continue;
    out.n++;
    out.confusion[truth][record.overall]++;
    if (truth === record.overall) out.exact++;
    if (record.overall === "ACCEPT" && CHECKS.some((c) => labels[c] === "FAIL")) out.masked_failures++;
  }
  return out;
}

/** Two independent labellers: raw agreement and Cohen's kappa per check. */
export function agreement(a: Map<string, Labels>, b: Map<string, Labels>): Agreement[] {
  return CHECKS.map((check) => {
    const pairs: [Verdict, Verdict][] = [];
    for (const [id, la] of a) {
      const x = la[check];
      const y = b.get(id)?.[check];
      if (x && y) pairs.push([x, y]);
    }
    const agreed = pairs.filter(([x, y]) => x === y).length;
    const n = pairs.length;
    let kappa: number | null = null;
    if (n > 0) {
      const po = agreed / n;
      const cats: Verdict[] = ["PASS", "FAIL", "UNCERTAIN"];
      const pe = cats.reduce((sum, k) => sum + (pairs.filter(([x]) => x === k).length / n) * (pairs.filter(([, y]) => y === k).length / n), 0);
      kappa = pe === 1 ? null : (po - pe) / (1 - pe);
    }
    return { check, both_labelled: n, agreed, kappa };
  });
}

/**
 * Ground truth when there are two labellers: keep a label only where both agree. Disagreements
 * are dropped from scoring (and reported), rather than silently picking one side.
 */
export function consensus(a: Map<string, Labels>, b: Map<string, Labels> | null): { truth: Map<string, Labels>; dropped: { case_id: string; check: CheckName; a: Verdict; b: Verdict }[] } {
  if (!b) return { truth: a, dropped: [] };
  const truth = new Map<string, Labels>();
  const dropped: { case_id: string; check: CheckName; a: Verdict; b: Verdict }[] = [];
  for (const [id, la] of a) {
    const lb = b.get(id) ?? {};
    const t: Labels = {};
    for (const c of CHECKS) {
      const x = la[c];
      const y = lb[c];
      if (x && y) {
        if (x === y) t[c] = x;
        else dropped.push({ case_id: id, check: c, a: x, b: y });
      }
    }
    truth.set(id, t);
  }
  return { truth, dropped };
}
