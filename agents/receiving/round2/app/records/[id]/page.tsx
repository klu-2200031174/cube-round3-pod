import Link from "next/link";
import { notFound } from "next/navigation";
import { issuesOf, sha256, verifyRecord, type EvidenceRecord } from "@/lib/evidence";
import { effectiveChecks, type OverrideRow } from "@/lib/records";
import { PHOTO_BUCKET, serverClient } from "@/lib/supabase/server";
import { OverrideForm, RetryButton } from "./forms";

export const maxDuration = 300;

const show = (v: unknown) => (v == null ? "—" : Array.isArray(v) ? v.join(", ") || "—" : String(v));
const SOURCE_LABEL = { model: "photo (model)", operator: "operator count", derived: "derived", none: "no source" } as const;

export default async function RecordPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = await serverClient();
  const { data: row } = await db.from("inspections").select("id, record_id, content_hash, retry_of, evidence, created_at").eq("record_id", id).maybeSingle();
  if (!row) notFound(); // also what another org's user gets: RLS hides the row entirely
  const rec = row.evidence as EvidenceRecord;

  const [{ data: overrides }, { data: retries }, { data: parent }, signed, photoChecks] = await Promise.all([
    db.from("overrides").select("*").eq("inspection_id", row.id).order("created_at").returns<OverrideRow[]>(),
    db.from("inspections").select("record_id, status, overall").eq("retry_of", row.id),
    row.retry_of ? db.from("inspections").select("record_id").eq("id", row.retry_of).maybeSingle() : Promise.resolve({ data: null }),
    rec.photos.length ? db.storage.from(PHOTO_BUCKET).createSignedUrls(rec.photos.map((p) => p.ref), 600) : Promise.resolve({ data: [] }),
    Promise.all(
      rec.photos.map(async (p) => {
        const { data } = await db.storage.from(PHOTO_BUCKET).download(p.ref);
        return data ? sha256(Buffer.from(await data.arrayBuffer())) === p.sha256 : null;
      }),
    ),
  ]);

  const hashOk = verifyRecord(rec) && rec.content_hash === row.content_hash;
  const eff = effectiveChecks(rec, overrides ?? []);
  const urls = new Map((signed.data ?? []).flatMap((s) => (s.path && s.signedUrl ? [[s.path, s.signedUrl] as const] : [])));

  return (
    <>
      <p className="sub" style={{ marginBottom: 6 }}>
        <Link href="/queue">← Review queue</Link>
      </p>
      <h1 className="mono">{rec.record_id}</h1>
      <p className="sub">
        {rec.unit_id} · {rec.expected.po_number}/{rec.expected.po_line} · {rec.expected.product_title} ({rec.expected.sku}) · captured{" "}
        {new Date(rec.captured_at).toLocaleString()} by {rec.operator_id}
      </p>

      <div className="panel">
        <div className="row" style={{ flexWrap: "wrap", gap: 16 }}>
          <div>
            <label>Overall (as recorded)</label>
            <span className={`chip big ${rec.overall}`}>{rec.overall}</span> <span className={`chip ${rec.status}`}>{rec.status}</span>
          </div>
          {eff.overall !== rec.overall && (
            <div>
              <label>Overall after overrides</label>
              <span className={`chip big ${eff.overall}`}>{eff.overall}</span>
            </div>
          )}
          <div>
            <label>Content hash</label>
            <span className={`chip ${hashOk ? "PASS" : "FAIL"}`}>{hashOk ? "matches record" : "does NOT match"}</span>
          </div>
        </div>
        {rec.status === "pending" && (
          <div className="note" style={{ marginTop: 14 }}>
            The model call failed: {rec.model.error}. The photos and this record are saved, and every visual check is UNCERTAIN.
            {retries?.length ? " It has been retried; see below." : ""}
            {!retries?.length && <RetryButton recordId={rec.record_id} />}
          </div>
        )}
        {parent && (
          <p className="sub" style={{ margin: "12px 0 0" }}>
            Retry of <Link href={`/records/${parent.record_id}`}>{parent.record_id}</Link>
          </p>
        )}
        {retries?.map((r) => (
          <p className="sub" key={r.record_id} style={{ margin: "12px 0 0" }}>
            Retried as <Link href={`/records/${r.record_id}`}>{r.record_id}</Link> → <span className={`chip ${r.overall}`}>{r.overall}</span>
          </p>
        ))}
      </div>

      {(() => {
        // Issues as they stand after overrides (0.1 records predate the stored list, so derive it).
        const issues = issuesOf(eff.checks);
        return (
          <section className="panel">
            <h2>Detected issues</h2>
            {issues.length === 0 ? (
              <p className="sub">None. Every check is PASS.</p>
            ) : (
              <ul className="issues">
                {issues.map((i) => (
                  <li key={i.check}>
                    <span className={`chip ${i.verdict}`}>{i.verdict}</span> <span className="mono">{i.check}</span>: {i.detail}
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })()}

      <section className="panel">
        <h2>Checks: expected vs observed</h2>
        <p className="sub">
          Confidence is a fixed rule, not a model score: <strong>high</strong> = operator count confirmed by the photo,{" "}
          <strong>medium</strong> = one direct source, <strong>low</strong> = model-only count or a poor photo. UNCERTAIN has none.
        </p>
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>Check</th>
                <th>Verdict</th>
                <th>Confidence</th>
                <th>Expected</th>
                <th>Observed</th>
                <th>Source</th>
                <th>Why</th>
              </tr>
            </thead>
            <tbody>
              {eff.checks.map((c) => (
                <tr key={c.name}>
                  <td className="mono">{c.name}</td>
                  <td>
                    <span className={`chip ${c.verdict}`}>{c.verdict}</span>
                    {c.overridden && (
                      <div style={{ fontSize: 12, marginTop: 4 }}>
                        <s>{c.overridden.original_verdict}</s> overridden
                      </div>
                    )}
                  </td>
                  <td>{c.confidence ?? "—"}</td>
                  <td>{show(c.expected)}</td>
                  <td>{show(c.observed)}</td>
                  <td>
                    <span className="chip src">{SOURCE_LABEL[c.source]}</span>
                    {c.photo_refs.length > 0 && <div className="sub mono" style={{ margin: "4px 0 0" }}>{c.photo_refs.map((n) => `#${n}`).join(" ")}</div>}
                  </td>
                  <td className="reason">{c.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel">
        <h2>Photos</h2>
        <p className="sub">Numbers match the labels on the contact sheet the model saw. Links expire after 10 minutes.</p>
        <div className="photos">
          {rec.photos.map((p, i) => (
            <figure key={p.ref}>
              {urls.get(p.ref) ? (
                // eslint-disable-next-line @next/next/no-img-element
                <a href={urls.get(p.ref)} target="_blank" rel="noreferrer"><img src={urls.get(p.ref)} alt={`#${p.index} ${p.role}`} /></a>
              ) : (
                <div className="error">Not available</div>
              )}
              <figcaption>
                <strong>#{p.index} {p.role}</strong>{" "}
                <span className={`chip ${photoChecks[i] ? "PASS" : photoChecks[i] === false ? "FAIL" : "UNCERTAIN"}`}>
                  {photoChecks[i] ? "sha256 ok" : photoChecks[i] === false ? "sha256 mismatch" : "not checked"}
                </span>
                <br />
                <span className="mono">{p.sha256.slice(0, 16)}…</span>
              </figcaption>
            </figure>
          ))}
        </div>
      </section>

      <div className="grid2">
        <section className="panel">
          <h2>Override a check</h2>
          <p className="sub">Overrides are added alongside the record. The original verdict is never changed or deleted.</p>
          <OverrideForm recordId={rec.record_id} checks={eff.checks.map((c) => ({ name: c.name, verdict: c.verdict }))} />
        </section>
        <section className="panel">
          <h2>Override history</h2>
          {overrides?.length ? (
            <table>
              <tbody>
                {overrides.map((o) => (
                  <tr key={o.id}>
                    <td>
                      <span className="mono">{o.check_name}</span>
                      <div>
                        <span className={`chip ${o.original_verdict}`}>{o.original_verdict}</span> → <span className={`chip ${o.new_verdict}`}>{o.new_verdict}</span>
                      </div>
                    </td>
                    <td className="reason">
                      “{o.reason}”
                      <div style={{ fontSize: 12 }}>
                        {o.operator_id}, {new Date(o.created_at).toLocaleString()}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="sub">No overrides.</p>
          )}
        </section>
      </div>

      <section className="panel">
        <h2>Evidence record</h2>
        <dl className="kv" style={{ marginBottom: 12 }}>
          <dt>Contract</dt>
          <dd className="mono">{rec.contract_version}</dd>
          <dt>Model</dt>
          <dd className="mono">
            {rec.model.provider}/{rec.model.model}, prompt {rec.model.prompt_version}
            {rec.model.latency_ms != null && `, ${(rec.model.latency_ms / 1000).toFixed(1)} s`}
          </dd>
          <dt>Operator counts</dt>
          <dd>
            cartons {show(rec.operator_counts?.cartons_received)}, units per carton {show(rec.operator_counts?.units_per_carton_counted)}
          </dd>
          <dt>Content hash</dt>
          <dd className="mono" style={{ wordBreak: "break-all" }}>{rec.content_hash}</dd>
        </dl>
        <p>
          <a href={`/records/${rec.record_id}/json`}>Download JSON</a> (the shape in <code>contract/receiving-evidence.schema.json</code>)
        </p>
        <details>
          <summary>CSV-compatible summary</summary>
          <pre>{JSON.stringify(rec.summary, null, 2)}</pre>
        </details>
        <details>
          <summary>Raw model output</summary>
          <pre>{rec.model.raw_output ?? "(none)"}</pre>
        </details>
      </section>
    </>
  );
}
