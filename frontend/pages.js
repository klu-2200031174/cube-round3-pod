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

// ---------------------------------------------------------------- Framer Motion helper
function applyMotionEffects() {
  if (typeof window.Motion === "undefined") return;
  const { animate, inView, stagger } = window.Motion;
  const prefersReduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (prefersReduced) return;

  try {
    // Staggered reveals on hero elements
    animate(".hero-pill-badge", { opacity: [0, 1], y: [16, 0] }, { duration: 0.55, ease: [0.16, 1, 0.3, 1] });
    animate(".hero-headline", { opacity: [0, 1], y: [22, 0] }, { duration: 0.65, delay: 0.08, ease: [0.16, 1, 0.3, 1] });
    animate(".hero-subhead", { opacity: [0, 1], y: [18, 0] }, { duration: 0.65, delay: 0.16, ease: [0.16, 1, 0.3, 1] });
    animate(".hero-cta-group", { opacity: [0, 1], y: [16, 0] }, { duration: 0.55, delay: 0.24, ease: [0.16, 1, 0.3, 1] });
    animate(".hero-stage-card", { opacity: [0, 1], y: [28, 0] }, { duration: 0.75, delay: 0.32, ease: [0.16, 1, 0.3, 1] });

    // Pipeline nodes stagger
    const nodes = document.querySelectorAll(".pipeline-node");
    if (nodes.length) {
      animate(nodes, { opacity: [0, 1], y: [12, 0] }, { delay: stagger(0.08, { start: 0.42 }), duration: 0.5 });
    }

    // Scroll viewport triggers
    if (typeof inView === "function") {
      inView(".agent-spec-card", (info) => {
        animate(info.target, { opacity: [0, 1], y: [24, 0] }, { duration: 0.6, ease: [0.16, 1, 0.3, 1] });
      });
      inView(".workflow-step-card", (info) => {
        animate(info.target, { opacity: [0, 1], y: [20, 0] }, { duration: 0.55, ease: [0.16, 1, 0.3, 1] });
      });
      inView(".evidence-dossier-card", (info) => {
        animate(info.target, { opacity: [0, 1], y: [28, 0] }, { duration: 0.7, ease: [0.16, 1, 0.3, 1] });
      });
      inView(".outcomes-banner", (info) => {
        animate(info.target, { opacity: [0, 1], y: [20, 0] }, { duration: 0.6, ease: [0.16, 1, 0.3, 1] });
      });
    }
  } catch (err) {
    console.warn("Motion effect warning:", err);
  }
}

