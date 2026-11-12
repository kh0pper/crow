/**
 * sweep.js — the periodic pass that keeps history honest and small: redact,
 * coalesce, erase.
 *
 * Three jobs, in this order, each bounded so a big table never blocks a boot or a
 * request (the design §8.8 budget):
 *
 *   (a) REDACT. A secret must never sit in the version table a second time. The
 *       capture triggers cannot do this (SQLite has no `regexp` on a raw
 *       connection, and a trigger that fell back to LIKE would store the secret
 *       anyway — see covered.js), so the scan happens here in JavaScript against
 *       the SAME patterns CI uses for this public repository
 *       (servers/shared/history/secret-patterns.js SECRET_PATTERNS — the one
 *       list, imported by scripts/check-public-hygiene.mjs too; the runtime never
 *       imports a CI script). A matching snapshot_json is rewritten with
 *       "[redacted]" in place of each match and the row is marked redacted = 1 —
 *       which api.js then refuses to restore, because the row no longer holds the
 *       item's value.
 *       ONE SHAPE IS HISTORY-ONLY, AND ONLY IN A URL-NAMED FIELD: a credential
 *       in a URL query string or fragment (`?api_key=…`, `&token=…`,
 *       `#access_token=…`) — URL_CREDENTIAL_QUERY in this file, applied by
 *       redactValue to a snapshot value whose KEY is `url` or ends in `_url`.
 *       It is deliberately NOT applied to plain text: `?token=…` is ordinary in a
 *       how-to, a note or a post (a placeholder, a pagination cursor named
 *       token), and every redacted version is refused by a restore — for a
 *       deleted item, also by the Trash — so a false positive costs the operator
 *       the ability to restore their own prose. The field it does cover is a
 *       source's stored `url`: exactly how a pasted key reaches history, and a
 *       value no SECRET_PATTERN recognizes. SECRET_PATTERNS and the PEM/PGP
 *       blocks stay GLOBAL — a real key shape is redacted in every type and
 *       every field. LIVE DATA IS NOT HISTORY'S BUSINESS: the memory, post or
 *       section itself keeps its text. Only the stored versions are rewritten.
 *       Rewriting a version is a history edit, so it goes through the armed
 *       switch (covered.js), one transaction per batch: arm → update → disarm.
 *
 *   (b) COALESCE. Rapid saves by the same author on the same item are one
 *       version, not twenty (§8.8: within 2 minutes). Only CONSECUTIVE `update`
 *       versions of one item with the same author and job, less than 120 s apart,
 *       and never a redacted row (that is evidence, not noise) — the earlier of
 *       the pair goes. Deletes need the armed switch, like every other history
 *       write.
 *
 *   (c) ERASE. An item that has been in the Trash longer than the Trash period is
 *       erased for real — every version of it, through erase.js's armed door. The
 *       Trash period is a local setting (history.trash_days, default 30).
 *
 *       AN ERASE LEAVES A TOMBSTONE and (when erase emission is on) tells the
 *       peers (erase.js): the item must not be re-created here by a peer's
 *       restore, and the peer's own copy and Trash go too. Emission is gated by
 *       the LOCAL setting `history.erase_sync` (default OFF — see erase.js's
 *       ERASE_SYNC_SETTING for why a peer capability gate does not exist yet).
 *       The sweep passes its caller's InstanceSyncManager through; with none
 *       given, erase.js resolves this process's singleton, and a process without
 *       one (the Maker Lab bundle) queues the event durably for the gateway's
 *       drain.
 *
 *   (d) FINISH A FAILED INBOUND ERASE. A peer's erase that could not be applied
 *       atomically left its tombstone (the part that must never be lost) plus a
 *       marker in pending_remote_erasures (erase.js). This pass retries those
 *       through the same apply path — the feed loop cannot: it consumes an entry
 *       whose apply threw, so without this the erase would simply stop halfway.
 *       The marker holds only the TOMBSTONE KEYS and the erase lamport, so this
 *       pass re-resolves the item first (a summary by its source, a memory by the
 *       id the wire named, a section by its scope) and the retry runs the same
 *       local-only / summary / source gates the first attempt ran. A marker that
 *       cannot be resolved stays for the next run: failing closed is the safe
 *       direction, the tombstone is already in place.
 *
 * RETENTION. `history.retention` defaults to `forever`, and `forever` keeps
 * everything. Any other value is currently a NO-OP: a thinning schedule is not
 * specified yet, so this pass reports the value it saw and changes nothing. It
 * must not throw on an unexpected value — a settings typo may never stop the
 * redaction or the Trash clock.
 *
 * BOUNDED AND EVENTUALLY COMPLETE. Each pass walks at most `batchSize` rows, by
 * id, continuing from a per-connection cursor (a WeakMap keyed by the db handle,
 * so an in-process caller that keeps one handle — the gateway's sweep does —
 * keeps making progress across runs while a fresh handle restarts from the
 * beginning). Redaction walks the backlog from that cursor AND scans the FRESH
 * WINDOW — the rows written since the last pass — so a secret written a minute
 * ago is caught by the next run while the older rows are still covered over
 * time. A full walk is idempotent: redacted rows are excluded and a coalesce pair
 * is gone after the first pass.
 *
 * THE FRESH WINDOW KEEPS A "SCANNED UP TO" MARK. "Scan the newest batch" was a
 * re-scan of the same rows every five minutes: a version with no secret in it is
 * never marked `redacted = 1`, so the same N rows were read, decoded and walked
 * forever. The mark — `history.redact_scanned_to` in dashboard_settings, the
 * local key/value Crow already keeps its history settings in (and a key the sync
 * allowlist does not carry, so it never leaves the host) — records the highest
 * version id the fresh window has covered. Each pass scans only rows ABOVE it,
 * ascending, and moves it forward; on a store that has never been scanned the
 * window starts at the newest batch (so the first pass covers exactly what the
 * old code covered). The BACKLOG walk is unchanged: it is what covers versions
 * written before the mark existed.
 *
 * ONE STORE PER PASS (`store`, default `crow`; the card store is `tasks`). The
 * instance has TWO item_versions tables — crow.db's, and tasks.db's own (board
 * cards; a SQLite trigger cannot write across databases) — so a pass names the
 * store it sweeps and touches ONLY that store's covered types: a crow.db pass can
 * never read or delete a card's versions, and a tasks.db pass can never touch a
 * memory's. `typesForStore` (covered.js) is the one list of which type lives
 * where. Everything a pass does is keyed the same way: the redaction walks, the
 * coalescing walk and the Trash listing all carry `item_type IN (…)` for the
 * store's types.
 *
 * THE SCAN MARK IS PER STORE (a crow.db mark cannot describe tasks.db's ids — two
 * independent AUTOINCREMENT series). It is still kept in crow.db's
 * dashboard_settings, the one place this instance keeps history settings (tasks.db
 * has no settings table), under `history.redact_scanned_to` for the crow store and
 * `history.redact_scanned_to.tasks` for the card store: two keys, so neither store's
 * pass can overwrite the other's mark. The pass writes it through `settingsDb` — the
 * crow.db client the caller already holds — which is why a tasks pass takes one
 * (see the `settingsDb` option); without it the tasks pass has no mark and re-covers
 * its newest batch each run, the safe (re-scanned) direction.
 */
