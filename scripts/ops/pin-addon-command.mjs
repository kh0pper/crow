#!/usr/bin/env node
/**
 * Pin an add-on's launcher: write command_sha256 (the current SHA-256 of its
 * absolute `command`) into <crow-home>/mcp-addons.json.
 *
 * Add-on launchers outside the root-owned system directories (for example
 * uv/uvx in ~/.local/bin, or a run.sh in the bundle) are only started when
 * pinned, and the pin is re-checked at every start
 * (servers/shared/resolve-command.js). Run this as the operator after
 * installing or updating the launcher, then restart the gateway.
 *
 *   node scripts/ops/pin-addon-command.mjs <addon-id> [--command /abs/path]
 *
 * --command also rewrites a bare command (e.g. "uvx") to the absolute path
 * you give. CROW_HOME selects the instance (default ~/.crow).
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export function pinAddonCommand({ crowHome, id, command }) {
  const file = join(crowHome, "mcp-addons.json");
  const addons = JSON.parse(readFileSync(file, "utf8"));
  const entry = addons[id];
  if (!entry) throw new Error(`no add-on '${id}' in ${file}`);
  const cmd = command || entry.command;
  if (typeof cmd !== "string" || !isAbsolute(cmd)) throw new Error(`'${id}' command must be an absolute path (pass --command /abs/path)`);
  if (!statSync(cmd).isFile()) throw new Error(`${cmd} is not a file`);
  const sha = createHash("sha256").update(readFileSync(cmd)).digest("hex");
  addons[id] = { ...entry, command: cmd, command_sha256: sha };
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(addons, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, file);
  return { file, command: cmd, sha256: sha };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const id = args[0];
  const i = args.indexOf("--command");
  const command = i >= 0 ? args[i + 1] : undefined;
  if (!id || id.startsWith("-")) {
    console.error("usage: pin-addon-command.mjs <addon-id> [--command /abs/path]");
    process.exit(2);
  }
  try {
    const r = pinAddonCommand({ crowHome: process.env.CROW_HOME || join(homedir(), ".crow"), id, command });
    console.log(`pinned ${id}: ${r.command} sha256=${r.sha256} (${r.file}); restart the gateway to start it`);
  } catch (e) {
    console.error(String(e.message || e));
    process.exit(1);
  }
}
