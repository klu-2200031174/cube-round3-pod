"use strict";
// Control-centre pages (Pod 13). Components (h, api, charts, renderEvidence, forms...) come from app.js.
const CHIPS = ["ALL", "IN_PROGRESS", "BLOCKED", "FAILED", "RECOVERY_REQUIRED", "COMPLETED"];
const STAGES5 = [["receiving", "Receiving"], ["prep", "Prep"], ["pack", "Pack"], ["returns", "Returns"], ["recovery", "Recovery"]];
const chipRow = (cur, set) => h("div", { class: "chips" }, CHIPS.map((c) => h("button", { class: "chip" + (cur === c ? " on" : ""), onclick: () => set(c) }, c)));
const when = (t) => (t ? t.replace("T", " ").replace("Z", "").slice(0, 16) : "—");
async function openWorkflow(id, into) {
  const b = await api("/workflows/" + encodeURIComponent(id) + "/evidence"); into.replaceChildren(); renderBundle(b, into);
  const wf = b.workflow; into.prepend(h("div", { class: "card" }, h("h3", {}, "Workflow timeline · " + wf.workflow_id), h("div", { class: "steps" }, wf.stage_results.map((s) => h("div", { class: "stp " + s.state }, h("b", {}, s.stage), h("span", {}, s.state === "skipped" ? "skipped" : (s.verdict || s.state)))))));
}
// ---------------------------------------------------------------- landing
function landing(m) {
  document.body.classList.add("landing");
  m.append(h("div", { class: "hero" }, h("span", { class: "pill" }, "● INTEGRATED END TO END"), h("h1", {}, "From supplier dock ", h("em", {}, "to final claim.")),
    h("p", {}, "One orchestrator routes every unit, hands each stage the full evidence chain, and derives the outcome. Five Groq-powered agents. Every decision traceable to its evidence."),
    h("a", { class: "btn big", href: "#overview" }, "Open control center →"),
    h("div", { class: "flow" }, STAGES5.map(([k, l], i) => [h("div", { class: "node" }, h("small", {}, "0" + (i + 1)), h("b", {}, l)), i < 4 ? h("span", { class: "arrow" }, "→") : null])),
    h("div", { class: "grid g4", style: "margin-top:34px;text-align:left" }, [["Judge", "Agents describe and judge from photos — PASS, FAIL or UNCERTAIN, never a guess."], ["Decide", "The orchestrator derives status and the final outcome from the evidence chain."], ["Trace", "Every record carries sha256 hashes of the photos it was based on."], ["Recover", "Fee charges are matched to evidence: contradicted, supported or silent."]].map(([t, d]) => h("div", { class: "card" }, h("h3", {}, t), h("p", { class: "mute" }, d))))));
}
// ---------------------------------------------------------------- overview
async function overview(m) {
  const [a, wf] = await Promise.all([api("/api/analytics"), api("/api/workflow-list")]); const k = a.kpis;
  m.append(h("h2", {}, "Overview"), h("p", { class: "sub" }, "Live state of every unit moving through the five agents."));
  if (!k.groq_ready) m.append(h("div", { class: "note warn" }, "Groq is not connected, so AI inspections are off. Add the key in ", h("a", { href: "#system" }, "Pod / System"), ". Sample units replay the organiser's CSV — they are not AI results."));
  m.append(h("div", { class: "grid g4", style: "margin-bottom:16px" }, [["Workflows", k.workflows], ["Clean", k.clean], ["Exceptions", k.exceptions], ["Claims recommended", k.claims], ["Claimable value", money(k.claimable_usd)], ["Needs review", k.needs_review], ["AI records (Groq)", k.ai_records], ["Lab units", k.lab_units]].map(([l, v]) => h("div", { class: "kpi" }, h("span", {}, l), h("b", {}, v)))));
  const pipe = h("div", { class: "card" }, h("h3", {}, "Standard flow · standard-v1"), h("div", { class: "flow small" }, STAGES5.map(([s, l], i) => { const v = a.stage_verdicts[s] || {}; const n = (v.PASS || 0) + (v.FAIL || 0) + (v.UNCERTAIN || 0);
    return [h("a", { class: "node", href: "#console-" + s }, h("small", {}, "0" + (i + 1)), h("b", {}, l), h("span", {}, n + " records"), h("div", { class: "mini" }, ["PASS", "FAIL", "UNCERTAIN"].map((x) => h("i", { style: `flex:${v[x] || 0};background:${VC[x]}` })))), i < 4 ? h("span", { class: "arrow" }, "→") : null]; })));
  m.append(pipe); const g = h("div", { class: "grid g2" }); const c1 = h("div", { class: "card" }, h("h3", {}, "Final outcomes")), c2 = h("div", { class: "card" }, h("h3", {}, "Workflows by status"));
  doughnut(c1, a.outcomes, { CLEAN: "#10b981", EXCEPTION: "#ef4444", CLAIM_RECOMMENDED: "#0ea5e9", NEEDS_REVIEW: "#f59e0b", INCOMPLETE: "#94a3b8" }); doughnut(c2, a.status); g.append(c1, c2); m.append(g);
  m.append(h("div", { class: "card" }, h("h3", {}, "Latest workflows"), wfTable(wf.slice(0, 8), m)));
}
function wfTable(rows, host) {
  const detail = h("div"); const t = h("table", {}, h("tr", {}, ["Workflow", "Unit", "Org", "Route", "Returned", "Stage", "Status", "Outcome", "Claimable"].map((x) => h("th", {}, x))));
  rows.forEach((r) => t.append(h("tr", { class: "click", onclick: () => openWorkflow(r.workflow_id, detail).then(() => detail.scrollIntoView({ behavior: "smooth" })) }, h("td", { class: "mono" }, r.workflow_id.replace("WF-", "")), h("td", {}, r.unit_id), h("td", {}, r.org_id.replace("org_", "")), h("td", {}, r.route.toUpperCase()), h("td", {}, r.returned ? "YES" : "NO"), h("td", {}, r.current_stage || "—"), h("td", {}, badge(r.status)), h("td", {}, r.outcome ? badge(r.outcome) : "—"), h("td", {}, r.claimable_usd ? money(r.claimable_usd) : "—"))));
  if (!rows.length) t.append(h("tr", {}, h("td", { colspan: 9, class: "mute" }, "No workflow matches this search or filter.")));
  return h("div", {}, h("div", { class: "scroll" }, t), detail);
}
// ---------------------------------------------------------------- workflows
async function workflows(m) {
  let rows = await api("/api/workflow-list"), cur = "ALL", q = ""; const host = h("div");
  m.append(h("h2", {}, "Workflows"), h("p", { class: "sub" }, "All running and completed commerce workflows. Click a row for its full evidence trail."));
  const search = inp("", "text", "Search by workflow ID, unit ID, org…"); const draw = () => { const f = rows.filter((r) => (cur === "ALL" || r.status === cur) && (r.workflow_id + r.unit_id + r.org_id).toLowerCase().includes(q.toLowerCase())); host.replaceChildren(chipRow(cur, (c) => { cur = c; draw(); }), wfTable(f.slice(0, 120), m), h("p", { class: "mute" }, f.length + " workflow(s)")); };
  search.oninput = () => { q = search.value; draw(); };
  m.append(h("div", { class: "row card" }, search, h("div", { class: "fix" }, h("button", { onclick: () => runModal(async () => { rows = await api("/api/workflow-list"); draw(); }) }, "+ Run Workflow"))), host); draw();
}
async function runModal(done) {
  const units = await api("/api/units"); const sel = h("select", {}, units.map((u) => h("option", { value: u.org_id + "|" + u.unit_id }, `${u.unit_id} · ${u.org_id} (Route: ${u.route.toUpperCase()}, Returned: ${u.returned ? "YES" : "NO"}) · ${u.title}`)));
  const msg = h("p", { class: "mute" }); const ov = h("div", { class: "overlay" }); const close = () => ov.remove();
  const go = h("button", { onclick: async () => { go.disabled = true; msg.textContent = "Running…"; const [org, unit] = sel.value.split("|"); try { const r = await api("/workflows", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ org_id: org, unit_id: unit }) }); toast("Workflow " + r.status + " · " + (r.final_outcome?.outcome || "")); close(); done && done(); } catch (e) { msg.textContent = e.message; go.disabled = false; } } }, "▶ Launch Workflow");
  ov.append(h("div", { class: "modal" }, h("div", { class: "row" }, h("h3", {}, "Run Workflow"), h("button", { class: "ghost fix", onclick: close }, "✕")), h("p", { class: "mute" }, "Dispatch commerce orchestration for an inventory unit."),
    h("div", { class: "tabs" }, h("button", { class: "chip on" }, "Demo Cases (" + units.length + ")"), h("a", { class: "chip", href: "#live", onclick: close }, "Custom Unit →")), field("Select case", sel), msg, h("div", { class: "row", style: "justify-content:flex-end" }, h("button", { class: "ghost fix", onclick: close }, "Cancel"), h("div", { class: "fix" }, go))));
  document.body.append(ov);
}
// ---------------------------------------------------------------- units
async function unitsPage(m) {
  const [units, wf] = await Promise.all([api("/api/units"), api("/api/workflow-list")]); const by = Object.fromEntries(wf.map((w) => [w.unit_id + w.org_id, w]));
  m.append(h("h2", {}, "Units"), h("p", { class: "sub" }, "Every inventory unit in the pod, with its route and latest workflow state.")); const q = inp("", "text", "Filter by unit, SKU, org…"); const body = h("tbody");
  const draw = () => body.replaceChildren(...units.filter((u) => (u.unit_id + u.sku + u.org_id + u.title).toLowerCase().includes(q.value.toLowerCase())).map((u) => { const w = by[u.unit_id + u.org_id];
    return h("tr", {}, h("td", { class: "mono" }, u.unit_id), h("td", {}, u.org_id.replace("org_demo_", "")), h("td", {}, u.title, h("div", { class: "mute mono" }, u.sku)), h("td", {}, u.route.toUpperCase()), h("td", {}, u.returned ? "YES" : "NO"), h("td", {}, u.fees ? u.fees + " · " + money(u.fee_total) : "—"), h("td", {}, w ? badge(w.outcome || w.status) : h("span", { class: "mute" }, "not run")),
      h("td", {}, h("button", { class: "ghost", onclick: async (e) => { e.target.disabled = true; try { await api("/workflows", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ org_id: u.org_id, unit_id: u.unit_id }) }); toast(u.unit_id + " processed"); route(); } catch (x) { toast(x.message); } } }, w ? "Re-open" : "Run"))); }));
  q.oninput = draw; draw(); m.append(h("div", { class: "card" }, q, h("div", { class: "scroll", style: "max-height:560px;margin-top:10px" }, h("table", {}, h("thead", {}, h("tr", {}, ["Unit", "Org", "Product", "Route", "Returned", "Fee lines", "Outcome", ""].map((x) => h("th", {}, x)))), body))));
}
// ---------------------------------------------------------------- review queue
async function queue(m) {
  const q = await api("/api/review-queue"); m.append(h("h2", {}, "Review Queue"), h("p", { class: "sub" }, "Agents returned UNCERTAIN and asked for a person. Your decision is recorded as an override on top of the evidence — nothing is rewritten."));
  if (!q.length) return m.append(h("div", { class: "card" }, "🎉 Nothing is waiting for a decision."));
  m.append(h("p", { class: "mute" }, q.length + " item(s) waiting"));
  q.forEach((it) => { const v = h("select", {}, ["PASS", "FAIL", "UNCERTAIN"].map((x) => h("option", {}, x))), who = inp("", "text", "Your name"), why = inp("", "text", "Reason (required)"); const msg = h("span", { class: "mute" });
    const b = h("button", { onclick: async () => { b.disabled = true; try { await api(`/workflows/${encodeURIComponent(it.workflow_id)}/overrides`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ record_id: it.record_id, new_verdict: v.value, actor: who.value, reason: why.value }) }); await api(`/workflows/${encodeURIComponent(it.workflow_id)}/resume`, { method: "POST" }); toast("Decision recorded"); route(); } catch (e) { msg.textContent = e.message; b.disabled = false; } } }, "Record decision");
    m.append(h("div", { class: "card" }, h("div", { class: "row" }, h("div", {}, h("b", {}, it.unit_id), " · ", it.stage, " ", badge("UNCERTAIN"), h("div", { class: "mute mono" }, it.record_id)), h("div", { class: "fix" }, h("a", { href: "#evidence/" + it.record_id }, "View evidence →"))), h("p", {}, it.reason), it.uncertain_checks.length ? h("p", { class: "mute" }, "Uncertain checks: " + it.uncertain_checks.join(", ")) : null,
      h("div", { class: "grid g3" }, field("Decision", v), field("Reviewer", who), field("Reason", why)), h("div", { style: "margin-top:10px" }, b, " ", msg))); });
}
// ---------------------------------------------------------------- recovery
async function recoveryHub(m) {
  const [ch, an] = await Promise.all([api("/api/charges"), api("/api/analytics")]); let cur = "ALL";
  m.append(h("h2", {}, "Recovery & Claims"), h("p", { class: "sub" }, "Charge review and automated claim recommendations. Silent is never claimed."));
  const claim = ch.filter((c) => c.position === "CONTRADICTS"); m.append(h("div", { class: "grid g4", style: "margin-bottom:16px" }, [["Charges reviewed", ch.length], ["Claims recommended", claim.length], ["Claimable value", money(claim.reduce((s, c) => s + (c.claim_usd || 0), 0))], ["Silent", ch.filter((c) => c.position === "SILENT").length]].map(([l, v]) => h("div", { class: "kpi" }, h("span", {}, l), h("b", {}, v)))));
  const host = h("div"); const tag = { ALL: null, CLAIMABLE: "CONTRADICTS", SUPPORTS: "SUPPORTS", SILENT: "SILENT" };
  const draw = () => { const f = ch.filter((c) => !tag[cur] || c.position === tag[cur]); const t = h("table", {}, h("tr", {}, ["Charge", "Type", "Amount", "Position", "Evidence", "Decision"].map((x) => h("th", {}, x))));
    f.slice(0, 150).forEach((c) => t.append(h("tr", {}, h("td", { class: "mono" }, c.line_id), h("td", {}, c.type), h("td", {}, money(c.amount_usd)), h("td", {}, badge(c.position)), h("td", { class: "mono" }, c.evidence.join(", ") || "—"), h("td", {}, c.position === "CONTRADICTS" ? h("b", {}, "CLAIM " + money(c.claim_usd)) : "NO CLAIM"))));
    host.replaceChildren(h("div", { class: "chips" }, Object.keys(tag).map((k) => h("button", { class: "chip" + (cur === k ? " on" : ""), onclick: () => { cur = k; draw(); } }, k))), h("div", { class: "scroll", style: "max-height:420px" }, t)); }; draw();
  m.append(h("div", { class: "card" }, host)); const g = h("div", { class: "grid g2" }); const a = h("div", { class: "card" }, h("h3", {}, "Charge assessments")), b = h("div", { class: "card" }, h("h3", {}, "Claimable $ by charge type")); doughnut(a, an.recovery_positions, { SUPPORTS: "#10b981", CONTRADICTS: "#ef4444", SILENT: "#f59e0b" }); bar(b, Object.keys(an.claimable_by_type), [{ label: "Claimable $", data: Object.values(an.claimable_by_type) }]); g.append(a, b); m.append(g);
  m.append(h("h3", { style: "color:var(--ink);margin-top:24px" }, "Analyse a fee report")); await recoveryPage(m, true);
}
// ---------------------------------------------------------------- evidence
async function evidencePage(m, arg) {
  m.append(h("h2", {}, "Evidence"), h("p", { class: "sub" }, "Every record is immutable and hashed. Open one to see the checks, photos (sha256) and the raw JSON."));
  const detail = h("div"); const show = async (id) => { const e = await api("/api/evidence/" + encodeURIComponent(id)); detail.replaceChildren(h("h3", { style: "color:var(--ink)" }, "Record " + id)); renderEvidence(e, detail); detail.scrollIntoView({ behavior: "smooth" }); };
  if (arg) return show(arg).then(() => m.append(detail));
  const list = await api("/api/evidence-list"); let st = "ALL"; const q = inp("", "text", "Search record, unit, model…"); const host = h("div");
  const draw = () => { const f = list.filter((e) => (st === "ALL" || e.stage === st) && (e.record_id + e.unit_id + (e.model || "")).toLowerCase().includes(q.value.toLowerCase()));
    const t = h("table", {}, h("tr", {}, ["Record", "Stage", "Unit", "Verdict", "Outcome", "Model", "Photos", "Hash", "Produced"].map((x) => h("th", {}, x))));
    f.slice(0, 120).forEach((e) => t.append(h("tr", { class: "click", onclick: () => show(e.record_id) }, h("td", { class: "mono" }, e.record_id), h("td", {}, e.stage), h("td", {}, e.unit_id), h("td", {}, badge(e.verdict)), h("td", {}, e.outcome), h("td", { class: "mono" }, e.model || "—"), h("td", {}, e.photos), h("td", { class: "mono" }, e.hash), h("td", {}, when(e.produced_at)))));
    host.replaceChildren(h("div", { class: "chips" }, ["ALL", ...STAGES5.map((s) => s[0])].map((s) => h("button", { class: "chip" + (st === s ? " on" : ""), onclick: () => { st = s; draw(); } }, s))), h("div", { class: "scroll", style: "max-height:380px" }, t), h("p", { class: "mute" }, f.length + " record(s)")); };
  q.oninput = draw; draw(); m.append(h("div", { class: "card" }, q, host), detail);
}
// ---------------------------------------------------------------- agents
async function agentsPage(m) {
  const [ag, a] = await Promise.all([api("/api/agents"), api("/api/analytics")]); const c = await api("/api/config");
  m.append(h("h2", {}, "Agents"), h("p", { class: "sub" }, "Five specialised agents, all integrated and all running on Groq."));
  m.append(h("div", { class: "grid g3", style: "margin-bottom:16px" }, [["Agents in flow", 5], ["Integrated (not stubs)", "5 of 5"], ["Model", c.key_set ? c.model : "Groq key missing"]].map(([l, v]) => h("div", { class: "kpi" }, h("span", {}, l), h("b", { style: "font-size:22px" }, v)))));
  m.append(h("div", { class: "grid g3" }, ag.map((x) => h("div", { class: "card" }, h("span", { class: "pill" }, "● INTEGRATED"), h("h3", { style: "margin-top:10px;font-size:18px" }, x.n + " · " + x.stage[0].toUpperCase() + x.stage.slice(1) + " Manager"),
    h("p", { class: "mute", style: "font-size:13px" }, x.implementation), h("p", { class: "mono mute" }, x.agent_id + " · " + x.mode), h("p", {}, h("b", {}, "AI: "), x.ai), h("div", {}, x.checks.map((k) => h("span", { class: "tag" }, k))),
    h("p", { class: "mute" }, "Records produced: " + Object.values(a.stage_verdicts[x.stage] || {}).reduce((s, n) => s + n, 0)), h("a", { class: "btn", href: "#console-" + x.stage }, "Open console →")))));
}
// ---------------------------------------------------------------- failures
async function failuresPage(m) {
  const f = await api("/api/failures"); m.append(h("h2", {}, "Failures"), h("p", { class: "sub" }, "Stages that did not complete. Failures are recorded, never turned into success. Retry re-runs only what did not finish."));
  if (!f.length) return m.append(h("div", { class: "card" }, "✅ No failed workflows."));
  f.forEach((x) => m.append(h("div", { class: "card" }, h("div", { class: "row" }, h("div", {}, h("b", {}, x.workflow_id), " ", badge(x.status), h("div", { class: "mute" }, x.reason)), h("div", { class: "fix" }, h("button", { onclick: async (e) => { e.target.disabled = true; try { await api(`/workflows/${encodeURIComponent(x.workflow_id)}/resume`, { method: "POST" }); toast("Retried"); route(); } catch (er) { toast(er.message); e.target.disabled = false; } } }, "Retry"))),
    x.errors.map((er) => h("p", { class: "mono" }, `${er.stage}: ${er.code} — ${er.message}`)))));
}
// ---------------------------------------------------------------- system
async function systemPage(m) {
  m.append(h("h2", {}, "Pod 13"), h("p", { class: "sub" }, "Standard commerce flow · orchestration environment")); const hl = h("div"); const check = async () => { hl.replaceChildren("Checking…"); try { const r = await api("/health"); hl.replaceChildren(h("table", {}, [["Backend API", "Online"], ["Flow", r.flow], ["Orchestrator", r.status.toUpperCase()], ...Object.entries(r.agents).map(([k, v]) => [k + " agent", v.status])].map(([a, b]) => h("tr", {}, h("td", {}, a), h("td", {}, h("b", {}, b)))))); } catch (e) { hl.textContent = "Offline: " + e.message; } };
  m.append(h("div", { class: "grid g2" }, h("div", { class: "card" }, h("h3", {}, "Architecture"), STAGES5.map(([, l], i) => h("div", { class: "arch" }, (i + 1) + " · " + l + " Manager"))), h("div", { class: "card" }, h("h3", {}, "Health & connectivity"), hl, h("div", { style: "margin-top:12px" }, h("button", { class: "ghost", onclick: check }, "Recheck connection")))));
  check(); await settings(m);
}
// ---------------------------------------------------------------- orchestration graph (live + replay)
const COLS_PAR = [["receiving", "prep", "pack"], ["returns"], ["recovery"]], COLS_SEQ = [["receiving"], ["prep"], ["pack"], ["returns"], ["recovery"]];
const LBL = { receiving: "Receiving", prep: "Prep", pack: "Pack", returns: "Returns", recovery: "Recovery" };
const STATE_COL = { pending: "#cbd5e1", running: "#0ea5e9", completed: "#10b981", error: "#ef4444" };
function dagEl(st, parallel, pick, sel) {
  const cols = (parallel ? COLS_PAR : COLS_SEQ).map((c) => c.filter((s) => st[s] && st[s].state !== "skipped")).filter((c) => c.length);
  const node = (s) => { const x = st[s]; const v = x.verdict; const cls = "dnode " + x.state + (v ? " v" + v : "") + (sel === s ? " sel" : "");
    return h("div", { class: cls, onclick: () => pick && pick(s) }, h("b", {}, LBL[s]), x.state === "running" ? h("span", { class: "run" }, h("span", { class: "spin dark" }), "working…") : h("span", {}, v ? v : x.state),
      x.duration_ms != null ? h("small", {}, (x.duration_ms / 1000).toFixed(2) + " s") : null, x.outcome ? h("small", {}, x.outcome) : null); };
  return h("div", { class: "dag" }, cols.map((c, i) => [h("div", { class: "dcol" }, c.length > 1 && parallel ? h("div", { class: "together" }, "⚡ run together") : null, c.map(node)), i < cols.length - 1 ? h("div", { class: "dedge" }, h("i", {}), h("small", {}, "evidence")) : null]));
}
function ganttChart(host) {
  const box = h("div", { class: "chart" }), cv = h("canvas"); box.append(cv); host.append(box);
  const ch = new Chart(cv, { type: "bar", data: { labels: [], datasets: [{ data: [], backgroundColor: [], borderRadius: 6, borderSkipped: false }] },
    options: { indexAxis: "y", responsive: true, maintainAspectRatio: false, animation: false, plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => `${c.raw[0].toFixed(2)}s → ${c.raw[1].toFixed(2)}s  (${(c.raw[1] - c.raw[0]).toFixed(2)}s)` } } }, scales: { x: { title: { display: true, text: "seconds since start" }, min: 0 } } } });
  charts.push(ch);
  return (st, now) => { const rows = Object.entries(st).filter(([, x]) => x.t_start); if (!rows.length) return; const t0 = Math.min(...rows.map(([, x]) => x.t_start));
    rows.sort((a, b) => a[1].t_start - b[1].t_start); ch.data.labels = rows.map(([k]) => LBL[k]);
    ch.data.datasets[0].data = rows.map(([, x]) => [x.t_start - t0, Math.max((x.t_end ?? now) - t0, x.t_start - t0 + 0.02)]);
    ch.data.datasets[0].backgroundColor = rows.map(([, x]) => (x.state === "running" ? "#38bdf8" : x.verdict === "FAIL" ? "#ef4444" : x.verdict === "UNCERTAIN" ? "#f59e0b" : "#10b981")); ch.update("none"); };
}
function summary(st, now) {
  const rows = Object.values(st).filter((x) => x.t_start); if (!rows.length) return "";
  const t0 = Math.min(...rows.map((x) => x.t_start)), t1 = Math.max(...rows.map((x) => x.t_end ?? now)); const sum = rows.reduce((a, x) => a + ((x.t_end ?? now) - x.t_start), 0);
  return { wall: t1 - t0, sum, saved: Math.max(sum - (t1 - t0), 0) };
}
// Shows a workflow's orchestration. mode "live" polls until done; mode "replay" animates a finished workflow.
function orchestrationPanel(workflowId, opts = {}) {
  const root = h("div", { class: "card orch" }), head = h("div", { class: "row", style: "align-items:center" }), graph = h("div"), kp = h("div", { class: "grid g4", style: "margin:12px 0" }), log = h("div", { class: "log" }), detail = h("div");
  const gHost = h("div"); const upd = ganttChart(gHost); let sel = null, timer = null, last = null, stopped = false, speed = 1;
  const title = h("h3", { style: "margin:0" }, "AI orchestration · " + workflowId); const status = h("span", { class: "badge UNCERTAIN" }, "connecting…");
  head.append(title, h("div", { class: "fix" }, status)); root.append(head, graph, kp, h("div", { class: "grid g2" }, h("div", {}, h("h3", {}, "Timeline (Gantt) — bars that overlap ran at the same time"), gHost), h("div", {}, h("h3", {}, "Orchestrator events"), log)), detail);
  const pick = async (s) => { sel = s; const x = last?.stages[s]; draw(last, last.now); if (x?.record_id) { const e = await api("/api/evidence/" + encodeURIComponent(x.record_id)); detail.replaceChildren(h("h3", { style: "color:var(--ink)" }, LBL[s] + " — evidence record"), ""); renderEvidence(e, detail); detail.scrollIntoView({ behavior: "smooth" }); } };
  function draw(d, now) {
    if (!d) return; graph.replaceChildren(dagEl(d.stages, d.parallel, pick, sel)); upd(d.stages, now); const sm = summary(d.stages, now);
    kp.replaceChildren(...(sm ? [["Mode", d.parallel ? "Parallel" : "Sequential"], ["Wall-clock", sm.wall.toFixed(2) + " s"], ["Sum of agent time", sm.sum.toFixed(2) + " s"], ["Saved by parallelism", d.parallel && d.done ? sm.saved.toFixed(2) + " s" : d.done ? "0.00 s" : "…"]] : [["Mode", d.parallel ? "Parallel" : "Sequential"]]).map(([l, v]) => h("div", { class: "kpi" }, h("span", {}, l), h("b", { style: "font-size:22px" }, v))));
    log.replaceChildren(...(d.transitions || []).map((t) => h("div", { class: "ev" }, h("span", { class: "mono mute" }, (t.at || "").slice(11, 19)), " ", h("b", {}, t.event.replace("_", " ")), " ", t.stage || "", " ", h("span", { class: "mute" }, t.detail || ""))));
  }
  async function poll() {
    if (stopped) return; try { const d = await api("/api/lab/live/" + encodeURIComponent(workflowId)); last = d; if (d.known) { draw(d, d.now); status.textContent = d.done ? "finished · " + (d.status || "") : "running…"; status.className = "badge " + (d.done ? "PASS" : "UNCERTAIN");
      if (d.done) { stopped = true; opts.onDone && opts.onDone(d); root.append(replayBar()); return; } } } catch (e) { status.textContent = e.message; }
    timer = setTimeout(poll, 350);
  }
  function replayBar() {
    const sp = h("select", { onchange: (e) => (speed = +e.target.value) }, [[1, "1× speed"], [3, "3×"], [0.25, "0.25× slow-mo"]].map(([v, l]) => h("option", { value: v }, l)));
    return h("div", { class: "row", style: "align-items:center;margin-top:10px" }, h("div", { class: "fix" }, h("button", { class: "ghost", onclick: replay }, "↻ Replay this run")), h("div", { class: "fix" }, sp), h("span", { class: "mute" }, "Click any agent node to open its evidence record."));
  }
  function replay() {
    if (!last) return; stopped = true; clearTimeout(timer); const rows = Object.values(last.stages).filter((x) => x.t_start); const t0 = Math.min(...rows.map((x) => x.t_start)), t1 = Math.max(...rows.map((x) => x.t_end)); const real = performance.now();
    const step = () => { const t = t0 + ((performance.now() - real) / 1000) * speed; const stages = {};
      for (const [k, x] of Object.entries(last.stages)) stages[k] = !x.t_start ? x : t < x.t_start ? { state: "pending" } : t < x.t_end ? { state: "running", t_start: x.t_start } : x;
      draw({ ...last, stages, done: t >= t1 }, Math.min(t, t1)); if (t < t1) requestAnimationFrame(step); }; step();
  }
  if (opts.replay) { api("/api/lab/live/" + encodeURIComponent(workflowId)).then((d) => { last = d; draw(d, d.now); status.textContent = "finished · " + (d.status || ""); status.className = "badge PASS"; root.append(replayBar()); }); } else poll();
  root.stop = () => { stopped = true; clearTimeout(timer); };
  return root;
}
async function orchestrationPage(m, arg) {
  m.append(h("h2", {}, "AI Orchestration"), h("p", { class: "sub" }, "How the orchestrator schedules the five agents. In parallel mode, agents that do not need each other's evidence run at the same moment; an agent that does (Returns needs Pack, Recovery needs everything) waits for exactly those records."));
  m.append(h("div", { class: "card" }, h("h3", {}, "Dependency rules"), h("div", { class: "grid g3" }, [["Run together", "Receiving ∥ Prep or Pack — independent photos, independent rules."], ["Wait for Pack", "Returns compares what came back with what Pack sealed, so it starts after Pack."], ["Wait for all", "Recovery audits every charge against all earlier records, so it runs last."]].map(([t, d]) => h("div", { class: "note" }, h("b", {}, t), h("div", {}, d)))), h("p", { class: "mute" }, "Decisions are identical in both modes — only the schedule differs. Every record is hashed and immutable either way.")));
  const rows = await api("/api/workflow-list"); const holder = h("div");
  const sel = h("select", {}, rows.map((r) => h("option", { value: r.workflow_id, selected: r.workflow_id === arg }, `${r.unit_id} · ${r.status} · ${r.stages.join(" → ")}`)));
  const par = h("input", { type: "checkbox", checked: true }); const show = () => { holder.querySelector(".orch")?.stop?.(); holder.replaceChildren(orchestrationPanel(sel.value, { replay: true })); };
  const runSample = h("button", { onclick: async (e) => { e.target.disabled = true; const [org, unit] = (units_.find((u) => u.unit_id === uSel.value) || {}).k?.split("|") || []; try { const r = await api("/workflows", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ org_id: org, unit_id: unit, parallel: par.checked }) }); const rr = await api("/api/workflow-list"); sel.replaceChildren(...rr.map((x) => h("option", { value: x.workflow_id, selected: x.workflow_id === r.workflow_id }, `${x.unit_id} · ${x.status} · ${x.stages.join(" → ")}`))); sel.value = r.workflow_id; show(); } catch (er) { toast(er.message); } e.target.disabled = false; } }, "Open / run unit");
  const units_ = (await api("/api/units")).map((u) => ({ ...u, k: u.org_id + "|" + u.unit_id })); const uSel = h("select", {}, units_.map((u) => h("option", { value: u.unit_id }, `${u.unit_id} · ${u.route.toUpperCase()}${u.returned ? " · returned" : ""}`)));
  m.append(h("div", { class: "card" }, h("h3", {}, "Replay a workflow"), h("div", { class: "grid g2" }, field("Workflow", sel), h("div", {}, h("label", {}, "Or run a sample unit now"), h("div", { class: "row" }, uSel, h("label", { class: "chk fix" }, par, "parallel"), h("div", { class: "fix" }, runSample)))), h("div", { style: "margin-top:10px" }, h("button", { onclick: show }, "Show orchestration"))), holder, h("p", { class: "mute" }, "Sample units replay the organiser's CSV and finish in milliseconds, and a unit that was already processed is shown as it ran (evidence is immutable, so it is not re-run). To watch real Groq calls overlap, use Live Run with your own photos."));
  if (rows.length) show();
}
async function startLive(btn, out, parallel, build) {
  btn.disabled = true; const old = btn.textContent; btn.replaceChildren(h("span", { class: "spin" }), "Orchestrating…");
  try { const fd = build(); fd.append("async", "1"); fd.append("parallel", parallel ? "1" : "0"); const r = await api("/api/lab/run", { method: "POST", body: fd });
    out.replaceChildren(); const results = h("div");
    const panel = orchestrationPanel(r.workflow_id, { onDone: async () => { const b = await api("/workflows/" + encodeURIComponent(r.workflow_id) + "/evidence"); results.replaceChildren(); renderBundle(b, results); btn.disabled = false; btn.textContent = old; refreshStatus(); } });
    out.append(panel, results); panel.scrollIntoView({ behavior: "smooth" });
  } catch (e) { out.replaceChildren(h("div", { class: "note warn" }, "⚠ " + e.message)); btn.disabled = false; btn.textContent = old; }
}
// ---------------------------------------------------------------- live run
const FEE_TYPES = [["inbound_defect_fee", "inbound defect fee"], ["lost_inbound", "lost inbound"], ["damaged_in_warehouse", "damaged in warehouse"], ["refund_issued_item_not_returned", "refund, item not returned"], ["fulfilment_fee_weight_tier", "fulfilment fee (weight tier)"]];
async function livePage(m) {
  m.append(h("h2", {}, "Live Run"), h("p", { class: "sub" }, "Process one unit through every agent with your own data and photos. The run uses the real agents and real Groq model calls."));
  const rcv = receivingForm(), prep = prepForm(), pack = packForm(), ret = returnsForm();
  const route_ = h("select", {},
    h("option", { value: "all" }, "All 5 Agents (Receiving → Prep → Pack → Returns → Recovery)"),
    h("option", { value: "fba" }, "Fulfillment by Amazon (FBA) → Prep"),
    h("option", { value: "mfn" }, "Merchant-fulfilled / 3PL → Pack")
  );
  const wantRet = h("input", { type: "checkbox", checked: true });
  const parBox = h("input", { type: "checkbox", checked: true });
  const step = (n, t, who, ...k) => h("div", { class: "card step" }, h("div", { class: "row", style: "align-items:center" }, h("span", { class: "num" }, n), h("div", {}, h("h3", { style: "margin:0;font-size:18px" }, t), h("div", { class: "mute" }, who))), ...k);
  const prepC = step("02", "Prep: packaging & labelling", "Prep Manager · FBA units", prep.el);
  const packC = step("03", "Pack: open-box check", "Pack Manager · merchant-fulfilled units", pack.el);
  const retC = step("04", "Returns: returned item", "Returns Manager · customer return inspection", ret.el);
  const sync = () => {
    prepC.style.display = (route_.value === "fba" || route_.value === "all") ? "" : "none";
    packC.style.display = (route_.value === "mfn" || route_.value === "all") ? "" : "none";
    retC.style.display = wantRet.checked ? "" : "none";
  };
  route_.onchange = wantRet.onchange = sync;
  sync();
  const feeBox = h("div");
  const addFee = (t = "inbound_defect_fee", a = "3") => {
    const r = h("div", { class: "row", style: "margin-bottom:8px" },
      h("select", {}, FEE_TYPES.map(([v, l]) => h("option", { value: v, selected: v === t }, l))),
      h("input", { type: "number", step: "0.01", value: a }),
      h("span", { class: "fix mute" }, "USD"),
      h("button", { class: "ghost fix", type: "button", onclick: () => r.remove() }, "Remove")
    );
    feeBox.append(r);
  };
  addFee();
  const out = h("div");
  const btn = h("button", { onclick: () => startLive(btn, out, parBox.checked, () => {
    const d = { route: route_.value, receiving: rcv.collect() };
    const fd = new FormData();
    fd.append("stage", "pipeline");
    rcv.dz.files.forEach((x) => fd.append("photos_receiving", x.file));
    if (route_.value === "fba" || route_.value === "all") {
      d.prep = prep.collect();
      prep.dz.files.forEach((x) => fd.append("photos_prep", x.file));
    }
    if (route_.value === "mfn" || route_.value === "all") {
      d.pack = pack.collect();
      pack.dz.files.forEach((x) => fd.append("photos_pack", x.file));
    }
    if (wantRet.checked) {
      d.returns = ret.collect();
      ret.dz.files.forEach((x) => fd.append("photos_returns", x.file));
    }
    d.fees = [...feeBox.children].map((r, i) => ({
      line_id: "FEE-" + (i + 1),
      charge_type: r.querySelector("select").value,
      amount_usd: r.querySelector("input").value
    }));
    fd.append("data", JSON.stringify(d));
    fd.append("roles", JSON.stringify({ receiving: rcv.dz.roles() }));
    return fd;
  }) }, "Start processing");

  m.append(
    step("01", "Receiving: dock inspection", "Receiving Manager", rcv.el),
    h("div", { class: "card" },
      field("Fulfilment route", route_),
      h("label", { class: "chk" }, wantRet, "This unit was returned by a customer (enables Returns Manager)")
    ),
    prepC, packC, retC,
    step("05", "Recovery: fee lines", "Recovery Manager",
      h("p", { class: "mute" }, "The fees charged for this unit. Recovery checks each one against the earlier agents' records. With no fee lines, Recovery has nothing to audit."),
      feeBox,
      h("button", { class: "ghost", type: "button", onclick: () => addFee("lost_inbound", "5") }, "Add fee line")
    ),
    h("label", { class: "chk" }, parBox, "⚡ Run independent agents in parallel (Receiving ∥ Prep/Pack; Returns waits for Pack; Recovery waits for all)"),
    h("div", { class: "row", style: "align-items:center;margin-bottom:20px" },
      h("div", { class: "fix" }, btn),
      h("div", { class: "fix" }, h("button", { class: "ghost", onclick: () => route() }, "Reset")),
      h("span", { class: "mute" }, "Receiving, Pack and Prep take seconds; Returns usually takes longer.")
    ),
    out
  );
}
// ---------------------------------------------------------------- shell + router
const NAV = [
  ["overview", "Overview", "▦"],
  ["live", "Live Run (All Agents)", "▶"],
  ["console-receiving", "1 · Receiving Manager", "📥"],
  ["console-prep", "2 · Prep Manager", "🏷"],
  ["console-pack", "3 · Pack Manager", "📦"],
  ["console-returns", "4 · Returns Manager", "↩"],
  ["recovery", "5 · Recovery Hub", "$"],
  ["orchestration", "Orchestration Graph", "⛭"],
  ["workflows", "Workflows", "☰"],
  ["units", "Units", "◫"],
  ["queue", "Review Queue", "✓"],
  ["evidence", "Evidence Vault", "⛓"],
  ["agents", "Agents Fleet", "✦"],
  ["failures", "Failures", "⚠"],
  ["analytics", "Analytics", "◔"],
  ["system", "Pod / System", "⚙"]
];
const PG = { overview, orchestration: orchestrationPage, live: livePage, workflows, units: unitsPage, queue, recovery: recoveryHub, evidence: evidencePage, agents: agentsPage, failures: failuresPage, analytics: dashboard, system: systemPage };
Object.assign(PG, {
  "console-receiving": stagePage("receiving", "1 · Receiving Manager", "Does the shipment match the purchase order and arrive in acceptable condition? UNCERTAIN is a valid answer.", receivingForm),
  "console-prep": stagePage("prep", "2 · Prep Manager", "Were the packaging and labelling requirements actually met? Only what a photo can show is judged.", prepForm),
  "console-pack": stagePage("pack", "3 · Pack Manager", "Does the open box contain exactly what was ordered? SEAL, STOP & FIX, or UNCERTAIN.", packForm),
  "console-returns": stagePage("returns", "4 · Returns Manager", "Identity, completeness, condition and recommended disposition of a returned item.", returnsForm) }); PG["console-recovery"] = recoveryPage; PG["console-pipeline"] = livePage;
