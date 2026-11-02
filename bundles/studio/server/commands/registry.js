/**
 * Studio command registry — the one list of edits the GUI, the MCP server and
 * the shared history all go through.
 *
 * A command is a plain spec:
 *
 *   defineCommand({
 *     id: "clip.write",                 // the contract: GUI, MCP and history use it
 *     title: "Write a clip's notes",
 *     humanOnly: false,                 // true: only a person may run it
 *     idField: "clip_id",               // the argument naming an object it creates
 *     schema,                           // zod, .strict() so typos are refused
 *     summary(args, snap) -> string,    // one human line for the history panel
 *     touches(args, snap) -> string[],  // object refs a lock/focus check looks at
 *     apply(doc, args, snap) -> {before, after},
 *   });
 *
 * `before` and `after` are plain objects keyed `"<ref>|<field>"` (see
 * doc.js `applyBeforeAfter`) holding deep-cloned JSON: one entry per field the
 * command changed, `"*"` for a whole created or deleted object. A `null` value
 * means "that object or field did not exist" — never `undefined`, which JSON
 * would drop when the history stores the entry.
 *
 * Order of work in a call, which the hub relies on:
 *
 *   prepareCommand()  validates the arguments and names the touched objects,
 *                     WITHOUT touching the document (so a lock or focus check
 *                     can still refuse the edit);
 *   applyCommand()    applies it and summarises it, inside the caller's
 *                     transaction.
 *
 * `runCommand()` does both, for callers that need no lock check (tests, the
 * tools that only build documents).
 *
 * Commands are registered by importing `./core.js` for its side effect. A
 * consumer that imports only this module gets an empty registry, and
 * `getCommand` says so.
 */

import { randomUUID } from "node:crypto";
import { snapshot } from "../doc.js";

/**
 * The refusal codes a caller may see. `limit`, `invalid` and `not_found` come
 * from the registry; the rest are raised by the session hub.
 * @type {string[]}
 */
export const REFUSAL_CODES = Object.freeze([
  "limit",
  "invalid",
  "not_found",
  "human_only",
  "locked",
  "focused",
  "acl",
  "conflict",
]);

/**
 * A refusal a caller can explain and act on. The message is plain English and
 * names the object, field or limit it is about.
 */
