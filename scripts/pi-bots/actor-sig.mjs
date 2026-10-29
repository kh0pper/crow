/**
 * Actor-header binding (S2, 2026-10-02).
 *
 * Kinds signed with the one per-boot key (each its own MAC domain, so none
 * replays as another): "bot" (phone), "board", "board-thread", "artifacts"
 * over the v1 tuple below, and the session-bound (v2) kind "peer-relay"
 * (the loopback relay to paired peers, item 46 PR-B, below).
 *
 * A bot's per-turn MCP config carries X-Crow-Actor-{Kind,Id,Thread,Gateway}
 * so /phone/mcp can attribute a call plan to the bot and deliver the result
 * back to the conversation that asked. Those headers sit next to a SHARED
 * path-scoped token, so on their own they prove nothing: any child holding the
 * token could name another bot or another Perch session. X-Crow-Actor-Sig
 * binds them:
 *
 *   sig = HMAC-SHA256(key, JSON(["crow-actor-v1", kind, bot, thread, gateway]))
 *
 * Where the key lives (the whole point; see the PR report for the full model):
 *  - Only in process MEMORY. Never on disk, never in the DB, never in env.
 *    pi children run as the gateway's uid: anything in ~/.crow (crow.db
 *    included) or in a parent's environment (/proc/<pid>/environ is readable
 *    by the same uid) is readable by a child with a shell, and a readable key
 *    would make the signature worthless. Process memory is not: with Yama
 *    ptrace_scope >= 1 a process cannot ptrace or read the memory of a
 *    non-descendant, and a pi child is never an ancestor of the signer.
 *  - Minted fresh at each gateway boot (initGatewayActorKey). Signatures are
 *    therefore per-boot. That costs nothing in practice: every turn and every
 *    child spawn rewrites the bot's .mcp.json with a fresh signature, and a
 *    gateway restart kills its children (systemd control-group kill). A child
 *    that somehow outlives a restart is downgraded to the unattributed actor,
 *    which is the safe direction.
 *  - Other processes that build bot worlds receive the key over a pipe, never
 *    the environment: the gateway hands it to the supervised Discord child on
 *    stdin (CROW_ACTOR_KEY_STDIN=1 only says "read stdin", it is not secret).
 *    The separate systemd bot hosts get no key at all: they ask the
 *    gateway's loopback signing relay for each turn's signatures
 *    (presignActors below). A process with no key and no presigned
 *    signature signs nothing; its bots' phone plans are then unattributed
 *    (owner notification only, no Perch card, no thread reply).
 *
 * What this stops (exactly):
 *  - forging only the thread/gateway headers, or naming a bot id without
 *    that bot's signature;
 *  - owner-level access through the bare phone token (no actor headers);
 *  - impersonation by bots that have neither a file-read tool nor an open
 *    shell, since they cannot see any signature but their own.
 * What it does NOT stop:
 *  - a bot that can READ another bot's world files — CLOSED by S6 with
 *    pi-lab >= c8bbb02 (pi-lab-compat.mjs): read tools are confined to the
 *    bot's own roots (bot-read-paths.mjs), any `.mcp.json` is structurally
 *    unreadable, and the per-turn config reaches pi over an inherited fd
 *    (mcp-delivery.mjs), so no signature rests on disk at all. With an older
 *    pi-lab (or PIBOT_MCP_CONFIG_DELIVERY=file) the headers sit in
 *    <session_dir>/.mcp.json / /tmp/pibot-job-* again and can be replayed.
 *    An allowlisted file-reading bash command (cat, python3, ...) still
 *    reads anything — keep those out of bash_allow for confined bots.
 *  - a bot with an open shell. The gateway's user is in the docker and sudo
 *    groups. S3 (scripts/pi-bots/pi_sandbox.mjs) is defense in depth that
 *    removes the casual docker/sudo routes (docker socket and user-session
 *    IPC masked, no_new_privs) where bubblewrap is usable. It is NOT
 *    containment: the filesystem stays writable (rc files, ~/crow, ssh keys),
 *    so a shell can still persist or escape. Only a dedicated bot user closes
 *    this.
 *  - a child replaying its OWN headers (that is its own identity).
 *
 * The second key: scope-bound (v3) kinds (SCOPE_ACTOR_KINDS, "service"),
 * the loopback MCP mount helper, below. initGatewayActorKey also mints a
 * separate per-boot `scopeKey`, which it never returns: the stdin hand-off
 * carries only the v1/v2 key, and setActorKey installs only that one. So the
 * supervised Discord child, which holds the v1/v2 key, cannot compute a v3 MAC
 * for any scope (not even a live owner Perch session's), and a v1/v2 key
 * received anywhere verifies no v3 signature. Key-less hosts get v3 only from
 * the signing relay, and only for an owner job (routes/actor-sign.js). The v3
 * tuple carries NO owner or channel claim, on purpose: the mount resolves who
 * started the turn, and on which channel, from rows on every request.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

let key = null;
// The v3 (scope-bound) key: gateway-only, never returned, never handed off.
let scopeKey = null;

/** Gateway boot: mint the per-boot keys once (idempotent). Returns ONLY the
 *  v1/v2 key, so the gateway can hand it to a supervised child over a pipe;
 *  the scope key stays in this process. */
