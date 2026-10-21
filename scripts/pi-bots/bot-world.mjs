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
import { normalizeStoredBashPolicy, resolveClassifierEndpoint } from "../../servers/shared/bot-bash-policy.js";
import { readBotClassifierSync } from "./bot-classifier.mjs";
import { mkdirSync, writeFileSync, appendFileSync, mkdtempSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeBotMcp, removeStaleBotMcp } from "./mcp_writer.mjs";
import { validateExtensions } from "./pi_extensions_allowlist.mjs";
import { resolveModel } from "./model_resolver.mjs";
import { checkPiModel, PiModelUnavailableError } from "./pi-model-catalog.mjs";
import { resolveSkills, resolveSkill, skillDirs } from "./skill_resolver.mjs";
import { resolveCrowHome } from "./ext_registry.mjs";
import { proposalsDir, selfAuthoringPromptBlock } from "./skill_proposals.mjs";
import { mcpConfigDelivery } from "./mcp-delivery.mjs";
import { worldRootFor, carriedReadRoots, brokenWorldLink } from "./world-root.mjs";
import { installedKitDir, readKitThemes, readHouseStyleSync, houseStyleLinks } from "../../servers/shared/design-kit.js";

/** Lazy bridge handle — see the CYCLE NOTE above. */
function loadBridge() { return import("./bridge.mjs"); }

/**
 * Does this def's crow_mcp selection grant `server` — whole (`artifacts`),
 * per tool (`artifacts/artifact_create`) or in the bridge's toolAllowlist
 * spelling (`artifacts__artifact_create`)? This is a COPY of the artifacts
 * bundle's grantsServer() (bundles/artifacts/server/delivery.js): core must
 * not import a bundle, and tests/bot-world-artifacts-skill.test.js pins the
 * two against each other so they cannot drift.
 */
export function botGrantsServer(def, server) {
  const list = (def && def.tools && def.tools.crow_mcp) || [];
  return list.some((e) => typeof e === "string" && (e === server || e.startsWith(server + "/") || e.startsWith(server + "__")));
}

/**
 * Artifacts smoke fixes S2a (review M7): `artifact_update` is answered with
 * `needs_link` from an unlinked Perch chat, and the way out is
 * `artifact_attach` (plus `artifact_find` to name the artifact). A def that
 * grants Update per tool therefore also needs those two. PURE: returns a new
 * list with any missing companion appended; a whole-server `artifacts` grant
 * (which already covers them) or a list without Update is returned as is.
 * Callers (scripts/pi-bots/artifacts-companions.mjs) write the result INTO the
 * stored def — never at runtime — so every crow_mcp consumer sees it.
 */
const ART_COMPANIONS = ["artifact_find", "artifact_attach"];
export function withArtifactsCompanions(crowMcp) {
  const list = Array.isArray(crowMcp) ? crowMcp.slice() : [];
  const has = (tool) => list.includes(`artifacts/${tool}`) || list.includes(`artifacts__${tool}`);
  if (list.includes("artifacts") || !has("artifact_update")) return list;
  for (const t of ART_COMPANIONS) if (!has(t)) list.push(`artifacts/${t}`);
  return list;
}

/**
 * Design kit (spec §3.1, §4.3, §4.4; review H2). The kit mode is THIS
 * instance's install state (installedKitDir), passed in as kitInstalled and
 * stated in the prompt by kitModeLine — never inferred from which skill files
 * resolve (the resolver also searches the repo skills/ dir). Kit skills are
 * attached only from <crowHome>/skills itself; since the 2026-10-16 skills
 * audit the resolver no longer reads the main instance's ~/.crow/skills from
 * another instance at all. design-poster is attached only when the operator
 * selects it (review L9: spawn size).
 */
export const DESIGN_SKILLS = Object.freeze(["design-frontend"]);
/** Every skill the Design kit ships: dropped from a kit-less instance's spawn
 *  by exact name (another design-* skill is the operator's own and stays). */
export const KIT_SKILLS = Object.freeze(["design-frontend", "design-themes", "design-poster"]);
export const kitModeLine = (installed) => (installed ? "Design kit: installed" : "Design kit: not installed");
/**
 * The skill names a spawn inlines, in order. F4 (Artifacts acceptance smoke):
 * a bot whose tools grant the Artifacts server ran WITHOUT the protocol skill
 * unless the operator had attached it by hand — it tried to `read` the skill
 * file itself, the sandbox refused, and the model improvised (write +
 * send_user_file instead of artifact_create). The skill text is inlined HERE,
 * gateway-side (the child never reads the file), so the grant itself now
 * attaches the skill: an explicit def selection wins, a missing skill file
 * (bundle not installed on this instance) adds nothing and stays quiet.
 */