export class StudioError extends Error {
  /**
   * @param {"limit"|"invalid"|"not_found"|"human_only"|"locked"|"focused"|"acl"|"conflict"} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = "StudioError";
    this.code = code;
  }
}

/** Command ids read like "clip.write": a namespace, then one verb. */
const ID_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

/** @type {Map<string, Readonly<object>>} */
const COMMANDS = new Map();

/**
 * Register a command. Re-registering an id replaces it, so a module that is
 * loaded twice does not double-list its commands.
 * @param {{id: string, title: string, humanOnly?: boolean, idField?: string|null,
 *          schema: {safeParse: Function}, summary: Function, touches: Function,
 *          apply: Function}} spec
 * @returns {Readonly<object>} the registered command
 */
export function defineCommand(spec) {
  if (!spec || typeof spec !== "object") {
    throw new TypeError("Studio: a command spec must be an object");
  }
  const { id, title, schema, summary, touches, apply } = spec;
  if (typeof id !== "string" || !ID_PATTERN.test(id)) {
    throw new TypeError(`Studio: "${id}" is not a command id like "clip.write"`);
  }
  if (typeof title !== "string" || title.trim() === "") {
    throw new TypeError(`Studio: command "${id}" needs a title`);
  }
  if (!schema || typeof schema.safeParse !== "function") {
    throw new TypeError(`Studio: command "${id}" needs a zod schema`);
  }
  if (typeof summary !== "function") {
    throw new TypeError(`Studio: command "${id}" needs a summary(args, snap)`);
  }
  if (typeof touches !== "function") {
    throw new TypeError(`Studio: command "${id}" needs a touches(args, snap)`);
  }
  if (typeof apply !== "function") {
    throw new TypeError(`Studio: command "${id}" needs an apply(doc, args, snap)`);
  }

  const command = Object.freeze({
    id,
    title,
    humanOnly: spec.humanOnly === true,
    idField: typeof spec.idField === "string" && spec.idField !== "" ? spec.idField : null,
    schema,
    summary,
    touches,
    apply,
  });
  COMMANDS.set(id, command);
  return command;
}

/**
 * Look one command up by its id.
 * @param {string} id
 * @returns {Readonly<object>} the command
 * @throws {StudioError} code "not_found" when no command has that id
 */
export function getCommand(id) {
  const command = COMMANDS.get(id);
  if (!command) {
    const hint = COMMANDS.size === 0
      ? " No commands are registered: import server/commands/core.js first."
      : "";
    throw new StudioError("not_found", `There is no Studio command "${id}".${hint}`);
  }
  return command;
}

/**
 * @param {string} id
 * @returns {boolean} whether a command with this id is registered
 */
export function hasCommand(id) {
  return COMMANDS.has(id);
}

/**
 * Every registered command, sorted by id — the GUI's list, the MCP server's
 * tool list and the parity test all read this.
 * @returns {Array<Readonly<object>>}
 */
export function listCommands() {
  return [...COMMANDS.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Validate one command's arguments.
 *
 * A schema refinement that hits a song limit tags its issue with
 * `addLimitIssue()`, and is reported with code "limit" rather than "invalid"
 * so a caller can tell "too much of an allowed thing" from "malformed".
 * @param {Readonly<object>} command
 * @param {unknown} args
 * @returns {object} the parsed arguments, with defaults filled in
 * @throws {StudioError} code "limit" for an over-the-limit value, code
 *   "invalid" naming each rejected field otherwise
 */
export function validateArgs(command, args) {
  const result = command.schema.safeParse(args ?? {});
  if (result.success) return result.data;
  const overLimit = result.error.issues.find((issue) => issue.params?.refusal === "limit");
  if (overLimit) throw new StudioError("limit", overLimit.message);
  const details = result.error.issues.map((issue) => {
    const path = issue.path.join(".");
    return path ? `${path}: ${issue.message}` : issue.message;
  });
  throw new StudioError("invalid", `Invalid arguments for ${command.id}: ${details.join("; ")}`);
}

/**
 * Report a schema refinement's failure as a limit refusal rather than a plain
 * argument error. Use it from a zod `.superRefine((value, ctx) => ...)`.
 * @param {{addIssue: Function}} ctx - the refinement context
 * @param {string} message - plain English, naming the limit
 * @returns {void}
 */
export function addLimitIssue(ctx, message) {
  ctx.addIssue({ code: "custom", message, params: { refusal: "limit" } });
}

/**
 * Validate a command and name the objects it touches, without editing.
 *
 * A missing object id (a new track, scene or clip) is generated here, so the
 * touched refs and the edit itself always agree on it.
 * @param {import("yjs").Doc} doc
 * @param {string} id
 * @param {unknown} args
 * @returns {{command: Readonly<object>, args: object, snap: object, touched: string[]}}
 * @throws {StudioError}
 */
export function prepareCommand(doc, id, args) {
  const command = getCommand(id);
  const parsed = validateArgs(command, args);
  if (command.idField && (parsed[command.idField] === undefined || parsed[command.idField] === null)) {
    parsed[command.idField] = randomUUID();
  }
  const snap = snapshot(doc);
  const touched = command.touches(parsed, snap);
  if (!Array.isArray(touched) || touched.some((ref) => typeof ref !== "string" || ref === "")) {
    throw new TypeError(`Studio: ${command.id} returned touched refs that are not strings`);
  }
  return { command, args: parsed, snap, touched: [...new Set(touched)] };
}

/**
 * Apply a prepared command and summarise it.
 *
 * Runs inside the caller's transaction (the hub wraps it in
 * `doc.transact(fn, origin)`); it opens none of its own, so one command stays
 * one Yjs update and one history step.
 * @param {import("yjs").Doc} doc
 * @param {{command: Readonly<object>, args: object, snap: object}} prepared
 * @returns {{summary: string, before: Object<string, any>, after: Object<string, any>}}
 * @throws {StudioError}
 */
export function applyCommand(doc, prepared) {
  const { command, args, snap } = prepared;
  const changes = command.apply(doc, args, snap);
  if (!changes || typeof changes !== "object") {
    throw new TypeError(`Studio: ${command.id} returned no before/after`);
  }
  const before = changes.before ?? {};
  const after = changes.after ?? {};
  const summary = command.summary(args, snap);
  if (typeof summary !== "string" || summary === "") {
    throw new TypeError(`Studio: ${command.id} returned an empty summary`);
  }
  return { summary, before, after };
}

/**
 * Validate, apply and summarise one command in a single call — for tests and
 * for document editors that check no locks.
 *
 * The hub does NOT use this: it calls `prepareCommand`, checks locks and focus
 * against `touched`, then calls `applyCommand` inside its transaction.
 * @param {import("yjs").Doc} doc
 * @param {string} id
 * @param {unknown} [args]
 * @returns {{id: string, args: object, touched: string[], summary: string,
 *            before: Object<string, any>, after: Object<string, any>}}
 * @throws {StudioError}
 */
export function runCommand(doc, id, args = {}) {
  const prepared = prepareCommand(doc, id, args);
  const { summary, before, after } = applyCommand(doc, prepared);
  return { id: prepared.command.id, args: prepared.args, touched: prepared.touched, summary, before, after };
}