export function initGatewayActorKey() {
  if (!key) key = randomBytes(32);
  if (!scopeKey) scopeKey = randomBytes(32);
  return key;
}

/** Install a key received from the gateway (child processes). Accepts a
 *  Buffer or a hex string; anything not 32 bytes is ignored. Installs the
 *  v1/v2 key only: a child never holds the scope key. */
export function setActorKey(k) {
  const b = Buffer.isBuffer(k) ? k : (typeof k === "string" && /^[0-9a-f]{64}$/i.test(k.trim()) ? Buffer.from(k.trim(), "hex") : null);
  if (b && b.length === 32) key = Buffer.from(b);
  return !!key;
}

export function hasActorKey() { return !!key; }

/** Test seam only. */
export function _resetActorKeyForTest() { key = null; scopeKey = null; }

// Fields are trimmed on BOTH sides: HTTP strips edge whitespace from header
// values, so an untrimmed MAC would silently fail for such an id.
const f = (v) => (v == null ? "" : String(v).trim());

// JSON array, not a joined string: no field value can shift a boundary.
function v1Message({ kind = "bot", botId, threadId, gatewayType }) {
  return JSON.stringify(["crow-actor-v1", f(kind), f(botId), f(threadId), f(gatewayType)]);
}

function mac(k, actor) {
  return createHmac("sha256", k).update(v1Message(actor)).digest("hex");
}

/** Signature for the actor headers, or null when this process holds no key
 *  (and its gateway presigned nothing for exactly this tuple, see below). */
export function signActor(actor) {
  if (!actor || actor.botId == null || String(actor.botId).trim() === "") return null;
  if (!key) return presignedFor(v1Message(actor));
  return mac(key, actor);
}

/** Constant-time check of a presented signature. False without a key. */
export function verifyActorSig({ kind = "bot", botId, threadId, gatewayType, sig }) {
  if (!key || typeof sig !== "string" || !/^[0-9a-f]{64}$/i.test(sig.trim()) || botId == null || String(botId).trim() === "") return false;
  const want = Buffer.from(mac(key, { kind, botId, threadId, gatewayType }), "hex");
  const got = Buffer.from(sig.trim(), "hex");
  return got.length === want.length && timingSafeEqual(got, want);
}

