/**
 * Crow's Nest Panel — Meta Glasses (pairing + status + profile overrides).
 *
 * All user-data rendering uses textContent + appendChild. No string-
 * interpolated HTML for device fields.
 */

const CLIENT_SCRIPT = `
(function() {
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

  async function refreshDevices() {
    var root = document.getElementById('mg-devices');
    try {
      var res = await fetch('/api/meta-glasses/devices', { credentials: 'same-origin' });
      var data = await res.json();
      renderDevices(data.devices || []);
    } catch (e) {
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

  renderCompat();
  refreshDevices();
  setInterval(refreshDevices, 5000);
})();
`;

export default {
  id: "meta-glasses",
  name: "Meta Glasses",
  icon: "eye",
  route: "/dashboard/meta-glasses",
  navOrder: 55,
  category: "hardware",

  async handler(req, res, { layout }) {
    const styles = `
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
    `;

    const content = `
      <style>${styles}</style>
      <div class="mg-wrap">
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
  },
};
