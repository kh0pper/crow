/**
 * Settings Section: History (Backup & updates group)
 *
 * The three settings the version history design §3/§8 gives the owner, plus the
 * size line a small machine needs (the design §6: "a visible size line and the
 * retention setting, not silent growth").
 *
 *   retention       today only "forever" exists, so the line is READ-ONLY. The
 *                   sweep accepts no other value yet (sweep.js RETENTION_FOREVER:
 *                   anything else is reported and not applied); offering a
 *                   picker with one choice and no effect would be a lie.
 *   history.trash_days    1…365, default 30. Written with scope "local": a
 *                   dashboard_settings_overrides row for THIS instance. Its
 *                   readers (gateway/boot/post-listen.js's sweep and the Trash
 *                   page) go through readSetting, which resolves the override
 *                   first, so the save takes effect without a restart.
 *   history.erase_sync    off by default. Written with scope "global", which
 *                   writeSetting routes to the global dashboard_settings row
 *                   because the key is instance-scope (sync-allowlist.js
 *                   INSTANCE_SCOPE_KEYS): its reader — erase.js
 *                   eraseSyncEnabled — queries that table DIRECTLY, so a
 *                   downgraded-to-local override would be invisible to it and
 *                   the switch would silently do nothing. Instance-scope keys
 *                   never leave this box: isSyncable() is false for them, so
 *                   neither the live manager nor the durable queue carries one.
 *
 * NONE of the three keys is in SYNC_ALLOWLIST, and none may ever be: history is
 * per instance (the design §4 — "history stays local and does not sync"), and a
 * peer-supplied retention would let one machine shorten another's memory.
 *
 * Only the owner may change them (the design §4: a bot cannot change retention,
 * empty the Trash or erase history), so handleAction uses the same
 * isLocalPasswordSessionOn check the History pages use. The settings panel is
 * reachable by any signed-in session; this section is not its to change.
 */
import { escapeHtml, formatBytes } from "../../shared/components.js";
import { fill, t } from "../../shared/i18n.js";
import { readSetting, writeSetting } from "../registry.js";
import { isLocalPasswordSessionOn } from "../../local-session.js";
import { DEFAULT_TRASH_DAYS, normalizeTrashDays } from "../../../../shared/history/trash.js";
import { historyFootprint } from "../../../../shared/history/size.js";

const BASE = "/dashboard/settings?section=history";

/** The bounds the design gives the Trash period, in days. */
export const TRASH_DAYS_MIN = 1;
export const TRASH_DAYS_MAX = 365;

/** The three keys, named once so a test and the renderer cannot disagree. */
export const HISTORY_SETTINGS = Object.freeze({
  retention: "history.retention",
  trashDays: "history.trash_days",
  eraseSync: "history.erase_sync",
  // The scheduled erase of a project's deleted WORKSPACE files. DEFAULT OFF, no
  // UI yet: until the Trash page lists workspace files, the history copy is the
  // only copy of a file a bot deleted (the review that blocked Task 6, H5), so
  // only the boot sweep reads this and only an operator who sets it by hand turns
  // it on. Instance-scope through the `history.*` pattern, so it never syncs.
  workspaceAutoErase: "history.workspace_auto_erase",
});

/** `history.erase_sync` as a boolean (the same values erase.js accepts). */
function eraseSyncOn(value) {
  return value === "1" || value === "true" || value === "on";
}

/** The Trash period actually in force: the stored value, clamped, else 30. */
export function effectiveTrashDays(raw) {
  if (raw === null || raw === undefined || String(raw).trim() === "") return DEFAULT_TRASH_DAYS;
  return normalizeTrashDays(Number(raw));
}