// ---- board actor headers (S5, 2026-10-02) ----
//
// /board/mcp attributes a mutation to X-Crow-Actor-Id and grants the
// result-service lock exemption by X-Crow-Actor-Id (session rail) or
// X-Crow-Job-Id (job rail). Same key, same MAC, but the MAC's kind field is
// "board" and the second field is the job id, so a phone signature (kind
// "bot") can never be replayed as a board signature or the reverse. jobId is
// optional (Perch and channel turns carry none); it is still bound, so a
// signature minted without a job cannot be paired with a job id afterwards.

/** Signature for the board actor headers, or null without a key / bot id. */
export function signBoardActor({ botId, jobId } = {}) {
  return signActor({ kind: "board", botId, threadId: jobId, gatewayType: null });
}

/** Constant-time check of a presented board signature. False without a key. */
export function verifyBoardActorSig({ botId, jobId, sig } = {}) {
  return verifyActorSig({ kind: "board", botId, threadId: jobId, gatewayType: null, sig });
}

// ---- artifacts actor headers (Crow Artifacts, spec §7.1 / H6) ----
//
// /artifacts/mcp attributes a call to (bot, thread, gateway). Same key and
// MAC; kind "artifacts", so neither a phone ("bot") nor a board signature can
// be replayed here, nor an artifacts signature there.

/** Signature for the artifacts actor headers, or null without a key / bot id. */
export function signArtifactsActor({ botId, threadId, gatewayType } = {}) {
  return signActor({ kind: "artifacts", botId, threadId, gatewayType });
}

/** Constant-time check of a presented artifacts signature. False without a key. */
export function verifyArtifactsActorSig({ botId, threadId, gatewayType, sig } = {}) {
  return verifyActorSig({ kind: "artifacts", botId, threadId, gatewayType, sig });
}

// ---- session-bound actor headers, v2 (item 46 PR-B) ----
//
// The v1 tuple names no bot session, and a thread lookup can be ambiguous, so
// a v1 signature can be replayed into another session of the same bot on the
// same thread. A v2 signature binds the session (bot_sessions.id):
//
//   sig = HMAC-SHA256(key, JSON(["crow-actor-v2", kind, bot, session, thread, gateway]))
//
// The verifier resolves that session itself and checks it (still live, this
// bot's), so a session-scoped mount learns the session's project from the row,
// never from the request. v2 is only for the kinds below; the v1 kinds above
// stay byte-identical. Different version tag, so no v1 signature verifies as
// v2 or the reverse, and the kind field keeps every v2 kind its own domain.

/** The kinds signed over the session-bound (v2) tuple. */
// Only "peer-relay" today. A later kind is added here with its own verifier;
// the set is closed, so nothing can mint a v2 kind that no verifier checks.
export const SESSION_ACTOR_KINDS = Object.freeze(["peer-relay"]);

/** A bot_sessions.id as the decimal string the MAC binds, or null. */
function sessionField(v) {
  if (typeof v === "number") return Number.isSafeInteger(v) && v > 0 ? String(v) : null;
  if (typeof v !== "string") return null;
  const t = v.trim();
  return /^[1-9][0-9]{0,15}$/.test(t) ? t : null;
}

function v2Message({ kind, botId, sessionId, threadId, gatewayType }) {
  return JSON.stringify(["crow-actor-v2", f(kind), f(botId), sessionField(sessionId), f(threadId), f(gatewayType)]);
}

function v2Valid({ kind, botId, sessionId }) {
  return SESSION_ACTOR_KINDS.includes(kind) && botId != null && String(botId).trim() !== "" && sessionField(sessionId) !== null;
}

/** Session-bound signature, or null without a key (and no presigned match),
 *  a bot id, a valid session id, or a session kind. */
export function signSessionActor(actor = {}) {
  if (!v2Valid(actor)) return null;
  const msg = v2Message(actor);
  if (!key) return presignedFor(msg);
  return createHmac("sha256", key).update(msg).digest("hex");
}

