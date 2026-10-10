// Eval runner: runs the agent on the held-out photo set and scores it against human labels.
//
//   npm run eval                                      # default model (Gemini): run every case, then score
//   npm run eval -- --run my-run                      # resumable: finished cases are skipped, pending ones retried
//                                                     (the pending attempt is kept in records/attempts/)
//   npm run eval -- --score-only --run my-run         # rescore after editing labels, no model calls
//   npm run eval -- --only EV01,EV02 --provider gemini
//   npm run eval -- --dir some/other/eval/folder      # same layout elsewhere (used for smoke tests)
//
// Inputs (all in submissions/Bhargav200/eval/, see eval/README.md):
//   cases.csv      what each case is checked against (PO spec) and which photos it has
//   labels_a.csv   labeller A's verdict per check
//   labels_b.csv   labeller B's verdict per check (optional; enables agreement + consensus truth)
//   photos/        the photos
// Outputs: eval/results/<run>/records/*.json, metrics.json, results.md
import { config } from "dotenv";
config({ path: ".env.local" });
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { parse } from "csv-parse/sync";
import {
  CHECKS, agreement, byConfidence, consensus, scoreCheck, scoreOverall,
  type EvalCase, type Labels, type Miss,
} from "../lib/eval";
import type { EvidenceRecord } from "../lib/evidence";
import { inspectUnit } from "../lib/inspect";
import type { PhotoInput, PhotoRole, PoLine, Verdict } from "../lib/types";
import { visionProvider } from "../lib/vision";
import { PROMPT_VERSION } from "../lib/vision/prompt";

let EVAL_DIR = path.resolve("../eval");
const ROLES: PhotoRole[] = ["pallet", "carton", "unit", "label", "other"];
const VERDICTS: Verdict[] = ["PASS", "FAIL", "UNCERTAIN"];

type Row = Record<string, string>;
const readCsv = (file: string): Row[] =>
  parse(readFileSync(file, "utf8"), { columns: true, skip_empty_lines: true, trim: true, comment: "#" }) as Row[];

const optInt = (s: string | undefined) => (s == null || s.trim() === "" ? undefined : Number(s));

function caseToPo(r: Row): PoLine {
  const cartons = Number(r.cartons_ordered);
  const upc = Number(r.units_per_carton_ordered);
  return {
    unit_id: r.case_id,
    org_id: "org_eval",
    po_number: "PO-EVAL",
    po_line: 1,
    supplier: "Eval set",
    sku: r.sku,
    asin: "n/a",
    product_title: r.product_title,
    spec_colour: r.spec_colour || "n/a",
    spec_variant: r.spec_variant,
    spec_components: (r.spec_components ?? "").split(";").map((s) => s.trim()).filter(Boolean),
    cartons_ordered: cartons,
    units_per_carton_ordered: upc,
    qty_ordered: cartons * upc,
  };
}

function casePhotos(r: Row): PhotoInput[] {
  return r.photos.split(";").map((spec) => {
    const [role, file] = spec.includes("=") ? spec.split("=") : ["other", spec];
    if (!ROLES.includes(role as PhotoRole)) throw new Error(`${r.case_id}: unknown photo role "${role}"`);
    const full = path.join(EVAL_DIR, "photos", file.trim());
    if (!existsSync(full)) throw new Error(`${r.case_id}: photo not found: ${full}`);
    return { role: role as PhotoRole, ref: `eval/photos/${file.trim()}`, bytes: readFileSync(full) };
  });
}

function readLabels(file: string): Map<string, Labels> | null {
  if (!existsSync(file)) return null;
  const out = new Map<string, Labels>();
  for (const r of readCsv(file)) {
    const l: Labels = {};
    for (const c of CHECKS) {
      const v = (r[c] ?? "").trim().toUpperCase();
      if (v === "") continue;
      if (!VERDICTS.includes(v as Verdict)) throw new Error(`${path.basename(file)} ${r.case_id}: "${r[c]}" in ${c} (use PASS, FAIL, UNCERTAIN or blank)`);
      l[c] = v as Verdict;
    }
    out.set(r.case_id, l);
  }
  return out;
}

