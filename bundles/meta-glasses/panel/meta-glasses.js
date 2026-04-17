/**
 * Crow's Nest Panel — Meta Glasses (pairing + status + profile overrides).
 *
 * All user-data rendering uses textContent + appendChild. No string-
 * interpolated HTML for device fields.
 */

const CLIENT_SCRIPT = `
(function() {
  // Under Turbo Drive, this IIFE re-executes on every navigation into the
  // meta-glasses panel. Kill any prior refresh interval so concurrent
  // re-entries don't stack pollers. Element-level listeners (the buttons
  // below) are safely re-attached to the fresh DOM each time.
  if (window.__mgRefreshInterval) {
    clearInterval(window.__mgRefreshInterval);
    window.__mgRefreshInterval = null;
  }

  var MG_REQUIRED_APP = "1.4.0";

  function cmpVer(a, b) {
    var pa = (a||"0").split(".").map(function(n){return parseInt(n,10)||0;});
    var pb = (b||"0").split(".").map(function(n){return parseInt(n,10)||0;});
    for (var i = 0; i < Math.max(pa.length, pb.length); i++) {
      var d = (pa[i]||0) - (pb[i]||0);
      if (d !== 0) return d < 0 ? -1 : 1;
    }
    return 0;
  }
  function detectAppVersion() {
    // Primary signal: the native JS bridge. window.Crow is only injected
    // by the Crow Android app's CrowBridge (see MainActivity.java).
    if (window.Crow && typeof window.Crow.appVersion === "function") {
      try {
        var v = window.Crow.appVersion();
        if (v) return v;
      } catch (_) {}
    }
    // Fallback: UA sniff (can be stale right after an app upgrade).
    var ua = navigator.userAgent || "";
    var m = ua.match(/CrowAndroid\\/(\\d+\\.\\d+(?:\\.\\d+)?)/);
    return m ? m[1] : null;
  }
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }
  function el(tag, attrs, text) {
    var e = document.createElement(tag);
    if (attrs) for (var k in attrs) { if (k === "className") e.className = attrs[k]; else e.setAttribute(k, attrs[k]); }
    if (text !== undefined && text !== null) e.textContent = String(text);
    return e;
  }

  function renderCompat() {
    var bar = document.getElementById('mg-compat');
    clear(bar);
    bar.style.display = 'block';
    var ver = detectAppVersion();
    if (!ver) {
      bar.style.borderColor = 'var(--crow-warning, #b45309)';
      bar.appendChild(el('strong', null, '\u26A0\uFE0F  Crow Android app not detected.'));
      bar.appendChild(document.createTextNode(' Open this page in the Crow Android app (1.4.0+) to pair glasses. If you have it but this bar still shows, the app is older than 1.4.0.'));
      return;
    }
    if (cmpVer(ver, MG_REQUIRED_APP) < 0) {
      bar.style.borderColor = 'var(--crow-warning, #b45309)';
      bar.appendChild(el('strong', null, '\u26A0\uFE0F  Crow Android app ' + ver + ' detected.'));
      bar.appendChild(document.createTextNode(' Version ' + MG_REQUIRED_APP + '+ is required for glasses pairing. Update from the Crow releases page.'));
      return;
    }
    // Compatible — confirm visibly rather than hiding. Color-blind-safe:
    // text + icon + copy all convey the state without relying on hue.
    bar.style.borderColor = 'var(--crow-success, #15803d)';
    bar.appendChild(el('strong', null, '\u2705  Ready to pair.'));
    bar.appendChild(document.createTextNode(' Crow Android app ' + ver + ' detected — tap Pair new glasses below to begin.'));
  }

  function renderDevices(devices) {
    var root = document.getElementById('mg-devices');
    clear(root);
    if (!devices || devices.length === 0) {
      root.appendChild(el('div', { className: 'mg-empty' },
        'No glasses paired yet. Tap Pair new glasses above to begin.'));
      return;
    }
    devices.forEach(function(d) {
      var card = el('div', { className: 'mg-card' });
      var header = el('div');
      var lastSeenMs = d.last_seen ? new Date(d.last_seen).getTime() : 0;
      var online = lastSeenMs && (Date.now() - lastSeenMs < 30000);
      header.appendChild(el('span', { className: 'mg-status-dot' + (online ? ' online' : '') }));
      header.appendChild(el('span', { className: 'mg-card-name' }, d.name || d.id));
      var gen = el('span', { className: 'mg-badge' + (d.generation === 'gen2' ? '' : ' mg-badge-warn') },
        d.generation === 'gen2' ? 'Gen 2' : 'Unknown');
      header.appendChild(gen);
      card.appendChild(header);

      var meta = el('div', { className: 'mg-card-meta' });
      var pairedAt = d.paired_at ? new Date(d.paired_at).toLocaleString() : '?';
      var lastSeen = d.last_seen ? new Date(d.last_seen).toLocaleString() : 'never';
      meta.appendChild(document.createTextNode('paired ' + pairedAt + ' · last seen ' + lastSeen));
      if (d.household_profile) meta.appendChild(document.createTextNode(' · profile: ' + d.household_profile));
      card.appendChild(meta);

      // Per-device OCR toggle (Phase 5 B.2). Off by default; enabling
      // runs a second vision call per capture to extract text and
      // writes it to the searchable library after redacting a small
      // set of PII patterns. Disclaimer copy is verbatim from the plan.
      var ocrRow = el('div', { className: 'mg-ocr-row' });
      ocrRow.style.cssText = 'margin-top:0.5rem;padding-top:0.5rem;border-top:1px solid var(--crow-border)';
      var ocrLabel = el('label', { className: 'mg-ocr-label' });
      ocrLabel.style.cssText = 'display:flex;align-items:center;gap:0.5rem;font-size:0.85rem;cursor:pointer';
      var ocrCheckbox = el('input');
      ocrCheckbox.type = 'checkbox';
      ocrCheckbox.checked = !!d.ocr_enabled;
      ocrCheckbox.addEventListener('change', function() {
        setOcrEnabled(d.id, ocrCheckbox.checked, ocrCheckbox);
      });
      ocrLabel.appendChild(ocrCheckbox);
      ocrLabel.appendChild(el('span', null, 'Enable OCR on captures'));
      ocrRow.appendChild(ocrLabel);
      var ocrHelp = el('div', { className: 'mg-ocr-help' });
      ocrHelp.style.cssText = 'font-size:0.72rem;color:var(--crow-text-muted);margin-top:0.35rem;line-height:1.4';
      ocrHelp.textContent = "OCR-extracted text becomes searchable. We redact a small set of patterns (SSN, credit card, email, phone) but cannot redact names, addresses, account numbers, or personal info that doesn't match those patterns. The original photo is never modified. OCR is off by default.";
      ocrRow.appendChild(ocrHelp);
      card.appendChild(ocrRow);

      var actions = el('div', { className: 'mg-actions' });
      var rotateBtn = el('button', { className: 'btn btn-secondary btn-sm' }, 'Rotate token');
      rotateBtn.addEventListener('click', function() { rotateToken(d.id, rotateBtn); });
      var unpairBtn = el('button', { className: 'btn btn-secondary btn-sm' }, 'Unpair');
      unpairBtn.style.color = 'var(--crow-error)';
      unpairBtn.addEventListener('click', function() { unpair(d.id, unpairBtn); });
      actions.appendChild(rotateBtn);
      actions.appendChild(unpairBtn);
      card.appendChild(actions);

      root.appendChild(card);
    });
  }

  async function setOcrEnabled(id, enabled, checkbox) {
    checkbox.disabled = true;
    try {
      var res = await fetch('/api/meta-glasses/devices/' + encodeURIComponent(id), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ ocr_enabled: enabled }),
      });
      var data = await res.json();
      if (!data.ok) {
        checkbox.checked = !enabled; // revert
      }
    } catch (e) {
      checkbox.checked = !enabled; // revert on network failure
    } finally {
      checkbox.disabled = false;
    }
  }

  async function refreshDevices() {
    var root = document.getElementById('mg-devices');
    // Bail if the panel was unmounted (e.g., Turbo navigated away between
    // poll tick and fetch completion). Prevents null.appendChild crashes.
    if (!root) return;
    try {
      var res = await fetch('/api/meta-glasses/devices', { credentials: 'same-origin' });
      var data = await res.json();
      if (!document.getElementById('mg-devices')) return;
      renderDevices(data.devices || []);
    } catch (e) {
      if (!root.isConnected) return;
      clear(root);
      var err = el('div', { className: 'mg-empty' }, 'Failed to load devices: ' + e.message);
      err.style.color = 'var(--crow-error)';
      root.appendChild(err);
    }
  }

  async function unpair(id, btn) {
    if (!confirm('Unpair these glasses? Any active session will be closed.')) return;
    btn.disabled = true;
    await fetch('/api/meta-glasses/devices/' + encodeURIComponent(id), { method: 'DELETE', credentials: 'same-origin' });
    refreshDevices();
  }

  async function rotateToken(id, btn) {
    btn.disabled = true;
    btn.textContent = 'Rotating…';
    try {
      var res = await fetch('/api/meta-glasses/pair', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ id: id })
      });
      var data = await res.json();
      if (data.ok && data.token) {
        window.prompt('New bearer token (copy into the Crow Android app):', data.token);
      } else {
        alert('Rotate failed: ' + (data.error || 'unknown error'));
      }
    } finally {
      btn.disabled = false;
      btn.textContent = 'Rotate token';
      refreshDevices();
    }
  }

  function pairFromAndroid() {
    if (window.Crow && typeof window.Crow.launchGlassesPairing === 'function') {
      window.Crow.launchGlassesPairing();
    } else {
      alert("Open this page in the Crow Android app (1.4.0+). The app's JS bridge exposes Crow.launchGlassesPairing(); this dashboard tab cannot pair directly because DAT requires Bluetooth access on the phone.");
    }
  }

  var ptt = { active: false };
  async function sendTurn(action) {
    try {
      var res = await fetch('/api/meta-glasses/turn', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ action: action })
      });
      return await res.json();
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }
  async function toggleTalk() {
    var btn = document.getElementById('mg-talk-btn');
    var status = document.getElementById('mg-talk-status');
    if (!ptt.active) {
      status.textContent = 'Starting turn...';
      var begin = await sendTurn('begin');
      if (!begin.ok || !begin.delivered) {
        status.textContent = 'No connected glasses session.';
        return;
      }
      ptt.active = true;
      btn.textContent = 'Stop';
      btn.classList.add('btn-danger');
      status.textContent = 'Listening — speak, then press Stop.';
    } else {
      status.textContent = 'Ending turn...';
      await sendTurn('end');
      ptt.active = false;
      btn.textContent = 'Ask Crow';
      btn.classList.remove('btn-danger');
      status.textContent = 'Processing...';
    }
  }

  async function pushSay() {
    var text = (document.getElementById('mg-say-text').value || '').trim();
    if (!text) return;
    var status = document.getElementById('mg-say-status');
    status.textContent = 'Sending...';
    try {
      var res = await fetch('/api/meta-glasses/say', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ text: text })
      });
      var data = await res.json();
      status.textContent = data.ok
        ? ('Delivered to ' + (data.delivered || 0) + ' of ' + (data.targeted || 0) + ' sessions.')
        : ('Failed: ' + (data.error || 'unknown'));
    } catch (e) {
      status.textContent = 'Error: ' + e.message;
    }
  }

  document.getElementById('mg-pair-btn').addEventListener('click', pairFromAndroid);
  document.getElementById('mg-say-btn').addEventListener('click', pushSay);
  document.getElementById('mg-talk-btn').addEventListener('click', toggleTalk);

  renderCompat();
  refreshDevices();
  window.__mgRefreshInterval = setInterval(refreshDevices, 5000);
})();
`;

