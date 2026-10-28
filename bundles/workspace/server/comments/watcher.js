/**
 * Comment loop: the saved-file watcher (spec §3.6), Phase 1 shadow mode.
 * It READS only: SEARCH listings, file GETs, version PROPFINDs, display-name PROPFINDs, and the editor sessions'
 * OCS config + command-service `info` (through sweepSessions). It never PUTs, PROPPATCHes, MOVEs or forcesaves, and
 * it logs verdicts (hash + snippet, never the comment text) instead of acting on them.
 *
 * One tick: mode / block check (mode off → no Nextcloud call at all) → back-off → lease → prune → session sweep →
 * for changed etags (≤ MAX_DOWNLOADS downloads; over MAX_BYTES by listing size → skipped until the etag changes):
 * download, snapshot, diff, classify, log → putState per file. A Nextcloud outage (NcError: no answer, or an HTTP
 * error other than 403/404/423, e.g. 5xx) ends the tick (files already done keep their state), backs off BACKOFF_MS
 * and widens the next listing to OUTAGE_LIMIT. A 403, 404 or 423 while scanning one file, or any non-Nextcloud error,
 * is that file's alone: it is marked skip_reason "error" (retried when its etag changes), a scan_error event is
 * logged (no comment text), and the tick goes on.
 */
import { randomUUID } from "node:crypto";
import { appImport } from "../app-root.js";
import { listRecent, getFile } from "../nc/dav.js";
import { splitPath } from "../nc/paths.js";
import { listVersions } from "../nc/versions.js";
import { displayName, ocsGet } from "../nc/ocs.js";
import { getNcInstanceId } from "../nc/onlyoffice.js";
import { NcError } from "../result.js";
import { openDocx } from "../ooxml/docx-model.js";
import { readCommentThreads } from "../ooxml/docx-comments.js";
import { flatten, fingerprint, snapshot as snapshotOf, diff, pairKey } from "./keys.js";
import { DOCX_MIME, sweepSessions } from "./sessions.js";
import { getWatch, setBlocked, takeLease, prune, getState, putState, logEvent, textHash, snippetOf } from "./store.js";
import { isBotAuthor, historyOf, savedOwner, verdictOf } from "./identity.js";

export const TICK_MS = 15000;
export const LIVE_TICK_MS = 5000;
export const MAX_DOWNLOADS = 5;
export const MAX_BYTES = 20 * 1024 * 1024;
export const BACKOFF_MS = 60000;
export const RECENT_LIMIT = 60;
export const OUTAGE_LIMIT = 200;
export const NAME_CHECK_MS = 24 * 3600 * 1000;
export const NAME_RETRY_MS = 3600 * 1000;
const WINDOW_SLACK_MS = 30000; // the same ±30 s soleOwnerWindowAt uses
/** Nextcloud answers that concern one file (forbidden, gone, locked): that file is skipped, the tick goes on. */
const PER_FILE_STATUS = new Set([403, 404, 423]);

let mentionsP = null;
const mentions = () => (mentionsP ??= appImport("servers/shared/bot-mention.js").catch((e) => { mentionsP = null; throw e; }));
const parseJson = (s, d) => { try { return JSON.parse(s); } catch { return d; } };
const errCode = (err) => (/^[a-z_]{1,40}$/.test(String(err?.code || "")) ? err.code : "error");

const normName = (s) => String(s ?? "").normalize("NFC").trim().toLowerCase();

/**
 * Spec §3.3: does another account share an owner's display name? Crow bot's full-match autocomplete finds exact
 * display names outside its group (spike E12). → true (clash), false (none), null (could not tell: Nextcloud
 * failed, or an owner's name is unknown). Reads only.
 */
