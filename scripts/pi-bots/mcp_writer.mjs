#!/usr/bin/env node
/**
 * Crow Bot Builder — per-bot MCP config writer + tool-list prober (Phase 2.1).
 *
 * S2/D finding (plan §5, "Verified Claims"): pi-lab/extensions/mcp-client.ts
 * reads `~/.pi/agent/mcp.json` from homedir() UNCONDITIONALLY and merges every
 * cwd-ancestor `.mcp.json`, with the homedir file WINNING on key collision.
 * The bridge pins each pi's cwd to the bot's `session_dir`, so the per-bot
 * config is `<session_dir>/.mcp.json`. Because the merge is additive and
 * homedir wins, this file canNOT remove a homedir server — tool *scoping*
 * stays the `--tools` allowlist (toolAllowlist() in bridge.mjs). What this
 * file IS for:
 *   1. make the bot workspace self-describing / portable,
 *   2. carry a bot-specific server that is NOT in the global homedir file,
 *   3. HARD-GUARANTEE `CROW_JOURNAL_MODE=DELETE` on every crow.db server in
 *      the per-bot file — the WAL-unlink scar guard
 *      ([[feedback_crowdb_wal_flip_new_consumers]]); defends against a future
 *      homedir edit or a bot adding a crow.db server.
 *
 * Server blocks are COPIED VERBATIM from the already-working canonical
 * `~/.pi/agent/mcp.json`, so a generated per-bot file is valid by construction.
 *
 * Also exports probeServerTools(): a dependency-free MCP stdio `tools/list`
 * (initialize -> notifications/initialized -> tools/list) reusing the
 * s0_mcp_probe wire plumbing — this is the authoritative GUI tool-picker data
 * source (plan §5: pi's effective mcp.json + a LIVE per-server tools/list, NOT
 * getProxyStatus()). Each tool is flagged `hasPattern` if its inputSchema
 * contains a `pattern`/regex anywhere (drives the Phase-2.3 SOFT-WARN; S4
 * proved the crow-chat --jinja regex scar does NOT reproduce under pi).
 */
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const HOME = "/home/kh0pp";
export const CANONICAL_MCP_PATH = HOME + "/.pi/agent/mcp.json";

export function readCanonicalMcp(path = CANONICAL_MCP_PATH) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    throw new Error("cannot read canonical mcp.json at " + path + ": " + e.message);
  }
  let j;
  try {
    j = JSON.parse(raw);
  } catch (e) {
    throw new Error("canonical mcp.json is not valid JSON: " + e.message);
  }
  if (!j || typeof j.mcpServers !== "object" || !j.mcpServers) {
    throw new Error("canonical mcp.json has no mcpServers object");
  }
  return j;
}

/** Distinct MCP server names a bot references via def.tools.crow_mcp. */
export function serversForBot(def) {
  const sel = (def && def.tools && def.tools.crow_mcp) || [];
  const set = new Set();
  for (const entry of sel) {
    if (typeof entry !== "string" || !entry) continue;
    // "server/tool" -> "server"; a bare "server" -> "server"
    set.add(entry.split("/")[0]);
  }
  return [...set];
}

/** True if a server block touches crow.db (so the journal guard applies). */
function touchesCrowDb(block) {
  return !!(block && block.env && block.env.CROW_DB_PATH);
}

/**
 * Build the per-bot `.mcp.json` object from the bot def + canonical config.
 * @returns {{ json:object, servers:string[], warnings:string[], journalGuarded:string[] }}
 */
export function buildBotMcp(def, canonical) {
  const want = serversForBot(def);
  const out = { mcpServers: {} };
  const warnings = [];
  const journalGuarded = [];
  for (const name of want) {
    const block = canonical.mcpServers[name];
    if (!block) {
      warnings.push(
        "server '" + name + "' is selected but absent from canonical mcp.json — pi will NOT have it"
      );
      continue;
    }
    // deep clone so we never mutate the canonical in memory
    const clone = JSON.parse(JSON.stringify(block));
    if (touchesCrowDb(clone)) {
      clone.env = clone.env || {};
      if (clone.env.CROW_JOURNAL_MODE !== "DELETE") {
        clone.env.CROW_JOURNAL_MODE = "DELETE";
        journalGuarded.push(name);
      }
    }
    out.mcpServers[name] = clone;
  }
  return { json: out, servers: Object.keys(out.mcpServers), warnings, journalGuarded };
}

/**
 * Write `<session_dir>/.mcp.json` for a bot. Idempotent (full rewrite each
 * call). Throws only on a missing session_dir in the def or an unreadable
 * canonical; a selected-but-absent server is a soft warning (returned).
 */
export function writeBotMcp(def, opts = {}) {
  if (!def || !def.session_dir) throw new Error("bot def has no session_dir");
  const canonical = opts.canonical || readCanonicalMcp(opts.canonicalPath);
  const built = buildBotMcp(def, canonical);
  mkdirSync(def.session_dir, { recursive: true });
  const path = join(def.session_dir, ".mcp.json");
  writeFileSync(path, JSON.stringify(built.json, null, 2) + "\n", { mode: 0o600 });
  return {
    path,
    servers: built.servers,
    warnings: built.warnings,
    journalGuarded: built.journalGuarded,
  };
}

