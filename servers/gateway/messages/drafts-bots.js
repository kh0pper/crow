/**
 * Who wrote a Crow Messages draft, as a person reads it.
 *
 * A draft row carries `origin` (`owner` or `bot`) and, for a bot's, the `bot_id` the door recorded.
 * A `bot_id` is not a name: it is the identifier a bot's definition is filed under
 * (`pi_bot_defs.bot_id`), and every surface that shows a bot's part in a draft — the "by <bot>" chip
 * on the Drafts list, the composer's "Draft by <bot>" banner — has to show the name the operator
 * gave it. The lookup therefore happens HERE, once, on the server: the panel's render and the draft
 * routes both ask this module, so a bot is named the same way everywhere and the browser never has
 * to know a bot id is a definition row.
 *
 * Three rules:
 *
 *  - A draft that is not a bot's is handed back untouched. Nothing is added for an owner's draft, so
 *    a caller can never render "by <bot>" over the operator's own words.
 *  - The row's OWN SNAPSHOT wins (`bot_name`, written when the draft was made and covered by the
 *    seal): that is the name the person saw when the bot wrote it, and it cannot be changed under
 *    them by renaming the bot. A row with no snapshot (an owner's draft, or one written before the
 *    column existed) is named by its definition's display name.
 *  - A bot id with no row (a bot that was deleted, or a row written by hand) falls back to the id
 *    itself. It is an identifier, not a secret, and a blank chip would be worse than a technical one.
 *  - The lookup never throws. A draft list is part of a panel render and of an autosave's answer; a
 *    `pi_bot_defs` that is missing (an install that never made a bot) or a failing query must leave
 *    the drafts drawable, not take the page down.
 *
 * Read-only: this module writes nothing.
 */

/** The name a draft's bot is shown by: the definition's display name, else the id, else null. */
function nameFor(names, botId) {
  if (botId == null || botId === "") return null;
  const found = names.get(String(botId));
  return found && found.trim() ? found.trim() : String(botId);
}

/**
 * The display names of a set of bots, keyed by `bot_id`. Empty ids are ignored, an empty set costs
 * no query, and any failure answers an empty map (callers fall back to the id).
 *
 * @param {object} db
 * @param {Array<string|null|undefined>} botIds
 * @returns {Promise<Map<string, string>>}
 */
export async function botNamesFor(db, botIds = []) {
  const names = new Map();
  const ids = [...new Set((Array.isArray(botIds) ? botIds : [])
    .map((id) => (id == null ? "" : String(id).trim()))
    .filter(Boolean))];
  if (!ids.length || !db || typeof db.execute !== "function") return names;
  try {
    const placeholders = ids.map(() => "?").join(", ");
    const { rows } = await db.execute({
      sql: `SELECT bot_id, display_name FROM pi_bot_defs WHERE bot_id IN (${placeholders})`,
      args: ids,
    });
    for (const row of rows || []) {
      const name = row?.display_name == null ? "" : String(row.display_name).trim();
      if (name) names.set(String(row.bot_id), name);
    }
  } catch {
    // No pi_bot_defs (or a query failure): the ids stand in for the names.
  }
  return names;
}

/**
 * The same drafts with `botName` filled in for a bot's own (`null` for an owner's). Returns new
 * objects; the store's rows are never modified.
 *
 * @param {object} db
 * @param {object[]} drafts
 * @returns {Promise<object[]>}
 */
export async function draftsWithBotNames(db, drafts = []) {
  const list = Array.isArray(drafts) ? drafts : [];
  const botIds = list
    .filter((d) => d && d.origin === "bot" && !String(d.botName ?? "").trim())
    .map((d) => d.botId);
  const names = botIds.length ? await botNamesFor(db, botIds) : new Map();
  return list.map((draft) => {
    if (!draft || draft.origin !== "bot") return { ...draft, botName: null };
    const snapshot = String(draft.botName ?? "").trim();
    return { ...draft, botName: snapshot || nameFor(names, draft.botId) };
  });
}

export { nameFor as botNameOrId };