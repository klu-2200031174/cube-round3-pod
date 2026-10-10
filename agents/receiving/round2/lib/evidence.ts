import { createHash } from "node:crypto";
import type { Check, Overall, PhotoEvidence, PoLine, RecordStatus } from "./types";
import type { Observation } from "./observation";
import { variantColourStatus } from "./decide";

// 0.1 — first draft.
// 0.2 — adds checks[].confidence and the derived issues[] list (portal: "detected issues",
//       "confidence where applicable"). Readers of 0.1 records must treat both as absent.
export const CONTRACT_VERSION = "receiving-evidence/0.2";

export interface ModelRun {
  provider: string;
  model: string;
  prompt_version: string;
  latency_ms: number | null;
  /** Set when the call failed; the record is then `pending`. */
  error: string | null;
  /** Exactly what the model returned, kept for audit. */
  raw_output: string | null;
}

/**
 * Summary in the same vocabulary as data/receiving_sample.csv, so Prep / Recovery can
 * consume this record without learning a new shape. Derived from `checks`, never set directly.
 */
export interface CsvCompatibleSummary {
  cartons_received: number | null;
  units_per_carton_counted: number | null;
  qty_received: number | null;
  identity_match: "yes" | "no" | "uncertain";
  carton_damage: string; // none | crushing | water | tears | uncertain (";"-joined when several)
  unit_damage: string;
  quality_flags: string[]; // wrong_colour | wrong_variant | missing_components | obvious_defect
}

/** One line per check that is not a PASS: what a receiving lead or Recovery needs to act on. */
export interface Issue {
  check: Check["name"];
  verdict: "FAIL" | "UNCERTAIN";
  detail: string;
}

export interface EvidenceRecord {
  contract_version: string;
  stage: "receiving";
  record_id: string;
  unit_id: string;
  org_id: string;
  status: RecordStatus;
  overall: Overall;
  expected: PoLine;
  summary: CsvCompatibleSummary;
  /** FAIL checks first, then UNCERTAIN ones. Derived from `checks`, never set directly. */
  issues: Issue[];
  checks: Check[];
  photos: PhotoEvidence[];
  /** What the operator typed at the dock, kept as input so a retry can replay it. null = not entered. */
  operator_counts: { cartons_received: number | null; units_per_carton_counted: number | null };
  operator_id: string;
  captured_at: string;
  model: ModelRun;
  /** sha256 over the canonical JSON of every other field. A content hash, not a tamper-proof seal. */
  content_hash: string;
}

export function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** JSON with object keys sorted at every level, so the same record always hashes the same. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function hashRecord(record: Omit<EvidenceRecord, "content_hash">): string {
  return sha256(canonicalJson(record));
}

export function verifyRecord(record: EvidenceRecord): boolean {
  const { content_hash, ...rest } = record;
  return hashRecord(rest) === content_hash;
}

function byName(checks: Check[], name: Check["name"]): Check {
  const c = checks.find((x) => x.name === name);
  if (!c) throw new Error(`missing check ${name}`);
  return c;
}

function damageSummary(c: Check): string {
  if (c.verdict === "PASS") return "none";
  if (c.verdict === "UNCERTAIN") return "uncertain";
  return Array.isArray(c.observed) ? c.observed.join(";") : String(c.observed);
}

export function summarise(checks: Check[], po: PoLine, obs: Observation | null): CsvCompatibleSummary {
  const num = (c: Check) => (c.verdict !== "UNCERTAIN" && typeof c.observed === "number" ? c.observed : null);
  const identity = byName(checks, "identity");
  const flags: string[] = [];
  if (byName(checks, "variant_colour").verdict === "FAIL" && obs) {
    const st = variantColourStatus(po, obs);
    if (st.colour === "mismatch") flags.push("wrong_colour");
    if (st.variant === "mismatch") flags.push("wrong_variant");
  }
  if (byName(checks, "components").verdict === "FAIL") flags.push("missing_components");
  if (byName(checks, "defects").verdict === "FAIL") flags.push("obvious_defect");

  return {
    cartons_received: num(byName(checks, "carton_count")),
    units_per_carton_counted: num(byName(checks, "units_per_carton")),
    qty_received: num(byName(checks, "quantity")),
    identity_match: identity.verdict === "PASS" ? "yes" : identity.verdict === "FAIL" ? "no" : "uncertain",
    carton_damage: damageSummary(byName(checks, "carton_damage")),
    unit_damage: damageSummary(byName(checks, "unit_damage")),
    quality_flags: flags,
  };
}

export function issuesOf(checks: Check[]): Issue[] {
  const pick = (v: "FAIL" | "UNCERTAIN") => checks.filter((c) => c.verdict === v).map((c) => ({ check: c.name, verdict: v, detail: c.reason }));
  return [...pick("FAIL"), ...pick("UNCERTAIN")];
}

export function buildRecord(input: Omit<EvidenceRecord, "content_hash" | "contract_version" | "stage" | "issues">): EvidenceRecord {
  const body = { contract_version: CONTRACT_VERSION, stage: "receiving" as const, ...input, issues: issuesOf(input.checks) };
  return { ...body, content_hash: hashRecord(body) };
}
