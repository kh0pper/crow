#!/usr/bin/env node
/**
 * Crow Bot Builder — Bot Session Bridge (Phase 1, Gmail-shaped, thin).
 *
 * Maps {bot, gateway thread} <-> a resumable pi session, relays one turn,
 * persists bot_sessions, supports stop. The spawn / line-buffered-NDJSON /
 * SIGTERM->SIGKILL core is the S1/S2-verified subagent pattern (spawn with an
 * explicit argv array, NO shell — execFile-safe); pi is driven over the
 * S2-proven `--mode rpc` JSONL protocol (prompt / get_state / abort /
 * --session resume). Transport-agnostic: handleInbound() takes the exact
 * {bot_id, gateway_thread_id, user_message} shape router_dispatch.mjs hands
 * off, plus an injectable sendReply. The real Gmail adapter (router_dispatch
 * reuse) is a thin wrapper added when a human runs the live §9 E2E; the core
 * loop is proven here via --inject / bridge_e2e.mjs with a capturing sendReply.
 *
 * Authorities (plan §1): bot_sessions.status = runtime (this module owns it);
 * tasks_items.status = board (the tasks tool owns it, via pi); plan file =
 * work content. crow.db opened with busy_timeout only, NO journal_mode pragma;
 * pi spawned with CROW_JOURNAL_MODE=DELETE (memory crowdb-wal-flip-new-consumers).
 */
import Database from "better-sqlite3";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, appendFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { countLivePi, LIFECYCLE_DEFAULTS } from "./pi_lifecycle.mjs";
import { writeBotMcp } from "./mcp_writer.mjs";
import { validateExtensions, isMultiAgentCapable } from "./pi_extensions_allowlist.mjs";
import { resolveModel, escalateRequested, stripEscalateToken } from "./model_resolver.mjs";
import { getTrackerContext, kanbanText, cardStatus, resolveTrackerType } from "./tracker.mjs";
import { resolveSkills, resolveSkill, skillDirs } from "./skill_resolver.mjs";
import { resolveCrowHome } from "./ext_registry.mjs";
import { proposalsDir, selfAuthoringPromptBlock } from "./skill_proposals.mjs";
import { gatewayHint as resolveGatewayHint } from "./gateways/index.mjs";
import { runSkillReview } from "./skill_review.mjs";
import { botsDbPath, tasksDbPath as resolveTasksDbPath } from "./instance-paths.mjs";
import { remoteServersForBot, parseRemoteInvocationFlag } from "./remote-blocks.mjs";
import { warmModel } from "./warm.mjs";
import { meterBotTurn } from "./metering.mjs";
import { getOrCreateLocalInstanceId } from "../../servers/gateway/instance-registry.js";
import { statusToStage } from "../../servers/gateway/routes/board-stages.js";
import { extractPlanFileLine, buildPlanPrompt } from "./plan_dispatch.mjs";

const HOME = "/home/kh0pp";
const NODE = HOME + "/.nvm/versions/node/v20.20.2/bin/node";
// Package was renamed from @mariozechner/pi-coding-agent to
// @earendil-works/pi-coding-agent (still 'pi' binary; v0.74.2 verified).
const PI_CLI = HOME + "/.nvm/versions/node/v20.20.2/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js";
const CROW_DB = botsDbPath();
// Skill-file roots are resolved per-instance by skill_resolver (A3):
// <crowHome>/skills, then ~/.crow/skills, then the repo ~/crow/skills.
const TASKS_DB = resolveTasksDbPath();
const TURN_TIMEOUT_MS = Number(process.env.PIBOT_TURN_TIMEOUT_MS || 600000);
const PROMPT_ACK_TIMEOUT_MS = Number(process.env.PIBOT_PROMPT_ACK_TIMEOUT_MS || 60000);

function db(p) { const d = new Database(p); d.pragma("busy_timeout = 10000"); return d; }

export function toolAllowlist(def, { remoteEnabled = false } = {}) {
  const builtin = (def.tools && def.tools.pi_builtin) || [];
  const mcp = ((def.tools && def.tools.crow_mcp) || []).map((s) => "mcp__" + s.replace("/", "__"));
  const out = [...builtin, ...mcp];
  if (remoteEnabled) {
    // Server-level allow per remote capability (= all that capability's tools;
    // the peer's L2a gate is the per-call enforcement). Block names mirror
    // mintRemoteBlocks: crow-remote-<instanceId8>-<canonicalId>.
    for (const { instanceId, canonicalId } of remoteServersForBot(def)) {
      out.push(`mcp__crow-remote-${instanceId.slice(0, 8)}-${canonicalId}`);
    }
  }
  return out.join(",");
}

// F4a L2b: read feature_flags.remote_invocation with the same scope resolution
// as readSetting (this-instance override first, then global), synchronously
// over better-sqlite3. Local-only flag; default off. Never throws.
export function readRemoteInvocationEnabled(conn) {
  try {
    let localId = null;
    try { localId = getOrCreateLocalInstanceId(); } catch {}
    let row = null;
    if (localId) {
      row = conn.prepare("SELECT value FROM dashboard_settings_overrides WHERE key='feature_flags' AND instance_id=?").get(localId);
    }
    if (!row) row = conn.prepare("SELECT value FROM dashboard_settings WHERE key='feature_flags'").get();
    return parseRemoteInvocationFlag(row ? row.value : null);
  } catch { return false; }
}

// instanceId -> gateway_url for non-revoked peers with a URL. (The peer's L2a
// exposure gate is the trust boundary; this is just URL resolution.)
export function readPeerGatewayUrls(conn) {
  try {
    const rows = conn.prepare("SELECT id, gateway_url FROM crow_instances WHERE status != 'revoked' AND gateway_url IS NOT NULL").all();
    const map = {};
    for (const r of rows) map[r.id] = r.gateway_url;
    return map;
  } catch { return {}; }
}

