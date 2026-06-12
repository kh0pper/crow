/**
 * Bot Builder Panel — Data Queries
 *
 * Constants, caches, and data helpers for the bot-builder panel.
 * The probe caches (_probeCache/_probeAt, _extCache/_extAt) MUST live in this
 * module alongside probeAll/probeExtensions — a missed cache is a ReferenceError
 * on tools-tab render (invisible to boot and suite).
 */

import { readdirSync } from "node:fs";
import { join as pathJoin } from "node:path";
import {
  readCanonicalMcp,
  probeServerTools,
} from "../../../../../scripts/pi-bots/mcp_writer.mjs";
import {
  PI_EXT_ALLOWLIST,
} from "../../../../../scripts/pi-bots/pi_extensions_allowlist.mjs";
import {
  resolveCrowHome,
  listInstalledExtensions,
  extensionTools,
} from "../../../../../scripts/pi-bots/ext_registry.mjs";
import { skillDirs } from "../../../../../scripts/pi-bots/skill_resolver.mjs";
import { tasksDbPath, botsWorkspaceRoot } from "../../../../../scripts/pi-bots/instance-paths.mjs";
import { listProvidersAll } from "../../../../orchestrator/providers-db.js";
import { getPeerCapabilities } from "../../capabilities-cache.js";
import { getTrustedInstances } from "../nest/data-queries.js";
import { getOrCreateLocalInstanceId } from "../../../instance-registry.js";
import { readSetting } from "../../settings/registry.js";

export const TASKS_DB = tasksDbPath();

// Skill dirs are resolved per-instance by skill_resolver.skillDirs() (A6):
// <crowHome>/skills, ~/.crow/skills, ~/crow/skills.
export const PI_BUILTIN = ["read", "edit", "write", "bash", "list", "glob", "grep"];
// PI_EXT_ALLOWLIST is imported from the single-source module (Phase 2.4):
// scripts/pi-bots/pi_extensions_allowlist.mjs — the panel only OFFERS these;
// the bridge REFUSES anything else (no Bot Builder code ever runs `pi install`).
export { PI_EXT_ALLOWLIST };

export const TABS = [
  ["ai", "AI / Models"],
  ["tools", "Tools & Extensions"],
  ["gateways", "Gateways"],
  ["tracker", "Project / Tracker"],
  ["skills", "Skills & Prompt"],
  ["permissions", "Permissions / Safety"],
  ["triggers", "Triggers"],
  ["sessions", "Sessions"],
  ["review", "Review / Deploy"],
];

// in-process probe cache (per gateway process), 5-min TTL — probing spawns
// every MCP server, so we don't redo it on every tools-tab render.
let _probeCache = null;
let _probeAt = 0;
export async function probeAll() {
  if (_probeCache && Date.now() - _probeAt < 300000) return _probeCache;
  const out = {};
  let canonical;
  try {
    canonical = readCanonicalMcp();
  } catch (e) {
    return { _error: String(e.message || e) };
  }
  const names = Object.keys(canonical.mcpServers);
  await Promise.all(
    names.map(async (n) => {
      try {
        out[n] = await probeServerTools(canonical.mcpServers[n], { timeoutMs: 12000 });
      } catch (e) {
        out[n] = { ok: false, error: String(e.message || e) };
      }
    })
  );
  _probeCache = out;
  _probeAt = Date.now();
  return out;
}

// A6: live tool probe for installed EXTENSIONS (addon servers absent from
// canonical — the canonical ones already render under probeAll above). Cached
// 5-min like probeAll since each entry spawns its MCP server.
let _extCache = null;
let _extAt = 0;
export async function probeExtensions(crowHome) {
  if (_extCache && Date.now() - _extAt < 300000) return _extCache;
  const exts = listInstalledExtensions(crowHome).filter((e) => e.needsMint);
  const out = [];
  for (const ext of exts) {
    out.push({ ext, probe: await extensionTools(ext, { crowHome }) });
  }
  _extCache = out;
  _extAt = Date.now();
  return out;
}

// A6: vision profiles have no dedicated getter (unlike tts/stt) — read the
// dashboard_settings row directly, same storage shape, apiKey stripped.
export async function loadVisionProfiles(db) {
  try {
    const r = await db.execute({
      sql: "SELECT value FROM dashboard_settings WHERE key = 'vision_profiles'",
      args: [],
    });
    if (!r.rows[0]?.value) return [];
    return JSON.parse(r.rows[0].value).map(({ apiKey, ...rest }) => rest);
  } catch {
    return [];
  }
}

