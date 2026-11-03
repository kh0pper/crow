/**
 * The staged-send recorder (spec §12.1): one shared function that turns a successful Gmail draft
 * tool call into a `staged_sends` row.
 *
 * Three places a bot can create a draft hook into this, and only these:
 *   - the Perch engine's `tool_execution_end` (before the tool end frame is emitted, so the hub's
 *     refetch on that frame finds the row);
 *   - a bridge channel turn (`toolCalls()`, captured before the child is closed and recorded after);
 *   - the job runner (a goal job, and a card job through the bridge's own entry point).
 * Voice (the gateway's in-process executor) is out of scope: `isDraftTool` recognises the raw
 * gateway tool name so a future hook can see such a call, but `recordDraft` only records the
 * pi-named form, so nothing here can be reached from a voice turn by accident.
 *
 * The order matters and is the whole safety story (§12.3):
 *   1. Parse `{success, data:{draft_id, thread_id}}` out of the tool RESULT. `success !== true`, no
 *      draft id, or a result that is not the tool's own JSON records nothing — the Gmail MCP server
 *      reports a provider error as `{success:false}` text, not as an MCP error, so the text is the
 *      only signal. A call pi marked `isError` never reaches here (the hooks skip it).
 *   2. Re-read the draft from the provider and hash THAT: what the operator approves has to be what
 *      Gmail holds, not what the bot says it wrote. The re-read snapshot is also what the send route
 *      re-checks later.
 *   3. Fail closed. When the credential cannot be named, the read fails, or the draft's shape is one
 *      we cannot rebuild faithfully (an attachment, a Reply-To, a bad address — see
 *      `gmail-client.js` `faithful`), the row is written with `cred_ref` NULL and a snapshot taken
 *      from the tool ARGS when the read failed at all. A null `cred_ref` is the card's
 *      "Open in Gmail to send": Crow never sends a draft it could not read and re-hash.
 *
 * Nothing here ever writes a token file path (only a `{server, role}` reference — see `cred-ref.js`),
 * and the provider's raw message is never stored: the row holds the canonical snapshot and its hash.
 *
 * Non-Perch rows notify (`Draft ready to review` / `Borrador listo para revisar`, straight to the
 * card) — a channel or job turn has no chat to push into. The Perch hook passes `notify:false`: its
 * chat card is enough. The notification carries the id, never the draft: a notification is stored,
 * shown on the dashboard and pushed to phones, so no address, subject or body may ride on it.
 *
 * A recorder failure never breaks a turn: `safeRecordDraft`/`recordDrafts` are what the hooks call,
 * and they log exactly one line — the tool name and an error code — and return.
 */
import { readFileSync } from "node:fs";
import { canonicalSnapshot } from "./canonical.js";
import { TOKEN_ENV_BY_ROLE, canonicalMcpPath, mcpAddonsPath, credRefFromWorld } from "./cred-ref.js";
import { createGmailClient } from "./gmail-client.js";
import { createStaged, findStagedByDraftId } from "./store.js";

/** The pi-named draft tools: `mcp__<server>__gmail_create_draft[_personal]` / `…threaded_reply`. */
const DRAFT_TOOL_PI = /__gmail_create_(?:draft(?:_personal)?|threaded_reply)$/;
/** The raw gateway form (the add-on / voice executor's tool name). Matched, never recorded. */
const DRAFT_TOOL_RAW = /^gmail_create_(?:draft(?:_personal)?|threaded_reply)$/;

/** The recipient/subject/body keys all three draft tools share (threaded_reply has no cc/bcc). */
const SNAPSHOT_ARGS = Object.freeze(["to", "cc", "bcc", "subject", "body"]);
/** A provider draft id: opaque, but always this alphabet (Gmail's ids are URL-safe). */
const DRAFT_ID_RE = /^[A-Za-z0-9_-]+$/;

/**
 * True for a draft tool, pi-named or raw. The raw form is matched only so a caller can RECOGNISE
 * such a call (the voice turn is out of scope for release 1) — `recordDraft` never records one.
 */
