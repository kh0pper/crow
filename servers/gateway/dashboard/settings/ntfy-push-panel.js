/**
 * Settings › Notifications › Phone notifications (ntfy autowire, spec 2026-10-03).
 *
 * Status (configured / phone fetched the settings / last push result), the
 * phone-facing server address, and two buttons: set up / repair, and send a test.
 * Server-rendered form posts — no client JS.
 */
import { escapeHtml } from "../shared/components.js";
import { t } from "../shared/i18n.js";
import {
  resolveNtfyConfig, readNtfyStatus, recordNtfyStatus, readStoredNtfyConfig,
  writeStoredNtfyConfig, normalizeExternalUrl,
} from "../../push/ntfy-config.js";

export const NTFY_ACTIONS = new Set(["ntfy_setup", "ntfy_test", "ntfy_save_url"]);
const BACK = "/dashboard/settings?section=notifications";

// Test seams: the provisioner and the sender.
let _provision = null;
let _send = null;
export function _setNtfyPanelDepsForTest({ provision = null, send = null } = {}) { _provision = provision; _send = send; }

function when(iso, lang) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(lang === "es" ? "es" : "en", { dateStyle: "medium", timeStyle: "short" });
}

const row = (label, value) => `<div style="display:flex;gap:0.5rem;flex-wrap:wrap;margin:0.25rem 0;font-size:0.85rem">
  <span style="color:var(--crow-text-muted);min-width:11rem">${escapeHtml(label)}</span><span style="overflow-wrap:anywhere">${value}</span></div>`;

/**
 * @param {object} o
 * @param {string} o.csrf
 * @param {string} o.lang
 * @param {object} [o.env]
 * @param {string} [o.flash]  ntfy query param after a post: setup_ok|setup_fail|test_ok|test_fail|url_ok|url_bad|env
 */
