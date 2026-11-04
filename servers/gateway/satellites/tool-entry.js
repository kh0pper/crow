/**
 * Satellite tool entries (SAT-7, spec §5.3, §9.1, §9.2): one `connectedServers` entry per
 * satellite-hosted bundle, appended AFTER every local source so a name clash always keeps the
 * local tool. `entry.tools` holds only the names that pass the bundle's prefix rule AND belong
 * to the owner-approved pin, so every reader of `entry.tools` (/tools via proxy.js,
 * router.js's walks, ai/tool-executor, getChatTools) sees the same list.
 *
 * `entry.client.callTool` is the one wrapper every consumer calls. In order:
 *   1. a caller context must exist and be the owner or a bot — no store, a peer or a cross-host
 *      call is refused BEFORE any network work (fails closed for every path that sets none);
 *   2. the satellite's last reported tools hash must still equal the pin and the name must be in
 *      the approved list (a change disables the bundle's calls until the owner approves);
 *   3. revoked / not active → "not available here"; unreachable → "… is unreachable (since …)";
 *   4. one signed POST /satellite/v1/mcp/<bundle> with X-Crow-Sat-Caller = the caller;
 *   5. the answer is text-only and ≤ 256 KiB serialized;
 *   6. anything thrown or malformed → "<tool> failed." (upstream text is never echoed).
 *
 * The entry is built and refreshed by `refreshSatelliteEntries` (gateway boot, and after every
 * status poll — a pin that was just approved becomes callable without waiting for a restart).
 */
import { createDbClient } from "../../db.js";
import { RESULT_CAP_BYTES } from "../../shared/satellite-protocol.js";
import { currentCaller } from "../caller-context.js";
import { satelliteFetch } from "./client.js";
import { BUNDLE_ID_RE, installPaths, satelliteInstalls } from "./installs.js";
import { getSatellite, getToolPin } from "./store.js";
import { hhmm, reportedTools, toolNameRe, toolsState } from "./tools-pin.js";

/** D22: CLEAN_MCP_TOOLS is an exact-name match on `mcp__artifacts__*`, so this key is refused. */
export const RESERVED_BUNDLE_IDS = Object.freeze(["artifacts"]);

/** The caller strings the satellite signs for (§5.1): a named bot, or the owner. */
const ALLOWED_CALLERS = (c) => c === "owner-local" || c === "owner-remote" || /^bot:[A-Za-z0-9._-]{1,64}$/.test(String(c || ""));

const text = (t) => ({ content: [{ type: "text", text: t }] });
const refusal = (t) => ({ ...text(t), isError: true });

export const notAvailableFor = (tool) => refusal(`${tool || "This tool"} is not available here.`);
/** The pin refusal, with the loopback mount's own code (helper spec §5's `tools_changed`), so a bot
 *  reading it through `/satellite-tools/.../mcp` gets that fixed sentence and its audit event. */
export const toolsChangedResult = () => ({ ...refusal("These tools changed; approve them on the Servers page."), code: "tools_changed" });
export const failedFor = (tool) => refusal(`${tool || "That tool"} failed.`);

/** A satellite entry may carry this bundle id (never `artifacts`; a real bundle id only). */
export function satelliteEntryAllowed(bundle) {
  return BUNDLE_ID_RE.test(String(bundle)) && !RESERVED_BUNDLE_IDS.includes(String(bundle));
}

// ── the servers map this module maintains ──────────────────────────────────────────────────────
// proxy.js binds its connectedServers once at load; every function here takes an explicit
// `servers` override so a test never has to touch the process-wide map.
let serversMap = null;
export function bindSatelliteServers(map) { serversMap = map || null; }

/** [id, entry] pairs, every non-satellite source before any satellite one (insertion order kept). */
export function localFirst(servers) {
  const map = servers || serversMap;
  if (!map) return [];
  const local = [];
  const satellite = [];
  for (const pair of map) (pair[1]?.isSatellite ? satellite : local).push(pair);
  return [...local, ...satellite];
}

/** A satellite source is never shown to a peer caller (§9.2). */
export function satelliteVisible(entry) {
  return !(entry?.isSatellite === true && currentCaller()?.peer === true);
}