export async function ownerNameClash(cfg) {
  try {
    const owners = new Set(cfg.ownerUids);
    for (const uid of cfg.ownerUids) {
      const name = await displayName(cfg, uid);
      if (!name || !normName(name)) return null;
      const q = new URLSearchParams({ search: name, itemType: "", itemId: "", limit: "200" });
      q.append("shareTypes[]", "0");
      const found = await ocsGet(cfg, `/ocs/v2.php/core/autocomplete/get?${q}`);
      if (!Array.isArray(found)) return null;
      if (found.some((u) => !owners.has(String(u?.id)) && normName(u?.label) === normName(name))) return true;
    }
    return false;
  } catch { return null; }
}

/** seams.snapshot: tests only (a failure inside one file's scan). */
export function makeCommentTick({ db, getConfig, clock, seams = {} }) {
  const owner = `comment-watch:${randomUUID()}`;
  let backoffUntil = 0, outage = false, nextNameCheck = 0;

  return async function tick() {
    const now = clock.now();
    const watch = await getWatch(db);
    if (watch.mode === "off") return { ran: false, why: "off", nextMs: TICK_MS };
    let cfg;
    try { cfg = getConfig(); } catch { return { ran: false, why: "not_ready", nextMs: TICK_MS }; }
    if (cfg.commentLoopBlocked || watch.blocked_reason) return { ran: false, why: "blocked", nextMs: TICK_MS };
    if (now < backoffUntil) return { ran: false, why: "backoff", nextMs: backoffUntil - now };
    if (!(await takeLease(db, owner, now))) return { ran: false, why: "lease", nextMs: TICK_MS };
    await prune(db, now);

    // At start and then daily (retried hourly when it could not run). It only ever SETS a block: clearing one is
    // bootstrap's job (through the env) or an operator's.
    if (now >= nextNameCheck) {
      const clash = await ownerNameClash(cfg);
      nextNameCheck = now + (clash === null ? NAME_RETRY_MS : NAME_CHECK_MS);
      if (clash === true) { await setBlocked(db, "duplicate_display_name"); console.warn("[workspace] comment watcher: another account has an owner's display name; the loop is blocked"); return { ran: false, why: "blocked", nextMs: TICK_MS }; }
    }

    const limit = outage ? OUTAGE_LIMIT : RECENT_LIMIT;
    let anyLive = false;
    try {
      ({ anyLive } = await sweepSessions({ db, getConfig: () => cfg, clock, limit }));
      const entries = await listRecent(cfg, { limit, mimes: [DOCX_MIME] });
      const ctx = { db, cfg, now, watch, names: null, instanceId: getNcInstanceId() || cfg.ncInstanceId || null, snapshot: seams.snapshot || snapshotOf };
      let downloads = 0;
      for (const e of entries) {
        if (e.isFolder || !(Number(e.fileId) > 0)) continue;
        const st = await getState(db, e.fileId);
        if (st && st.etag === e.etag) continue;
        if (e.size > MAX_BYTES) { await skip(ctx, e, st, { etag: e.etag, mtime: e.mtime }, "too_large"); continue; }
        if (downloads >= MAX_DOWNLOADS) continue; // the rest wait for the next tick (oversized ones are still marked)
        downloads++;
        try { await scanFile(ctx, e, st); } catch (err) {
          if (err instanceof NcError && !PER_FILE_STATUS.has(err.status)) throw err;
          await skip(ctx, e, st, { etag: e.etag, mtime: e.mtime }, "error");
          await logEvent(db, { at: now, fileId: e.fileId, kind: "scan_error", detail: { source: "saved", code: errCode(err) } });
          console.warn(`[workspace] comment watcher: file ${Number(e.fileId)} skipped (${errCode(err)})`);
        }
      }
      outage = false;
    } catch (err) {
      if (!(err instanceof NcError)) throw err; // not an outage: no back-off (the loop logs it and ticks again)
      backoffUntil = clock.now() + BACKOFF_MS; outage = true;
      console.warn(`[workspace] comment watcher: ${errCode(err)}; backing off`);
      return { ran: true, error: true, nextMs: BACKOFF_MS };
    }
    return { ran: true, nextMs: anyLive ? LIVE_TICK_MS : TICK_MS };
  };
}

