/**
 * The research-eval trajectory replayer (harness mode). It starts the real fixture research
 * server (fixture-server.mjs) over stdio inside a scratch instance, drives a recorded
 * trajectory's tool calls through the MCP SDK client, and writes a pi-style session log that
 * session-log.mjs parseSession reads.
 *
 * Why harness mode drives the MCP tools directly, without pi: pi
 * (@earendil-works/pi-coding-agent) is not an npm dependency of this repo and is not on the CI
 * runner's PATH, and the design leaves the driver to the builder. The trajectory files and the
 * session-log shape are the ones a later pi + stub-model driver will replay, so the scorer does
 * not change when that driver lands.
 *
 * Trajectory steps (JSON):
 *   { "call": "<tool>", "args": {...} }   one assistant message with one tool call
 *   { "batch": [<call steps>] }             one assistant message with parallel calls; they run in
 *                                           order (a later call's placeholder can resolve) and all
 *                                           their results follow that one message
 *   { "say": "<text>" }                     one assistant text message
 * Placeholders in args (resolved to NUMBERS, the tools' zod schemas take z.number()):
 *   "$project"       the scratch instance's project id
 *   "$source:<url>"  the id from the earliest call on <url> whose result reads
 *                    "Source added (id: N" / "Source already exists (id: N" / "Source #N:"
 *
 * Session log: one header line, an optional user line (the case prompt), then
 * {"type":"message","message":{...}} lines. A toolCall is {type:"toolCall", id, name, arguments}
 * named mcp__crow-projects__<tool> with ids c1, c2, …; a toolResult is {role:"toolResult",
 * toolCallId, toolName, content, isError}: the shape pinned from a real pi log (the private
 * engineering notes).
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { TOOL_PREFIX } from "./session-log.mjs";
import { ROOT } from "./scratch.mjs";

export const FIXTURE_SERVER = join(import.meta.dirname, "fixture-server.mjs");
export const TRAJECTORIES_DIR = join(import.meta.dirname, "trajectories");
export const EXIT_WAIT_MS = 10_000;
export const BASE_TRAJECTORIES = ["careful", "hank", "correcting"];

const ID_RE = [/Source (?:added|already exists) \(id: (\d+)/, /^Source #(\d+):/];
// MCP error codes that mean the connection, not the tool, failed (ConnectionClosed, RequestTimeout).
const TRANSPORT_CODES = new Set([-32000, -32001]);

/** Thrown for a trajectory that cannot be replayed as written (never retried: it is not transport). */
export class TrajectoryError extends Error {}

export const CHILD_MISSING = "cannot find the fixture server child; refusing to read evidence";

/**
 * A trajectory by name. `careful`, `hank` and `correcting` are top-level keys of
 * <dir>/<caseId>.json; "<case>.<name>" is that case's `adversarial[<name>]`.
 * @returns {{steps: object[], fails?: string[]}}
 */
export function loadTrajectory(caseId, name, dir = TRAJECTORIES_DIR) {
  const dot = String(name).indexOf(".");
  const file = join(dir, `${caseId}.json`);
  if (!existsSync(file)) throw new TrajectoryError(`no trajectory file for ${caseId} (${file})`);
  const all = JSON.parse(readFileSync(file, "utf8"));
  let t;
  if (dot >= 0) {
    const [forCase, adv] = [name.slice(0, dot), name.slice(dot + 1)];
    if (forCase !== caseId) throw new TrajectoryError(`trajectory ${name} belongs to ${forCase}, not ${caseId}`);
    t = all.adversarial?.[adv];
  } else {
    t = all[name];
  }
  if (!t || !Array.isArray(t.steps)) throw new TrajectoryError(`${caseId} has no ${name} trajectory`);
  return t;
}

/** The case a "<case>.<name>" trajectory is for, or null for a base trajectory run on every case. */
export function trajectoryCase(name) {
  const dot = String(name).indexOf(".");
  return dot >= 0 ? name.slice(0, dot) : null;
}

function resolveArgs(value, ctx) {
  if (Array.isArray(value)) return value.map((v) => resolveArgs(v, ctx));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveArgs(v, ctx)]));
  if (value === "$project") return Number(ctx.projectId);
  if (typeof value === "string" && value.startsWith("$source:")) {
    const url = value.slice("$source:".length);
    if (!ctx.sources.has(url)) throw new TrajectoryError(`placeholder ${value}: no earlier result gave a source id for that url`);
    return Number(ctx.sources.get(url));
  }
  return value;
}

const textOf = (content) => (Array.isArray(content) ? content : [])
  .filter((b) => b && b.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n");

function sourceIdIn(text) {
  for (const re of ID_RE) {
    const m = re.exec(text);
    if (m) return Number(m[1]);
  }
  return null;
}

/**
 * Runs one SDK request with its own abort signal, aborted if the request fails. The SDK leaves a
 * failed request's 60 s timeout timer running when the connection closes under it (a server that
 * refuses to start), which would hold the process open; the abort clears it.
 */
async function settled(request) {
  const ac = new AbortController();
  try {
    return await request({ signal: ac.signal });
  } catch (err) {
    ac.abort();
    throw err;
  }
}

/**
 * Waits for `child` to exit, at most `ms`. → "exited" (a normal exit, any code), "signal" (killed
 * by a signal: it may have died mid-write) or "timeout".
 */
function waitExit(child, ms) {
  const how = () => (child.signalCode !== null ? "signal" : "exited");
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(how());
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve("timeout"), ms);
    child.once("exit", () => { clearTimeout(t); resolve(how()); });
  });
}