export function isDraftTool(toolName) {
  const name = String(toolName ?? "");
  return DRAFT_TOOL_PI.test(name) || DRAFT_TOOL_RAW.test(name);
}

/**
 * A tool result as text. pi hands `{content:[{type:'text',text}]}` to `tool_execution_end`; the
 * bridge and the job runner carry the same shape. A bare string is already the text.
 */
export function resultTextOf(result) {
  if (result == null) return "";
  if (typeof result === "string") return result;
  if (Array.isArray(result)) return result.map((r) => resultTextOf(r)).filter(Boolean).join("\n");
  if (typeof result === "object") {
    if (Array.isArray(result.content)) {
      return result.content.map((c) => (c && c.type === "text" && typeof c.text === "string" ? c.text : "")).filter(Boolean).join("\n");
    }
    if (typeof result.text === "string") return result.text;
  }
  return "";
}

/**
 * `{draftId, threadId}` from a draft tool's result text, or null. The WHOLE trimmed text must parse
 * to the tool's own `{success, data:{draft_id, thread_id}}` JSON: no brace-slicing, because a draft
 * id quoted inside wrapped or echoed text is a forged id, not a draft this turn made. A `draft_id`
 * that is not a non-empty `[A-Za-z0-9_-]` string is equally not ours, and `success !== true` is a
 * provider error — both record nothing.
 */
export function parseDraftResult(text) {
  const raw = String(text ?? "").trim();
  if (!raw) return null;
  let body = null;
  try { body = JSON.parse(raw); } catch { return null; }
  if (!body || typeof body !== "object" || body.success !== true) return null;
  const data = body.data && typeof body.data === "object" ? body.data : {};
  if (typeof data.draft_id !== "string" || !DRAFT_ID_RE.test(data.draft_id)) return null;
  return {
    draftId: data.draft_id,
    threadId: data.thread_id == null ? null : String(data.thread_id),
  };
}

/** The snapshot a draft call's own args describe — the fallback when the provider cannot be read. */
export function snapshotFromArgs(args) {
  const a = args && typeof args === "object" ? args : {};
  const picked = {};
  for (const key of SNAPSHOT_ARGS) picked[key] = a[key];
  return canonicalSnapshot(picked);
}

/* ---------------------------------------------------------- credential config */

/**
 * An MCP config reduced to what naming a credential needs: which servers exist and whether each
 * carries the primary/personal token env key. The values are `"1"`, never the paths — `cred-ref.js`
 * re-resolves the file from operator config at send time, so a session never holds a token location.
 *
 * Accepts both config shapes `credRefFromWorld` does (`{mcpServers:{…}}` and a flat map).
 */
export function redactMcpConfig(mcpConfig) {
  const servers = {};
  if (!mcpConfig || typeof mcpConfig !== "object") return { mcpServers: servers };
  const map = mcpConfig.mcpServers && typeof mcpConfig.mcpServers === "object" ? mcpConfig.mcpServers : mcpConfig;
  for (const [server, block] of Object.entries(map)) {
    if (!block || typeof block !== "object" || block.disabled) continue;
    const env = block.env;
    if (!env || typeof env !== "object") continue;
    const redacted = {};
    for (const key of Object.values(TOKEN_ENV_BY_ROLE)) {
      if (typeof env[key] === "string" && env[key].trim()) redacted[key] = "1";
    }
    if (Object.keys(redacted).length) servers[server] = { env: redacted };
  }
  return { mcpServers: servers };
}

/**
 * The same redacted view of the OPERATOR's own config (the canonical pi `mcp.json` plus this
 * instance's `mcp-addons.json`) — the fallback for a caller that never held a world config (a card
 * job's turn is built inside the bridge). Operator-owned files only; a bot cannot write either.
 */
export function credConfigFromOperatorConfig(paths = {}) {
  const servers = {};
  for (const path of [paths.canonical || canonicalMcpPath(), paths.addons || mcpAddonsPath()]) {
    let json = null;
    try { json = JSON.parse(readFileSync(path, "utf8")); } catch { continue; }
    const redacted = redactMcpConfig(json).mcpServers;
    for (const [server, block] of Object.entries(redacted)) {
      const merged = servers[server] || (servers[server] = { env: {} });
      Object.assign(merged.env, block.env);
    }
  }
  return { mcpServers: servers };
}

