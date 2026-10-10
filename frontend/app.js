"use strict";
const $ = (s, r = document) => r.querySelector(s);
function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === "class") e.className = v; else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) e.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat(Infinity)) if (k != null && k !== false) e.append(k.nodeType ? k : document.createTextNode(String(k)));
  return e;
}
const badge = (t) => h("span", { class: "badge " + String(t).replace(/[^A-Za-z_]/g, "") + (t === "STOP & FIX" ? " STOP" : "") }, t ?? "—");
const money = (n) => "$" + Number(n || 0).toFixed(2);
const show = (v) => v == null ? "—" : typeof v === "object" ? JSON.stringify(v) : String(v);
function toast(m) { const t = h("div", { class: "toast" }, m); document.body.append(t); setTimeout(() => t.remove(), 4200); }
function getApiBase() {
  if (window.CUBE_API_BASE) return window.CUBE_API_BASE.replace(/\/+$/, "");
  const saved = localStorage.getItem("CUBE_API_BASE");
  if (saved) return saved.replace(/\/+$/, "");
  return "";
}
async function api(path, opts) {
  const base = getApiBase();
  const url = base ? (base + (path.startsWith("/") ? path : "/" + path)) : path;
  const r = await fetch(url, opts); let j = null;
  try { j = await r.json(); } catch {}
  if (!r.ok) throw new Error((j && (j.detail?.toString?.() || j.error)) || r.statusText);
  return j;
}
const SAAS_PALETTE = [
  "#2563eb", "#10b981", "#f59e0b", "#8b5cf6", "#06b6d4", "#ec4899", "#64748b", "#0284c7"
];
const SKY = SAAS_PALETTE;
const VC = { PASS: "#10b981", FAIL: "#ef4444", UNCERTAIN: "#f59e0b" };
const charts = [];
function chart(parent, cfg, tall) {
  const box = h("div", { class: "chart" + (tall ? " tall" : "") }), cv = h("canvas");
  box.append(cv);
  parent.append(box);

  const isDark = document.body.classList.contains("dark");
  const gridColor = isDark ? "rgba(255, 255, 255, 0.06)" : "#f1f5f9";
  const tickColor = isDark ? "#94a3b8" : "#64748b";

  let defaultScales = {};
  if (cfg.type === "bar" || cfg.type === "line") {
    const isHorizontal = cfg.options && cfg.options.indexAxis === "y";
    defaultScales = {
      x: {
        grid: { display: isHorizontal, color: gridColor, drawBorder: false },
        ticks: { font: { family: "'Plus Jakarta Sans', -apple-system, sans-serif", size: 11, weight: 500 }, color: tickColor }
      },
      y: {
        grid: { display: !isHorizontal, color: gridColor, drawBorder: false },
        ticks: { font: { family: "'Plus Jakarta Sans', -apple-system, sans-serif", size: 11, weight: 500 }, color: tickColor, padding: 6 }
      }
    };
  }

  cfg.options = Object.assign({
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: {
        position: "bottom",
        labels: {
          usePointStyle: true,
          pointStyle: "circle",
          boxWidth: 7,
          padding: 14,
          font: { family: "'Plus Jakarta Sans', -apple-system, sans-serif", size: 11, weight: 600 },
          color: tickColor
        }
      },
      tooltip: {
        backgroundColor: "#0f172a",
        titleColor: "#ffffff",
        bodyColor: "#f8fafc",
        padding: 10,
        cornerRadius: 6,
        borderWidth: 1,
        borderColor: "rgba(255, 255, 255, 0.1)",
        bodyFont: { family: "'Plus Jakarta Sans', -apple-system, sans-serif", size: 12 },
        titleFont: { family: "'Plus Jakarta Sans', -apple-system, sans-serif", size: 12, weight: 700 }
      }
    }
  }, cfg.options || {});

  if (cfg.type === "bar" || cfg.type === "line") {
    cfg.options.scales = Object.assign({}, defaultScales, cfg.options.scales || {});
  }

  if (cfg.type === "doughnut" || cfg.type === "pie") {
    cfg.options.cutout = cfg.options.cutout || "68%";
    (cfg.data.datasets || []).forEach(ds => {
      ds.borderRadius = ds.borderRadius || 6;
      ds.borderWidth = ds.borderWidth || 2;
      ds.borderColor = ds.borderColor || "#ffffff";
      ds.hoverOffset = 4;
    });
  }
  charts.push(new Chart(cv, cfg));
  return box;
}
const empty = (p, m = "No data yet — run an agent first.") => p.append(h("p", { class: "mute" }, m));
function doughnut(p, obj, colors, type = "doughnut") {
  const k = Object.keys(obj);
  if (!k.length) return empty(p);
  chart(p, { type, data: { labels: k, datasets: [{ data: k.map((x) => obj[x]), backgroundColor: k.map((x, i) => (colors && colors[x]) || SAAS_PALETTE[i % SAAS_PALETTE.length]) }] } });
}
function bar(p, labels, sets, opts = {}) {
  if (!labels.length) return empty(p);
  chart(p, { type: "bar", data: { labels, datasets: sets.map((s, i) => ({ backgroundColor: SAAS_PALETTE[i % SAAS_PALETTE.length], borderRadius: 6, borderSkipped: false, maxBarThickness: 36, ...s })) }, options: opts }, opts.tall);
}
// ---------------------------------------------------------------- photo drop zone
function dropzone(withRoles) {
  const files = []; const thumbs = h("div", { class: "thumbs" }); const input = h("input", { type: "file", accept: "image/jpeg,image/png,image/webp", multiple: true, style: "display:none" });
  const zone = h("div", { class: "drop" }, "📷 Drop photos here or click to choose (JPEG / PNG / WebP, up to 8)");
  const redraw = () => { thumbs.replaceChildren(...files.map((f, i) => {
    const t = h("div", { class: "thumb" }, h("img", { src: f.url }), h("div", { class: "mute" }, f.file.name.slice(0, 16)),
      h("button", { class: "x", type: "button", onclick: () => { files.splice(i, 1); redraw(); } }, "×"));
    if (withRoles) { const s = h("select", { onchange: (e) => (f.role = e.target.value) }, ["carton", "pallet", "unit", "label", "other"].map((r) => h("option", { value: r, selected: r === f.role }, r))); t.append(s); }
    return t; })); };
  const add = (list) => { for (const file of list) if (/^image\//.test(file.type) && files.length < 8) files.push({ file, url: URL.createObjectURL(file), role: files.length ? (withRoles ? "unit" : "") : (withRoles ? "carton" : "") }); redraw(); };
  zone.onclick = () => input.click(); input.onchange = () => { add(input.files); input.value = ""; };
  zone.ondragover = (e) => { e.preventDefault(); zone.classList.add("over"); }; zone.ondragleave = () => zone.classList.remove("over");
  zone.ondrop = (e) => { e.preventDefault(); zone.classList.remove("over"); add(e.dataTransfer.files); };
  return { el: h("div", {}, zone, input, thumbs), files, roles: () => files.map((f) => f.role) };
}
const field = (label, input) => h("div", { class: "form-field" }, h("label", {}, label), input);
const inp = (v = "", type = "text", ph = "") => h("input", { type, value: v, placeholder: ph });
// ---------------------------------------------------------------- result rendering
const HEAD = { receiving: (e) => ({ v: e.decision.verdict, t: { accept: "ACCEPT", accept_with_exceptions: "EXCEPTION", reject: "REJECT", pending_review: "UNCERTAIN — REVIEW" }[e.decision.outcome] }),
  prep: (e) => ({ v: e.decision.verdict, t: "PREP STATUS: " + ({ compliant: "PASS", non_compliant: "FAIL", pending_review: "UNCERTAIN" }[e.decision.outcome]) }),
  pack: (e) => ({ v: e.decision.verdict, t: e.payload.decision_label || { seal: "SEAL", stop_and_fix: "STOP & FIX", pending_review: "UNCERTAIN" }[e.decision.outcome] }),
  returns: (e) => ({ v: e.decision.verdict, t: "DISPOSITION: " + e.decision.outcome.toUpperCase() }),
  recovery: (e) => ({ v: e.decision.verdict, t: { claim_recommended: "CLAIM RECOMMENDED · " + money(e.payload.claimable_usd), no_claim: "NO CLAIM", insufficient_evidence: "SILENT — insufficient evidence", pending_review: "PENDING" }[e.decision.outcome] }) };
function renderEvidence(e, into) {
  const hd = (HEAD[e.stage] || ((x) => ({ v: x.decision.verdict, t: x.decision.outcome })))(e);
  const conf = e.decision.confidence;
  into.append(h("div", { class: "banner " + hd.v },
    h("div", {},
      h("h3", {}, hd.t),
      h("p", {}, e.decision.reason)
    ),
    h("div", { class: "banner-meta" },
      h("div", {}, "Record ", h("b", {}, e.record_id)),
      h("div", {}, conf != null ? "confidence " + Math.round(conf * 100) + "%" : "confidence n/a"),
      h("div", {}, "model: " + (e.model.name || "—")),
      e.decision.needs_human ? h("div", { style: "color:var(--unc);font-weight:700;margin-top:2px;" }, "👤 Needs Human Review") : null
    )
  ));
  if (e.error) into.append(h("div", { class: "note warn" }, "⚠ " + e.error.code + ": " + e.error.message));

  // Table of checks
  const t = h("table", { class: "evidence-checks-table" },
    h("thead", {},
      h("tr", {}, ["Check", "Verdict", "Expected", "Observed", "Conf.", "Detail / Evidence"].map((x) => h("th", {}, x)))
    ),
    h("tbody", {},
      e.checks.map(c => {
        const chips = c.evidence_refs && c.evidence_refs.length ? h("div", { class: "evidence-chips-row" },
          c.evidence_refs.map(ref => {
            const fname = ref.split("/").pop();
            const clean = fname.length > 20 ? fname.slice(0, 10) + "…" + fname.slice(-8) : fname;
            return h("span", { class: "evidence-chip", title: fname }, "📎 " + clean);
          })
        ) : null;

        return h("tr", {},
          h("td", { class: "check-key-cell" }, c.check_key),
          h("td", {}, badge(c.verdict)),
          h("td", { class: "mono" }, show(c.expected)),
          h("td", { class: "mono" }, show(c.observed)),
          h("td", {}, c.confidence != null ? Math.round(c.confidence * 100) + "%" : "—"),
          h("td", { class: "detail-cell" },
            c.detail || c.uncertain_reason ? h("div", {}, c.detail || c.uncertain_reason) : null,
            chips
          )
        );
      })
    )
  );

  const row = h("div", { class: "evidence-results-grid" });
  const left = h("div", { class: "card", style: "margin:0;" },
    h("h3", {}, "Inspection Results · Expected vs Observed"),
    h("div", { class: "scroll" }, t)
  );

  const mix = {};
  e.checks.forEach((c) => (mix[c.verdict] = (mix[c.verdict] || 0) + 1));
  const passCount = mix.PASS || 0;
  const failCount = mix.FAIL || 0;
  const uncCount = mix.UNCERTAIN || 0;
  const total = passCount + failCount + uncCount;
  const passRate = total > 0 ? Math.round((passCount / total) * 100) : 0;

  const right = h("div", { class: "card verdict-summary-card", style: "margin:0;" },
    h("h3", {}, "Verdict Breakdown"),
    h("div", { class: "verdict-metrics-row" },
      h("div", { class: "verdict-metric-pill pass" },
        h("span", { class: "val" }, passCount),
        h("span", { class: "lbl" }, "PASS")
      ),
      h("div", { class: "verdict-metric-pill fail" },
        h("span", { class: "val" }, failCount),
        h("span", { class: "lbl" }, "FAIL")
      ),
      uncCount > 0 ? h("div", { class: "verdict-metric-pill unc" },
        h("span", { class: "val" }, uncCount),
        h("span", { class: "lbl" }, "REVIEW")
      ) : null,
      h("div", { class: "verdict-metric-pill rate" },
        h("span", { class: "val" }, passRate + "%"),
        h("span", { class: "lbl" }, "PASS RATE")
      )
    ),
    h("div", { class: "verdict-chart-wrap" })
  );

  row.append(left, right);
  into.append(row);

  doughnut(right.querySelector(".verdict-chart-wrap"), mix, VC);

  if (e.stage === "pack" && e.payload.lines) {
    const c = h("div", { class: "card" }, h("h3", {}, "Order vs detected items")); const tb = h("table", {}, h("tr", {}, ["Ordered", "Expected qty", "Observed qty", "Status", "Detail"].map((x) => h("th", {}, x))));
    e.payload.lines.forEach((l) => tb.append(h("tr", {}, h("td", {}, l.name + (l.colour ? " (" + l.colour + ")" : "")), h("td", {}, l.expected_qty), h("td", {}, l.observed_qty ?? "?"), h("td", {}, badge(l.status === "ok" ? "PASS" : l.status === "uncertain" ? "UNCERTAIN" : "FAIL")), h("td", {}, l.detail))));
    e.payload.extra_items.forEach((x) => tb.append(h("tr", {}, h("td", {}, "— not ordered —"), h("td", {}, 0), h("td", {}, x.qty ?? 1), h("td", {}, badge("FAIL")), h("td", {}, "Unexpected extra item: " + x.detected))));
    c.append(tb); const bx = h("div", { class: "grid g2" }); const ch = h("div"); bar(ch, e.payload.lines.map((l) => l.name), [{ label: "Ordered", data: e.payload.lines.map((l) => l.expected_qty) }, { label: "Detected", data: e.payload.lines.map((l) => l.observed_qty || 0) }]);
    bx.append(h("div"), ch); c.append(ch); into.append(c);
  }
  if (e.stage === "receiving" && e.payload.qty_ordered != null) {
    const c = h("div", { class: "card" }, h("h3", {}, "Quantity: ordered vs received")); bar(c, ["Units"], [{ label: "Ordered", data: [e.payload.qty_ordered] }, { label: "Received", data: [e.payload.qty_received ?? 0] }]); into.append(c);
  }
  if (e.stage === "returns" && e.payload.components?.length) {
    const c = h("div", { class: "card" }, h("h3", {}, "Accessories & condition"), h("p", {}, "Condition: ", h("b", {}, e.payload.condition_grade || "UNCERTAIN"), " · rule ", h("span", { class: "mono" }, e.payload.rule_id || "")));
    const tb = h("table", {}, h("tr", {}, ["Part", "Status", "Essential"].map((x) => h("th", {}, x)))); e.payload.components.forEach((p) => tb.append(h("tr", {}, h("td", {}, p.part || p.name), h("td", {}, badge(p.status === "PRESENT" ? "PASS" : p.status === "ABSENT" ? "FAIL" : "UNCERTAIN"), " " + (p.status || "")), h("td", {}, p.essential ? "yes" : "no")))); c.append(tb); into.append(c);
  }
  if (e.stage === "prep" && (e.payload.not_verifiable || []).length) into.append(h("div", { class: "note warn" }, "Cannot be verified from a photo (not guessed): " + e.payload.not_verifiable.map((x) => x.name || x.check_id || x).join(", "), e.payload.retake?.length ? " · Retake: " + e.payload.retake.join(" ") : ""));
  if (e.stage === "recovery") renderCharges(e, into);
  if (e.inputs?.length) { const th = h("div", { class: "thumbs mono" }, e.inputs.map((i) => h("div", { class: "thumb" }, i.ref.split("/").pop(), h("div", { class: "mute" }, "sha " + (i.sha256 || "—").slice(0, 10))))); into.append(h("div", { class: "card" }, h("h3", {}, "Evidence record · photos hashed (sha256)"), th, h("p", { class: "mono mute" }, "content_hash " + (e.content_hash || "").slice(0, 24) + "… · produced " + e.produced_at))); }
  into.append(h("details", {}, h("summary", {}, "Full structured evidence record (JSON)"), h("pre", {}, JSON.stringify(e, null, 2))));
}
function renderCharges(e, into) {
  const ch = e.payload.charges || []; const c = h("div", { class: "card" }, h("h3", {}, "Parsed charges & assessment · claimable " + money(e.payload.claimable_usd)));
  const tb = h("table", {}, h("tr", {}, ["Charge", "Type", "Amount", "Assessment", "Claim", "Why / evidence"].map((x) => h("th", {}, x))));
  ch.forEach((x) => tb.append(h("tr", {}, h("td", { class: "mono" }, x.line_id), h("td", {}, x.charge_type), h("td", {}, money(x.amount_usd)), h("td", {}, badge(x.position)),
    h("td", {}, x.position === "CONTRADICTS" ? h("b", {}, money(x.claim_amount_usd)) : "NOT SUPPORTED"), h("td", {}, x.explanation || x.reason, x.evidence_record_ids?.length ? h("div", { class: "mono mute" }, "📎 " + x.evidence_record_ids.join(", ")) : null))));
  c.append(tb); if (e.payload.narrative) c.append(h("p", { class: "mute" }, "Explanations written by: " + (e.payload.narrative.source === "groq" ? "Groq (" + e.payload.narrative.model + ")" : "template") + ". Verdicts and amounts come from the rules engine only."));
  into.append(c); const g = h("div", { class: "grid g2" }); const a = h("div", { class: "card" }, h("h3", {}, "Charge amounts by assessment")), b = h("div", { class: "card" }, h("h3", {}, "Assessment mix"));
  const sums = {}, cnt = {}; ch.forEach((x) => { sums[x.position] = (sums[x.position] || 0) + x.amount_usd; cnt[x.position] = (cnt[x.position] || 0) + 1; });
  const pc = { SUPPORTS: "#10b981", CONTRADICTS: "#ef4444", SILENT: "#f59e0b" }; doughnut(a, sums, pc, "pie"); doughnut(b, cnt, pc); g.append(a, b); into.append(g);
}
function renderBundle(res, into) {
  into.replaceChildren(); const order = ["receiving", "prep", "pack", "returns", "recovery"];
  const evs = Object.values(res.evidence).sort((a, b) => order.indexOf(a.stage) - order.indexOf(b.stage));
  const fo = res.workflow.final_outcome;
  if (evs.length > 1 && fo) into.append(h("div", { class: "card" }, h("h3", {}, "Final commerce outcome"), badge(fo.outcome), " ", h("span", {}, fo.reason), h("div", { class: "mute mono" }, "workflow " + res.workflow.workflow_id + " · status " + res.workflow.status)));
  for (const e of evs) { into.append(h("h3", { style: "color:var(--ink);margin:18px 0 8px" }, "Stage: " + e.stage)); renderEvidence(e, into); }
  into.scrollIntoView({ behavior: "smooth" });
}
async function submitLab(btn, out, build) {
  btn.disabled = true; const old = btn.textContent; btn.replaceChildren(h("span", { class: "spin" }), "Agent is inspecting…");
  try { const fd = build(); const res = await api("/api/lab/run", { method: "POST", body: fd }); renderBundle(res, out); refreshStatus(); }
  catch (e) { out.replaceChildren(h("div", { class: "note warn" }, "⚠ " + e.message)); } finally { btn.disabled = false; btn.textContent = old; }
}
// ---------------------------------------------------------------- stage forms
let CAT = [];
const RECEIVING_PRODUCTS = [
  { sku: "SKU-BOTTLE-750", title: "Insulated Water Bottle", supplier: "Supplier East", colour: "blue", variant: "750ml", comps: "bottle;lid", cartons: 1, per: 24 },
  { sku: "SKU-BOTTLE-500", title: "Water bottle 500 ml", supplier: "Supplier East", colour: "blue", variant: "500ml", comps: "bottle;lid", cartons: 2, per: 12 },
  { sku: "SKU-CABLE-USBC", title: "USB-C Fast Charging Cable", supplier: "Supplier North", colour: "white", variant: "2m", comps: "cable", cartons: 2, per: 24 },
  { sku: "SKU-CABLE-USBA", title: "USB-A to USB-C cable", supplier: "Supplier North", colour: "black", variant: "1m", comps: "cable", cartons: 2, per: 24 },
  { sku: "SKU-LAMP-LED", title: "LED Desk Lamp", supplier: "Supplier Coastal", colour: "grey", variant: "standard", comps: "lamp;usb cable;manual", cartons: 2, per: 12 },
  { sku: "SKU-TOWEL-BLU", title: "Cotton Bath Towel", supplier: "Supplier East", colour: "blue", variant: "bath", comps: "towel", cartons: 1, per: 24 },
  { sku: "SKU-TOWEL-GRN", title: "Bath towel, green", supplier: "Supplier East", colour: "green", variant: "bath", comps: "towel", cartons: 1, per: 24 },
  { sku: "SKU-CANDLE-3", title: "Soy Candle Trio Gift Box", supplier: "Supplier Coastal", colour: "cream", variant: "3-pack", comps: "candle x3;gift box", cartons: 2, per: 12 },
  { sku: "SKU-PUZZLE-500", title: "500-piece jigsaw puzzle", supplier: "Supplier Coastal", colour: "n/a", variant: "500pc", comps: "puzzle pieces;poster", cartons: 4, per: 12 },
  { sku: "SKU-PUZZLE-1000", title: "1000-piece jigsaw puzzle", supplier: "Supplier Coastal", colour: "n/a", variant: "1000pc", comps: "puzzle pieces;poster", cartons: 2, per: 12 },
  { sku: "SKU-PROT-1KG", title: "Whey Protein Powder 1 kg", supplier: "Supplier East", colour: "n/a", variant: "1kg vanilla", comps: "tub;scoop", cartons: 2, per: 24 },
  { sku: "SKU-LEASH-6FT", title: "Nylon Dog Leash 6 ft", supplier: "Supplier Coastal", colour: "red", variant: "6ft", comps: "leash", cartons: 1, per: 12 },
  { sku: "SKU-MUG-11", title: "Ceramic Mug 11 oz (Set of 2)", supplier: "Supplier East", colour: "white", variant: "11oz", comps: "mug x2", cartons: 2, per: 12 },
  { sku: "SKU-HEADPHONES-BT", title: "Wireless Over-Ear Headphones", supplier: "Supplier North", colour: "black", variant: "over-ear", comps: "headphones;carrying case;usb cable;manual", cartons: 1, per: 12 },
  { sku: "SKU-EARBUDS-TWS", title: "True Wireless Earbuds with Case", supplier: "Supplier North", colour: "white", variant: "in-ear", comps: "earbuds (pair of 2);charging case", cartons: 2, per: 24 },
  { sku: "SKU-EARPHONES-WIRED", title: "Wired in-ear earphones with remote", supplier: "Supplier North", colour: "white", variant: "wired", comps: "earphones", cartons: 2, per: 24 },
  { sku: "SKU-CHARGER-A", title: "Phone charger A (Samsung)", supplier: "Supplier East", colour: "white", variant: "standard", comps: "adapter;cable", cartons: 2, per: 24 },
  { sku: "SKU-CHARGER-B", title: "Phone charger B (OPPO)", supplier: "Supplier East", colour: "white", variant: "standard", comps: "adapter;cable", cartons: 2, per: 24 },
  { sku: "SKU-SERUM-30", title: "Face Serum 30 ml", supplier: "Supplier Coastal", colour: "amber", variant: "30ml", comps: "bottle;dropper;leaflet", cartons: 2, per: 24 },
  { sku: "SKU-FACEMASK-JAR", title: "Face Mask in a Jar", supplier: "Supplier Coastal", colour: "white", variant: "100ml", comps: "jar;lid", cartons: 1, per: 24 },
  { sku: "SKU-TONER", title: "Face toner bottle", supplier: "Supplier Coastal", colour: "clear", variant: "200ml", comps: "bottle;cap", cartons: 1, per: 24 },
  { sku: "SKU-CLAWCLIP", title: "Hair claw clip", supplier: "Supplier Coastal", colour: "black", variant: "clip", comps: "clip", cartons: 2, per: 24 },
  { sku: "SKU-COMB", title: "Hair comb", supplier: "Supplier Coastal", colour: "black", variant: "comb", comps: "comb", cartons: 2, per: 24 },
  { sku: "SKU-PERFUME", title: "Perfume bottle with cap", supplier: "Supplier Coastal", colour: "clear", variant: "spray", comps: "perfume bottle;cap", cartons: 2, per: 12 },
  { sku: "SKU-POUCH-BLK", title: "Black pouch", supplier: "Supplier Coastal", colour: "black", variant: "zip", comps: "pouch", cartons: 2, per: 24 },
  { sku: "SKU-SOFTTOY", title: "Soft toy plush", supplier: "Supplier East", colour: "brown", variant: "plush", comps: "soft toy", cartons: 1, per: 12 },
  { sku: "SKU-VASE", title: "Flower vase", supplier: "Supplier Coastal", colour: "ceramic", variant: "single", comps: "vase", cartons: 1, per: 12 },
  { sku: "SKU-WATERBOTTLE-FLIP", title: "Water bottle with flip lid", supplier: "Supplier East", colour: "teal", variant: "gradient", comps: "bottle;lid", cartons: 2, per: 12 }
];

function receivingForm() {
  const prods = [...RECEIVING_PRODUCTS];
  if (Array.isArray(CAT)) {
    for (const c of CAT) {
      if (!prods.some((p) => p.sku === c.sku)) {
        prods.push({
          sku: c.sku,
          title: c.title,
          supplier: "Supplier East",
          colour: "n/a",
          variant: "",
          comps: (c.parts || []).join(";"),
          cartons: 1,
          per: 24
        });
      }
    }
  }

  const pSel = h("select", { style: "font-weight:600;color:var(--ink)" },
    h("option", { value: "SKU-BOTTLE-750" }, "Insulated Water Bottle (SKU-BOTTLE-750)"),
    prods.filter((p) => p.sku !== "SKU-BOTTLE-750").map((p) => h("option", { value: p.sku }, `${p.title} (${p.sku})`)),
    h("option", { value: "custom" }, "— Custom / Manual entry —")
  );

  const init = prods[0];
  const f = {
    sku: inp(init.sku),
    title: inp(init.title),
    supplier: inp(init.supplier),
    colour: inp(init.colour),
    variant: inp(init.variant),
    comps: inp(init.comps),
    cartons: inp(init.cartons, "number"),
    per: inp(init.per, "number"),
    qty: inp(init.cartons * init.per, "number"),
    cc: inp("", "number", "optional"),
    uc: inp("", "number", "optional")
  };

  const applyProduct = (sku) => {
    const p = prods.find((x) => x.sku === sku);
    if (!p) return;
    f.sku.value = p.sku;
    f.title.value = p.title;
    f.supplier.value = p.supplier || "Supplier East";
    f.colour.value = p.colour || "n/a";
    f.variant.value = p.variant || "";
    f.comps.value = p.comps || "";
    f.cartons.value = p.cartons || 1;
    f.per.value = p.per || 24;
    f.qty.value = (p.cartons || 1) * (p.per || 24);
  };

  pSel.onchange = () => {
    if (pSel.value === "custom") return;
    applyProduct(pSel.value);
  };

  const calcQty = () => {
    const c = parseInt(f.cartons.value) || 0;
    const p = parseInt(f.per.value) || 0;
    if (c > 0 && p > 0) f.qty.value = c * p;
  };
  f.cartons.addEventListener("input", calcQty);
  f.per.addEventListener("input", calcQty);

  const dz = dropzone(true);
  const el = h("div", { style: "display:flex;flex-direction:column;gap:16px;" },
    h("div", { class: "agent-section-card" },
      h("h3", {}, h("span", { class: "icon" }, "📦"), "Inbound Product & Purchase Order Specifications"),
      h("div", { style: "margin-bottom:14px;" },
        field("Select catalog product (auto-populates SKU, specifications & order quantities)", pSel)
      ),
      h("div", { class: "form-grid g3" },
        field("SKU", f.sku),
        field("Product title", f.title),
        field("Supplier", f.supplier),
        field("Expected colour (n/a if none)", f.colour),
        field("Expected variant", f.variant),
        field("Components (; separated)", f.comps),
        field("Cartons ordered", f.cartons),
        field("Units per carton", f.per),
        field("Expected quantity", f.qty)
      )
    ),
    h("div", { class: "agent-section-card" },
      h("h3", {}, h("span", { class: "icon" }, "🔢"), "Physical Count Verification (Optional)"),
      h("div", { class: "form-grid g2" },
        field("Operator-counted cartons", f.cc),
        field("Operator-counted units per carton", f.uc)
      )
    ),
    h("div", { class: "agent-section-card" },
      h("h3", {}, h("span", { class: "icon" }, "📷"), "Dock Photographic Evidence"),
      h("p", { class: "mute", style: "margin:0 0 10px;font-size:12.5px;" }, "Attach photos of cartons, pallets, and labels. Specify each photo's role."),
      dz.el
    )
  );

  const collect = () => ({
    po: {
      sku: f.sku.value,
      product_title: f.title.value,
      supplier: f.supplier.value,
      spec_colour: f.colour.value || "n/a",
      spec_variant: f.variant.value,
      spec_components: f.comps.value,
      cartons_ordered: f.cartons.value,
      units_per_carton_ordered: f.per.value,
      qty_ordered: f.qty.value
    },
    counts: {
      cartons_received: f.cc.value,
      units_per_carton_counted: f.uc.value
    }
  });

  return { el, dz, collect };
}


function createToggleRow(title, desc, input) {
  const row = h("label", { class: "toggle-row" },
    h("div", { class: "toggle-info" },
      h("div", { class: "toggle-title" }, title),
      h("div", { class: "toggle-desc" }, desc)
    ),
    h("div", { class: "switch" },
      input,
      h("span", { class: "switch-slider" })
    )
  );
  return row;
}

function prepForm() {
  const PREP_PRODUCTS = [
    { sku: "SKU-CANDLE-3", fnsku: "X00DUMMY002", title: "Soy Candle Trio Gift Box", poly: true, suf: true, exp: false, marks: ["Fragile"] },
    { sku: "SKU-LAMP-LED", fnsku: "X00DUMMY357", title: "LED Desk Lamp with USB", poly: true, suf: false, exp: false, marks: ["Fragile"] },
    { sku: "SKU-BOTTLE-750", fnsku: "X00DUMMY622", title: "Insulated Water Bottle 750ml", poly: true, suf: true, exp: false, marks: [] },
    { sku: "SKU-TOWEL-BLU", fnsku: "X00DUMMY600", title: "Cotton Bath Towel", poly: true, suf: true, exp: false, marks: [] },
    { sku: "SKU-PROT-1KG", fnsku: "X00DUMMY1KG", title: "Whey Protein Powder 1kg", poly: false, suf: false, exp: true, marks: [] },
    { sku: "SKU-SERUM-30", fnsku: "X00DUMMYSRM", title: "Face Serum 30ml (Glass Dropper)", poly: true, suf: true, exp: true, marks: ["Liquid", "Glass"] },
    { sku: "SKU-CABLE-USBC", fnsku: "X00DUMMY261", title: "USB-C Cable 2m", poly: true, suf: true, exp: false, marks: [] }
  ];

  const pSel = h("select", { style: "font-weight:600;color:var(--ink)" },
    h("option", { value: "SKU-CANDLE-3" }, "Soy Candle Trio Gift Box (SKU-CANDLE-3)"),
    PREP_PRODUCTS.filter(p => p.sku !== "SKU-CANDLE-3").map(p => h("option", { value: p.sku }, `${p.title} (${p.sku})`)),
    h("option", { value: "custom" }, "— Custom / Manual entry —")
  );

  const init = PREP_PRODUCTS[0];
  const f = {
    sku: inp(init.sku),
    fnsku: inp(init.fnsku),
    poly: h("input", { type: "checkbox", checked: init.poly }),
    suf: h("input", { type: "checkbox", checked: init.suf }),
    exp: h("input", { type: "checkbox", checked: init.exp })
  };
  const markDefs = ["Fragile", "This Way Up", "Liquid", "Glass", "Keep Dry", "Heavy"];
  const marks = markDefs.map((m) => h("input", { type: "checkbox", value: m, checked: init.marks.includes(m), style: "display:none;" }));

  // Interactive Chip Toggles
  const chipElements = markDefs.map((m, i) => {
    const isAct = init.marks.includes(m);
    const chip = h("button", {
      type: "button",
      class: "chip-toggle" + (isAct ? " active" : ""),
      onclick: () => {
        marks[i].checked = !marks[i].checked;
        chip.classList.toggle("active", marks[i].checked);
        const icon = chip.querySelector(".chip-icon");
        if (icon) icon.textContent = marks[i].checked ? "✓" : "+";
      }
    },
      h("span", { class: "chip-icon" }, isAct ? "✓" : "+"),
      m
    );
    return chip;
  });

  pSel.onchange = () => {
    if (pSel.value === "custom") return;
    const p = PREP_PRODUCTS.find(x => x.sku === pSel.value);
    if (!p) return;
    f.sku.value = p.sku;
    f.fnsku.value = p.fnsku;
    f.poly.checked = p.poly;
    f.suf.checked = p.suf;
    f.exp.checked = p.exp;
    markDefs.forEach((m, i) => {
      const active = p.marks.includes(m);
      marks[i].checked = active;
      chipElements[i].classList.toggle("active", active);
      const icon = chipElements[i].querySelector(".chip-icon");
      if (icon) icon.textContent = active ? "✓" : "+";
    });
  };

  const dz = dropzone(false);
  const el = h("div", { style: "display:flex;flex-direction:column;gap:16px;" },
    h("div", { class: "agent-section-card" },
      h("h3", {},
        h("span", { class: "icon" }, "🏷"),
        "FBA Work Order & Item Specification"
      ),
      h("div", { style: "margin-bottom:14px;" },
        field("Select catalog product (auto-populates SKU, expected FNSKU & requirements)", pSel)
      ),
      h("div", { class: "form-grid g2" },
        field("SKU", f.sku),
        field("Expected FNSKU (label text)", f.fnsku)
      )
    ),
    h("div", { class: "agent-section-card" },
      h("h3", {},
        h("span", { class: "icon" }, "🛡"),
        "Amazon FBA Packaging Requirements"
      ),
      h("div", { class: "toggle-card-group" },
        createToggleRow("Poly Bag Required", "Transparent, fully sealed barrier around item", f.poly),
        createToggleRow("Suffocation Warning Required", "Mandatory label for bag openings >= 5 inches", f.suf),
        createToggleRow("Expiration Date Visible", "Must remain clearly scannable and unobstructed", f.exp)
      ),
      h("div", { style: "margin-top:14px;margin-bottom:6px;" },
        h("label", { style: "font-size:12px;font-weight:600;color:var(--ink);" }, "Required Handling Marks")
      ),
      h("div", { class: "chip-group" },
        ...chipElements
      ),
      h("div", { class: "note" },
        h("div", { class: "note-title" },
          h("span", { style: "color:var(--cyan);font-weight:800;" }, "✦"),
          "AI Visual Prep Inspection Rules (fba@1 rules engine)"
        ),
        h("ul", {},
          h("li", {}, h("b", {}, "Polybag:"), " Verified present and fully sealed against contaminants."),
          h("li", {}, h("b", {}, "Suffocation Warning:"), " Verified visible, legible, and proportionate to bag size."),
          h("li", {}, h("b", {}, "FNSKU Placement:"), " Verified on a flat scannable surface (fails across seams/curved edges)."),
          h("li", {}, h("b", {}, "Original Barcodes:"), " Pre-existing manufacturer barcode verified covered."),
          h("li", {}, h("b", {}, "Physical Thickness:"), " Recognized as non-verifiable from images (never guessed or hallucinated).")
        )
      )
    ),
    h("div", { class: "agent-section-card" },
      h("h3", {},
        h("span", { class: "icon" }, "📷"),
        "Prepared Unit Photographs"
      ),
      h("p", { class: "mute", style: "margin:0 0 10px;font-size:12.5px;" }, "Upload photos of the prepared unit (front, back, label, warnings, seam)."),
      dz.el
    )
  );

  const collect = () => ({
    work_order: {
      sku: f.sku.value,
      fnsku: f.fnsku.value,
      polybag: f.poly.checked,
      suffocation_warning: f.suf.checked,
      has_expiry: f.exp.checked,
      handling_marks: marks.filter((m) => m.checked).map((m) => m.value)
    }
  });
  return { el, dz, collect };
}

function packForm() {
  const lines = h("div", { class: "lines" });
  const dz = dropzone(false);
  const addLine = (n = "", c = "", v = "", q = 1) => {
    const r = h("div", { class: "row", style: "margin-bottom:8px;" },
      inp(n, "text", "Product e.g. T-Shirt"),
      inp(c, "text", "Colour"),
      inp(v, "text", "Size / variant"),
      h("input", { type: "number", value: q, min: 1, style: "max-width:80px" }),
      h("button", { class: "ghost fix", type: "button", onclick: () => r.remove() }, "✕")
    );
    lines.append(r);
  };
  addLine("T-Shirt", "black", "", 2);
  addLine("Cap", "blue", "", 1);

  const el = h("div", { style: "display:flex;flex-direction:column;gap:16px;" },
    h("div", { class: "agent-section-card" },
      h("h3", {}, h("span", { class: "icon" }, "📦"), "Customer Order Manifest & Expected Item Census"),
      h("p", { class: "mute", style: "margin:0 0 12px;font-size:12.5px;" }, "Specify the item lines expected inside the shipping container."),
      lines,
      h("div", { style: "margin-top:10px;" },
        h("button", { class: "ghost", type: "button", onclick: () => addLine() }, "+ Add Item Line")
      )
    ),
    h("div", { class: "agent-section-card" },
      h("h3", {}, h("span", { class: "icon" }, "📷"), "Open Package Inspection Captures"),
      h("p", { class: "mute", style: "margin:0 0 10px;font-size:12.5px;" }, "Attach top-down photos of the open box showing all items before taping/sealing."),
      dz.el
    )
  );

  const collect = () => ({
    order: [...lines.children].map((r) => {
      const i = r.querySelectorAll("input");
      return { name: i[0].value, colour: i[1].value, variant: i[2].value, quantity: i[3].value };
    }).filter((l) => l.name.trim())
  });
  return { el, dz, collect };
}

function returnsForm() {
  const RET_PRESETS = [
    { sku: "SKU-HEADPHONES-BT", title: "Wireless Over-Ear Headphones", parts: "headphones;carrying case;usb cable;manual", desc: "Black over-ear wireless headphones with fold-flat earcups" },
    { sku: "SKU-EARBUDS-TWS", title: "True Wireless Earbuds with Case", parts: "earbuds (pair of 2);charging case", desc: "Two white wireless in-ear earbuds in a pill-shaped flip-lid charging case" },
    { sku: "SKU-LAMP-LED", title: "LED Desk Lamp", parts: "lamp;usb cable;manual", desc: "Small grey LED desk lamp with flexible neck and power cord" },
    { sku: "SKU-BOTTLE-750", title: "Water Bottle 750ml", parts: "bottle;lid", desc: "Reusable steel 750ml bottle with screw-on lid" },
    { sku: "SKU-PUZZLE-1000", title: "1000-Piece Jigsaw Puzzle", parts: "puzzle pieces;poster", desc: "Cardboard box containing jigsaw puzzle pieces and fold-out guide poster" },
    { sku: "SKU-CHARGER-A", title: "Phone Charger A (Samsung)", parts: "adapter;cable", desc: "White wall charging adapter with detachable USB-C cable" }
  ];

  const sel = h("select", { style: "font-weight:600;color:var(--ink)" },
    h("option", { value: "SKU-HEADPHONES-BT" }, "Wireless Over-Ear Headphones (SKU-HEADPHONES-BT)"),
    RET_PRESETS.filter(p => p.sku !== "SKU-HEADPHONES-BT").map(p => h("option", { value: p.sku }, `${p.title} (${p.sku})`)),
    Array.isArray(CAT) ? CAT.filter(c => !RET_PRESETS.some(p => p.sku === c.sku)).map(c => h("option", { value: c.sku }, `${c.title} (${c.sku})`)) : [],
    h("option", { value: "custom" }, "— Custom / Manual Entry —")
  );

  const init = RET_PRESETS[0];
  const title = inp(init.title), parts = inp(init.parts), desc = inp(init.desc, "text", "optional: what it looks like");
  const dz = dropzone(false);
  const info = h("p", { class: "mute", style: "margin:4px 0 10px;font-size:12px;" }, "Expected components: " + init.parts.split(";").join(", "));

  sel.onchange = () => {
    if (sel.value === "custom") {
      title.disabled = parts.disabled = desc.disabled = false;
      info.textContent = "Enter custom product requirements manually.";
      return;
    }
    const p = RET_PRESETS.find(x => x.sku === sel.value) || (Array.isArray(CAT) ? CAT.find(x => x.sku === sel.value) : null);
    if (p) {
      title.value = p.title;
      parts.value = Array.isArray(p.parts) ? p.parts.join(";") : (p.parts || "");
      desc.value = p.visual_description || p.desc || "";
      info.textContent = "Expected components: " + parts.value.split(";").join(", ");
    }
  };

  const el = h("div", { style: "display:flex;flex-direction:column;gap:16px;" },
    h("div", { class: "agent-section-card" },
      h("h3", {}, h("span", { class: "icon" }, "↩"), "Customer Return Catalog Signature"),
      h("div", { style: "margin-bottom:14px;" },
        field("Select product ordered (defines expected product signature & components)", sel)
      ),
      h("div", { class: "form-grid g3" },
        field("Product title", title),
        field("Expected components & accessories (;)", parts),
        field("Visual description", desc)
      ),
      info
    ),
    h("div", { class: "agent-section-card" },
      h("h3", {}, h("span", { class: "icon" }, "🔍"), "Amazon Condition Grading & Disposition Standards"),
      h("div", { class: "note" },
        h("b", {}, "Amazon Returns Multi-Modal Inspection Scale:"),
        h("ul", { style: "margin:6px 0 0;padding-left:18px;font-size:12px;line-height:1.6;" },
          h("li", {}, h("b", {}, "Identity:"), " Verifies physical item matches catalog signature (flags swap fraud)."),
          h("li", {}, h("b", {}, "Completeness:"), " Audits essential cables, adaptors, and accessories."),
          h("li", {}, h("b", {}, "Condition Scale:"), " New, Used - Like New, Used - Very Good, Used - Good, Used - Acceptable, Unacceptable."),
          h("li", {}, h("b", {}, "Disposition:"),
            " ", h("span", { class: "badge PASS" }, "RESTOCK"),
            " · ", h("span", { class: "badge refurbish" }, "REFURBISH"),
            " · ", h("span", { class: "badge liquidate" }, "LIQUIDATE"),
            " · ", h("span", { class: "badge FAIL" }, "DISPOSE")
          )
        )
      )
    ),
    h("div", { class: "agent-section-card" },
      h("h3", {}, h("span", { class: "icon" }, "📷"), "Returned Item & Packaging Photographs"),
      h("p", { class: "mute", style: "margin:0 0 10px;font-size:12.5px;" }, "Upload photos showing returned product condition, accessories, and packaging."),
      dz.el
    )
  );

  const collect = () => sel.value && sel.value !== "custom" ? { product: { sku: sel.value, title: title.value, parts: parts.value.split(";"), visual_description: desc.value } } : { product: { title: title.value, parts: parts.value.split(";"), visual_description: desc.value } };
  return { el, dz, collect };
}

function stagePage(stage, label, sub, mk) {
  return async (m) => {
    const header = h("div", { class: "page-header-strip" },
      h("div", { class: "page-header-title-box" },
        h("div", { style: "font-family:var(--font-mono);font-size:11px;color:var(--mute);margin-bottom:4px;text-transform:uppercase;letter-spacing:0.05em;" },
          "Agent Console · " + stage.toUpperCase()
        ),
        h("h2", {}, label),
        h("p", { class: "sub" }, sub)
      ),
      h("div", { class: "header-action-group" },
        h("span", { class: "badge PASS" }, "● ONLINE · Groq Vision"),
        h("a", { class: "btn ghost", href: "#live" }, "All-Agents Pipeline →")
      )
    );

    const f = mk();
    const out = h("div", { class: "output-dossier-card" },
      h("div", { class: "empty-dossier-state" },
        h("span", { class: "empty-dossier-icon" }, "🔍"),
        h("b", { style: "display:block;margin-bottom:4px;color:var(--ink);" }, "Inspection Output Dossier"),
        h("p", { class: "mute", style: "margin:0;font-size:12.5px;" },
          "Configure the work order specifications and attach photographic evidence, then trigger the inspection."
        )
      )
    );

    const btn = h("button", {
      class: "btn-primary-prominent",
      onclick: () => submitLab(btn, out, () => {
        const fd = new FormData();
        fd.append("stage", stage);
        fd.append("data", JSON.stringify(f.collect()));
        fd.append("roles", JSON.stringify(f.dz.roles()));
        f.dz.files.forEach((x) => fd.append("photos", x.file));
        return fd;
      })
    }, "▶ Run " + label + " Inspection");

    const leftCol = h("div", { class: "agent-column-form" },
      f.el,
      h("div", { class: "agent-section-card" },
        h("h3", {}, "Execution Controls"),
        btn
      )
    );

    const rightCol = h("div", { class: "agent-column-results" }, out);
    const workspace = h("div", { class: "agent-workspace-grid" }, leftCol, rightCol);

    const historyCard = h("div", { class: "card", style: "margin-top:24px;" },
      h("h3", {}, "Historical Outcomes: " + label + " Across All Workflows")
    );
    const historyDoughnut = h("div", { id: "history-doughnut-box-" + stage });
    historyCard.append(historyDoughnut);

    m.append(header, workspace, historyCard);

    try {
      const an = await api("/api/analytics");
      doughnut(historyDoughnut, an.stage_outcomes[stage] || {});
    } catch {}
  };
}

const EX = "Charge ID: 48291\nShipment: SHP-10291\nReason: Packaging defect\nAmount: $38\n\nCharge ID: 48292\nShipment: SHP-10291\nReason: Weight tier fee\nAmount: $4.75";

async function recoveryPage(m, embedded) {
  const header = !embedded ? h("div", { class: "page-header-strip" },
    h("div", { class: "page-header-title-box" },
      h("div", { style: "font-family:var(--font-mono);font-size:11px;color:var(--mute);margin-bottom:4px;text-transform:uppercase;letter-spacing:0.05em;" },
        "Agent Console · RECOVERY"
      ),
      h("h2", {}, "5 · Recovery Manager"),
      h("p", { class: "sub" }, "Parse fee and reimbursement ledgers and cross-reference each charge against immutable evidence from upstream managers.")
    ),
    h("div", { class: "header-action-group" },
      h("span", { class: "badge PASS" }, "● Defensible Claims Engine"),
      h("a", { class: "btn ghost", href: "#recovery" }, "Recovery Hub →")
    )
  ) : null;

  const an = await api("/api/analytics");
  const wfs = an.recent.filter((r) => r.stages.length);
  const sel = h("select", {},
    h("option", { value: "" }, "No upstream evidence (all charges will evaluate as SILENT)"),
    wfs.map((w) => h("option", { value: w.workflow_id }, `${w.unit_id} · ${w.outcome || w.status} · ${w.stages.join(" → ")}`))
  );

  const ta = h("textarea", { style: "min-height:160px;" });
  ta.value = EX;
  const out = h("div", { class: "output-dossier-card" },
    h("div", { class: "empty-dossier-state" },
      h("span", { class: "empty-dossier-icon" }, "💳"),
      h("b", { style: "display:block;margin-bottom:4px;color:var(--ink);" }, "Fee Audit & Claim Dossier"),
      h("p", { class: "mute", style: "margin:0;font-size:12.5px;" }, "Select an evidence source and input fee lines, then run the claim analysis.")
    )
  );

  const run = h("button", {
    class: "btn-primary-prominent",
    onclick: async () => {
      run.disabled = true;
      run.innerHTML = '<span class="spin"></span> Auditing Charges…';
      try {
        const r = await api("/api/lab/recovery", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ report: ta.value, workflow_id: sel.value })
        });
        out.replaceChildren();
        out.append(
          h("div", { class: "note", style: "margin-bottom:14px;" },
            `Audited ${r.parsed_charges.length} charge(s) against evidence: ${r.evidence_used.join(", ") || "none"}`
          )
        );
        renderEvidence(r.output.evidence, out);
      } catch (e) {
        out.replaceChildren(h("div", { class: "note warn" }, "⚠ " + e.message));
      } finally {
        run.disabled = false;
        run.textContent = "▶ Analyze Charges & Audit Claims";
      }
    }
  }, "▶ Analyze Charges & Audit Claims");

  const leftCol = h("div", { class: "agent-column-form" },
    h("div", { class: "agent-section-card" },
      h("h3", {}, h("span", { class: "icon" }, "🔗"), "Upstream Evidence Source"),
      field("Completed workflow evidence record", sel)
    ),
    h("div", { class: "agent-section-card" },
      h("div", { style: "display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;" },
        h("h3", { style: "margin:0;" }, h("span", { class: "icon" }, "📄"), "Fee & Reimbursement Report"),
        h("button", { class: "ghost", style: "height:28px;padding:0 8px;font-size:11px;", onclick: () => (ta.value = EX) }, "Load Example")
      ),
      h("p", { class: "mute", style: "margin:0 0 8px;font-size:12px;" }, "Paste charge report lines (supports CSV, JSON, or Key: Value blocks)."),
      ta
    ),
    h("div", { class: "agent-section-card" },
      h("h3", {}, "Execution Controls"),
      run
    )
  );

  const rightCol = h("div", { class: "agent-column-results" }, out);
  const workspace = h("div", { class: "agent-workspace-grid" }, leftCol, rightCol);

  if (header) m.append(header);
  m.append(workspace);

  if (!embedded) {
    const chartsRow = h("div", { class: "grid g2", style: "margin-top:24px;" });
    const c1 = h("div", { class: "card" }, h("h3", {}, "Historical Charge Assessments (All Runs)"));
    const c2 = h("div", { class: "card" }, h("h3", {}, "Claimable Reimbursement by Type"));
    doughnut(c1, an.recovery_positions, { SUPPORTS: "#10b981", CONTRADICTS: "#ef4444", SILENT: "#f59e0b" });
    bar(c2, Object.keys(an.claimable_by_type), [{ label: "Claimable $", data: Object.values(an.claimable_by_type), backgroundColor: "#059669" }]);
    chartsRow.append(c1, c2);
    m.append(chartsRow);
  }
}