/** Constant-time check of a presented session-bound signature. False without a key. */
export function verifySessionActorSig({ sig, ...actor } = {}) {
  if (!key || !v2Valid(actor) || typeof sig !== "string" || !/^[0-9a-f]{64}$/i.test(sig.trim())) return false;
  const want = createHmac("sha256", key).update(v2Message(actor)).digest();
  const got = Buffer.from(sig.trim(), "hex");
  return got.length === want.length && timingSafeEqual(got, want);
}

// ---- scope-bound actor headers, v3 (loopback MCP mount helper) ----
//
//   sig   = HMAC-SHA256(scopeKey, JSON(["crow-actor-v3", kind, bot, scope, thread, gateway]))
//   scope = jobId ? "j:<job_id>" : "s:<bot_sessions.id>"     (a job wins whenever one exists)
//
// Signed with the SECOND key (header comment): only the gateway can mint one,
// in process for its own bots, or through the signing relay for an owner job.
// Different version tag and a different key, so no v1/v2 signature verifies
// as v3 or the reverse. The verifier is handed the scope string the request
// carries (X-Crow-Actor-Scope) and resolves it itself (signed-session.js
// resolveSignedScope): the job still running, the session still live.

/** The kinds signed over the scope-bound (v3) tuple. Closed set, like v2. */
export const SCOPE_ACTOR_KINDS = Object.freeze(["service"]);

// bot_jobs.job_id as the generators mint it ("job-<base36>-<base36>"), with
// room for other safe ids; bounded so the scope header stays small. A job id
// outside it gets no v3 signature (fail closed), never a session fallback.
const JOB_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
export const SCOPE_RE = /^(s:[1-9][0-9]{0,15}|j:[A-Za-z0-9._:-]{1,128})$/;

/** The scope a turn's ids name: "j:<job>" when a job id is given (H1), else
 *  "s:<session>" for a valid session id, else null. */
export function scopeRefFor({ sessionId, jobId } = {}) {
  if (jobId != null && !(typeof jobId === "string" && jobId.trim() === "")) {
    const j = typeof jobId === "string" ? jobId.trim() : null;
    return j !== null && JOB_ID_RE.test(j) ? "j:" + j : null;
  }
  const s = sessionField(sessionId);
  return s === null ? null : "s:" + s;
}

function v3Message({ kind, botId, scope, threadId, gatewayType }) {
  return JSON.stringify(["crow-actor-v3", f(kind), f(botId), f(scope), f(threadId), f(gatewayType)]);
}

function v3Valid({ kind, botId, scope }) {
  return SCOPE_ACTOR_KINDS.includes(kind) && botId != null && String(botId).trim() !== "" && typeof scope === "string" && SCOPE_RE.test(scope.trim());
}

/** Scope-bound signature, or null for a non-scope kind, no bot, no scope, or
 *  no scope key (and no presigned match for exactly this tuple). */
export function signScopeActor({ kind, botId, sessionId, jobId, threadId, gatewayType } = {}) {
  const scope = scopeRefFor({ sessionId, jobId });
  const actor = { kind, botId, scope, threadId, gatewayType };
  if (!v3Valid(actor)) return null;
  const msg = v3Message(actor);
  if (!scopeKey) return presignedFor(msg);
  return createHmac("sha256", scopeKey).update(msg).digest("hex");
}

/** Constant-time check of a presented scope-bound signature over the scope
 *  string the request carries. False without the scope key. */
export function verifyScopeActorSig({ kind, botId, scope, threadId, gatewayType, sig } = {}) {
  const actor = { kind, botId, scope, threadId, gatewayType };
  if (!scopeKey || !v3Valid(actor) || typeof sig !== "string" || !/^[0-9a-f]{64}$/i.test(sig.trim())) return false;
  const want = createHmac("sha256", scopeKey).update(v3Message(actor)).digest();
  const got = Buffer.from(sig.trim(), "hex");
  return got.length === want.length && timingSafeEqual(got, want);
}

