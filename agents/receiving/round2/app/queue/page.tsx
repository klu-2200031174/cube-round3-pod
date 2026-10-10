import Link from "next/link";
import { serverClient } from "@/lib/supabase/server";

// Everything a human still has to look at: pending records, REVIEW (some check UNCERTAIN) and
// EXCEPTION (some check FAIL). A pending record that has been retried drops off; its retry takes its place.
export default async function QueuePage() {
  const db = await serverClient();
  const { data: rows, error } = await db
    .from("inspections")
    .select("id, record_id, unit_id, status, overall, retry_of, operator_id, created_at, overrides(count)")
    .or("status.eq.pending,overall.neq.ACCEPT")
    .order("created_at", { ascending: false })
    .limit(200);
  const { data: retried } = await db.from("inspections").select("retry_of").not("retry_of", "is", null);
  const superseded = new Set((retried ?? []).map((r) => r.retry_of));
  const open = (rows ?? []).filter((r) => !superseded.has(r.id));

  const count = (k: string) => open.filter((r) => (k === "pending" ? r.status === "pending" : r.overall === k && r.status !== "pending")).length;

  return (
    <>
      <h1>Review queue</h1>
      <p className="sub">
        {count("pending")} pending (model failed) · {count("EXCEPTION")} exception · {count("REVIEW")} review. ACCEPT records are not listed.
      </p>
      {error && <div className="error">{error.message}</div>}
      <div className="panel scroll">
        {open.length ? (
          <table>
            <thead>
              <tr>
                <th>Record</th>
                <th>Unit</th>
                <th>Outcome</th>
                <th>Overrides</th>
                <th>Operator</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {open.map((r) => (
                <tr key={r.id}>
                  <td>
                    <Link href={`/records/${r.record_id}`} className="mono">
                      {r.record_id}
                    </Link>
                  </td>
                  <td className="mono">{r.unit_id}</td>
                  <td>
                    <span className={`chip ${r.overall}`}>{r.overall}</span> {r.status === "pending" && <span className="chip pending">pending</span>}
                  </td>
                  <td>{(r.overrides as unknown as { count: number }[])[0]?.count || "—"}</td>
                  <td>{r.operator_id}</td>
                  <td>{new Date(r.created_at).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="sub">Nothing to review.</p>
        )}
      </div>
    </>
  );
}
