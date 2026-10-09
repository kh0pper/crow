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
  // Fields are trimmed on BOTH sides: HTTP strips edge whitespace from header
  // values, so an untrimmed MAC would silently fail for such an id.
  const f = (v) => (v == null ? "" : String(v).trim());
  const msg = JSON.stringify(["crow-actor-v1", f(kind), f(botId), f(threadId), f(gatewayType)]);
  return createHmac("sha256", k).update(msg).digest("hex");
}

/** Signature for the actor headers, or null when this process holds no key. */
export function signActor(actor) {
  if (!key || !actor || actor.botId == null || String(actor.botId).trim() === "") return null;
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
