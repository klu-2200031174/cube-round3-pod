// Headless Receiving Manager: inspect one unit from local photo files, print the evidence record.
//
//   npm run agent -- --unit UNIT-0001 --photo pallet=fixtures/a.jpg --photo unit=fixtures/b.jpg \
//                    [--cartons 1] [--upc 24] [--operator op_eli] [--out runs/] [--provider gemini|ollama]
//
// The PO line is looked up by unit_id in data/receiving_sample.csv. Works without Supabase.
import { config } from "dotenv";
config({ path: ".env.local" });
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { inspectUnit } from "../lib/inspect";
import { loadPoLines } from "../lib/po";
import type { PhotoInput, PhotoRole } from "../lib/types";
import { visionProvider } from "../lib/vision";

const ROLES: PhotoRole[] = ["pallet", "carton", "unit", "label", "other"];

function parsePhoto(spec: string): PhotoInput {
  const eq = spec.indexOf("=");
  const maybeRole = eq > 0 ? spec.slice(0, eq) : "";
  const role = (ROLES as string[]).includes(maybeRole) ? (maybeRole as PhotoRole) : "other";
  const file = role === "other" && !maybeRole ? spec : spec.slice(eq + 1);
  return { role, ref: file, bytes: readFileSync(file) };
}

async function main() {
  const { values } = parseArgs({
    options: {
      unit: { type: "string" },
      photo: { type: "string", multiple: true, default: [] },
      cartons: { type: "string" },
      upc: { type: "string" },
      operator: { type: "string", default: "op_cli" },
      out: { type: "string" },
      provider: { type: "string" },
    },
  });
  if (!values.unit) throw new Error("--unit is required (e.g. --unit UNIT-0001)");
  const po = loadPoLines().find((p) => p.unit_id === values.unit);
  if (!po) throw new Error(`No PO line for ${values.unit} in data/receiving_sample.csv`);

  const record = await inspectUnit({
    po,
    photos: values.photo.map(parsePhoto),
    counts: {
      cartons_received: values.cartons != null ? Number(values.cartons) : undefined,
      units_per_carton_counted: values.upc != null ? Number(values.upc) : undefined,
    },
    operator_id: values.operator,
    provider: visionProvider(values.provider),
  });

  const json = JSON.stringify(record, null, 2);
  if (values.out) {
    mkdirSync(values.out, { recursive: true });
    const file = path.join(values.out, `${record.record_id}.json`);
    writeFileSync(file, json);
    console.error(`wrote ${file}`);
  }
  console.log(json);
  console.error(
    `\n${record.unit_id} → ${record.overall} (${record.status})\n` +
      record.checks.map((c) => `  ${c.verdict.padEnd(9)} ${c.name.padEnd(17)} ${c.reason}`).join("\n"),
  );
}

main().catch((e) => {
  console.error(`error: ${(e as Error).message}`);
  process.exit(1);
});
