/**
 * The operator-visible bell for a bot spawn the hidden-entry rule REFUSED
 * (scripts/pi-bots/hidden_files.mjs): a secret FOLDER that was hidden before and
 * is now gone or replaced, a secret folder or file that is a link (or sits
 * behind one), an entry that could not be masked at all, or an identity record
 * Crow cannot read.
 *
 * Why a bell and not only the failed turn: the refusal stops EVERY bot on the
 * instance, and the operator never sees a bot's failed turn in a channel they
 * are not reading. The bridge is where the refusal happens, and it is a
 * better-sqlite3 process, so this writes the row itself — one `notifications`
 * row, `type: "system"`, `priority: "high"`, `source: "bot-sandbox"` — instead
 * of going through `createNotification` (which is async and fans out to push /
 * ntfy / email from the gateway process). The masking and the preference gate
 * are the SAME code the gateway uses (`maskSecrets`, `notificationTypeEnabled`),
 * so a bell raised here is indistinguishable from any other system bell.
 *
 * Deduped per entry per 24 h: the refusal fires on every turn of every bot, so
 * without a window one mislaid folder would bury the bell. The dedupe reads the
 * notifications themselves (`source` + `metadata.hidden_rel` inside the
 * window), so it survives a restart and needs no extra state file.
 *
 * It is the IN-APP row only: the bell badge in an already-open dashboard catches
 * up on its next read (the gateway's own live broadcast runs in the gateway
 * process, not here), and the off-device fan-out (web push, ntfy, email) is the
 * gateway's `deliverNotification`, which this path deliberately does not import.
 *
 * When the store cannot be used at all (no crow.db yet, the table missing, a
 * locked file) the same alert goes to the DB-free alert spool
 * (servers/shared/alert-spool.js), which the gateway drains into the same bell
 * once it is up. That branch dedupes the file NAME instead: one file per entry
 * per 24 h window, so a refusal loop cannot fill `alerts/pending`.
 *
 * Nothing here ever throws, and no path is written into the text: the title and
 * body name the entry `~/rel` and the exact reset command, never an absolute
 * path and never any content.
 */
import Database from "better-sqlite3";
import { maskSecrets } from "../../servers/shared/secret-mask.js";
import { writeAlertFile } from "../../servers/shared/alert-spool.js";
import { notificationTypeEnabled } from "../../servers/shared/notifications.js";
import { resolveSqlitePath } from "./instance-paths.mjs";
import { HIDDEN_DIR_RESET_COMMAND } from "./hidden_files.mjs";

/** `notifications.source` every refusal bell carries. */
export const HIDDEN_DIR_ALERT_SOURCE = "bot-sandbox";
/** `notifications.metadata.code` / the alert-spool code prefix. */
export const HIDDEN_DIR_ALERT_CODE = "hidden-secret-refused";
/** One bell per entry per this window. */
export const HIDDEN_DIR_ALERT_COOLDOWN_MS = 24 * 60 * 60 * 1000;
/** Where the dashboard shows bot runtime state, so one click explains the bell. */
export const HIDDEN_DIR_ALERT_ACTION_URL = "/dashboard/settings?section=bot-runtime";

/**
 * The sentence for each cause `resolveHiddenSecretPath` reports. Kept here (not
 * built from the refusal text) because the refusal names the absolute path of
 * the identity record — the bell must not.
 */
const CAUSE_TEXT = Object.freeze({
  missing: (rel) => "~/" + rel + " was there the last time a bot ran and is gone now.",
  replaced: (rel, kind) => "~/" + rel + " is not the " + noun(kind) + " Crow hid the last time (it was replaced).",
  link: (rel, kind) => "~/" + rel + " is a link, or sits behind one, so Crow can't hide " + what(kind) + ".",
  unmasked: (rel) => "Crow could not hide ~/" + rel + " on the spawn it just tried.",
  record: () => "Crow's record of the secret folders it hides is unreadable, so it can't tell whether one moved or was replaced.",
});

const noun = (kind) => (kind === "file" ? "file" : "folder");
const what = (kind) => (kind === "file" ? "it" : "the credentials in it");

/**
 * The bell's title and body for one refusal: the entry `~/rel`, what happened,
 * and the one command that re-confirms it. Both fields are masked with the
 * shared display mask.
 *
 * @param {{rel:string, kind?:"dir"|"file", cause?:string}} entry
 * @returns {{title:string, body:string}}
 */
export function hiddenDirAlertText({ rel, kind = "dir", cause = "missing" } = {}) {
  const say = CAUSE_TEXT[cause] || CAUSE_TEXT.missing;
  const remedy = cause === "link"
    ? "Replace it with a real " + noun(kind) + "; if Crow then still refuses a bot, run "
    : "If that was you, run ";
  const title = maskSecrets("A bot could not start: ~/" + rel);
  const body = maskSecrets(say(String(rel), kind) + " " + remedy + HIDDEN_DIR_RESET_COMMAND + " and start the bot again.");
  return { title, body };
}

/** Open the instance store read-write, but never create it: a refused spawn
 *  must not leave a fresh crow.db behind. A short busy timeout on purpose — a
 *  refusal must not hang the turn behind a gateway write; past it the spool is
 *  the fallback. */
