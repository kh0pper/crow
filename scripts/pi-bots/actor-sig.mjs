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
 *
 * Board-only shared secret (optional, operator-provisioned): see boardKey()
 * below. It is the one deliberate exception to "never in env", and it covers
 * board signatures only.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { BOARD_ACTOR_SECRET_ENV } from "../../servers/shared/bot-env.js";

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
export function _resetActorKeyForTest() { key = null; boardSecretKey = null; warnedBadSecret = false; }

function mac(k, { kind = "bot", botId, threadId, gatewayType }) {
  // JSON array, not a joined string: no field value can shift a boundary.
  // Fields are trimmed on BOTH sides: HTTP strips edge whitespace from header
  // values, so an untrimmed MAC would silently fail for such an id.
  const f = (v) => (v == null ? "" : String(v).trim());
  const msg = JSON.stringify(["crow-actor-v1", f(kind), f(botId), f(threadId), f(gatewayType)]);
  return createHmac("sha256", k).update(msg).digest("hex");
}

function signWith(k, actor) {
  if (!k || !actor || actor.botId == null || String(actor.botId).trim() === "") return null;
  return mac(k, actor);
}

function verifyWith(k, { kind = "bot", botId, threadId, gatewayType, sig }) {
  if (!k || typeof sig !== "string" || !/^[0-9a-f]{64}$/i.test(sig.trim()) || botId == null || String(botId).trim() === "") return false;
  const want = Buffer.from(mac(k, { kind, botId, threadId, gatewayType }), "hex");
  const got = Buffer.from(sig.trim(), "hex");
  return got.length === want.length && timingSafeEqual(got, want);
}

/** Signature for the actor headers, or null when this process holds no key. */
export function signActor(actor) {
  return signWith(key, actor);
}

/** Constant-time check of a presented signature. False without a key. */
export function verifyActorSig(args) {
  return verifyWith(key, args);
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

// ---- board-only shared secret (2026-10-20) ----
//
// Out-of-gateway runners (the external-supervisor runner, pibot-gateways)
// never hold the gateway's per-boot key, so their board writes were always
// unattributed. An operator may provision CROW_BOARD_ACTOR_SECRET (hex or
// base64, at least 32 bytes decoded) in the environment of BOTH the gateway
// and the runner. The board key is then
//
//   boardKey = HMAC-SHA256(secret, "crow-board-actor-v1")
//
// in every process that has it, so a runner's board signature verifies at
// the gateway and survives a gateway restart. Scope, deliberately narrow:
//  - board only. Phone and artifacts signatures keep the per-boot in-memory
//    key; the secret cannot mint them.
//  - the secret never reaches a child: every bot/child env builder strips it
//    (servers/shared/bot-env.js withoutBoardActorSecret), and
//    initBoardSigning() captures the derived key and removes the variable
//    from process.env so later children cannot inherit it. The supervised
//    Discord child gets the DERIVED board key over stdin, like the per-boot
//    key, never the secret.
//  - it is weaker than the per-boot key against a same-uid process that can
//    read the gateway's or runner's /proc/<pid>/environ (Yama does not guard
//    environ reads) or the EnvironmentFile. That is the "bot with an open
//    shell" case documented above; provision the secret in a root-owned 0600
//    EnvironmentFile, never a world-readable one.
// A secret that is set but too short or not hex/base64 is ignored with one
// warning, and board signing falls back to the per-boot key.

const BOARD_KDF_LABEL = "crow-board-actor-v1";
let boardSecretKey = null; // derived board key (captured from env, or handed over a pipe)
let warnedBadSecret = false;

/** Decode an operator secret: hex first (even length, hex digits only), else
 *  base64 / base64url. Returns a Buffer of at least 32 bytes, or null. */
export function decodeBoardSecret(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  let b = null;
  if (s.length % 2 === 0 && /^[0-9a-f]+$/i.test(s)) b = Buffer.from(s, "hex");
  else if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(s)) b = Buffer.from(s, "base64");
  return b && b.length >= 32 ? b : null;
}