/* -------------------------------------------------------------- notification */

/** The dashboard's language setting (`Settings › Language`), defaulting to English. */
async function readLang(db, hint) {
  if (hint === "en" || hint === "es") return hint;
  try {
    const { rows } = await db.execute({ sql: "SELECT value FROM dashboard_settings WHERE key = 'language'", args: [] });
    const value = rows[0] ? String(rows[0].value) : "";
    return value === "es" ? "es" : "en";
  } catch { return "en"; }
}

/**
 * The "Draft ready to review" notification a non-Perch row raises: title and a link to the card,
 * and nothing else. `body` is deliberately null (the push channel falls back to the title) and
 * `metadata` carries the row id only.
 */
async function notifyDraftReady(db, id, lang) {
  const [{ createNotification }, { t }] = await Promise.all([
    import("../../shared/notifications.js"),
    import("../dashboard/shared/i18n.js"),
  ]);
  await createNotification(db, {
    title: t("staged.notify.title", await readLang(db, lang)),
    body: null,
    type: "attention",
    source: "staged-sends",
    priority: "normal",
    action_url: "/dashboard/staged/" + encodeURIComponent(id),
    metadata: { staged_id: id, channel: "gmail" },
  });
}

/* ------------------------------------------------------------------- record */

/**
 * A better-sqlite3 connection as the async client surface the store and the notification helper
 * use (`{execute({sql, args})}`). The bridge and the job runner are better-sqlite3 processes and
 * must NOT open a second, WAL-flipping libsql connection to the same crow.db, so the recorder
 * takes an adapter over their existing connection instead.
 */
export function betterSqliteDb(conn) {
  if (!conn) throw new Error("staged recorder: no database");
  if (typeof conn.execute === "function") return conn;
  return {
    async execute({ sql, args = [] } = {}) {
      const stmt = conn.prepare(String(sql));
      if (stmt.reader) return { rows: stmt.all(...args), rowsAffected: 0 };
      const info = stmt.run(...args);
      return { rows: [], rowsAffected: info.changes, lastInsertRowid: info.lastInsertRowid };
    },
  };
}

/**
 * Record one successful draft tool call as a staged row. Returns
 * `{id, credRef, openInGmail, reason}` (or null when the call recorded nothing), where `openInGmail`
 * true / `credRef` null is the card's "Open in Gmail to send". A replay of a draft that already has
 * a row (a resumed turn, a duplicate end event) records nothing and returns null.
 *
 * `context`:
 *   channel        default "gmail"
 *   sessionId / threadId / botId / cardId / jobId   provenance columns
 *   credConfig     the redacted MCP config to name the credential from (default: the operator's)
 *   tainted        written through unchanged (the hooks decide; see their comments)
 *   notify         true for a non-Perch row (bridge, job); the Perch card needs no push
 *   lang           "en" | "es"; otherwise the dashboard setting decides
 *   fetchImpl / configPaths   Gmail client seams (tests)
 *   log            read by `recordDrafts` (its one failure line); not used here
 */
