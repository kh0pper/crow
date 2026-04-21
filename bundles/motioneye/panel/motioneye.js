/**
 * Crow's Nest Panel — motionEye: iframe-only bundle.
 *
 * motionEye's admin UI uses form POSTs + session cookies + CSRF tokens — not
 * worth wrapping for v1 when the Web UI inside an iframe just works. Camera
 * configuration, recordings browse, and motion-detection toggle all happen
 * inside the iframe from motionEye's own origin (same first-party-cookie
 * pattern as the Jellyfin panel).
 *
 * If you want MCP-callable "list cameras / list events / snapshot" from the
 * AI, install the Frigate bundle alongside.
 *
 * No companion routes.js — no REST proxy needed for v1.
 */

export default {
  id: "motioneye",
  name: "motionEye",
  icon: "phone-video",
  route: "/dashboard/motioneye",
  navOrder: 33,
  category: "cameras",

  async handler(req, res, { layout, appRoot }) {
    const { pathToFileURL } = await import("node:url");
    const { join } = await import("node:path");

    const componentsPath = join(appRoot, "servers/gateway/dashboard/shared/components.js");
    const { escapeHtml } = await import(pathToFileURL(componentsPath).href);

    const motioneyeUrl = process.env.MOTIONEYE_URL || "http://localhost:8765";

    const content = `
      <style>
        .me-panel { display: flex; flex-direction: column; height: calc(100vh - 140px); }
        .me-panel h1 { margin: 0 0 0.75rem; }
        .me-note { color: var(--muted, #888); font-size: 0.85rem; margin-bottom: 0.5rem; }
        .me-iframe { flex: 1; width: 100%; border: 0; border-radius: 6px; background: #000; }
      </style>
      <div class="me-panel">
        <h1>motionEye</h1>
        <div class="me-note">Default login on first start: <code>admin</code> / (empty password). Rotate via Settings → General.</div>
        <iframe id="motioneye-iframe" data-turbo-permanent src="${escapeHtml(motioneyeUrl)}" class="me-iframe" allow="autoplay; fullscreen"></iframe>
      </div>
    `;

    res.send(layout({ title: "motionEye", content }));
  },
};