// ---------------------------------------------------------------- landing (SYDON.AI x CUBE POD 13)
function landing(m) {
  document.body.classList.remove("login-page");
  document.body.classList.add("landing");

  // Sticky Navigation Header
  const nav = h("header", { class: "sydon-nav" },
    h("div", { class: "nav-container" },
      h("a", { class: "nav-brand", href: "#" },
        h("div", { class: "brand-title" }, "sydon.ai", h("span", { class: "accent" }, "× pod13")),
        h("span", { class: "brand-tag" }, "ROUND 3")
      ),
      h("nav", { class: "nav-menu" },
        h("a", { class: "nav-link", href: "#platform" }, "Platform"),
        h("a", { class: "nav-link", href: "#five-agents" }, "Five Agents"),
        h("a", { class: "nav-link", href: "#evidence-integrity" }, "Evidence"),
        h("a", { class: "nav-link", href: "#how-it-works" }, "How It Works")
      ),
      h("div", { class: "nav-actions" },
        h("a", { class: "btn-nav-login", href: "#login" }, "Demo Login"),
        h("a", { class: "btn-nav-cta", href: "#overview" }, "Open Control Center →")
      )
    )
  );

  // Hero Section
  const hero = h("section", { class: "landing-hero", id: "platform" },
    h("div", { class: "hero-editorial" },
      h("div", { class: "hero-pill-badge" },
        h("span", { class: "pulse-dot" }),
        "CUBE BUILDATHON 2026 · ROUND 3 · POD 13"
      ),
      h("h1", { class: "hero-headline" },
        "Intelligence in motion. ",
        h("em", {}, "Decisions with evidence.")
      ),
      h("p", { class: "hero-subhead" },
        "Five specialized agents. One orchestrated workflow. Every operational decision connected to its evidence."
      ),
      h("div", { class: "hero-cta-group" },
        h("a", { class: "btn-hero-primary", href: "#overview" }, "Enter Control Center →"),
        h("a", { class: "btn-hero-secondary", href: "#how-it-works" }, "Explore the Platform ↓")
      )
    ),

    // Original Hero Composition: 5 Agents In Motion
    h("div", { class: "hero-stage-card" },
      h("div", { class: "stage-top-bar" },
        h("div", { class: "unit-specimen-pill" },
          h("span", {}, "ACTIVE UNIT:"),
          h("b", {}, "UNIT-0042"),
          h("span", {}, "·"),
          h("span", {}, "SKU: B09X41-PRO"),
          h("span", {}, "·"),
          h("span", {}, "ROUTE: MFN-DIRECT")
        ),
        h("div", { class: "stage-telemetry-tag" },
          h("span", { class: "spin", style: "width:10px;height:10px;border-width:1.5px;color:var(--emerald)" }),
          "5 AGENTS CONCURRENT · ORCHESTRATION ACTIVE"
        )
      ),

      h("div", { class: "stage-pipeline-flow" },
        [
          ["01", "Receiving Manager", "ACCEPT", "PO Match 100%"],
          ["02", "Prep Manager", "PASS", "FBA Compliant"],
          ["03", "Pack Manager", "SEAL", "Census Verified"],
          ["04", "Returns Manager", "RESTOCK", "Condition: Like-New"],
          ["05", "Recovery Manager", "CLAIM $38.00", "Packaging Defect Audit"]
        ].map(([idx, name, verdict, sub], i) =>
          h("div", { class: "pipeline-node" + (i === 2 ? " active-focus" : "") },
            h("div", { class: "node-idx" }, "AGENT " + idx),
            h("div", { class: "node-name" }, name),
            h("div", { class: "node-badge-verdict" + (idx === "05" ? " claim" : "") }, verdict),
            h("div", { style: "font-size:11px;color:var(--mute);margin-top:6px;" }, sub)
          )
        )
      ),

      h("div", { class: "stage-bottom-ledger" },
        h("div", { class: "ledger-item" },
          h("span", { class: "label" }, "Evidence Digest:"),
          h("span", { class: "value mono" }, "sha256:4f8e719ba28d09e331c...")
        ),
        h("div", { class: "ledger-item" },
          h("span", { class: "label" }, "Verification:"),
          h("span", { class: "value" }, "Cryptographic Integrity 100%")
        ),
        h("div", { class: "ledger-item" },
          h("span", { class: "label" }, "Final Verdict:"),
          h("span", { class: "value", style: "color:var(--emerald-dark)" }, "VERIFIED WITH PROOF")
        )
      )
    )
  );

  // Five Agents Section
  const fiveAgentsSection = h("section", { class: "landing-section", id: "five-agents" },
    h("div", { class: "section-editorial-header" },
      h("span", { class: "section-label" }, "Autonomous Operating Fleet"),
      h("h2", { class: "section-title" }, "The Five Intelligent Agents"),
      h("p", { class: "section-desc" },
        "Five purpose-built vision and logic engines operating in an orchestrated DAG. Each agent delivers rigorous, evidence-backed verdicts without hallucinations."
      )
    ),

    h("div", { class: "agents-editorial-grid" },
      // Agent 1: Receiving Manager
      h("div", { class: "agent-spec-card span-4" },
        h("div", { class: "card-top-identity" },
          h("div", { class: "agent-icon-box" }, "📥"),
          h("span", { class: "agent-order-num" }, "STAGE 01")
        ),
        h("h3", { class: "agent-card-title" }, "Receiving Manager"),
        h("p", { class: "agent-card-role" },
          "Dock inbound inspection, purchase order reconciliation, and physical carton damage grading."
        ),
        h("ul", { class: "agent-specs-list" },
          h("li", {}, "Audits carton condition and seals against inbound manifest"),
          h("li", {}, "Cross-checks received quantities against original PO lines"),
          h("li", {}, "Evaluates shipping label OCR legibility and tracking barcodes")
        ),
        h("div", { class: "agent-meta-footer" },
          h("span", { class: "model mono" }, "Groq / Qwen 27B Vision"),
          h("span", { class: "verdict" }, "ACCEPT · EXCEPTION · REJECT")
        )
      ),

      // Agent 2: Prep Manager
      h("div", { class: "agent-spec-card span-4" },
        h("div", { class: "card-top-identity" },
          h("div", { class: "agent-icon-box" }, "🏷"),
          h("span", { class: "agent-order-num" }, "STAGE 02")
        ),
        h("h3", { class: "agent-card-title" }, "Prep Manager"),
        h("p", { class: "agent-card-role" },
          "Amazon FBA compliance enforcement, polybag specifications, and scannable barcode verification."
        ),
        h("ul", { class: "agent-specs-list" },
          h("li", {}, "Checks suffocation warnings on polybags > 5 inches"),
          h("li", {}, "Confirms barcode readability and FNSKU label coverage"),
          h("li", {}, "Flags non-verifiable attributes without guessing")
        ),
        h("div", { class: "agent-meta-footer" },
          h("span", { class: "model mono" }, "Deterministic FBA Matrix"),
          h("span", { class: "verdict" }, "PASS · FAIL · UNCERTAIN")
        )
      ),

      // Agent 3: Pack Manager
      h("div", { class: "agent-spec-card span-4" },
        h("div", { class: "card-top-identity" },
          h("div", { class: "agent-icon-box" }, "📦"),
          h("span", { class: "agent-order-num" }, "STAGE 03")
        ),
        h("h3", { class: "agent-card-title" }, "Pack Manager"),
        h("p", { class: "agent-card-role" },
          "Outbound box census audit prior to sealing. Detects omissions, incorrect variants, and extra items."
        ),
        h("ul", { class: "agent-specs-list" },
          h("li", {}, "Zero-shot visual item count blind to the packing order"),
          h("li", {}, "Identifies missing SKU items or unauthorized foreign items"),
          h("li", {}, "Automated halt triggers (STOP & FIX) for warehouse packers")
        ),
        h("div", { class: "agent-meta-footer" },
          h("span", { class: "model mono" }, "Census Vision Audit"),
          h("span", { class: "verdict" }, "SEAL · STOP & FIX · UNCERTAIN")
        )
      ),

      // Agent 4: Returns Manager
      h("div", { class: "agent-spec-card span-6" },
        h("div", { class: "card-top-identity" },
          h("div", { class: "agent-icon-box" }, "↩"),
          h("span", { class: "agent-order-num" }, "STAGE 04")
        ),
        h("h3", { class: "agent-card-title" }, "Returns Manager"),
        h("p", { class: "agent-card-role" },
          "Reverse logistics grading against official Amazon condition rubrics. Detects swap fraud and audits accessories."
        ),
        h("ul", { class: "agent-specs-list" },
          h("li", {}, "Detects product swap fraud against original catalog signatures"),
          h("li", {}, "Audits completeness of enclosed accessories, power cables, and documentation"),
          h("li", {}, "Classifies condition across 6 grades and assigns automated disposition")
        ),
        h("div", { class: "agent-meta-footer" },
          h("span", { class: "model mono" }, "Multi-Modal Condition Scale"),
          h("span", { class: "verdict" }, "RESTOCK · REFURBISH · LIQUIDATE · DISPOSE")
        )
      ),

      // Agent 5: Recovery Manager (Featured Card)
      h("div", { class: "agent-spec-card span-6" },
        h("div", { class: "card-top-identity" },
          h("div", { class: "agent-icon-box" }, "$"),
          h("span", { class: "agent-order-num" }, "STAGE 05")
        ),
        h("h3", { class: "agent-card-title" }, "Recovery Manager"),
        h("p", { class: "agent-card-role" },
          "Financial fee reconciliation and automated claim generator. Audits charge line items against upstream evidence."
        ),
        h("ul", { class: "agent-specs-list" },
          h("li", {}, "Cross-references Amazon chargebacks directly against Pack/Prep hashes"),
          h("li", {}, "Generates defensible reimbursement claims with exact proof references"),
          h("li", {}, "Strict SILENT discipline: never asserts claims without verifiable evidence")
        ),
        h("div", { class: "agent-meta-footer" },
          h("span", { class: "model mono" }, "Automated Claim Engine"),
          h("span", { class: "verdict" }, "CONTRADICTS ($) · SUPPORTS · SILENT")
        )
      )
    )
  );

  // How the System Works Section
  const howItWorksSection = h("section", { class: "landing-section", id: "how-it-works" },
    h("div", { class: "section-editorial-header" },
      h("span", { class: "section-label" }, "Execution Architecture"),
      h("h2", { class: "section-title" }, "How the System Works"),
      h("p", { class: "section-desc" },
        "Input captures move through orchestrated parallel stages. Code decides deterministically; Groq vision observes without bias; outcomes are cryptographically bonded to evidence."
      )
    ),

    h("div", { class: "workflow-matrix-container" },
      [
        ["01", "Input Capture", "Photographic captures of cartons, barcodes, items, and fee ledgers are ingested."],
        ["02", "Orchestration", "DAG scheduler executes independent agents in parallel (Receiving ∥ Prep/Pack)."],
        ["03", "Agent Decisions", "Vision models describe observations; deterministic rule engines compute verdicts."],
        ["04", "Evidence Validation", "Every observation check and photo sha256 checksum is hashed into an immutable record."],
        ["05", "Final Outcome", "The orchestrator resolves the workflow status and computes recovery positions."]
      ].map(([num, title, desc]) =>
        h("div", { class: "workflow-step-card" },
          h("span", { class: "step-num-pill" }, "PHASE " + num),
          h("h4", { class: "step-title" }, title),
          h("p", { class: "step-desc" }, desc)
        )
      )
    ),

    h("div", { class: "outcomes-banner" },
      h("h3", { style: "margin:0 0 8px;font-size:18px;color:var(--ink);" }, "Verifiable Outcome Matrix"),
      h("p", { class: "mute", style: "margin:0;font-size:13.5px;" },
        "The final result depends strictly on available evidence. UNCERTAIN results trigger human review and are never coerced into a PASS."
      ),
      h("div", { class: "outcomes-grid" },
        h("div", { class: "outcome-card pass" },
          h("h4", {}, "● PASS"),
          h("p", {}, "Complete photographic compliance verified. PO confirmed, package sealed, or return restocked.")
        ),
        h("div", { class: "outcome-card fail" },
          h("h4", {}, "● FAIL"),
          h("p", {}, "Discrepancy or physical defect confirmed. Packaging rejected, omission flagged, or fee contradicted.")
        ),
        h("div", { class: "outcome-card uncertain" },
          h("h4", {}, "● UNCERTAIN"),
          h("p", {}, "Photo angle obscured or insufficient data. Escalated to human review queue without guessing.")
        )
      )
    )
  );

  // Evidence Section (Nothing lost between input and decision)
  const evidenceSection = h("section", { class: "landing-section", id: "evidence-integrity" },
    h("div", { class: "section-editorial-header" },
      h("span", { class: "section-label" }, "Traceability Guarantee"),
      h("h2", { class: "section-title" }, "Nothing lost between input and decision."),
      h("p", { class: "section-desc" },
        "Every single verdict links directly to its source photographs, expected vs observed criteria, model metadata, and sha256 cryptographic hashes."
      )
    ),

    h("div", { class: "evidence-dossier-card" },
      h("div", { class: "dossier-header-bar" },
        h("div", { class: "dossier-title-group" },
          h("h3", {}, "Evidence Record Specimen"),
          h("span", { class: "unit-pill" }, "UNIT-0042"),
          h("span", { class: "badge PASS" }, "SEAL · PASS")
        ),
        h("div", { class: "dossier-specimen-badge" }, "DEMO EVIDENCE SPECIMEN · NON-PRODUCTION RECORD")
      ),

      h("div", { class: "dossier-body" },
        h("div", { class: "dossier-meta-grid" },
          h("div", { class: "dossier-meta-box" },
            h("span", { class: "k" }, "Record ID"),
            h("span", { class: "v" }, "EV-PACK-0042-881")
          ),
          h("div", { class: "dossier-meta-box" },
            h("span", { class: "k" }, "Contributing Agent"),
            h("span", { class: "v" }, "Pack Manager")
          ),
          h("div", { class: "dossier-meta-box" },
            h("span", { class: "k" }, "Input Hash"),
            h("span", { class: "v" }, "sha256:9b1a7d6540c9...")
          ),
          h("div", { class: "dossier-meta-box" },
            h("span", { class: "k" }, "Confidence Score"),
            h("span", { class: "v", style: "color:var(--emerald-dark)" }, "98.4% Verified")
          )
        ),

        h("div", { style: "margin-bottom:20px;" },
          h("h4", { style: "margin:0 0 10px;font-size:14px;color:var(--ink);" }, "Inspection Checks: Expected vs Observed"),
          h("table", {},
            h("thead", {},
              h("tr", {},
                ["Check Description", "Verdict", "Expected Qty", "Observed Qty", "Evidence Reference"].map((th) => h("th", {}, th))
              )
            ),
            h("tbody", {},
              h("tr", {},
                h("td", {}, h("b", {}, "item_count_primary")),
                h("td", {}, h("span", { class: "badge PASS" }, "PASS")),
                h("td", { class: "mono" }, "1 unit"),
                h("td", { class: "mono" }, "1 unit (verified)"),
                h("td", { class: "mono mute" }, "img_carton_top.jpg")
              ),
              h("tr", {},
                h("td", {}, h("b", {}, "accessory_cable_usb_c")),
                h("td", {}, h("span", { class: "badge PASS" }, "PASS")),
                h("td", { class: "mono" }, "1 unit"),
                h("td", { class: "mono" }, "1 unit (present)"),
                h("td", { class: "mono mute" }, "img_carton_top.jpg")
              ),
              h("tr", {},
                h("td", {}, h("b", {}, "extra_unordered_items")),
                h("td", {}, h("span", { class: "badge PASS" }, "PASS")),
                h("td", { class: "mono" }, "0 extra"),
                h("td", { class: "mono" }, "0 extra detected"),
                h("td", { class: "mono mute" }, "img_carton_top.jpg")
              )
            )
          )
        ),

        h("div", { style: "background:var(--bg-primary);border:1px solid var(--border-subtle);border-radius:10px;padding:12px 16px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;font-size:12px;" },
          h("div", { class: "mono", style: "color:var(--ink-secondary);" },
            "Photo References: ",
            h("span", { class: "mute" }, "img_carton_top.jpg (sha256:4f8e719ba28d09e3...) · img_barcode.jpg (sha256:7c21ae9004f183bb...)")
          ),
          h("div", { class: "mono", style: "color:var(--emerald-dark);font-weight:600;" },
            "CONTENT HASH: sha256:a9143c7219f854b..."
          )
        )
      )
    )
  );

  // Closing Section
  const closingSection = h("section", { class: "landing-closing-cta" },
    h("div", { class: "closing-card" },
      h("span", { class: "section-label" }, "Deployable Control Center"),
      h("h2", { class: "closing-title" }, "Make every operational decision traceable."),
      h("p", { class: "closing-sub" },
        "Launch autonomous multi-agent pipelines, inspect live review queues, and reconcile fee recovery with photographic certainty."
      ),
      h("a", { class: "btn-hero-primary", href: "#overview", style: "font-size:16px;padding:15px 34px;" }, "Open Control Center →")
    )
  );

  // Footer
  const footer = h("footer", { class: "landing-footer" },
    h("div", { class: "footer-content" },
      h("div", {},
        h("div", { class: "footer-brand" }, "SYDON.AI × CUBE POD 13"),
        h("div", { class: "footer-sub" }, "CUBE Buildathon 2026 · Round 3 · Multi-Agent Workflow & Recovery Decision Engine")
      ),
      h("div", { class: "footer-meta-badges" },
        h("span", { class: "meta-pill" }, "5 Agents Integrated"),
        h("span", { class: "meta-pill" }, "Groq Multi-Modal"),
        h("span", { class: "meta-pill" }, "Parallel DAG Scheduler"),
        h("span", { class: "meta-pill" }, "Framer Motion Ready")
      )
    )
  );

  m.append(nav, hero, fiveAgentsSection, howItWorksSection, evidenceSection, closingSection, footer);

  // Trigger Framer Motion effects
  setTimeout(applyMotionEffects, 40);
}

