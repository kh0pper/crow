/**
 * Every crow_browser_* tool call goes through the shared browser lease
 * (servers/shared/browser-lease.js), so bots take turns on the one shared page
 * and wait for the operator without ever acting late.
 *
 * installLeaseGuard(server) wraps server.tool so each registered handler is
 * guarded; it must run before the first registration. Per call:
 *   - crow_browser_status and crow_browser_guide skip the lease (they never
 *     drive the page);
 *   - the lease is free, ours, or expired → take or renew it, mark the call in
 *     flight (inCall, with this process's page targetId), run the tool, end
 *     the call. When someone else had the lease since this session last did,
 *     the result starts with the "changed hands" text; when the operator took
 *     it while the tool ran, with the "took the browser during this step" text;
 *   - another bot holds it → the busy text at once, no action;
 *   - the operator holds it, or a take-over is waiting for in-flight calls
 *     (the lease's pendingOperator) → wait up to 20 s (poll 500 ms, always under pi's
 *     30 s tool timeout). A call that waited NEVER acts: it returns the held
 *     text, or the handed-back text once the operator lets go, and the bot
 *     calls again (that next call acts, with the "changed hands" prefix).
 *   - a locked (ELEASELOCKED) or unreadable lease → the busy text, no action.
 *
 * Identity comes from the spawn env only (never tool arguments):
 * PI_BOT_PERCH_SESSION_ID and PI_BOT_ID, set by the gateway for a Perch turn.
 * Without them (Gmail/Discord bridge turns, other MCP clients) the holder is
 * "external:<pid>", released on beforeExit/SIGTERM/SIGINT and by the TTL.
 *
 * The lease is advisory (a bot with a shell can reach CDP directly); nothing
 * private depends on it. If the lease module is missing (an installed bundle
 * on an older core), the tools run as before, without a lease.
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { appImport } from "./app-root.js";
import { stateDir } from "./instance.js";

let sharedLease = null;
try {
  sharedLease = await appImport("servers/shared/browser-lease.js");
} catch {
  // An older core without the lease module: no lease, tools run as before.
}

export const TEXTS = Object.freeze({
  busy: "The browser is busy: another bot is using it. Try again in a minute.",
  held: "The operator has the browser; call again to continue.",
  handedBack: "The operator handed the browser back; call again.",
  genChanged: "The browser changed hands since your last step; check the page before relying on earlier state.",
  taken: "The operator took the browser during this step; check the page.",
});

/** Tools that never drive the page and so never touch the lease. */
/** One retry of a failed endCall, this long after. */
export const END_CALL_RETRY_MS = 500;

export const EXEMPT_TOOLS = new Set(["crow_browser_status", "crow_browser_guide"]);

const OPERATOR_WAIT_MS = 20000;
const OPERATOR_POLL_MS = 500;
const TARGET_ID_TIMEOUT_MS = 1000;
const EXIT_RELEASE_TIMEOUT_MS = 2000;
// A lock older than this is broken whatever pid it names (a planted lock
// naming a live pid must not jam every call); the gateway uses the same.
const LOCK_OPTS = Object.freeze({ forceBreakAfterMs: 30000 });

const SESSION_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const TOKEN_RE = /^[\x21-\x7e]{1,128}$/;

/** The lease holder for this process, from the spawn env. */
export function leaseIdentity(env = process.env, pid = process.pid) {
  const sid = env.PI_BOT_PERCH_SESSION_ID;
  if (typeof sid === "string" && SESSION_RE.test(sid) && sid !== "." && sid !== "..") {
    const botId = typeof env.PI_BOT_ID === "string" && TOKEN_RE.test(env.PI_BOT_ID) ? env.PI_BOT_ID : null;
    return { holder: { kind: "bot", sessionId: sid, botId }, external: false };
  }
  return { holder: { kind: "bot", sessionId: "external:" + pid, botId: null }, external: true };
}

const textResult = (text) => ({ content: [{ type: "text", text }] });

