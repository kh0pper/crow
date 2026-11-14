// Project-share scope (Phase 1): what a bot may call, on which project, and the one refusal
// vocabulary every project server shares.
//
// Three servers register project tools — the projects server (`createProjectServer`), the memory
// server (`createMemoryServer`) and the storage server (`createStorageServer`). A share covers
// exactly four families of those tools (workspace files, memories, notes, sources); every other
// tool that acts on a project is refused for a bot. So every registered tool name is placed in
// exactly one of five frozen collections below, and the coverage test fails on any name it does
// not find (or finds twice):
//
//   TOOL_CLASS             a family tool, classed "read" or "write"
//   HOME_ONLY_TOOLS        acts on a named project, outside the four families
//   SCOPED_LISTING_TOOLS   takes no project but reads across projects (names, counts, previews)
//   OWNER_ONLY_TOOLS       refused for any bot, shares or not
//   PROJECT_NEUTRAL_TOOLS  touches no project-scoped row at all (instance-wide or no rows)
//
// One name is in a sixth, narrower list: `crow_list_context_sections` is a scoped listing that
// also takes a `project_id` filter (SCOPED_LISTING_PROJECT_TOOLS). A listing is not one of the four
// families a share covers, so a bot naming any project but its own is refused `home_only` there.
//
// `crow_dream` is the one name in two entries: with `dry_run` true it is a cross-project report
// (SCOPED_LISTING_TOOLS), with it false it can update or delete memories (OWNER_ONLY_TOOLS).
// `toolPolicyFor(tool, args)` resolves that per call; the collections stay the static inventory.
//
// The rules the decision functions implement:
//   - The operator's own voice bot (`crow.voice`) is the operator: every rule here treats it like
//     a non-bot actor — but only when the actor is the frozen one `operatorVoiceActor()` builds, the
//     marker carrying `operatorVoice: true`. An id is a claim, not a credential: the same id arriving
//     from a pi bot session (the engine's marker, carried on the actor as `botSession`), from a
//     per-call `_meta`/header, or from a process env gets no exemption and is an ordinary bound bot.
//   - An unverified bot (marker present, no bot identity) is refused everything, code `owner_only`.
//   - A HOME_ONLY call with no `project_id` means the bot's HOME project; never the global or the
//     device scope. A bot naming `device_id` is refused `owner_only`.
//   - A covered read with no `project_id` is scoped to the home project and nothing else
//     (`botReadScope`): project-less rows are never included. A covered write with no `project_id`
//     lands in the home project (`botWriteProject`); a bot with NO home project is refused
//     `home_only` with NAME_A_PROJECT_MESSAGE, so a write is never allowed with no project.
//   - By-id tools resolve the row's own `project_id` first (`decideRowAccess`); every refusal
//     there is reported as the message a missing id gets, so a hidden row and a missing row read
//     the same. `auditRefusal` records the true code.
//
// Shares are resolved on every call through `resolveBotAccess` (project-bot-shares.js); nothing
// here caches. See the private engineering notes for the Phase 1 share design.

import { appendAudit } from "./project-acl.js";
import { resolveBotAccess } from "./project-bot-shares.js";
import { CROW_VOICE_BOT_ID } from "./voice-bot.js";
import { UNKNOWN, auditActor, resolveCallActor } from "../research/actor.js";

/** The message a missing id and a hidden row both get: they must be indistinguishable. */
export const NOT_FOUND_MESSAGE = "Not found.";

/** Every refusal message is a fixed string: it never carries a project name or content. */
const REFUSAL_MESSAGES = Object.freeze({
  no_share: "No share grants this bot access to that project.",
  read_only: "This bot's share of that project is read-only.",
  suspended: "This bot's share of that project is suspended while a project has an outside member.",
  home_only: "That tool is for the bot's own project only.",
  owner_only: "That tool is for the operator only.",
});

/** A bot write with no project and no home project of its own. */
export const NAME_A_PROJECT_MESSAGE = "Name a project: this bot has no project of its own.";

export class ShareRefusal extends Error {
  constructor(code) {
    const known = Object.prototype.hasOwnProperty.call(REFUSAL_MESSAGES, code);
    super(known ? REFUSAL_MESSAGES[code] : REFUSAL_MESSAGES.owner_only);
    this.name = "ShareRefusal";
    this.code = known ? code : "owner_only";
  }
}

