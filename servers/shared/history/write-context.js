/**
 * write-context.js — who is writing, carried ambiently through the call stack.
 *
 * The capture triggers (covered.js) record WHAT changed; they cannot know who
 * changed it, because they fire for every writer, including a bot on its own
 * sqlite3 connection. So the writer is carried out of band: whoever starts a unit
 * of work (a dashboard request, a verified bot tool call, a peer's applied change,
 * a schedule firing) opens a context with `withWriteContext`, and
 * `createDbClient()` in servers/db.js stamps the rows the triggers write inside
 * that same immediate transaction. A write with no context stays
 * `author_kind = 'unattributed'` — never `owner` (the version history design, §8.2).
 *
 * AsyncLocalStorage, not a module global: the gateway serves many concurrent
 * callers, and a global "current author" would attribute one request's write to
 * another request's caller. ALS follows the promise chain, so a tool handler, its
 * awaits and the DB call they end in all see the same store.
 *
 * `withWriteContext` NESTS, but only within one author: an inner context of the
 * SAME author kind wins field by field over the outer one, so a schedule firing
 * inside a request (or a job inside a session) can name only what it changes. An
 * inner context of a DIFFERENT author kind replaces the outer one wholesale — the
 * ids of one author's unit of work never travel into another author's write (see
 * `withWriteContext`).
 *
 * It never throws on a malformed context. A caller that passes junk (a typo'd
 * kind, a number where a string belongs, an actor that did not verify) gets no
 * context — the write is then recorded as unattributed, which is the honest
 * answer — rather than an exception inside a write path.
 *
 * The author kinds, and nothing else: `owner | bot | peer | system`. A context
 * that would say `unattributed` is not a context at all.
 *
 * ONE PROCESS, stated plainly: the context is in-memory state, so it reaches a
 * write only when the write is made in the process that opened it. A bot's tool
 * call proxied to another server's own port (the memory server, for instance), and
 * a bot's direct SQL on crow.db, carry no context and are recorded as
 * 'unattributed'. That is the honest record — it is what the triggers saw — and
 * the raw-SQL case is exactly the containment gap the design names rather than
 * hides.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";

/** The author kinds a context may name. `unattributed` is the absence of one. */
export const AUTHOR_KINDS = Object.freeze(["owner", "bot", "peer", "system"]);

/** The ambient store. Read it through currentWriteContext(), not directly. */
export const writeContext = new AsyncLocalStorage();

const str = (v) => {
  if (typeof v === "string") {
    const s = v.trim();
    return s === "" ? null : s;
  }
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
};

/**
 * One context object, sanitized: only the fields it actually sets come back, so
 * a nested context overrides exactly what it names and inherits the rest.
 * Returns null when the object names nothing usable (no kind, no ids).
 */
function cleanContext(ctx) {
  if (!ctx || typeof ctx !== "object" || Array.isArray(ctx)) return null;
  const out = {};
  const kind = typeof ctx.authorKind === "string" ? ctx.authorKind.trim() : "";
  if (AUTHOR_KINDS.includes(kind)) out.authorKind = kind;
  const authorId = str(ctx.authorId);
  if (authorId !== null) out.authorId = authorId;
  const jobId = str(ctx.jobId);
  if (jobId !== null) out.jobId = jobId;
  const originInstance = str(ctx.originInstance);
  if (originInstance !== null) out.originInstance = originInstance;
  return Object.keys(out).length ? out : null;
}

/**
 * Run `fn` as `ctx`.
 *
 * SAME author kind → the inner context wins field by field over whatever context
 * is already active (`{ ...outer, ...inner }`): a narrower scope inside one
 * author's work keeps that work's ids unless it names its own.
 *
 * DIFFERENT author kind → the inner context REPLACES the outer one wholesale. A
 * bot's tool call made while the owner's dashboard request is in flight is the
 * BOT's write, alone: carrying the owner's session hash and `session:<hash>` job
 * into it would file the bot's work under the owner's sign-in, which is the exact
 * confusion version history exists to prevent. Same for a peer's applied change
 * inside an owner request. So no authorId, jobId or originInstance crosses an
 * author-kind boundary.
 *
 * A malformed or empty `ctx` is ignored (the outer context, if any, stays in
 * effect) and `fn` still runs exactly once: no write path may fail because
 * attribution was unavailable.
 */
export function withWriteContext(ctx, fn) {
  if (typeof fn !== "function") return undefined;
  const add = cleanContext(ctx);
  if (!add) return fn();
  const outer = writeContext.getStore() || null;
  const merged = !outer
    ? add
    : outer.authorKind === add.authorKind
      ? { ...outer, ...add }
      : { ...add };
  // No author kind anywhere: nothing to attribute the write to, so do not open a
  // store that would only make the caller's writes look attributable.
  if (!merged.authorKind) return fn();
  return writeContext.run(Object.freeze(merged), fn);
}