// ── the published tool list ───────────────────────────────────────────────────────────────────

/**
 * The tools a satellite bundle may publish: the approved pin's tools, re-checked against the
 * prefix rule. No pin, or a status entry with no sha256 (tools could not be cached), means no
 * tools — never the satellite's own list.
 */
export function publishedTools(bundle, pin, reported) {
  if (!pin || !reported || typeof reported.sha256 !== "string" || !reported.sha256) return [];
  let list;
  try { list = JSON.parse(pin.tools_json); } catch { return []; }
  const re = toolNameRe(bundle);
  const seen = new Set();
  const out = [];
  for (const t of Array.isArray(list) ? list : []) {
    const name = typeof t?.name === "string" ? t.name : "";
    if (!re.test(name) || seen.has(name)) continue;
    seen.add(name);
    out.push({
      name,
      description: typeof t.description === "string" ? t.description : "",
      inputSchema: t.inputSchema && typeof t.inputSchema === "object" ? t.inputSchema : { type: "object", properties: {} },
    });
  }
  return out;
}

// ── the client every consumer calls ──────────────────────────────────────────────────────────

let rpcSeq = 1;

/**
 * The `entry.client` of a satellite bundle. `entry` is read for its (refreshable) satelliteId.
 * Deps are injectable for tests: dbFactory, fetchImpl, env, timeoutMs. `closeDb` is false when the
 * factory hands out a client the caller owns (a test's fixture db), so a call never closes it.
 */
export function createSatelliteToolClient({ bundle, entry, dbFactory = createDbClient, closeDb = true, fetchImpl = globalThis.fetch, env = process.env, timeoutMs, log = (m) => console.warn(m) }) {
  async function loadState(satelliteId) {
    const db = dbFactory();
    try {
      const sat = await getSatellite(db, satelliteId);
      const pin = sat ? await getToolPin(db, satelliteId, bundle) : null;
      return { sat, pin };
    } finally { if (closeDb) { try { db?.close?.(); } catch { /* best effort */ } } }
  }

  async function callTool(params = {}) {
    const name = typeof params?.name === "string" ? params.name : "";
    try {
      // 1. Who is calling (§9.2). Every other path — no ALS store, a peer instance, a cross-host
      // request, an unknown caller — is refused before any DB or network work.
      const ctx = currentCaller();
      if (!ctx || ctx.peer === true || ctx.crossHost === true || !ALLOWED_CALLERS(ctx.caller)) {
        return notAvailableFor(name);
      }

      // 2./3. Live state: revoked / unreachable / the pin hash, and the approved name list.
      const { sat, pin } = await loadState(entry.satelliteId);
      if (!sat) return notAvailableFor(name);
      const state = toolsState(sat, bundle, pin);
      if (state.state === "revoked") return notAvailableFor(name);
      if (state.state === "unreachable") {
        const since = state.since ? hhmm(state.since) : "?";
        return refusal(`${sat.name || "The server"} is unreachable (since ${since}).`);
      }
      if (state.state !== "ok") return toolsChangedResult();
      if (!publishedTools(bundle, pin, reportedTools(sat, bundle)).some((t) => t.name === name)) {
        return toolsChangedResult();
      }

      // 4. One signed tools/call. satelliteFetch signs X-Crow-Sat-Caller from `caller`.
      const r = await satelliteFetch(sat, {
        method: "POST",
        path: `/satellite/v1/mcp/${bundle}`,
        body: { jsonrpc: "2.0", id: rpcSeq++, method: "tools/call", params: { name, arguments: params?.arguments ?? {} } },
        caller: ctx.caller,
        maxBytes: RESULT_CAP_BYTES + 4096,
        fetchImpl,
        env,
        ...(timeoutMs ? { timeoutMs } : {}),
      });
      const result = r?.json?.result;
      if (r?.status !== 200 || !result || typeof result !== "object" || r?.json?.error) return failedFor(name);

      // 5. Text only, then the cap over the serialized answer (spec §9.1).
      const kept = [];
      let dropped = 0;
      for (const item of Array.isArray(result.content) ? result.content : []) {
        if (item && item.type === "text" && typeof item.text === "string") kept.push({ type: "text", text: item.text });
        else dropped++;
      }
      if (dropped) kept.push({ type: "text", text: `(${dropped} non-text item${dropped === 1 ? "" : "s"} dropped)` });
      const shaped = result.isError === true ? { content: kept, isError: true } : { content: kept };
      const bytes = Buffer.byteLength(JSON.stringify(shaped), "utf8");
      if (bytes > RESULT_CAP_BYTES) return refusal(`result too large (${Math.ceil(bytes / 1024)} KiB)`);
      return shaped;
    } catch (err) {
      // 6. Never the upstream text: a thrown fetch, a bad signature or a malformed answer.
      log(`[satellites] ${bundle}/${name || "?"}: ${err?.code || err?.message || "failed"}`);
      return failedFor(name);
    }
  }

  return { callTool, close() { /* nothing to close: one stateless request per call */ } };
}