/** A saved/refused banner from the redirect. */
function flash(req, lang) {
  const q = req?.query || {};
  if (q.saved) return `<div class="alert alert-success">${escapeHtml(t("settings.historySaved", lang))}</div>`;
  if (q.refused === "not_owner") return `<div class="alert alert-error">${escapeHtml(t("settings.historyNotOwner", lang))}</div>`;
  if (q.refused === "bad_days") return `<div class="alert alert-error">${escapeHtml(t("settings.historyBadDays", lang))}</div>`;
  return "";
}

/** The size line, the project-file line and the warning (each degrades alone). */
export function sizeLines(size, lang) {
  const muted = "font-size:0.85rem;color:var(--crow-text-muted)";
  if (!size) {
    return `<p id="history-size" style="${muted};margin:0 0 1rem">${escapeHtml(t("settings.historySizeUnknown", lang))}</p>`;
  }
  const items = (size.versions || 0) + (size.cards ? size.cards.versions : 0);
  const itemBytes = size.bytes + (size.cards ? size.cards.bytes : 0);
  const ws = size.workspaceBytes;
  const wsLine = ws === null
    ? t("settings.historyWorkspaceUnknown", lang)
    : ws === 0
      ? t("settings.historyWorkspaceNone", lang)
      : fill(t("settings.historyWorkspaceSize", lang), { size: formatBytes(ws) });
  const warn = size.warn
    ? `<div id="history-size-warning" class="callout callout-warning" role="status" style="margin:1rem 0 0">${escapeHtml(
      fill(t("settings.historySizeWarn", lang), { size: formatBytes(size.totalBytes), free: formatBytes(size.freeBytes) }),
    )}</div>`
    : "";
  const partial = size.partial
    ? `<p id="history-size-partial" style="${muted};margin:0.5rem 0 0">${escapeHtml(t("settings.historySizePartial", lang))}</p>`
    : "";
  return `<p id="history-size" style="${muted};margin:0 0 1rem">${escapeHtml(
    fill(t("settings.historySize", lang), { n: items, size: formatBytes(itemBytes) }),
  )}</p>
    <p style="${muted};margin:0 0 0.35rem">${escapeHtml(t("settings.historyWorkspaceLabel", lang))}</p>
    <p id="history-workspace" style="${muted};margin:0">${escapeHtml(wsLine)}</p>${partial}${warn}`;
}

