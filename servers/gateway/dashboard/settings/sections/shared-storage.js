/**
 * Settings Section: Shared Storage (Multi-Instance group)
 *
 * Lets the operator configure a single MinIO/S3 endpoint that every paired
 * Crow instance uses for object storage. Endpoint + region + bucket_prefix
 * + use_ssl replicate via the sync-allowlist entry "storage.shared.*";
 * access_key + secret_key are sealed with secret-box before write so the
 * ciphertext is safe to replicate over the (signed-but-not-encrypted)
 * instance-sync feed.
 *
 * Save handler pre-flights the new credentials with a listBuckets() call
 * before committing, so bad creds fail at save-time rather than at next
 * upload.
 */

import { escapeHtml } from "../../shared/components.js";
import * as Minio from "minio";
import { readSetting, readSettings, writeSetting } from "../registry.js";
import { isSealed, openSecret, sealSecret } from "../../../../sharing/secret-box.js";
import { loadOrCreateIdentity } from "../../../../sharing/identity.js";
import { resetStorageClient } from "../../../../storage/s3-client.js";

const KEYS = {
  endpoint: "storage.shared.endpoint",
  useSSL: "storage.shared.use_ssl",
  region: "storage.shared.region",
  prefix: "storage.shared.bucket_prefix",
  accessKey: "storage.shared.access_key",
  secretKey: "storage.shared.secret_key",
  autoApply: "storage.local.auto_apply_to_bundles",
};