// F4a: best-effort federated peer tools (read-only display). Budgeted; offline peers skipped.
export async function gatherPeerTools(db) {
  let peers = [];
  try { peers = await getTrustedInstances(db); } catch { return []; }
  if (!peers.length) return [];
  const localId = getOrCreateLocalInstanceId();
  const settled = await Promise.allSettled(
    peers.filter((p) => p.id !== localId).map((p) => getPeerCapabilities(db, p.id, { source: "bot-builder" }))
  );
  const out = [];
  for (const s of settled) {
    if (s.status !== "fulfilled" || !s.value || s.value.status !== "ok") continue;
    const inst = s.value.instance || {};
    for (const t of (s.value.capabilities?.tools || [])) {
      out.push({ ...t, instanceId: s.value.instanceId, instanceName: inst.name || s.value.instanceId || "(unknown)" });
    }
  }
  return out;
}

// F4a L2b: is cross-instance invocation enabled on THIS instance?
export async function remoteInvocationOn(db) {
  try {
    const raw = await readSetting(db, "feature_flags");
    return !!raw && JSON.parse(raw)?.remote_invocation === true;
  } catch { return false; }
}

// R14 (Phase 3.2): models.json read goes through the 3.0 resolver's
export async function loadModelOptions(db) {
  try {
    const all = await listProvidersAll(db);
    const enabled = all.filter((p) => !p.disabled);
    const opts = [];
    for (const row of enabled) {
      for (const m of row.models || []) {
        const mid = typeof m === "string" ? m : m.id;
        if (!mid) continue;
        opts.push({ provider: row.id, key: `${row.id}/${mid}`, label: (m.name || mid) });
      }
    }
    if (!opts.length) return { error: "No providers configured.", opts: [] };
    return { error: null, opts };
  } catch (err) {
    return { error: "Provider registry unavailable: " + err.message, opts: [] };
  }
}

// A6: instance-aware — scans <crowHome>/skills, ~/.crow/skills, ~/crow/skills
// (the same order skill_resolver resolves), not the old hardcoded pair.
export function loadSkills(crowHome) {
  const names = new Set();
  for (const dir of skillDirs(crowHome)) {
    try {
      for (const f of readdirSync(dir)) {
        if (f.endsWith(".md")) names.add(f.replace(/\.md$/, ""));
      }
    } catch { /* dir missing */ }
  }
  return [...names].sort();
}

export async function tableMissing(db) {
  try {
    await db.execute({ sql: "SELECT 1 FROM pi_bot_defs LIMIT 1", args: [] });
    return false;
  } catch {
    return true;
  }
}

export function defaultDefinition(botId, projectId, model) {
  // M3b: project_id is no longer a field in this returned object — the
  // pi_bot_defs.project_id column is authoritative. We still take projectId
  // as a parameter so the system_prompt template can baked-reference the
  // project number at creation time (it's just a string in the prompt; the
  // runtime project context block in bridge.mjs supersedes it).
  const sessionDir = pathJoin(botsWorkspaceRoot(), botId);
  return {
    engine: "pi",
    models: { default: model || "crow-local/qwen3.6-35b-a3b" },
    tools: {
      pi_builtin: ["read", "edit", "write"],
      crow_mcp: [
        "crow-tasks/tasks_list",
        "crow-tasks/tasks_get",
        "crow-tasks/tasks_update",
        "crow-tasks/tasks_complete",
        "crow-tasks/tasks_search",
      ],
      pi_extensions: [],
      skills: [],
    },
    gateways: [
      {
        type: "gmail",
        address: `kevin.hopper+${botId}@maestro.press`,
        allowlist: ["kevin.hopper1@gmail.com", "kevin.hopper@maestro.press"],
      },
    ],
    permission_policy: { bash: "deny", bash_allow: [], write_paths: [sessionDir], external_send: "draft_only", confirm: [], self_authoring: false, skill_learning: "off" },
    triggers: { gateway: true, cron: "" },
    system_prompt:
      `You are ${botId}, a single-purpose Crow bot. Operate ONLY within ` +
      `project ${projectId}'s Kanban (tasks_* filtered by that project_id) and ` +
      `your workspace ${sessionDir}. For the card you are told to do: read its ` +
      `plan file, do the work, write results into the plan file, advance the card ` +
      `pending->in_progress->done via tasks_update, then reply in the same gateway ` +
      `thread. Never send external email; never run bash. One card per request.`,
    skills: [],
    session_dir: sessionDir,
    spawn_env: { CROW_JOURNAL_MODE: "DELETE", PI_PROVIDER: "crow-local" },
  };
}

export const lines = (s) => String(s || "").split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