export class PiRpc {
  constructor(opts) {
    const def = opts.def, sessionDir = opts.sessionDir;
    // Phase 3.0 (R3): provider+model are resolved per-turn by
    // model_resolver.resolveModel() and passed in via opts.resolved — there
    // is NO hardcoded crow-local anywhere in the spawn path anymore.
    const resolved = opts.resolved;
    const args = [PI_CLI, "--mode", "rpc", "--provider", resolved.provider, "--model", resolved.model,
      "--session-dir", sessionDir + "/sessions"];
    // Phase 3.1 (R9/R11): multi-agent is allowed iff the operator opted in
    // (def.permission_policy.multi_agent) AND the POST-resolution model is
    // capability-listed. Both flow into PI_BOT_PERMISSION_POLICY for the
    // pi-lab gate (the hard backstop, fail-closed on absence) and gate the
    // `subagent` belt below.
    const maOptIn = !!(def.permission_policy && def.permission_policy.multi_agent === true);
    const maCapable = isMultiAgentCapable(resolved.provider, resolved.model);
    // Belt (R7 — pi `--tools` provably filters extension-registered tools
    // too: dist/cli/args.js:220-221 "Applies to built-in, extension, and
    // custom tools"). Only expose `subagent` to the model when capable+
    // opted-in; otherwise pi never offers it. The gate is the backstop if a
    // hand DB-edit bypasses this.
    let tools = toolAllowlist(def, { remoteEnabled: opts.remoteEnabled });
    if (maOptIn && maCapable) tools = [tools, "subagent"].filter(Boolean).join(",");
    if (tools) args.push("--tools", tools);
    if (opts.appendSystemPromptFile) args.push("--append-system-prompt", opts.appendSystemPromptFile);
    if (opts.piSessionId) args.push("--session", opts.piSessionId);
    // PI_BOT_PERMISSION_POLICY drives the per-bot gate in pi-lab's
    // permission-gating.ts (Phase 2.2 + 3.1). Absent => that extension is a
    // no-op (non-bot pi unaffected); present => deny/allowlist bash, confine
    // write/edit to write_paths, draft-only external send, confirm[] block,
    // and (3.1) subagent gated on multi_agent && model_capable. We MERGE the
    // computed flags onto a COPY of def.permission_policy (never mutate the
    // stored def). PIBOT_SUBAGENT_DEPTH=0: this is the top-level bot pi; the
    // subagent extension bumps the counter for any child it spawns so the
    // gate blocks sub-agents-spawning-sub-agents.
    const piPolicy = Object.assign(
      {}, def.permission_policy || { bash: "deny", write_paths: [] },
      { multi_agent: maOptIn, model_capable: maCapable });
    // Slice C: a self_authoring bot must be able to write into its staging dir
    // even when its cwd/sessionDir is a project workspace. Append the absolute
    // staging dir to the write_paths COPY (create the array if absent — pi-lab's
    // underAnyRoot fail-closes on a non-array). Never mutates the stored def.
    if (opts.selfAuthoringDir) {
      piPolicy.write_paths = (Array.isArray(piPolicy.write_paths) ? piPolicy.write_paths.slice() : [])
        .concat(opts.selfAuthoringDir);
    }
    const env = Object.assign({}, process.env,
      { PATH: HOME + "/.nvm/versions/node/v20.20.2/bin:" + (process.env.PATH || ""),
        PI_PROVIDER: resolved.provider,
        PIBOT_SUBAGENT_DEPTH: "0",
        PI_BOT_PERMISSION_POLICY: JSON.stringify(piPolicy) },
      def.spawn_env || {});
    // detached:true puts pi in its own process group so close() can SIGTERM
    // the whole tree (pi + its MCP children). Without this, killing pi leaves
    // its MCP server children (brave-search, google-workspace, github, etc.)
    // running indefinitely — observed leak of ~5 MCP procs per turn.
    this.proc = spawn(NODE, args, { cwd: sessionDir, env, stdio: ["pipe", "pipe", "pipe"], detached: true });
    this.events = []; this.responses = []; this.stderr = ""; this._b = ""; this._w = []; this.badStdout = 0;
    this.proc.stdout.on("data", (c) => {
      this._b += c.toString("utf8");
      let nl;
      while ((nl = this._b.indexOf("\n")) >= 0) {
        let ln = this._b.slice(0, nl); this._b = this._b.slice(nl + 1);
        if (ln.endsWith("\r")) ln = ln.slice(0, -1);
        if (!ln) continue;
        let m; try { m = JSON.parse(ln); } catch { this.badStdout++; continue; }
        (m.type === "response" ? this.responses : this.events).push(m);
        for (const w of this._w.slice()) if (w.p(m)) { this._w.splice(this._w.indexOf(w), 1); w.r(m); }
      }
    });
    this.proc.stderr.on("data", (d) => { this.stderr += d.toString(); });
    this.exited = new Promise((res) => this.proc.on("exit", (c) => res(c == null ? -1 : c)));
  }
  send(o) { this.proc.stdin.write(JSON.stringify(o) + "\n"); }
  waitFor(p, ms, label) {
    return new Promise((resolve, reject) => {
      const hit = this.events.find(p) || this.responses.find(p);
      if (hit) return resolve(hit);
      const w = { p, r: resolve }; this._w.push(w);
      setTimeout(() => { const i = this._w.indexOf(w); if (i >= 0) { this._w.splice(i, 1); reject(new Error("timeout:" + label + " (stderr " + this.stderr.slice(-200) + ")")); } }, ms);
    });
  }
  async prompt(message, ms, images) {
    this.send(Object.assign({ type: "prompt", message }, (images && images.length) ? { images } : {}));
    await this.waitFor((m) => m.type === "response" && m.command === "prompt", PROMPT_ACK_TIMEOUT_MS, "prompt-ack");
    return this.waitFor((m) => m.type === "agent_end", ms, "agent_end");
  }
  async getState() { this.send({ type: "get_state" }); return this.waitFor((m) => m.type === "response" && m.command === "get_state", 15000, "get_state"); }
  // Correlate by a unique per-call id: waitFor scans an ACCUMULATING responses
  // array, so without an id the second get_session_stats of a turn would match
  // the FIRST call's stale response (=> zero delta, silent no-op). pi echoes the
  // id we send (rpc-mode success()). getState tolerates the stale match only
  // because sessionId is invariant; token counts change per turn, so we can't.
  async getSessionStats() { const id = "stats_" + (this._statsSeq = (this._statsSeq || 0) + 1); this.send({ type: "get_session_stats", id }); return this.waitFor((m) => m.type === "response" && m.id === id && m.command === "get_session_stats", 15000, "get_session_stats"); }
  async abort() { this.send({ type: "abort" }); return this.waitFor((m) => m.type === "response" && m.command === "abort", 15000, "abort").catch(() => null); }
  assistantText() {
    let last = null; for (const e of this.events) if (e.type === "agent_end") last = e;
    const ms = last ? last.messages : this.events.filter((e) => e.type === "message_end").map((e) => e.message);
    let t = ""; for (const mm of ms || []) if (mm && mm.role === "assistant" && Array.isArray(mm.content))
      t += mm.content.filter((c) => c.type === "text").map((c) => c.text).join("");
    return t.trim();
  }
  toolCalls() { return this.events.filter((e) => e.type === "tool_execution_end").map((e) => ({ tool: e.toolName, isError: !!e.isError })); }
  async close() {
    try { this.proc.stdin.end(); } catch (e) {}
    const pid = this.proc.pid;
    // Kill the whole process group (pi + MCP children). Falls back to a
    // direct pi-only kill if the pgroup is already gone (e.g. pi crashed
    // before its children spawned, leaving no group to address).
    try { process.kill(-pid, "SIGTERM"); } catch (e) { try { this.proc.kill("SIGTERM"); } catch {} }
    const k = setTimeout(() => {
      try { process.kill(-pid, "SIGKILL"); } catch (e) { try { this.proc.kill("SIGKILL"); } catch {} }
    }, 5000);
    await this.exited;
    clearTimeout(k);
  }
}