function _splitHostPort(endpoint) {
  let s = String(endpoint || "").trim().replace(/^https?:\/\//, "").split("/")[0];
  const c = s.lastIndexOf(":");
  if (c === -1) return { host: s, port: 9000 };
  return { host: s.slice(0, c), port: parseInt(s.slice(c + 1), 10) || 9000 };
}

async function _readAll(db) {
  const m = await readSettings(db, "storage.%");
  return {
    endpoint: m.get(KEYS.endpoint) || "",
    useSSL: m.get(KEYS.useSSL) === "true",
    region: m.get(KEYS.region) || "us-east-1",
    prefix: m.get(KEYS.prefix) || "crow",
    accessSealed: m.get(KEYS.accessKey) || "",
    secretSealed: m.get(KEYS.secretKey) || "",
    autoApply: m.get(KEYS.autoApply) === "true",
  };
}

function _buildClient({ endpoint, useSSL, accessKey, secretKey }) {
  const { host, port } = _splitHostPort(endpoint);
  return new Minio.Client({ endPoint: host, port, useSSL, accessKey, secretKey });
}

export default {
  id: "shared-storage",
  group: "multiInstance",
  icon: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/><path d="M3 12c0 1.66 4 3 9 3s9-1.34 9-3"/></svg>`,
  labelKey: "settings.section.sharedStorage",
  navOrder: 35,

  async getPreview({ db }) {
    try {
      const cfg = await _readAll(db);
      if (!cfg.endpoint) return "Not configured";
      return `${cfg.endpoint} · ${cfg.prefix}-*`;
    } catch {
      return "-";
    }
  },

  async render({ db }) {
    const cfg = await _readAll(db);
    const maskedAccess = cfg.accessSealed ? "••••••••" : "";
    const maskedSecret = cfg.secretSealed ? "••••••••" : "";

    return `<style>
      .ss-grid { display:grid; grid-template-columns:180px 1fr; gap:0.75rem 1rem; align-items:center; }
      .ss-grid label { color:var(--crow-text-muted); font-size:0.85rem; }
      .ss-grid input[type=text],
      .ss-grid input[type=password] {
        width:100%; padding:6px 10px; background:var(--crow-bg-deep); border:1px solid var(--crow-border);
        border-radius:3px; color:var(--crow-text); font-family:'JetBrains Mono',monospace; font-size:0.9rem;
      }
      .ss-btn {
        padding:6px 14px; background:var(--crow-bg-deep); border:1px solid var(--crow-border);
        border-radius:3px; color:var(--crow-text); cursor:pointer; font-size:0.85rem;
      }
      .ss-btn.primary { background:var(--crow-accent); border-color:var(--crow-accent); color:#000; font-weight:500; }
      .ss-btn:hover { filter:brightness(1.1); }
      .ss-actions { display:flex; gap:0.5rem; margin-top:1rem; }
      .ss-status { margin-top:0.75rem; padding:0.5rem; border-radius:3px; display:none; font-size:0.85rem; }
      .ss-status.ok { display:block; background:#0a3a1e; color:#7fe0a0; }
      .ss-status.err { display:block; background:#3a0a1a; color:#f77ea0; }
      .ss-note { margin-top:1rem; font-size:0.82rem; color:var(--crow-text-muted); line-height:1.4; }
    </style>

    <div style="margin-bottom:1rem;font-size:0.85rem;color:var(--crow-text-muted)">
      One MinIO/S3 endpoint shared across every paired Crow instance. Endpoint + region + bucket prefix
      replicate via sync-allowlist. Access and secret keys replicate <em>sealed</em> (AES-256-GCM with an
      identity-derived key) so the ciphertext in sync feeds never exposes plaintext.
    </div>

    <form id="ss-form" class="ss-grid" onsubmit="return false">
      <label>Endpoint</label>
      <input name="endpoint" type="text" value="${escapeHtml(cfg.endpoint)}" placeholder="100.118.41.122:9000" />

      <label>Use SSL</label>
      <div><input name="use_ssl" type="checkbox" ${cfg.useSSL ? "checked" : ""}/> <span style="font-size:0.85rem;color:var(--crow-text-muted)">HTTPS instead of HTTP</span></div>

      <label>Region</label>
      <input name="region" type="text" value="${escapeHtml(cfg.region)}" placeholder="us-east-1" />

      <label>Bucket prefix</label>
      <input name="prefix" type="text" value="${escapeHtml(cfg.prefix)}" placeholder="crow" />

      <label>Access key</label>
      <input name="access_key" type="text" value="${escapeHtml(maskedAccess)}" placeholder="${cfg.accessSealed ? "(leave to keep current)" : "crowadmin"}" />

      <label>Secret key</label>
      <input name="secret_key" type="password" value="${escapeHtml(maskedSecret)}" placeholder="${cfg.secretSealed ? "(leave to keep current)" : ""}" autocomplete="new-password" />

      <label>Auto-apply to bundles</label>
      <div><input name="auto_apply" type="checkbox" ${cfg.autoApply ? "checked" : ""}/> <span style="font-size:0.85rem;color:var(--crow-text-muted)">Force-recreate S3-capable bundles on save (local-only, not synced)</span></div>
    </form>

    <div class="ss-actions">
      <button class="ss-btn primary" id="ss-save">Save</button>
      <button class="ss-btn" id="ss-test">Test connection</button>
    </div>

    <div class="ss-status" id="ss-status"></div>

    <div class="ss-note">
      Pre-flight: save runs <code>listBuckets()</code> with the entered creds and refuses to commit on failure.
      Leaving access/secret blank keeps the currently-sealed values.
    </div>

    <div id="ss-bundles" style="margin-top:1.5rem;padding-top:1rem;border-top:1px solid var(--crow-border);font-size:0.9rem">
      <div style="color:var(--crow-text-muted);font-size:0.82rem;margin-bottom:0.5rem">Bundles using shared storage</div>
      <div id="ss-bundles-list" style="color:var(--crow-text-muted);font-size:0.85rem">Loading…</div>
    </div>

    <script>
    (function() {
      const form = document.getElementById('ss-form');
      const status = document.getElementById('ss-status');
      function show(kind, msg) { status.className = 'ss-status ' + kind; status.textContent = msg; }
      function clear() { status.className = 'ss-status'; status.textContent = ''; }
      function payload() {
        const d = new FormData(form);
        const obj = {
          endpoint: d.get('endpoint')?.trim() || '',
          use_ssl: d.get('use_ssl') === 'on',
          region: d.get('region')?.trim() || 'us-east-1',
          bucket_prefix: d.get('prefix')?.trim() || 'crow',
          auto_apply_to_bundles: d.get('auto_apply') === 'on',
        };
        const ak = d.get('access_key') || '';
        const sk = d.get('secret_key') || '';
        if (ak && ak !== '••••••••') obj.access_key = ak;
        if (sk && sk !== '••••••••') obj.secret_key = sk;
        return obj;
      }
      async function apiCall(action, data) {
        const f = new FormData();
        f.append('action', action);
        f.append('payload', JSON.stringify(data));
        const res = await fetch(window.location.pathname + window.location.search, {
          method: 'POST', body: f, credentials: 'same-origin',
        });
        const text = await res.text();
        let json; try { json = JSON.parse(text); } catch { json = { ok: res.ok, text }; }
        return { ok: res.ok, json };
      }
      document.getElementById('ss-save').addEventListener('click', async () => {
        clear();
        const r = await apiCall('save', payload());
        if (r.ok) show('ok', r.json?.message || '✓ Saved');
        else show('err', r.json?.error || '✗ Save failed');
      });
      document.getElementById('ss-test').addEventListener('click', async () => {
        clear();
        const r = await apiCall('test', payload());
        if (r.ok) show('ok', '✓ Connected. ' + (r.json?.buckets?.length || 0) + ' bucket(s): ' + (r.json?.buckets || []).slice(0,6).join(', '));
        else show('err', r.json?.error || '✗ Connection failed');
      });

      function mkEl(tag, attrs, text) {
        const el = document.createElement(tag);
        if (attrs) for (const k in attrs) el.setAttribute(k, attrs[k]);
        if (text != null) el.textContent = text;
        return el;
      }
      function mkPill(state) {
        const labels = { ok: 'in sync', drift: 'drifted — apply', missing: 'missing — apply', none: 'no config' };
        const styles = {
          ok: 'background:#0a3a1e;color:#7fe0a0',
          drift: 'background:#3a2b0a;color:#f3c26e',
          missing: 'background:#3a0a1a;color:#f77ea0',
          none: 'background:#222;color:#888',
        };
        return mkEl('span', { style: styles[state] + ';padding:2px 8px;border-radius:3px;font-size:0.78rem' }, labels[state]);
      }
      async function loadBundles() {
        const el = document.getElementById('ss-bundles-list');
        try {
          const res = await fetch('/dashboard/bundles/api/shared-storage/status', { credentials: 'same-origin' });
          if (!res.ok) { el.textContent = 'Could not load bundle status.'; return; }
          const data = await res.json();
          el.textContent = '';
          if (!data.bundles || data.bundles.length === 0) {
            el.appendChild(mkEl('em', null, 'No installed bundles declare shared storage.'));
            return;
          }
          for (const b of data.bundles) {
            const state = b.drift ? 'drift' : b.missing ? 'missing' : b.onDiskVersion ? 'ok' : 'none';
            const row = mkEl('div', { style: 'display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid var(--crow-border)' });
            const left = mkEl('div');
            left.appendChild(mkEl('strong', null, b.name));
            left.appendChild(mkEl('span', { style: 'color:var(--crow-text-muted);font-size:0.78rem' }, ' · ' + b.bucket));
            const right = mkEl('div', { style: 'display:flex;gap:0.5rem;align-items:center' });
            right.appendChild(mkPill(state));
            if (state === 'drift' || state === 'missing') {
              const btn = mkEl('button', { class: 'ss-btn', 'data-apply-id': b.id, style: 'padding:3px 10px;font-size:0.8rem' }, 'Apply');
              btn.addEventListener('click', async () => {
                btn.disabled = true;
                btn.textContent = 'Applying…';
                const r = await fetch('/dashboard/bundles/api/shared-storage/apply/' + encodeURIComponent(b.id), { method: 'POST', credentials: 'same-origin' });
                if (r.ok) loadBundles();
                else { btn.disabled = false; btn.textContent = 'Apply (failed)'; }
              });
              right.appendChild(btn);
            }
            row.appendChild(left);
            row.appendChild(right);
            el.appendChild(row);
          }
        } catch (e) { el.textContent = 'Error: ' + e.message; }
      }
      loadBundles();
    })();
    </script>
    `;
  },

  async handleAction({ req, res, db, action }) {
    if (action !== "save" && action !== "test") return false;

    let payload;
    try { payload = JSON.parse(req.body?.payload || "{}"); }
    catch { res.status(400).json({ error: "bad payload" }); return true; }

    const current = await _readAll(db);
    const identity = loadOrCreateIdentity();

    // Resolve effective access/secret for the pre-flight. If the operator didn't
    // touch the field, use the stored (sealed) value opened in-memory.
    let accessKey = payload.access_key;
    if (!accessKey) accessKey = current.accessSealed ? openSecret(current.accessSealed, identity) : "";
    let secretKey = payload.secret_key;
    if (!secretKey) secretKey = current.secretSealed ? openSecret(current.secretSealed, identity) : "";

    const endpoint = payload.endpoint;
    const useSSL = !!payload.use_ssl;

    if (!endpoint) {
      res.status(400).json({ error: "endpoint required" });
      return true;
    }
    if (!accessKey || !secretKey) {
      res.status(400).json({ error: "access_key and secret_key required" });
      return true;
    }

    // Pre-flight: listBuckets with the exact config the save would commit.
    let buckets;
    try {
      const client = _buildClient({ endpoint, useSSL, accessKey, secretKey });
      const list = await client.listBuckets();
      buckets = list.map((b) => b.name);
    } catch (err) {
      res.status(400).json({ error: `MinIO pre-flight failed: ${err.message}` });
      return true;
    }

    if (action === "test") {
      res.json({ ok: true, buckets });
      return true;
    }

    // save — commit all six sync-scoped keys + the local-only auto-apply flag
    const region = payload.region || "us-east-1";
    const prefix = payload.bucket_prefix || "crow";

    await writeSetting(db, KEYS.endpoint, endpoint, { scope: "global" });
    await writeSetting(db, KEYS.useSSL, useSSL ? "true" : "false", { scope: "global" });
    await writeSetting(db, KEYS.region, region, { scope: "global" });
    await writeSetting(db, KEYS.prefix, prefix, { scope: "global" });
    // Only re-seal if the value actually changed (avoid churning the sync feed
    // with fresh nonces every save when nothing rotated).
    if (payload.access_key) {
      await writeSetting(db, KEYS.accessKey, sealSecret(accessKey, identity), { scope: "global" });
    }
    if (payload.secret_key) {
      await writeSetting(db, KEYS.secretKey, sealSecret(secretKey, identity), { scope: "global" });
    }
    await writeSetting(db, KEYS.autoApply, payload.auto_apply_to_bundles ? "true" : "false", { scope: "local" });

    // Invalidate the storage client so subsequent uploads pick up fresh config.
    try { resetStorageClient(); } catch {}

    res.json({ ok: true, message: `✓ Saved · ${buckets.length} bucket(s) reachable` });
    return true;
  },
};