const pct = (x: number | null) => (x == null ? "–" : `${Math.round(x * 100)}%`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function gitCommit(): string {
  try {
    const head = execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    const dirty = execSync("git status --porcelain -- .", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim() ? "+uncommitted" : "";
    return head + dirty;
  } catch {
    return "unknown";
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      provider: { type: "string" },
      run: { type: "string" },
      only: { type: "string" },
      delay: { type: "string" },
      "score-only": { type: "boolean", default: false },
      dir: { type: "string" },
    },
  });
  if (values.dir) EVAL_DIR = path.resolve(values.dir);
  const casesFile = path.join(EVAL_DIR, "cases.csv");
  if (!existsSync(casesFile)) throw new Error(`No ${casesFile}. See eval/README.md.`);
  const only = values.only ? new Set(values.only.split(",").map((s) => s.trim())) : null;
  const all = readCsv(casesFile).filter((r) => r.case_id && (!only || only.has(r.case_id)));
  // Rows still carrying the template's FILL placeholder haven't been shot yet.
  const cases = all.filter((r) => r.product_title && r.product_title !== "FILL");
  if (cases.length < all.length) console.error(`${all.length - cases.length} case(s) not filled in yet (product_title FILL), skipped`);

  const providerName = values.provider || process.env.VISION_PROVIDER || "gemini";
  const runName = values.run ?? `${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}-${providerName}`;
  const runDir = path.join(EVAL_DIR, "results", runName);
  const recDir = path.join(runDir, "records");
  mkdirSync(recDir, { recursive: true });

  if (!values["score-only"]) {
    const provider = visionProvider(providerName);
    // Gemini's free tier allows roughly 10 requests a minute; stay under it by default.
    const delay = Number(values.delay ?? (providerName === "gemini" ? 7000 : 0));
    let i = 0;
    for (const r of cases) {
      i++;
      const out = path.join(recDir, `${r.case_id}.json`);
      if (existsSync(out)) {
        const prev = JSON.parse(readFileSync(out, "utf8")) as EvidenceRecord;
        if (prev.status !== "pending") {
          console.error(`[${i}/${cases.length}] ${r.case_id} already in this run, skipped`);
          continue;
        }
        // A pending record means the model call failed (e.g. a temporary overload). Keep it as
        // evidence of the fail-open path, out of the scored folder, then try the case again.
        const attemptsDir = path.join(recDir, "attempts");
        mkdirSync(attemptsDir, { recursive: true });
        renameSync(out, path.join(attemptsDir, `${r.case_id}.${prev.captured_at.replace(/[:.]/g, "-")}.pending.json`));
        console.error(`[${i}/${cases.length}] ${r.case_id} was pending (${prev.model.error}), retrying`);
      }
      const record = await inspectUnit({
        po: caseToPo(r),
        photos: casePhotos(r),
        counts: { cartons_received: optInt(r.operator_cartons), units_per_carton_counted: optInt(r.operator_upc) },
        operator_id: "eval",
        record_id: `RCV-${r.case_id}`,
        provider,
      });
      writeFileSync(out, JSON.stringify(record, null, 2));
      const secs = record.model.latency_ms != null ? `${(record.model.latency_ms / 1000).toFixed(1)} s` : "–";
      console.error(`[${i}/${cases.length}] ${r.case_id} → ${record.overall} (${record.status}, ${secs})${record.model.error ? ` ${record.model.error}` : ""}`);
      if (delay && i < cases.length) await sleep(delay);
    }
  }

  // ---- scoring ----
  const la = readLabels(path.join(EVAL_DIR, "labels_a.csv"));
  const lb = readLabels(path.join(EVAL_DIR, "labels_b.csv"));
  if (!la) {
    console.error("No eval/labels_a.csv yet: records are saved, nothing to score.");
    return;
  }
  const { truth, dropped } = consensus(la, lb);
  const wanted = new Set(cases.map((r) => r.case_id));
  const records = readdirSync(recDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(path.join(recDir, f), "utf8")) as EvidenceRecord)
    .filter((r) => wanted.has(r.unit_id));
  const evalCases: EvalCase[] = records
    .filter((r) => truth.has(r.unit_id))
    .map((record) => ({ case_id: record.unit_id, record, labels: truth.get(record.unit_id)! }));
  const unlabelled = records.filter((r) => !truth.has(r.unit_id)).map((r) => r.unit_id);

  const misses: Miss[] = [];
  const perCheck = CHECKS.map((c) => scoreCheck(c, evalCases, misses));
  const overall = scoreOverall(evalCases);
  const conf = byConfidence(evalCases);
  const agree = la && lb ? agreement(la, lb) : null;
  // Latency of calls that returned an answer; failed calls are counted under "pending" instead.
  const lat = records.filter((r) => r.status === "complete").map((r) => r.model.latency_ms).filter((x): x is number => x != null).sort((a, b) => a - b);
  const q = (p: number) => (lat.length ? lat[Math.min(lat.length - 1, Math.floor(p * lat.length))] / 1000 : null);
  const pending = records.filter((r) => r.status === "pending");
  const scenarios = new Map(cases.map((r) => [r.case_id, r.scenario ?? ""]));
  const sources = (c: string) => {
    const n: Record<string, number> = {};
    for (const r of records) {
      const s = r.checks.find((x) => x.name === c)?.source ?? "none";
      n[s] = (n[s] ?? 0) + 1;
    }
    return Object.entries(n).map(([k, v]) => `${k} ${v}`).join(", ");
  };

  const meta = {
    run: runName,
    scored_at: new Date().toISOString(),
    provider: records[0]?.model.provider ?? providerName,
    model: records[0]?.model.model ?? "?",
    prompt_version: records[0]?.model.prompt_version ?? PROMPT_VERSION,
    contract_version: records[0]?.contract_version ?? "?",
    code_commit: gitCommit(),
    cases: records.length,
    scored_cases: evalCases.length,
    labellers: lb ? 2 : 1,
    pending: pending.length,
    retried_after_pending: existsSync(path.join(recDir, "attempts")) ? readdirSync(path.join(recDir, "attempts")).length : 0,
    latency_s: { median: q(0.5), p90: q(0.9), max: lat.length ? lat[lat.length - 1] / 1000 : null },
  };
  writeFileSync(path.join(runDir, "metrics.json"), JSON.stringify({ meta, perCheck, overall, byConfidence: conf, agreement: agree, dropped, misses, unlabelled }, null, 2));

  const L: string[] = [];
  L.push(`# Eval results: ${runName}`, "");
  L.push(`Generated by \`npm run eval\`. Don't edit by hand; rerun with \`--score-only\` after changing labels.`, "");
  L.push(`| | |`, `|---|---|`);
  L.push(`| Model | ${meta.provider} / ${meta.model} |`, `| Prompt | ${meta.prompt_version} |`, `| Contract | ${meta.contract_version} |`, `| Code | ${meta.code_commit} |`);
  L.push(`| Cases run / scored | ${meta.cases} / ${meta.scored_cases} |`, `| Labellers | ${meta.labellers}${meta.labellers === 1 ? " (no agreement measure possible)" : ""} |`);
  L.push(`| Pending (model failed, fail-open) | ${meta.pending} final; ${meta.retried_after_pending} earlier attempt(s) pending and retried (kept in records/attempts/) |`);
  L.push(`| Latency per unit | median ${meta.latency_s.median ?? "–"} s, p90 ${meta.latency_s.p90 ?? "–"} s, max ${meta.latency_s.max ?? "–"} s |`, "");

  L.push(`## Per check`, "", `Positive = FAIL (a problem is present). FN = a real problem the agent passed. FP = a false alarm. UNCERTAIN is counted separately, never as right or wrong.`, "");
  L.push(`| Check | n | TP | FN | FP | TN | Abstained (label PASS / FAIL) | Label UNCERTAIN: agent agreed / forced | Accuracy when decided | Coverage | FAIL recall | FAIL precision | Source of verdicts |`);
  L.push(`|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|---|`);
  for (const s of perCheck) {
    L.push(`| ${s.check} | ${s.n} | ${s.tp} | ${s.fn} | ${s.fp} | ${s.tn} | ${s.abstain_on_pass} / ${s.abstain_on_fail} | ${s.correct_abstain} / ${s.forced} | ${pct(s.decided_accuracy)} | ${pct(s.coverage)} | ${pct(s.fail_recall)} | ${pct(s.fail_precision)} | ${sources(s.check)} |`);
  }
  L.push("", `## Overall verdict`, "", `Exact match ${overall.exact} of ${overall.n}. **ACCEPT while a label says FAIL (masked failure): ${overall.masked_failures}.**`, "");
  L.push(`| Label ↓ / Agent → | ACCEPT | REVIEW | EXCEPTION |`, `|---|--:|--:|--:|`);
  for (const t of ["ACCEPT", "REVIEW", "EXCEPTION"] as const) {
    L.push(`| ${t} | ${overall.confusion[t].ACCEPT} | ${overall.confusion[t].REVIEW} | ${overall.confusion[t].EXCEPTION} |`);
  }
  L.push("", `## Accuracy by confidence level`, "", `Committed verdicts on clear-cut labels. If "high" isn't more accurate than "low", the confidence rule isn't earning its place.`, "");
  L.push(`| Confidence | Verdicts | Correct | Accuracy |`, `|---|--:|--:|--:|`);
  for (const k of ["high", "medium", "low", "none"] as const) L.push(`| ${k} | ${conf[k].n} | ${conf[k].correct} | ${pct(conf[k].n ? conf[k].correct / conf[k].n : null)} |`);
  if (agree) {
    L.push("", `## Labeller agreement`, "", `Ground truth keeps only labels both labellers agree on; ${dropped.length} disagreeing label(s) were dropped (listed in metrics.json).`, "");
    L.push(`| Check | Both labelled | Agreed | Cohen's κ |`, `|---|--:|--:|--:|`);
    for (const a of agree) L.push(`| ${a.check} | ${a.both_labelled} | ${a.agreed} | ${a.kappa == null ? "–" : a.kappa.toFixed(2)} |`);
  }
  L.push("", `## Every miss`, "", `| Case | Scenario | Check | Label | Agent | Kind | Agent's reason |`, `|---|---|---|---|---|---|---|`);
  for (const m of misses) L.push(`| ${m.case_id} | ${scenarios.get(m.case_id)} | ${m.check} | ${m.label} | ${m.agent} | ${m.kind} | ${m.reason.replace(/\|/g, "/").replace(/\n/g, " ")} |`);
  if (pending.length) {
    L.push("", `## Pending records`, "");
    for (const r of pending) L.push(`- ${r.unit_id}: ${r.model.error}`);
  }
  if (unlabelled.length) L.push("", `Not scored (no labels): ${unlabelled.join(", ")}`);
  writeFileSync(path.join(runDir, "results.md"), `${L.join("\n")}\n`);
  console.error(`\nScored ${evalCases.length} case(s). Wrote ${path.join(runDir, "results.md")}`);
}

main().catch((e) => {
  console.error(`error: ${(e as Error).message}`);
  process.exit(1);
});
