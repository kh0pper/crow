/**
 * The operator's default Studio layout template: where it lives, the three
 * calls the web layer makes, and the owner check its writes sit behind.
 *
 * This is the wiring as VALUES — pure functions over an injected database
 * client — so the module has no side effects at import: no client of its own,
 * no top-level await, no timers, no import of the gateway's tree. The panel
 * loader (`panel/routes.js`) does all of those things to build the panel, so
 * the wiring lives here, where it can be built over a scratch database without
 * booting a gateway.
 *
 * The setting is instance-local on purpose: where a song's widgets sit is view
 * state, and the default for a song this device has never opened is this
 * machine's own preference — a "local" write lands in the per-instance settings
 * table and is never emitted to a peer.
 */

/** The instance-local setting key the operator's default layout template lives under. */
const LAYOUT_TEMPLATE_KEY = "studio.layout_template";

/**
 * The operator's default layout template, as the web layer's three calls: the
 * stored TEXT (null when unset), a write of it, and a clear.
 *
 * Built from the settings registry as a value, so the wiring is ONE function a
 * caller can hand a different client (the gateway's own, or a scratch one)
 * rather than a copy of these three closures that could drift from the routes'.
 * @param {object|null} registry the dashboard's settings registry module
 * @param {object} db a crow.db client (the gateway's own, or a scratch one)
 * @returns {{read: Function, write: Function, clear: Function}|null}
 */
export function buildLayoutTemplate(registry, db) {
  if (!registry || typeof registry.readSetting !== "function") return null;
  return {
    read: () => registry.readSetting(db, LAYOUT_TEMPLATE_KEY),
    write: (template) =>
      registry.writeSetting(db, LAYOUT_TEMPLATE_KEY, String(template), { scope: "local" }),
    clear: () => registry.deleteLocalSetting(db, LAYOUT_TEMPLATE_KEY),
  };
}

/**
 * The gate the default template's WRITE and CLEAR sit behind: whether this
 * request is the owner at THIS machine's own dashboard.
 *
 * The rule itself is injected (`isLocalPasswordSessionOn` in the gateway,
 * because it needs the app root's session and origin checks and this bundle
 * imports nothing from the gateway's tree). What is pinned here is the client
 * it is asked over — the same crow.db this instance keeps its settings in —
 * and the fail-closed answer when a gateway wired no check at all: nobody is
 * the owner, so the routes refuse rather than guess.
 * @param {((db: object, req: object) => any)|null|undefined} gate the owner rule
 * @param {object} db a crow.db client
 * @returns {(req: object) => any} the gate's own answer, or false without one
 */
export function buildLayoutOwnerCheck(gate, db) {
  return (req) => (typeof gate === "function" ? gate(db, req) : false);
}