// ---- peer-relay actor headers (item 46 PR-B) ----
//
// A pi bot's remote-tools proxy (crow-remote-proxy.mjs) calls a paired peer
// through the gateway's loopback relay (servers/gateway/routes/peer-relay.js),
// never directly: no pair key, signing key or peer bearer reaches a bot
// process. The relay forwards only for a bot it verified with this signature
// (v2: bound to the bot session, which the relay resolves and checks), then
// signs the peer-bound tools/call with the pair subkey itself. Kind
// "peer-relay": no phone, board, board-thread or artifacts signature can be
// replayed here, nor this one there.

/** Signature for the peer-relay actor headers, or null without a key / bot id / session id. */
export function signPeerRelayActor({ botId, sessionId, threadId, gatewayType } = {}) {
  return signSessionActor({ kind: "peer-relay", botId, sessionId, threadId, gatewayType });
}

/** Constant-time check of a presented peer-relay signature. False without a key. */
export function verifyPeerRelayActorSig({ botId, sessionId, threadId, gatewayType, sig } = {}) {
  return verifySessionActorSig({ kind: "peer-relay", botId, sessionId, threadId, gatewayType, sig });
}

// ---- presigned signatures for a key-less bot host (item 46 PR-B) ----
//
// The separate bot hosts (the pibot-bridge@ tick, the pibot-gateways@ and
// pibot-discord@ runners) hold no key, and none may ever reach them. Before a
// turn's config is built, such a host asks its own gateway's loopback signing
// relay (POST /internal/actor-sign, servers/gateway/routes/actor-sign.js) for
// the signatures of this turn's exact tuples. The gateway authenticates the
// calling process (it must be the main process of one of those systemd
// units), checks the bot and its live session, and returns signatures only:
// never the key. They are cached here in memory and handed out by the sign*
// functions above only when this process holds no key, and only for exactly
// the tuple the gateway signed. Verification never reads the cache.

const PRESIGN_CAP = 256;
const presigned = new Map(); // message -> hex sig, insertion-ordered (LRU on write)

function presignedFor(msg) {
  const v = presigned.get(msg);
  return v === undefined ? null : v;
}

function remember(msg, sig) {
  presigned.delete(msg);
  if (presigned.size >= PRESIGN_CAP) presigned.delete(presigned.keys().next().value);
  presigned.set(msg, sig);
}

/** Test seam only. */
export function _resetPresignedForTest() { presigned.clear(); }

/** The exact message each kind signs for a turn's tuple (the catalog's tuples). */
function messageFor(kind, { botId, sessionId, threadId, gatewayType, jobId }) {
  if (SESSION_ACTOR_KINDS.includes(kind)) return v2Valid({ kind, botId, sessionId }) ? v2Message({ kind, botId, sessionId, threadId, gatewayType }) : null;
  if (SCOPE_ACTOR_KINDS.includes(kind)) {
    const scope = scopeRefFor({ sessionId, jobId }); // job first, as signScopeActor
    return v3Valid({ kind, botId, scope }) ? v3Message({ kind, botId, scope, threadId, gatewayType }) : null;
  }
  if (kind === "board") return v1Message({ kind, botId, threadId: jobId, gatewayType: null });
  if (kind === "bot" || kind === "artifacts" || kind === "board-thread") return v1Message({ kind, botId, threadId, gatewayType });
  return null;
}

/**
 * Ask this host's gateway to sign a turn's actor tuples. Never throws: any
 * failure leaves the cache without them, so the turn runs unsigned (today's
 * behaviour on a key-less host). Resolves true when at least one signature
 * was cached.
 */