// ---------------------------------------------------------------- pipeline
async function pipelinePage(m) {
  m.append(h("h2", {}, "🔗 Full pipeline — one unit through all agents"), h("p", { class: "sub" }, "Receiving → Prep (FBA) or Pack (merchant) → Returns (optional) → Recovery. Evidence flows forward; the orchestrator derives the final outcome."));
  const rcv = receivingForm(), prep = prepForm(), pack = packForm(), ret = returnsForm(); const route = h("select", {}, h("option", { value: "mfn" }, "Merchant-fulfilled / 3PL → Pack"), h("option", { value: "fba" }, "FBA → Prep"));
  const wantRet = h("input", { type: "checkbox" }); const fees = h("textarea", { style: "min-height:120px" }); fees.value = EX; const out = h("div");
  const sec = (t, ...k) => h("div", { class: "card" }, h("h3", {}, t), ...k); const prepC = sec("2 · Prep", prep.el), packC = sec("3 · Pack", pack.el), retC = sec("4 · Returns", ret.el);
  const sync = () => { prepC.style.display = route.value === "fba" ? "" : "none"; packC.style.display = route.value === "mfn" ? "" : "none"; retC.style.display = wantRet.checked ? "" : "none"; }; route.onchange = wantRet.onchange = sync; sync();
  const btn = h("button", { onclick: () => submitLab(btn, out, () => {
    const d = { route: route.value, receiving: rcv.collect(), fees: fees.value }; const fd = new FormData(); fd.append("stage", "pipeline"); const roles = { receiving: rcv.dz.roles() };
    rcv.dz.files.forEach((x) => fd.append("photos_receiving", x.file));
    if (route.value === "fba") { d.prep = prep.collect(); prep.dz.files.forEach((x) => fd.append("photos_prep", x.file)); } else { d.pack = pack.collect(); pack.dz.files.forEach((x) => fd.append("photos_pack", x.file)); }
    if (wantRet.checked) { d.returns = ret.collect(); ret.dz.files.forEach((x) => fd.append("photos_returns", x.file)); }
    fd.append("data", JSON.stringify(d)); fd.append("roles", JSON.stringify(roles)); return fd; }) }, "▶ Run the full pipeline");
  m.append(sec("1 · Receiving", rcv.el), h("div", { class: "card" }, field("Fulfilment route", route), h("label", { class: "chk" }, wantRet, "This unit was returned by a customer")), prepC, packC, retC,
    sec("5 · Recovery — fee report for this unit", fees), h("div", {}, btn), out);
}
// ---------------------------------------------------------------- dashboard
async function dashboard(m) {
  const a = await api("/api/analytics"), k = a.kpis;
  m.append(h("h2", {}, "Analytics"), h("p", { class: "sub" }, "Every workflow, verdict, claim and AI call, charted."));
  if (!k.groq_ready) m.append(h("div", { class: "note warn" }, "Groq is not connected — AI inspections are off. Add your key in ", h("a", { href: "#settings" }, "Groq settings"), ". Sample runs below are the organiser's CSV replay, not AI."));
  const kp = [["Workflows", k.workflows], ["Clean", k.clean], ["Exceptions", k.exceptions], ["Claims recommended", k.claims], ["Claimable $", money(k.claimable_usd)], ["Needs review", k.needs_review], ["AI (Groq) records", k.ai_records], ["Lab units", k.lab_units]];
  m.append(h("div", { class: "grid g4", style: "margin-bottom:18px" }, kp.map(([l, v]) => h("div", { class: "kpi" }, h("span", {}, l), h("b", {}, v)))));
  const C = (t, fn, cls = "") => { const c = h("div", { class: "card " + cls }, h("h3", {}, t)); fn(c); return c; };
  const sv = a.stage_verdicts, st = Object.keys(sv);
  m.append(h("div", { class: "grid g2" },
    C("Final outcomes", (c) => doughnut(c, a.outcomes, { CLEAN: "#10b981", EXCEPTION: "#ef4444", CLAIM_RECOMMENDED: "#0ea5e9", NEEDS_REVIEW: "#f59e0b", INCOMPLETE: "#94a3b8" })),
    C("Verdicts per agent", (c) => bar(c, st, ["PASS", "FAIL", "UNCERTAIN"].map((v) => ({ label: v, data: st.map((s) => sv[s][v] || 0), backgroundColor: VC[v] })), { scales: { x: { stacked: true }, y: { stacked: true } } })),
    C("Top failing checks", (c) => bar(c, a.top_failing_checks.map((x) => x[0]), [{ label: "FAIL count", data: a.top_failing_checks.map((x) => x[1]) }], { indexAxis: "y" })),
    C("Recovery: charge assessments", (c) => doughnut(c, a.recovery_positions, { SUPPORTS: "#10b981", CONTRADICTS: "#ef4444", SILENT: "#f59e0b" }, "pie")),
    C("Claimable $ by charge type", (c) => bar(c, Object.keys(a.claimable_by_type), [{ label: "Claimable $", data: Object.values(a.claimable_by_type) }])),
    C("Cumulative claimable $ over time", (c) => a.claims_timeline.length ? chart(c, { type: "line", data: { labels: a.claims_timeline.map((x) => x.month), datasets: [{ label: "Cumulative $", data: a.claims_timeline.map((x) => x.cumulative), borderColor: "#0ea5e9", backgroundColor: "rgba(56,189,248,.25)", fill: true, tension: .3 }, { label: "Per month $", data: a.claims_timeline.map((x) => x.claimable), borderColor: "#075985", tension: .3 }] } }) : empty(c)),
    C("Evidence source", (c) => doughnut(c, a.providers, { "Groq AI": "#0ea5e9", "Sample CSV replay": "#bae6fd", "Rules engine": "#075985" })),
    C("Average Groq latency per agent (ms)", (c) => bar(c, Object.keys(a.latency_ms), [{ label: "ms", data: Object.values(a.latency_ms) }])),
    C("Confidence distribution", (c) => bar(c, a.confidence_hist.map((_, i) => i * 10 + "–" + (i * 10 + 9) + "%"), [{ label: "records", data: a.confidence_hist }]))));
  const tb = h("table", {}, h("tr", {}, ["Unit", "Org", "Stages", "Outcome", "Claimable"].map((x) => h("th", {}, x))));
  a.recent.forEach((r) => tb.append(h("tr", {}, h("td", { class: "mono" }, r.unit_id), h("td", {}, r.org_id), h("td", {}, r.stages.join(" → ")), h("td", {}, badge(r.outcome || r.status)), h("td", {}, r.claimable_usd ? money(r.claimable_usd) : "—"))));
  m.append(h("div", { class: "card" }, h("h3", {}, "Recent workflows"), tb));
}
// ---------------------------------------------------------------- samples
async function samples(m) {
  m.append(h("h2", {}, "🗂 Sample runs (organiser dataset)"), h("p", { class: "sub" }, "100 sample units. They have no photos, so agents replay the organiser's CSV rows (labelled csv-replay-stub) — use the agent pages to run real AI on your own photos."));
  const units = await api("/api/units"); const out = h("div"); const q = inp("", "text", "filter by unit, SKU, org…"); const body = h("tbody");
  const draw = () => { body.replaceChildren(...units.filter((u) => (u.unit_id + u.sku + u.org_id + u.title).toLowerCase().includes(q.value.toLowerCase())).map((u) => h("tr", {}, h("td", { class: "mono" }, u.unit_id), h("td", {}, u.org_id.replace("org_demo_", "")), h("td", {}, u.title), h("td", {}, u.route), h("td", {}, u.returned ? "yes" : ""), h("td", {}, u.fees ? u.fees + " · " + money(u.fee_total) : ""),
    h("td", {}, h("button", { class: "ghost", onclick: async (e) => { e.target.disabled = true; try { const r = await api("/workflows", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ org_id: u.org_id, unit_id: u.unit_id }) }); const b = await api("/workflows/" + r.workflow_id + "/evidence"); renderBundle(b, out); } catch (x) { toast(x.message); } e.target.disabled = false; } }, "Run"))))); };
  q.oninput = draw; draw(); const all = h("button", { onclick: async () => { all.disabled = true; for (let i = 0; i < units.length; i++) { all.textContent = "Running " + (i + 1) + "/" + units.length; try { await api("/workflows", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ org_id: units[i].org_id, unit_id: units[i].unit_id }) }); } catch {} } all.textContent = "Done — open the dashboard"; } }, "Run all 100 samples");
  m.append(h("div", { class: "card" }, h("div", { class: "row" }, q, h("div", { class: "fix" }, all)), h("div", { style: "max-height:380px;overflow:auto;margin-top:10px" }, h("table", {}, h("thead", {}, h("tr", {}, ["Unit", "Org", "Product", "Route", "Returned", "Fees", ""].map((x) => h("th", {}, x)))), body))), out);
}
// ---------------------------------------------------------------- settings
async function settings(m) {
  m.append(h("h3", { style: "color:var(--ink);margin-top:22px" }, "Groq connection"), h("p", { class: "sub" }, "All five agents call Groq's vision/text models. Your key is held in server memory only — put it in .env (GROQ_API_KEY) to make it permanent."));
  const c = await api("/api/config"); const key = h("input", { type: "password", placeholder: "gsk_…" }); const res = h("div");
  const save = h("button", { onclick: async () => { try { await api("/api/config/groq", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ api_key: key.value }) }); key.value = ""; toast("Key saved for this session"); refreshStatus(); } catch (e) { toast(e.message); } } }, "Save key");
  const test = h("button", { class: "ghost", onclick: async () => { res.replaceChildren(h("p", {}, "Testing…")); const r = await api("/api/config/groq/test", { method: "POST" }); res.replaceChildren(h("div", { class: "note" + (r.ok && r.model_available ? "" : " warn") }, r.ok ? (r.model_available ? "✅ Connected. Model " + r.model + " is available." : "⚠ Connected, but " + (r.note || "model unavailable")) : "❌ " + r.error), r.models ? h("p", { class: "mono mute" }, "Models: " + r.models.join(", ")) : null); } }, "Test connection");
  m.append(h("div", { class: "card" }, h("p", {}, "Status: ", c.key_set ? h("b", {}, "key set (" + c.key_hint + ")") : h("b", {}, "no key"), " · primary model ", h("span", { class: "mono" }, c.model), " · fallbacks ", h("span", { class: "mono" }, c.fallback_models.join(", "))),
    field("Groq API key", key), h("div", { style: "margin-top:12px;display:flex;gap:10px" }, save, test), res, h("p", { class: "mute" }, "Change models with GROQ_MODEL / GROQ_FALLBACK_MODELS in .env. Current vision models accept max 3 images per call; extra photos are tiled into numbered contact sheets.")),
    h("div", { class: "card" }, h("h3", {}, "How each agent uses Groq"), h("table", {}, h("tr", {}, ["Agent", "Groq does", "Code decides"].map((x) => h("th", {}, x))),
      [["Receiving", "describes cartons/product blind to the PO", "match to PO, 9 checks, ACCEPT / EXCEPTION / REVIEW"], ["Prep", "reports what it sees per requirement", "FBA rule pack → PASS / FAIL / UNCERTAIN"], ["Pack", "lists items in the open box blind to the order", "SEAL / STOP & FIX / UNCERTAIN"],
       ["Returns", "identity, parts, damage, grade on Amazon's scale", "ordered rule table → restock / refurbish / liquidate / dispose"], ["Recovery", "writes the claim explanation", "SUPPORTS / CONTRADICTS / SILENT + amounts"]].map((r) => h("tr", {}, r.map((x) => h("td", {}, x)))))));
}