// ---- dependency-free MCP stdio tools/list (GUI picker source) -------------

function deepHasPattern(schema, depth = 0) {
  if (!schema || typeof schema !== "object" || depth > 12) return false;
  if (Object.prototype.hasOwnProperty.call(schema, "pattern")) return true;
  for (const k of Object.keys(schema)) {
    const v = schema[k];
    if (v && typeof v === "object" && deepHasPattern(v, depth + 1)) return true;
  }
  return false;
}

/**
 * Live `tools/list` for one MCP server block (command/args/cwd/env exactly as
 * pi-lab/mcp-client would spawn it). Never throws — returns {ok:false,error}.
 * @returns {Promise<{ok:boolean, serverName?:string, tools?:Array<{name:string,description:string,hasPattern:boolean}>, error?:string}>}
 */
export function probeServerTools(block, opts = {}) {
  const timeoutMs = opts.timeoutMs || 15000;
  return new Promise((resolve) => {
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      try {
        child.kill("SIGKILL");
      } catch {
        /* gone */
      }
      resolve(r);
    };
    let child;
    try {
      child = spawn(block.command, block.args || [], {
        cwd: block.cwd,
        env: Object.assign({}, process.env, block.env || {}),
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (e) {
      return resolve({ ok: false, error: "spawn failed: " + e.message });
    }
    let stderr = "";
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", (e) => finish({ ok: false, error: "proc error: " + e.message }));
    const hardTimer = setTimeout(
      () => finish({ ok: false, error: "timeout (stderr: " + stderr.slice(-300) + ")" }),
      timeoutMs
    );

    let buf = "";
    const pending = new Map();
    let nextId = 1;
    child.stdout.on("data", (d) => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id != null && pending.has(msg.id)) {
          const { resolve: rs, reject: rj } = pending.get(msg.id);
          pending.delete(msg.id);
          msg.error ? rj(new Error(JSON.stringify(msg.error))) : rs(msg.result);
        }
      }
    });
    const rpc = (method, params) => {
      const id = nextId++;
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      return new Promise((rs, rj) => {
        pending.set(id, { resolve: rs, reject: rj });
        setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            rj(new Error("rpc timeout " + method));
          }
        }, timeoutMs);
      });
    };
    const notify = (method, params) =>
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");

    (async () => {
      try {
        const init = await rpc("initialize", {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "pibot-picker", version: "0" },
        });
        notify("notifications/initialized", {});
        const list = await rpc("tools/list", {});
        clearTimeout(hardTimer);
        const tools = (list && list.tools ? list.tools : []).map((t) => ({
          name: t.name,
          description: (t.description || "").slice(0, 240),
          hasPattern: deepHasPattern(t.inputSchema),
        }));
        finish({
          ok: true,
          serverName: (init && init.serverInfo && init.serverInfo.name) || "?",
          tools,
        });
      } catch (e) {
        clearTimeout(hardTimer);
        finish({ ok: false, error: e.message + " (stderr: " + stderr.slice(-200) + ")" });
      }
    })();
  });
}

// CLI: write <botId> | probe <serverName> | list-servers
if (import.meta.url === "file://" + process.argv[1]) {
  const cmd = process.argv[2];
  const arg = process.argv[3];
  const CROW_DB = process.env.CROW_DB_PATH || HOME + "/.crow-mpa/data/crow.db";
  if (cmd === "list-servers") {
    const c = readCanonicalMcp();
    console.log(Object.keys(c.mcpServers).join("\n"));
    process.exit(0);
  }
  if (cmd === "probe" && arg) {
    const c = readCanonicalMcp();
    const block = c.mcpServers[arg];
    if (!block) {
      console.error("no such server: " + arg);
      process.exit(2);
    }
    probeServerTools(block).then((r) => {
      console.log(JSON.stringify(r, null, 2));
      process.exit(r.ok ? 0 : 1);
    });
  } else if (cmd === "write" && arg) {
    // load the bot def from crow.db
    import("/home/kh0pp/crow/node_modules/better-sqlite3/lib/index.js").then((m) => {
      const Database = m.default;
      const d = new Database(CROW_DB);
      d.pragma("busy_timeout = 10000");
      const row = d
        .prepare("SELECT definition FROM pi_bot_defs WHERE bot_id=?")
        .get(arg);
      d.close();
      if (!row) {
        console.error("no such bot: " + arg);
        process.exit(2);
      }
      const def = JSON.parse(row.definition || "{}");
      const res = writeBotMcp(def);
      console.log(JSON.stringify(res, null, 2));
      process.exit(0);
    });
  } else {
    console.error(
      "usage: mcp_writer.mjs list-servers | probe <server> | write <botId>"
    );
    process.exit(2);
  }
}
