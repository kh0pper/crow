/**
 * Bot Builder — delete a bot with blast-radius confirmation (Item 5 PR2,
 * spec §D5).
 *
 * The confirmation page is a plain GET (?bot=<id>&confirm_delete=1) so there
 * is no render-on-POST concern; the destructive action is a PRG POST
 * (action="delete_confirm") handled in api-handlers.js.
 *
 * Cleanup list (spec §D5). The bot_id-keyed tables have NO FK cascades
 * (bare TEXT bot_id), so this list is their integrity mechanism. The
 * contacts row is DIFFERENT: contacts(id) has ON DELETE CASCADE children —
 * messages, shared_items, message_retry_queue, contact_group_members — so
 * deleting the local-bot contact also deletes the user's DM history with
 * this bot and its group memberships. That is deliberate (a deleted bot's
 * conversation references a dead endpoint) but MUST be disclosed on the
 * confirm page (PR #191 review M1):
 *   - pi_bot_defs row
 *   - bot_sessions rows
 *   - bot_message_seen rows (stale dedup rows would make a RECREATED same-id
 *     bot silently ignore messages)
 *   - bot_skill_events rows
 *   - the bot_id entry in the remote_managed_bots settings JSON list
 *   - the bot's contacts row (origin='local-bot') via DIRECT SQL — the
 *     contact-delete.js helper deliberately refuses local-bot rows
 *     ("recreated at boot"), which no longer holds once the def is gone
 *   - best-effort (optional features, try/catch per step): bot_message_acl,
 *     bot_message_invites, unbinding devices whose bound_bot_id matches
 *     (via device-store helpers — devices are a JSON blob in
 *     dashboard_settings, never raw SQL)
 * The workspace directory on disk is deliberately KEPT (user data).
 *
 * The bot's git key (per-bot git access, C5) is the one on-disk thing that is
 * removed: a key dir under the instance's 0700 secrets dir belongs to a bot id
 * that is about to stop existing, so leaving it would be a live credential for
 * nothing. Its fingerprint goes back on the redirect, so the owner is told
 * which deploy key to take off the forge. A failed removal never fails the
 * delete (the bot is gone either way): the redirect names the leftover folder
 * instead, and the next boot sweep (post-listen.js) tries again.
 */

import { escapeHtml, section, callout } from "../../shared/components.js";
import { csrfInput } from "../../shared/csrf.js";
import { t, fill } from "../../shared/i18n.js";
import { readSetting, writeSetting } from "../../settings/registry.js";
import { emitBotDefsChanged } from "./defs-changed.js";
import { isVoiceBotId } from "../../../../shared/voice-bot.js";
import { isFingerprint } from "../../../../shared/bot-git/host-keys.js";
import { botGitDirReal } from "../../../../shared/bot-git/paths.js";
import { botKeyStatus, removeBotKey } from "../../../../shared/bot-git/store.js";
import { revokeAllSharesForBot } from "../../../../shared/project-bot-shares.js";

// One seam, for the two key-store calls the delete path makes: a test needs to
// prove the handler survives a removal that throws, without planting a real
// failure under the secrets dir.
let keyStore = { botKeyStatus, removeBotKey };
/** TEST ONLY: replace the key-store calls. null restores the real store. */
export function _setBotGitStoreForTest(store) {
  keyStore = store && typeof store === "object" ? store : { botKeyStatus, removeBotKey };
}

async function count(db, sql, args) {
  try {
    const { rows } = await db.execute({ sql, args });
    return Number(rows[0] && (rows[0].n ?? 0)) || 0;
  } catch { return 0; }
}

/** The bot's local-bot contacts row id, or null (identity may be unavailable). */
async function localBotContactId(db, botId) {
  try {
    const admin = await import("./crow-messages-admin.js");
    const crowId = admin.botIdentityFor(botId).crowId;
    if (!crowId) return null;
    const { rows } = await db.execute({
      sql: "SELECT id FROM contacts WHERE crow_id=? AND origin='local-bot' LIMIT 1",
      args: [crowId],
    });
    return rows[0] ? Number(rows[0].id) : null;
  } catch { return null; }
}

