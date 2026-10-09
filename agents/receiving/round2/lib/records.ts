import type { SupabaseClient } from "@supabase/supabase-js";
import { overallVerdict } from "./decide";
import type { EvidenceRecord } from "./evidence";
import type { Check, Overall, Verdict } from "./types";

export interface OverrideRow {
  id: string;
  check_name: string;
  original_verdict: Verdict;
  new_verdict: Verdict;
  reason: string;
  operator_id: string;
  created_at: string;
}

/** Inserts one inspection row plus its photo rows. Rows are never updated afterwards. */
export async function saveRecord(db: SupabaseClient, record: EvidenceRecord, retryOf: string | null = null): Promise<string> {
  const { data, error } = await db
    .from("inspections")
    .insert({
      record_id: record.record_id,
      unit_id: record.unit_id,
      org_id: record.org_id,
      status: record.status,
      overall: record.overall,
      evidence: record,
      content_hash: record.content_hash,
      operator_id: record.operator_id,
      retry_of: retryOf,
    })
    .select("id")
    .single();
  if (error) throw new Error(`Saving the record failed: ${error.message}`);

  if (record.photos.length > 0) {
    const { error: photoErr } = await db.from("inspection_photos").insert(
      record.photos.map((p) => ({ inspection_id: data.id, org_id: record.org_id, idx: p.index, role: p.role, path: p.ref, sha256: p.sha256 })),
    );
    if (photoErr) throw new Error(`Saving photo rows failed: ${photoErr.message}`);
  }
  return data.id as string;
}

/**
 * The record's checks with the latest override applied per check. The stored record is untouched;
 * this is a view for the screen, and the UI always shows the original verdict beside it.
 */
export function effectiveChecks(record: EvidenceRecord, overrides: OverrideRow[]): { checks: (Check & { overridden?: OverrideRow })[]; overall: Overall } {
  const latest = new Map<string, OverrideRow>();
  for (const o of [...overrides].sort((a, b) => a.created_at.localeCompare(b.created_at))) latest.set(o.check_name, o);
  const checks = record.checks.map((c) => {
    const o = latest.get(c.name);
    return o ? { ...c, verdict: o.new_verdict, overridden: o } : c;
  });
  return { checks, overall: overallVerdict(checks) };
}