// ── building and refreshing the entries ─────────────────────────────────────────────────────

const logged = new Set();
function noteOnce(key, message, log) {
  if (logged.has(key)) return;
  logged.add(key);
  log(message);
}

/**
 * Reconcile the satellite entries in `servers` with installed.json + the pins in `db`.
 * Entries are created once and then refreshed in place, so an existing client (with its deps)
 * is reused and every reader keeps seeing the same entry object. Never throws on one bundle.
 *
 * `dbFactory` is a test seam: a supplied factory is used for the client's own state reads and its
 * clients are the caller's (never closed here). Without one, every call opens and closes its own
 * client, so a client created during a status poll never borrows the poller's db.
 */
export async function refreshSatelliteEntries({
  db = null, dbFactory = null, servers = null, paths = installPaths(),
  fetchImpl = globalThis.fetch, env = process.env, log = (m) => console.warn(m),
} = {}) {
  const map = servers || serversMap;
  if (!map) return { bundles: 0 };
  let recs;
  try { recs = satelliteInstalls(paths); } catch (err) { log(`[satellites] installed.json unreadable: ${err.message}`); return { bundles: 0 }; }
  if (!recs.length) {
    // Nothing hosted anymore: drop every satellite entry (an uninstall or an unpair).
    for (const [id, e] of [...map]) if (e?.isSatellite) map.delete(id);
    return { bundles: 0 };
  }

  const ownDb = db || (dbFactory || createDbClient)();
  const closeAfter = !db;
  const clientDbFactory = dbFactory || createDbClient;
  const clientCloseDb = !dbFactory;
  let n = 0;
  try {
    for (const rec of recs) {
      const id = String(rec?.id || "");
      // D22: `artifacts` is an exact-name allow list in outside-text-tools.mjs — no entry, ever.
      if (!satelliteEntryAllowed(id)) {
        noteOnce(`bad:${id}`, `[satellites] bundle id ${JSON.stringify(id)} is never exposed as satellite tools (reserved name)`, log);
        continue;
      }
      const existing = map.get(id);
      // One host per bundle id is enforced at install; a local source still always wins.
      if (existing && !existing.isSatellite) continue;
      let sat = null;
      let pin = null;
      try {
        sat = await getSatellite(ownDb, rec.host);
        pin = await getToolPin(ownDb, rec.host, id);
      } catch (err) {
        log(`[satellites] ${id}: ${err.message}`);
        continue;
      }
      const entry = existing || {
        client: null, tools: [], status: "connected", isRemote: false, isSatellite: true, satelliteId: rec.host,
      };
      entry.satelliteId = rec.host;
      entry.tools = publishedTools(id, pin, sat ? reportedTools(sat, id) : null);
      if (!entry.client) {
        entry.client = createSatelliteToolClient({ bundle: id, entry, dbFactory: clientDbFactory, closeDb: clientCloseDb, fetchImpl, env, log });
      }
      if (!existing) map.set(id, entry);
      n += 1;
    }
    // Drop entries whose install record went away (uninstall / unpair), even while others remain.
    const ids = new Set(recs.map((r) => String(r?.id || "")));
    for (const [id, e] of [...map]) if (e?.isSatellite && !ids.has(id)) map.delete(id);
  } finally {
    if (closeAfter) { try { ownDb?.close?.(); } catch { /* best effort */ } }
  }
  return { bundles: n };
}