/** `result` with `prefix` in front of its first text item (or as a new first item). */
function withPrefix(result, prefix) {
  if (!prefix || !result || typeof result !== "object" || !Array.isArray(result.content)) return result;
  const content = result.content.slice();
  const first = content[0];
  if (first && first.type === "text" && typeof first.text === "string") {
    content[0] = { ...first, text: prefix + "\n\n" + first.text };
  } else {
    content.unshift({ type: "text", text: prefix });
  }
  return { ...result, content };
}

function defaultIsAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A promise that settles with `fallback` after `ms` (timer unref'd), or with `p`. */
function within(p, ms, fallback) {
  return Promise.race([
    p,
    new Promise((r) => { const t = setTimeout(() => r(fallback), ms); t.unref?.(); }),
  ]);
}

/** This bundle's version, from its own manifest (the installed copy's, when installed). */
export function ownBundleVersion() {
  try {
    const m = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
    return typeof m.version === "string" ? m.version : null;
  } catch { return null; }
}

/**
 * Tell the gateway this server enforces the lease (R1.2 PR 5): enforced.json
 * in the lease directory, written atomically, naming this bundle's version.
 * The gateway offers Take over only while that version matches the installed
 * manifest. Never blocks startup: a failure is logged (stderr; stdout is the
 * MCP channel) and the server carries on.
 */
function reportEnforced(lease, dir, opts) {
  if (opts.reportEnforced === false || typeof lease.writeEnforced !== "function") return;
  try {
    const bundleVersion = "bundleVersion" in opts ? opts.bundleVersion : ownBundleVersion();
    if (!bundleVersion) throw new Error("no bundle version");
    lease.writeEnforced(dir, { bundleVersion, now: Date.now() });
  } catch (e) {
    try { console.error("[browser] lease enforcement not reported: " + String((e && e.code) || "error").slice(0, 40)); } catch { /* no stderr */ }
  }
}

/**
 * Wrap every later server.tool(...) registration with the lease.
 *
 * @param {object} server  an McpServer (anything with tool(name, ..., handler))
 * @param {object} [opts]  test seams: lease (module, or null for none), dir,
 *   env, pid, now, sleep, getTargetId (async → this process's page target id
 *   or null), proc (signal source), exit (process.exit)
 * @returns {{ holder, external, enabled, exiting }}
 */
export function installLeaseGuard(server, opts = {}) {
  const lease = "lease" in opts ? opts.lease : sharedLease;
  const pid = opts.pid ?? process.pid;
  const now = opts.now || Date.now;
  const sleep = opts.sleep || realSleep;
  const getTargetId = opts.getTargetId || (async () => null);
  const proc = opts.proc || process;
  const exit = opts.exit || ((code) => process.exit(code));
  const { holder, external } = leaseIdentity(opts.env || process.env, pid);
  let dir = null;
  if (lease) {
    try { dir = opts.dir || lease.leaseDir(stateDir); } catch { dir = null; }
  }
  const enabled = !!(lease && dir);
  const guard = { holder, external, enabled, exiting: null };
  if (!enabled) return guard;
  reportEnforced(lease, dir, opts);

  async function targetIdNow() {
    try {
      const id = await within(Promise.resolve(getTargetId()), TARGET_ID_TIMEOUT_MS, null);
      return typeof id === "string" && TOKEN_RE.test(id) ? id : null;
    } catch { return null; }
  }

  /** The operator holds it, or has asked for it (a take-over waiting on in-flight calls). */
  function operatorBlocks(cur) {
    if (typeof lease.operatorBlocks === "function") return lease.operatorBlocks(cur, now());
    return !!(cur && cur.holder && cur.holder.kind === "operator" && !lease.isFree(cur, now()));
  }

  /** The operator holds it: wait (never act) until they let go or 20 s pass. */
  async function waitForOperator(start) {
    const deadline = start + OPERATOR_WAIT_MS;
    for (;;) {
      const left = deadline - now();
      if (left <= 0) return TEXTS.held;
      await sleep(Math.min(OPERATOR_POLL_MS, left));
      let cur;
      try { cur = await lease.readLease(dir); } catch { return TEXTS.held; }
      if (!operatorBlocks(cur)) return TEXTS.handedBack;
    }
  }

  async function guarded(handler, args) {
    const start = now();
    let acq;
    try {
      acq = await lease.acquire(dir, holder, { now: start, ...LOCK_OPTS });
    } catch {
      return textResult(TEXTS.busy);   // ELEASELOCKED or any lease I/O error
    }
    if (!acq || !acq.ok) {
      if (acq && acq.reason === "operator") return textResult(await waitForOperator(start));
      return textResult(TEXTS.busy);
    }

    const callId = randomBytes(8).toString("hex");
    let targetId = await targetIdNow();
    let begun;
    try {
      begun = await lease.beginCall(dir, holder, { callId, pid, targetId, now: now(), ...LOCK_OPTS });
    } catch {
      // Lost the lease between acquire and beginCall (or the lease broke): do not act.
      let cur = null;
      try { cur = await lease.readLease(dir); } catch { /* treat as busy */ }
      return textResult(operatorBlocks(cur) ? TEXTS.held : TEXTS.busy);
    }

    let result;
    let ended = null;
    try {
      result = await handler(...args);
    } finally {
      // A first call (launch, or before Chrome was connected) records its page afterwards.
      if (!targetId) {
        targetId = await targetIdNow();
        if (targetId) {
          try { await lease.beginCall(dir, holder, { callId, pid, targetId, now: now(), ...LOCK_OPTS }); } catch { /* taken meanwhile */ }
        }
      }
      try {
        ended = await lease.endCall(dir, holder, { callId, now: now(), ...LOCK_OPTS });
      } catch {
        // A locked lease (ELEASELOCKED) or a write error: one retry after
        // 500 ms, so a finished call does not sit in inCall (it would make a
        // take-over wait the full 30 s). Still advisory after that.
        try {
          await sleep(END_CALL_RETRY_MS);
          ended = await lease.endCall(dir, holder, { callId, now: now(), ...LOCK_OPTS });
        } catch { /* advisory */ }
      }
    }

    const prefixes = [];
    if (acq.genChanged) prefixes.push(TEXTS.genChanged);
    // gen moved while the tool ran: someone else took the lease mid-call.
    if (ended && ended.gen !== begun.gen) {
      const operatorInvolved = (ended.holder && ended.holder.kind === "operator") || ended.lastHolderKey === "operator:operator";
      if (operatorInvolved) prefixes.push(TEXTS.taken);
      else if (!acq.genChanged) prefixes.push(TEXTS.genChanged);
    }
    return withPrefix(result, prefixes.join("\n\n"));
  }

  const register = server.tool.bind(server);
  server.tool = (name, ...rest) => {
    const handler = rest[rest.length - 1];
    if (typeof handler === "function" && !EXEMPT_TOOLS.has(name)) {
      rest[rest.length - 1] = (...args) => guarded(handler, args);
    }
    return register(name, ...rest);
  };

  if (external) {
    const releaseNow = () => {
      guard.exiting ||= (async () => {
        try {
          await within(lease.release(dir, holder.sessionId, {
            now: now(),
            // We are exiting: our own in-flight calls must not defer the release.
            isAlive: (p) => p !== pid && defaultIsAlive(p),
            lockTimeoutMs: 1000,
            ...LOCK_OPTS,
          }), EXIT_RELEASE_TIMEOUT_MS, null);
        } catch { /* advisory: the TTL frees it */ }
      })();
      return guard.exiting;
    };
    proc.on("beforeExit", () => { releaseNow(); });
    for (const [signal, code] of [["SIGTERM", 143], ["SIGINT", 130]]) {
      proc.on(signal, () => { releaseNow().then(() => exit(code)); });
    }
  }
  return guard;
}
