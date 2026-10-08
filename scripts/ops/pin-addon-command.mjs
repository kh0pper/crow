#!/usr/bin/env node
/**
 * Check or pin the launchers of an instance's MCP add-ons
 * (<crow-home>/mcp-addons.json; CROW_HOME selects the instance, default
 * ~/.crow).
 *
 * Launchers outside the root-owned system directories — uv/uvx in
 * ~/.local/bin, a run.sh in the bundle — are started only when pinned
 * (`command_sha256`), and the pin is re-checked at every start
 * (servers/shared/resolve-command.js; pi-lab re-checks it at spawn).
 *
 *   node scripts/ops/pin-addon-command.mjs --check
 *       read-only: one line per add-on — "ok", or "would refuse — <reason>"
 *       plus the command that fixes it. Exit 1 when anything would be refused.
 *   node scripts/ops/pin-addon-command.mjs <addon-id> [--command /abs/path]
 *       write the pin (and, with --command, replace a bare command such as
 *       "uvx" by that absolute path). Restart the gateway afterwards.
 *
 * Re-pin triggers (the add-on is refused, and says so in the gateway log and
 * on the Extensions page, until re-pinned):
 *   - an update of the launcher itself: `uv self update`, a new uv/uvx, an
 *     edited run.sh;
 *   - an operator edit of the add-on's mcp-addons.json entry.
 * A bundle's own ./run.sh is re-pinned automatically by the Extensions
 * install and update; Extensions also offers a one-click re-pin.
 * Not fixable by a pin: a uv/uvx `--from git+…` that names no commit SHA —
 * edit the entry to `…@<40-hex commit>`.
 */
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { addonLauncherStatus, launcherPin } from "../../servers/shared/resolve-command.js";

const addonsFile = (crowHome) => join(crowHome, "mcp-addons.json");
const bundleDir = (crowHome, id, entry) => (entry && entry.cwd) || join(crowHome, "bundles", id);

function writeAddons(file, addons) {
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(addons, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, file);
}

/**
 * Pin one add-on (operator script and the Extensions one-click re-pin).
 * @returns {{file, command, sha256}}
 */
export function repinAddon({ crowHome, id, command }) {
  const file = addonsFile(crowHome);
  const addons = JSON.parse(readFileSync(file, "utf8"));
  const entry = addons[id];
  if (!entry) throw new Error(`no add-on '${id}' in ${file}`);
  const cmd = command || entry.command;
  if (typeof cmd !== "string" || !cmd) throw new Error(`'${id}' has no command`);
  if (command && !isAbsolute(command)) throw new Error("--command must be an absolute path");
  const dir = bundleDir(crowHome, id, entry);
  const sha = launcherPin(cmd, dir);
  if (!sha) {
    if (!isAbsolute(cmd) && !cmd.includes("/")) throw new Error(`'${id}' uses the bare command '${cmd}'; give it an absolute path (--command /abs/path)`);
    throw new Error(`'${id}': ${cmd} needs no pin or cannot be pinned (root-owned, or not found)`);
  }
  addons[id] = { ...entry, command: cmd, command_sha256: sha };
  writeAddons(file, addons);
  return { file, command: cmd, sha256: sha };
}

/** Kept for callers of the first version of this script. */
export function pinAddonCommand(args) { return repinAddon(args); }

/** Read-only report: [{id, ok, line}] */
export function checkAddons({ crowHome }) {
  const file = addonsFile(crowHome);
  const addons = JSON.parse(readFileSync(file, "utf8"));
  const rows = [];
  for (const [id, entry] of Object.entries(addons)) {
    if (entry && entry.url) { rows.push({ id, ok: true, line: `${id}: ok (url)` }); continue; }
    const st = addonLauncherStatus(entry, bundleDir(crowHome, id, entry));
    if (st.ok) { rows.push({ id, ok: true, line: `${id}: ok` }); continue; }
    const bare = typeof entry.command === "string" && !entry.command.includes("/") && !["node", "npm", "npx"].includes(entry.command);
    const fix = st.needsRepin ? `re-pin: node scripts/ops/pin-addon-command.mjs ${id}`
      : bare ? `pin with an absolute path: node scripts/ops/pin-addon-command.mjs ${id} --command /abs/path`
        : /floating git ref/.test(st.reason || "") ? "edit the entry: --from …@<40-hex commit>" : "fix the entry";
    rows.push({ id, ok: false, line: `${id}: would refuse — ${st.reason}; ${fix}` });
  }
  return { file, rows };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const crowHome = process.env.CROW_HOME || join(homedir(), ".crow");
  try {
    if (args[0] === "--check") {
      const { file, rows } = checkAddons({ crowHome });
      console.log(`# ${file}`);
      for (const r of rows) console.log(r.line);
      process.exit(rows.every((r) => r.ok) ? 0 : 1);
    }
    const id = args[0];
    const i = args.indexOf("--command");
    const command = i >= 0 ? args[i + 1] : undefined;
    if (!id || id.startsWith("-")) {
      console.error("usage: pin-addon-command.mjs --check | <addon-id> [--command /abs/path]   (CROW_HOME selects the instance)");
      process.exit(2);
    }
    const r = repinAddon({ crowHome, id, command });
    console.log(`pinned ${id}: ${r.command} sha256=${r.sha256} (${r.file}); restart the gateway to start it`);
  } catch (e) {
    console.error(String(e.message || e));
    process.exit(1);
  }
}
