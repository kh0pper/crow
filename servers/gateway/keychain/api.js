/**
 * /dashboard/keychain/api/* — the only door through which keychain plaintext reaches a
 * browser. Mounted after dashboardAuth + csrfMiddleware (dashboard/index.js), so every
 * request is a signed-in dashboard session with a valid CSRF echo; peer-signed requests
 * are refused here. Plaintext is returned only by /reveal (re-auth grant) and /first-view
 * (one-time grant); the passphrase-sealed Export only by its one-time link, which a granted
 * POST /export mints. Every response is Cache-Control: no-store; nothing secret is logged.
 */
import { Router } from "express";
import { createDbClient, auditLog } from "../../db.js";
import { createNotification } from "../../shared/notifications.js";
import { verifyPassword } from "../dashboard/auth.js";
import { is2faEnabled, getTotpSecret, verifyTotp } from "../dashboard/totp.js";
import { createReauthGate } from "./reauth.js";
import { loadKeychainKey } from "./key.js";
import { sealExport, openExport, MIN_PASSPHRASE } from "./export.js";
import {
  listEntries, getEntry, openEntrySecret, consumeFirstView, addManualSecret, deleteEntry,
  exportableEntries, importEntries, ensureWriteKey,
} from "./store.js";
import { vaultwardenStatus, saveToVault } from "./vault-save.js";
import { recordKeychainExport, recordKeychainImport, exportSnapshot } from "./reminder.js";
import { createExportTickets } from "./export-tickets.js";
import { invalidateHealthCache } from "../dashboard/panels/nest/health-signals.js";

const BASE = "/dashboard/keychain/api";

async function readPasswordHash() {
  const db = createDbClient();
  try {
    const r = await db.execute("SELECT value FROM dashboard_settings WHERE key = 'password_hash'");
    return r.rows[0]?.value || null;
  } finally {
    db.close();
  }
}

export function defaultReauthGate() {
  return createReauthGate({
    is2faEnabled,
    hasDashboardPassword: async () => !!(await readPasswordHash()),
    verifyTotpCode: async (code) => verifyTotp(code, await getTotpSecret()),
    verifyDashboardPassword: async (pw) => {
      const stored = await readPasswordHash();
      if (!stored || !pw) return false;
      try { return await verifyPassword(pw, stored); } catch { return false; }
    },
  });
}

const auditDetails = (e) => ({ entry_id: e.id, label: e.label, bundle_id: e.bundle_id || null, env_key: e.env_key || null });
const str = (v, max) => (typeof v === "string" && v.length > 0 && v.length <= max ? v : null);
const KEY_MISSING = { code: "key_missing", error: "This password was saved under a keychain key that is not on this machine. Import an Export file to recover it, or delete it." };