export function skillNamesFor(def, { crowHome, kitInstalled = false, houseStyle = null } = {}) {
  const names = [...(def.skills || [])].filter((n) => kitInstalled || !KIT_SKILLS.includes(n));
  if (!botGrantsServer(def, "artifacts")) return names;
  if (!names.includes("artifacts") && resolveSkill("artifacts", { crowHome })) names.push("artifacts");
  if (!kitInstalled || !crowHome) return names;
  const own = (n) => existsSync(join(crowHome, "skills", `${n}.md`));
  for (const n of [...DESIGN_SKILLS, ...(houseStyle ? ["design-themes"] : [])]) if (!names.includes(n) && own(n)) names.push(n);
  return names;
}

/** The house-style block a spawn appends (spec §4.4 "the bot is told"; review M3). */
export function houseStylePromptBlock(hs) {
  return `## House style\n\nThis bot's artifacts use the house style "${hs.name}" (theme:${hs.id}). Crow adds its fonts and colours to every artifact you save. Documents and diagrams pick it up by themselves. In a page, link these files in the <head>: ${hs.links.join(", ")}; then use the CSS variables from the design-themes skill. Do not choose your own palette or fonts.`;
}

/**
 * Phase A — identity. The exact sequence handleInbound ran inline before C-11.
 *
 * @param {{botId: string, threadId: string, gatewayType?: string,
 *          log?: (m: string) => void, jobId?: string|null, cardBound?: boolean,
 *          cwd?: string|null}} opts
 *   `jobId` (Track 1 Task 7 — the missing link in the job_id chain):
 *   job_runner.runCardExecute passes job.job_id through here so it reaches
 *   writeBotMcp's board-entry headers (X-Crow-Job-Id) — without it the
 *   result-service job-rail lock exemption (D-T1.5) can never match a
 *   job-dispatched turn's own bot_jobs row.
 *   `cardBound` (Track 3 acceptance F2): a perch session spawned against a
 *   card. Like a job turn, it must be able to call board_report_result (the
 *   dispatch brief ends the run with that call), so the board MCP entry is
 *   ensured regardless of the def's own crow_mcp selection.
 *   `cwd` (open-anywhere plan, Phase B): the operator's chosen working
 *   directory — pi's process cwd AND the home of the per-bot `.mcp.json`
 *   (pi-lab's mcp-client reads `cwd/.mcp.json`). NULL/unset keeps today's
 *   behavior byte-identically: cwd === sessionDir (the world root).
 * @returns {Promise<{def, bot, crowHome, projectId, projectSpace, projectMembers,
 *          sessionDir, cwd, tasksDbPath, remoteEnabled, peerGatewayUrls, session,
 *          narrowedTools, gatewayType, kitInstalled, houseStyle}>}
 */
