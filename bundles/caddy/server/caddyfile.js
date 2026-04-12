/**
 * Minimal Caddyfile reader/writer for Crow's MCP tools.
 *
 * This is intentionally *not* a full Caddyfile parser — Caddy's own adapter is
 * the authoritative validator (POST /load on the admin API). We handle only
 * the common site-block shape that add_site emits:
 *
 *   example.com {
 *     reverse_proxy <upstream>
 *   }
 *
 * Hand-edited Caddyfiles are preserved on reads: list_sites reports any
 * site address it can detect, even if the body is complex. add_site appends
 * a new block at the end; remove_site deletes a block by matching address.
 * For anything more elaborate, the operator edits the file directly and
 * calls caddy_reload.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export function resolveConfigDir(envValue) {
  const raw = envValue || "~/.crow/caddy";
  if (raw.startsWith("~/")) return join(homedir(), raw.slice(2));
  return raw;
}

export function caddyfilePath(configDir) {
  return join(configDir, "Caddyfile");
}

export const DEFAULT_CADDYFILE = `# Crow-managed Caddyfile. The global options block below is required by
# Crow's MCP server and panel to reach the admin API from the host.
# Everything below is yours to edit. Run caddy_reload after manual edits.
{
\temail {$CADDY_EMAIL}
\tadmin 0.0.0.0:2019
}
`;

export function ensureConfigDir(configDir) {
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }
  const dataDir = join(configDir, "data");
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  }
  const cfgDir = join(configDir, "config");
  if (!existsSync(cfgDir)) {
    mkdirSync(cfgDir, { recursive: true });
  }
  const p = caddyfilePath(configDir);
  if (!existsSync(p)) {
    writeFileSync(p, DEFAULT_CADDYFILE, { mode: 0o644 });
  }
}

/**
 * Read the Caddyfile, returning "" if it does not yet exist.
 */
export function readCaddyfile(configDir) {
  const p = caddyfilePath(configDir);
  if (!existsSync(p)) return "";
  return readFileSync(p, "utf8");
}

/**
 * Write the Caddyfile atomically (write-then-rename).
 */
export function writeCaddyfile(configDir, contents) {
  ensureConfigDir(configDir);
  const p = caddyfilePath(configDir);
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, contents, { mode: 0o644 });
  renameSync(tmp, p);
}

/**
 * Locate site blocks in the Caddyfile.
 * Returns an array of { address, body, start, end } where start/end are
 * character offsets into the source. Skips Caddy's "global options" block
 * (the leading block that begins with `{` rather than an address).
 *
 * Handles multi-address forms like `a.example.com, b.example.com {` by
 * splitting on commas.
 */
export function parseSites(source) {
  const sites = [];
  const lines = source.split("\n");
  let i = 0;
  let offset = 0;
  let seenFirstBlock = false;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    const lineLen = line.length + 1; // +1 for newline

    // Skip blank / comment lines
    if (!trimmed || trimmed.startsWith("#")) {
      offset += lineLen;
      i++;
      continue;
    }

    // Match "addresses {" at end of line
    const m = trimmed.match(/^(.+?)\s*\{\s*$/);
    if (!m) {
      offset += lineLen;
      i++;
      continue;
    }

    // Caddy's global options block is the first top-level block AND starts
    // with just "{". We detect "global options" by the address being empty.
    const addressPart = m[1].trim();
    if (!seenFirstBlock && addressPart === "") {
      // This is the global options block — skip it
      seenFirstBlock = true;
      const endIdx = findBlockEnd(lines, i);
      for (let k = i; k <= endIdx; k++) offset += lines[k].length + 1;
      i = endIdx + 1;
      continue;
    }
    seenFirstBlock = true;

    if (addressPart === "") {
      offset += lineLen;
      i++;
      continue;
    }

    const start = offset;
    const endIdx = findBlockEnd(lines, i);
    if (endIdx === -1) {
      // Unterminated block — bail to avoid emitting partial data
      break;
    }

    let end = offset;
    for (let k = i; k <= endIdx; k++) end += lines[k].length + 1;

    const body = lines.slice(i + 1, endIdx).join("\n");
    const addresses = addressPart.split(",").map((s) => s.trim()).filter(Boolean);
    for (const address of addresses) {
      sites.push({ address, body, start, end });
    }

    offset = end;
    i = endIdx + 1;
  }

  return sites;
}

function findBlockEnd(lines, openIdx) {
  let depth = 0;
  for (let k = openIdx; k < lines.length; k++) {
    for (const ch of lines[k]) {
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) return k;
      }
    }
  }
  return -1;
}

/**
 * Append a new reverse-proxy site block to the Caddyfile source.
 * Returns the new source. Does not persist.
 */
export function appendSite(source, domain, upstream, extra = "") {
  const base = source.endsWith("\n") || source === "" ? source : source + "\n";
  const sep = base && !base.endsWith("\n\n") ? "\n" : "";
  const extraLines = extra
    ? extra.split("\n").map((l) => "  " + l).join("\n") + "\n"
    : "";
  const block =
    `${domain} {\n` +
    `  reverse_proxy ${upstream}\n` +
    extraLines +
    `}\n`;
  return base + sep + block;
}

/**
 * Remove a site block matching the given address.
 * If multiple blocks match (rare), only the first is removed.
 * Returns { source: updated source, removed: boolean }.
 */
export function removeSite(source, domain) {
  const sites = parseSites(source);
  const match = sites.find((s) => s.address === domain);
  if (!match) return { source, removed: false };

  // Find the actual byte range for *this* block (if the block has multiple
  // addresses, the same start/end applies; removing the block removes them
  // all — the operator edits manually if they want to split).
  let before = source.slice(0, match.start);
  let after = source.slice(match.end);
  // Collapse any excess blank lines introduced by the removal.
  const joined = (before + after).replace(/\n{3,}/g, "\n\n");
  return { source: joined, removed: true };
}