function openExistingStore(dbPath) {
  return new Database(resolveSqlitePath(dbPath), { fileMustExist: true, timeout: 2000 });
}

/**
 * Write the refusal bell into the instance store, synchronously.
 *
 * @param {{dbPath?:string, rel:string, kind?:string, cause?:string,
 *          nowMs?:number, open?:Function}} opts  `open` is the test seam: it
 *   must return a better-sqlite3 connection, or something falsy for "no store".
 * @returns {{written:boolean, reason:string, id?:number}}
 *   `reason` is `"written"`, `"deduped"`, `"disabled"` (the operator switched
 *   system notifications off — a choice, never retried), `"no-store"` (no path,
 *   no file) or `"error"`. Only the last two mean "the store could not be used",
 *   which is what makes the caller spool instead.
 */
export function bellHiddenDirRefusal({ dbPath, rel, kind = "dir", cause = "missing", nowMs = Date.now(), open = openExistingStore } = {}) {
  let conn = null;
  try {
    if (!dbPath) return { written: false, reason: "no-store" };
    conn = open(dbPath);
    if (!conn) return { written: false, reason: "no-store" };
    let prefs = null;
    try { prefs = conn.prepare("SELECT value FROM dashboard_settings WHERE key = 'notification_prefs'").get(); } catch { /* no settings table yet: allow */ }
    if (!notificationTypeEnabled(prefs, "system")) return { written: false, reason: "disabled" };
    const cutoff = Math.floor((nowMs - HIDDEN_DIR_ALERT_COOLDOWN_MS) / 1000);
    const recent = conn.prepare(
      "SELECT id FROM notifications WHERE source = ? AND json_valid(metadata) " +
      "AND json_extract(metadata, '$.hidden_rel') = ? AND created_at >= datetime(?, 'unixepoch') LIMIT 1",
    ).get(HIDDEN_DIR_ALERT_SOURCE, rel, cutoff);
    if (recent) return { written: false, reason: "deduped", id: Number(recent.id) };
    const { title, body } = hiddenDirAlertText({ rel, kind, cause });
    // `created_at` is stamped from the CALLER's clock (`nowMs`), the same clock
    // the dedupe window uses, so the two can never disagree — and a test can move
    // the window without touching the host's clock.
    const info = conn.prepare(
      "INSERT INTO notifications (type, source, title, body, priority, action_url, metadata, created_at) " +
      "VALUES ('system', ?, ?, ?, 'high', ?, ?, datetime(?, 'unixepoch'))",
    ).run(HIDDEN_DIR_ALERT_SOURCE, title, body, HIDDEN_DIR_ALERT_ACTION_URL,
      JSON.stringify({ code: HIDDEN_DIR_ALERT_CODE, hidden_rel: rel, hidden_kind: noun(kind), cause }),
      Math.floor(nowMs / 1000));
    return { written: true, reason: "written", id: Number(info.lastInsertRowid) };
  } catch (err) {
    return { written: false, reason: "error", error: String(err?.message || err) };
  } finally {
    try { if (conn) conn.close(); } catch { /* already closed */ }
  }
}

/** A file-name-safe slug for one entry (`~/.config/gcloud` → `config-gcloud`). */
function relSlug(rel) {
  return String(rel || "entry").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "entry";
}

/**
 * The same alert through the DB-free spool.
 *
 * The alert file's name is `<stamp>-<code>.json` and the DRAIN dedupes on that
 * name, so both halves are pinned to the 24 h window: the code carries the entry,
 * and the stamp is the window's start rather than "now". Two refusals inside one
 * window therefore name the SAME file (the second rename replaces the first)
 * instead of adding one per refused turn, and a later window adds its own.
 *
 * @returns {string|null} the file written, or null
 */
export function spoolHiddenDirRefusal({ rel, kind = "dir", cause = "missing", nowMs = Date.now(), write = writeAlertFile } = {}) {
  try {
    const { title, body } = hiddenDirAlertText({ rel, kind, cause });
    const window = Math.floor(nowMs / HIDDEN_DIR_ALERT_COOLDOWN_MS);
    return write({
      code: HIDDEN_DIR_ALERT_CODE + "-" + relSlug(rel),
      title,
      body,
      at: new Date(window * HIDDEN_DIR_ALERT_COOLDOWN_MS).toISOString(),
    }) || null;
  } catch {
    return null;
  }
}

/**
 * Ring the bell for one refused spawn, or stay silent when it rang within the
 * window. Store first (the bell the operator sees immediately), spool only when
 * the store could not be used. Never throws.
 *
 * @returns {{written:boolean, reason:string, spooled:boolean}}
 */
export function notifyHiddenDirRefusal({ dbPath, rel, kind = "dir", cause = "missing", nowMs = Date.now(), bell = bellHiddenDirRefusal, spool = spoolHiddenDirRefusal } = {}) {
  try {
    const result = bell({ dbPath, rel, kind, cause, nowMs });
    if (result.written || result.reason === "deduped" || result.reason === "disabled") return { ...result, spooled: false };
    const file = spool({ rel, kind, cause, nowMs });
    return { ...result, spooled: Boolean(file) };
  } catch (err) {
    return { written: false, reason: "error", error: String(err?.message || err), spooled: false };
  }
}