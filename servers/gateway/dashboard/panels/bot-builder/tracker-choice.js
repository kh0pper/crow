/**
 * Bot Builder — the one tracker write (leaf module, no imports).
 *
 * Shared by the Edit tab's tracker save and "Turn on a board"
 * (api-handlers.js), the guided wizard's project create (wizard.js) and
 * "Move a bot here" (move-bot.js), so they cannot drift. Lives here, not in
 * api-handlers.js, because api-handlers.js imports wizard.js: a helper there
 * would be an import cycle.
 */

/**
 * The tracker write the Edit tab's tracker save makes, shared with board_on so
 * the two cannot drift. Mutates and returns `def`: mirrors project_id into
 * the JSON (the column stays authoritative, M3b) and sets tracker_config.
 * tracker_config.project_id is always dropped — tracker.mjs prefers it over
 * the column, so a stale copy would point the bot's context at another board.
 */
export function applyTrackerChoice(def, { projectId = null, type = "kanban", slug = "", contextFields = "", queueFilterKey = "", queueFilterValue = "" } = {}) {
  def.project_id = projectId;
  def.tracker_config = def.tracker_config || {};
  def.tracker_config.type = type;
  delete def.tracker_config.project_id;
  if (type === "custom") {
    def.tracker_config.tracker_slug = String(slug || "").trim();
    def.tracker_config.context_fields = String(contextFields || "").split(",").map((x) => x.trim()).filter(Boolean);
    const qf = String(queueFilterKey || "").trim();
    const qv = String(queueFilterValue || "").trim();
    if (qf && qv) { def.tracker_config.queue_filter = { [qf]: qv }; }
    else { delete def.tracker_config.queue_filter; }
  } else if (type === "kanban" || type === "task-list" || type === "none") {
    delete def.tracker_config.tracker_slug;
    delete def.tracker_config.context_fields;
    delete def.tracker_config.queue_filter;
  }
  return def;
}

/** The tracker type a def runs with (tracker.mjs's own default is kanban when the field is unset). */
export function trackerType(def) {
  const tc = def && def.tracker_config;
  return tc && typeof tc === "object" && tc.type ? String(tc.type) : "";
}

/**
 * The "Show this bot its project's cards" switch: kanban, task-list and an unset or missing type are
 * On (tracker.mjs runs an unset type as kanban, so the switch shows what the bot gets); none and
 * custom are not.
 */
export function trackerOn(def) {
  const ty = trackerType(def);
  return ty === "" || ty === "kanban" || ty === "task-list";
}

/** A custom-tracker bot has no switch: its tracker is left as it is. */
export function trackerIsCustom(def) {
  return trackerType(def) === "custom";
}

/**
 * Apply the switch. A custom-tracker def is never changed by it (a crafted show_cards is ignored; the
 * project link alone may move, and tracker_config stays untouched). On keeps task-list when the bot
 * already is task-list, else kanban; Off writes none. Returns true when it wrote a tracker.
 */
export function applyShowCards(def, { projectId = null, on = false } = {}) {
  if (trackerIsCustom(def)) { def.project_id = projectId; return false; }
  applyTrackerChoice(def, { projectId, type: on ? (trackerType(def) === "task-list" ? "task-list" : "kanban") : "none" });
  return true;
}
