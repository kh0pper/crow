/**
 * The operator-visible bell for a bot spawn the hidden-entry rule REFUSED
 * (scripts/pi-bots/hidden_files.mjs): a secret FOLDER that was hidden before and
 * is now gone or replaced, a secret folder or file that is a link (or sits
 * behind one), a secret folder with a link inside it (or one Crow could not look
 * through), an entry that could not be masked at all, or an identity record
 * Crow cannot read or write.
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
 * body name the entry `~/rel`, the entry's name when there is one to name, and
 * the exact reset command, never an absolute path and never any content. The
 * command is the one for the INSTANCE that refused (hiddenDirResetCommand): on a
 * co-hosted instance the bare command would forget the DEFAULT instance's
 * records, so the bell spells that instance's home `--crow-home ~/.crow-<x>`.
 */
import Database from "better-sqlite3";
import { maskSecrets } from "../../servers/shared/secret-mask.js";
import { writeAlertFile } from "../../servers/shared/alert-spool.js";
import { notificationTypeEnabled } from "../../servers/shared/notifications.js";
import { resolveSqlitePath } from "./instance-paths.mjs";
import { INNER_LINK_MAX_ENTRIES, hiddenDirResetCommand } from "./hidden_files.mjs";

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
 *
 * `x` carries what the cause needs beyond the entry: the LINK'S NAME inside a
 * folder (`entry`, for `inner-link`), how many entries a folder holds
 * (`count`), and for a `record` refusal which of the two it was (`recordWhy`:
 * unreadable, or not writable).
 */
const CAUSE_TEXT = Object.freeze({
  missing: (rel) => "~/" + rel + " was there the last time a bot ran and is gone now.",
  replaced: (rel, kind) => "~/" + rel + " is not the " + noun(kind) + " Crow hid the last time (it was replaced).",
  link: (rel, kind) => "~/" + rel + " is a link, or sits behind one, so Crow can't hide " + what(kind) + ".",
  unmasked: (rel) => "Crow could not hide ~/" + rel + " on the spawn it just tried.",
  "inner-link": (rel, kind, x) => (x && x.entry
    ? "~/" + rel + " has a link inside it (~/" + rel + "/" + x.entry +
      "), so Crow can't hide the folder whole: the mask covers the link, not what it points at."
    : "Crow could not look inside ~/" + rel + " on the spawn it just tried, so it can't tell whether a link in it leads to a credential."),
  "inner-many": (rel, kind, x) => "~/" + rel + " holds " + ((x && x.count) || "more than " + INNER_LINK_MAX_ENTRIES) +
    " entries, more than the " + INNER_LINK_MAX_ENTRIES + " Crow will look through for links.",
  record: (rel, kind, x) => (x && x.recordWhy === "not writable"
    ? "Crow could not write its record of the secret folders it hides, so it can't remember which folder it hid."
    : "Crow's record of the secret folders it hides is unreadable, so it can't tell whether one moved or was replaced."),
});

const noun = (kind) => (kind === "file" ? "file" : "folder");
const what = (kind) => (kind === "file" ? "it" : "the credentials in it");

/**
 * What the operator should DO about one cause, ending with the command that
 * re-confirms the entry. Each cause has its own action, because one sentence for
 * all of them told the operator the wrong thing: a link is not something to
 * "replace with a real folder" when the entry should not exist at all, a record
 * Crow cannot WRITE is not fixed by forgetting it, and a folder full of entries
 * is not fixed by re-confirming it either.
 */
function remedyFor(cause, kind, { reset, entry, recordWhy }) {
  if (cause === "link") {
    return "Remove the link (or, if you use that tool, replace it with a real " + noun(kind) +
      "), then run " + reset + " and start the bot again.";
  }
  if (cause === "inner-link") {
    return entry
      ? "Replace the link with a real file in the folder (or remove it), then run " + reset + " and start the bot again."
      : "Make the folder readable by its owner, then start the bot again.";
  }
  if (cause === "inner-many") {
    return "Move the folder's contents aside (Crow will not look through more than " + INNER_LINK_MAX_ENTRIES +
      " entries), then run " + reset + " and start the bot again.";
  }
  if (cause === "record" && recordWhy === "not writable") {
    return "Check that the Crow secrets folder is writable by its owner, then start the bot again.";
  }
  return "If that was you, run " + reset + " and start the bot again.";
}