export async function buildBotWorld({ botId, threadId, gatewayType = "perch", log = () => {}, jobId = null, cardBound = false, cwd = null }) {
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
  // Open-anywhere B2: a bot with NEITHER is no longer refused — the world
  // root falls back to <crowHome>/pi-bots/<botId> (mkdir'd below via the
  // sessions mkdir). The old no_session_dir throw made an unconfigured bot
  // unspawnable on every rail; with the cwd/world-root split there is always
  // a sane storage root, and a perch operator can point the session anywhere.
  // (One resolution, shared with the Bot Builder's "Turn on a board",
  // which carries the old root's world over when a project moves it.)
  const sessionDir = worldRootFor({ workspaceDir: projectSpace && projectSpace.workspace_dir, def, crowHome, botId });
  // The operator's chosen working directory (open-anywhere). Defaults to the
  // world root, which keeps every pre-existing caller byte-identical. It is
  // pi's process cwd, the directory added to write_paths at spawn, and where
  // the per-bot .mcp.json lives — so validate it hard, before any side effect:
  // absolute, existing, a directory. The gateway route validates first; this
  // is the belt-and-braces second gate (engineError-shaped code for the map).
  const resolvedCwd = cwd || sessionDir;
  if (cwd) {
    let ok = typeof cwd === "string" && cwd.startsWith("/");
    if (ok) { try { ok = statSync(cwd).isDirectory(); } catch { ok = false; } }
    if (!ok) {
      throw Object.assign(
        new Error("cwd is not an existing directory: " + JSON.stringify(cwd)),
        { code: "bad_cwd" }
      );
    }
  }
  const tasksDbPath = (projectSpace && projectSpace.tasks_db_uri) || B.TASKS_DB;
  // World root storage: pi session files, outputs/<sid>, uploads — always
  // under sessionDir, NEVER inside the operator's chosen cwd (a session's
  // deliverables must not litter the project directory).
  // A carried-over world ("Turn on a board", world-root.mjs) whose link now
  // points nowhere would make that mkdir throw EEXIST on every turn; name it.
  const broken = brokenWorldLink(sessionDir);
  if (broken) {
    const msg = "the bot's carried-over world link is broken: " + broken.path + " -> " + broken.target +
      " (the old folder is gone; restore it, or remove the link to start a fresh world)";
    log(msg);
    throw Object.assign(new Error(msg), { code: "world_link_broken" });
  }
  mkdirSync(sessionDir + "/sessions", { recursive: true });

  // Keep the per-bot <sessionDir>/.mcp.json in sync with the def on every
  // turn (best-effort; a writer hiccup can never break a turn). Primary
  // writer is the GUI save handler; this is the defensive backstop.
  // M3b: pass the resolved sessionDir (which may differ from def.session_dir
  // when the bot has a project_space workspace).
  // The file ALWAYS lives in the world root, never in the operator's chosen
  // cwd: writeBotMcp replaces the whole file (closed-world), so writing it
  // into a project directory destroyed that project's own .mcp.json on every
  // turn (r4-acme and crow itself, 2026-09-12/13). pi finds it through the
  // engine-reserved PI_BOT_MCP_CONFIG env var the bridge sets at spawn
  // (pi-lab mcp-client: global file + that file only, no cwd-ancestor walk),
  // so a chosen directory is read-only to the MCP layer and its own
  // .mcp.json neither leaks into the bot nor gets rewritten.
  // F4a L2b: read the remote_invocation flag + trusted peer gateway URLs once
  // (local-only, default off). With the flag off, remoteEnabled=false ⇒
  // writeBotMcp mints no remote blocks and toolAllowlist adds no remote entries
  // ⇒ live bots are byte-identical to today. Reads never throw.
  const _conn = B.db(B.CROW_DB);
  let remoteEnabled = false, peerGatewayUrls = {};
  // bash policy "auto": the safety classifier pi-lab will call, resolved
  // here (setting, else an installed local candidate). null for every other
  // policy — the spawn policy is then byte-identical to before.
  let botClassifier = null;
  let houseStyle = null, kitInstalled = false;
  try {
    remoteEnabled = B.readRemoteInvocationEnabled(_conn);
    if (remoteEnabled) peerGatewayUrls = B.readPeerGatewayUrls(_conn);
    if (def.permission_policy && normalizeStoredBashPolicy(def.permission_policy.bash).value === "auto") {
      botClassifier = readBotClassifierSync(_conn);
      if (!botClassifier.ok) log("bash=auto but no usable safety classifier (" + botClassifier.reason + ") — every command will be asked (interactive) or refused (unattended)");
    }
    // Design kit (spec §4.3, §4.4; review H2): this instance's install state,
    // then the house style (the project's theme, else the bot default; null
    // unless the installed kit knows it). Never fails a turn.
    try {
      kitInstalled = !!installedKitDir(crowHome);
      const themes = kitInstalled ? readKitThemes(crowHome) : new Map();
      const id = themes.size ? readHouseStyleSync(_conn, { projectId, def, known: new Set(themes.keys()) }) : null;
      houseStyle = id ? { id, name: themes.get(id).name, links: houseStyleLinks(id, themes.get(id)) } : null;
    } catch { kitInstalled = false; houseStyle = null; }
  } finally { _conn.close(); }
  // Pin an operator-named *.ts.net endpoint to its tailnet IP (refused when it
  // resolves anywhere else); IP endpoints pass through.
  if (botClassifier && botClassifier.ok) {
    botClassifier = await resolveClassifierEndpoint(botClassifier);
    if (!botClassifier.ok) log("bash=auto: safety classifier endpoint refused (" + botClassifier.reason + ") — commands will be asked (interactive) or refused (unattended)");
  }
  // S6-CROW: fd delivery (mcp-delivery.mjs) builds the same config but keeps
  // it in memory — PiRpc pipes it to pi on an inherited fd — and removes any
  // stale on-disk copy. file delivery is the pre-S6 write, unchanged.
  const mcpDelivery = mcpConfigDelivery();
  let mcpConfig = null;
  try {
    // acceptance F2: a card-bound session (or a job turn) must be able to
    // call board_report_result — ensure the board entry is minted.
    const w = writeBotMcp(def, {
      sessionDir, crowHome, remoteEnabled, peerGatewayUrls, botId, jobId, threadId, gatewayType,
      ensureServers: (jobId || cardBound) ? ["board"] : [],
      write: mcpDelivery === "file",
    });
    mcpConfig = w.json || null;
    if (w.warnings.length) log("mcp.json warnings: " + w.warnings.join("; "));
    if (w.remoteWarnings && w.remoteWarnings.length) {
      for (const warn of w.remoteWarnings) log("remote-tool: " + warn);
    }
    if (w.journalGuarded.length) log("mcp.json journal-guarded: " + w.journalGuarded.join(","));
    if (w.minted && w.minted.length) log("mcp.json minted from extensions: " + w.minted.join(","));
  } catch (e) {
    log("per-bot mcp.json write skipped (non-fatal): " + (e && e.message || e));
    // fd mode: a failed build must still not leave an earlier turn's signed
    // file behind (pi ignores it — no PI_BOT_MCP_CONFIG — but another reader
    // would not). The child then gets an empty bot layer, as a missing file did.
    if (mcpDelivery === "fd") removeStaleBotMcp(join(sessionDir, ".mcp.json"));
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
  // cwd: the resolved working directory (=== sessionDir when not chosen).
  // mcpConfigPath: the per-bot closed-world config, always under the world
  // root; the bridge hands it to pi via PI_BOT_MCP_CONFIG. null in fd mode —
  // no file is written (PiRpc still names the absent path, see its fdMode
  // block); mcpConfig (the built JSON) is what PiRpc pipes instead.
  // mcpDelivery: "fd" | "file" (S6-CROW).
  return { def, bot, crowHome, projectId, projectSpace, projectMembers, sessionDir,
    cwd: resolvedCwd, mcpConfigPath: mcpDelivery === "file" ? join(sessionDir, ".mcp.json") : null,
    mcpDelivery, mcpConfig, tasksDbPath, remoteEnabled, peerGatewayUrls, session, botClassifier,
    narrowedTools, gatewayType, kitInstalled, houseStyle,
    // "Turn on a board" fallback carry-over (world-root.mjs): entries linked
    // one by one from the bot's own pre-project root resolve outside every
    // root pi-lab's realpath read gate knows, so that old root joins the read
    // roots. [] for every other bot.
    extraReadPaths: carriedReadRoots({ worldRoot: sessionDir, legacyRoot: worldRootFor({ workspaceDir: null, def, crowHome, botId }) }) };
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
  // across <crowHome>/skills, then the running checkout's skills/, wins.
  const { sections: skillSections, missing: missingSkills, off: offSkillNames = [] } =
    resolveSkills(skillNamesFor(def, { crowHome, kitInstalled: !!world.kitInstalled, houseStyle: world.houseStyle || null }), { crowHome });
  for (const s of skillSections) appendFileSync(sysFile, "\n\n" + s.text);
  // Design kit (review H2): an Artifacts bot is told the kit mode in exactly
  // one line — a missing line (job turns) reads as "not installed".
  if (botGrantsServer(def, "artifacts")) {
    appendFileSync(sysFile, "\n\n" + kitModeLine(!!world.kitInstalled));
    if (world.kitInstalled && world.houseStyle) appendFileSync(sysFile, "\n\n" + houseStylePromptBlock(world.houseStyle));
  }
  for (const name of missingSkills) {
    log("skill file not found for '" + name + "' in " + skillDirs(crowHome).join(", "));
  }
  // Switched off by the owner in the Skills panel (skill-state.json): not an error.
  for (const name of offSkillNames) log("skill '" + name + "' is off on this instance");

  // Slice C — opt-in self-authoring. When permission_policy.self_authoring is
  // true, the bot MAY draft a new skill into a CONFINED staging dir. The dir is
  // keyed on def.session_dir (NOT the resolved sessionDir, which for a
  // project-native bot is <workspace>/bots/<id>) so it is the exact location the
  // Bot Builder review UI scans — no write-here/scan-there split. Open-anywhere
  // B2 (review Q1): it also does NOT follow the operator's perch cwd — a
  // session working in an arbitrary project directory still stages proposals
  // where the review UI looks. We mkdir it,
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
  // M2: fail the turn before spawning when pi cannot use the resolved model.
  const piCheck = await checkPiModel(resolved);
  if (!piCheck.ok) throw new PiModelUnavailableError(piCheck.message);

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
      botClassifier: world.botClassifier || null,
      narrowedTools: world.narrowedTools,
      appendSystemPromptFile: sysFile,
      // S6-CROW: the bot's project workspace joins its read roots (PiRpc,
      // bot-read-paths.mjs); null for a bot without a project.
      projectWorkspaceDir: (world.projectId != null && world.projectSpace && world.projectSpace.workspace_dir) || null,
      // The bot's id, for the workspace env (bot-workspace-env.mjs).
      botId: (world.bot && world.bot.bot_id) || null,
      extraReadPaths: world.extraReadPaths || [],
      // S6-CROW: how the MCP config reaches pi. Absent on a hand-built world
      // (test seams) => PiRpc's pre-S6 file env.
      mcpDelivery: world.mcpDelivery,
      mcpConfig: world.mcpConfig,
    },
  };
}