// ---------------------------------------------------------------- login page
function loginPage(m) {
  document.body.classList.remove("landing");
  document.body.classList.add("login-page");

  const DEMO_ACCOUNTS = [
    { role: "Admin", email: "admin@pod13.demo", pass: "Pod13Admin!2026", desc: "Full Fleet Supervision & Settings" },
    { role: "Operations", email: "operator@pod13.demo", pass: "Pod13Ops!2026", desc: "Live Runs, Queue & Workflows" },
    { role: "Recovery", email: "recovery@pod13.demo", pass: "Pod13Recovery!2026", desc: "Fee Audits & Claims Engine" }
  ];

  const topNav = h("div", { class: "login-top-bar" },
    h("a", { href: "#", class: "nav-brand", style: "text-decoration:none;" },
      h("div", { class: "brand-title" }, "sydon.ai", h("span", { class: "accent" }, "× pod13")),
      h("span", { class: "brand-tag" }, "ROUND 3")
    ),
    h("a", { href: "#", class: "btn-nav-login", style: "display:inline-flex;align-items:center;gap:6px;" },
      "← Return to Platform"
    )
  );

  const emailInp = h("input", { type: "email", placeholder: "name@pod13.demo", required: true });
  const passInp = h("input", { type: "password", placeholder: "••••••••••••", required: true });
  let passShown = false;
  const toggleBtn = h("button", {
    type: "button",
    class: "btn-toggle-eye",
    onclick: () => {
      passShown = !passShown;
      passInp.type = passShown ? "text" : "password";
      toggleBtn.textContent = passShown ? "👁️ Hide" : "👁️ Show";
    }
  }, "👁️ Show");

  const rememberChk = h("input", { type: "checkbox", checked: true });
  const alertBox = h("div", { style: "display:none;margin-bottom:16px;padding:10px 14px;border-radius:8px;font-size:12.5px;" });

  const showAlert = (msg, isError) => {
    alertBox.style.display = "block";
    alertBox.style.background = isError ? "var(--fail-bg)" : "var(--emerald-subtle)";
    alertBox.style.color = isError ? "var(--fail)" : "var(--emerald-dark)";
    alertBox.style.border = "1px solid " + (isError ? "#fca5a5" : "var(--emerald-border)");
    alertBox.textContent = msg;
  };

  const demoBtnsContainer = h("div", { class: "demo-account-buttons" });
  let selectedBtn = null;

  DEMO_ACCOUNTS.forEach((acc) => {
    const btn = h("button", {
      type: "button",
      class: "btn-demo-pill",
      onclick: () => {
        if (selectedBtn) selectedBtn.classList.remove("selected");
        btn.classList.add("selected");
        selectedBtn = btn;
        emailInp.value = acc.email;
        passInp.value = acc.pass;
        showAlert("Credentials loaded for " + acc.role + ". Click Sign In to authenticate.", false);
      }
    }, h("div", { style: "font-weight:700;" }, acc.role), h("div", { style: "font-size:10px;color:var(--mute);" }, acc.email.split("@")[0]));
    demoBtnsContainer.append(btn);
  });

  const submitBtn = h("button", {
    type: "submit",
    class: "btn-auth-submit"
  }, "Sign In to Control Center →");

  const form = h("form", {
    onsubmit: async (e) => {
      e.preventDefault();
      const email = emailInp.value.trim();
      const pass = passInp.value.trim();

      if (!email || !pass) {
        showAlert("Please enter both email and password.", true);
        return;
      }

      const matched = DEMO_ACCOUNTS.find(a => a.email.toLowerCase() === email.toLowerCase() && a.pass === pass);

      submitBtn.disabled = true;
      submitBtn.innerHTML = '<span class="spin"></span> Authenticating terminal...';
      alertBox.style.display = "none";

      await new Promise(r => setTimeout(r, 600));

      if (matched || (email.includes("@") && pass.length >= 6)) {
        const role = matched ? matched.role : "Operator";
        localStorage.setItem("sydon_user", JSON.stringify({ email, role, loggedAt: new Date().toISOString() }));
        showAlert("Authenticated successfully as " + role + ". Redirecting...", false);
        toast("Authenticated as " + role);
        setTimeout(() => {
          location.hash = "#overview";
        }, 300);
      } else {
        submitBtn.disabled = false;
        submitBtn.textContent = "Sign In to Control Center →";
        showAlert("Invalid credentials. Please select one of the demo accounts above.", true);
      }
    }
  },
    h("div", { class: "auth-form-group" },
      h("label", {}, "Work Email"),
      emailInp
    ),
    h("div", { class: "auth-form-group" },
      h("label", {}, "Password"),
      h("div", { class: "input-with-action" },
        passInp,
        toggleBtn
      )
    ),
    h("div", { class: "auth-check-row" },
      h("label", { class: "chk", style: "margin:0;" }, rememberChk, "Remember this terminal"),
      h("a", { href: "#", class: "mute", style: "text-decoration:none;font-size:12px;" }, "Platform Home")
    ),
    alertBox,
    submitBtn
  );

  const authCard = h("div", { class: "login-auth-card" },
    h("div", { class: "auth-header" },
      h("h2", {}, "Sign In to Control Center"),
      h("p", {}, "Access the multi-agent orchestration console and evidence vault.")
    ),
    h("div", { class: "demo-access-panel" },
      h("span", { class: "title" }, "Quick Demo Access (Select to Populate)"),
      demoBtnsContainer,
      h("p", { class: "mute", style: "font-size:11px;margin:8px 0 0;" }, "Selecting a profile pre-fills credentials without auto-submitting.")
    ),
    form,
    h("p", { class: "mute", style: "font-size:11.5px;text-align:center;margin-top:24px;" },
      "Development & Evaluation Environment · No external secrets transmitted."
    )
  );

  const container = h("div", { class: "login-card-container" }, authCard);
  const wrap = h("div", { class: "login-screen-wrap" }, topNav, container);

  m.append(wrap);
}