export default {
  id: "history",
  group: "backup",
  icon: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>`,
  labelKey: "settings.section.history",
  navOrder: 20,
  // None of the three keys replicates, and this section declares no syncKeys on
  // purpose (see checkSyncKeyDrift: a declared key absent from SYNC_ALLOWLIST is
  // drift; these must never be in it at all).
  scope: "local",
  // No getPreview: the only honest preview is the size line, and it is a full
  // aggregate over item_versions. The menu renders on every Settings page, so
  // that read belongs on this section's own page, not in the menu.

  async render({ req, db, lang }) {
    // History settings (sizes, the erase-sync switch) are the owner's: another
    // session sees only that the section exists.
    if ((await isLocalPasswordSessionOn(db, req).catch(() => false)) !== true) {
      return `<p class="settings-hint">${escapeHtml(t("history.ownerOnly", lang))}</p>`;
    }
    const rawDays = await readSetting(db, HISTORY_SETTINGS.trashDays).catch(() => null);
    const days = effectiveTrashDays(rawDays);
    const eraseSync = eraseSyncOn(await readSetting(db, HISTORY_SETTINGS.eraseSync).catch(() => null));
    const size = await historyFootprint(db).catch(() => null);
    const csrf = escapeHtml(req?.csrfToken || "");
    const retentionRaw = await readSetting(db, HISTORY_SETTINGS.retention).catch(() => null);
    // The retention line is honest about today: `forever` is the only value the
    // sweep applies, so the line says what it does rather than offering a choice.
    const retentionLine = retentionRaw && retentionRaw !== "forever"
      ? fill(t("settings.historyRetentionOther", lang), { value: String(retentionRaw) })
      : t("settings.historyRetentionForever", lang);

    return `${flash(req, lang)}
    <p style="font-size:0.88rem;color:var(--crow-text-secondary);line-height:1.5;margin-bottom:1.25rem">${escapeHtml(
      t("settings.historyIntro", lang),
    )}</p>

    <h3 style="font-size:1rem;margin:0 0 0.35rem">${escapeHtml(t("settings.historyRetentionLabel", lang))}</h3>
    <p id="history-retention" style="font-size:0.85rem;color:var(--crow-text-muted);margin:0 0 1.5rem">${escapeHtml(retentionLine)}</p>

    <form method="POST" action="/dashboard/settings?section=history">
      <input type="hidden" name="_csrf" value="${csrf}">
      <input type="hidden" name="action" value="save_history_settings">

      <h3 style="font-size:1rem;margin:0 0 0.35rem">${escapeHtml(t("settings.historyTrashDaysLabel", lang))}</h3>
      <p style="font-size:0.82rem;color:var(--crow-text-muted);margin:0 0 0.5rem">${escapeHtml(t("settings.historyTrashDaysHelp", lang))}</p>
      <input type="number" id="history-trash-days" name="trash_days" value="${escapeHtml(String(days))}"
             min="${TRASH_DAYS_MIN}" max="${TRASH_DAYS_MAX}" step="1" required
             style="max-width:9rem;margin-bottom:1.5rem">

      <h3 style="font-size:1rem;margin:0 0 0.35rem">${escapeHtml(t("settings.historyEraseSyncLabel", lang))}</h3>
      <label style="display:flex;align-items:flex-start;gap:0.6rem;cursor:pointer;margin-bottom:0.35rem">
        <input type="checkbox" id="history-erase-sync" name="erase_sync" value="1"${eraseSync ? " checked" : ""} style="margin-top:0.2rem">
        <span style="font-size:0.85rem;color:var(--crow-text-secondary)">${escapeHtml(t("settings.historyEraseSyncHelp", lang))}</span>
      </label>
      <div style="margin:1.25rem 0 1.5rem">
        <button type="submit" class="btn btn-primary">${escapeHtml(t("common.save", lang))}</button>
      </div>
    </form>

    <h3 style="font-size:1rem;margin:0 0 0.35rem">${escapeHtml(t("settings.historySizeLabel", lang))}</h3>
    ${sizeLines(size, lang)}`;
  },

  async handleAction({ req, res, db, action }) {
    if (action !== "save_history_settings") return false;

    // Owner only: retention is history's whole point of being trustworthy, and a
    // bot session (or a peer's SSO session) may not shorten it.
    let owner = false;
    try {
      owner = (await isLocalPasswordSessionOn(db, req)) === true;
    } catch {
      owner = false;
    }
    if (!owner) {
      res.redirectAfterPost(`${BASE}&refused=not_owner`);
      return true;
    }

    const requested = Number(req.body?.trash_days);
    const days = Number.isFinite(requested) ? Math.trunc(requested) : NaN;
    if (!Number.isFinite(days) || days < TRASH_DAYS_MIN || days > TRASH_DAYS_MAX) {
      res.redirectAfterPost(`${BASE}&refused=bad_days`);
      return true;
    }
    // LOCAL scope: this instance's own Trash period. readSetting (the sweep and
    // the Trash page) resolves this override first.
    await writeSetting(db, HISTORY_SETTINGS.trashDays, String(days), { scope: "local", allowLocalFallback: false });

    // `history.erase_sync` is instance-scope (global row, never emitted) because
    // erase.js reads that row directly — see this file's header.
    const wantEraseSync = String(req.body?.erase_sync || "") === "1";
    await writeSetting(db, HISTORY_SETTINGS.eraseSync, wantEraseSync ? "true" : "false", { scope: "global", allowLocalFallback: false });

    res.redirectAfterPost(`${BASE}&saved=1`);
    return true;
  },
};