const baseRow = (e, st, now) => ({ file_id: e.fileId, first_seen_at: st?.first_seen_at ?? now, own_put_etag: st?.own_put_etag ?? null });

/** Remember the etag so the file is not retried until it changes; the last parsed snapshot is kept. */
function skip(ctx, e, st, { etag, mtime }, reason) {
  return putState(ctx.db, { ...baseRow(e, st, ctx.now), etag, mtime, threads_json: st?.threads_json ?? "[]", scanned_at: st?.scanned_at ?? null, skip_reason: reason });
}

async function scanFile(ctx, e, st) {
  const { db, cfg, now, watch } = ctx;
  const got = await getFile(cfg, splitPath(e.path), { maxBytes: MAX_BYTES }).catch((err) => { if (err?.code === "too_large") return null; throw err; });
  if (!got) return skip(ctx, e, st, { etag: e.etag, mtime: e.mtime }, "too_large");
  let parsed;
  try { parsed = readCommentThreads(openDocx(got.bytes)); } catch { return skip(ctx, e, st, got, "unreadable"); }
  const { parseMentions, resolveMentionedBot } = await mentions();
  const next = ctx.snapshot(parsed.threads, parseMentions);
  const nextJson = JSON.stringify(next);
  const prev = st?.scanned_at ? parseJson(st.threads_json, []) : null; // null = first sighting
  const row = baseRow(e, st, now);

  // E1 close-save (and the save of Crow's own PUT): the comment parts are the same → etag/mtime only.
  if (prev && st.threads_json === nextJson) {
    return putState(db, { ...row, etag: got.etag, mtime: got.mtime, threads_json: st.threads_json, scanned_at: st.scanned_at, skip_reason: null });
  }

  const { added, edited, rekeys } = diff(prev, next);
  const flat = flatten(parsed.threads);
  const byFp = new Map(flat.map((c) => [fingerprint(c), c]));
  const people = new Map([...parsed.people].map(([a, u]) => [String(a).normalize("NFC"), u]));
  const prevFps = new Set((prev || []).flatMap((t) => t.comments.map((c) => c.fp)));

  // Pass 1 (no Nextcloud): which new / edited comments name an enabled bot and were not written by a bot.
  const cands = [];
  for (const [kind, x, tokens] of [...added.map((x) => ["scan_new", x, x.tokens]), ...edited.map((x) => ["scan_edit", x, x.newTokens])]) {
    if (!tokens?.length) continue;
    const c = byFp.get(x.fp);
    if (!c) continue;
    const peopleUid = people.get(c.author) ?? null;
    if (isBotAuthor(c.author, peopleUid)) continue;
    let bot = null;
    for (const t of tokens) { bot = await resolveMentionedBot(db, t); if (bot) break; }
    if (bot) cands.push({ kind, x, c, peopleUid, bot });
  }

  // Pass 2: the Nextcloud facts the rules need, fetched BEFORE any event is logged, so a failure here logs nothing
  // and the whole file is retried.
  let facts = null;
  if (cands.length) {
    ctx.names ??= await Promise.all(cfg.ownerUids.map((u) => displayName(cfg, u)));
    const versions = await listVersions(cfg, e.fileId);
    // The version the GET returned, by its mtime; not listed → no newest version → non_owner_version (fail closed).
    const newest = versions.find((v) => Number(v.versionId) === Number(got.mtime)) || null;
    const prevVersion = newest ? versions.find((v) => Number(v.versionId) < Number(newest.versionId)) || null : null;
    const sinceS = prev ? Number(st.mtime) : Math.floor(Number(watch.watch_since) / 1000);
    let sessionFirstSeenMs = null;
    if (newest) {
      const t = Number(newest.versionId) * 1000;
      const r = (await db.execute({ sql: "SELECT MIN(first_seen) AS f FROM workspace_editor_sessions WHERE file_id=? AND first_seen-?<=? AND last_seen+?>=?", args: [Number(e.fileId), WINDOW_SLACK_MS, t, WINDOW_SLACK_MS, t] })).rows[0];
      sessionFirstSeenMs = r?.f == null ? null : Number(r.f);
    }
    facts = {
      newest, versionsSince: versions.filter((v) => Number(v.versionId) > sinceS).length,
      prevVersionMtimeS: prevVersion ? Number(prevVersion.versionId) : null, sessionFirstSeenMs,
      sinceMs: prev ? Number(st.scanned_at) : Number(watch.watch_since) || 0,
    };
  }

  for (const { kind, x, c, peopleUid, bot } of cands) {
    const pair = pairKey(e.fileId, c.author, c.date);
    const common = { source: "saved", pair, fp: x.fp, hash: textHash(c.text), snippet: snippetOf(c.text), bot: bot.botId };
    await logEvent(db, { at: now, fileId: e.fileId, kind, detail: common });
    await checkLiveFp(db, now, e.fileId, pair, x.fp, flat, bot.botId);
    const history = historyOf({ date: c.date, watchSince: watch.watch_since, knownFp: prevFps.has(x.fp), firstSighting: !prev, sessionFirstSeenMs: facts.sessionFirstSeenMs, prevVersionMtimeS: facts.prevVersionMtimeS });
    const identity = await savedOwner({ author: c.author, peopleUid, instanceId: ctx.instanceId, newestVersion: facts.newest, versionsSince: facts.versionsSince, db, fileId: e.fileId, sinceMs: facts.sinceMs, ownerUids: cfg.ownerUids, ownerNames: ctx.names });
    const v = verdictOf(history, identity);
    const age = Date.parse(c.date);
    await logEvent(db, { at: now, fileId: e.fileId, kind: v.kind, detail: { ...common, reason: v.reason, sole: !!identity.sole, age_s: Number.isFinite(age) ? Math.round((now - age) / 1000) : null } });
  }
  for (const r of rekeys) await logEvent(db, { at: now, fileId: e.fileId, kind: "rekey", detail: { source: "saved", from: r.from, to: r.to, ambiguous: !!r.ambiguous } });
  return putState(db, { ...row, etag: got.etag, mtime: got.mtime, threads_json: nextJson, scanned_at: now, skip_reason: null });
}