/** Blast radius facts for the confirm page (all best-effort). */
export async function deleteBlastRadius(db, botId) {
  const sessions = await count(db, "SELECT COUNT(*) AS n FROM bot_sessions WHERE bot_id=?", [botId]);
  const liveSessions = await count(db,
    "SELECT COUNT(*) AS n FROM bot_sessions WHERE bot_id=? AND status IN ('active','waiting-user')", [botId]);
  const acl = await count(db, "SELECT COUNT(*) AS n FROM bot_message_acl WHERE bot_id=?", [botId]);
  const invites = await count(db, "SELECT COUNT(*) AS n FROM bot_message_invites WHERE bot_id=?", [botId]);
  const seen = await count(db, "SELECT COUNT(*) AS n FROM bot_message_seen WHERE bot_id=?", [botId]);
  let boundDevices = [];
  try {
    const { listDevices } = await import("../../../../shared/device-store.js");
    boundDevices = (await listDevices(db).catch(() => [])).filter((d) => d.bound_bot_id === botId);
  } catch { boundDevices = []; }
  // FK-cascade disclosure (review M1): deleting the local-bot contact takes
  // the DM history and group memberships with it — count them for the page.
  let messages = 0, groupMemberships = 0;
  const contactId = await localBotContactId(db, botId);
  if (contactId != null) {
    messages = await count(db, "SELECT COUNT(*) AS n FROM messages WHERE contact_id=?", [contactId]);
    groupMemberships = await count(db, "SELECT COUNT(*) AS n FROM contact_group_members WHERE contact_id=?", [contactId]);
  }
  let gitKey = false;
  try { gitKey = keyStore.botKeyStatus(botId).on === true; } catch { gitKey = false; }
  return { sessions, liveSessions, acl, invites, seen, boundDevices, messages, groupMemberships, gitKey };
}

/** GET ?bot=<id>&confirm_delete=1 — the confirmation page. */
export async function renderDeleteConfirm(req, res, { db, layout, lang, PAGE_CSS, bot }) {
  const botId = bot.bot_id;
  const def = (() => { try { return JSON.parse(bot.definition || "{}"); } catch { return {}; } })();
  const gwType = ((def.gateways || []).find((g) => g && g.type) || {}).type || null;
  const br = await deleteBlastRadius(db, botId);

  const li = (txt) => `<li>${txt}</li>`;
  const items = [
    li(fill(t("botbuilder.delRadiusSessions", lang), { n: br.sessions })),
    gwType ? li(fill(t("botbuilder.delRadiusGateway", lang), { type: escapeHtml(gwType) })) : "",
    (br.acl || br.invites)
      ? li(fill(t("botbuilder.delRadiusMessaging", lang), { acl: br.acl, inv: br.invites }))
      : "",
    br.boundDevices.length
      ? li(fill(t("botbuilder.delRadiusDevices", lang), {
          names: escapeHtml(br.boundDevices.map((d) => d.name || d.id).join(", ")) }))
      : "",
    (br.messages || br.groupMemberships)
      ? li(fill(t("botbuilder.delRadiusConversation", lang), { n: br.messages, g: br.groupMemberships }))
      : "",
    br.gitKey ? li(t("botbuilder.delRadiusGitKey", lang)) : "",
    li(t("botbuilder.delRadiusWorkspaceKept", lang)),
  ].filter(Boolean).join("");

  const liveWarn = br.liveSessions
    ? callout(escapeHtml(fill(t("botbuilder.delLiveSessionsWarn", lang), { n: br.liveSessions })), "warning")
    : "";

  const body =
    `<p>${fill(t("botbuilder.delIntro", lang), { name: `<b>${escapeHtml(bot.display_name || botId)}</b>` })}</p>` +
    `<ul class="btb-del-radius">${items}</ul>` +
    liveWarn +
    callout(escapeHtml(t("botbuilder.delPermanent", lang)), "error") +
    `<form method="POST" style="margin-top:1rem;display:flex;gap:.5rem;flex-wrap:wrap">` +
    `<input type="hidden" name="action" value="delete_confirm">` +
    `<input type="hidden" name="bot_id" value="${escapeHtml(botId)}">` +
    csrfInput(req) +
    `<button type="submit" class="btb-btn btb-btn-danger">${t("botbuilder.delConfirmBtn", lang)}</button>` +
    `<a class="btb-btn btb-btn-sec" href="/dashboard/bot-builder?bot=${encodeURIComponent(botId)}&amp;tab=review">${t("botbuilder.delCancelBtn", lang)}</a>` +
    `</form>`;

  return res.send(layout({
    title: t("botbuilder.delTitle", lang),
    content: PAGE_CSS + section(
      t("botbuilder.delTitle", lang) + ": " + escapeHtml(bot.display_name || botId),
      body),
  }));
}

/**
 * The warning for a key folder that outlived its bot. The redirect text names
 * only the folder inside the key store (`bot-git/<id>`), never the owner's full
 * secrets path; the full path goes to this box's log instead. Never a
 * filesystem error — the owner needs the folder, not the errno.
 */
function keyLeftoverText(lang, botId) {
  const name = "bot-git/" + botId;
  let fullPath = "";
  try { fullPath = botGitDirReal(botId) || ""; } catch { fullPath = ""; }
  console.warn("[bot-git] a deleted bot's key folder could not be removed: " + (fullPath || name));
  return fill(t("botbuilder.delGitKeyWarn", lang), { path: name });
}

