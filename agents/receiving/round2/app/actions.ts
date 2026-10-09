"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { sha256, type EvidenceRecord } from "@/lib/evidence";
import { inspectUnit, newRecordId } from "@/lib/inspect";
import { saveRecord } from "@/lib/records";
import { PHOTO_BUCKET, serverClient } from "@/lib/supabase/server";
import type { OperatorCounts, PhotoInput, PhotoRole, PoLine, Verdict } from "@/lib/types";
import { visionProvider } from "@/lib/vision";

export type FormState = { error?: string; ok?: string } | undefined;

const ROLES: PhotoRole[] = ["pallet", "carton", "unit", "label", "other"];
const VERDICTS: Verdict[] = ["PASS", "FAIL", "UNCERTAIN"];
const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
const MAX_PHOTOS = 8;

async function requireUser() {
  const db = await serverClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) redirect("/login");
  return { db, user };
}

function optionalCount(v: FormDataEntryValue | null): number | undefined | "bad" {
  const s = String(v ?? "").trim();
  if (s === "") return undefined;
  const n = Number(s);
  return Number.isInteger(n) && n >= 0 ? n : "bad";
}

export async function signIn(_: FormState, fd: FormData): Promise<FormState> {
  const db = await serverClient();
  const { error } = await db.auth.signInWithPassword({ email: String(fd.get("email")), password: String(fd.get("password")) });
  if (error) return { error: error.message };
  redirect("/");
}

export async function signOut() {
  const db = await serverClient();
  await db.auth.signOut();
  redirect("/login");
}

/**
 * Inspect one unit. Photos are uploaded first, then the model is called once, then the record is
 * saved. A model failure still saves a `pending` record (fail open); only a storage or database
 * failure stops the flow, and then the operator sees why.
 */
export async function inspectAction(_: FormState, fd: FormData): Promise<FormState> {
  const { db, user } = await requireUser();

  const unitId = String(fd.get("unit_id") ?? "");
  const { data: po, error: poErr } = await db.from("po_lines").select("*").eq("unit_id", unitId).maybeSingle<PoLine>();
  if (poErr) return { error: poErr.message };
  if (!po) return { error: `No PO line ${unitId} in your organisation.` };

  const cartons = optionalCount(fd.get("cartons_received"));
  const upc = optionalCount(fd.get("units_per_carton_counted"));
  if (cartons === "bad" || upc === "bad") return { error: "Counts must be whole numbers, 0 or more, or left blank." };
  const counts: OperatorCounts = { cartons_received: cartons, units_per_carton_counted: upc };

  const picked: { role: PhotoRole; file: File }[] = [];
  for (let i = 0; i < MAX_PHOTOS; i++) {
    const file = fd.get(`photo_${i}`);
    if (!(file instanceof File) || file.size === 0) continue;
    const role = String(fd.get(`role_${i}`)) as PhotoRole;
    if (!ROLES.includes(role)) return { error: `Unknown photo role "${role}".` };
    if (!EXT[file.type]) return { error: `${file.name}: use JPEG, PNG or WebP.` };
    picked.push({ role, file });
  }
  if (picked.length === 0) return { error: "Add at least one photo." };

  // 1. Store the photos. From here on the capture exists even if the model fails.
  const photos: PhotoInput[] = [];
  for (const { role, file } of picked) {
    const bytes = Buffer.from(await file.arrayBuffer());
    const path = `${po.org_id}/${randomUUID()}.${EXT[file.type]}`;
    const { error } = await db.storage.from(PHOTO_BUCKET).upload(path, bytes, { contentType: file.type });
    if (error) return { error: `Photo upload failed: ${error.message}` };
    photos.push({ role, ref: path, bytes });
  }

  // 2. One model call for the unit; never throws for model problems.
  const record = await inspectUnit({ po, photos, counts, operator_id: user.email ?? user.id, provider: visionProvider() });

  // 3. Save the record.
  try {
    await saveRecord(db, record);
  } catch (e) {
    return { error: `${(e as Error).message}. The photos are stored; record ${record.record_id} was not saved.` };
  }
  revalidatePath("/queue");
  redirect(`/records/${record.record_id}`);
}

/** Re-run the model for a pending record. Inserts a new record pointing at the old one; the old row is kept. */
export async function retryAction(recordId: string): Promise<FormState> {
  const { db, user } = await requireUser();
  const { data: row, error } = await db.from("inspections").select("id, evidence").eq("record_id", recordId).maybeSingle();
  if (error || !row) return { error: error?.message ?? "Record not found." };
  const old = row.evidence as EvidenceRecord;
  if (old.status !== "pending") return { error: "Only pending records can be retried." };

  const photos: PhotoInput[] = [];
  for (const p of old.photos) {
    const { data, error: dlErr } = await db.storage.from(PHOTO_BUCKET).download(p.ref);
    if (dlErr || !data) return { error: `Could not load photo #${p.index}: ${dlErr?.message ?? "missing"}` };
    const bytes = Buffer.from(await data.arrayBuffer());
    if (sha256(bytes) !== p.sha256) return { error: `Photo #${p.index} no longer matches its recorded sha256; not retrying.` };
    photos.push({ role: p.role, ref: p.ref, bytes });
  }

  const record = await inspectUnit({
    po: old.expected,
    photos,
    counts: {
      cartons_received: old.operator_counts?.cartons_received ?? undefined,
      units_per_carton_counted: old.operator_counts?.units_per_carton_counted ?? undefined,
    },
    operator_id: user.email ?? user.id,
    captured_at: old.captured_at,
    record_id: newRecordId(),
    provider: visionProvider(),
  });
  try {
    await saveRecord(db, record, row.id);
  } catch (e) {
    return { error: (e as Error).message };
  }
  revalidatePath("/queue");
  redirect(`/records/${record.record_id}`);
}

/** Append an override. The original verdict is read from the stored record, not from the form. */
export async function overrideAction(_: FormState, fd: FormData): Promise<FormState> {
  const { db, user } = await requireUser();
  const recordId = String(fd.get("record_id"));
  const checkName = String(fd.get("check_name"));
  const newVerdict = String(fd.get("new_verdict")) as Verdict;
  const reason = String(fd.get("reason") ?? "").trim();
  if (!VERDICTS.includes(newVerdict)) return { error: "Pick a verdict." };
  if (reason.length < 3) return { error: "Give a reason (at least 3 characters)." };

  const { data: row, error } = await db.from("inspections").select("id, org_id, evidence").eq("record_id", recordId).maybeSingle();
  if (error || !row) return { error: error?.message ?? "Record not found." };
  const check = (row.evidence as EvidenceRecord).checks.find((c) => c.name === checkName);
  if (!check) return { error: `No check "${checkName}" on this record.` };

  const { error: insErr } = await db.from("overrides").insert({
    inspection_id: row.id,
    org_id: row.org_id,
    check_name: checkName,
    original_verdict: check.verdict,
    new_verdict: newVerdict,
    reason,
    operator_id: user.email ?? user.id,
  });
  if (insErr) return { error: insErr.message };
  revalidatePath(`/records/${recordId}`);
  revalidatePath("/queue");
  return { ok: `${checkName} set to ${newVerdict}. The original verdict (${check.verdict}) stays on the record.` };
}
