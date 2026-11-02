/**
 * The dashboard chat's view of a project's connections (project services Task 20).
 *
 * The chat runs in-process, so it does not go through `/services-tools/<uuid>/mcp`; this module
 * is the small adapter that gives it the same two things the mount gives a bot: the connection's
 * cached tools under `mcp__<block>__<tool>` names, and a call that starts the child on demand.
 *
 *  - Listing starts nothing (I3): tools come ONLY from the per-service cache (listedTools), so a
 *    connection whose child never started contributes nothing. `onlyUuids` (a Set) restricts the
 *    listing to named connections; it is the seam roadmap PR 10's kiosk opt-in uses.
 *  - A connection is offered only when its binding still matches the service the owner connected
 *    and it is not sensitive (Task 16c). Any doubt is "skip": a sensitive connection's tools are
 *    never advertised, let alone called.
 *  - A call re-checks the same three things, because the owner may have disconnected the
 *    connection or switched it to private since the tools were listed. The refusals use the
 *    mount's fixed copy, never a row's error text.
 *  - EVERY result passes through shapeServiceResult with the connection's injected values before
 *    it becomes text: this path bypasses the mount's own shaping, so a token a child echoes back
 *    must still reach the chat as [redacted].
 *  - Tool names over 64 characters, and names carrying characters a model rejects (anything
 *    outside [A-Za-z0-9_-]), are not advertised; each name is warned about once per process. A
 *    duplicate name keeps the first connection in connectionsFor order.
 *  - A call has its own budget (60 s by default) and accepts the caller's abort signal, so a
 *    stopped chat turn cancels it; hitting the budget answers with the mount's timeout copy.
 */
import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { blockNameFor } from "../../shared/service-catalog.js";
import { listConnections, servableConnection } from "../../shared/service-connections.js";
import { connectionBindingOk, isSensitiveConnection } from "../../shared/service-sensitivity.js";
import { resolveCrowHome } from "../../shared/crow-home.js";
import { loopbackErrorText } from "../loopback-tool-mount.js";
import {
  ChildError, childSecretValues, ensureChild, listableConnection, listedTools, shapeServiceResult,
} from "./children.js";

/** The longest tool name a model accepts (I10, the same cap Task 18 applies to its blocks). */
export const SERVICE_TOOL_NAME_MAX = 64;
/** A name a model will accept: the mount's tool names are mcp__<block>__<tool>, nothing else. */
export const SERVICE_TOOL_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** The mount's per-call budget (SERVICES_CALL_TIMEOUT_MS in services/mount.js). */
export const SERVICE_CALL_TIMEOUT_MS = 60_000;
const DEFAULT_SCHEMA = Object.freeze({ type: "object", properties: {} });
/** The names already warned about (one console line per process per name). */
const warnedLongNames = new Set();
const warnedBadNames = new Set();
/** The rejection reason of a call that used up its budget. */
const CALL_TIMED_OUT = Symbol("service-call-timeout");
/** The ChildError codes with their own fixed copy; any other failure is "<tool> failed.". */
const FIXED_ERRORS = new Set(["busy", "child_unavailable", "not_installed", "not_active"]);

/**
 * The project's service tools, as chat tool schemas, and the route from each name back to its
 * connection and the child's own tool name.
 *
 * @param {object} db
 * @param {{projectId?: number|null, crowHome?: string, onlyUuids?: Set<string>|null}} opts
 * @returns {Promise<{tools: Array<{name: string, description: string, inputSchema: object}>,
 *                    route: Map<string, {uuid: string, toolName: string}>}>}
 */
export async function listProjectServiceTools(db, { projectId = null, crowHome = resolveCrowHome(), onlyUuids = null } = {}) {
  const tools = [];
  const route = new Map();
  if (projectId == null) return { tools, route };

  // The same rows the mount offers (fix round 1): active, plus an 'error' row ensureChild still
  // retries on its own (listableConnection, last_error child_unavailable). Leaving such a row out
  // of the chat's listing meant nothing called ensureChild and its cooldown retry never ran.
  // listConnections carries the active rows and the error ones in connectionsFor's own order
  // (service_id, label_slug, id), so "first wins" is unchanged.
  const connections = (await listConnections(db, { projectId, ownerContactId: null }))
    .filter((c) => c.status === "active" || listableConnection(c));
  for (const conn of connections) {
    if (onlyUuids && !onlyUuids.has(conn.uuid)) continue;
    // Same two gates as children.js listedTools, checked before it so a refused connection costs
    // no cache read. Either one failing means the connection contributes nothing.
    if (!connectionBindingOk(conn, { crowHome })) continue;
    if (isSensitiveConnection(conn, { crowHome })) continue;
    const cached = await listedTools(db, conn.uuid, { crowHome });
    if (!cached) continue;

    const block = blockNameFor(conn.serviceId, conn.accountLabel);
    for (const tool of cached) {
      const name = `mcp__${block}__${tool.name}`;
      if (name.length > SERVICE_TOOL_NAME_MAX) {
        if (!warnedLongNames.has(name)) {
          warnedLongNames.add(name);
          console.warn(`[services] tool name over ${SERVICE_TOOL_NAME_MAX} characters, not advertised: ${name}`);
        }
        continue;
      }
      // A tool name with a character a model rejects (e.g. "search.repos") is skipped whole.
      if (!SERVICE_TOOL_NAME_RE.test(name)) {
        if (!warnedBadNames.has(name)) {
          warnedBadNames.add(name);
          console.warn(`[services] tool name a model rejects, not advertised: ${name}`);
        }
        continue;
      }
      // First wins: connectionsFor order is service_id, label_slug, id.
      if (route.has(name)) continue;
      route.set(name, { uuid: conn.uuid, toolName: tool.name });
      tools.push({
        name,
        description: typeof tool.description === "string" ? tool.description : "",
        inputSchema: tool.inputSchema && typeof tool.inputSchema === "object" ? tool.inputSchema : { ...DEFAULT_SCHEMA },
      });
    }
  }
  return { tools, route };
}