export async function recordDraft({ db, toolName, args = null, resultText = null, context = {} } = {}) {
  // Pi-named only: the raw gateway form is a voice/executor call, out of scope (see the header).
  if (!DRAFT_TOOL_PI.test(String(toolName ?? ""))) return null;
  const parsed = parseDraftResult(resultTextOf(resultText));
  if (!parsed) return null;

  const toolArgs = args && typeof args === "object" ? args : {};
  // `undefined` means "name it from the operator's own config"; a caller that passes an explicit
  // config (a test, a world) is honored as is, including one with no server in it at all.
  const credConfig = context.credConfig !== undefined ? context.credConfig : credConfigFromOperatorConfig();
  const credRef = credRefFromWorld(credConfig, toolName);

  // Idempotency first, before any Gmail read: the draft id under the credential we would use (or a
  // row for it that ended with none) IS this draft. Checking after the read let a replay whose read
  // came out differently add a second row; checking here also saves the read. Every state counts,
  // so a draft the operator already sent or discarded never comes back as a second card.
  if (await findStagedByDraftId(db, { providerDraftId: parsed.draftId, credRef, orUnreadable: true })) return null;

  // Step 2, fail closed: the provider's draft is the snapshot, unless we cannot read it.
  let snapshot = snapshotFromArgs(toolArgs);
  let providerThreadId = parsed.threadId;
  let storedCredRef = credRef;
  let reason = credRef ? null : "no_credential";
  if (credRef) {
    try {
      const client = createGmailClient({ credRef, fetchImpl: context.fetchImpl, configPaths: context.configPaths });
      const draft = await client.getDraft(parsed.draftId);
      if (draft.threadId) providerThreadId = draft.threadId;
      if (draft.faithful === false) {
        // Readable but not representable (an attachment, a Reply-To, …): the operator sends it from
        // Gmail. The read DID succeed, so its snapshot is the honest thing to show.
        snapshot = draft.snapshot;
        storedCredRef = null;
        reason = draft.reason || "unfaithful";
      } else {
        snapshot = draft.snapshot;
      }
    } catch (e) {
      // No credential we can read (the public workspace-mcp keeps its token where Crow cannot see
      // it), a gone draft, a provider error: the args describe what the bot intended, and a null
      // cred_ref means this row is never sent by Crow.
      snapshot = snapshotFromArgs(toolArgs);
      storedCredRef = null;
      reason = e && typeof e.code === "string" ? e.code : "unreadable";
    }
  }

  // A row for the same draft written while this one read Gmail (two paths racing) is caught here.
  if (await findStagedByDraftId(db, { providerDraftId: parsed.draftId, credRef: storedCredRef, orUnreadable: true })) return null;

  // Step 3: one row. new_recipients stays null (the card's "new recipient" hint is filled lazily by
  // the reader that builds the card, never here).
  const id = await createStaged(db, {
    sessionId: context.sessionId ?? null,
    threadId: context.threadId ?? null,
    botId: context.botId ?? null,
    cardId: context.cardId ?? null,
    jobId: context.jobId ?? null,
    channel: context.channel || "gmail",
    credRef: storedCredRef,
    providerDraftId: parsed.draftId,
    providerThreadId,
    snapshot,
    tainted: context.tainted === true,
    newRecipients: null,
  });

  if (context.notify === true) {
    // A side channel: a failed notification must never lose the row.
    try { await notifyDraftReady(db, id, context.lang); } catch { /* the card is still there */ }
  }
  return { id, credRef: storedCredRef, openInGmail: storedCredRef == null, reason };
}

/**
 * `recordDraft` for each draft call in a turn's `toolCalls()` list (the bridge and job shape:
 * `{tool, isError, args, result}`). An errored call made no draft, so it is skipped. Stops nothing on
 * a failure — each call is recorded on its own and a failure is logged by `safeRecordDraft` through
 * the caller's own `log` (the `context.log` the hooks pass). Returns the rows actually written.
 */
export async function recordDrafts(db, calls, context = {}) {
  const written = [];
  const log = typeof context.log === "function" ? context.log : null;
  for (const call of Array.isArray(calls) ? calls : []) {
    if (!call || call.isError === true || !DRAFT_TOOL_PI.test(String(call.tool ?? ""))) continue;
    const r = await safeRecordDraft({ db, log, toolName: call.tool, args: call.args ?? null, resultText: call.result ?? null, context });
    if (r) written.push(r);
  }
  return written;
}

/**
 * `recordDraft` that cannot break a turn. A failure is ONE log line: the tool name and an error
 * code, never an args or result value (those carry the draft's recipients and text).
 */
export async function safeRecordDraft({ log = null, ...rest } = {}) {
  try {
    return await recordDraft(rest);
  } catch (e) {
    const code = e && typeof e.code === "string" ? e.code : "error";
    const line = "staged draft not recorded (" + String(rest.toolName ?? "?") + "): " + code;
    try {
      if (typeof log === "function") log(line);
      else console.error("[staged] " + line);
    } catch { /* a broken logger must not break the turn either */ }
    return null;
  }
}