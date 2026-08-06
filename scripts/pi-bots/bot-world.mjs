#!/usr/bin/env node
/**
 * Crow Bot Builder — per-turn WORLD BUILDER (Perch Hub P2, C-11).
 *
 * Every bot turn — gmail, discord, telegram, slack, perch — assembles the same
 * "world" before it can spawn pi: which bot, which project space, which session
 * dir, which .mcp.json, which prior session row, then the system-prompt file,
 * the resolved model, and the PiRpc options. That assembly lived inline in
 * bridge.mjs's handleInbound(); P2's interactive engine needs the SAME world
 * without the per-turn channel semantics wrapped around it.
 *
 * So it is extracted here, VERBATIM, in two phases:
 *
 *   A. buildBotWorld()  — identity. Everything up to and including the session
 *      lookup. Side effects (in this exact order, unchanged): mkdir the sessions
 *      dir, read the remote-invocation flag, write the per-bot .mcp.json,
 *      refuse non-allowlisted pi_extensions.
 *   B. prepareSpawn()   — spawn readiness. The system-prompt file (system_prompt
 *      + skills + the opt-in self-authoring block), the per-turn model
 *      resolution, and the PiRpc option bag.
 *
 * What is NOT here, deliberately: everything channel-shaped — the stop-control
 * check, card parsing, the pi capacity gate, prompt templates + gateway hints,
 * the session upsert, warmModel, metering, audit, the post-turn skill review,
 * sendReply semantics, the deferral protocol. Those stay in handleInbound.
 *
 * BYTE-IDENTITY: `tests/bot-world.test.js` is a golden fixture recorded against
 * the PRE-extraction bridge — argv, PI_/PIBOT_ env, the sha256 of the system
 * prompt file, and the prompt text, for a fresh gmail turn, a resumed gmail
 * turn, a discord turn, and a job_runner spawn. If you change anything in this
 * file, that fixture is the thing that decides whether you were allowed to.
 *
 * CYCLE NOTE: bridge.mjs imports THIS module statically; this module imports
 * bridge.mjs LAZILY inside the functions (the same shape as perch.js's
 * loadBridge()). Everything taken from bridge is part of its public export
 * surface — which job_runner.mjs also consumes, so those names are stable.
 */
import { mkdirSync, writeFileSync, appendFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeBotMcp } from "./mcp_writer.mjs";
import { validateExtensions } from "./pi_extensions_allowlist.mjs";
import { resolveModel } from "./model_resolver.mjs";
import { resolveSkills, resolveSkill, skillDirs } from "./skill_resolver.mjs";
import { resolveCrowHome } from "./ext_registry.mjs";
import { proposalsDir, selfAuthoringPromptBlock } from "./skill_proposals.mjs";

/** Lazy bridge handle — see the CYCLE NOTE above. */
function loadBridge() { return import("./bridge.mjs"); }

/**
 * Phase A — identity. The exact sequence handleInbound ran inline before C-11.
 *
 * @param {{botId: string, threadId: string, gatewayType?: string,
 *          log?: (m: string) => void}} opts
 * @returns {Promise<{def, bot, crowHome, projectId, projectSpace, projectMembers,
 *          sessionDir, tasksDbPath, remoteEnabled, peerGatewayUrls, session,
 *          narrowedTools, gatewayType}>}
 */
export async function buildBotWorld({ botId, threadId, gatewayType = "perch", log = () => {} }) {
  const B = await loadBridge();
  const bot = B.loadBot(botId);
  const def = bot.def;
  // Active Crow instance home (CROW_HOME env -> ~/.crow-mpa on MPA, else
  // ~/.crow). Governs per-instance skills + mcp-addons resolution; the DB
  // still routes on CROW_DB_PATH, independent of this.
  const crowHome = resolveCrowHome();
  // M3b atomic cutover: column is authoritative. JSON copy is ignored even
  // if present (legacy fixtures may still carry it; new bots don't write it).
  const projectId = bot.project_id == null ? null : Number(bot.project_id);
  const projectSpace = B.loadProjectSpace(projectId);
  const projectMembers = B.loadProjectMembers(projectId);
  // session_dir resolution: prefer the project workspace when available
  // (new project-native bots). Legacy bots without a project_space row, or
  // whose row has no workspace_dir, fall back to def.session_dir (the
  // pre-M3 ~/.crow-mpa/pi-bots/<bot_id>/ path).
  const sessionDir = (projectSpace && projectSpace.workspace_dir)
    ? (projectSpace.workspace_dir + "/bots/" + botId)
    : def.session_dir;
  const tasksDbPath = (projectSpace && projectSpace.tasks_db_uri) || B.TASKS_DB;
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
  const _conn = B.db(B.CROW_DB);
  let remoteEnabled = false, peerGatewayUrls = {};
  try {
    remoteEnabled = B.readRemoteInvocationEnabled(_conn);
    if (remoteEnabled) peerGatewayUrls = B.readPeerGatewayUrls(_conn);
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

  const session = B.getSession(botId, threadId);
  // C-6: the same SELECT * that resolves pi_session_id also carries this
  // session's saved narrowing (Perch writes it; Bot Builder still owns the
  // envelope). NULL on every non-perch row => PiRpc sees undefined => the
  // spawn args are byte-identical to what shipped before.
  const narrowedTools = session && session.narrowed_tools != null ? session.narrowed_tools : null;

  // gatewayType is carried through inert (no behavior depends on it here) so a
  // caller that only holds the world still knows which channel asked for it.
  return { def, bot, crowHome, projectId, projectSpace, projectMembers, sessionDir,
    tasksDbPath, remoteEnabled, peerGatewayUrls, session, narrowedTools, gatewayType };
}

/**
 * Phase B — spawn readiness. The system-prompt file, the resolved model, and
 * the PiRpc option bag. The CALLER adds piSessionId (the resume decision is
 * channel policy, not world state) and any test seams.
 *
 * @param {object} world  the object buildBotWorld() returned
 * @param {{escalate?: boolean, log?: (m: string) => void}} [opts]
 * @returns {Promise<{sysFile, selfAuthoringDir, resolved, piRpcOpts}>}
 */
export async function prepareSpawn(world, { escalate = false, log = () => {} } = {}) {
  const def = world.def, crowHome = world.crowHome;

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

  // Phase 3.0 (R3/R4/R5): resolve provider/model for THIS turn.
  const resolved = await resolveModel(def, { escalate });

  return {
    sysFile,
    selfAuthoringDir,
    resolved,
    piRpcOpts: {
      def,
      sessionDir: world.sessionDir,
      resolved,
      selfAuthoringDir,
      remoteEnabled: world.remoteEnabled,
      narrowedTools: world.narrowedTools,
      appendSystemPromptFile: sysFile,
    },
  };
}
