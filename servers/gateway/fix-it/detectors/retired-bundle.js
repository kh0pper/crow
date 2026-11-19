/**
 * Fix-it detector: a bundle Crow RETIRED is still installed on this machine.
 *
 * The AI Companion (Open-LLM-VTuber + Live2D, `bundles/companion/`) was removed from
 * Crow for every install. An install made before that still has it: an `installed.json`
 * record and/or `~/.crow/bundles/companion/`. Nothing removes it behind the owner's
 * back — this card asks, and its one click runs the product's own uninstall (the same
 * handler the Extensions page's Remove button posts to). Its data folder is kept, per
 * the existing kept-data rules; nothing else is "undone" and the card offers no undo
 * beyond what stays on disk.
 *
 * No event fires for an installed record, so this is a BOOT check (`runBootChecks()`).
 * It resolves itself the moment the bundle is gone.
 *
 * Card text lives HERE, in code, keyed by id — never in the crow.db columns: the eight
 * add-ons that share crow.db can write `fix_it_items`, so a stored title/why is not
 * something to render. (Same rule as the add-on-wall card.)
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { CROW_HOME } from "../../bundles-config.js";
import { readInstalled } from "../../bundle-core.js";
import { RETIRED_BUNDLES, retiredBundleIds } from "../../retired-bundles.js";
import { ACTION_ID as REMOVE_ACTION_ID, LABEL as REMOVE_LABEL, label as removeLabel } from "../remedies/remove-retired-bundle.js";

export const SOURCE = "retired-bundle";

/** One card per retired bundle id. */
export const dedupKeyFor = (bundleId) => `retired:${bundleId}`;

const LANG = (lang) => (lang === "es" ? "es" : "en");

/** The retired bundle's display name, from the stub (never from a stored row). */
function bundleName(bundleId) {
  return RETIRED_BUNDLES[bundleId]?.name || bundleId;
}

/** The card's title, in the dashboard's language. */
export function cardTitle(bundleId, lang = "en") {
  const name = bundleName(bundleId);
  return LANG(lang) === "es" ? `${name} se retiró` : `${name} was retired`;
}

/**
 * The card's body, in the dashboard's language. It says what the button does — quoting the
 * button's own words, so the instruction and the button always agree — that the data folder
 * stays, and that there is no undo beyond that: the three things an owner deciding about a
 * one-click removal needs. The quotes are the ones the surrounding UI uses: straight double
 * quotes in English, the Spanish guillemets («») that every other quoted control name in
 * `dashboard/shared/i18n.js` carries.
 */
export function cardWhy(bundleId, lang = "en") {
  const name = bundleName(bundleId);
  const press = removeLabel(lang);
  if (LANG(lang) === "es") {
    // `la extensión` / `el complemento`: the article agrees with the add-on's kind.
    const how = RETIRED_BUNDLES[bundleId]?.type === "bundle" ? "la extensión" : "el complemento";
    return `${name} ya no forma parte de Crow, pero sigue instalado en este Crow. Pulsa «${press}»: Crow usa su propia ruta de desinstalación y conserva la carpeta de datos de ${how} (tus conversaciones, modelos y ajustes se quedan ahí). No hay forma de deshacerlo más allá de eso.`;
  }
  return `${name} is no longer part of Crow, but it is still installed on this Crow. Press "${press}": Crow runs its own uninstall path and keeps the add-on's data folder (your conversations, models and settings stay there). There is no undo beyond that.`;
}

export default {
  source: SOURCE,
  // An installed record emits no event: runBootChecks() calls check() at gateway start.
  events: [],
  async onEvent() {},
  /**
   * One card per retired bundle that is still installed, RESOLVING itself once the
   * bundle is gone. Never throws into boot (runBootChecks isolates a detector).
   *
   * `opts`: { crowHome, bundlesDir, installedPath, exists } — tests pass their own
   * roots; the running gateway takes the defaults.
   */
  async check(store, opts = {}) {
    const crowHome = opts.crowHome || CROW_HOME;
    const bundlesDir = opts.bundlesDir || join(crowHome, "bundles");
    const exists = typeof opts.exists === "function" ? opts.exists : existsSync;
    const installed = readInstalled(opts.installedPath || join(crowHome, "installed.json"));
    const installedIds = new Set(
      (Array.isArray(installed) ? installed : [])
        .map((rec) => (typeof rec === "string" ? rec : rec?.id))
        .filter((id) => typeof id === "string"),
    );
    const cards = [];
    for (const bundleId of retiredBundleIds()) {
      // "Installed" here means the record OR the folder: a half-removed install (the
      // folder left behind after its record went) is exactly what this card is for.
      const present = installedIds.has(bundleId) || exists(join(bundlesDir, bundleId));
      if (!present) {
        try { await store.resolveByKey(SOURCE, dedupKeyFor(bundleId)); } catch { /* no row yet */ }
        continue;
      }
      await store.upsertItem({
        source: SOURCE,
        dedupKey: dedupKeyFor(bundleId),
        title: cardTitle(bundleId, "en"),
        why: cardWhy(bundleId, "en"),
        severity: "warn",
        remedies: [{ actionId: REMOVE_ACTION_ID, kind: "instant", label: REMOVE_LABEL, args: { bundle: bundleId } }],
        context: { bundle: bundleId },
      });
      cards.push(bundleId);
    }
    return { cards };
  },
};