function shell() { const a = $("aside"); a.replaceChildren(h("div", { class: "logo" }, h("b", {}, "CUBE"), h("span", {}, "pod13")), h("small", {}, "Commerce Context · Round 3"), ...NAV.map(([k, l, i]) => h("a", { "data-p": k, href: "#" + k }, h("i", {}, i), l)), h("div", { class: "groq", id: "groqbox" })); }
async function route() {
  charts.splice(0).forEach((c) => c.destroy()); document.querySelectorAll(".overlay").forEach((o) => o.remove());
  const [p, arg] = (location.hash || "#").slice(1).split("/"); const host = $("#main"); const m = h("div"); host.replaceChildren(m); const isLanding = !p; document.body.classList.toggle("landing", isLanding);
  document.querySelectorAll("aside a").forEach((a) => a.classList.toggle("on", a.dataset.p === p));
  try { if (isLanding) landing(m); else await (PG[p] || overview)(m, arg); } catch (e) { m.append(h("div", { class: "note warn" }, "⚠ " + e.message)); }
  if (!isLanding) m.append(h("div", { class: "footbar" }, "LIVE ● connected to the orchestrator API · ", h("span", { id: "wfcount" })));
  api("/api/analytics").then((a) => { const e = $("#wfcount"); if (e) e.textContent = a.kpis.workflows + " workflows tracked"; }).catch(() => {});
}
function promptBackendUrl() {
  const current = getApiBase() || "";
  const next = prompt("Enter your Render Backend API URL (e.g. https://cube-round3-pod-backend.onrender.com or leave blank for local/same-origin):", current);
  if (next !== null) {
    if (next.trim()) {
      localStorage.setItem("CUBE_API_BASE", next.trim().replace(/\/+$/, ""));
    } else {
      localStorage.removeItem("CUBE_API_BASE");
    }
    toast("Backend updated: " + (next.trim() || "same-origin / local"));
    refreshStatus();
    route();
  }
}
async function refreshStatus() {
  const b = $("#groqbox");
  const base = getApiBase();
  try {
    const c = await api("/api/config");
    if (b) {
      b.replaceChildren(
        h("b", {}, c.key_set ? "🟢 Groq connected" : "🔴 Groq key missing"),
        h("div", {}, c.model),
        h("button", {
          class: "ghost",
          style: "margin-top:6px;font-size:11px;padding:3px 8px;width:100%;",
          onclick: promptBackendUrl
        }, base ? "🔗 " + base.replace(/^https?:\/\//, "").slice(0, 20) : "🔗 Backend URL")
      );
    }
  } catch (e) {
    if (b) {
      b.replaceChildren(
        h("b", { style: "color:var(--stop)" }, "⚠ Backend disconnected"),
        h("div", { class: "mute", style: "font-size:11px" }, (base ? base.replace(/^https?:\/\//, "").slice(0, 18) : "local") + ": " + e.message.slice(0, 24)),
        h("button", {
          class: "ghost",
          style: "margin-top:6px;font-size:11px;padding:3px 8px;width:100%;",
          onclick: promptBackendUrl
        }, "🔗 Set Backend URL")
      );
    }
  }
}
shell(); window.addEventListener("hashchange", route); (async () => { try { CAT = await api("/api/catalogue"); } catch {} refreshStatus(); route(); })();
