// Bridge between the Pod orchestrator (Python, agents/receiving/app.py) and the Round 2 Receiving Manager.
// NEW integration file: it only calls the Round 2 code in ./round2, which is copied unchanged (see PROVENANCE.md).
//
// stdin : { po_row, photos: [{ role, ref, path }], counts?, operator_id, record_id, captured_at }
// stdout: the Round 2 EvidenceRecord (receiving-evidence/0.2) as JSON.
// Model problems never throw: Round 2's inspectUnit() fails open and returns status "pending".
import { readFileSync } from "node:fs";
import { inspectUnit } from "./round2/lib/inspect";
import { rowToPoLine } from "./round2/lib/po";
import type { PhotoRole } from "./round2/lib/types";
import { visionProvider } from "./round2/lib/vision";

interface BridgeInput {
  po_row: Record<string, string>;
  photos: { role: PhotoRole; ref: string; path: string }[];
  counts?: { cartons_received?: number; units_per_carton_counted?: number };
  operator_id: string;
  record_id: string;
  captured_at: string;
}

async function main() {
  const input = JSON.parse(readFileSync(0, "utf8")) as BridgeInput;
  const record = await inspectUnit({
    po: rowToPoLine(input.po_row),
    photos: input.photos.map((p) => ({ role: p.role, ref: p.ref, bytes: readFileSync(p.path) })),
    counts: input.counts ?? {},
    operator_id: input.operator_id,
    provider: visionProvider(),
    record_id: input.record_id,
    captured_at: input.captured_at,
  });
  process.stdout.write(JSON.stringify(record));
}

main().catch((e) => {
  process.stderr.write(`bridge error: ${(e as Error).message}\n`);
  process.exit(1);
});
