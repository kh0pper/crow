// Crow Artifacts — threads, comments, caps, deletion, carry-forward
// (spec §4.2, §4.3, §5.3, §7.3; D19).
//
// Authors: { kind: "owner" } (the operator), { kind: "contact", id } (a
// verified contact identity — step 6 wires the transport), { kind: "bot", id }.
import { LIMITS } from "./limits.js";
import { audit, isTainted } from "./store.js";

const err = (code, message) => Object.assign(new Error(message || code), { code });

/** Server-side anchor schema: the same shapes the viewer accepts (viewer.js
 *  validAnchor), re-checked here because the browser is not the boundary. */
export function validAnchor(a) {
  if (!a || typeof a !== "object" || Array.isArray(a)) return null;
  const s = JSON.stringify(a);
  if (Buffer.byteLength(s) > LIMITS.anchorJsonBytes) return null;
  const str = (v, n) => typeof v === "string" && v.length <= n;
  if (a.kind === "element" && str(a.selector, 1024) && str(a.text, 400)) return { kind: "element", selector: a.selector, text: a.text };
  if (a.kind === "text" && str(a.quote, 1000) && a.quote.trim() && str(a.prefix || "", 200) && str(a.suffix || "", 200)) return { kind: "text", quote: a.quote, prefix: a.prefix || "", suffix: a.suffix || "" };
  if (a.kind === "region" && Number.isFinite(a.x) && Number.isFinite(a.y) && a.x >= 0 && a.x <= 1 && a.y >= 0 && a.y <= 1) return { kind: "region", x: a.x, y: a.y };
  if (a.kind === "block" && typeof a.id === "string" && /^b\d{1,6}$/.test(a.id) && str(a.text || "", 400) && str(a.quote || "", 1000)) return { kind: "block", id: a.id, text: a.text || "", quote: a.quote || "" };
  if (a.kind === "whole") return { kind: "whole" };
  return null;
}

/**
 * D28 (review M3/M4): resolve a document BLOCK anchor against the version's
 * stored anchor map, server-side. The client (and the frame behind it) only
 * names the block id and the quote; the block TEXT always comes from the
 * map. A quote that does not occur in that block's rendered text (`plain`,
 * or `text` minus its markdown markup for versions saved before D28) is
 * not that block's: it becomes a text anchor instead, so a comment can
 * never be pinned to the wrong section. Non-block anchors pass through. Returns null when unanchorable.
 */
