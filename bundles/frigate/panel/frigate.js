/**
 * Crow's Nest Panel — Frigate: cameras, recent events with thumbnails, system stats, Web UI iframe.
 *
 * Bundle-compatible version: uses dynamic imports with appRoot instead of
 * static ESM imports, so this panel works both from the repo and when
 * installed to ~/.crow/panels/.
 *
 * Overview tab: REST-driven via /api/frigate/* routes (bundles/frigate/panel/routes.js).
 * Web UI tab: iframe Frigate's own UI. Frigate sets its own JWT cookie inside the
 * iframe from the :8971 origin — same first-party pattern as the Jellyfin panel.
 *
 * Client-side JS uses DOM construction (createElement + textContent + appendChild)
 * so there is no innerHTML assignment with dynamic content.
 */

export default {
  id: "frigate",
  name: "Frigate",
  icon: "phone-video",
  route: "/dashboard/frigate",
  navOrder: 32,
  category: "cameras",

  async handler(req, res, { layout, appRoot }) {
    const { pathToFileURL } = await import("node:url");
    const { join } = await import("node:path");

    const componentsPath = join(appRoot, "servers/gateway/dashboard/shared/components.js");
    const { escapeHtml } = await import(pathToFileURL(componentsPath).href);

    const tab = req.query.tab || "overview";

    const tabs = [
      { id: "overview", label: "Overview" },
      { id: "webui", label: "Web UI" },
    ];

    const tabBar = `<div class="fg-tabs">${tabs.map((t) =>
      `<a href="?tab=${escapeHtml(t.id)}" class="fg-tab${tab === t.id ? " active" : ""}">${escapeHtml(t.label)}</a>`
    ).join("")}</div>`;

    let body = "";
    if (tab === "webui") {
      const frigateUrl = process.env.FRIGATE_URL || "http://localhost:8971";
      body = `
        <div class="fg-webui">
          <iframe id="frigate-iframe" data-turbo-permanent src="${escapeHtml(frigateUrl)}" class="fg-iframe" allow="autoplay; fullscreen"></iframe>
        </div>
      `;
    } else {
      body = renderOverview();
    }

    const content = `
      <style>${frigateStyles()}</style>
      <div class="fg-panel">
        <h1>Frigate NVR</h1>
        ${tabBar}
        <div class="fg-body">${body}</div>
      </div>
      <script>${frigateScript()}</script>
    `;

    res.send(layout({ title: "Frigate", content }));
  },
};

function renderOverview() {
  return `
    <div class="fg-overview">
      <div class="fg-section">
        <h3>Cameras</h3>
        <div id="fg-cameras" class="fg-cameras">
          <div class="fg-loading">Loading cameras…</div>
        </div>
      </div>
      <div class="fg-section">
        <h3>Recent Events</h3>
        <div id="fg-events" class="fg-events">
          <div class="fg-loading">Loading events…</div>
        </div>
      </div>
      <div class="fg-section">
        <h3>System</h3>
        <pre id="fg-stats" class="fg-stats">Loading stats…</pre>
      </div>
    </div>
  `;
}