/**
 * The bell's title and body for one refusal: the entry `~/rel`, what happened,
 * and the command that re-confirms it — on the instance that refused.
 *
 * `crowHome` is that instance's Crow home, so a co-hosted instance's bell names
 * its own record (`--crow-home ~/.crow-<x>`, ~-relative: no absolute path in a
 * bell) instead of the default instance's.
 *
 * @param {{rel:string, kind?:"dir"|"file", cause?:string, entry?:string|null,
 *          recordWhy?:string|null, count?:number|null,
 *          crowHome?:string|null}} entry
 * @returns {{title:string, body:string}}
 */
export function hiddenDirAlertText({ rel, kind = "dir", cause = "missing", entry = null, recordWhy = null, count = null, crowHome = null } = {}) {
  const say = CAUSE_TEXT[cause] || CAUSE_TEXT.missing;
  const extra = { reset: hiddenDirResetCommand({ crowHome }), entry, recordWhy };
  const title = maskSecrets("A bot could not start: ~/" + rel);
  const body = maskSecrets(say(String(rel), kind, { entry, recordWhy, count }) + " " + remedyFor(cause, kind, extra));
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
 * `entry` (a link's name inside the folder), `recordWhy` and `count` are what the
 * cause needs to say the sentence, and `crowHome` is the Crow home of the
 * instance that refused (so the command in the bell is ITS reset command).
 *
 * @param {{dbPath?:string, rel:string, kind?:string, cause?:string,
 *          entry?:string|null, recordWhy?:string|null, count?:number|null,
 *          crowHome?:string|null, nowMs?:number, open?:Function}} opts  `open` is
 *   the test seam: it must return a better-sqlite3 connection, or something falsy
 *   for "no store".
 * @returns {{written:boolean, reason:string, id?:number}}
 *   `reason` is `"written"`, `"deduped"`, `"disabled"` (the operator switched
 *   system notifications off — a choice, never retried), `"no-store"` (no path,
 *   no file) or `"error"`. Only the last two mean "the store could not be used",
 *   which is what makes the caller spool instead.
 */
export function bellHiddenDirRefusal({ dbPath, rel, kind = "dir", cause = "missing", entry = null, recordWhy = null,
  count = null, crowHome = null, nowMs = Date.now(), open = openExistingStore } = {}) {
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
    const { title, body } = hiddenDirAlertText({ rel, kind, cause, entry, recordWhy, count, crowHome });
    // The cause says WHICH sentence, so the row records which rule fired without
    // parsing it; `hidden_entry` names the link inside the folder, never its
    // target. The dedupe stays per ENTRY, so a folder's missing/replaced/link
    // states share one window.
    const metadata = { code: HIDDEN_DIR_ALERT_CODE, hidden_rel: rel, hidden_kind: noun(kind), cause };
    if (entry) metadata.hidden_entry = entry;
    if (recordWhy) metadata.hidden_record = recordWhy;
    // `created_at` is stamped from the CALLER's clock (`nowMs`), the same clock
    // the dedupe window uses, so the two can never disagree — and a test can move
    // the window without touching the host's clock.
    const info = conn.prepare(
      "INSERT INTO notifications (type, source, title, body, priority, action_url, metadata, created_at) " +
      "VALUES ('system', ?, ?, ?, 'high', ?, ?, datetime(?, 'unixepoch'))",
    ).run(HIDDEN_DIR_ALERT_SOURCE, title, body, HIDDEN_DIR_ALERT_ACTION_URL,
      JSON.stringify(metadata),
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
export function spoolHiddenDirRefusal({ rel, kind = "dir", cause = "missing", entry = null, recordWhy = null,
  count = null, crowHome = null, nowMs = Date.now(), write = writeAlertFile } = {}) {
  try {
    const { title, body } = hiddenDirAlertText({ rel, kind, cause, entry, recordWhy, count, crowHome });
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
export function notifyHiddenDirRefusal({ dbPath, rel, kind = "dir", cause = "missing", entry = null, recordWhy = null,
  count = null, crowHome = null, nowMs = Date.now(), bell = bellHiddenDirRefusal, spool = spoolHiddenDirRefusal } = {}) {
  try {
    const result = bell({ dbPath, rel, kind, cause, entry, recordWhy, count, crowHome, nowMs });
    if (result.written || result.reason === "deduped" || result.reason === "disabled") return { ...result, spooled: false };
    const file = spool({ rel, kind, cause, entry, recordWhy, count, crowHome, nowMs });
    return { ...result, spooled: Boolean(file) };
  } catch (err) {
    return { written: false, reason: "error", error: String(err?.message || err), spooled: false };
  }
}