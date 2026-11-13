/**
 * Giving one bot the Studio tools — the song page's one-click offer.
 *
 * A bot def's `tools.crow_mcp` list holds the servers and tools a bot may use.
 * A BARE server entry (`"studio"`) grants every tool that server offers: the pi
 * rails expand it to the real tool names before the spawn (see
 * `scripts/pi-bots/bare-server-tools.mjs`). So giving a bot Studio is one entry
 * in that list, and nothing else in the def is touched.
 *
 * ## What this module is
 *
 * The def editing lives here, and the panel loader (`../panel/routes.js`) only
 * wires it: it passes in the gateway's own database client, the audit append,
 * the Bot Builder defs-changed emit, the bare-entry primer and the model's tool
 * budget. Nothing here imports from `servers/…`, so the same code runs in the
 * gateway (through the loader) and in a test over a scratch crow.db.
 *
 * ## It is a person's click, never a guess
 *
 * The function never runs on its own: the route that calls it is behind the
 * dashboard session and the CSRF header, refuses an agent caller, and needs
 * write on the song's project. It also never guesses which bot: the caller
 * names the bot and the stored row's `project_id` has to be the project the
 * route asked about. Crow's voice bot is refused by its id before any row is
 * read (the injected `isVoiceBot`), because its tools are its own.
 *
 * ## A tool budget it cannot read fails open
 *
 * Appending a server entry can put a bot past its model's tool limit, which
 * would make the next turn refuse its whole allowlist. The candidate def is
 * therefore primed (the live, killed-on-finish `tools/list` probe) and counted
 * the way the spawn preflight counts it; over the cap the edit is refused with
 * a sentence naming Bot Builder. A budget that cannot be read (an unresolvable
 * model, a helper that will not load) does NOT block the edit — exactly the
 * behaviour `defaultCompanionBudget` itself has.
 */

/** What a caller is told when the def is already past saving by hand. */
const BAD_DEF_TEXT = "That bot's definition could not be read; fix it in Bot Builder first.";

/**
 * What a caller is told when the bot is not this project's, or is gone — and
 * what Crow's voice bot is told, so nothing about it is confirmed.
 */
export const NOT_FOUND_TEXT = "That bot is not this project's bot any more.";

/** What a caller is told when the bot changed between the read and the write. */
const STALE_TEXT = "The bot changed meanwhile; reload and try again.";

/** What a caller is told when the extra server entry would pass the tool limit. */
const OVER_BUDGET_TEXT =
  "That bot is near its model's tool limit; trim its tools in Bot Builder first, then give it Studio again.";