// Compared with ALL whitespace removed (review M-1): rendered text and a
// browser selection disagree about spaces around inline formatting.
const noWs = (s) => String(s || "").replace(/\s+/g, "");
// D28 (review low): versions saved before D28 have no `plain`, only the
// block's markdown `text` (capped at 400 chars). A selection is rendered
// text, so drop the common markdown markup before comparing: link/image
// syntax keeps its label, block markers go, emphasis/code marks go only when
// they wrap words (snake_case and 2*3 stay). Past the 400-char cap a quote
// still demotes to a text anchor, which is the safe direction.
const mdPlain = (s) => String(s || "")
  .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
  .replace(/^[ \t]{0,3}(#{1,6}[ \t]+|>[ \t]?|[-*+][ \t]+|\d+[.)][ \t]+)/gm, "")
  .replace(/`+([^`]*?)`+/g, "$1")
  .replace(/(\*\*|__|~~)(?=\S)([\s\S]*?\S)\1/g, "$2")
  .replace(/(^|[^\w*])([*_])(?=\S)([^*_]*?\S)\2(?![\w*])/g, "$1$3");
const renderedOf = (b) => (typeof b.plain === "string" ? b.plain : mdPlain(b.text));
export function resolveBlockAnchor(anchorMap, a) {
  if (!a || a.kind !== "block") return a;
  const quote = typeof a.quote === "string" ? a.quote.slice(0, 1000) : "";
  const ctx = (v) => (typeof v === "string" ? v.slice(0, 200) : "");
  // Review M-2: keep the selection's context so a repeated phrase stays distinguishable.
  const asText = () => (quote.trim() ? { kind: "text", quote, prefix: ctx(a.prefix), suffix: ctx(a.suffix) } : null);
  const blocks = anchorMap && anchorMap.kind === "blocks" && Array.isArray(anchorMap.blocks) ? anchorMap.blocks : [];
  const b = blocks.find((x) => x && x.id === a.id);
  if (!b) return asText();
  // A section the owner picked from the trusted list stays that section even
  // when the typed "exact words" are not verbatim (review low); its quote is
  // owner text and never crosses into the frame (pins carry the id only).
  if (quote.trim() && !a.fromList && !noWs(renderedOf(b)).includes(noWs(quote))) return asText();
  return { kind: "block", id: b.id, text: String(b.text || "").slice(0, 400), quote };
}

function cleanText(t) {
  const s = String(t == null ? "" : t).replace(/\r\n/g, "\n").trim();
  if (!s) throw err("bad_request", "comment text required");
  if (s.length > LIMITS.commentChars) throw err("too_long", `comments are capped at ${LIMITS.commentChars} characters`);
  return s;
}

async function contactCaps(db, artifactId, contactId, { newThread }) {
  const hourAgo = Date.now() - 3600 * 1000;
  const recent = Number((await db.execute({ sql: "SELECT COUNT(*) AS c FROM artifact_comments WHERE author_kind='contact' AND author_id=? AND ts>?", args: [contactId, hourAgo] })).rows[0].c);
  if (recent >= LIMITS.commentsPerContactPerHour) throw err("rate_limited", "too many comments this hour");
  if (newThread) {
    const open = Number((await db.execute({ sql: "SELECT COUNT(*) AS c FROM artifact_threads WHERE artifact_id=? AND author_kind='contact' AND author_id=? AND status<>'resolved'", args: [artifactId, contactId] })).rows[0].c);
    if (open >= LIMITS.openThreadsPerContactPerArtifact) throw err("too_many_threads", "too many open threads on this artifact");
  }
}

async function botCaps(db, botId) {
  const hourAgo = Date.now() - 3600 * 1000;
  const n = Number((await db.execute({ sql: "SELECT COUNT(*) AS c FROM artifact_comments WHERE author_kind='bot' AND author_id=? AND ts>?", args: [botId, hourAgo] })).rows[0].c);
  if (n >= LIMITS.botCommentsPerHour) throw err("rate_limited", "too many bot comments this hour");
}

function checkAuthor(a) {
  if (!a || !["owner", "contact", "bot"].includes(a.kind)) throw err("forbidden", "unknown author");
  if (a.kind !== "owner" && !a.id) throw err("forbidden", "author identity required");
}

export async function addThread(db, { artifactId, versionN, anchor, text, author, tainted = false }) {
  checkAuthor(author);
  const a = validAnchor(anchor);
  if (!a) throw err("bad_anchor", "anchor rejected");
  const body = cleanText(text);
  if (author.kind === "contact") await contactCaps(db, artifactId, author.id, { newThread: true });
  if (author.kind === "bot") await botCaps(db, author.id);
  const total = Number((await db.execute({ sql: "SELECT COUNT(*) AS c FROM artifact_threads WHERE artifact_id=? AND status<>'resolved'", args: [artifactId] })).rows[0].c);
  if (total >= LIMITS.threadsPerArtifact) throw err("too_many_threads", "this artifact has too many open threads");
  const v = (await db.execute({ sql: "SELECT n, flagged_reason FROM artifact_versions WHERE artifact_id=? AND n=?", args: [artifactId, versionN] })).rows[0];
  if (!v) throw err("not_found", "no such version");
  if (v.flagged_reason) throw err("forbidden", "this version was flagged");
  const r = await db.execute({ sql: "INSERT INTO artifact_threads (artifact_id,version_n,anchor_json,author_kind,author_id,anchor_from_version) VALUES (?,?,?,?,?,?)", args: [artifactId, versionN, JSON.stringify(a), author.kind, author.id || null, versionN] });
  const threadId = Number(r.lastInsertRowid);
  await db.execute({ sql: "INSERT INTO artifact_comments (thread_id,author_kind,author_id,text,ts,tainted) VALUES (?,?,?,?,?,?)", args: [threadId, author.kind, author.id || null, body, Date.now(), tainted ? 1 : 0] });
  return { threadId };
}

export async function addComment(db, { threadId, text, author, tainted = false }) {
  checkAuthor(author);
  const body = cleanText(text);
  const t = (await db.execute({ sql: "SELECT * FROM artifact_threads WHERE id=?", args: [threadId] })).rows[0];
  if (!t) throw err("not_found", "no such thread");
  if (author.kind === "contact") await contactCaps(db, t.artifact_id, author.id, { newThread: false });
  if (author.kind === "bot") await botCaps(db, author.id);
  const r = await db.execute({ sql: "INSERT INTO artifact_comments (thread_id,author_kind,author_id,text,ts,tainted) VALUES (?,?,?,?,?,?)", args: [threadId, author.kind, author.id || null, body, Date.now(), tainted ? 1 : 0] });
  await db.execute({ sql: "UPDATE artifact_threads SET updated_at=datetime('now') WHERE id=?", args: [threadId] });
  return { commentId: Number(r.lastInsertRowid), artifactId: t.artifact_id };
}

/** The round statuses that hold a thread (the bot's copy is in flight). Kept
 *  in step with rounds.js ACTIVE (comments.js cannot import rounds.js: rounds
 *  imports this module). */
const ACTIVE_ROUND = ["queued", "pending", "delivering", "working"];
const IN_ACTIVE = `r.status IN (${ACTIVE_ROUND.map((x) => `'${x}'`).join(",")})`;
/** SQL: "an active round or ask of artifact ?1 holds thread ?2". FAIL CLOSED:
 *  an active row whose thread list is unreadable holds every thread. Used
 *  INSIDE the edit/delete UPDATE, so the check and the write are one
 *  statement — a Send landing between a separate check and the write could
 *  otherwise deliver text the owner never approved (review M2). */
const HELD_SQL = `EXISTS (SELECT 1 FROM artifact_rounds r WHERE r.artifact_id=? AND ${IN_ACTIVE}
  AND (json_valid(r.thread_ids_json)=0 OR json_type(r.thread_ids_json)<>'array'
       OR EXISTS (SELECT 1 FROM json_each(r.thread_ids_json) j WHERE CAST(j.value AS INTEGER)=?)))`;

/** The threads an active round or ask holds, for the viewer to hide Edit and
 *  Delete. Fail closed like HELD_SQL: an unreadable active row locks every
 *  thread of the artifact. */
export async function lockedThreadIds(db, artifactId) {
  const rows = (await db.execute({ sql: `SELECT r.thread_ids_json FROM artifact_rounds r WHERE r.artifact_id=? AND ${IN_ACTIVE}`, args: [artifactId] })).rows;
  const out = new Set();
  for (const r of rows) {
    let ids = null;
    try { ids = JSON.parse(r.thread_ids_json); } catch { ids = null; }
    if (!Array.isArray(ids)) {
      const all = (await db.execute({ sql: "SELECT id FROM artifact_threads WHERE artifact_id=?", args: [artifactId] })).rows;
      return all.map((t) => Number(t.id)).sort((a, b) => a - b);
    }
    for (const id of ids) out.add(Number(id));
  }
  return [...out].sort((a, b) => a - b);
}

async function liveCount(db, threadId) {
  return Number((await db.execute({ sql: "SELECT COUNT(*) AS n FROM artifact_comments WHERE thread_id=? AND deleted_at IS NULL", args: [threadId] })).rows[0].n);
}

/** D19: the owner may delete any comment; a contact only their own; bots
 *  none. The owner's OWN words follow the edit rule (never while a round
 *  holds the thread); a contact's comment stays deletable at any time (D19
 *  privacy). Returns `remaining` (live comments left in the thread) so the
 *  viewer resolves an emptied thread from the server's count, never a stale
 *  list (review M3). */
export async function deleteComment(db, { commentId, actor }) {
  const c = (await db.execute({ sql: "SELECT c.*, t.artifact_id FROM artifact_comments c JOIN artifact_threads t ON t.id=c.thread_id WHERE c.id=? AND c.deleted_at IS NULL", args: [commentId] })).rows[0];
  if (!c) throw err("not_found", "no such comment");
  const owner = actor?.kind === "session";
  const self = actor?.kind === "contact" && c.author_kind === "contact" && c.author_id === actor.id;
  if (!owner && !self) throw err("forbidden", "not your comment");
  const locks = owner && c.author_kind === "owner";
  const r = await db.execute({
    sql: `UPDATE artifact_comments SET deleted_at=datetime('now'), text='' WHERE id=? AND deleted_at IS NULL${locks ? ` AND NOT ${HELD_SQL}` : ""}`,
    args: locks ? [commentId, c.artifact_id, Number(c.thread_id)] : [commentId],
  });
  if (Number(r.rowsAffected) !== 1) throw await gone(db, commentId);
  await audit(db, { artifactId: c.artifact_id, actor, action: "comment-deleted", target: String(commentId) });
  return { deleted: true, remaining: await liveCount(db, c.thread_id) };
}

/** Why an edit/delete UPDATE matched nothing: the comment went away, or a
 *  round holds its thread. */
async function gone(db, commentId) {
  const still = (await db.execute({ sql: "SELECT 1 FROM artifact_comments WHERE id=? AND deleted_at IS NULL", args: [commentId] })).rows[0];
  return still ? err("comment_locked", "this comment is with the bot right now") : err("not_found", "no such comment");
}

/** The owner edits their OWN words only (a contact's or a bot's text is never
 *  rewritten under their name), and never while a round holds the thread:
 *  what the bot was sent must match what the owner sees. The hold check is
 *  part of the UPDATE (HELD_SQL, fail closed). */
export async function editComment(db, { commentId, artifactId, text, actor }) {
  if (actor?.kind !== "session") throw err("forbidden", "only the owner edits comments");
  const body = cleanText(text);
  const c = (await db.execute({ sql: "SELECT c.*, t.artifact_id FROM artifact_comments c JOIN artifact_threads t ON t.id=c.thread_id WHERE c.id=? AND c.deleted_at IS NULL", args: [commentId] })).rows[0];
  if (!c || c.artifact_id !== artifactId) throw err("not_found", "no such comment");
  if (c.author_kind !== "owner") throw err("forbidden", "only your own comments can be edited");
  const r = await db.execute({
    sql: `UPDATE artifact_comments SET text=?, edited_at=datetime('now') WHERE id=? AND deleted_at IS NULL AND author_kind='owner' AND NOT ${HELD_SQL}`,
    args: [body, commentId, artifactId, Number(c.thread_id)],
  });
  if (Number(r.rowsAffected) !== 1) throw await gone(db, commentId);
  await db.execute({ sql: "UPDATE artifact_threads SET updated_at=datetime('now') WHERE id=?", args: [c.thread_id] });
  await audit(db, { artifactId, actor, action: "comment-edited", target: String(commentId) });
  return { edited: true };
}

/** D19: deleting a contact deletes their comments (the contact-deletion flow calls this). */
export async function deleteContactComments(db, contactId) {
  const r = await db.execute({ sql: "UPDATE artifact_comments SET deleted_at=datetime('now'), text='' WHERE author_kind='contact' AND author_id=? AND deleted_at IS NULL", args: [contactId] });
  return Number(r.rowsAffected || 0);
}

export async function setThreadStatus(db, { threadId, status, artifactId }) {
  if (!["open", "resolved"].includes(status)) throw err("bad_request", "status");
  if (!artifactId) throw err("bad_request", "artifact required");
  const r = await db.execute({ sql: "UPDATE artifact_threads SET status=?, updated_at=datetime('now') WHERE id=? AND artifact_id=?", args: [status, threadId, artifactId] });
  if (Number(r.rowsAffected) !== 1) throw err("not_found", "no such thread");
}

export async function listThreads(db, artifactId) {
  const threads = (await db.execute({ sql: "SELECT * FROM artifact_threads WHERE artifact_id=? ORDER BY id", args: [artifactId] })).rows;
  const comments = (await db.execute({ sql: "SELECT c.* FROM artifact_comments c JOIN artifact_threads t ON t.id=c.thread_id WHERE t.artifact_id=? AND c.deleted_at IS NULL ORDER BY c.id", args: [artifactId] })).rows;
  const by = new Map();
  for (const c of comments) { const k = Number(c.thread_id); if (!by.has(k)) by.set(k, []); by.get(k).push(c); }
  const taint = await anchorTaintMap(db, artifactId);
  return threads.map((t) => ({ ...t, anchor: JSON.parse(t.anchor_json), anchor_tainted: anchorTainted(t, taint), comments: by.get(Number(t.id)) || [] }));
}

/** n -> tainted? for every version of an artifact (one query). */
export async function anchorTaintMap(db, artifactId) {
  const rows = (await db.execute({ sql: "SELECT n, untrusted_input, trust_cleared_at FROM artifact_versions WHERE artifact_id=?", args: [artifactId] })).rows;
  return new Map(rows.map((v) => [Number(v.n), isTainted(v)]));
}

/** R-H1: an anchor's text is as trusted as the version it was taken from. A
 *  pruned or unknown source version reads as tainted (fail closed). */
export function anchorTainted(t, taintMap) {
  // Only anchors that carry TEXT can carry injected text: region and whole
  // anchors are coordinates / nothing.
  let kind = null;
  try { kind = JSON.parse(t.anchor_json).kind; } catch { return true; }
  if (kind === "region" || kind === "whole") return false;
  // R2-L3: unknown provenance on a text-carrying anchor is tainted (version_n
  // is rewritten by carry-forward, so it is no substitute).
  if (t.anchor_from_version == null) return true;
  const from = Number(t.anchor_from_version);
  return !taintMap.has(from) || taintMap.get(from) === true;
}

/** Visible text of an HTML document by one linear pass (ReDoS review: no
 *  lazy or overlapping regex over artifact content). Capped input. */
export function textOf(html, cap = 4 * 1024 * 1024) {
  const s = String(html || "").slice(0, cap);
  const low = s.toLowerCase();
  let out = "", i = 0;
  while (i < s.length) {
    const lt = s.indexOf("<", i);
    if (lt < 0) { out += s.slice(i); break; }
    out += s.slice(i, lt) + " ";
    let skipTo = -1;
    if (low.startsWith("<style", lt)) skipTo = low.indexOf("</style>", lt);
    else if (low.startsWith("<script", lt)) skipTo = low.indexOf("</script>", lt);
    const gt = s.indexOf(">", skipTo >= 0 ? skipTo : lt);
    if (gt < 0) break;
    i = gt + 1;
  }
  let t = "", sp = false;
  for (const ch of out) { const w = ch === " " || ch === "\n" || ch === "\t" || ch === "\r"; if (w) { if (!sp) t += " "; sp = true; } else { t += ch; sp = false; } }
  return t;
}
const squash = (s) => textOf(String(s || "").replace(/</g, " "));

/**
 * §4.2 carry-forward: open threads move to the new current version, re-anchored
 * by the same element, text or block. No match → `anchor-moved` (still shown).
 * @param {{ anchorMap: any, html: string }} next  the new version's anchor map and index.html
 */
export async function carryForward(db, { artifactId, toN, next, onlyThreads = null }) {
  // R3-L3: a version made by an untrusted round moves only THAT round's
  // threads; the owner's other threads stay on their version.
  const open = (await db.execute({ sql: "SELECT * FROM artifact_threads WHERE artifact_id=? AND status IN ('open','anchor-moved') AND version_n<?", args: [artifactId, toN] })).rows
    .filter((t) => !onlyThreads || onlyThreads.has(Number(t.id)));
  // Bounded: one linear pass over at most 512 KB of text; each thread does
  // one substring search over it (threads per artifact are capped).
  const text = textOf(next.html, 512 * 1024);
  const blocks = next.anchorMap?.kind === "blocks" ? next.anchorMap.blocks : [];
  const out = [];
  for (const t of open) {
    const a = JSON.parse(t.anchor_json);
    let moved = a, ok = false;
    if (a.kind === "block") {
      // Only the LOCATION moves (the block id). The text stays what the owner
      // anchored to: re-anchoring never copies a new version's text into a
      // thread (plan review R-H1).
      const hit = blocks.find((b) => b.text === a.text) || (a.quote && blocks.find((b) => b.text.includes(a.quote))) || (a.text && blocks.find((b) => b.text.includes(a.text.slice(0, 60))));
      if (hit) { moved = { ...a, id: hit.id }; ok = true; }
    } else if (a.kind === "text") {
      ok = text.includes(squash(a.quote).trim());
    } else if (a.kind === "element") {
      const idSel = /^#([A-Za-z][\w-]{0,63})/.exec(a.selector.slice(0, 80));
      const html = String(next.html || "");
      ok = (!a.text || text.includes(squash(a.text).trim())) && (!idSel || html.includes(`id="${idSel[1]}"`) || html.includes(`id='${idSel[1]}'`) || html.includes(`id=${idSel[1]}`));
    } else if (a.kind === "region" || a.kind === "whole") {
      ok = true;
    }
    const status = ok ? "open" : "anchor-moved";
    moved = validAnchor(moved) || a;   // re-validated: the 4 KB cap holds after a move
    await db.execute({ sql: "UPDATE artifact_threads SET version_n=?, anchor_json=?, status=?, updated_at=datetime('now') WHERE id=?", args: [toN, JSON.stringify(moved), status, t.id] });
    out.push({ threadId: t.id, status });
  }
  return out;
}

/** After a version becomes current: carry open threads forward to it. */
export async function carryForwardTo(db, blobs, artifactId, n, onlyThreads = null) {
  const v = (await db.execute({ sql: "SELECT files_json, anchor_map_json, state FROM artifact_versions WHERE artifact_id=? AND n=?", args: [artifactId, n] })).rows[0];
  if (!v || v.state !== "current") return [];
  const f = JSON.parse(v.files_json).find((x) => x.path === "index.html");
  const body = f ? await blobs.get(f.key) : null;
  return carryForward(db, { artifactId, toN: Number(n), onlyThreads, next: { anchorMap: v.anchor_map_json ? JSON.parse(v.anchor_map_json) : null, html: body ? body.toString("utf8") : "" } });
}
