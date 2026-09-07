/**
 * Crow's Nest Panel — Ramble.
 *
 * Map (vendored Leaflet) + compose + the 3x3 privacy grid + the pet mount.
 * COPIED ALONE to `$CROW_HOME/panels/ramble.js` at install, so it carries no
 * relative `../server/*` import; anything it needs from the bundle is resolved
 * through BUNDLE_DIR at request time. Every HTTP surface it talks to lives in
 * the companion `panel/routes.js` (STRICT_PANEL_MOUNT contract).
 *
 * The page is rendered static: grid state, marks and pet mood are all fetched
 * by `static/ramble.js` from `/api/ramble/*`, so the panel still renders when
 * the bundle's server modules or the db are unavailable.
 */

const OSM_ATTRIBUTION = "&copy; OpenStreetMap contributors";

const AUDIENCES = ["public", "contacts", "groups"];
const CHANNELS = ["ble", "lan", "geo"];

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export default {
  id: "ramble",
  name: "Ramble",
  icon: "map-pin",
  route: "/dashboard/ramble",
  navOrder: 120,
  category: "social",

  async handler(req, res, { db, layout }) {
    // Spec §11: OpenStreetMap public tiles are the phase-1 default, with the
    // tile URL configurable in settings. The URL itself is NOT rendered here:
    // the dashboard CSP is img-src 'self', so the client always draws from the
    // same-origin proxy (/ramble/tiles) and the proxy is what reads
    // `ramble_settings.tile_url`. Only the attribution is a page concern.
    let tileAttribution = OSM_ATTRIBUTION;
    if (db) {
      try {
        const { rows } = await db.execute({
          sql: "SELECT value FROM ramble_settings WHERE key = 'tile_attribution'",
          args: [],
        });
        if (rows[0]?.value) tileAttribution = String(rows[0].value);
      } catch { /* default */ }
    }

    const gridRows = AUDIENCES.map((audience) => {
      const cells = CHANNELS.map((channel) => `
              <td><input type="checkbox" class="rb-grid-cell" name="grid-${esc(audience)}-${esc(channel)}"
                    data-audience="${esc(audience)}" data-channel="${esc(channel)}"
                    aria-label="${esc(audience)} over ${esc(channel)}"></td>`).join("");
      return `
            <tr><th scope="row">${esc(audience)}</th>${cells}</tr>`;
    }).join("");

    const content = `
      <style>
        .rb-card { background:var(--crow-bg-surface); border:1px solid var(--crow-border);
          border-radius:8px; padding:0.9rem 1rem; margin-bottom:1rem; }
        #ramble-map { height:420px; width:100%; border-radius:8px; border:1px solid var(--crow-border);
          background:var(--crow-bg); touch-action: none; overscroll-behavior: contain; }
        .rb-compose { display:flex; flex-direction:column; gap:0.5rem; }
        .rb-compose textarea { width:100%; min-height:4.5rem; padding:0.45rem 0.6rem; border-radius:6px;
          border:1px solid var(--crow-border); background:var(--crow-bg); color:var(--crow-text);
          font:inherit; resize:vertical; }
        .rb-compose-row { display:flex; flex-wrap:wrap; gap:0.6rem; align-items:center; }
        .rb-compose select { padding:0.35rem 0.5rem; border-radius:6px; border:1px solid var(--crow-border);
          background:var(--crow-bg); color:var(--crow-text); }
        .rb-btn { padding:0.4rem 0.9rem; background:var(--crow-accent); color:var(--crow-accent-contrast);
          border:none; border-radius:6px; cursor:pointer; font-size:0.85rem; }
        .rb-btn-secondary { background:var(--crow-bg); color:var(--crow-text); border:1px solid var(--crow-border); }
        .rb-grid { border-collapse:collapse; }
        .rb-grid th, .rb-grid td { padding:0.35rem 0.75rem; border-bottom:1px solid var(--crow-border);
          text-align:center; }
        .rb-grid th[scope="row"] { text-align:left; font-weight:600; }
        .rb-muted { color:var(--crow-text-muted); font-size:0.85rem; }
        #ramble-marks { list-style:none; padding:0; margin:0.5rem 0 0; }
        #ramble-marks li { padding:0.4rem 0; border-bottom:1px solid var(--crow-border); font-size:0.9rem; }
        #ramble-pet { display:flex; align-items:center; gap:0.75rem; }
        #ramble-pet .rb-pet-line { font-size:0.85rem; color:var(--crow-text-muted); }

        /* ─── Ramble pet crow (panel-scoped copy of the header Tamagotchi,
             servers/gateway/dashboard/shared/notifications.js — SVG markup +
             mood CSS, sans onclick/thought-bubble/exclaim; keyframe names
             prefixed rb- so nothing collides with the header crow). ─── */
        #ramble-pet .rb-crow { display:block; overflow:visible; }

        @keyframes rb-crow-bounce-happy {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(-3px); }
        }
        @keyframes rb-crow-bounce-tired {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(-2px); }
        }
        @keyframes rb-crow-blink {
          0%, 92%, 100% { opacity: 1; }
          95% { opacity: 0; }
        }
        @keyframes rb-crow-flap {
          0%, 100% { transform: rotateZ(0deg); }
          50% { transform: rotateZ(-20deg); }
        }
        @keyframes rb-crow-droop {
          0%, 100% { transform: rotateZ(5deg); }
          50% { transform: rotateZ(10deg); }
        }

        #ramble-pet .crow-happy .crow-body-group { animation: rb-crow-bounce-happy 2s ease-in-out infinite; }
        #ramble-pet .crow-happy .crow-eye { animation: rb-crow-blink 4s step-end infinite; }
        #ramble-pet .crow-happy .crow-wing { animation: none; }
        #ramble-pet .crow-happy .crow-beak { fill: #d9a521; }

        #ramble-pet .crow-tired .crow-body-group { animation: rb-crow-bounce-tired 3s ease-in-out infinite; }
        #ramble-pet .crow-tired .crow-eye { animation: rb-crow-blink 6s step-end infinite; }
        #ramble-pet .crow-tired .crow-wing { animation: rb-crow-droop 3s ease-in-out infinite; }
        #ramble-pet .crow-tired .crow-beak { fill: #c8c864; }

        #ramble-pet .crow-alarmed .crow-body-group { animation: rb-crow-bounce-happy 1s ease-in-out infinite; }
        #ramble-pet .crow-alarmed .crow-eye { animation: rb-crow-blink 2s step-end infinite; }
        #ramble-pet .crow-alarmed .crow-wing { animation: rb-crow-flap 0.3s ease-in-out infinite; }
        #ramble-pet .crow-alarmed .crow-beak { fill: #c8c864; }
      </style>
      <link rel="stylesheet" href="/ramble/static/leaflet/leaflet.css">

      <div class="rb-card">
        <div id="ramble-map" data-tile-attribution="${esc(tileAttribution)}"></div>
        <p class="rb-muted" id="ramble-map-status">Move the map to pick the area you listen to.</p>
      </div>

      <div class="rb-card rb-compose">
        <h3 style="margin:0">Say something here</h3>
        <textarea id="rb-text" maxlength="2000" placeholder="A note for whoever passes by&hellip;"></textarea>
        <div class="rb-compose-row">
          <label for="rb-visibility">Audience</label>
          <select id="rb-visibility">
            <option value="public">public</option>
            <option value="contacts">contacts</option>
          </select>
          <label for="rb-reveal">Reveal</label>
          <select id="rb-reveal">
            <option value="locked">locked &mdash; only in range</option>
            <option value="open">open</option>
          </select>
          <button class="rb-btn" id="rb-leave-mark" type="button">Leave mark</button>
          <button class="rb-btn rb-btn-secondary" id="rb-caw" type="button">Caw</button>
        </div>
        <p class="rb-muted" id="rb-compose-status">Marks are stored locally and queued; the transport decides what actually goes out.</p>
      </div>

      <div class="rb-card">
        <h3 style="margin-top:0">Who can see me</h3>
        <p class="rb-muted">Nothing broadcasts unless the master switch <em>and</em> the specific cell are on.</p>
        <label><input type="checkbox" id="rb-master"> I&rsquo;m visible (master switch)</label>
        <table class="rb-grid">
          <thead><tr><th></th>${CHANNELS.map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead>
          <tbody>${gridRows}</tbody>
        </table>
        <p class="rb-compose-row">
          <label for="rb-identity">Public identity</label>
          <select id="rb-identity">
            <option value="rotating">rotating</option>
            <option value="pseudonym">pseudonym</option>
            <option value="real">real</option>
          </select>
        </p>
        <p class="rb-muted" id="rb-grid-status"></p>
      </div>

      <div class="rb-card">
        <h3 style="margin-top:0">Your crow</h3>
        <div id="ramble-pet">
          <svg class="rb-crow crow-happy" id="ramble-pet-crow" viewBox="0 0 48 56" width="42" height="49">
            <g class="crow-body-group">
              <g class="crow-feet">
                <line x1="19" y1="42" x2="17" y2="48" stroke="#0e6b62" stroke-width="1.5" stroke-linecap="round"/>
                <line x1="19" y1="42" x2="21" y2="48" stroke="#0e6b62" stroke-width="1.5" stroke-linecap="round"/>
                <line x1="29" y1="42" x2="27" y2="48" stroke="#0e6b62" stroke-width="1.5" stroke-linecap="round"/>
                <line x1="29" y1="42" x2="31" y2="48" stroke="#0e6b62" stroke-width="1.5" stroke-linecap="round"/>
              </g>
              <ellipse class="crow-body" cx="24" cy="34" rx="12" ry="10" fill="#0e6b62"/>
              <ellipse class="crow-wing" cx="14" cy="33" rx="6" ry="8" fill="#4fbdb0" opacity="0.5" transform-origin="14 33"/>
              <circle class="crow-head" cx="24" cy="18" r="9" fill="#0e6b62"/>
              <circle class="crow-eye" cx="28" cy="16" r="3" fill="#d9a521"/>
              <circle class="crow-pupil" cx="29" cy="16" r="1.5" fill="#22303a"/>
              <polygon class="crow-beak" points="33,18 40,20 33,22" fill="#d9a521"/>
            </g>
          </svg>
          <div class="rb-pet-line" id="ramble-pet-line">loading&hellip;</div>
        </div>
      </div>

      <div class="rb-card">
        <h3 style="margin-top:0">Nearby</h3>
        <ul id="ramble-marks"></ul>
      </div>

      <script src="/ramble/static/leaflet/leaflet.js"></script>
      <script src="/ramble/static/ramble.js"></script>
    `;

    res.send(layout({ title: "Ramble", content }));
  },
};