/**
 * fp_mismatch: a live_report for the same (file, author, second) whose fp matches neither this comment nor any other
 * saved comment of that pair (two comments in the same second, e.g. paste duplicates, legitimately share a pair).
 */
async function checkLiveFp(db, now, fileId, pair, fp, flat, bot) {
  const live = (await db.execute({ sql: "SELECT detail_json FROM workspace_comment_events WHERE kind='live_report' AND file_id=? AND json_extract(detail_json,'$.pair')=?", args: [fileId, pair] })).rows
    .map((r) => parseJson(r.detail_json, {}).fp).filter((x) => typeof x === "string");
  if (!live.length || live.includes(fp)) return;
  const saved = new Set(flat.filter((o) => pairKey(fileId, o.author, o.date) === pair).map(fingerprint));
  const other = live.find((x) => !saved.has(x));
  if (other) await logEvent(db, { at: now, fileId, kind: "fp_mismatch", detail: { source: "saved", pair, fp, live_fp: other, bot } });
}

let running = null;
/** One watcher per gateway process; ticks every TICK_MS (LIVE_TICK_MS while a docx session is live). → {stop}. */
export function startCommentWatcher({ db, getConfig, clock }) {
  if (running) return running;
  const tick = makeCommentTick({ db, getConfig, clock });
  let timer = null, stopped = false;
  const loop = async () => {
    let next = TICK_MS;
    try { next = (await tick())?.nextMs || TICK_MS; } catch (e) { console.warn(`[workspace] comment watcher tick failed: ${e?.code || "error"}`); }
    if (!stopped) { timer = setTimeout(loop, Math.max(1000, next)); timer.unref?.(); }
  };
  timer = setTimeout(loop, TICK_MS); timer.unref?.();
  const handle = { stop() { stopped = true; clearTimeout(timer); if (running === handle) running = null; } };
  running = handle;
  return handle;
}
