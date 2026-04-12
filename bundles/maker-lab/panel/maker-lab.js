/**
 * Crow's Nest Panel — Maker Lab (Phase 1 scaffold)
 *
 * Three view modes (solo / family / classroom), guest "Try it" button,
 * minimal learner management. Lesson authoring UI lands in Phase 2.
 *
 * Handler pattern copied from bundles/knowledge-base/panel/knowledge-base.js.
 */

export default {
  id: "maker-lab",
  name: "Maker Lab",
  icon: "graduation-cap",
  route: "/dashboard/maker-lab",
  navOrder: 45,
  category: "education",

  async handler(req, res, { db, layout, appRoot }) {
    const { pathToFileURL } = await import("node:url");
    const { join } = await import("node:path");
    const componentsPath = join(appRoot, "servers/gateway/dashboard/shared/components.js");
    const { escapeHtml } = await import(pathToFileURL(componentsPath).href);

    // Resolve current mode (solo/family/classroom) from dashboard_settings.
    async function getMode() {
      const r = await db.execute({
        sql: "SELECT value FROM dashboard_settings WHERE key = 'maker_lab.mode'",
        args: [],
      });
      return r.rows[0]?.value || "family";
    }

    async function setMode(mode) {
      await db.execute({
        sql: `INSERT INTO dashboard_settings (key, value) VALUES ('maker_lab.mode', ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        args: [mode],
      });
    }

    // ─── POST actions ───────────────────────────────────────────────────

    if (req.method === "POST") {
      const a = req.body?.action;

      if (a === "set_mode") {
        const mode = String(req.body.mode || "family");
        if (["solo", "family", "classroom"].includes(mode)) {
          // Solo-downgrade guard: refuse if more than one learner exists.
          if (mode === "solo") {
            const c = await db.execute({
              sql: "SELECT COUNT(*) AS n FROM research_projects WHERE type='learner_profile'",
              args: [],
            });
            if (Number(c.rows[0].n) > 1) {
              return res.redirect("/dashboard/maker-lab?err=solo_multiple_learners");
            }
          }
          await setMode(mode);
        }
        return res.redirect("/dashboard/maker-lab");
      }

      if (a === "create_learner") {
        const name = String(req.body.name || "").trim().slice(0, 100);
        const age = Number(req.body.age);
        const avatar = String(req.body.avatar || "").slice(0, 50) || null;
        const consent = req.body.consent === "1";
        if (!name || !Number.isFinite(age) || age < 3 || age > 100) {
          return res.redirect("/dashboard/maker-lab?err=create_invalid");
        }
        if (!consent) {
          return res.redirect("/dashboard/maker-lab?err=consent_required");
        }
        const meta = JSON.stringify({ age, avatar });
        const ins = await db.execute({
          sql: `INSERT INTO research_projects (name, type, description, metadata, created_at, updated_at)
                VALUES (?, 'learner_profile', ?, ?, datetime('now'), datetime('now')) RETURNING id`,
          args: [name, null, meta],
        });
        const lid = Number(ins.rows[0].id);
        await db.execute({
          sql: `INSERT INTO maker_learner_settings (learner_id, consent_captured_at)
                VALUES (?, datetime('now'))`,
          args: [lid],
        });
        return res.redirect(`/dashboard/maker-lab?created=${lid}`);
      }

      if (a === "delete_learner") {
        const lid = Number(req.body.learner_id);
        if (!Number.isFinite(lid)) return res.redirect("/dashboard/maker-lab");
        // Tier-1: require explicit confirm step via ?confirm=DELETE in POST body.
        if (req.body.confirm !== "DELETE") {
          return res.redirect(`/dashboard/maker-lab?pending_delete=${lid}`);
        }
        await db.execute({ sql: "DELETE FROM maker_sessions WHERE learner_id=?", args: [lid] });
        await db.execute({ sql: "DELETE FROM maker_transcripts WHERE learner_id=?", args: [lid] });
        await db.execute({ sql: "DELETE FROM maker_bound_devices WHERE learner_id=?", args: [lid] });
        await db.execute({ sql: "DELETE FROM maker_learner_settings WHERE learner_id=?", args: [lid] });
        try { await db.execute({ sql: "DELETE FROM memories WHERE project_id=?", args: [lid] }); } catch {}
        await db.execute({
          sql: "DELETE FROM research_projects WHERE id=? AND type='learner_profile'",
          args: [lid],
        });
        return res.redirect("/dashboard/maker-lab?deleted=1");
      }

      // Minting sessions actually happens via the MCP tool; the panel only
      // renders the redemption code / short URL on return. Phase 2 wires the
      // QR-code image rendering.
    }

    // ─── GET ────────────────────────────────────────────────────────────

    const mode = await getMode();
    const err = String(req.query.err || "");
    const pendingDelete = req.query.pending_delete ? Number(req.query.pending_delete) : null;

    const learnersR = await db.execute({
      sql: `SELECT rp.id, rp.name, rp.metadata, rp.created_at,
                   mls.transcripts_enabled, mls.consent_captured_at
            FROM research_projects rp
            LEFT JOIN maker_learner_settings mls ON mls.learner_id = rp.id
            WHERE rp.type = 'learner_profile'
            ORDER BY rp.created_at DESC`,
      args: [],
    });
    const learners = learnersR.rows.map((r) => {
      let meta = {};
      try { meta = JSON.parse(r.metadata || "{}"); } catch {}
      return {
        id: Number(r.id),
        name: r.name,
        age: meta.age ?? null,
        persona: meta.age == null ? "kid-tutor"
          : meta.age <= 9 ? "kid-tutor"
          : meta.age <= 13 ? "tween-tutor"
          : "adult-tutor",
        transcripts_enabled: !!r.transcripts_enabled,
        consent_captured_at: r.consent_captured_at,
        created_at: r.created_at,
      };
    });

    const activeSessionsR = await db.execute({
      sql: `SELECT token, learner_id, started_at, expires_at, state, hints_used
            FROM maker_sessions
            WHERE state != 'revoked' AND expires_at > datetime('now') AND is_guest = 0
            ORDER BY started_at DESC LIMIT 50`,
      args: [],
    });
    const activeByLearner = new Map();
    for (const s of activeSessionsR.rows) {
      activeByLearner.set(Number(s.learner_id), s);
    }

    // ─── Render ─────────────────────────────────────────────────────────

    const modeTabs = ["solo", "family", "classroom"].map((m) => `
      <form method="POST" action="/dashboard/maker-lab" style="display:inline">
        <input type="hidden" name="action" value="set_mode">
        <input type="hidden" name="mode" value="${m}">
        <button type="submit" class="mode-tab ${m === mode ? 'active' : ''}">${m}</button>
      </form>
    `).join("");

    const errBanner = err ? `<div class="banner error">${escapeHtml({
      create_invalid: "Name is required and age must be between 3 and 100.",
      consent_required: "Consent checkbox is required.",
      solo_multiple_learners: "Cannot downgrade to Solo mode while more than one learner profile exists. Use Archive & Downgrade from the Settings panel.",
    }[err] || err)}</div>` : "";

    const createForm = `
      <details class="panel">
        <summary>+ Add learner</summary>
        <form method="POST" action="/dashboard/maker-lab" class="create-form">
          <input type="hidden" name="action" value="create_learner">
          <label>Name <input name="name" required maxlength="100"></label>
          <label>Age <input name="age" type="number" min="3" max="100" required></label>
          <label>Avatar <input name="avatar" placeholder="mao_pro" maxlength="50"></label>
          <label class="consent">
            <input type="checkbox" name="consent" value="1">
            I am the parent/guardian of this child, or I am the child's teacher operating under the school's consent process. (COPPA / GDPR-K)
          </label>
          <button type="submit">Create learner</button>
        </form>
      </details>
    `;

    const guestButton = `
      <a class="guest-btn" href="/dashboard/maker-lab?guest=1">Try it without saving →</a>
    `;

    const renderLearnerCard = (l) => {
      const active = activeByLearner.get(l.id);
      const isPending = pendingDelete === l.id;
      return `
        <div class="learner-card ${active ? 'active' : ''}">
          <div class="meta">
            <strong>${escapeHtml(l.name)}</strong>
            <span class="age">age ${l.age ?? '—'}</span>
            <span class="persona">${escapeHtml(l.persona)}</span>
            ${l.transcripts_enabled ? '<span class="chip">transcripts on</span>' : ''}
            ${active ? `<span class="chip live">live session</span>` : ''}
          </div>
          <div class="actions">
            ${active
              ? `<span class="expires">ends ${escapeHtml(active.expires_at || '')}</span>`
              : `<a class="btn primary" href="/dashboard/maker-lab?start=${l.id}">Start session</a>`}
            ${isPending
              ? `<form method="POST" action="/dashboard/maker-lab" style="display:inline">
                   <input type="hidden" name="action" value="delete_learner">
                   <input type="hidden" name="learner_id" value="${l.id}">
                   <input type="hidden" name="confirm" value="DELETE">
                   <button type="submit" class="btn danger">Confirm delete</button>
                 </form>
                 <a class="btn" href="/dashboard/maker-lab">Cancel</a>`
              : `<form method="POST" action="/dashboard/maker-lab" style="display:inline">
                   <input type="hidden" name="action" value="delete_learner">
                   <input type="hidden" name="learner_id" value="${l.id}">
                   <button type="submit" class="btn danger-outline">Delete</button>
                 </form>`}
          </div>
        </div>
      `;
    };

    const learnersHtml = mode === "classroom"
      ? `<div class="classroom-grid">${learners.map(renderLearnerCard).join("")}</div>`
      : `<div class="family-list">${learners.map(renderLearnerCard).join("")}</div>`;

    const modeHeadline = ({
      solo: "Solo mode — one learner, auto-start.",
      family: "Family mode — per-learner progress timeline.",
      classroom: "Classroom mode — grid view, bulk start, printable QR sheet.",
    })[mode];

    const startHint = req.query.start
      ? `<div class="banner info">Session minting happens through the <code>maker_start_session</code> MCP tool. Phase 2 wires this button to a redemption-code + QR view.</div>`
      : "";

    const phaseBanner = `<div class="banner info"><strong>Phase 1 scaffold.</strong> Blockly surface, kiosk routes, and QR rendering land in Phase 2. See <code>bundles/maker-lab/PHASE-0-REPORT.md</code>.</div>`;

    const css = `<style>
      .maker-lab { padding: 1rem; }
      .mode-tabs { display: flex; gap: 0.5rem; margin-bottom: 1rem; }
      .mode-tab { padding: 0.4rem 1rem; border: 1px solid var(--border, #333); background: transparent; color: inherit; cursor: pointer; border-radius: 4px; text-transform: capitalize; }
      .mode-tab.active { background: var(--accent, #84cc16); color: #000; font-weight: 600; }
      .headline { color: var(--muted, #888); font-size: 0.9em; margin-bottom: 1rem; }
      .panel { background: var(--card, rgba(255,255,255,0.03)); padding: 1rem; border-radius: 8px; margin-bottom: 1rem; }
      .create-form { display: grid; gap: 0.5rem; margin-top: 0.75rem; max-width: 400px; }
      .create-form label { display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.9em; }
      .create-form label.consent { flex-direction: row; gap: 0.5rem; align-items: flex-start; }
      .create-form input[type=text], .create-form input[type=number], .create-form input:not([type]) { padding: 0.4rem; background: var(--input, rgba(0,0,0,0.3)); color: inherit; border: 1px solid var(--border, #333); border-radius: 4px; }
      .family-list { display: grid; gap: 0.5rem; }
      .classroom-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 0.5rem; }
      .learner-card { border: 1px solid var(--border, #333); padding: 0.75rem; border-radius: 6px; display: flex; justify-content: space-between; align-items: center; gap: 1rem; }
      .learner-card.active { border-color: var(--accent, #84cc16); }
      .classroom-grid .learner-card { flex-direction: column; align-items: stretch; }
      .meta { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: baseline; }
      .age, .persona { color: var(--muted, #888); font-size: 0.85em; }
      .chip { padding: 0.1rem 0.5rem; background: rgba(132,204,22,0.15); color: #84cc16; border-radius: 10px; font-size: 0.75em; }
      .chip.live { background: rgba(239,68,68,0.15); color: #ef4444; }
      .actions { display: flex; gap: 0.5rem; flex-wrap: wrap; }
      .btn { padding: 0.3rem 0.8rem; text-decoration: none; border: 1px solid var(--border, #333); color: inherit; border-radius: 4px; font-size: 0.85em; background: transparent; cursor: pointer; }
      .btn.primary { background: var(--accent, #84cc16); color: #000; border-color: var(--accent, #84cc16); }
      .btn.danger { background: #ef4444; color: #fff; border-color: #ef4444; }
      .btn.danger-outline { color: #ef4444; border-color: #ef4444; }
      .guest-btn { display: inline-block; margin-left: 0.5rem; padding: 0.3rem 0.8rem; border: 1px dashed var(--muted, #888); border-radius: 4px; color: inherit; text-decoration: none; font-size: 0.9em; }
      .banner { padding: 0.6rem 0.9rem; border-radius: 4px; margin-bottom: 0.75rem; font-size: 0.9em; }
      .banner.error { background: rgba(239,68,68,0.15); color: #ef4444; }
      .banner.info { background: rgba(59,130,246,0.12); color: #60a5fa; }
      .expires { font-size: 0.8em; color: var(--muted, #888); }
    </style>`;

    const content = `
      <div class="maker-lab">
        ${css}
        ${phaseBanner}
        ${errBanner}
        ${startHint}
        <div class="mode-tabs">${modeTabs}${guestButton}</div>
        <div class="headline">${modeHeadline}</div>
        ${createForm}
        ${learnersHtml || '<div class="panel">No learners yet. Add one above to get started.</div>'}
      </div>
    `;

    return layout({ title: `Maker Lab (${mode})`, content });
  },
};