import { SECRET_PATTERNS } from "./secret-patterns.js";
import { STORE_CROW, STORE_TASKS, typesForStore } from "./covered.js";
import { withoutWriteContext } from "./write-context.js";
import { eraseItems, finishPendingRemoteErasures, runArmedStatements } from "./erase.js";
import { trashEntries, normalizeTrashDays, DEFAULT_TRASH_DAYS } from "./trash.js";

/** Rows per pass when the caller does not say. */
export const DEFAULT_BATCH = 500;

/** The local setting that records how far the fresh-window scan has got (crow store). */
export const REDACT_SCAN_SETTING = "history.redact_scanned_to";

/**
 * The scan-mark key for one store. The crow store keeps the original key (so a
 * store that has been sweeping since Task 4 keeps its mark); every other store gets
 * its own suffixed key, so the two series of version ids can never overwrite each
 * other's progress.
 */
export function redactScanSetting(store = STORE_CROW) {
  return store === STORE_CROW ? REDACT_SCAN_SETTING : `${REDACT_SCAN_SETTING}.${store}`;
}

/** The stores a sweep may name, and the covered item types each one holds. */
function typesOfStore(store) {
  if (store !== STORE_CROW && store !== STORE_TASKS) {
    throw new Error(`history: sweep store must be ${STORE_CROW} or ${STORE_TASKS}, not ${JSON.stringify(store)}`);
  }
  return typesForStore(store);
}

