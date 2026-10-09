import Link from "next/link";
import { serverClient } from "@/lib/supabase/server";
import type { PoLine } from "@/lib/types";
import { InspectForm } from "./inspect-form";

// The model call can take minutes with local Ollama on CPU; Gemini answers in seconds.
export const maxDuration = 300;

export default async function InspectPage() {
  const db = await serverClient();
  const [{ data: lines, error }, { data: recent }] = await Promise.all([
    db.from("po_lines").select("*").order("unit_id").returns<PoLine[]>(),
    db.from("inspections").select("record_id, unit_id, status, overall, created_at").order("created_at", { ascending: false }).limit(8),
  ]);
  const gemini = (process.env.VISION_PROVIDER || "gemini") === "gemini";
  const timeoutS = Math.round(Number((gemini ? process.env.GEMINI_TIMEOUT_MS : process.env.OLLAMA_TIMEOUT_MS) || (gemini ? 120_000 : 600_000)) / 1000);

  return (
    <>
      <h1>Inspect a delivery</h1>
      <p className="sub">
        Pick the PO line, add the photos taken at the dock, and optionally type in your counts. All photos go to the model in one
        call. If the model is down or slow (over {timeoutS} s), the photos and a <em>pending</em> record are saved anyway.
      </p>
      {error && <div className="error">Could not load PO lines: {error.message}</div>}
      <div className="grid2">
        <InspectForm lines={lines ?? []} />
        <section className="panel">
          <h2>Recent inspections</h2>
          {recent?.length ? (
            <table>
              <tbody>
                {recent.map((r) => (
                  <tr key={r.record_id}>
                    <td>
                      <Link href={`/records/${r.record_id}`} className="mono">
                        {r.record_id}
                      </Link>
                      <div className="sub" style={{ margin: 0 }}>
                        {r.unit_id}
                      </div>
                    </td>
                    <td>
                      <span className={`chip ${r.overall}`}>{r.overall}</span>{" "}
                      {r.status === "pending" && <span className="chip pending">pending</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="sub">None yet.</p>
          )}
        </section>
      </div>
    </>
  );
}