/**
 * Replays `steps` against the fixture server for `casePath` inside `scratch` (scratch.mjs) and
 * appends the session to scratch.sessionPath. Returns only once the server child has exited, so
 * its DB is closed and the fetch log is complete.
 * `afterConnect(transport)` is a test-only seam, called once the connection is up.
 * @returns {Promise<{ok: boolean, error?: string}>} ok false = a transport or spawn failure, a
 *   server child that cannot be found or did not exit in time, or one killed by a signal (retryable)
 * @throws {TrajectoryError} a step that cannot be replayed as written
 */
export async function replayTrajectory({ casePath, steps, scratch, afterConnect }) {
  const caseDef = JSON.parse(readFileSync(casePath, "utf8"));
  const write = (obj) => appendFileSync(scratch.sessionPath, JSON.stringify(obj) + "\n");
  const message = (m) => write({ type: "message", message: m });
  write({ type: "session", version: 3, id: `replay-${caseDef.id}`, timestamp: new Date().toISOString(), cwd: scratch.home, replay: true });
  if (typeof caseDef.prompt === "string") message({ role: "user", content: [{ type: "text", text: caseDef.prompt }] });

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [FIXTURE_SERVER],
    env: { ...scratch.env, CROW_RESEARCH_EVAL_CASE: casePath, CROW_RESEARCH_EVAL_FETCH_LOG: scratch.fetchLogPath },
    cwd: ROOT,
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (d) => { if (stderr.length < 8192) stderr += String(d); });
  const client = new Client({ name: "research-eval-replay", version: "1.0.0" });
  const ctx = { projectId: scratch.projectId, sources: new Map() };
  let n = 0;
  let child = null;
  let failure = null;
  const tail = () => (stderr.trim() ? ` (server stderr: ${stderr.trim().split("\n").slice(-3).join(" | ")})` : "");

  try {
    await settled((o) => client.connect(transport, o));
    // The SDK keeps the child private; it is needed to wait for its exit after close(). Without
    // it the DB and fetch log may still be open, so the attempt fails (retryable), never reads on.
    if (afterConnect) afterConnect(transport); // test-only seam: inspect or break the live transport
    child = transport._process ?? null;
    if (!child || typeof child.once !== "function") throw new Error(CHILD_MISSING);
    for (const step of steps) {
      if (typeof step?.say === "string") {
        message({ role: "assistant", content: [{ type: "text", text: step.say }] });
        continue;
      }
      const calls = Array.isArray(step?.batch) ? step.batch : step?.call ? [step] : null;
      if (!calls || calls.length === 0 || calls.some((c) => typeof c?.call !== "string")) {
        throw new TrajectoryError(`unknown trajectory step ${JSON.stringify(step)}`);
      }
      const done = [];
      for (const c of calls) {
        const args = resolveArgs(c.args ?? {}, ctx);
        const id = `c${++n}`;
        let content;
        let isError;
        try {
          const r = await settled((o) => client.callTool({ name: c.call, arguments: args }, undefined, o));
          content = Array.isArray(r.content) ? r.content : [];
          isError = r.isError === true;
        } catch (err) {
          if (err?.code === undefined || TRANSPORT_CODES.has(err.code)) throw err;
          // A protocol-level tool error (bad arguments, unknown tool): the bot would see it as an error result.
          content = [{ type: "text", text: String(err.message) }];
          isError = true;
        }
        const url = typeof args.url === "string" ? args.url : null;
        const sid = isError ? null : sourceIdIn(textOf(content));
        if (url && sid !== null && !ctx.sources.has(url)) ctx.sources.set(url, sid);
        done.push({ id, name: c.call, args, content, isError });
      }
      message({ role: "assistant", content: done.map((d) => ({ type: "toolCall", id: d.id, name: TOOL_PREFIX + d.name, arguments: d.args })) });
      for (const d of done) message({ role: "toolResult", toolCallId: d.id, toolName: TOOL_PREFIX + d.name, content: d.content, isError: d.isError });
    }
  } catch (err) {
    if (err instanceof TrajectoryError) failure = err;
    else failure = { ok: false, error: `${err?.message ?? err}${tail()}` };
  }

  try { await client.close(); } catch { /* the child is waited on below */ }
  // A child that never connected (a refused start) has already gone; there is nothing to read.
  const exit = child ? await waitExit(child, EXIT_WAIT_MS) : null;
  if (failure instanceof TrajectoryError) throw failure;
  if (failure) return failure;
  if (exit === "timeout") return { ok: false, error: `the fixture server did not exit within ${EXIT_WAIT_MS} ms${tail()}` };
  if (exit === "signal") return { ok: false, error: `the fixture server was killed by ${child.signalCode}; its writes may be incomplete${tail()}` };
  return { ok: true };
}