export default {
  id: "meta-glasses",
  name: "Meta Glasses",
  icon: "eye",
  route: "/dashboard/meta-glasses",
  navOrder: 55,
  category: "hardware",

  async handler(req, res, { db, layout }) {
    const tab = req.query.tab === "library" ? "library" : "pair";
    const styles = SHARED_STYLES;
    const tabBar = renderTabBar(tab);

    if (tab === "library") {
      return renderLibraryTab({ req, res, db, layout, styles, tabBar });
    }

    return renderPairTab({ req, res, layout, styles, tabBar });
  },
};

const SHARED_STYLES = `
  .mg-wrap { max-width: 780px; }
  .mg-hero { border: 1px solid var(--crow-border); border-radius: 12px; padding: 1rem 1.25rem; margin-bottom: 1rem; background: var(--crow-surface); }
  .mg-hero h1 { margin: 0 0 0.25rem; font-size: 1.1rem; }
  .mg-hero p { margin: 0; color: var(--crow-text-muted); font-size: 0.9rem; }
  .mg-card { border: 1px solid var(--crow-border); border-radius: 10px; padding: 0.75rem 1rem; margin-bottom: 0.5rem; background: var(--crow-surface); }
  .mg-card-name { font-weight: 600; font-size: 0.95rem; }
  .mg-card-meta { font-size: 0.8rem; color: var(--crow-text-muted); margin-top: 0.25rem; }
  .mg-actions { display: flex; gap: 0.5rem; margin-top: 0.5rem; flex-wrap: wrap; }
  .mg-empty { text-align: center; color: var(--crow-text-muted); padding: 2rem 1rem; border: 1px dashed var(--crow-border); border-radius: 10px; }
  .mg-badge { font-size: 0.65rem; padding: 0.1rem 0.4rem; border-radius: 3px; background: var(--crow-accent); color: #fff; font-weight: 600; margin-left: 0.4rem; }
  .mg-badge-warn { background: var(--crow-warning, #b45309); }
  .mg-status-dot { display: inline-block; width: 0.6rem; height: 0.6rem; border-radius: 50%; margin-right: 0.4rem; background: var(--crow-text-muted); }
  .mg-status-dot.online { background: var(--crow-success); }
  .mg-tabs { display: flex; gap: 0.25rem; margin-bottom: 1rem; border-bottom: 1px solid var(--crow-border); }
  .mg-tab { padding: 0.5rem 0.85rem; font-size: 0.85rem; color: var(--crow-text-muted); text-decoration: none; border-bottom: 2px solid transparent; margin-bottom: -1px; }
  .mg-tab.active { color: var(--crow-text); border-bottom-color: var(--crow-accent); font-weight: 500; }
  .mg-tab:hover { color: var(--crow-text); }
  .mg-lib-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 0.75rem; }
  .mg-lib-card { border: 1px solid var(--crow-border); border-radius: 8px; overflow: hidden; background: var(--crow-surface); display: flex; flex-direction: column; }
  .mg-lib-thumb { width: 100%; height: 140px; object-fit: cover; background: var(--crow-bg-deep, #111); display: block; }
  .mg-lib-thumb-link { background: var(--crow-bg-deep, #111); height: 140px; display: flex; align-items: center; justify-content: center; color: var(--crow-text-muted); font-size: 0.75rem; text-decoration: none; }
  .mg-lib-caption { padding: 0.4rem 0.55rem; font-size: 0.78rem; color: var(--crow-text); line-height: 1.35; }
  .mg-lib-date { font-size: 0.68rem; color: var(--crow-text-muted); padding: 0 0.55rem 0.4rem; }
  .mg-lib-actions { padding: 0 0.55rem 0.55rem; display: flex; gap: 0.3rem; }
  .mg-lib-search { display: flex; gap: 0.5rem; margin-bottom: 0.75rem; }
  .mg-lib-search input { flex: 1; padding: 0.45rem 0.6rem; background: var(--crow-bg-deep, #111); border: 1px solid var(--crow-border); border-radius: 4px; color: var(--crow-text); font-size: 0.85rem; }
  .mg-lib-detail { border: 1px solid var(--crow-border); border-radius: 10px; padding: 1rem; margin-bottom: 1rem; background: var(--crow-surface); }
  .mg-lib-detail img { max-width: 100%; height: auto; border-radius: 6px; display: block; margin-bottom: 0.75rem; }
`;

