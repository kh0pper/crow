/**
 * Extensions Panel — themed collections ("install these N extensions in one click").
 *
 * Data lives in registry/collections.json. v1 is local-file only: the remote
 * add-on registry may grow collections later, at which point the merge follows
 * the add-on rule (local wins by id).
 *
 * Membership is constrained (tests/extensions-collections.test.js enforces it):
 * official add-ons only, never privileged / consent_required (one-click must not
 * weaken the consent gate), never GPU-gated, dependency-closed and topologically
 * ordered, and each member declares how it arrives:
 *   deploys  — ships its own containers via docker-compose
 *   connects — integrates with an external service the user must already run
 *              (carries `you_need`, rendered as a prerequisite in the UI)
 *   builtin  — in-process panel/MCP add-on: no container, no external service
 * The server re-validates all of this at install time against the on-disk
 * manifests (routes/bundles.js) — this file is data, not a trust boundary.
 */

import { existsSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** registry/collections.json — five levels up from panels/extensions/. */
export const COLLECTIONS_PATH = join(__dirname, "../../../../../registry/collections.json");

/**
 * Load collections. Never throws: a missing or corrupt file yields [] and the
 * collections section simply doesn't render.
 * @returns {Array<{id:string,name:string,description:string,icon:string,members:Array<{id:string,kind:string,you_need?:string}>}>}
 */
export function loadCollections(path = COLLECTIONS_PATH) {
  try {
    if (!existsSync(path)) return [];
    const data = JSON.parse(readFileSync(path, "utf8"));
    const collections = data?.collections;
    if (!Array.isArray(collections)) return [];
    return collections.filter(
      (c) => c && typeof c.id === "string" && Array.isArray(c.members) && c.members.length > 0,
    );
  } catch {
    return [];
  }
}

/** @returns {object|null} the collection with this id, or null. */
export function getCollection(id, path = COLLECTIONS_PATH) {
  return loadCollections(path).find((c) => c.id === id) || null;
}