/**
 * The `item_type IN (…)` predicate for one store's types, or "1 = 0" for a store
 * with no covered type (no pass may then touch any row). The values are the frozen
 * COVERED keys, quoted as SQL literals — never caller input.
 */
function typesPredicate(types) {
  if (types.length === 0) return "1 = 0";
  return `item_type IN (${types.map((t) => `'${String(t).replace(/'/g, "''")}'`).join(", ")})`;
}

/** The only retention value that is applied today. */
export const RETENTION_FOREVER = "forever";

/** What a matched secret becomes. */
export const REDACTION_PLACEHOLDER = "[redacted]";

/** Two saves this close together, by the same author on the same item, are one. */
export const COALESCE_WINDOW_MS = 120_000;

const MS_PER_DAY = 86_400_000;

/** Per-handle scan cursors: db → { redact: lastId, coalesce: lastId }. */
const CURSORS = new WeakMap();

function cursorFor(db) {
  let cursor = CURSORS.get(db);
  if (!cursor) {
    cursor = { redact: 0, coalesce: 0 };
    CURSORS.set(db, cursor);
  }
  return cursor;
}

/** The batch size actually used: a positive integer, else the default. */
function normalizeBatch(batchSize) {
  const n = Math.trunc(Number(batchSize));
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_BATCH;
}

/** A private-key block, header through its matching END (non-greedy, multi-line). */
const PEM_PRIVATE_KEY_BLOCK = /-----BEGIN ((?:[A-Z0-9]+ )*)PRIVATE KEY-----[\s\S]*?-----END \1PRIVATE KEY-----/g;
const PGP_PRIVATE_KEY_BLOCK = /-{5}BEGIN PGP PRIVATE KEY BLOCK-{5}[\s\S]*?-{5}END PGP PRIVATE KEY BLOCK-{5}/g;
const PEM_PRIVATE_KEY_HEADER = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/;
const PGP_PRIVATE_KEY_HEADER = /-{5}BEGIN PGP PRIVATE KEY BLOCK-{5}/;

/**
 * A credential carried in a URL QUERY STRING or FRAGMENT (`?api_key=…`,
 * `&token=…`, `#access_token=…`): the whole parameter, name and value, becomes
 * the placeholder.
 *
 * HISTORY-ONLY, deliberately not in SECRET_PATTERNS (the list CI's hygiene check
 * shares), and — see redactValue — applied ONLY to a snapshot value whose key
 * names a URL. Plain text is left alone: `?token=…` is ordinary in prose and in
 * documentation, and a redacted version cannot be restored (and a redacted delete
 * cannot be un-deleted), so the pattern is kept to the one field where a pasted
 * credential actually lands. A source's stored `url` is that field, and the value
 * in it looks like no known token shape (`SECRET_PATTERNS` never sees it).
 *
 * The `[?&;#]` prefix is what keeps this off SQL text and prose: a bare
 * `token=` is a column name in a statement or a sentence, not a URL parameter.
 * `#` covers the fragment an OAuth implicit-flow callback carries its token in
 * (`https://site/callback#access_token=…&expires_in=3600`).
 *
 * A value of `${…}`/`<…>` (a template or a placeholder) is left alone, and so is
 * an already-redacted one. Percent-encoding is NOT excluded: a base64 token whose
 * first character is `/` or `+` arrives as `%2F…` or `%2B…`, which is a
 * credential like any other.
 */
const URL_CREDENTIAL_QUERY = new RegExp(
  String.raw`[?&;#](?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token|refresh[_-]?token|id[_-]?token|token|secret|client[_-]?secret|password|passwd)=` +
    String.raw`(?![\[$<{])[^&#\s"'<>]{3,}`,
  "gi",
);

/**
 * A snapshot KEY that names a URL: `url` itself, or a snake_case field ending in
 * `_url` (a source's `final_url`, a hypothetical `source_url`). Only a value
 * under such a key gets the URL-credential scrub — see redactValue.
 */
const URL_FIELD_KEY = /(^|_)url$/i;