/** @returns {Error} a coded refusal whose message is written for the caller. */
function refuse(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * Does this bot def already grant the Studio server?
 *
 * Only the BARE server entry (`"studio"`) is the server grant: it is the one
 * spelling the pi rails expand to every tool Studio offers. A per-tool entry
 * (`"studio/studio_play"`, `"studio__studio_play"`) grants that one tool and
 * nothing else, so a bot holding only those is still offered the grant — and
 * `withStudioTools` appends the bare entry beside them, never in place of them.
 * @param {object|null|undefined} def
 * @returns {boolean}
 */
export function grantsStudioTools(def) {
  const list = def && def.tools && def.tools.crow_mcp;
  if (!Array.isArray(list)) return false;
  return list.includes("studio");
}

/**
 * A copy of this def that also grants the Studio server.
 *
 * The stored object is never mutated, and nothing else in it changes: `tools`
 * is copied, `crow_mcp` is copied with one entry appended, and every other key
 * is carried over as it was. A `tools` or `crow_mcp` that is absent is created;
 * one that is present but is not the right shape is a def nobody can edit
 * safely, so it refuses instead of dropping what is there.
 * @param {object} def
 * @returns {object} the candidate def
 */
export function withStudioTools(def) {
  if (!def || typeof def !== "object" || Array.isArray(def)) throw refuse("bad_def", BAD_DEF_TEXT);
  const tools = def.tools;
  if (tools != null && (typeof tools !== "object" || Array.isArray(tools))) throw refuse("bad_def", BAD_DEF_TEXT);
  const list = tools && tools.crow_mcp;
  if (list != null && !Array.isArray(list)) throw refuse("bad_def", BAD_DEF_TEXT);
  return {
    ...def,
    tools: { ...(tools || {}), crow_mcp: [...(Array.isArray(list) ? list : []), "studio"] },
  };
}

/**
 * Build the `giveBotStudioTools` the panel loader injects into the web layer.
 *
 * @param {object} options
 * @param {{execute: Function}} options.db a libsql-compatible client (`execute({sql, args})`)
 * @param {((entry: object) => Promise<void>)|null} [options.appendAudit] the project
 *   audit append (`project-acl.js` `appendAudit`, already bound to the client)
 * @param {((botId: string) => void)|null} [options.emitDefsChanged] Bot Builder's
 *   defs-changed emit, so a running gateway picks the new def up without a restart
 * @param {((def: object) => Promise<Object<string, string[]>|void>)|null}
 *   [options.primeTools] the bare-entry primer (`primeBareServerTools`): it
 *   lists each bare server's real tool names and RETURNS the map it built, which
 *   is handed on to the budget count. A primer that throws or returns nothing
 *   is an empty map: the count then sees the entry itself, as a spawn with no
 *   listing does
 * @param {((def: object, options: {bareServerTools: Object<string, string[]>}) =>
 *   Promise<{cap?: number|null, countFor: Function}>)|null}
 *   [options.budgetFor] the model's tool budget (`defaultCompanionBudget`), given
 *   the primer's map so its count is the one the spawn makes
 * @param {((botId: string) => boolean)|null} [options.isVoiceBot] whether an id
 *   is Crow's voice bot, which is refused before any row is read (default:
 *   never a voice bot)
 * @param {((message: string) => void)|null} [options.log] one line per failed
 *   budget read; defaults to silence
 * @returns {(request: {botId: string, projectId: number}) =>
 *   Promise<{ok: true, already: boolean}>}
 */
export function createGiveBotStudioTools({
  db,
  appendAudit = null,
  emitDefsChanged = null,
  primeTools = null,
  budgetFor = null,
  isVoiceBot = null,
  log = () => {},
} = {}) {
  if (!db || typeof db.execute !== "function") {
    throw new TypeError("Studio give-tools needs a database client");
  }

  /** The voice-bot rule the caller injects; without one, no id is Crow's voice. */
  const voiceBot = typeof isVoiceBot === "function" ? isVoiceBot : () => false;

  /**
   * Append the Studio server entry to one bot's `tools.crow_mcp`.
   *
   * @param {{botId: string, projectId: number}} request
   * @returns {Promise<{ok: true, already: boolean}>} `already` when the bot
   *   already grants Studio (nothing is written, nothing audited)
   * @throws {Error} a refusal carrying `not_found` (404), `stale` (409),
   *   `bad_def` (422) or `over_budget` (422) and a sentence for the caller
   */
  return async function giveBotStudioTools({ botId, projectId } = {}) {
    const id = String(botId ?? "");
    const project = Number(projectId);
    if (id === "" || !Number.isInteger(project) || project <= 0) throw refuse("not_found", NOT_FOUND_TEXT);
    // Crow's voice answers every surface and its tools are its own (the Bot
    // Builder rule: voice_bot_readonly). It is refused by its id, BEFORE the row
    // is read, with the same answer a bot that is not this project's gets, so
    // the route confirms nothing about it.
    if (voiceBot(id) === true) throw refuse("not_found", NOT_FOUND_TEXT);

    const { rows } = await db.execute({
      sql: "SELECT definition, project_id FROM pi_bot_defs WHERE bot_id = ?",
      args: [id],
    });
    const row = rows?.[0];
    if (!row) throw refuse("not_found", NOT_FOUND_TEXT);
    // The bot's own home project is what it may be given tools for: a page that
    // names another project's bot gets the same answer as one naming no bot.
    if (row.project_id == null || Number(row.project_id) !== project) throw refuse("not_found", NOT_FOUND_TEXT);

    let def = null;
    try {
      def = JSON.parse(row.definition ?? "{}");
    } catch {
      def = null;
    }
    if (!def || typeof def !== "object" || Array.isArray(def)) throw refuse("bad_def", BAD_DEF_TEXT);

    // Already granted: no write, no audit row, and an answer the panel can show
    // as "it already has them".
    if (grantsStudioTools(def)) return { ok: true, already: true };

    const candidate = withStudioTools(def);

    // The candidate is primed first (the live tools/list probe the rails run
    // before a spawn), and the map the primer returns is handed to the count, so
    // the budget sees the names the bare entry really expands to rather than the
    // entry itself. A primer that throws or returns nothing is an empty map.
    let bareServerTools = {};
    if (typeof primeTools === "function") {
      try {
        const primed = await primeTools(candidate);
        if (primed && typeof primed === "object" && !Array.isArray(primed)) bareServerTools = primed;
      } catch {
        // A listing that fails only warns in the primer; a primer that throws
        // is the same failure and must not block the edit.
      }
    }
    try {
      const budget = typeof budgetFor === "function" ? await budgetFor(candidate, { bareServerTools }) : null;
      if (
        budget &&
        Number.isInteger(budget.cap) &&
        budget.cap > 0 &&
        typeof budget.countFor === "function" &&
        budget.countFor(candidate) > budget.cap
      ) {
        throw refuse("over_budget", OVER_BUDGET_TEXT);
      }
    } catch (err) {
      // Only the over-budget refusal above is the caller's; anything else is a
      // budget that could not be read, which fails open (as the companion
      // helper does).
      if (err?.code === "over_budget") throw err;
      try {
        log("studio: the tool budget could not be read; adding Studio anyway: " + ((err && err.message) || err));
      } catch {
        // A logger that throws must not stop the edit either.
      }
    }

    // Compare-and-swap on the definition that was read (Bot Builder's own rule):
    // a concurrent save wins, and this one asks the page to reload.
    const written = await db.execute({
      sql: "UPDATE pi_bot_defs SET definition=?, updated_at=datetime('now') WHERE bot_id=? AND definition IS ?",
      args: [JSON.stringify(candidate), id, row.definition ?? null],
    });
    if (!Number(written.rowsAffected)) throw refuse("stale", STALE_TEXT);

    // A running gateway has to see the new def, or the bot keeps its old tool
    // list until the next restart; a bus that is not there is not an error.
    if (typeof emitDefsChanged === "function") {
      try {
        emitDefsChanged(id);
      } catch {
        /* no bot-builder bus here */
      }
    }

    // One audit line for the grant — what changed, and that it came from this
    // page. A failed append is logged by `appendAudit` itself and never fails
    // the edit.
    if (typeof appendAudit === "function") {
      await appendAudit({
        project_id: project,
        actor_type: "local",
        action: "bot.tools.grant",
        target: `bot:${id}`,
        payload: { server: "studio", via: "studio-ask" },
      });
    }

    return { ok: true, already: false };
  };
}