function frigateStyles() {
  return `
    .fg-panel { max-width: 1100px; margin: 0 auto; padding: 1rem; }
    .fg-tabs { display: flex; gap: 0.25rem; border-bottom: 1px solid var(--border, #333); margin-bottom: 1rem; }
    .fg-tab { padding: 0.5rem 1rem; text-decoration: none; color: var(--muted, #888); border-bottom: 2px solid transparent; }
    .fg-tab.active { color: var(--fg, #fff); border-bottom-color: var(--accent, #fbbf24); }
    .fg-section { margin: 1.5rem 0; }
    .fg-section h3 { margin: 0 0 0.5rem; font-size: 1rem; color: var(--muted, #888); text-transform: uppercase; letter-spacing: 0.05em; }
    .fg-cameras { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 0.75rem; }
    .fg-camera { padding: 0.75rem; background: var(--panel, #1a1a1a); border: 1px solid var(--border, #333); border-radius: 6px; }
    .fg-camera-name { font-weight: 600; margin-bottom: 0.25rem; }
    .fg-camera-meta { font-size: 0.85rem; color: var(--muted, #888); }
    .fg-badge { display: inline-block; padding: 0.1rem 0.4rem; border-radius: 3px; font-size: 0.75rem; margin-right: 0.25rem; }
    .fg-badge.on { background: rgba(34, 197, 94, 0.2); color: #22c55e; }
    .fg-badge.off { background: rgba(148, 163, 184, 0.2); color: #94a3b8; }
    .fg-badge.person { background: rgba(59, 130, 246, 0.2); color: #3b82f6; }
    .fg-badge.car { background: rgba(251, 146, 60, 0.2); color: #fb923c; }
    .fg-badge.dog, .fg-badge.cat, .fg-badge.animal { background: rgba(168, 85, 247, 0.2); color: #a855f7; }
    .fg-events { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 0.75rem; }
    .fg-event { background: var(--panel, #1a1a1a); border: 1px solid var(--border, #333); border-radius: 6px; overflow: hidden; }
    .fg-event-thumb { width: 100%; aspect-ratio: 16/9; object-fit: cover; background: #000; display: block; }
    .fg-event-body { padding: 0.5rem 0.75rem; font-size: 0.85rem; }
    .fg-event-camera { color: var(--muted, #888); font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; }
    .fg-event-time { color: var(--muted, #888); font-size: 0.75rem; margin-top: 0.2rem; }
    .fg-stats { padding: 0.75rem; background: var(--panel, #1a1a1a); border: 1px solid var(--border, #333); border-radius: 6px; font-family: monospace; font-size: 0.85rem; white-space: pre-wrap; margin: 0; }
    .fg-loading { color: var(--muted, #888); font-style: italic; grid-column: 1 / -1; }
    .fg-empty { color: var(--muted, #888); font-style: italic; grid-column: 1 / -1; }
    .fg-error { color: #f43f5e; grid-column: 1 / -1; }
    .fg-webui { height: calc(100vh - 220px); }
    .fg-iframe { width: 100%; height: 100%; border: 0; border-radius: 6px; }
  `;
}