export async function presignActors({ gatewayUrl, botId, sessionId, threadId, gatewayType, jobId, kinds = [], fetchImpl = globalThis.fetch, timeoutMs = 5000 } = {}) {
  try {
    if (!gatewayUrl || botId == null || String(botId).trim() === "" || !Array.isArray(kinds) || !kinds.length) return false;
    const tuple = {
      botId: String(botId),
      ...(sessionId != null && sessionId !== "" ? { sessionId: String(sessionId) } : {}),
      ...(threadId != null ? { threadId: String(threadId) } : {}),
      ...(gatewayType != null ? { gatewayType: String(gatewayType) } : {}),
      ...(jobId != null && jobId !== "" ? { jobId: String(jobId) } : {}),
    };
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    let body;
    try {
      const r = await fetchImpl(String(gatewayUrl).replace(/\/+$/, "") + "/internal/actor-sign", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...tuple, kinds: kinds.map(String) }),
        signal: ac.signal,
      });
      if (!r.ok) return false;
      body = await r.json();
    } finally { clearTimeout(t); }
    const sigs = body && typeof body === "object" && body.sigs && typeof body.sigs === "object" ? body.sigs : null;
    if (!sigs) return false;
    let n = 0;
    for (const kind of kinds) {
      const sig = sigs[kind];
      if (typeof sig !== "string" || !/^[0-9a-f]{64}$/i.test(sig)) continue;
      const msg = messageFor(kind, tuple);
      if (!msg) continue;
      remember(msg, sig.toLowerCase());
      n++;
    }
    return n > 0;
  } catch {
    return false;
  }
}

/** Gateway side of the signing relay: the signature of one kind over a turn's
 *  tuple with THIS process's key (null without one or for an unknown kind).
 *  A scope kind signs with the scope key, and only for a job tuple: the relay
 *  never signs an s: scope (spec §4.4; in-process bots use signScopeActor). */
export function signKindForTuple(kind, tuple = {}) {
  if (tuple.botId == null || String(tuple.botId).trim() === "") return null;
  if (SCOPE_ACTOR_KINDS.includes(kind)) {
    if (!scopeKey || !String(scopeRefFor(tuple) || "").startsWith("j:")) return null;
    const msg = messageFor(kind, tuple);
    return msg ? createHmac("sha256", scopeKey).update(msg).digest("hex") : null;
  }
  if (!key) return null;
  const msg = messageFor(kind, tuple);
  return msg ? createHmac("sha256", key).update(msg).digest("hex") : null;
}

// ---- board thread binding (redesign P5, Task 5.1) ----
//
// Lets /board/mcp learn which chat a call came from, so a card can be offered
// back into that conversation. Kind "board-thread": distinct from phone
// ("bot"), board and artifacts, so none of those signatures can be replayed
// here and this one can't be replayed there. botId is bound, so another bot's
// thread signature never attaches to this bot's calls.

/** Signature for the board thread headers, or null without a key / bot id. */
export function signBoardThreadActor({ botId, threadId, gatewayType } = {}) {
  return signActor({ kind: "board-thread", botId, threadId, gatewayType });
}

/** Constant-time check of a presented board-thread signature. */
export function verifyBoardThreadActorSig({ botId, threadId, gatewayType, sig } = {}) {
  return verifyActorSig({ kind: "board-thread", botId, threadId, gatewayType, sig });
}

/** Child side of the handoff: read the hex key the gateway wrote on stdin.
 *  Resolves false (never throws) when stdin is empty or closed. */
export async function readActorKeyFromStdin(stream = process.stdin, timeoutMs = 2000) {
  return await new Promise((resolve) => {
    let buf = "";
    let done = false;
    const finish = () => {
      if (done) return; done = true;
      clearTimeout(t);
      stream.removeListener("data", onData); stream.removeListener("end", finish); stream.removeListener("error", finish);
      try { stream.pause(); } catch {}
      resolve(setActorKey(buf.split("\n")[0] || ""));
    };
    const onData = (d) => { buf += d.toString("utf8"); if (buf.includes("\n") || buf.length >= 64) finish(); };
    const t = setTimeout(finish, timeoutMs);
    stream.on("data", onData); stream.once("end", finish); stream.once("error", finish);
    try { stream.resume(); } catch { finish(); }
  });
}