/** The shaped result's text items, in order (images cannot ride a chat tool result here). */
function shapeToText(shaped) {
  return (shaped.content || []).filter((item) => item && item.type === "text").map((item) => item.text).join("\n");
}

/**
 * Race a client call against its budget (and the caller's abort signal). The rejection reason is
 * CALL_TIMED_OUT for the budget, so the caller can answer with the mount's timeout copy rather
 * than the generic failure. Whatever wins, the timer and the abort listener are dropped.
 */
function withBudget(promise, timeoutMs, signal) {
  if (!(timeoutMs > 0)) return promise;
  let timer = null;
  let onAbort = null;
  const budget = new Promise((_, reject) => {
    timer = setTimeout(() => reject(CALL_TIMED_OUT), timeoutMs);
    timer.unref?.();
  });
  const aborted = signal
    ? new Promise((_, reject) => {
        if (signal.aborted) return reject(new Error("aborted"));
        onAbort = () => reject(new Error("aborted"));
        signal.addEventListener("abort", onAbort, { once: true });
      })
    : null;
  return Promise.race([promise, budget, ...(aborted ? [aborted] : [])]).finally(() => {
    if (timer) clearTimeout(timer);
    if (onAbort) signal.removeEventListener("abort", onAbort);
  });
}

/**
 * Call one listed service tool. Starts the child if needed, then shapes the raw result with the
 * values injected into that child before turning it into text.
 *
 * @param {object} db
 * @param {Map<string, {uuid: string, toolName: string}>} route the listing's route
 * @param {string} name the chat tool name
 * @param {object} args
 * @param {{crowHome?: string, lang?: string, signal?: AbortSignal, timeoutMs?: number,
 *          ensure?: Function}} opts  ensure is a test seam (defaults to ensureChild)
 * @returns {Promise<{result: string, isError: boolean}>}
 */
export async function callProjectServiceTool(db, route, name, args, {
  crowHome = resolveCrowHome(), lang = "en", signal, timeoutMs = SERVICE_CALL_TIMEOUT_MS, ensure = ensureChild,
} = {}) {
  const entry = route instanceof Map ? route.get(name) : null;
  if (!entry) return { result: "Unknown tool", isError: true };
  const { uuid, toolName } = entry;
  const fail = (code) => ({ result: loopbackErrorText(code, { lang, tool: toolName }), isError: true });

  // Re-check what the listing checked: the owner may have turned it off or private since.
  let conn = null;
  try { conn = await servableConnection(db, uuid, { allowError: true }); } catch { conn = null; }
  if (!listableConnection(conn) || !connectionBindingOk(conn, { crowHome })) return fail("not_active");
  if (isSensitiveConnection(conn, { crowHome })) return fail("private_unavailable");

  let raw;
  try {
    const { client } = await ensure(db, uuid, { crowHome });
    // The budget rides on the SDK call too, so a child that answers late is cancelled there.
    const callOpts = { timeout: timeoutMs };
    if (signal) callOpts.signal = signal;
    raw = await withBudget(client.callTool({ name: toolName, arguments: args }, undefined, callOpts), timeoutMs, signal);
  } catch (err) {
    // A call that used up its budget gets the mount's timeout copy. The SDK's own timeout is the
    // same answer; a caller's abort is not a timeout.
    const sdkTimeout = err && err.code === ErrorCode.RequestTimeout && !(signal && signal.aborted);
    if (err === CALL_TIMED_OUT || sdkTimeout) return fail("timeout");
    // The child's own error text never reaches the chat; its class gets the mount's copy.
    const code = err instanceof ChildError ? err.code : null;
    return fail(FIXED_ERRORS.has(code) ? code : "failed");
  }

  const shaped = shapeServiceResult(raw, { secrets: childSecretValues(uuid), lang, tool: toolName });
  return { result: shapeToText(shaped), isError: shaped.isError === true };
}