/** The tool-result shape the project tools already return for an ACL error. */
export function refusalResult(message) {
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

/** The result for a row the caller may not see: exactly what a missing id gets. */
export function notFoundResult() {
  return refusalResult(NOT_FOUND_MESSAGE);
}

const read = (family) => Object.freeze({ family, class: "read" });
const write = (family) => Object.freeze({ family, class: "write" });

/**
 * The four families a share covers: every one is classed here, read or write. A family tool
 * missing from this table is treated as "unlisted" at runtime (denied for a bot).
 */
export const TOOL_CLASS = Object.freeze({
  // workspace files
  crow_workspace_dir: read("file"),
  crow_list_files: read("file"),
  crow_get_file_url: read("file"),
  crow_upload_file: write("file"),
  crow_delete_file: write("file"),
  // memories
  crow_search_memories: read("memory"),
  crow_recall_by_context: read("memory"),
  crow_deep_recall: read("memory"),
  crow_list_memories: read("memory"),
  crow_get_memory: read("memory"),
  crow_store_memory: write("memory"),
  crow_update_memory: write("memory"),
  crow_delete_memory: write("memory"),
  // notes
  crow_search_notes: read("note"),
  crow_add_note: write("note"),
  crow_withdraw_note: write("note"),
  // sources
  crow_search_sources: read("source"),
  crow_list_sources: read("source"),
  crow_get_source: read("source"),
  crow_generate_bibliography: read("source"),
  crow_add_source: write("source"),
  crow_fetch_source: write("source"),
  crow_verify_source: write("source"),
});

/** Project tools outside the four families: refused for a bot on any project but its home. */
export const HOME_ONLY_TOOLS = Object.freeze([
  "crow_update_project",
  "crow_project_get",
  "crow_project_capabilities",
  "crow_list_members",
  "crow_add_member",
  "crow_remove_member",
  "crow_audit_log",
  "crow_register_backend",
  "crow_list_backends",
  "crow_remove_backend",
  "crow_backend_schema",
  "crow_get_context",
  "crow_update_context_section",
  "crow_add_context_section",
  "crow_delete_context_section",
]);

/**
 * Tools that take no project but read across projects. For a bot: the home project plus projects
 * it holds a live, non-suspended share to (listing names and levels), the home project only
 * (content previews and counts).
 */
export const SCOPED_LISTING_TOOLS = Object.freeze([
  "crow_list_projects",
  "crow_project_stats",
  "crow_memory_stats",
  "crow_storage_stats",
  "crow_list_context_sections",
  "crow_dream",
]);

/**
 * The listed tools that also take a `project_id` filter: the ones a bot could otherwise use to
 * read a shared project's row names, which no share covers.
 */
export const SCOPED_LISTING_PROJECT_TOOLS = Object.freeze([
  "crow_list_context_sections",
]);

/**
 * Refused for any bot actor regardless of shares (crow_dream only when it may mutate; the voice bot
 * is exempt because the bot rules never bind it).
 *
 * The three schedule tools are here because the schedules table has no project column: a schedule
 * belongs to this instance, not to a project, so there is nothing to scope it to — home-only would
 * have let a bot manage the operator's whole schedule list.
 *
 * The notification tools are here because notification text carries other projects' names and card
 * titles, and dismissing one clears the operator's own alerts. `crow_notification_settings` belongs
 * here too: its `set` action rewrites instance-wide notification preferences, so a bot could
 * silence the operator's alerts.
 */
export const OWNER_ONLY_TOOLS = Object.freeze([
  "crow_create_project",
  "crow_regenerate_embeddings",
  "crow_dream",
  "crow_create_schedule",
  "crow_list_schedules",
  "crow_update_schedule",
  "crow_check_notifications",
  "crow_dismiss_notification",
  "crow_dismiss_all_notifications",
  "crow_notification_settings",
]);

/**
 * Five project-neutral tools, listed so that no existing bot silently loses them: they touch no
 * project-scoped row (backgrounds are instance-wide, web search writes nothing). Reading,
 * dismissing or re-configuring a notification is NOT neutral — see OWNER_ONLY_TOOLS.
 */
export const PROJECT_NEUTRAL_TOOLS = Object.freeze([
  "crow_web_search",
  // Sending a notification is a message to the operator, never a read of another project's rows.
  "crow_create_notification",
  "crow_generate_background",
  "crow_list_backgrounds",
  "crow_set_background",
]);

const HOME_ONLY = new Set(HOME_ONLY_TOOLS);
const SCOPED_LISTING = new Set(SCOPED_LISTING_TOOLS);
const SCOPED_LISTING_PROJECT = new Set(SCOPED_LISTING_PROJECT_TOOLS);
const OWNER_ONLY = new Set(OWNER_ONLY_TOOLS);
const NEUTRAL = new Set(PROJECT_NEUTRAL_TOOLS);

/** The per-call classification of one tool name, or null for a name no collection covers. */
export function toolPolicyFor(tool, args = {}) {
  const name = String(tool);
  if (name === "crow_dream") {
    return args && args.dry_run === false
      ? Object.freeze({ kind: "owner_only", family: "memory" })
      : Object.freeze({ kind: "scoped_listing", family: "memory" });
  }
  const cls = TOOL_CLASS[name];
  if (cls) return Object.freeze({ kind: cls.class, family: cls.family });
  if (HOME_ONLY.has(name)) return Object.freeze({ kind: "home_only", family: null });
  if (SCOPED_LISTING.has(name)) return Object.freeze({ kind: "scoped_listing", family: null });
  if (OWNER_ONLY.has(name)) return Object.freeze({ kind: "owner_only", family: null });
  if (NEUTRAL.has(name)) return Object.freeze({ kind: "neutral", family: null });
  return null;
}

const isBot = (actor) => !!(actor && actor.kind === "bot");

/**
 * The one actor that keeps operator scope on the operator's voice bot: frozen, and marked. Only the
 * in-process voice executor may use it as its construction-time base actor; nothing a caller can
 * send (a `_meta` actor, an `x-crow-actor-*` header, a process env) carries the marker, and
 * `resolveCallActor` rebuilds a bot actor from kind and id alone. A bot turn on the pi engine gets
 * the same id without the marker, so it is bound by the bot rules like any other bot.
 */
const OPERATOR_VOICE_ACTOR = Object.freeze({ kind: "bot", id: CROW_VOICE_BOT_ID, operatorVoice: true });

/** The operator-voice base actor: frozen, so `Object.isFrozen` gates the marker. */
export function operatorVoiceActor() {
  return OPERATOR_VOICE_ACTOR;
}

/**
 * Is this the operator's own voice executor? Only the frozen factory actor qualifies: the id alone,
 * a copy carrying the flag, or the same id from a pi bot session is an ordinary bound bot.
 */
export function isOperatorVoice(actor) {
  return !!(
    actor &&
    actor.kind === "bot" &&
    actor.id === CROW_VOICE_BOT_ID &&
    actor.operatorVoice === true &&
    Object.isFrozen(actor) &&
    !actor.botSession
  );
}

/** Everything below a bot: any bot actor the bot rules bind (the voice bot is not one). */
const boundByBotRules = (actor) => isBot(actor) && !isOperatorVoice(actor);

const deny = (code) => {
  const refusal = new ShareRefusal(code);
  return { allowed: false, code: refusal.code, message: refusal.message };
};

const asId = (value) => {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const deviceNamed = (value) => typeof value === "string" && value.trim() !== "";

/**
 * The bot's home project id, or null: a bot whose definition is gone, or whose project is archived
 * or tombstoned, has no home (`resolveBotAccess` reads the same way).
 */
async function homeProjectId(db, botId) {
  if (botId == null || botId === "") return null;
  const { rows } = await db.execute({
    sql: `SELECT p.id AS id FROM pi_bot_defs d JOIN project_spaces p ON p.id = d.project_id
           WHERE d.bot_id = ? AND p.archived_at IS NULL
             AND (p.status IS NULL OR p.status != 'archived') LIMIT 1`,
    args: [String(botId)],
  });
  return rows[0] && rows[0].id != null ? Number(rows[0].id) : null;
}

/**
 * May this actor call `tool` against `projectId`?
 *
 * Non-bot actors (owner, unknown, operator clients) are always allowed: nothing changes for them.
 * For a bot: an unverified bot is refused `owner_only`, as is a call naming `device_id`;
 * `OWNER_ONLY_TOOLS` (and any unlisted name) are refused `owner_only`; no project is allowed for a
 * covered tool, a `PROJECT_NEUTRAL_TOOLS` or a `SCOPED_LISTING_TOOLS` entry, and for a HOME_ONLY
 * tool only when the bot has a home project. A covered WRITE with no project needs a project to
 * land in, so a bot with no home project is refused `home_only` with NAME_A_PROJECT_MESSAGE (a
 * read with no project still passes, and scopes itself through `botReadScope`); a named project is
 * allowed when it is the home project, refused `home_only` for a HOME_ONLY tool and for a
 * `SCOPED_LISTING_PROJECT_TOOLS` entry, and otherwise decided by `resolveBotAccess`.
 *
 * `args` is the call's own arguments (only `dry_run` is read: it picks which of `crow_dream`'s two
 * entries applies); `deviceId` is the call's `device_id`.
 *
 * @returns {Promise<{allowed: true, projectId: number|null} | {allowed: false, code: string, message: string}>}
 */
export async function decideProjectAccess(db, actor, { tool, projectId, args = {}, deviceId = null } = {}) {
  const requested = asId(projectId);
  if (!boundByBotRules(actor)) return { allowed: true, projectId: requested };

  if (actor.unverified) return deny("owner_only");
  if (deviceNamed(deviceId)) return deny("owner_only");

  const policy = toolPolicyFor(tool, args);
  if (!policy || policy.kind === "owner_only") return deny("owner_only");

  const home = await homeProjectId(db, actor.id);

  if (requested == null) {
    if (home == null && policy.kind === "home_only") return deny("home_only");
    // A write must land in a real project: the home project, or a refusal. Passing
    // `{projectId: null}` would hand a handler a write it cannot scope (`botWriteProject` refuses
    // the same call), so the gate refuses here with the code the audit log knows.
    if (home == null && policy.kind === "write") {
      return { allowed: false, code: "home_only", message: NAME_A_PROJECT_MESSAGE };
    }
    return { allowed: true, projectId: home };
  }

  if (home != null && home === requested) return { allowed: true, projectId: requested };
  if (policy.kind === "home_only") return deny("home_only");
  if (SCOPED_LISTING_PROJECT.has(String(tool))) return deny("home_only");

  const access = await resolveBotAccess(db, actor.id, requested);
  if (access.kind === "none") return deny("no_share");
  if (access.suspended) return deny("suspended");
  if (policy.kind === "write" && access.level === "read") return deny("read_only");
  return { allowed: true, projectId: requested };
}

/**
 * The scope of every read whose `project_id` is omitted: for a bot, the home project and nothing
 * else (`homeProjectId: null` matches no rows). Project-less rows are never included. `null` for a
 * non-bot actor means "no restriction".
 *
 * @returns {Promise<null | { homeProjectId: number|null }>}
 */
export async function botReadScope(db, actor) {
  if (!boundByBotRules(actor)) return null;
  if (actor.unverified) return { homeProjectId: null };
  return { homeProjectId: await homeProjectId(db, actor.id) };
}

/**
 * The `AND …` fragment a scoped read appends to its WHERE clause, with its args. A null scope adds
 * nothing; a scope with no home project matches no rows.
 */
export function scopePredicate(scope, { column = "project_id" } = {}) {
  if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(String(column))) throw new Error("bad scope column");
  if (scope == null) return { sql: "", args: [] };
  if (scope.homeProjectId == null) return { sql: " AND 1 = 0", args: [] };
  return { sql: ` AND ${column} = ?`, args: [Number(scope.homeProjectId)] };
}

/**
 * The project an omitted `project_id` becomes on a write: the home project for a bot, else a
 * refusal (a bot with no home project must name one). Non-bot actors pass through unchanged.
 *
 * @returns {Promise<{projectId: number|string|null} | {refused: true, message: string}>}
 */
export async function botWriteProject(db, actor, requestedProjectId) {
  const requested = requestedProjectId == null || requestedProjectId === "" ? null : requestedProjectId;
  if (!boundByBotRules(actor)) return { projectId: requested };
  if (requested != null) return { projectId: asId(requested) };
  const home = await homeProjectId(db, actor.id);
  if (home == null) return { refused: true, message: NAME_A_PROJECT_MESSAGE };
  return { projectId: home };
}

/**
 * The same decision for a by-id row, whose own `project_id` the caller resolved first. A
 * project-less row (`rowProjectId == null`) is owner-only, so a bot is refused `no_share`.
 */
export async function decideRowAccess(db, actor, { tool, rowProjectId, args = {}, deviceId = null } = {}) {
  if (!boundByBotRules(actor)) return { allowed: true, projectId: asId(rowProjectId) };
  if (actor.unverified) return deny("owner_only");
  const policy = toolPolicyFor(tool, args);
  if (!policy || policy.kind === "owner_only") return deny("owner_only");
  if (rowProjectId == null) return deny("no_share");
  return decideProjectAccess(db, actor, { tool, projectId: rowProjectId, args, deviceId });
}

const REFUSAL_WINDOW_MS = 60_000;
const refusalWindows = new WeakMap();

const clockOf = (now) => {
  if (typeof now === "function") return now;
  if (typeof now === "number") return () => now;
  return Date.now;
};

function windowFor(db) {
  let w = refusalWindows.get(db);
  if (!w) {
    w = new Map();
    refusalWindows.set(db, w);
  }
  return w;
}

/**
 * Record a refusal in the project's own log: action `share.refused`, target `tool:<name>`, payload
 * `{code}`. A refusal that names no project (an `owner_only` refusal with no project, an unverified
 * bot) is logged on the bot's HOME project when it has one, and dropped silently when it has none.
 * A project that does not exist takes no row (silently), and repeats of the same
 * (bot, project, tool, code) inside 60 s collapse into the first, so a retry loop cannot flood the
 * log. `now` is the clock (a function or a millisecond value) for tests.
 */
export async function auditRefusal(db, actor, { tool, projectId, code, now = Date.now } = {}) {
  const named = asId(projectId);
  const id = named != null ? named
    : isBot(actor) && actor.id ? await homeProjectId(db, actor.id)
      : null;
  if (id == null) return;

  const exists = await db.execute({
    sql: "SELECT id FROM project_spaces WHERE id = ? LIMIT 1",
    args: [id],
  });
  if (!exists.rows[0]) return;

  const at = clockOf(now)();
  const windows = windowFor(db);
  const botId = isBot(actor) && actor.id ? String(actor.id) : "-";
  const key = [id, botId, String(tool), String(code)].join("\u0000");
  const last = windows.get(key);
  if (last != null && at - last < REFUSAL_WINDOW_MS) return;

  for (const [k, t] of windows) if (at - t >= REFUSAL_WINDOW_MS) windows.delete(k);
  windows.set(key, at);

  await appendAudit(db, {
    project_id: id,
    ...auditActor(actor),
    action: "share.refused",
    target: `tool:${String(tool)}`,
    payload: { code },
  });
}

/**
 * One gate per tool call, and the only copy of these decisions: it resolves the actor from the
 * construction-time base and the call's `extra`, and answers with the tool-result shape the project
 * tools already use for an ACL error.
 *
 * `check` passes `{ projectId }` — the project the gate RESOLVED, which is the home project when the
 * call omitted one and the bot has a home — so a handler writes and reads against the project the
 * gate resolved rather than the one the call happened to name. `checkRow` passes `null`: the row's
 * own project is already the caller's, there is nothing left to resolve. A refusal from either is
 * the tool-result object (`isError: true`), so a handler reads:
 *
 *   const gate = makeShareGate(db, "crow_store_memory", { baseActor, extra });
 *   const pass = await gate.check(args.project_id, args);
 *   if (pass && pass.isError) return pass;
 *   const projectId = pass.projectId;
 *
 * The handler passes the call's own arguments as the second parameter: only `device_id` and
 * `dry_run` are read (a bot naming a device is refused, and `dry_run` picks which of `crow_dream`'s
 * two entries applies).
 *
 * A pass can carry `projectId: null`, and for a bot READ that does NOT mean unrestricted: it means
 * the call named no project and the bot has no home project. The handler must then apply
 * `readScope()` (with `scopePredicate`) so the read matches nothing. A covered WRITE never passes
 * `projectId: null`: a bot with no home project is refused instead.
 *
 * Every refusal from `checkRow` is the not-found result; the true code goes to the audit log only.
 */
export function makeShareGate(db, tool, { extra, baseActor } = {}) {
  const actor = resolveCallActor(baseActor || UNKNOWN, extra);

  const audit = (projectId, code) => auditRefusal(db, actor, { tool, projectId, code });

  return {
    actor,
    async check(projectId, callArgs = {}) {
      const args = callArgs && typeof callArgs === "object" ? callArgs : {};
      const decision = await decideProjectAccess(db, actor, { tool, projectId, args, deviceId: args.device_id });
      if (decision.allowed) return { projectId: decision.projectId ?? null };
      await audit(projectId ?? null, decision.code);
      return refusalResult(decision.message);
    },
    async checkRow(rowProjectId, callArgs = {}) {
      const args = callArgs && typeof callArgs === "object" ? callArgs : {};
      const decision = await decideRowAccess(db, actor, { tool, rowProjectId, args, deviceId: args.device_id });
      if (decision.allowed) return null;
      await audit(rowProjectId ?? null, decision.code);
      return notFoundResult();
    },
    readScope() {
      return botReadScope(db, actor);
    },
    writeProject(requested) {
      return botWriteProject(db, actor, requested);
    },
  };
}