/** Does this snapshot key name a URL field? */
function isUrlFieldKey(key) {
  return typeof key === "string" && URL_FIELD_KEY.test(key);
}

/**
 * Replace every secret-shaped match in one DECODED string with the placeholder.
 *
 * The snapshot is JSON, so its stored strings are escaped (`\n`, `\"`, ...).
 * Running the patterns on that raw JSON misses a key that follows an escaped
 * newline (there is no word boundary between the literal `n` and the key), which
 * is why the caller decodes first and this function only ever sees real values.
 *
 * A private key is not just its header: the body is the secret. PEM/PGP blocks
 * are redacted from BEGIN through the matching END; an unmatched header (no END)
 * redacts the WHOLE value, because the field cannot be trusted to end anywhere.
 *
 * A credential in a URL query string or fragment is NOT handled here: that shape
 * is ordinary in prose and documentation, so it is applied per FIELD — see
 * redactUrlCredentials, which redactValue calls only for a url-named key.
 *
 * @returns {string|null} the rewritten text, or null when nothing matched
 */
export function redactText(text) {
  if (typeof text !== "string" || text === "") return null;
  let out = text;
  let hit = false;
  for (const pattern of [PEM_PRIVATE_KEY_BLOCK, PGP_PRIVATE_KEY_BLOCK]) {
    const next = out.replace(pattern, REDACTION_PLACEHOLDER);
    if (next !== out) {
      out = next;
      hit = true;
    }
  }
  if (PEM_PRIVATE_KEY_HEADER.test(out) || PGP_PRIVATE_KEY_HEADER.test(out)) {
    out = REDACTION_PLACEHOLDER;
    hit = true;
  }
  for (const [, pattern] of SECRET_PATTERNS) {
    // String#replace resets a global regex's lastIndex itself, so the shared
    // pattern objects are safe to reuse across rows and runs.
    const next = out.replace(pattern, REDACTION_PLACEHOLDER);
    if (next !== out) {
      out = next;
      hit = true;
    }
  }
  return hit ? out : null;
}

/**
 * Redact the credential-bearing parameters of ONE url field's value
 * (URL_CREDENTIAL_QUERY).
 *
 * URL-SCOPED on purpose (see the pattern and redactValue): the shape is ordinary
 * in prose, and a redacted version is one nobody can restore, so it is applied
 * only where a pasted link with a live key actually lands.
 *
 * @returns {string|null} the rewritten url, or null when nothing matched
 */
export function redactUrlCredentials(url) {
  if (typeof url !== "string" || url === "") return null;
  const rewritten = url.replace(URL_CREDENTIAL_QUERY, REDACTION_PLACEHOLDER);
  return rewritten === url ? null : rewritten;
}

/**
 * Walk every string VALUE of a decoded snapshot, redacting as it goes.
 *
 * The KEY rides along because the URL-credential scrub is field-scoped: it fires
 * for a value under a url-named key only (isUrlFieldKey), while PEM/PGP and
 * SECRET_PATTERNS fire for every string of every type. An array hands its own key
 * down to its elements, so a list of links under a url-named key is still covered.
 *
 * @returns {*} the rewritten value, or null when nothing matched
 */
function redactValue(value, key = null) {
  if (typeof value === "string") {
    const rewrittenText = redactText(value);
    let out = rewrittenText === null ? value : rewrittenText;
    let hit = rewrittenText !== null;
    if (isUrlFieldKey(key)) {
      const withoutCredentials = redactUrlCredentials(out);
      if (withoutCredentials !== null) {
        out = withoutCredentials;
        hit = true;
      }
    }
    return hit ? out : null;
  }
  let hit = false;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const next = redactValue(value[i], key);
      if (next !== null) {
        value[i] = next;
        hit = true;
      }
    }
  } else if (value && typeof value === "object") {
    for (const childKey of Object.keys(value)) {
      const next = redactValue(value[childKey], childKey);
      if (next !== null) {
        value[childKey] = next;
        hit = true;
      }
    }
  }
  return hit ? value : null;
}

/**
 * Redact one stored snapshot: decode the JSON, walk its string values, encode it
 * back. `redacted = 1` is set by the caller only after this whole row succeeded,
 * so a row is never marked redacted while any part of it still holds the secret.
 * @returns {string|null} the rewritten snapshot_json, or null when nothing matched
 */