function secretKeyFromEnv() {
  const raw = process.env.CROW_BOARD_ACTOR_SECRET;
  if (raw == null || String(raw).trim() === "") return null;
  const b = decodeBoardSecret(raw);
  if (!b) {
    if (!warnedBadSecret) {
      warnedBadSecret = true;
      // Never the value, never its length.
      console.warn("[actor-sig] " + BOARD_ACTOR_SECRET_ENV + " is set but does not decode (hex or base64) to at least 32 bytes; ignored; board signing falls back to the per-boot key where this process has one");
    }
    return null;
  }
  return createHmac("sha256", b).update(BOARD_KDF_LABEL).digest();
}

function boardKey() {
  return boardSecretKey || secretKeyFromEnv() || key;
}

/** "shared-secret" | "per-boot" | "none": which key signs and verifies board
 *  actor headers in this process. */
export function boardSigningMode() {
  if (boardSecretKey || secretKeyFromEnv()) return "shared-secret";
  return key ? "per-boot" : "none";
}

/** Startup (gateway and runner): capture the derived board key, then drop the
 *  secret from this process's env so no child spawned later inherits it.
 *  Returns boardSigningMode(). Idempotent. */
export function initBoardSigning() {
  const k = secretKeyFromEnv();
  if (k) boardSecretKey = k;
  delete process.env.CROW_BOARD_ACTOR_SECRET;
  return boardSigningMode();
}

/** Install a derived board key received from the gateway over a pipe (the
 *  supervised Discord child). 64 hex chars, else ignored. */
export function setBoardKey(hex) {
  if (typeof hex === "string" && /^[0-9a-f]{64}$/i.test(hex.trim())) boardSecretKey = Buffer.from(hex.trim(), "hex");
  return !!boardSecretKey;
}

/** Gateway side of the Discord handoff: " <derived board key hex>" in
 *  shared-secret mode, "" otherwise (the per-boot key then covers board). */
export function boardKeyHandoff() {
  const k = boardSecretKey || secretKeyFromEnv();
  return k ? " " + k.toString("hex") : "";
}

/** Signature for the board actor headers, or null without a key / bot id. */
export function signBoardActor({ botId, jobId } = {}) {
  return signWith(boardKey(), { kind: "board", botId, threadId: jobId, gatewayType: null });
}

/** Constant-time check of a presented board signature. False without a key. */
export function verifyBoardActorSig({ botId, jobId, sig } = {}) {
  return verifyWith(boardKey(), { kind: "board", botId, threadId: jobId, gatewayType: null, sig });
}

// ---- artifacts actor headers (Crow Artifacts, spec §7.1 / H6) ----
//
// /artifacts/mcp attributes a call to (bot, thread, gateway). Same key and
// MAC; kind "artifacts", so neither a phone ("bot") nor a board signature can
// be replayed here, nor an artifacts signature there.

/** Signature for the artifacts actor headers, or null without a key / bot id. */
export function signArtifactsActor({ botId, threadId, gatewayType } = {}) {
  return signWith(key, { kind: "artifacts", botId, threadId, gatewayType });
}

/** Constant-time check of a presented artifacts signature. False without a key. */
export function verifyArtifactsActorSig({ botId, threadId, gatewayType, sig } = {}) {
  return verifyWith(key, { kind: "artifacts", botId, threadId, gatewayType, sig });
}

/** Child side of the handoff: read the line the gateway wrote on stdin,
 *  "<per-boot key hex>[ <derived board key hex>]". Resolves whether the
 *  per-boot key was installed; false (never throws) when stdin is empty or
 *  closed. */
export async function readActorKeyFromStdin(stream = process.stdin, timeoutMs = 2000) {
  return await new Promise((resolve) => {
    let buf = "";
    let done = false;
    const finish = () => {
      if (done) return; done = true;
      clearTimeout(t);
      stream.removeListener("data", onData); stream.removeListener("end", finish); stream.removeListener("error", finish);
      try { stream.pause(); } catch {}
      const [actorHex = "", boardHex = ""] = (buf.split("\n")[0] || "").trim().split(/\s+/);
      if (boardHex) setBoardKey(boardHex);
      resolve(setActorKey(actorHex));
    };
    // 64 hex + space + 64 hex = 129; a longer unterminated line is not ours.
    const onData = (d) => { buf += d.toString("utf8"); if (buf.includes("\n") || buf.length >= 160) finish(); };
    const t = setTimeout(finish, timeoutMs);
    stream.on("data", onData); stream.once("end", finish); stream.once("error", finish);
    try { stream.resume(); } catch { finish(); }
  });
}