/** POST action="delete_confirm" — PRG. Returns the redirect via res. */
export async function handleDeleteConfirm(req, res, { db, lang = "en" } = {}) {
  const b = req.body || {};
  const botId = (b.bot_id || "").trim();
  if (!botId) return res.redirectAfterPost("/dashboard/bot-builder");
  if (isVoiceBotId(botId)) return res.redirectAfterPost("/dashboard/bot-builder?error=voice_bot_permanent");
  let existed = false;
  try {
    existed = !!(await db.execute({ sql: "SELECT 1 FROM pi_bot_defs WHERE bot_id=?", args: [botId] })).rows[0];
  } catch { existed = false; }
  if (!existed) return res.redirectAfterPost("/dashboard/bot-builder?error=unknown_bot");

  // Core rows (same DB, no cascades — this list IS the integrity mechanism).
  const del = async (sql) => { try { await db.execute({ sql, args: [botId] }); } catch { /* per-step best-effort */ } };
  await del("DELETE FROM bot_sessions WHERE bot_id=?");
  await del("DELETE FROM bot_message_seen WHERE bot_id=?");
  await del("DELETE FROM bot_skill_events WHERE bot_id=?");
  await del("DELETE FROM bot_message_acl WHERE bot_id=?");
  await del("DELETE FROM bot_message_invites WHERE bot_id=?");

  // remote_managed_bots settings JSON entry.
  try {
    const raw = await readSetting(db, "remote_managed_bots");
    let list = [];
    try { list = raw ? JSON.parse(raw) : []; } catch { list = []; }
    if (Array.isArray(list) && list.includes(botId)) {
      await writeSetting(db, "remote_managed_bots", JSON.stringify(list.filter((x) => x !== botId)), { scope: "local" });
    }
  } catch { /* best-effort */ }

  // Local-bot contacts row — direct SQL by the bot's derived crow_id (the
  // contact-delete helper refuses origin='local-bot' rows by design).
  try {
    const admin = await import("./crow-messages-admin.js");
    const crowId = admin.botIdentityFor(botId).crowId;
    if (crowId) {
      await db.execute({
        sql: "DELETE FROM contacts WHERE crow_id=? AND origin='local-bot'",
        args: [crowId],
      });
    }
  } catch { /* identity derivation may be unavailable — best-effort */ }

  // Unbind devices (JSON blob in dashboard_settings — helpers only).
  try {
    const { listDevices, updateDeviceProfiles } = await import("../../../../shared/device-store.js");
    const devices = await listDevices(db).catch(() => []);
    for (const d of devices) {
      if (d.bound_bot_id === botId) {
        await updateDeviceProfiles(db, d.id, { bound_bot_id: "" });
      }
    }
  } catch { /* bundle may be absent — best-effort */ }

  // Shares granted TO this bot die with it. `project_bot_shares.bot_id` has no foreign key
  // (bot definitions are text keys), so this is the integrity step: without it a bot later
  // created with the same id would inherit every project the old one could reach. Each shared
  // project gets the revoke in its own audit log. A revoke that fails stops the delete BEFORE the
  // def row goes: a def that outlives its revoke is a bot that still reaches the projects it was
  // shared into, and the owner can retry the delete once the store answers.
  try {
    await revokeAllSharesForBot(db, botId, { reason: "bot_deleted" });
  } catch (e) {
    return res.redirectAfterPost(
      `/dashboard/bot-builder?bot=${encodeURIComponent(botId)}&tab=review&error=` + encodeURIComponent(String(e.message || e)));
  }

  // The def row LAST: if anything above hard-fails, the bot still exists and
  // the operator can retry; a half-deleted def with live children is worse.
  try {
    await db.execute({ sql: "DELETE FROM pi_bot_defs WHERE bot_id=?", args: [botId] });
  } catch (e) {
    return res.redirectAfterPost(
      `/dashboard/bot-builder?bot=${encodeURIComponent(botId)}&tab=review&error=` + encodeURIComponent(String(e.message || e)));
  }

  // The bot's git key (C5). The def row is gone, so no spawn can use the key
  // any more; removing it here lets the owner take the deploy key off the forge
  // in the same breath. A removal that fails (or throws) must not fail the
  // delete: the bot is deleted either way, the redirect names the leftover
  // folder, and the next boot sweep retries.
  let gitFp = null;
  let gitWarn = null;
  let gitKeyOn = false;
  try { gitKeyOn = keyStore.botKeyStatus(botId).on === true; } catch { gitKeyOn = false; }
  try {
    const g = keyStore.removeBotKey(botId);
    if (g && g.removed === true) {
      if (isFingerprint(g.fingerprint)) gitFp = g.fingerprint;
    } else if (gitKeyOn) {
      gitWarn = keyLeftoverText(lang, botId);
    }
  } catch {
    gitWarn = keyLeftoverText(lang, botId);
  }

  emitBotDefsChanged(botId);
  return res.redirectAfterPost(`/dashboard/bot-builder?deleted=${encodeURIComponent(botId)}` +
    (gitFp ? `&git_fp=${encodeURIComponent(gitFp)}` : "") +
    (gitWarn ? `&warn=${encodeURIComponent(gitWarn)}` : ""));
}
