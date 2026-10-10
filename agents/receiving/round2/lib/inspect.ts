import { randomUUID } from "node:crypto";
import { decide, overallVerdict } from "./decide";
import { buildRecord, sha256, summarise, type EvidenceRecord } from "./evidence";
import type { Observation } from "./observation";
import type { OperatorCounts, PhotoInput, PoLine } from "./types";
import { composeContactSheet } from "./vision/compose";
import { PROMPT_VERSION } from "./vision/prompt";
import { VisionError, type VisionProvider } from "./vision/provider";

export interface InspectInput {
  po: PoLine;
  photos: PhotoInput[];
  counts?: OperatorCounts;
  operator_id: string;
  provider: VisionProvider;
  record_id?: string;
  captured_at?: string;
}

export function newRecordId(): string {
  return `RCV-${randomUUID().slice(0, 8).toUpperCase()}`;
}

/**
 * Inspects one unit. Never throws for model problems: if the model is down, slow or returns
 * junk, the record is still produced with status "pending", visual checks UNCERTAIN, and the
 * error kept on the record (engineering rule 3, fail open).
 */
export async function inspectUnit(input: InspectInput): Promise<EvidenceRecord> {
  const { po, photos, counts = {}, provider } = input;
  const photoEvidence = photos.map((p, i) => ({ index: i + 1, role: p.role, ref: p.ref, sha256: sha256(p.bytes) }));

  let observation: Observation | null = null;
  let raw_output: string | null = null;
  let latency_ms: number | null = null;
  let error: string | null = null;

  if (photos.length === 0) {
    error = "No photos supplied";
  } else {
    try {
      const sheet = await composeContactSheet(photos);
      const res = await provider.observe(sheet, photos.map((p) => p.role));
      ({ observation, raw_output, latency_ms } = res);
    } catch (err) {
      if (err instanceof VisionError) {
        error = err.message;
        raw_output = err.raw_output;
        latency_ms = err.latency_ms;
      } else {
        error = `Unexpected error: ${(err as Error).message}`;
      }
    }
  }

  // Models sometimes cite photo numbers that don't exist (seen: "#2" with one photo). Drop them
  // so the evidence record never points at a photo that isn't there.
  const checks = decide(po, observation, counts, photos.map((p) => p.role)).map((c) => ({
    ...c,
    photo_refs: [...new Set(c.photo_refs)].filter((i) => i >= 1 && i <= photos.length),
  }));
  return buildRecord({
    record_id: input.record_id ?? newRecordId(),
    unit_id: po.unit_id,
    org_id: po.org_id,
    status: observation ? "complete" : "pending",
    overall: overallVerdict(checks),
    expected: po,
    summary: summarise(checks, po, observation),
    checks,
    photos: photoEvidence,
    operator_counts: {
      cartons_received: counts.cartons_received ?? null,
      units_per_carton_counted: counts.units_per_carton_counted ?? null,
    },
    operator_id: input.operator_id,
    captured_at: input.captured_at ?? new Date().toISOString(),
    model: { provider: provider.provider, model: provider.model, prompt_version: PROMPT_VERSION, latency_ms, error, raw_output },
  });
}
