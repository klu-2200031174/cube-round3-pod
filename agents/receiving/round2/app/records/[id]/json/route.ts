import { serverClient } from "@/lib/supabase/server";

// The stored evidence record exactly as saved, for Prep / Recovery to consume. RLS applies.
export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = await serverClient();
  const { data } = await db.from("inspections").select("evidence").eq("record_id", id).maybeSingle();
  if (!data) return Response.json({ error: "not found" }, { status: 404 });
  return new Response(JSON.stringify(data.evidence, null, 2), {
    headers: { "content-type": "application/json", "content-disposition": `attachment; filename="${id}.json"` },
  });
}