export function keychainApiRouter({
  openDb = () => createDbClient(),
  crowHome = undefined, // the keychain key lives in <crowHome>/secrets (default: CROW_HOME)
  gate = defaultReauthGate(),
  vault = { status: vaultwardenStatus, save: saveToVault },
  audit = auditLog,
  notify = createNotification,
  tickets = createExportTickets(),
} = {}) {
  const router = Router();

  router.use(BASE, (req, res, next) => {
    if (req.headers["x-crow-signature"]) return res.status(403).json({ error: "The keychain is not available to paired instances." });
    if (!req.dashboardSession) return res.status(401).json({ error: "Sign in first." });
    res.set("Cache-Control", "no-store");
    next();
  });

  const readKey = () => loadKeychainKey({ crowHome });
  // Saving creates the key on first use; a key created while entries already exist means
  // the old key was lost — audit it and tell the user once (re-review m2).
  const writeKey = (db, ip) => ensureWriteKey(db, {
    crowHome,
    onNewKey: async ({ orphaned }) => {
      await audit(db, "keychain_key_created", { ip, details: { orphaned } });
      try { await notify(db, { title: "New Crow keychain key created", body: `${orphaned} saved password(s) were sealed with a key that is no longer on this machine. Import an Export file in Settings → Security & passwords → Saved passwords & keys to recover them.`, type: "system", source: "keychain" }); } catch {}
    },
  });

  const withDb = (handler) => async (req, res) => {
    const db = openDb();
    try {
      await handler(req, res, db);
    } catch (err) {
      if (err?.code === "KEYCHAIN_KEY_MISSING") { if (!res.headersSent) res.status(409).json(KEY_MISSING); return; }
      if (err?.code === "KEYCHAIN_KEY_INVALID") { if (!res.headersSent) res.status(409).json({ code: "key_invalid", error: err.message }); return; }
      console.error("[keychain] request failed:", err?.code || err?.name || "error");
      if (!res.headersSent) res.status(500).json({ error: "Keychain error. Nothing was revealed." });
    } finally {
      try { db.close(); } catch {}
    }
  };

  const requireGrant = async (req, res) => {
    if ((await gate.method()) === "none") {
      res.status(403).json({ code: "reauth_unavailable", error: "Set a dashboard password or two-factor authentication first: Crow needs one to confirm it's you." });
      return false;
    }
    if (gate.isGranted(req.dashboardSession)) return true;
    res.status(403).json({ code: "reauth_required", error: "Confirm it's you first." });
    return false;
  };

  router.get(`${BASE}/entries`, withDb(async (req, res, db) => {
    const st = vault.status();
    const key = readKey();
    res.json({
      entries: await listEntries(db, { keyId: key?.id || null }),
      key_present: !!key,
      reauth_method: await gate.method(),
      granted_until: gate.expiresAt(req.dashboardSession),
      vault_available: !!(st && st.installed && st.cliPath && st.secure && !st.serverOutdated),
    });
  }));

  router.post(`${BASE}/reauth`, withDb(async (req, res, db) => {
    const out = await gate.verify(req.dashboardSession, { password: req.body?.password, totp_code: req.body?.totp_code });
    if (out.ok) {
      await audit(db, "keychain_reauth_ok", { ip: req.ip, details: { method: out.method } });
      return res.json({ ok: true, method: out.method, expires_at: out.expires_at });
    }
    if (out.unavailable) return res.status(403).json({ code: "reauth_unavailable", error: out.error });
    if (out.locked) return res.status(429).json({ error: out.error, locked_until: out.locked_until });
    await audit(db, "keychain_reauth_failed", { ip: req.ip, details: { method: out.method || null } });
    if (out.global_lock_started) {
      await audit(db, "keychain_reauth_lockout", { ip: req.ip, details: { scope: "instance" } });
      try { await notify(db, { title: "Crow keychain locked for an hour", body: "Too many wrong confirmations to reveal saved passwords. If this was not you, change your dashboard password.", type: "system", source: "keychain" }); } catch {}
    }
    return res.status(401).json({ error: out.error });
  }));

  router.post(`${BASE}/reveal`, withDb(async (req, res, db) => {
    if (!(await requireGrant(req, res))) return;
    const purpose = req.body?.purpose === "copy" ? "copy" : "reveal";
    const entry = await getEntry(db, Number(req.body?.id));
    if (!entry) return res.status(404).json({ error: "No such password." });
    const secret = await openEntrySecret(db, readKey(), entry.id);
    await audit(db, purpose === "copy" ? "keychain_copy" : "keychain_reveal", { ip: req.ip, details: auditDetails(entry) });
    res.json({ secret });
  }));

  router.post(`${BASE}/first-view`, withDb(async (req, res, db) => {
    const entry = await getEntry(db, Number(req.body?.id));
    if (!entry) return res.status(404).json({ error: "No such password." });
    const secret = await consumeFirstView(db, readKey(), entry.id);
    if (secret === null) return res.status(410).json({ code: "first_view_spent", error: "Already shown. Open Settings → Security & passwords → Saved passwords & keys to see it again." });
    await audit(db, "keychain_first_view", { ip: req.ip, details: auditDetails(entry) });
    res.json({ secret });
  }));

  router.post(`${BASE}/add`, withDb(async (req, res, db) => {
    const label = str(req.body?.label?.trim?.(), 200);
    const secret = str(req.body?.secret, 1024);
    if (!label || !secret || /[\0]/.test(secret)) return res.status(400).json({ error: "A label and a password are required." });
    const username = str(req.body?.username, 256);
    const url = str(req.body?.url, 2048);
    if (url && !/^https?:\/\//i.test(url)) return res.status(400).json({ error: "The address must start with http:// or https://." });
    const { id } = await addManualSecret(db, await writeKey(db, req.ip), { label, username, url, secret });
    await audit(db, "keychain_add", { ip: req.ip, details: { entry_id: id, label } });
    res.json({ ok: true, id });
  }));

  router.post(`${BASE}/delete`, withDb(async (req, res, db) => {
    if (!(await requireGrant(req, res))) return;
    const entry = await getEntry(db, Number(req.body?.id));
    if (!entry) return res.status(404).json({ error: "No such password." });
    // C5: a generated token may be the ONLY plaintext of a hash the extension still uses.
    if (entry.origin === "generated" && entry.status === "active" && req.body?.confirm_generated !== true) {
      return res.status(409).json({ code: "generated_in_use", error: `Crow generated this and keeps no other copy: without it you may not be able to sign in to ${entry.bundle_id || "the extension"}, or read data it encrypted. Export or save it elsewhere first.` });
    }
    await deleteEntry(db, entry.id);
    await audit(db, "keychain_delete", { ip: req.ip, details: auditDetails(entry) });
    res.json({ ok: true });
  }));

  // Export is two steps (2026-10-20): POST seals the file and parks it behind a one-time,
  // 2-minute, same-session link; GET serves it once as a real attachment, which a browser and
  // the Crow app can both save (a blob: download in the page was dropped by the app's WebView).
  // The Nest reminder is recorded only once the file was served, or, when the page asks with
  // ?confirm=1 (the Crow app), only once it says the file was saved (POST /export/saved).
  router.post(`${BASE}/export`, withDb(async (req, res, db) => {
    if (!(await requireGrant(req, res))) return;
    const passphrase = typeof req.body?.passphrase === "string" ? req.body.passphrase : "";
    if (passphrase.length < MIN_PASSPHRASE) return res.status(400).json({ error: `Choose a passphrase of at least ${MIN_PASSPHRASE} characters.` });
    const key = readKey();
    if (!key) return res.status(409).json(KEY_MISSING);
    const snapshot = await exportSnapshot(db, key.id).catch(() => null);
    const entries = await exportableEntries(db, key);
    const file = await sealExport(entries, passphrase);
    const filename = `crow-keychain-${new Date().toISOString().slice(0, 10)}.json`;
    const { token, expiresAt } = tickets.issue(req.dashboardSession, { file, filename, keyId: key.id, snapshot, count: entries.length });
    res.json({ ok: true, count: entries.length, filename, token, download: `${BASE}/export/file/${token}`, expires_at: new Date(expiresAt).toISOString() });
  }));

  const TICKET_ERRORS = {
    not_found: [404, "export_link_unknown", "This download link is not yours, or it was replaced by a newer Export."],
    used: [410, "export_link_used", "This download link was already used. Export again."],
    expired: [410, "export_link_expired", "This download link expired. Export again."],
    not_served: [409, "export_not_fetched", "The file was not downloaded yet."],
  };
  const ticketError = (res, error) => {
    const [status, code, message] = TICKET_ERRORS[error] || TICKET_ERRORS.not_found;
    return res.status(status).json({ code, error: message });
  };
  const recordExport = async (record) => {
    if (!record?.snapshot) return;
    const db = openDb();
    try { await recordKeychainExport(db, record.keyId, record.snapshot); } catch {} finally { try { db.close(); } catch {} }
    invalidateHealthCache();
  };

  router.all(`${BASE}/export/file/:token`, withDb(async (req, res, db) => {
    // Express runs GET handlers for HEAD too: a HEAD (a link preview, a prober) must never
    // spend the one download.
    if (req.method !== "GET") return res.status(405).set("Allow", "GET").json({ error: "GET only." });
    // Nor may a prefetch (Turbo, speculation rules, a browser preloader) spend it.
    const purpose = ["sec-purpose", "purpose", "x-sec-purpose", "x-purpose", "x-moz"].map((h) => String(req.headers[h] || "")).join(" ");
    if (/prefetch|prerender|preview/i.test(purpose)) return res.status(409).json({ code: "export_link_prefetch", error: "Not on a prefetch." });
    // The Crow app saves through its own bridge and then confirms; a GET from its WebView
    // (a navigation, which an app without a download listener drops) never counts as saved.
    const deferRecord = req.query?.confirm === "1" || String(req.headers["user-agent"] || "").includes("CrowAndroid/");
    const out = tickets.take(req.params.token, req.dashboardSession, { deferRecord });
    if (out.error) return ticketError(res, out.error);
    // Every fetch is audited (the sealed file left the server). A deferred one went to the app's
    // page and may still be cancelled there, so it does not read "Exported".
    try { await audit(db, deferRecord ? "keychain_export_fetched" : "keychain_export", { ip: req.ip, details: { count: out.count } }); } catch {} // the ticket is spent: always deliver
    // The reminder clears once the body was handed to the socket, never earlier.
    if (out.record) res.once("finish", () => { recordExport(out.record); });
    res.set("Content-Type", "application/json; charset=utf-8");
    res.set("Content-Disposition", `attachment; filename="${out.filename}"`);
    res.set("X-Content-Type-Options", "nosniff");
    res.send(JSON.stringify(out.file));
  }));

  router.post(`${BASE}/export/saved`, withDb(async (req, res, db) => {
    const out = tickets.confirm(req.body?.token, req.dashboardSession);
    if (out.error) return ticketError(res, out.error);
    await recordExport(out);
    try { await audit(db, "keychain_export_saved", { ip: req.ip, details: { count: out.count } }); } catch {}
    res.json({ ok: true });
  }));

  router.post(`${BASE}/import`, withDb(async (req, res, db) => {
    if (!(await requireGrant(req, res))) return;
    const entries = await openExport(req.body?.file, typeof req.body?.passphrase === "string" ? req.body.passphrase : "");
    if (!entries) return res.status(400).json({ error: "That passphrase does not open this file, or it is not a Crow keychain export." });
    const ikey = await writeKey(db, req.ip);
    const { ids, ...out } = await importEntries(db, ikey, entries);
    await recordKeychainImport(db, ikey.id, ids).catch(() => {});
    invalidateHealthCache();
    await audit(db, "keychain_import", { ip: req.ip, details: out });
    res.json({ ok: true, ...out });
  }));

  router.post(`${BASE}/vault-save`, withDb(async (req, res, db) => {
    if (!(await requireGrant(req, res))) return;
    const st = vault.status();
    if (!st || !st.installed || !st.cliPath) return res.status(409).json({ ok: false, reason: "Install or update the Vaultwarden extension first." });
    if (st.serverOutdated) return res.status(409).json({ ok: false, reason: st.serverOutdated });
    const email = str(req.body?.vault_email?.trim?.(), 320);
    const masterPassword = str(req.body?.vault_password, 1024);
    if (!email || !masterPassword) return res.status(400).json({ ok: false, reason: "Enter your vault email and master password." });
    const entry = await getEntry(db, Number(req.body?.id));
    if (!entry) return res.status(404).json({ ok: false, reason: "No such password." });
    const secret = await openEntrySecret(db, readKey(), entry.id);
    const out = await vault.save({
      cliPath: st.cliPath, serverUrl: st.serverUrl, email, masterPassword,
      item: { name: entry.label, username: entry.username, password: secret, url: entry.url, notes: entry.bundle_id ? `Saved by Crow (${entry.bundle_id} / ${entry.env_key})` : "Saved by Crow" },
    });
    await audit(db, "keychain_vault_save", { ip: req.ip, details: { ...auditDetails(entry), ok: !!out.ok, reason: out.ok ? null : out.reason } });
    res.json(out.ok ? { ok: true } : { ok: false, reason: out.reason });
  }));

  router.get(`${BASE}/activity`, withDb(async (_req, res, db) => {
    const { rows } = await db.execute("SELECT event_type, created_at, details FROM audit_log WHERE event_type LIKE 'keychain_%' ORDER BY id DESC LIMIT 25");
    res.json({ events: rows.map((r) => ({ event: r.event_type, at: r.created_at, details: (() => { try { return JSON.parse(r.details || "{}"); } catch { return {}; } })() })) });
  }));

  return router;
}