// ---------------------------------------------------------------- overview (Enterprise Redesign)
async function overview(m) {
  const [a, wf] = await Promise.all([api("/api/analytics"), api("/api/workflow-list")]);
  const k = a.kpis;

  // Header strip
  const header = h("div", { class: "page-header-strip" },
    h("div", { class: "page-header-title-box" },
      h("h2", {}, "Overview"),
      h("p", { class: "sub" }, "Live operational state across the five-agent commerce workflow pipeline.")
    ),
    h("div", { class: "header-action-group" },
      h("button", { onclick: () => runModal(async () => { route(); }) }, "+ Launch Workflow"),
      h("a", { class: "btn ghost", href: "#live" }, "Live Run →"),
      h("button", { class: "ghost", onclick: () => route() }, "↻ Refresh")
    )
  );

  // Groq warning if key missing
  const groqWarn = !k.groq_ready ? h("div", { class: "note warn", style: "margin-bottom:16px;" },
    "Groq is not connected — multi-modal visual inspections are inactive. Configure your API key in ",
    h("a", { href: "#system" }, "Pod / System"),
    ". Sample runs replay organizer benchmark rows."
  ) : null;

  // 6 Compact KPI cards
  const kpiItems = [
    { label: "Workflows", val: k.workflows, sub: "Total tracked", icon: "☰" },
    { label: "Clean Units", val: k.clean, sub: "Zero exceptions", icon: "✓", color: "var(--pass)" },
    { label: "Exceptions", val: k.exceptions, sub: "Defects / mismatches", icon: "⚠", color: "var(--fail)" },
    { label: "Claims Recommended", val: k.claims, sub: "Reimbursement ready", icon: "◈", color: "var(--cyan)" },
    { label: "Claimable Value", val: money(k.claimable_usd), sub: "Evidence-backed", icon: "$", color: "var(--emerald-dark)" },
    { label: "Needs Review", val: k.needs_review, sub: "Pending human input", icon: "👤", color: k.needs_review > 0 ? "var(--unc)" : "var(--mute)" }
  ];

  const kpiGrid = h("div", { class: "overview-kpi-grid" },
    kpiItems.map(item => h("div", { class: "kpi-card-compact" },
      h("div", { class: "kpi-compact-label" },
        h("span", {}, item.label),
        h("span", { style: "font-size:13px;" }, item.icon)
      ),
      h("div", { class: "kpi-compact-val", style: item.color ? `color:${item.color}` : "" }, item.val),
      h("div", { class: "kpi-compact-sub" }, item.sub)
    ))
  );

  // Five-Agent Workflow Visualization Strip
  const pipelineStrip = h("div", { class: "pipeline-overview-card" },
    h("div", { class: "pipeline-overview-header" },
      h("h3", {}, "Standard Multi-Agent Execution Flow (standard-v1)"),
      h("a", { href: "#orchestration", class: "mute", style: "text-decoration:none;font-size:12px;font-weight:600;" }, "Inspect DAG Graph →")
    ),
    h("div", { class: "pipeline-overview-strip" },
      STAGES5.map(([s, label], i) => {
        const v = a.stage_verdicts[s] || {};
        const count = (v.PASS || 0) + (v.FAIL || 0) + (v.UNCERTAIN || 0);
        return h("a", { class: "pipeline-agent-step", href: "#console-" + s },
          h("div", { class: "step-seq-tag" }, "STAGE 0" + (i + 1)),
          h("div", { class: "step-agent-name" }, label + " Manager"),
          h("div", { class: "step-agent-stats" }, count + " records processed"),
          h("div", { class: "verdict-mini-bar" },
            ["PASS", "FAIL", "UNCERTAIN"].map(res =>
              h("i", { style: `flex:${v[res] || 0};background:${VC[res]};` })
            )
          )
        );
      })
    )
  );

  // Two-column Main Grid: Left = Recent Workflows; Right = Review Queue Panel & Outcomes Chart
  const mainGrid = h("div", { class: "overview-main-grid" });

  // Left Column: Recent Activity Table
  const recentCard = h("div", { class: "card", style: "margin-bottom:0;" },
    h("div", { style: "display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;" },
      h("h3", { style: "margin:0;" }, "Recent Workflow Activity"),
      h("a", { href: "#workflows", class: "mute", style: "text-decoration:none;font-size:12px;font-weight:600;" }, "View All (" + wf.length + ") →")
    ),
    wfTable(wf.slice(0, 7), m)
  );

  // Right Column: Exceptions / Review Queue Panel + Outcomes Chart
  const rightCol = h("div", {});

  // Exceptions / Review Panel
  const reviewCard = h("div", { class: "review-exception-panel" + (k.needs_review > 0 ? " alert" : "") });
  if (k.needs_review > 0) {
    reviewCard.append(
      h("div", { style: "display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;" },
        h("h3", { style: "margin:0;font-size:14.5px;color:var(--unc);display:flex;align-items:center;gap:6px;" },
          "👤 " + k.needs_review + " Item" + (k.needs_review > 1 ? "s" : "") + " Awaiting Human Review"
        ),
        h("a", { href: "#queue", class: "btn ghost", style: "height:28px;padding:0 10px;font-size:11.5px;" }, "Open Queue →")
      ),
      h("p", { class: "mute", style: "margin:0;font-size:12.5px;" },
        "Agents returned UNCERTAIN due to ambiguous photographic evidence. Human overrides maintain complete audit fidelity."
      )
    );
  } else {
    reviewCard.append(
      h("h3", { style: "margin:0 0 4px;font-size:14px;color:var(--ink);" }, "✓ Review Queue Clear"),
      h("p", { class: "mute", style: "margin:0;font-size:12px;" }, "Zero workflows currently blocked or requiring human review.")
    );
  }

  // Outcome distribution chart card
  const chartCard = h("div", { class: "card" },
    h("h3", {}, "Final Outcome Distribution"),
    h("div", { id: "outcomes-chart-box" })
  );

  rightCol.append(reviewCard, chartCard);

  // Recovery claimable summary card if supported by real data
  if (a.claimable_by_type && Object.keys(a.claimable_by_type).length > 0) {
    const claimCard = h("div", { class: "card" },
      h("h3", {}, "Claimable Reimbursement by Type"),
      h("div", { id: "claimable-chart-box" })
    );
    rightCol.append(claimCard);
  }

  mainGrid.append(recentCard, rightCol);
  m.append(header, groqWarn, kpiGrid, pipelineStrip, mainGrid);

  // Render chart after DOM append
  doughnut(chartCard.querySelector("#outcomes-chart-box"), a.outcomes, {
    CLEAN: "#10b981",
    EXCEPTION: "#ef4444",
    CLAIM_RECOMMENDED: "#0ea5e9",
    NEEDS_REVIEW: "#f59e0b",
    INCOMPLETE: "#94a3b8"
  });

  const claimBox = rightCol.querySelector("#claimable-chart-box");
  if (claimBox && a.claimable_by_type && Object.keys(a.claimable_by_type).length > 0) {
    bar(claimBox, Object.keys(a.claimable_by_type), [
      { label: "Claimable $", data: Object.values(a.claimable_by_type), backgroundColor: "#059669" }
    ]);
  }
}