export function redactSnapshot(snapshotJson) {
  let parsed;
  try {
    parsed = JSON.parse(snapshotJson);
  } catch {
    return null; // a corrupt snapshot is not a secret we can safely rewrite
  }
  const rewritten = redactValue(parsed);
  return rewritten === null ? null : JSON.stringify(rewritten);
}

/**
 * Are the history tables there? A store that has not run migration 0024 (it
 * defers until the covered tables exist) has nothing to sweep, and a pass that
 * threw "no such table" every five minutes would bury a real failure in noise.
 */
async function historyReady(db) {
  try {
    const { rows } = await db.execute({
      sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('item_versions', 'item_versions_erase')",
      args: [],
    });
    return rows.length === 2;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------- (a) redact */

/**
 * The persisted "scanned up to" mark: the highest version id the FRESH WINDOW has
 * covered, or null on a store that has never been scanned.
 *
 * It lives in dashboard_settings — the local key/value table Crow already keeps
 * `history.trash_days` and `history.erase_sync` in — under a key the sync
 * allowlist does not carry, so it is per-instance and never travels. A store with
 * no settings table (a bare test shim) simply has no mark.
 *
 * `settingsDb` is the client that OWNS dashboard_settings (crow.db). It is the same
 * handle for the crow pass, and the caller's crow.db client for a tasks pass (that
 * store has no settings table); `key` is the per-store key (see
 * redactScanSetting), so neither store's pass can move the other's mark.
 */
async function readRedactScanMark(settingsDb, key) {
  try {
    const { rows } = await settingsDb.execute({
      sql: "SELECT value FROM dashboard_settings WHERE key = ?",
      args: [key],
    });
    const value = Number(rows[0]?.value);
    return rows.length > 0 && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : null;
  } catch {
    return null;
  }
}

/** Move the mark forward (never back). A store that cannot keep it re-scans — safe. */
async function writeRedactScanMark(settingsDb, key, id) {
  const value = Math.trunc(Number(id));
  if (!Number.isFinite(value) || value < 0) return;
  try {
    await settingsDb.execute({
      sql: `INSERT INTO dashboard_settings (key, value) VALUES (?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
             WHERE CAST(excluded.value AS INTEGER) > CAST(dashboard_settings.value AS INTEGER)`,
      args: [key, String(value)],
    });
  } catch (err) {
    // A store with no settings table (a bare test shim) has nowhere to keep the
    // mark; anything else is worth a line. Either way the next pass starts at the
    // backlog cursor, which is the conservative direction (re-scan).
    if (!/no such table/i.test(String(err?.message ?? ""))) {
      console.warn("[history] sweep: could not record the redaction scan mark:", err?.message ?? err);
    }
  }
}

/**
 * Where the fresh window starts on this pass (see readRedactScanMark).
 *
 * The MARK comes from the settings store (crow.db); the NEWEST ID comes from the
 * store being swept, because the two stores' version ids are independent series —
 * `settingsDb`'s MAX(id) says nothing about tasks.db's rows.
 */
async function redactWindowStart(db, settingsDb, batchSize, key) {
  const mark = await readRedactScanMark(settingsDb, key);
  if (mark !== null) return mark;
  // Never scanned here: cover the newest batch, exactly what "scan the newest N
  // rows" used to cover, and let the mark take it from there.
  try {
    const { rows } = await db.execute("SELECT MAX(id) AS top FROM item_versions");
    const top = Number(rows[0]?.top);
    return Number.isFinite(top) ? Math.max(0, top - batchSize) : 0;
  } catch {
    return 0;
  }
}

/** Redact one page of versions. @returns {Promise<number>} rows rewritten */
async function redactPage(db, rows) {
  const matches = [];
  for (const row of rows) {
    const rewritten = redactSnapshot(row.snapshot_json);
    if (rewritten !== null) matches.push({ id: Number(row.id), snapshot: rewritten });
  }
  if (matches.length === 0) return 0;
  await withoutWriteContext(() =>
    runArmedStatements(
      db,
      matches.map((match) => ({
        sql: "UPDATE item_versions SET snapshot_json = ?, redacted = 1 WHERE id = ?",
        args: [match.snapshot, match.id],
      })),
    ),
  );
  return matches.length;
}

/**
 * One redaction pass: continue the backlog walk from the cursor, then scan the
 * FRESH WINDOW — the versions written since the last pass, above the persisted
 * "scanned up to" mark — so a secret written since the last run is caught at
 * once and none of those rows is scanned twice.
 */
async function redactPass(db, batchSize, { types, key, settingsDb }) {
  const cursor = cursorFor(db);
  const scope = typesPredicate(types);
  const backlog = await db.execute({
    sql: `SELECT id, snapshot_json FROM item_versions
           WHERE redacted = 0 AND ${scope} AND id > ?
           ORDER BY id ASC LIMIT ?`,
    args: [cursor.redact, batchSize],
  });
  let redacted = await redactPage(db, backlog.rows);
  if (backlog.rows.length > 0) {
    cursor.redact = Number(backlog.rows[backlog.rows.length - 1].id);
  } else if (cursor.redact > 0) {
    // The walk reached the end: start the next one from the top. Rows written
    // meanwhile have higher ids and are scanned by the fresh window below.
    cursor.redact = 0;
  }

  const from = await redactWindowStart(db, settingsDb, batchSize, key);
  // The window scans by ID, redacted rows included: they are skipped for the work
  // but still count as scanned, so the mark stays a contiguous "everything up to
  // here has been looked at" (a row that matched nothing, or was already redacted,
  // must not pin the mark forever).
  const fresh = await db.execute({
    sql: `SELECT id, snapshot_json, redacted FROM item_versions
           WHERE ${scope} AND id > ?
           ORDER BY id ASC LIMIT ?`,
    args: [from, batchSize],
  });
  redacted += await redactPage(
    db,
    fresh.rows.filter((row) => Number(row.redacted) !== 1),
  );
  // Persist the mark even when the page was empty (a store whose ids are sparse
  // would otherwise restart from the same place forever), and only forwards.
  const highest = fresh.rows.length > 0 ? Number(fresh.rows[fresh.rows.length - 1].id) : null;
  await writeRedactScanMark(settingsDb, key, highest === null ? from : Math.max(from, highest));
  return redacted;
}

/* ----------------------------------------------------------- (b) coalesce */

const isMillis = (v) => typeof v === "string" && Number.isFinite(Date.parse(v));

/**
 * Are these two versions of one item one save? Both updates, by the same named
 * author in the same job, less than COALESCE_WINDOW_MS apart, neither redacted.
 * An unattributed pair (author_id NULL) is never coalesced: "the same author" is
 * unknowable, and guessing would delete history nothing accounts for.
 */
export function coalescible(older, newer) {
  if (!older || !newer) return false;
  if (older.op !== "update" || newer.op !== "update") return false;
  if (Number(older.redacted) === 1 || Number(newer.redacted) === 1) return false;
  if (older.author_id == null || older.author_id !== newer.author_id) return false;
  if ((older.job_id ?? null) !== (newer.job_id ?? null)) return false;
  if (!isMillis(older.created_at) || !isMillis(newer.created_at)) return false;
  return Math.abs(Date.parse(newer.created_at) - Date.parse(older.created_at)) < COALESCE_WINDOW_MS;
}

/** One coalescing pass. @returns {Promise<number>} versions removed */
async function coalescePass(db, batchSize, { types }) {
  const cursor = cursorFor(db);
  const scope = typesPredicate(types);
  const { rows } = await db.execute({
    sql: `SELECT id, item_type, item_id, op, author_id, job_id, created_at, redacted
            FROM item_versions
           WHERE ${scope} AND id > ?
           ORDER BY id ASC LIMIT ?`,
    args: [cursor.coalesce, batchSize],
  });
  if (rows.length === 0) {
    cursor.coalesce = 0;
    return 0;
  }

  // A run is anchored on its OLDEST version: the window closes when the newest
  // save is >= COALESCE_WINDOW_MS after the run started, not merely when it is
  // 2 minutes after the previous save. An hour of saves every 30 s therefore
  // keeps one version per two minutes instead of one per hour.
  const runs = new Map();
  const doomed = new Set();
  for (const row of rows) {
    const key = `${row.item_type}\u0000${row.item_id}`;
    const { rows: prior } = await db.execute({
      sql: `SELECT id, item_type, item_id, op, author_id, job_id, created_at, redacted
              FROM item_versions
             WHERE item_type = ? AND item_id = ? AND id < ?
             ORDER BY id DESC LIMIT 1`,
      args: [row.item_type, row.item_id, Number(row.id)],
    });
    if (!prior.length || row.op !== "update" || Number(row.redacted) === 1) {
      runs.delete(key);
      continue;
    }
    const priorRow = prior[0];
    const at = Date.parse(row.created_at);
    if (!Number.isFinite(at)) {
      runs.delete(key);
      continue;
    }

    let run = runs.get(key);
    if (!run && coalescible(priorRow, row)) {
      // The cursor may have started mid-run: anchor on the version just before
      // the batch so the same window is used across batches.
      run = {
        start: Date.parse(priorRow.created_at),
        authorId: row.author_id,
        jobId: row.job_id ?? null,
        lastId: Number(priorRow.id),
      };
    }
    if (!run || !coalescible(priorRow, row) || run.authorId !== row.author_id || run.jobId !== (row.job_id ?? null)) {
      // A different author/job, or a non-update in between: this row starts a run.
      runs.set(key, { start: at, authorId: row.author_id, jobId: row.job_id ?? null, lastId: Number(row.id) });
      continue;
    }
    if (at - run.start >= COALESCE_WINDOW_MS) {
      // The anchored window is closed: the previous run's newest version stays,
      // and this row is the first of the next run.
      runs.set(key, { start: at, authorId: row.author_id, jobId: row.job_id ?? null, lastId: Number(row.id) });
      continue;
    }
    doomed.add(Number(priorRow.id));
    run.lastId = Number(row.id);
    runs.set(key, run);
  }
  const nextCursor = Number(rows[rows.length - 1].id);
  if (doomed.size === 0) {
    cursor.coalesce = nextCursor;
    return 0;
  }

  const ids = [...doomed];
  await withoutWriteContext(() =>
    runArmedStatements(db, [
      { sql: `DELETE FROM item_versions WHERE id IN (${ids.map(() => "?").join(", ")})`, args: ids },
    ]),
  );
  // Only past a batch that actually landed: a failed delete leaves the pair for the
  // next run (it stays history, which is the safe direction).
  cursor.coalesce = nextCursor;
  return ids.length;
}

/* -------------------------------------------------------------- (c) erase */

/** Erase the Trash items older than the period, in one bounded page. */
async function erasePass(db, { now, trashDays, batchSize, syncManager, types }) {
  const cutoff = new Date(now.getTime() - normalizeTrashDays(trashDays) * MS_PER_DAY).toISOString();
  // `itemTypes` keeps the pass inside this store's types: a tasks pass must never
  // list (and so never erase) a crow.db item that shares tasks.db's id space.
  const entries = await trashEntries(db, { before: cutoff, limit: batchSize, itemTypes: types });
  if (entries.length === 0) return { erased: [], versions: 0, emitted: 0, cutoff };
  const { erased, versions, emitted } = await eraseItems(
    db,
    entries.map((e) => ({ itemType: e.itemType, itemId: e.itemId })),
    // The Trash clock is Crow's own unit of work: no person is pressing a button.
    { authorKind: "system", authorId: "history-sweep" },
    // The conditional is inside the armed transaction: a restore that landed
    // after the listing wrote a newer version, so this item is left alive (and
    // its tombstone is not written either).
    { deletedBefore: cutoff, syncManager },
  );
  return { erased: erased.filter((e) => e.versions > 0), versions, emitted, cutoff };
}

/* -------------------------------------------------------------- (d) retries */

/**
 * Finish the inbound erases that could not be applied atomically (erase.js's
 * pending_remote_erasures). Bounded, and a marker that fails again stays for the
 * next run: one broken erase must not stop the others, and none is deleted
 * because "we tried".
 */
async function pendingErasePass(db, batchSize) {
  try {
    const { completed, failed } = await finishPendingRemoteErasures(db, { limit: batchSize });
    if (failed.length > 0) {
      console.warn(
        `[history] sweep: ${failed.length} pending inbound erase(s) still could not be finished: ` +
          failed.map((entry) => entry.error).join("; ").slice(0, 500),
      );
    }
    return completed;
  } catch (err) {
    console.warn("[history] sweep: finishing pending inbound erases failed:", err?.message ?? err);
    return 0;
  }
}

/**
 * One sweep.
 *
 * Never throws for a configuration value: an unusable `trashDays` falls back to
 * the default, and any `retention` other than "forever" is reported and not
 * applied. Errors from the database DO propagate — the boot caller catches and
 * logs them, and a failed pass must not look like a clean one.
 *
 * ONE STORE, BY NAME. `store` says which item_versions this handle's file holds:
 * `crow` (the default: memories, posts, sections, notes, articles, bot defs) or
 * `tasks` (board cards, in the instance-global tasks.db). The pass touches ONLY
 * that store's covered types — see the module comment — and writes its scan mark
 * under that store's own key.
 *
 * @param {object} db the client for the store being swept
 * @param {{now?: Date, trashDays?: number, retention?: string, batchSize?: number,
 *   store?: string, settingsDb?: object|null,
 *   syncManager?: object|null|undefined}} [opts]
 *   `store` is `crow` or `tasks` (default `crow`). `settingsDb` is the client that
 *   OWNS dashboard_settings (crow.db) — the same handle for a crow pass, and the
 *   caller's crow.db client for a tasks pass, because tasks.db has no settings
 *   table and the scan mark must live where the settings live; without it a pass
 *   reads and writes only its own handle (right for crow, mark-less for tasks).
 *   `syncManager` is handed to the erase pass (see erase.js); undefined resolves
 *   this process's singleton.
 * @returns {Promise<{store: string, redacted: number, coalesced: number,
 *   erased: Array<{itemType: string, itemId: string, versions: number}>,
 *   erasedVersions: number, eraseEvents: number, pendingErased: number,
 *   retention: {value: string, applied: boolean}, trashDays: number, batchSize: number}>}
 */
export async function sweep(db, { now = new Date(), trashDays = DEFAULT_TRASH_DAYS, retention = RETENTION_FOREVER, batchSize = DEFAULT_BATCH, store = STORE_CROW, settingsDb = null, syncManager = undefined } = {}) {
  const batch = normalizeBatch(batchSize);
  const days = normalizeTrashDays(trashDays);
  const types = typesOfStore(store);
  // The settings store: this handle for the crow store, the caller's crow.db client
  // for any other store (see the option's doc).
  const settings = settingsDb || db;
  const markKey = redactScanSetting(store);
  const retentionValue = typeof retention === "string" && retention.trim() !== "" ? retention.trim() : RETENTION_FOREVER;
  const base = {
    store,
    redacted: 0,
    coalesced: 0,
    erased: [],
    erasedVersions: 0,
    eraseEvents: 0,
    pendingErased: 0,
    // Only `forever` is applied; anything else is a no-op until a thinning
    // schedule is specified (the design §8.9 / the plan's Task 4 note).
    retention: { value: retentionValue, applied: retentionValue === RETENTION_FOREVER },
    trashDays: days,
    batchSize: batch,
  };
  if (!(await historyReady(db))) return { ...base, skipped: "item_versions absent" };

  // A sweep is nobody's unit of work: nothing it writes is attributed to whoever
  // happened to be on the stack when the interval fired.
  return withoutWriteContext(async () => {
    const redacted = await redactPass(db, batch, { types, key: markKey, settingsDb: settings });
    const coalesced = await coalescePass(db, batch, { types });
    const erasedResult = await erasePass(db, { now, trashDays: days, batchSize: batch, syncManager, types });
    // (d) Finish the inbound erases a failed apply left behind. After the erase
    // pass on purpose: those items are already tombstoned, so nothing here can be
    // resurrected while the retry runs. CROW STORE ONLY: an inbound erase arrives
    // over instance sync, whose tables are all crow.db's — the card store never
    // carries a pending_remote_erasures row, and a tasks pass has no business
    // looking for one.
    const pendingFinished = store === STORE_CROW ? await pendingErasePass(db, batch) : 0;
    return {
      ...base,
      redacted,
      coalesced,
      pendingErased: pendingFinished,
      erased: erasedResult.erased,
      erasedVersions: erasedResult.versions,
      eraseEvents: erasedResult.emitted,
    };
  });
}