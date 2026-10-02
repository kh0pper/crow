/**
 * Actor-header binding (S2, 2026-10-02).
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
 *    A process with no key signs nothing; its bots' phone plans are then
 *    unattributed (owner notification only, no Perch card, no thread reply).
 *
 * What this stops: a child impersonating OTHER bots or sessions. What it does
 * not stop: a child replaying its OWN signed headers (it can read its own
 * .mcp.json), or a child that is root-equivalent anyway (see the report).
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

let key = null;

/** Gateway boot: mint the per-boot key once (idempotent). Returns it so the
 *  gateway can hand it to a supervised child over a pipe. */
export function initGatewayActorKey() {
  if (!key) key = randomBytes(32);
  return key;
}

/** Install a key received from the gateway (child processes). Accepts a
 *  Buffer or a hex string; anything not 32 bytes is ignored. */
export function setActorKey(k) {
  const b = Buffer.isBuffer(k) ? k : (typeof k === "string" && /^[0-9a-f]{64}$/i.test(k.trim()) ? Buffer.from(k.trim(), "hex") : null);
  if (b && b.length === 32) key = Buffer.from(b);
  return !!key;
}

export function hasActorKey() { return !!key; }

/** Test seam only. */
export function _resetActorKeyForTest() { key = null; }

function mac(k, { kind = "bot", botId, threadId, gatewayType }) {
  // JSON array, not a joined string: no field value can shift a boundary.
  const msg = JSON.stringify(["crow-actor-v1", kind || "", botId == null ? "" : String(botId),
    threadId == null ? "" : String(threadId), gatewayType == null ? "" : String(gatewayType)]);
  return createHmac("sha256", k).update(msg).digest("hex");
}

/** Signature for the actor headers, or null when this process holds no key. */
export function signActor(actor) {
  if (!key || !actor || actor.botId == null || actor.botId === "") return null;
  return mac(key, actor);
}

/** Constant-time check of a presented signature. False without a key. */
export function verifyActorSig({ kind = "bot", botId, threadId, gatewayType, sig }) {
  if (!key || typeof sig !== "string" || !/^[0-9a-f]{64}$/i.test(sig) || botId == null || botId === "") return false;
  const want = Buffer.from(mac(key, { kind, botId, threadId, gatewayType }), "hex");
  const got = Buffer.from(sig, "hex");
  return got.length === want.length && timingSafeEqual(got, want);
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
