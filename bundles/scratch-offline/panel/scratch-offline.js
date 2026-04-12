/**
 * Crow's Nest Panel — Scratch (Offline): launcher + setup hints + embed
 *
 * Same shape as the kolibri panel — Scratch is a UI-first surface; Crow
 * just provides a tile, first-install notes (the source build is slow
 * the first time), and an embed option.
 */

export default {
  id: "scratch-offline",
  name: "Scratch (Offline)",
  icon: "graduation-cap",
  route: "/dashboard/scratch-offline",
  navOrder: 56,
  category: "education",

  async handler(req, res, { layout, appRoot }) {
    const { pathToFileURL } = await import("node:url");
    const { join } = await import("node:path");
    const componentsPath = join(appRoot, "servers/gateway/dashboard/shared/components.js");
    const { escapeHtml } = await import(pathToFileURL(componentsPath).href);

    const port = process.env.SCRATCH_HTTP_PORT || "8087";
    const scratchUrl = `http://${req.hostname || "localhost"}:${port}`;
    const tab = req.query.tab === "embed" ? "embed" : "overview";

    const tabBar = `
      <div class="sc-tabs">
        <a href="?tab=overview" class="sc-tab${tab === "overview" ? " active" : ""}">Overview</a>
        <a href="?tab=embed" class="sc-tab${tab === "embed" ? " active" : ""}">Embed</a>
      </div>
    `;

    let body;
    if (tab === "embed") {
      body = `
        <div class="sc-embed-wrap">
          <p class="sc-hint">Scratch's service worker pins many assets; if the embed goes blank after a rebuild, <a href="${escapeHtml(scratchUrl)}" target="_blank" rel="noopener">open in a new tab</a> and hard-refresh.</p>
          <iframe src="${escapeHtml(scratchUrl)}" class="sc-iframe" title="Scratch (Offline)" allow="microphone; camera"></iframe>
        </div>
      `;
    } else {
      body = `
        <section class="sc-card">
          <h2>What this is</h2>
          <p>Self-hosted Scratch programming environment — the same block-based editor kids use on scratch.mit.edu, running entirely on your server with no cloud save, no sign-in, and no telemetry. Projects download as <code>.sb3</code> files.</p>
        </section>
        <section class="sc-card">
          <h2>Launch</h2>
          <p><a class="sc-btn" href="${escapeHtml(scratchUrl)}" target="_blank" rel="noopener">Open Scratch ↗</a></p>
          <p class="sc-muted">Or <a href="?tab=embed">embed it inside the Nest</a>.</p>
        </section>
        <section class="sc-card">
          <h2>First install is slow</h2>
          <p>The bundle builds <code>scratch-gui</code> from source the first time it starts. On a Pi 4 that's <strong>10-15 minutes</strong> and needs ~2 GB of free disk for npm build artifacts (discarded after). On x86, ~2 minutes. Subsequent launches are instant.</p>
          <p>If the build fails (out of memory on a Pi Zero, npm network timeout), <code>docker compose build --no-cache</code> and re-run.</p>
        </section>
        <section class="sc-card">
          <h2>Age gate</h2>
          <p>Scratch is recommended by its authors for <strong>ages 8+</strong>. The Maker Lab recommender surfaces this bundle only when <code>learner.age &gt;= 8</code>; younger learners stay on Blockly.</p>
        </section>
        <section class="sc-card">
          <h2>No cloud save — by design</h2>
          <p>This bundle does <strong>not</strong> connect to scratch.mit.edu's My Stuff backend. Projects live only as downloaded <code>.sb3</code> files. For a home lab with multiple learners, pair with the <code>filesystem</code> bundle so projects land in a shared <code>~/scratch-projects/</code> directory.</p>
        </section>
      `;
    }

    const content = `
      <style>${styles()}</style>
      <div class="sc-panel">
        <h1>Scratch (Offline)</h1>
        ${tabBar}
        <div class="sc-body">${body}</div>
      </div>
    `;
    return layout({ title: "Scratch (Offline)", content });
  },
};

function styles() {
  return `
    .sc-panel { max-width: 900px; margin: 0 auto; padding: 1.5rem; }
    .sc-tabs { display: flex; gap: 0.5rem; margin: 1rem 0 1.5rem; border-bottom: 1px solid var(--border, #333); }
    .sc-tab { padding: 0.5rem 1rem; color: var(--fg-muted, #888); text-decoration: none; border-bottom: 2px solid transparent; }
    .sc-tab.active { color: var(--fg, #eee); border-bottom-color: #f59e0b; }
    .sc-card { background: var(--card-bg, rgba(255,255,255,0.04)); border: 1px solid var(--border, #333); border-radius: 10px; padding: 1.25rem 1.5rem; margin-bottom: 1rem; }
    .sc-card h2 { margin: 0 0 0.75rem; font-size: 1.05rem; color: #f59e0b; }
    .sc-btn { display: inline-block; padding: 0.6rem 1.2rem; background: #f59e0b; color: #111; text-decoration: none; border-radius: 6px; font-weight: 600; }
    .sc-btn:hover { background: #fbbf24; }
    .sc-muted { color: var(--fg-muted, #888); font-size: 0.9rem; margin-top: 0.5rem; }
    .sc-hint { color: var(--fg-muted, #888); font-size: 0.85rem; margin: 0; }
    .sc-embed-wrap { display: flex; flex-direction: column; gap: 0.5rem; }
    .sc-iframe { width: 100%; height: 72vh; border: 1px solid var(--border, #333); border-radius: 8px; background: #fff; }
  `;
}
