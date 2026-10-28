/**
 * Comment loop fast path (spec §3.1, §3.2, §3.5), Phase 1 shadow mode: the plugin's POST /comments report.
 * The plugin is a sensor; everything is decided here, and in Phase 1 nothing is acted on: the report is logged
 * (live_report, then a verdict event) with a hash + snippet, never the comment text.
 *
 * Hash contract (Task 6 review): the live thread goes through the SAME keys.fromLive → keys.flatten path the saved
 * side's scan uses (NFC, CRLF → LF for text; quote whitespace collapsed, so E11's "p1\r\np2\r\n" QuoteText matches
 * the saved quote), and the same store.textHash / store.snippetOf. A live report and the saved comment built from
 * the same text therefore carry the same fp, hash and snippet.
 *
 * Which comment of the thread a report is about: on "add", the root; on "change", the newest comment (by Time,
 * later in thread order on a tie) whose text names an enabled bot. A root edited after its replies picks a newer
 * reply that also names a bot (accepted in shadow mode).
 */
import { appImport } from "../app-root.js";
import { stat } from "../nc/dav.js";
import { displayName } from "../nc/ocs.js";
import { fromLive, flatten, fingerprint, contentKeyOf, pairKey } from "./keys.js";
import { sessionByKey } from "./sessions.js";
import { getWatch, getState, logEvent, textHash, snippetOf } from "./store.js";
import { isBotAuthor, liveOwner, historyOf, verdictOf } from "./identity.js";

export const TEXT_MAX = 4096;
export const REPLIES_MAX = 50;
const NAME_MAX = 200;
const ID_MAX = 64;

let mentionsP = null;
const mentions = () => (mentionsP ??= appImport("servers/shared/bot-mention.js").catch((e) => { mentionsP = null; throw e; }));
const parseJson = (s, d) => { try { return JSON.parse(s); } catch { return d; } };

const str = (v, max) => typeof v === "string" && v.length <= max;
const time = (v) => (typeof v === "number" && Number.isFinite(v) && v > 0) || (typeof v === "string" && /^\d{1,16}$/.test(v));
const comment = (c) => c && typeof c === "object" && str(c.Text, TEXT_MAX) && time(c.Time) && str(c.UserName, NAME_MAX);

/** → {ok:true, r} | {ok:false}. r = {key, pv, kind, thread:{Id,Text,Time,UserName,QuoteText,Solved,Replies[]}, occ}. */
export function validateReport(body) {
  const b = body && typeof body === "object" && !Array.isArray(body) ? body : null;
  if (!b || !str(b.key, NAME_MAX) || !b.key || !(b.kind === "add" || b.kind === "change")) return { ok: false };
  const t = b.thread;
  if (!comment(t) || !str(t.Id, ID_MAX)) return { ok: false };
  if (t.QuoteText !== undefined && t.QuoteText !== null && !str(t.QuoteText, TEXT_MAX)) return { ok: false };
  const replies = t.Replies ?? [];
  if (!Array.isArray(replies) || replies.length > REPLIES_MAX || !replies.every(comment)) return { ok: false };
  const occ = b.occ;
  if (!Array.isArray(occ) || occ.length !== replies.length + 1 || !occ.every((n) => Number.isInteger(n) && n >= 0 && n < 10000)) return { ok: false };
  return {
    ok: true,
    r: {
      key: b.key, pv: typeof b.pv === "string" ? b.pv : null, kind: b.kind, occ: [...occ],
      thread: {
        Id: t.Id, Text: t.Text, Time: t.Time, UserName: t.UserName, QuoteText: t.QuoteText ?? "", Solved: t.Solved === true,
        Replies: replies.map((x) => ({ Text: x.Text, Time: x.Time, UserName: x.UserName })),
      },
    },
  };
}

/** The comment a report is about (see the header), with its first bot, or null. */
async function subjectOf(r, flat, db) {
  const { parseMentions, resolveMentionedBot } = await mentions();
  const botOf = async (c) => { for (const t of parseMentions(c.text)) { const b = await resolveMentionedBot(db, t); if (b) return b; } return null; };
  if (r.kind === "add") { const c = flat[0]; const bot = await botOf(c); return bot ? { c, bot } : null; }
  const times = [Number(r.thread.Time), ...r.thread.Replies.map((x) => Number(x.Time))];
  const order = flat.map((c, i) => i).sort((a, b) => times[b] - times[a] || b - a);
  for (const i of order) { const bot = await botOf(flat[i]); if (bot) return { c: flat[i], bot }; }
  return null;
}

/**
 * live = the router's req.live ({editor, fileId, key, uid, uids, at, path}); body = validateReport(...).r.
 * → {state: "off"|"shadow"}. Mode on is shadow in Phase 1 (nothing is ever written); blocked is off.
 */
export async function handleLiveReport({ db, getConfig, clock, live, body }) {
  const watch = await getWatch(db);
  const cfg = getConfig();
  if (watch.mode === "off" || watch.blocked_reason || cfg.commentLoopBlocked) return { state: "off" };
  const receivedAt = clock.now();
  const r = body;
  const flat = flatten(fromLive(r.thread, r.occ));
  const hit = await subjectOf(r, flat, db);
  if (!hit || isBotAuthor(hit.c.author, null)) return { state: "shadow" };
  const { c, bot } = hit;
  const fileId = live.fileId;
  const fp = fingerprint(c);
  const pair = pairKey(fileId, c.author, c.date);
  const common = { source: "live", pair, fp, hash: textHash(c.text), snippet: snippetOf(c.text), bot: bot.botId };
  await logEvent(db, { at: receivedAt, fileId, kind: "live_report", detail: { ...common, latency_ms: r.kind === "add" ? receivedAt - Number(r.thread.Time) : null } });

  const st = await getState(db, fileId);
  // known: the last scan held this fingerprint, or (the watcher's rule) a comment with the same author, second and text
  const held = parseJson(st?.threads_json, []).flatMap((t) => t.comments || []);
  const ck = contentKeyOf(c);
  const knownFp = held.some((x) => x.fp === fp || (x.ck && x.ck === ck));
  const firstSighting = !st?.scanned_at;
  const row = await sessionByKey(db, live.key);
  let prevVersionMtimeS = null;
  if (firstSighting && !knownFp) {
    const e = await stat(cfg, live.path ? { path: live.path } : { file_id: fileId }).catch(() => null);
    prevVersionMtimeS = Number(e?.mtime) > 0 ? Number(e.mtime) : null;
  }
  const history = historyOf({ date: c.date, watchSince: watch.watch_since, knownFp, firstSighting, sessionFirstSeenMs: row?.first_seen ?? null, prevVersionMtimeS });
  const ownerNames = await Promise.all(cfg.ownerUids.map((u) => displayName(cfg, u).catch(() => null)));
  const identity = liveOwner({ reporterUid: live.uid, sessionUids: live.uids, sessionRow: row, payloadName: c.author, tokenName: live.editor.userName, ownerUids: cfg.ownerUids, ownerNames });
  const v = verdictOf(history, identity);
  const age = Date.parse(c.date);
  await logEvent(db, { at: receivedAt, fileId, kind: v.kind, detail: { ...common, reason: v.reason, sole: !!identity.sole, age_s: Number.isFinite(age) ? Math.round((receivedAt - age) / 1000) : null } });
  return { state: "shadow" };
}
