/**
 * Crow's Nest Panel — Kolibri: launcher + setup hints + optional iframe embed
 *
 * v1 keeps the panel intentionally thin — the real UX lives in Kolibri's
 * own web app. We surface:
 *   1. First-run setup checklist
 *   2. Direct-link and iframe options
 *   3. A hardware-usage note (Pi-friendly floor + typical channel sizes)
 *
 * Channel browsing / lesson recommendation tools are Phase 4b (would wire
 * Kolibri's REST API through an MCP server). This panel ships without.
 */

export default {
  id: "kolibri",
  name: "Kolibri",
  icon: "graduation-cap",
  route: "/dashboard/kolibri",
  navOrder: 55,
  category: "education",

  async handler(req, res, { layout, appRoot }) {
    const { pathToFileURL } = await import("node:url");
    const { join } = await import("node:path");
    const componentsPath = join(appRoot, "servers/gateway/dashboard/shared/components.js");
    const { escapeHtml } = await import(pathToFileURL(componentsPath).href);

    const port = process.env.KOLIBRI_HTTP_PORT || "8085";
    const kolibriUrl = process.env.KOLIBRI_URL || `http://${req.hostname || "localhost"}:${port}`;
    const tab = req.query.tab === "embed" ? "embed" : "overview";

    const tabBar = `
      <div class="kb-tabs">
        <a href="?tab=overview" class="kb-tab${tab === "overview" ? " active" : ""}">Overview</a>
        <a href="?tab=embed" class="kb-tab${tab === "embed" ? " active" : ""}">Embed</a>
      </div>
    `;

    let body;
    if (tab === "embed") {
      body = `
        <div class="kb-embed-wrap">
          <p class="kb-hint">If the embed is blank, Kolibri may send frame-ancestor headers that block cross-origin iframes. <a href="${escapeHtml(kolibriUrl)}" target="_blank" rel="noopener">Open in a new tab</a> instead.</p>
          <iframe src="${escapeHtml(kolibriUrl)}" class="kb-iframe" title="Kolibri web UI"></iframe>
        </div>
      `;
    } else {
      body = `
        <section class="kb-card">
          <h2>First-run setup</h2>
          <ol>
            <li>Open <a href="${escapeHtml(kolibriUrl)}" target="_blank" rel="noopener"><code>${escapeHtml(kolibriUrl)}</code></a> and complete the first-run wizard (create a superuser account + facility).</li>
            <li>In the admin panel, go to <strong>Channels → Import</strong> and pick a few channels from Kolibri Studio. A good K-5 STEM starter set (CK-12, Khan Academy Kids, Touchable Earth) runs ~3-5 GB.</li>
            <li>Create learner accounts under <strong>Facility → Users</strong> — or hand out signup links via the <strong>Facility settings</strong>.</li>
            <li>Kolibri auto-discovers other Kolibri instances on the same LAN. Two Pis on the same network sync content automatically — useful for offline classrooms.</li>
          </ol>
        </section>
        <section class="kb-card">
          <h2>Launch</h2>
          <p><a class="kb-btn" href="${escapeHtml(kolibriUrl)}" target="_blank" rel="noopener">Open Kolibri ↗</a></p>
          <p class="kb-muted">Or <a href="?tab=embed">embed it inside the Nest</a>.</p>
        </section>
        <section class="kb-card">
          <h2>Sibling of Maker Lab</h2>
          <p>Kolibri fits alongside <code>maker-lab</code> as the content spine — Maker Lab's scaffolded AI tutor handles "why does this work?" conversations while Kolibri delivers the curated lesson + practice content. Learners can toggle between them from the Nest home screen.</p>
        </section>
        <section class="kb-card">
          <h2>Hardware notes</h2>
          <ul>
            <li>RAM floor: <strong>512 MB</strong> (runs on a Pi 4 with headroom).</li>
            <li>Disk: <strong>500 MB</strong> for the bare install; a populated K-5 STEM library is <strong>5-10 GB</strong>.</li>
            <li>Swap port to a Pi: set <code>KOLIBRI_HTTP_PORT=8080</code> if you want the canonical port, but only if nothing else is on :8080.</li>
          </ul>
        </section>
      `;
    }

    const content = `
      <style>${styles()}</style>
      <div class="kb-panel">
        <h1>Kolibri</h1>
        ${tabBar}
        <div class="kb-body">${body}</div>
      </div>
    `;

    return layout({ title: "Kolibri", content });
  },
};

function styles() {
  return `
    .kb-panel { max-width: 900px; margin: 0 auto; padding: 1.5rem; }
    .kb-tabs { display: flex; gap: 0.5rem; margin: 1rem 0 1.5rem; border-bottom: 1px solid var(--border, #333); }
    .kb-tab { padding: 0.5rem 1rem; color: var(--fg-muted, #888); text-decoration: none; border-bottom: 2px solid transparent; }
    .kb-tab.active { color: var(--fg, #eee); border-bottom-color: #84cc16; }
    .kb-card { background: var(--card-bg, rgba(255,255,255,0.04)); border: 1px solid var(--border, #333); border-radius: 10px; padding: 1.25rem 1.5rem; margin-bottom: 1rem; }
    .kb-card h2 { margin: 0 0 0.75rem; font-size: 1.05rem; color: #84cc16; }
    .kb-card ol, .kb-card ul { margin: 0; padding-left: 1.25rem; line-height: 1.6; }
    .kb-btn { display: inline-block; padding: 0.6rem 1.2rem; background: #84cc16; color: #111; text-decoration: none; border-radius: 6px; font-weight: 600; }
    .kb-btn:hover { background: #a3e635; }
    .kb-muted { color: var(--fg-muted, #888); font-size: 0.9rem; margin-top: 0.5rem; }
    .kb-embed-wrap { display: flex; flex-direction: column; gap: 0.5rem; }
    .kb-hint { color: var(--fg-muted, #888); font-size: 0.85rem; margin: 0; }
    .kb-iframe { width: 100%; height: 72vh; border: 1px solid var(--border, #333); border-radius: 8px; background: #fff; }
  `;
}