function renderTabBar(active) {
  return `<nav class="mg-tabs">
    <a href="/dashboard/meta-glasses" class="mg-tab ${active === "pair" ? "active" : ""}">Devices</a>
    <a href="/dashboard/meta-glasses?tab=library" class="mg-tab ${active === "library" ? "active" : ""}">Library</a>
  </nav>`;
}

function renderPairTab({ res, layout, styles, tabBar }) {
  const content = `
    <style>${styles}</style>
    <div class="mg-wrap">
      ${tabBar}
      <div class="mg-hero">
        <h1>Meta Glasses</h1>
        <p>Pair Meta Ray-Ban (Gen 2) smart glasses and drive them with your Crow BYOAI.</p>
      </div>

      <div id="mg-compat" class="mg-card" style="display:none"></div>

      <div style="display:flex;align-items:center;justify-content:space-between;margin:1rem 0 0.5rem">
        <h2 style="margin:0;font-size:0.9rem;text-transform:uppercase;letter-spacing:0.08em;color:var(--crow-text-muted)">Paired devices</h2>
        <button id="mg-pair-btn" class="btn btn-primary btn-sm">Pair new glasses</button>
      </div>

      <div id="mg-devices"></div>

      <div class="mg-card" style="margin-top:1rem">
        <div style="display:flex;align-items:center;gap:0.75rem">
          <button id="mg-talk-btn" class="btn btn-primary" style="min-width:120px">Ask Crow</button>
          <div id="mg-talk-status" style="font-size:0.85rem;color:var(--crow-text-muted)"></div>
        </div>
        <div style="font-size:0.75rem;color:var(--crow-text-muted);margin-top:0.5rem">
          Starts a voice turn on the first connected glasses session. Speak through the glasses, then press Stop.
        </div>
      </div>

      <details style="margin-top:1.5rem">
        <summary style="cursor:pointer;font-size:0.85rem;color:var(--crow-text-muted)">Developer tools</summary>
        <div style="margin-top:0.5rem;padding:0.75rem 1rem;border:1px solid var(--crow-border);border-radius:8px;background:var(--crow-surface)">
          <p style="font-size:0.8rem;margin:0 0 0.5rem">Push a line of speech to all connected sessions:</p>
          <div style="display:flex;gap:0.5rem">
            <input id="mg-say-text" placeholder="Hello from Crow" style="flex:1;padding:0.4rem;background:var(--crow-bg-deep,#111);border:1px solid var(--crow-border);border-radius:4px;color:var(--crow-text);font-size:0.85rem">
            <button id="mg-say-btn" class="btn btn-secondary btn-sm">Say</button>
          </div>
          <div id="mg-say-status" style="font-size:0.8rem;margin-top:0.35rem;color:var(--crow-text-muted)"></div>
        </div>
      </details>
    </div>

    <script>${CLIENT_SCRIPT}<\/script>`;

  res.send(layout({ title: "Meta Glasses", content }));
}