export function renderNtfyPushPanel({ csrf, lang, env = process.env, flash = "" }) {
  let cfg = null;
  try { cfg = resolveNtfyConfig(env); } catch { cfg = null; }
  const status = readNtfyStatus(env);
  const ok = "var(--crow-accent)";
  const bad = "#e0533d";

  const flashMsg = {
    setup_ok: [t("ntfyPush.setupOk", lang), ok],
    setup_fail: [`${t("ntfyPush.setupFail", lang)}: ${status.lastSetupError || ""}`, bad],
    test_ok: [t("ntfyPush.testSent", lang), ok],
    test_fail: [`${t("ntfyPush.testFailed", lang)}: ${status.lastPushError || ""}`, bad],
    test_off: [t("ntfyPush.notConfigured", lang), bad],
    url_bad: [t("ntfyPush.badAddress", lang), bad],
    url_ok: [t("ntfyPush.addressSaved", lang), ok],
    env: [t("ntfyPush.envBlocks", lang), bad],
  }[flash];
  const flashHtml = flashMsg
    ? `<p role="status" style="font-size:0.85rem;color:${flashMsg[1]};margin:0 0 0.75rem">${escapeHtml(flashMsg[0])}</p>`
    : "";

  const form = (action, label, primary, extra = "") => `<form method="POST" action="/dashboard/settings" style="display:inline">
      <input type="hidden" name="_csrf" value="${escapeHtml(csrf)}" />
      <input type="hidden" name="action" value="${action}" />${extra}
      <button type="submit" class="btn${primary ? " btn-primary" : ""}">${escapeHtml(label)}</button>
    </form>`;

  let body;
  if (!cfg) {
    body = `<p style="color:var(--crow-text-muted);font-size:0.85rem">${escapeHtml(t("ntfyPush.notConfigured", lang))}</p>
      <div style="display:flex;gap:0.5rem;flex-wrap:wrap">${form("ntfy_setup", t("ntfyPush.setup", lang), true)}</div>`;
  } else {
    const source = cfg.source === "env" ? t("ntfyPush.sourceEnv", lang) : t("ntfyPush.sourceAuto", lang);
    const addressLine = cfg.externalUrl
      ? `<code>${escapeHtml(cfg.externalUrl)}</code>${env.NTFY_EXTERNAL_URL ? ` <span style="color:var(--crow-text-muted)">(${escapeHtml(t("ntfyPush.addressEnv", lang))})</span>` : ""}`
      : `<span style="color:${bad}">${escapeHtml(t("ntfyPush.addressNone", lang))}</span>`;
    const app = status.appFetchedAt
      ? escapeHtml(when(status.appFetchedAt, lang))
      : `<span style="color:var(--crow-text-muted)">${escapeHtml(t("ntfyPush.appNever", lang))}</span>`;
    let last;
    if (!status.lastPushAt) last = `<span style="color:var(--crow-text-muted)">${escapeHtml(t("ntfyPush.lastNone", lang))}</span>`;
    else if (status.lastPushOk) last = `<span style="color:${ok}">✓ ${escapeHtml(when(status.lastPushAt, lang))}</span>`;
    else last = `<span style="color:${bad}">${escapeHtml(t("ntfyPush.lastFail", lang))} — ${escapeHtml(when(status.lastPushAt, lang))}: ${escapeHtml(status.lastPushError || "")}</span>`;

    const urlForm = cfg.source === "auto" && !env.NTFY_EXTERNAL_URL
      ? `<form method="POST" action="/dashboard/settings" style="margin-top:0.75rem">
      <input type="hidden" name="_csrf" value="${escapeHtml(csrf)}" />
      <input type="hidden" name="action" value="ntfy_save_url" />
      <label for="ntfy-external-url" style="display:block;font-size:0.85rem;margin-bottom:0.25rem">${escapeHtml(t("ntfyPush.address", lang))}</label>
      <div style="display:flex;gap:0.5rem;flex-wrap:wrap">
        <input id="ntfy-external-url" name="external_url" type="url" inputmode="url" value="${escapeHtml(cfg.storedExternalUrl)}" placeholder="https://" style="flex:1;min-width:14rem" />
        <button type="submit" class="btn">${escapeHtml(t("ntfyPush.saveAddress", lang))}</button>
      </div>
      <p style="color:var(--crow-text-muted);font-size:0.8rem;margin:0.25rem 0 0">${escapeHtml(t("ntfyPush.addressHelp", lang))}</p>
    </form>`
      : "";

    body = `${row(t("ntfyPush.channel", lang), `<code>${escapeHtml(cfg.topic)}</code> <span style="color:var(--crow-text-muted)">· ${escapeHtml(source)}</span>`)}
      ${row(t("ntfyPush.address", lang), addressLine)}
      ${row(t("ntfyPush.appFetched", lang), app)}
      ${row(t("ntfyPush.lastOk", lang), last)}
      ${urlForm}
      <div style="display:flex;gap:0.5rem;flex-wrap:wrap;margin-top:0.75rem">
        ${form("ntfy_test", t("ntfyPush.test", lang), true)}
        ${cfg.source === "auto" ? form("ntfy_setup", t("ntfyPush.repair", lang), false) : ""}
      </div>`;
  }

  return `<div id="ntfy-push" style="margin-top:1.5rem;padding-top:1rem;border-top:1px solid var(--crow-border)">
    <h4 style="margin:0 0 0.5rem 0;font-size:0.95rem">${escapeHtml(t("ntfyPush.title", lang))}</h4>
    <p style="color:var(--crow-text-muted);font-size:0.85rem;margin-bottom:0.75rem">${escapeHtml(t("ntfyPush.intro", lang))}</p>
    ${flashHtml}${body}
  </div>`;
}

/** Handles ntfy_* actions; returns false for anything else. */
export async function handleNtfyPushAction({ req, res, action, lang = "en", env = process.env }) {
  if (!NTFY_ACTIONS.has(action)) return false;
  const back = (code) => res.redirectAfterPost(`${BACK}&ntfy=${code}#ntfy-push`);

  if (action === "ntfy_setup") {
    if (env.NTFY_TOPIC) { back("env"); return true; }
    const provision = _provision || (await import("../../push/ntfy-provision.js")).provisionNtfy;
    const r = await provision({ env });
    recordNtfyStatus({ lastSetupAt: new Date().toISOString(), lastSetupOk: !!r.ok, lastSetupError: r.ok ? null : String(r.reason || "").slice(0, 300) }, env);
    back(r.ok ? "setup_ok" : "setup_fail");
    return true;
  }

  if (action === "ntfy_save_url") {
    const stored = readStoredNtfyConfig(env);
    const next = normalizeExternalUrl(req.body?.external_url);
    if (!stored || next === null) { back("url_bad"); return true; }
    writeStoredNtfyConfig({ ...stored, externalUrl: next }, env);
    back("url_ok");
    return true;
  }

  // ntfy_test
  const send = _send || (await import("../../push/ntfy.js")).sendNtfyNotification;
  const r = await send({
    title: t("ntfyPush.testTitle", lang),
    body: t("ntfyPush.testBody", lang),
    url: BACK,
    priority: "normal",
    type: "system",
  });
  back(r?.ok ? "test_ok" : r?.skipped ? "test_off" : "test_fail");
  return true;
}