function frigateScript() {
  return `
    (function () {
      function clearKids(el) { while (el && el.firstChild) el.removeChild(el.firstChild); }
      function span(cls, text) { var s = document.createElement("span"); s.className = cls; s.textContent = text; return s; }
      function div(cls, text) { var d = document.createElement("div"); d.className = cls; if (text != null) d.textContent = text; return d; }
      function el(tag, cls, text) { var x = document.createElement(tag); if (cls) x.className = cls; if (text != null) x.textContent = text; return x; }
      function relTime(secs) {
        if (!secs) return "";
        var d = Math.floor(Date.now() / 1000 - secs);
        if (d < 60) return d + "s ago";
        if (d < 3600) return Math.floor(d / 60) + "m ago";
        if (d < 86400) return Math.floor(d / 3600) + "h ago";
        return Math.floor(d / 86400) + "d ago";
      }
      function labelCls(label) {
        var l = (label || "").toLowerCase();
        if (["person","face"].indexOf(l) >= 0) return "fg-badge person";
        if (["car","truck","motorcycle","bicycle"].indexOf(l) >= 0) return "fg-badge car";
        if (["dog","cat","bird","animal","horse","sheep","cow"].indexOf(l) >= 0) return "fg-badge dog";
        return "fg-badge on";
      }

      function renderCameras(cams) {
        var host = document.getElementById("fg-cameras");
        if (!host) return;
        clearKids(host);
        if (!cams || cams.length === 0) {
          host.appendChild(div("fg-empty", "No cameras configured. Edit config.yml to add RTSP sources."));
          return;
        }
        cams.forEach(function (c) {
          var card = div("fg-camera");
          card.appendChild(div("fg-camera-name", c.name));
          var meta = div("fg-camera-meta");
          meta.appendChild(span(c.detect_enabled ? "fg-badge on" : "fg-badge off", c.detect_enabled ? "detect" : "detect off"));
          var res = (c.width && c.height) ? (c.width + "×" + c.height) : "?";
          meta.appendChild(document.createTextNode(" " + res));
          card.appendChild(meta);
          var objs = (c.tracked_objects || []).join(", ") || "none";
          card.appendChild(div("fg-camera-meta", "tracking: " + objs));
          host.appendChild(card);
        });
      }

      function renderEvents(events) {
        var host = document.getElementById("fg-events");
        if (!host) return;
        clearKids(host);
        if (!events || events.length === 0) {
          host.appendChild(div("fg-empty", "No events yet. Once a camera detects motion, events will appear here."));
          return;
        }
        events.forEach(function (e) {
          var card = div("fg-event");
          if (e.has_snapshot || e.has_clip) {
            var img = document.createElement("img");
            img.className = "fg-event-thumb";
            img.loading = "lazy";
            img.alt = (e.label || "event") + " on " + (e.camera || "");
            // Proxied through the gateway so Frigate JWT stays server-side
            img.src = "/api/frigate/events/" + encodeURIComponent(e.id) + "/thumbnail.jpg";
            img.onerror = function () { this.style.display = "none"; };
            card.appendChild(img);
          }
          var body = div("fg-event-body");
          var hdr = div("fg-event-camera", e.camera || "");
          body.appendChild(hdr);
          var labelRow = div("fg-event-label");
          labelRow.appendChild(span(labelCls(e.label), e.label || "unknown"));
          if (e.sub_label) {
            labelRow.appendChild(document.createTextNode(" " + e.sub_label));
          }
          if (typeof e.score === "number") {
            labelRow.appendChild(document.createTextNode(" " + Math.round(e.score * 100) + "%"));
          }
          body.appendChild(labelRow);
          body.appendChild(div("fg-event-time", relTime(e.start_time)));
          card.appendChild(body);
          host.appendChild(card);
        });
      }

      function showError(hostId, msg) {
        var host = document.getElementById(hostId);
        if (!host) return;
        clearKids(host);
        host.appendChild(div("fg-error", "Error: " + msg));
      }

      function loadCameras() {
        fetch("/api/frigate/cameras").then(function (r) { return r.json(); }).then(function (data) {
          if (data.error) return showError("fg-cameras", data.error);
          renderCameras(data.cameras);
        }).catch(function (err) { showError("fg-cameras", err.message); });
      }

      function loadEvents() {
        fetch("/api/frigate/events?limit=20").then(function (r) { return r.json(); }).then(function (data) {
          if (data.error) return showError("fg-events", data.error);
          renderEvents(data.events);
        }).catch(function (err) { showError("fg-events", err.message); });
      }

      function loadStats() {
        fetch("/api/frigate/stats").then(function (r) { return r.json(); }).then(function (data) {
          var target = document.getElementById("fg-stats");
          if (!target) return;
          if (data.error) { target.textContent = "Error: " + data.error; return; }
          var summary = {
            uptime_seconds: data.service && data.service.uptime,
            version: data.service && data.service.version,
            detectors: data.detectors ? Object.keys(data.detectors).map(function (k) {
              return { name: k, inference_ms: data.detectors[k].inference_speed };
            }) : [],
            processes: data.cpu_usages ? Object.keys(data.cpu_usages).length : 0,
          };
          target.textContent = JSON.stringify(summary, null, 2);
        }).catch(function (err) {
          var target = document.getElementById("fg-stats");
          if (target) target.textContent = "Fetch failed: " + err.message;
        });
      }

      if (document.getElementById("fg-cameras")) {
        loadCameras();
        loadEvents();
        loadStats();
      }
    })();
  `;
}