/**
 * Run `fn` with NO write context, whatever context the caller is in.
 *
 * The counterpart of `withWriteContext` for a unit of work that OUTLIVES the
 * request that started it: a child process, an interval, a background worker
 * spawned from a dashboard handler would otherwise inherit the ambient store for
 * its whole life through the promise chain that created it, and every write it
 * ever makes would be attributed to the sign-in that happened to click the
 * button. Opened at the top of the long-lived unit, `withoutWriteContext` gives
 * it the honest answer instead: what it writes is 'unattributed' until the unit
 * opens a context of its own (a schedule, a card, a bot).
 *
 * `AsyncLocalStorage.exit` only unwinds for the duration of `fn`; the caller's own
 * context is intact afterwards.
 */
export function withoutWriteContext(fn) {
  if (typeof fn !== "function") return undefined;
  if (!writeContext.getStore()) return fn();
  return writeContext.exit(fn);
}

/** The active context as a plain object with all four fields, or null. */
export function currentWriteContext() {
  const s = writeContext.getStore();
  if (!s || !AUTHOR_KINDS.includes(s.authorKind)) return null;
  return {
    authorKind: s.authorKind,
    authorId: s.authorId ?? null,
    jobId: s.jobId ?? null,
    originInstance: s.originInstance ?? null,
  };
}

/**
 * The job a write belongs to, from the identities a unit of work already has
 * (the version history design, §8.1): the board card it is working on, else the
 * voice hand-off it accepted, else the chat/Perch turn it runs in, else the
 * owner's dashboard session. Returns null when none is given — a jobless write
 * (a schedule, an outside edit) gets per-item history only, never a made-up job.
 */
export function jobIdFor({ cardId, handoffId, threadId, sessionHash } = {}) {
  const card = str(cardId);
  if (card !== null) return `card:${card}`;
  const handoff = str(handoffId);
  if (handoff !== null) return `handoff:${handoff}`;
  const thread = str(threadId);
  if (thread !== null) return `turn:${thread}`;
  const session = str(sessionHash);
  if (session !== null) return `session:${session}`;
  return null;
}

/* ------------------------------------------------------------- the four sources */

/**
 * The first 8 hex of a session token's sha256 — the only session fact history
 * keeps. Never the token, never the raw session id, never a user name or email:
 * an 8-hex prefix names a sign-in without storing anything that could sign in.
 */
export function sessionHash8(sessionToken) {
  if (typeof sessionToken !== "string" || sessionToken === "") return null;
  return createHash("sha256").update(sessionToken).digest("hex").slice(0, 8);
}

/** The owner at their own dashboard: author_id is the session hash prefix, the job
 *  is that session, so the owner's edits group per sign-in (§8.1). */
export function ownerWriteContext(sessionToken) {
  const hash = sessionHash8(sessionToken);
  if (hash === null) return null;
  return { authorKind: "owner", authorId: hash, jobId: jobIdFor({ sessionHash: hash }) };
}

/** A verified bot: the job is its card, else its hand-off, else its thread. No
 *  verified id → no context (the write stays unattributed, never the owner). */
export function botWriteContext(botId, { cardId = null, handoffId = null, threadId = null } = {}) {
  const id = str(botId);
  if (id === null) return null;
  return { authorKind: "bot", authorId: id, jobId: jobIdFor({ cardId, handoffId, threadId }) };
}

/**
 * The context a resolved MCP actor carries. `resolveActor` in the board mount
 * returns `{ kind, id, jobId, thread }`; only a verified `bot` actor with an id
 * has an author here — a `session` (a token holder) and an unverified bot actor
 * both stay unattributed, because nothing on that rail proves who they are.
 */
export function botActorWriteContext(actor) {
  if (!actor || typeof actor !== "object" || actor.kind !== "bot") return null;
  return botWriteContext(actor.id ?? null, { cardId: actor.jobId ?? null, threadId: actor.thread?.id ?? null });
}

/** A change applied from a paired instance: the peer's instance id is both the
 *  author and the origin (review focus 2 — never `owner`, never `unattributed`). */
export function peerWriteContext(instanceId) {
  const id = str(instanceId);
  if (id === null) return null;
  return { authorKind: "peer", authorId: id, originInstance: id };
}

/** A schedule firing: author_id is the schedule id and the job is that schedule,
 *  so everything one schedule did can be reviewed (and undone) as one job. A
 *  system write with no schedule (a cleanup sweep) names no author and no job. */
export function systemWriteContext(scheduleId = null) {
  const id = str(scheduleId);
  if (id === null) return { authorKind: "system" };
  return { authorKind: "system", authorId: id, jobId: `schedule:${id}` };
}