function escH(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

async function renderLibraryTab({ req, res, db, layout, styles, tabBar }) {
  const q = String(req.query.q || "").trim();
  const detailId = req.query.id ? parseInt(String(req.query.id), 10) : null;
  const page = Math.max(1, parseInt(String(req.query.page || "1"), 10) || 1);
  const PAGE_SIZE = 24;
  const offset = (page - 1) * PAGE_SIZE;

  // Build a per-request mint function for presigned URLs. Falls back to the
  // legacy disk route when MinIO is unavailable or minio_key is NULL.
  let s3Ready = false;
  let mintUrl = null;
  try {
    const { isAvailable, getPresignedUrl } = await import("../../../servers/storage/s3-client.js");
    s3Ready = await isAvailable();
    mintUrl = getPresignedUrl;
  } catch {}
  async function urlFor(row) {
    if (s3Ready && row.minio_key && mintUrl) {
      try { return await mintUrl(row.minio_key, { expiry: 3600 }); } catch {}
    }
    const name = String(row.disk_path || "").split("/").pop();
    return name ? `/api/meta-glasses/photo/${encodeURIComponent(name)}` : null;
  }

  // Query: FTS when q, recency otherwise. Always include pagination.
  let rows = [];
  let total = 0;
  try {
    if (q) {
      const countRow = await db.execute({
        sql: `SELECT COUNT(*) AS n FROM glasses_photos g JOIN glasses_photos_fts f ON g.id = f.rowid
              WHERE glasses_photos_fts MATCH ?`,
        args: [q],
      });
      total = Number(countRow.rows?.[0]?.n ?? 0);
      const r = await db.execute({
        sql: `SELECT g.id, g.device_id, g.captured_at, g.disk_path, g.minio_key, g.caption, g.ocr_text
              FROM glasses_photos g JOIN glasses_photos_fts f ON g.id = f.rowid
              WHERE glasses_photos_fts MATCH ?
              ORDER BY g.captured_at DESC LIMIT ? OFFSET ?`,
        args: [q, PAGE_SIZE, offset],
      });
      rows = r.rows;
    } else {
      const countRow = await db.execute("SELECT COUNT(*) AS n FROM glasses_photos");
      total = Number(countRow.rows?.[0]?.n ?? 0);
      const r = await db.execute({
        sql: `SELECT id, device_id, captured_at, disk_path, minio_key, caption, ocr_text
              FROM glasses_photos ORDER BY captured_at DESC LIMIT ? OFFSET ?`,
        args: [PAGE_SIZE, offset],
      });
      rows = r.rows;
    }
  } catch (err) {
    console.warn(`[meta-glasses] library query failed: ${err.message}`);
  }

  // Detail row takes precedence (still inside the frame so back-nav swaps).
  let detailHtml = "";
  if (detailId) {
    try {
      const r = await db.execute({
        sql: `SELECT id, device_id, captured_at, disk_path, minio_key, mime, size_bytes, caption, ocr_text
              FROM glasses_photos WHERE id = ?`,
        args: [detailId],
      });
      const d = r.rows[0];
      if (d) {
        const detailUrl = await urlFor(d);
        const when = escH(d.captured_at);
        const dev = escH(d.device_id);
        const caption = d.caption ? `<p style="margin:0 0 0.5rem;font-size:0.95rem">${escH(d.caption)}</p>` : "";
        const ocr = d.ocr_text ? `<div style="margin:0.5rem 0"><div style="font-size:0.75rem;color:var(--crow-text-muted);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:0.25rem">OCR</div><pre style="font-size:0.82rem;white-space:pre-wrap;margin:0;background:var(--crow-bg-deep,#111);padding:0.5rem;border-radius:4px">${escH(d.ocr_text)}</pre></div>` : "";
        const img = detailUrl ? `<img src="${escH(detailUrl)}" alt="${escH(d.caption || "")}">` : `<div class="mg-empty">Image unavailable.</div>`;
        detailHtml = `<div class="mg-lib-detail">
          ${img}
          ${caption}
          ${ocr}
          <div style="font-size:0.75rem;color:var(--crow-text-muted);margin:0.25rem 0 0.75rem">${dev} · ${when}${d.size_bytes ? ` · ${Math.round(d.size_bytes / 1024)} KB` : ""}${d.mime ? ` · ${escH(d.mime)}` : ""}</div>
          <div style="display:flex;gap:0.5rem;flex-wrap:wrap">
            <a href="/dashboard/meta-glasses?tab=library" class="btn btn-secondary btn-sm">Back</a>
            <form method="POST" action="/dashboard/meta-glasses/library/delete" style="display:inline" onsubmit="return confirm('Delete this photo? This removes the MinIO object + DB row.')">
              <input type="hidden" name="id" value="${d.id}">
              <button class="btn btn-sm" style="background:var(--crow-error);color:#fff;border-color:var(--crow-error)" type="submit">Delete</button>
            </form>
          </div>
        </div>`;
      } else {
        detailHtml = `<div class="mg-empty">Photo ${detailId} not found.</div>`;
      }
    } catch (err) {
      detailHtml = `<div class="mg-empty">Error loading photo: ${escH(err.message)}</div>`;
    }
  }

  const thumbsMarkup = rows.length === 0
    ? (q
        ? `<div class="mg-empty">No matches for "${escH(q)}".</div>`
        : `<div class="mg-empty">No photos captured yet. Ask the AI to take a photo through your glasses.</div>`)
    : (await Promise.all(rows.map(async (r) => {
        const url = await urlFor(r);
        const captionText = r.caption || (r.ocr_text ? r.ocr_text.slice(0, 80) : "(no caption)");
        const when = r.captured_at ? escH(r.captured_at).replace("T", " ").slice(0, 16) : "";
        const thumb = url && (r.minio_key || r.disk_path)
          ? `<a href="/dashboard/meta-glasses?tab=library&id=${r.id}"><img class="mg-lib-thumb" src="${escH(url)}" alt="${escH(captionText)}"></a>`
          : `<a href="/dashboard/meta-glasses?tab=library&id=${r.id}" class="mg-lib-thumb-link">photo unavailable</a>`;
        return `<div class="mg-lib-card">
          ${thumb}
          <div class="mg-lib-caption">${escH(captionText).slice(0, 80)}</div>
          <div class="mg-lib-date">${when}</div>
        </div>`;
      }))).join("");

  // Pagination
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  let paginationHtml = "";
  if (totalPages > 1) {
    const bits = [];
    const base = `/dashboard/meta-glasses?tab=library${q ? `&q=${encodeURIComponent(q)}` : ""}`;
    if (page > 1) bits.push(`<a href="${base}&page=${page - 1}" class="btn btn-sm btn-secondary">Prev</a>`);
    bits.push(`<span style="color:var(--crow-text-muted);font-size:0.82rem">${page} / ${totalPages} · ${total} photo${total === 1 ? "" : "s"}</span>`);
    if (page < totalPages) bits.push(`<a href="${base}&page=${page + 1}" class="btn btn-sm btn-secondary">Next</a>`);
    paginationHtml = `<div style="display:flex;align-items:center;justify-content:center;gap:1rem;margin-top:1rem">${bits.join("")}</div>`;
  }

  // Invariant: EVERY `?tab=library` GET response renders the
  // <turbo-frame id="mg-library-results"> wrapper at the same DOM
  // position. Turbo scopes its frame-swap by ID — if the post-delete
  // 303 lands on a response that conditionally omits the frame, the
  // swap silently no-ops and the user sees stale markup.
  const content = `
    <style>${styles}</style>
    <div class="mg-wrap">
      ${tabBar}
      <form class="mg-lib-search" method="GET" action="/dashboard/meta-glasses" data-turbo-frame="mg-library-results">
        <input type="hidden" name="tab" value="library">
        <input type="text" name="q" value="${escH(q)}" placeholder="Search captions + OCR text (FTS5)">
        <button type="submit" class="btn btn-primary btn-sm">Search</button>
        ${q ? `<a href="/dashboard/meta-glasses?tab=library" data-turbo-frame="mg-library-results" class="btn btn-secondary btn-sm">Clear</a>` : ""}
      </form>
      <turbo-frame id="mg-library-results" data-turbo-action="advance">
        ${detailHtml}
        <div class="mg-lib-grid">${thumbsMarkup}</div>
        ${paginationHtml}
      </turbo-frame>
    </div>`;

  res.send(layout({ title: "Meta Glasses — Library", content }));
}