export function loadBot(botId) {
  const c = db(CROW_DB);
  // M3b: project_id is now the column (not JSON). The JSON copy may still
  // exist for back-compat on legacy rows but is no longer authoritative.
  const row = c.prepare("SELECT bot_id, display_name, definition, enabled, project_id FROM pi_bot_defs WHERE bot_id=?").get(botId);
  c.close();
  if (!row) throw new Error("unknown bot " + botId);
  if (!row.enabled) throw new Error("bot " + botId + " disabled");
  return Object.assign({}, row, { def: JSON.parse(row.definition || "{}") });
}
// M3b: load the project_spaces row for a bot so the bridge can resolve a
// workspace_dir, tasks_db_uri, slug, and name to inject into the per-turn
// prompt. Returns null when projectId is unset or the project is missing /
// archived (in either case the bot falls back to legacy session_dir + env).
function loadProjectSpace(projectId) {
  if (projectId == null) return null;
  const c = db(CROW_DB);
  const r = c.prepare(
    "SELECT id, slug, name, workspace_dir, storage_prefix, tasks_db_uri, archived_at FROM project_spaces WHERE id=?"
  ).get(projectId);
  c.close();
  if (!r || r.archived_at) return null;
  return r;
}
// M3b: list active members with invoke_bot. Used both for the structured
// prompt context (the bot knows who can talk to it) and for audit attribution.
function loadProjectMembers(projectId) {
  if (projectId == null) return [];
  const c = db(CROW_DB);
  const rows = c.prepare(`
    SELECT pm.contact_id, pm.role, pm.capabilities,
           c.display_name, c.crow_id, c.email
      FROM project_members pm LEFT JOIN contacts c ON c.id = pm.contact_id
     WHERE pm.project_id = ? AND pm.revoked_at IS NULL
     ORDER BY pm.granted_at ASC
  `).all(projectId);
  c.close();
  return rows;
}
// M3b: appendAudit (mirror of the libsql helper in servers/shared/project-acl.js,
// but using the better-sqlite3 client the bridge already opens). Best-effort —
// failures must never break the primary action (the bot turn).
function appendAuditBridge(projectId, opts) {
  if (projectId == null) return;
  try {
    const c = db(CROW_DB);
    c.prepare(`
      INSERT INTO project_audit_log (project_id, actor_type, actor_id, action, target, payload)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      projectId,
      opts.actor_type || "bot",
      opts.actor_id || null,
      opts.action,
      opts.target || null,
      opts.payload == null ? null : (typeof opts.payload === "string" ? opts.payload : JSON.stringify(opts.payload))
    );
    c.close();
  } catch (e) {
    // never throw
  }
}
// kanbanText, cardStatus, getTrackerContext, resolveTrackerType — imported from tracker.mjs (S3)
// M3b: structured project-context block for the prompt. Replaces the bare
// "Project #N" interpolation in the legacy prompts; the bot now sees who
// can interact with it (member list filtered to invoke_bot=true), what
// backends are available, and where its workspace lives. The block is
// short — bots are line-budget sensitive.
function projectContextBlock(space, members) {
  if (!space) return "";
  const lines = [];
  lines.push("PROJECT: " + space.name + "  (id=" + space.id + ", slug=" + space.slug + ")");
  lines.push("  workspace: " + (space.workspace_dir || "(unset)"));
  if (space.storage_prefix) lines.push("  storage prefix: " + space.storage_prefix);
  if (members && members.length) {
    const summary = members.map((m) => {
      const who = m.contact_id == null ? "local user"
        : (m.display_name || m.email || m.crow_id || "contact");
      return who + " (" + m.role + ")";
    }).join(", ");
    lines.push("  members: " + summary);
  }
  return lines.join("\n");
}
function planFor(def, cardId) {
  const p = def.session_dir + "/plans/" + cardId + ".md";
  return { path: p, exists: existsSync(p), text: existsSync(p) ? readFileSync(p, "utf8") : "" };
}
function getSession(botId, threadId) {
  const c = db(CROW_DB);
  const r = c.prepare("SELECT * FROM bot_sessions WHERE bot_id=? AND gateway_thread_id=? ORDER BY id DESC LIMIT 1").get(botId, threadId);
  c.close(); return r || null;
}
function upsertSession(s) {
  const c = db(CROW_DB);
  if (s.id) {
    c.prepare("UPDATE bot_sessions SET pi_session_id=?, pi_session_dir=?, project_id=?, card_id=?, plan_path=?, status=?, control=?, model=?, escalated=?, kind=?, updated_at=datetime('now') WHERE id=?")
      .run(s.pi_session_id == null ? null : s.pi_session_id, s.pi_session_dir == null ? null : s.pi_session_dir, s.project_id == null ? null : s.project_id, s.card_id == null ? null : s.card_id, s.plan_path == null ? null : s.plan_path, s.status, s.control, s.model == null ? null : s.model, s.escalated == null ? 0 : (s.escalated ? 1 : 0), s.kind == null ? "chat" : s.kind, s.id);
  } else {
    const info = c.prepare("INSERT INTO bot_sessions (bot_id,pi_session_id,pi_session_dir,gateway_type,gateway_thread_id,project_id,card_id,plan_path,status,control,model,escalated,kind) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(s.bot_id, s.pi_session_id == null ? null : s.pi_session_id, s.pi_session_dir == null ? null : s.pi_session_dir, s.gateway_type || "gmail", s.gateway_thread_id, s.project_id == null ? null : s.project_id, s.card_id == null ? null : s.card_id, s.plan_path == null ? null : s.plan_path, s.status, s.control || "run", s.model == null ? null : s.model, s.escalated == null ? 0 : (s.escalated ? 1 : 0), s.kind == null ? "chat" : s.kind);
    s.id = info.lastInsertRowid;
  }
  c.close(); return s;
}
function parseCardIntent(msg) {
  const m = /\b(?:do\s+)?card\s*#?\s*(\d+)\b/i.exec(msg) || /\bexecute\s+#?(\d+)\b/i.exec(msg);
  return m ? Number(m[1]) : null;
}

export async function handleInbound(opts) {
  const bot_id = opts.bot_id, gateway_thread_id = opts.gateway_thread_id, user_message = opts.user_message;
  // Gateway-agnostic: the inbound adapter (gmail bridge_tick, discord_gateway)
  // declares its transport. Defaults to gmail for legacy callers that omit it.
  const gateway_type = opts.gateway_type || "gmail";
  const sendReply = opts.sendReply, log = opts.log || function () {};
  // Phase 3.0 (R4): operator-driven escalation via a bounded, inbound-only
  // `!escalate` token. Detect on the RAW inbound, then strip it so it never
  // reaches the model prompt or persists in the pi session transcript.
  const escalate = escalateRequested(user_message);
  const cleanMsg = stripEscalateToken(user_message);
  const bot = loadBot(bot_id);
  const def = bot.def;
  // Active Crow instance home (CROW_HOME env -> ~/.crow-mpa on MPA, else
  // ~/.crow). Governs per-instance skills + mcp-addons resolution; the DB
  // still routes on CROW_DB_PATH (above), independent of this.
  const crowHome = resolveCrowHome();
  // M3b atomic cutover: column is authoritative. JSON copy is ignored even
  // if present (legacy fixtures may still carry it; new bots don't write it).
  const projectId = bot.project_id == null ? null : Number(bot.project_id);
  const projectSpace = loadProjectSpace(projectId);
  const projectMembers = loadProjectMembers(projectId);
  // session_dir resolution: prefer the project workspace when available
  // (new project-native bots). Legacy bots without a project_space row, or
  // whose row has no workspace_dir, fall back to def.session_dir (the
  // pre-M3 ~/.crow-mpa/pi-bots/<bot_id>/ path).
  const sessionDir = (projectSpace && projectSpace.workspace_dir)
    ? (projectSpace.workspace_dir + "/bots/" + bot_id)
    : def.session_dir;
  const tasksDbPath = (projectSpace && projectSpace.tasks_db_uri) || TASKS_DB;
  mkdirSync(sessionDir + "/sessions", { recursive: true });

  // Keep the per-bot <sessionDir>/.mcp.json in sync with the def on every
  // turn (best-effort; additive merge — homedir ~/.pi/agent/mcp.json still
  // wins on collision, so a writer hiccup can never break a turn). Primary
  // writer is the GUI save handler; this is the defensive backstop.
  // M3b: pass the resolved sessionDir (which may differ from def.session_dir
  // when the bot has a project_space workspace) so the .mcp.json lives next
  // to where pi actually runs.
  // F4a L2b: read the remote_invocation flag + trusted peer gateway URLs once
  // (local-only, default off). With the flag off, remoteEnabled=false ⇒
  // writeBotMcp mints no remote blocks and toolAllowlist adds no remote entries
  // ⇒ live bots are byte-identical to today. Reads never throw.
  const _conn = db(CROW_DB);
  let remoteEnabled = false, peerGatewayUrls = {};
  try {
    remoteEnabled = readRemoteInvocationEnabled(_conn);
    if (remoteEnabled) peerGatewayUrls = readPeerGatewayUrls(_conn);
  } finally { _conn.close(); }
  try {
    const w = writeBotMcp(def, { sessionDir, crowHome, remoteEnabled, peerGatewayUrls });
    if (w.warnings.length) log("mcp.json warnings: " + w.warnings.join("; "));
    if (w.remoteWarnings && w.remoteWarnings.length) {
      for (const warn of w.remoteWarnings) log("remote-tool: " + warn);
    }
    if (w.journalGuarded.length) log("mcp.json journal-guarded: " + w.journalGuarded.join(","));
    if (w.minted && w.minted.length) log("mcp.json minted from extensions: " + w.minted.join(","));
  } catch (e) {
    log("per-bot mcp.json write skipped (non-fatal): " + (e && e.message || e));
  }

  // Install-approval gate (Phase 2.4): refuse non-allowlisted pi_extensions
  // that reached pi_bot_defs via an out-of-band DB edit (the GUI only offers
  // allowlisted ones). The bridge NEVER runs `pi install`; pi-lab is the
  // fixed package set. This is an audit/refusal surface, not a turn-killer.
  const extCheck = validateExtensions((def.tools && def.tools.pi_extensions) || []);
  if (extCheck.rejected.length) {
    log("REFUSED non-allowlisted pi_extensions: " + extCheck.rejected.join(", ") +
      " — Bot Builder never runs `pi install`; add via the pi-lab repo + scripts/pi-bots/pi_extensions_allowlist.mjs");
  }

  let session = getSession(bot_id, gateway_thread_id);
  if (session && session.control === "stop") {
    session.status = "stopped"; upsertSession(session);
    await sendReply("Session is stopped. Reply 'resume' to continue.");
    return { action: "stopped" };
  }

  const wantCard = parseCardIntent(cleanMsg);
  const resume = !!(session && session.pi_session_id);

  if (wantCard != null) {
    const st = cardStatus(wantCard, tasksDbPath);
    if (st === "done") {
      log("card " + wantCard + " already done — no re-exec");
      if (!session) session = upsertSession({ bot_id, gateway_thread_id, gateway_type, project_id: projectId, status: "waiting-user" });
      await sendReply("Card #" + wantCard + " is already done — nothing to do.");
      return { action: "noop-done", cardId: wantCard };
    }
  }

  // Global pi concurrency gate (plan §10 risk #4). Spawn-per-turn normally
  // keeps <=1 live pi; refuse to pile on past the cap. Return WITHOUT mutating
  // bot_sessions so the next bridge tick reprocesses this same inbound (the
  // tick keys "processed" off bot_sessions.updated_at, which we leave stale).
  const livePi = countLivePi();
  if (livePi >= LIFECYCLE_DEFAULTS.maxPi) {
    log("pi capacity reached (" + livePi + "/" + LIFECYCLE_DEFAULTS.maxPi + ") — deferring; tick will retry");
    return { action: "deferred", reason: "pi-capacity", livePi };
  }

  const sysFile = join(mkdtempSync(join(tmpdir(), "pibot-")), "sys.md");
  writeFileSync(sysFile, def.system_prompt || "You are a Crow bot.", { mode: 0o600 });

  // Append the content of each configured skill file to the system prompt.
  // def.skills[] is saved by the Bot Builder but was never consumed here —
  // bots with skills (e.g. pir-portal-runner: govqa-portal, oag-portal) ran
  // without them. A3: resolved per-instance via skill_resolver — first match
  // across <crowHome>/skills, ~/.crow/skills, ~/crow/skills wins.
  const { sections: skillSections, missing: missingSkills } =
    resolveSkills(def.skills || [], { crowHome });
  for (const s of skillSections) appendFileSync(sysFile, "\n\n" + s.text);
  for (const name of missingSkills) {
    log("skill file not found for '" + name + "' in " + skillDirs(crowHome).join(", "));
  }

  // Slice C — opt-in self-authoring. When permission_policy.self_authoring is
  // true, the bot MAY draft a new skill into a CONFINED staging dir. The dir is
  // keyed on def.session_dir (NOT the resolved sessionDir, which for a
  // project-native bot is <workspace>/bots/<id>) so it is the exact location the
  // Bot Builder review UI scans — no write-here/scan-there split. We mkdir it,
  // make it writable for the write tool (PiRpc augments write_paths below), and
  // inject the directive + full skill-writing guidance into the system prompt.
  // A staged file stays INERT (skill_resolver loads only by name from the skill
  // dirs, never from the staging dir; not in def.skills) until an operator
  // approves it. OFF => none of this happens; the bot is neither told nor tooled
  // to propose.
  let selfAuthoringDir = null;
  if (def.permission_policy && def.permission_policy.self_authoring === true && def.session_dir) {
    const stagingDir = proposalsDir(def.session_dir);
    // Safety: a staging dir that coincided with a real skill dir would make a
    // raw proposal loadable. Under defaults they never collide; refuse if they would.
    const dirs = skillDirs(crowHome);
    const collides = dirs.some((d) => stagingDir === d || stagingDir.startsWith(d + "/") || d.startsWith(stagingDir + "/"));
    if (collides) {
      log("self_authoring: refusing — staging dir " + stagingDir + " collides with a skill dir; skipped");
    } else {
      mkdirSync(stagingDir, { recursive: true });
      selfAuthoringDir = stagingDir;
      // Full skill-writing guidance once (dedupe if the operator also attached it).
      if (!(def.skills || []).includes("skill-writing")) {
        const sw = resolveSkill("skill-writing", { crowHome });
        if (sw) appendFileSync(sysFile, "\n\n" + sw.text);
        else log("self_authoring: skill-writing.md not found in " + dirs.join(", "));
      }
      appendFileSync(sysFile, "\n\n" + selfAuthoringPromptBlock(stagingDir));
    }
  }

  const cardId = wantCard != null ? wantCard : (session ? session.card_id : null);
  // planFor still pulls from def.session_dir for legacy compatibility (where
  // existing plan files live). Project-native bots that get a project_space
  // workspace will accumulate plans under <workspace>/bots/<bot_id>/plans/
  // once any are written; for the transition we look in both locations.
  const plan = cardId != null ? planFor(def, cardId) : { path: null, exists: false, text: "" };

  // M3b: structured project header replaces the bare "Project #N" string.
  // Falls back to a one-liner for legacy bots with no project_spaces row.
  // M4 (job-searcher Step 0): also surface the gateway_thread_id so the bot
  // can pass it verbatim to gmail_create_draft and stay threaded with the
  // user. Without this line the bot has no way to discover its own thread.
  // Gateway-type-aware reply hint. Gmail bots draft into a thread via
  // gmail_create_draft and must echo the thread_id; Discord bots have their
  // reply auto-posted by discord_gateway's sendReply, so they must NOT reach
  // for gmail tools.
  // A1.3: gateway hints now come from the registry (gateways/index.mjs), which
  // reproduces the gmail/discord strings byte-for-byte (verified — cache-prefix
  // stability) and serves telegram/slack/fallback hints for the new adapters.
  const gatewayHint = resolveGatewayHint(gateway_type, gateway_thread_id);
  const projectHeader = (projectSpace
    ? projectContextBlock(projectSpace, projectMembers)
    : (projectId != null ? "PROJECT #" + projectId + " (no space metadata)" : "PROJECT: (none)"))
    + gatewayHint;

  let promptText;
  if (cardId != null) {
    // Explicit card reference — full work-the-card workflow.
    promptText = projectHeader + "\n\nWork the following card.\n\nCARD #" + cardId +
      " (current board status: " + cardStatus(cardId, tasksDbPath) + ").\nPLAN FILE (" + plan.path + "):\n---\n" +
      (plan.text || "(plan file missing)") + "\n---\n\nUser said: \"" + cleanMsg + "\"\n\n" +
      "Do the work the plan describes. Use the tasks_* tools (scoped to project " + projectId +
      ") to set this card in_progress, then done. Use the write/edit tools to record your result " +
      "under the plan file's \"## Result\" section. When finished, reply with a short summary for " +
      "the gateway thread. One card only.";
  } else {
    // No card reference — let the bot DECIDE based on its system prompt
    // whether to (a) answer briefly without tools (greet, list cards, simple
    // chit-chat), or (b) call appropriate tools to answer a substantive
    // question (e.g. "what's my criteria?" → call bot_preferences_get; "any
    // shortlisted candidates?" → call job_candidates_query; "do a scout
    // pass" → run the full workflow). Previous template hard-banned tool
    // use here which made the bot useless for anything except "do card N".
    const trackerBlock = getTrackerContext(def, projectId, tasksDbPath);
    promptText = projectHeader + (trackerBlock ? "\n\n" + trackerBlock : "") + "\n\n" +
      "User said: \"" + cleanMsg + "\"\n\n" +
      "Reply on the gateway thread. Use tools as needed per your system " +
      "prompt: if the user asks a simple question (criteria, status, " +
      "specific employer), call the appropriate query tools and answer; " +
      "if the user asks for work to be done, run the workflow; if they're " +
      "just saying hi, reply briefly without tools. Don't ask 'which card?' " +
      "unless their message is genuinely ambiguous.";
  }

  // Phase 3.0 (R3/R4/R5): resolve provider/model for THIS turn. R4: if an
  // escalation flips the model vs the session's recorded one, force a FRESH
  // pi session — resuming a session created under a different provider/model
  // is an unproven pi path. `resume` still shapes the prompt (conversation
  // continuity); `effectiveResume` alone decides pi's `--session`.
  const resolved = await resolveModel(def, { escalate });
  const forceNew = escalate && resume && ((session && session.model) || null) !== resolved.key;
  const effectiveResume = resume && !forceNew;
  // R5: the ONE deterministic escalation-proof observable (get_state does NOT
  // echo the model — it returns sessionId/messageCount only).
  log("model-resolve bot=" + bot_id + " provider=" + resolved.provider + " model=" + resolved.model +
    " escalated=" + resolved.escalated + " source=" + resolved.source +
    " session=" + (effectiveResume ? "resume" : "new") + (forceNew ? " (forced-new: model changed)" : ""));

  session = upsertSession(Object.assign({}, session || {}, {
    bot_id, gateway_thread_id, gateway_type, project_id: projectId,
    card_id: cardId == null ? null : cardId, plan_path: plan.path,
    pi_session_dir: sessionDir + "/sessions", status: "active", control: "run",
    model: resolved.key, escalated: resolved.escalated ? 1 : 0,
  }));

  // Warm the resolved model bundle before spawning pi (same as runJob). The
  // bridge is a separate process from the gateway, so it warms over HTTP via
  // POST /llm/acquire; without this a cold on-demand model (:8003) makes pi
  // return "Connection error" → "(no reply)" on Discord/Gmail. Non-fatal.
  await warmModel(resolved.provider, log);

  const pi = new PiRpc({ def, sessionDir, resolved, selfAuthoringDir, remoteEnabled,
    piSessionId: effectiveResume ? session.pi_session_id : null, appendSystemPromptFile: sysFile });
  let result;
  // B1: captured on a successful turn so the post-turn skill review (fired AFTER
  // pi.close(), so the idle-only gate sees a clean slate) has the transcript.
  let postTurn = null;
  try {
    const st0 = await pi.getState().catch(() => null);
    const stats0 = await pi.getSessionStats().catch(() => null);
    await pi.prompt(promptText, TURN_TIMEOUT_MS, opts.images);
    const st1 = await pi.getState().catch(() => null);
    const stats1 = await pi.getSessionStats().catch(() => null);
    const piSessionId = (st1 && st1.data && st1.data.sessionId) || (st0 && st0.data && st0.data.sessionId) || (effectiveResume ? session.pi_session_id : null) || null;
    const text = pi.assistantText() || "(no reply)";
    const calls = pi.toolCalls();
    postTurn = { user: cleanMsg, assistant: text, toolNames: calls.map((c) => c.tool) };
    const newCardStatus = cardId != null ? cardStatus(cardId, tasksDbPath) : null;
    // Board–plan unification: fold the bot-written status back onto the
    // canonical stage column (single reconciliation point). Guarded on the
    // column existing so pre-migration instances are untouched.
    if (cardId != null && newCardStatus != null) {
      try {
        const t = db(tasksDbPath);
        try {
          const have = t.prepare("PRAGMA table_info(tasks_items)").all().map((c) => c.name);
          if (have.includes("stage")) {
            const cur = t.prepare("SELECT stage FROM tasks_items WHERE id=?").get(cardId);
            t.prepare("UPDATE tasks_items SET stage=? WHERE id=?")
              .run(statusToStage(newCardStatus, cur && cur.stage), cardId);
          }
        } finally { t.close(); }
      } catch (e) { log("stage reconcile skipped (non-fatal): " + (e && e.message || e)); }
    }
    const status = newCardStatus === "done" ? "done" : "waiting-user";
    session.pi_session_id = piSessionId;
    session.status = status; session.control = "run";
    session.model = resolved.key; session.escalated = resolved.escalated ? 1 : 0;
    upsertSession(session);
    // Phase 1.4: meter this bot turn (surface=bot) into usage_events via the
    // shared recordUsageEvent path. Best-effort — never breaks a turn. Uses a
    // short-lived busy_timeout-only connection (same discipline as appendAuditBridge;
    // NOT createDbClient, which would WAL-flip the prod crow.db).
    try {
      const mconn = db(CROW_DB);
      try {
        await meterBotTurn({
          conn: mconn, statsBefore: stats0 && stats0.data, statsAfter: stats1 && stats1.data,
          resolved, surface: "bot", requestId: piSessionId, log,
        });
      } finally { mconn.close(); }
    } catch (e) {
      log("[metering] bot usage record failed (non-fatal): " + ((e && e.message) || e));
    }
    // R12: the Gmail operator never sees stderr — if escalation was asked
    // for but no escalation model is configured, say so in-band.
    const notice = resolved.escalationRequestedButUnavailable
      ? "(note: escalation requested but no escalation model is configured for this bot; ran on " + resolved.key + ")\n\n"
      : "";
    await sendReply(notice + text);
    result = { action: cardId != null ? "executed" : "asked", cardId, cardStatus: newCardStatus,
      piSessionId, toolCalls: calls, replyPreview: text.slice(0, 120), stdoutClean: pi.badStdout === 0 };
    // M3b: audit every bot turn so the project timeline records what happened.
    // bot is the actor; project_audit_log shows human + bot events in one feed.
    // M4 (job-searcher Step 0): also record the LIST of tool names invoked
    // (not just the count) so the audit row is inspectable without tailing the
    // pi session JSONL — verification check #10 reads payload.tool_names.
    appendAuditBridge(projectId, {
      actor_type: "bot", actor_id: bot_id, action: "bot.invoke",
      target: cardId != null ? ("card:" + cardId) : ("thread:" + gateway_thread_id),
      payload: {
        action: result.action,
        card_status: newCardStatus,
        tool_calls: calls.length,
        tool_names: calls.map((c) => c.tool),
        model: resolved.key,
        escalated: resolved.escalated ? 1 : 0,
        session_id: session.id,
      },
    });
    log("turn done: action=" + result.action + " card=" + cardId + " status=" + newCardStatus + " tools=" + calls.length + " clean=" + result.stdoutClean);
  } catch (e) {
    session.status = "error";
    session.model = resolved.key; session.escalated = resolved.escalated ? 1 : 0;
    upsertSession(session);
    const notice = resolved.escalationRequestedButUnavailable
      ? "(note: escalation requested but no escalation model is configured for this bot; ran on " + resolved.key + ")\n\n"
      : "";
    await sendReply(notice + "(bridge error: " + e.message + ")");
    result = { action: "error", error: e.message };
    appendAuditBridge(projectId, {
      actor_type: "bot", actor_id: bot_id, action: "bot.error",
      target: cardId != null ? ("card:" + cardId) : ("thread:" + gateway_thread_id),
      payload: { error: String(e.message || e), model: resolved.key },
    });
  } finally {
    await pi.close();
  }
  // B1: post-turn self-learning review. Fire-and-forget — do NOT await (it must
  // never delay this turn's return or the next queued turn). It self-gates on
  // skill_learning mode + the idle-only countLivePi()===0 check, so a no-op turn
  // costs nothing. pi is already closed, so on an otherwise-idle node the gate
  // sees 0 live pi. Errors are swallowed inside runSkillReview.
  if (postTurn && (result.action === "asked" || result.action === "executed")) {
    runSkillReview({ bot_id, def, crowHome, sessionDir, transcript: postTurn,
      log: (m) => log("[skill-review] " + m) }).catch(() => {});
  }
  return result;
}

// Board plan dispatch (Plan 1 Task 7): spawn a CONFINED local-model planning
// run against the card's project repo. Structural guarantees (spec §Safety):
// resolved provider MUST be crow-local (no config knob reaches a paid model);
// write_paths = [<repo>/.pi/plans, <repo>/docs] + bash deny; bot_sessions row
// kind='planning' takes the same single-writer lock as execution.
export async function planCard(opts) {
  const cardId = Number(opts.cardId), botId = String(opts.botId);
  const log = opts.log || function () {};
  const bot = loadBot(botId);
  const def = bot.def;
  const projectId = bot.project_id == null ? null : Number(bot.project_id);
  const projectSpace = loadProjectSpace(projectId);

  // Same tasks-db resolution as handleInbound (project override wins).
  const cardsDb = (projectSpace && projectSpace.tasks_db_uri) || TASKS_DB;
  const t = db(cardsDb);
  const card = t.prepare("SELECT id, title, description, project_id FROM tasks_items WHERE id=?").get(cardId);
  t.close();
  if (!card) return { action: "error", error: "card not found" };

  const repoRoot = projectSpace && projectSpace.repo_path ? String(projectSpace.repo_path) : null;
  if (!repoRoot || !existsSync(repoRoot)) {
    return { action: "error", error: "project has no repo_path (workspace plan dispatch is not in v1 — edit the plan in the drawer)" };
  }

  if (countLivePi() >= LIFECYCLE_DEFAULTS.maxPi) return { action: "deferred", reason: "pi-capacity" };

  const resolved = await resolveModel(def, { escalate: false });
  if (String(resolved.provider) !== "crow-local") {
    return { action: "error", error: "plan dispatch is local-only; bot resolves to " + resolved.provider + "/" + resolved.model };
  }

  const sysFile = join(mkdtempSync(join(tmpdir(), "pibot-plan-")), "sys.md");
  writeFileSync(sysFile, "You are a careful software planner. You explore code read-only and write ONE plan file.", { mode: 0o600 });

  // Planning session takes the card lock: kind='planning', status active.
  let session = upsertSession({
    bot_id: botId, gateway_thread_id: "board-plan-" + cardId, gateway_type: "board",
    project_id: projectId, card_id: cardId, plan_path: null,
    pi_session_dir: repoRoot + "/.pi/board-planning", status: "active", control: "run",
    model: resolved.key, escalated: 0, kind: "planning",
  });
  let pi;
  try {
    mkdirSync(repoRoot + "/.pi/board-planning", { recursive: true });

    // Confinement belt: write_paths limited to plans+docs, bash denied. The
    // stored def's policy is NOT used — planning is stricter than the bot.
    const planningDef = Object.assign({}, def, {
      permission_policy: { bash: "deny", write_paths: [repoRoot + "/.pi/plans", repoRoot + "/docs"] },
      spawn_env: def.spawn_env || {},
      tools: def.tools,
    });
    await warmModel(resolved.provider, log);
    pi = new PiRpc({ def: planningDef, sessionDir: repoRoot + "/.pi/board-planning",
      resolved, piSessionId: null, appendSystemPromptFile: sysFile });
  } catch (e) {
    session.status = "error"; upsertSession(session);
    return { action: "error", error: e.message };
  }
  try {
    await pi.prompt(buildPlanPrompt(card, ".pi/plans"), TURN_TIMEOUT_MS);
    const text = pi.assistantText();
    const rel = extractPlanFileLine(text);
    if (!rel || !existsSync(repoRoot + "/" + rel)) {
      session.status = "error"; upsertSession(session);
      return { action: "error", error: "planning run produced no verifiable PLAN_FILE (reply tail: " + text.slice(-200) + ")" };
    }
    const planRef = { kind: "repo", path: rel };
    const t2 = db(cardsDb);
    t2.prepare("UPDATE tasks_items SET plan_ref=?, stage='ready', status='pending', updated_at=datetime('now') WHERE id=?")
      .run(JSON.stringify(planRef), cardId);
    t2.close();
    session.status = "done"; upsertSession(session);
    appendAuditBridge(projectId, {
      actor_type: "bot", actor_id: botId, action: "bot.plan",
      target: "card:" + cardId, payload: { plan_ref: planRef, model: resolved.key },
    });
    return { action: "planned", planRef };
  } catch (e) {
    session.status = "error"; upsertSession(session);
    return { action: "error", error: e.message };
  } finally {
    await pi.close();
  }
}

export function stopSession(botId, threadId) {
  const s = getSession(botId, threadId);
  if (!s) return { ok: false, reason: "no session" };
  s.control = "stop"; s.status = "stopped"; upsertSession(s);
  return { ok: true, sessionId: s.id };
}

if (import.meta.url === "file://" + process.argv[1]) {
  const a = process.argv.slice(2);
  if (a.includes("--stop")) {
    const bot = a[a.indexOf("--bot") + 1], thread = a[a.indexOf("--thread") + 1];
    console.log(JSON.stringify(stopSession(bot, thread))); process.exit(0);
  }
  if (a.includes("--plan-card")) {
    const payload = JSON.parse(a[a.indexOf("--plan-card") + 1]);
    planCard(Object.assign({}, payload, { log: (m) => console.error("[plan] " + m) }))
      .then((r) => { console.log("RESULT " + JSON.stringify(r)); process.exit(r.action === "error" ? 1 : 0); })
      .catch((e) => { console.error("PLAN CRASH " + e.stack); process.exit(2); });
  } else {
    const inj = a[a.indexOf("--inject") + 1];
    if (!inj) { console.error("usage: bridge.mjs --inject '<json>' | --stop --bot B --thread T | --plan-card '<json>'"); process.exit(2); }
    const payload = JSON.parse(inj);
    handleInbound(Object.assign({}, payload, {
      log: (m) => console.error("[bridge] " + m),
      sendReply: async (t) => console.log("REPLY>>>\n" + t + "\n<<<REPLY"),
    })).then((r) => { console.log("RESULT " + JSON.stringify(r)); process.exit(r.action === "error" ? 1 : 0); })
      .catch((e) => { console.error("BRIDGE CRASH " + e.stack); process.exit(2); });
  }
}
