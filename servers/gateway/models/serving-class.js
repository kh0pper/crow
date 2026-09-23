/**
 * serving.class — a curated safety CEILING on a model catalog entry
 * (spec docs/superpowers/specs/2026-09-23-serving-class-design.md).
 *
 * resident   — single box, no RPC, safe behind a cap: starts as today.
 * windowed   — operator present, two-box and/or evicts production.
 * wedge-risk — a shape that has wedged the box; never one-tap.
 *
 * The class lives in the git-reviewed catalog, never in instance settings:
 * settings may narrow what a box runs, never widen it. Pure, no I/O.
 */

export const SERVING_CLASSES = ["resident", "windowed", "wedge-risk"];

/** One Strix Halo box's GTT total (crow mem_info_gtt_total, 2026-09-23). A
 *  quant needing more RAM than this cannot run single-box, so its model
 *  cannot be `resident` (enforced by scripts/validate-model-catalog.js). */
export const SINGLE_BOX_RAM_MB = 126976;

export function servingClassOf(entry) {
  const cls = entry && entry.serving && typeof entry.serving === "object" ? entry.serving.class : null;
  return SERVING_CLASSES.includes(cls) ? cls : null;
}

export class ServingClassError extends Error {
  constructor(servingClass, providerName) {
    super(`${providerName || "model"} is a ${servingClass} model — the gateway does not start it on demand; heavy models run through an operator window`);
    this.name = "ServingClassError";
    this.code = "serving_class_refused";
    this.http = 409;
    this.servingClass = servingClass;
    this.provider = providerName || null;
  }
}

/** The refusal for starting `entry` as `providerName`, or null when allowed.
 *  Allowed: resident, uncurated (null class), or override === class. */
export function servingClassRefusal(entry, providerName, override) {
  const cls = servingClassOf(entry);
  if (cls === null || cls === "resident") return null;
  if (typeof override === "string" && override === cls) return null;
  return new ServingClassError(cls, providerName);
}

/** What the dashboard may offer for a registered, stopped model of this class. */
export function startAffordance(servingClass) {
  if (servingClass === "windowed") return "window-only";
  if (servingClass === "wedge-risk") return "never";
  return "start";
}