function wfTable(rows, host) {
  const detail = h("div", { style: "margin-top:14px;" });
  if (!rows || rows.length === 0) {
    return h("div", { class: "empty-dossier-state", style: "padding:32px 16px;" },
      h("span", { class: "empty-dossier-icon" }, "📋"),
      h("b", { style: "display:block;margin-bottom:4px;color:var(--ink);" }, "No Workflows Found"),
      h("p", { class: "mute", style: "margin:0 0 12px;font-size:12.5px;" }, "No matching workflows exist in the database."),
      h("button", { onclick: () => runModal(async () => { route(); }) }, "+ Run a Workflow")
    );
  }
  const t = h("table", {},
    h("thead", {},
      h("tr", {}, ["Workflow", "Unit ID", "Org", "Route", "Returned", "Stage", "Status", "Outcome", "Claimable"].map(th => h("th", {}, th)))
    ),
    h("tbody", {},
      rows.map(r => h("tr", { class: "click", onclick: () => openWorkflow(r.workflow_id, detail).then(() => detail.scrollIntoView({ behavior: "smooth" })) },
        h("td", { class: "mono", style: "font-weight:600;color:var(--cyan);" }, r.workflow_id.replace("WF-", "")),
        h("td", { class: "mono" }, r.unit_id),
        h("td", {}, r.org_id.replace("org_", "")),
        h("td", { class: "mono" }, r.route ? r.route.toUpperCase() : "—"),
        h("td", {}, r.returned ? h("span", { class: "badge", style: "background:#e0f2fe;color:#0369a1;" }, "YES") : h("span", { class: "mute" }, "NO")),
        h("td", {}, r.current_stage || "—"),
        h("td", {}, badge(r.status)),
        h("td", {}, r.outcome ? badge(r.outcome) : h("span", { class: "mute" }, "—")),
        h("td", { style: "font-weight:600;" }, r.claimable_usd ? money(r.claimable_usd) : h("span", { class: "mute" }, "—"))
      ))
    )
  );
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
// ---------------------------------------------------------------- shell + router (Enterprise Grouped Navigation)
const NAV_GROUPS = [
  {
    title: null,
    items: [
      ["overview", "Overview", "▦"]
    ]
  },
  {
    title: "Operations",
    items: [
      ["live", "Live Run", "▶"],
      ["workflows", "Workflows", "☰"],
      ["units", "Units", "◫"]
    ]
  },
  {
    title: "Five Agents",
    items: [
      ["console-receiving", "Receiving", "📥"],
      ["console-prep", "Prep", "🏷"],
      ["console-pack", "Pack", "📦"],
      ["console-returns", "Returns", "↩"],
      ["console-recovery", "Recovery", "$"]
    ]
  },
  {
    title: "Intelligence",
    items: [
      ["orchestration", "Orchestration Graph", "⛭"],
      ["agents", "Agents Fleet", "✦"]
    ]
  },
  {
    title: "Evidence & Decisions",
    items: [
      ["queue", "Review Queue", "✓"],
      ["evidence", "Evidence Vault", "⛓"],
      ["recovery", "Recovery Hub", "◈"]
    ]
  },
  {
    title: "Analytics & Settings",
    items: [
      ["failures", "Failures", "⚠"],
      ["analytics", "Analytics", "◔"],
      ["system", "Pod / System", "⚙"]
    ]
  }
];

const PG = {
  login: loginPage,
  overview,
  orchestration: orchestrationPage,
  live: livePage,
  workflows,
  units: unitsPage,
  queue,
  recovery: recoveryHub,
  evidence: evidencePage,
  agents: agentsPage,
  failures: failuresPage,
  analytics: dashboard,
  system: systemPage
};

Object.assign(PG, {
  "console-receiving": stagePage("receiving", "1 · Receiving Manager", "Dock inbound inspection, purchase order reconciliation, and physical carton damage grading.", receivingForm),
  "console-prep": stagePage("prep", "2 · Prep Manager", "Amazon FBA packaging compliance, polybag warning labels, and scannable barcode verification.", prepForm),
  "console-pack": stagePage("pack", "3 · Pack Manager", "Outbound carton census audit prior to taping. Detects missing items, wrong variants, and extra items.", packForm),
  "console-returns": stagePage("returns", "4 · Returns Manager", "Reverse logistics condition evaluation against Amazon rubrics and customer return swap fraud detection.", returnsForm),
  "console-recovery": recoveryPage,
  "console-pipeline": livePage
});

function shell() {
  const container = $("#sidebar-nav");
  const aside = $("#sidebar");
  if (!container || !aside) return;
  container.replaceChildren();

  // Portal & Login links
  const portalLinks = h("div", { style: "display:flex;gap:4px;margin-bottom:8px;padding-bottom:6px;border-bottom:1px solid var(--border-subtle);" },
    h("a", { class: "nav-item", "data-p": "", href: "#", title: "Landing Page", style: "flex:1;" }, h("i", {}, "🌐"), h("span", {}, "Portal Home")),
    h("a", { class: "nav-item", "data-p": "login", href: "#login", title: "Demo Login", style: "flex:1;" }, h("i", {}, "🔐"), h("span", {}, "Demo Login"))
  );
  container.append(portalLinks);

  NAV_GROUPS.forEach(group => {
    if (group.title) {
      container.append(h("div", { class: "nav-section-title" }, group.title));
    }
    group.items.forEach(([key, label, icon]) => {
      const a = h("a", { class: "nav-item", "data-p": key, href: "#" + key, title: label },
        h("i", {}, icon),
        h("span", {}, label)
      );
      container.append(a);
    });
  });

  // Collapsible sidebar toggle button logic
  const collapseBtn = $("#sidebar-collapse-btn");
  if (collapseBtn) {
    collapseBtn.onclick = () => {
      const isCollapsed = aside.classList.toggle("collapsed");
      collapseBtn.textContent = isCollapsed ? "▶" : "◀";
      collapseBtn.title = isCollapsed ? "Expand sidebar" : "Collapse sidebar";
    };
  }

  // Mobile navigation drawer toggle logic
  const mobileBtn = $("#mobile-menu-btn");
  const backdrop = $("#sidebar-backdrop");
  if (mobileBtn && backdrop) {
    const toggleMobile = () => {
      const isOpen = aside.classList.toggle("mobile-open");
      backdrop.classList.toggle("active", isOpen);
    };
    mobileBtn.onclick = toggleMobile;
    backdrop.onclick = toggleMobile;
    container.addEventListener("click", (e) => {
      if (e.target.closest("a")) {
        aside.classList.remove("mobile-open");
        backdrop.classList.remove("active");
      }
    });
  }
}

async function route() {
  charts.splice(0).forEach((c) => c.destroy());
  document.querySelectorAll(".overlay").forEach((o) => o.remove());

  const hash = (location.hash || "#").slice(1);
  const [p, arg] = hash.split("/");
  const path = location.pathname;

  const isLogin = p === "login" || path === "/login";
  const isLanding = (!p || p === "" || p === "portal") && !isLogin;

  document.body.classList.toggle("landing", isLanding);
  document.body.classList.toggle("login-page", isLogin);

  document.querySelectorAll("aside a").forEach((a) => {
    a.classList.toggle("on", a.dataset.p === p);
  });

  const host = $("#main");
  const m = h("div");
  host.replaceChildren(m);

  try {
    if (isLogin) {
      loginPage(m);
      return;
    }
    if (isLanding) {
      landing(m);
    } else {
      await (PG[p] || overview)(m, arg);
    }
  } catch (e) {
    m.append(h("div", { class: "note warn" }, "⚠ " + e.message));
  }

  if (!isLanding && !isLogin) {
    m.append(h("div", { class: "footbar" }, "LIVE ● connected to the orchestrator API · ", h("span", { id: "wfcount" })));
    api("/api/analytics").then((a) => {
      const e = $("#wfcount");
      if (e) e.textContent = a.kpis.workflows + " workflows tracked";
    }).catch(() => {});
  }
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
