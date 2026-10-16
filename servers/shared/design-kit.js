// The Design kit as seen by Crow core and its consumers (spec §4.3, §4.4, D8).
// Consumer-agnostic: Artifacts uses it today, Workspace next. No bare imports.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** The installed kit's directory, or null. "Installed" = listed in
 *  <crowHome>/installed.json AND its library + API files are present. */
export function installedKitDir(crowHome) {
  if (!crowHome) return null;
  const dir = join(crowHome, "bundles", "design-kit");
  if (!existsSync(join(dir, "lib", "manifest.json")) || !existsSync(join(dir, "server", "kit.js"))) return null;
  let list;
  try { list = JSON.parse(readFileSync(join(crowHome, "installed.json"), "utf8")); } catch { return null; }
  const ids = Array.isArray(list) ? list.map((x) => (typeof x === "string" ? x : x && x.id)) : [];
  return ids.includes("design-kit") ? dir : null;
}
