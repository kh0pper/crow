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
import { mkdirSync, writeFileSync, appendFileSync, mkdtempSync, statSync, lstatSync, existsSync, readdirSync, realpathSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname, relative, sep } from "node:path";
import { writeBotMcp, removeStaleBotMcp } from "./mcp_writer.mjs";
import { hasActorKey, presignActors, scopeRefFor } from "./actor-sig.mjs";
import { validateExtensions } from "./pi_extensions_allowlist.mjs";
import { resolveModel } from "./model_resolver.mjs";
import { checkPiModel, PiModelUnavailableError } from "./pi-model-catalog.mjs";
import { piProviderIdHere } from "./pi_provider_id.mjs";
import { resolveSkills, resolveSkill, skillDirs } from "./skill_resolver.mjs";
import { addSkillToolsGuarded } from "./skill-tools.mjs";
import { crowDefaultsBlock, readWritingRules } from "./crow-defaults.mjs";
import { isVoiceBotDef } from "../../servers/shared/voice-bot.js";
import { resolveCrowHome } from "./ext_registry.mjs";
import { proposalsDir, selfAuthoringPromptBlock } from "./skill_proposals.mjs";
import { mcpConfigDelivery } from "./mcp-delivery.mjs";
import { applyServiceBlocks, withServiceBlocks, offerableConnections } from "./service-blocks.mjs";
import { applySatelliteBlocks, withSatelliteBlocks } from "./satellite-blocks.mjs";
import { primeBareServerTools } from "./bare-server-tools.mjs";
import { worldRootFor, carriedReadRoots, brokenWorldLink } from "./world-root.mjs";
import { isValidReadPath, normalizeReadPath } from "./bot-read-paths.mjs";
import { botsProjectsRoot } from "./instance-paths.mjs";
import { installedKitDir, readKitThemes, readHouseStyleSync, houseStyleLinks } from "../../servers/shared/design-kit.js";

/** Project services (Task 18): THE seam every rail calls (service-blocks.mjs). */
export { withServiceBlocks, offerableConnections };
/** Satellite-hosted bundles on a bot's turns (SAT-7 part B): the same seam shape (satellite-blocks.mjs). */
export { withSatelliteBlocks };

/** Lazy bridge handle — see the CYCLE NOTE above. */
function loadBridge() { return import("./bridge.mjs"); }

/**
 * The spawn/job union of a def with its repo skills' declared tools
 * (skill-tools.mjs). Logs what was added or refused; never throws (a failure
 * leaves the def as stored).
 */
export async function withSkillTools(def, { crowHome, log = () => {}, repoSkillsDir = undefined } = {}) {
  try {
    const r = await addSkillToolsGuarded(def, { crowHome, repoSkillsDir });
    if (r.refused) log("skill tools not added (tool limit): " + r.wanted.join(", "));
    else if (r.added.length) log("skill tools added: " + r.added.join(", "));
    return r.def;
  } catch (e) {
    log("skill tools skipped (non-fatal): " + ((e && e.message) || e));
    return def;
  }
}

/**
 * The board verbs a bot uses to work its project's cards. Approving a plan and
 * deciding a result are left out: they're the operator's (board-mcp refuses a
 * bot actor anyway). Briefing tools stay a def choice.
 */
export const BOARD_BOT_TOOLS = Object.freeze([
  "board/board_list_boards", "board/board_list_items", "board/board_get_item",
  "board/board_create_item", "board/board_update_item", "board/board_move_item",
  "board/board_archive_item", "board/board_unarchive_item",
  "board/board_get_plan", "board/board_save_plan", "board/board_report_result",
  "board/board_ask_decision", "board/board_notify_decisions", "board/board_offer_card",
]);
/** The read verbs only: a channel turn (mail, Discord, Crow messages) reads its project's
 *  cards but changes none (the operator's ruling, 2026-11-02; board-mcp.js enforces it too). */
export const BOARD_BOT_READ_TOOLS = Object.freeze([
  "board/board_list_boards", "board/board_list_items", "board/board_get_item", "board/board_get_plan",
]);

/**
 * When the world mounts the board server for a def that never selected it,
 * also grant the board verbs on a COPY of the def, so pi's --tools allowlist
 * (bridge buildToolsCsv) doesn't filter them out: a mounted server whose tools
 * the allowlist drops is invisible to the model. Never past the model's tool
 * cap (the same budget skill tools use); a refusal is logged.
 */
export async function withBoardTools(def, { wanted, readOnly = false, log = () => {}, budget = null } = {}) {
  if (!wanted || !def || typeof def !== "object" || botGrantsServer(def, "board")) return def;
  const stored = (def.tools && def.tools.crow_mcp) || [];
  const verbs = readOnly ? BOARD_BOT_READ_TOOLS : BOARD_BOT_TOOLS;
  const candidate = { ...def, tools: { ...(def.tools || {}), crow_mcp: [...stored, ...verbs] } };
  try {
    const b = budget || (await (await import("./artifacts-companions.mjs")).defaultCompanionBudget(def));
    if (Number.isInteger(b.cap) && b.cap > 0 && b.countFor(candidate) > b.cap) {
      log("board tools not added (tool limit): the bot can't use its board until tools are trimmed in Bot Builder");
      return def;
    }
  } catch (e) {
    log("board tool budget check failed; adding board tools anyway: " + ((e && e.message) || e));
  }
  log("board tools added: " + verbs.length + (readOnly ? " (read only on this channel)" : ""));
  return candidate;
}

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
 * grants Update per tool therefore also needs those two — and, since a source
 * too big for one tool argument is refused inline, the two-step upload
 * (`artifact_upload_begin` + `artifact_upload_commit`). PURE: returns a new
 * list with any missing companion appended; a whole-server `artifacts` grant
 * (which already covers them) or a list without Update is returned as is.
 * Callers (scripts/pi-bots/artifacts-companions.mjs) write the result INTO the
 * stored def — never at runtime — so every crow_mcp consumer sees it.
 */
const ART_COMPANIONS = ["artifact_find", "artifact_attach", "artifact_upload_begin", "artifact_upload_commit"];
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

/** The kinds a turn's config carries signatures for (crow-server-catalog.mjs + remote-blocks.mjs). */
const PRESIGN_KINDS = ["bot", "board", "artifacts", "board-thread"];

/**
 * True when the bot works a project board: it is linked to a project and its
 * tracker shows it that project's cards (kanban or task-list; "none" and
 * custom trackers do not). Such a bot gets the board tools on every turn.
 */
export function projectShowsCards(projectId, def) {
  if (projectId == null || !Number.isFinite(Number(projectId))) return false;
  // Same default as tracker.mjs resolveTrackerType (not imported: that module
  // resolves its db paths at load).
  const type = (def && def.tracker_config && def.tracker_config.type) || "kanban";
  return type === "kanban" || type === "task-list";
}

/**
 * The workspace roots a bot's shares contribute to ONE spawn: for every live,
 * non-suspended share that names an absolute workspace_dir, the REAL top-level
 * entries of that workspace — one root each (`read` always, `write` for the
 * `read_write` ones only). A suspended share adds nothing (its project has an
 * outside member right now), and neither does a share whose project is
 * archived/tombstoned or has no workspace_dir — loadBotShares does not return
 * the archived ones, and a row without a usable dir is skipped here.
 *
 * The workspace root itself is NEVER granted, and neither is its `bots`
 * subtree: every bot homed at that project keeps its engine state at
 * <workspace_dir>/bots/<botId> (sessions/ and pi's transcripts, outputs/, .pi/,
 * and in file mode a .mcp.json carrying signed actor headers), so a share of
 * the whole workspace would expose them and, at `read_write`, let the bot
 * rewrite another bot's sessions. A `bots` directory that is itself a symlink
 * refuses the whole share's roots (fail closed, one warning), and so does every
 * other link in that tree. That tree is an ALLOWLIST with exactly one accepted
 * shape: Crow's own moved-bot link, a DIRECT child of `bots`,
 * `<workspace>/bots/<id>` -> `<projectsRoot>/<slug>/workspace/bots/<id>` (a
 * slug segment, the `workspace`/`bots` ones, and the id the link itself is
 * named; the target outside this workspace). Anything else under `bots` — a bot
 * home or a `sessions`/`.pi`/`outputs`/`.mcp.json` entry carried over to a
 * legacy root, a link deeper inside a bot home, a cross-share link of another
 * shape, a link chain, a dangling link — refuses the whole share's roots with
 * one warning. So does an accepted link whose target subtree holds a link, and
 * a tree the holdout could not inspect in full (too deep, too large,
 * unreadable).
 *
 * The workspace's OTHER top-level entries are walked too (bounded, never
 * following a link, `SHARE_ENTRY_MAX_DEPTH`/`SHARE_ENTRY_MAX_ENTRIES`): a link
 * inside one is harmless — a `.venv`'s system-python link, its `lib64 -> lib`,
 * a dangling link — unless its realpath lands in another project under the
 * projects area (this project's `bots` tree included), inside the Crow home, or
 * inside the data directory outside this workspace. Such an entry is not
 * granted (one line names the reason) and its siblings still are.
 *
 * ALLOWLIST, not a denylist: a share's workspace_dir is a candidate only when,
 * after realpathSync, it lies STRICTLY under realpathSync(projectsRoot) — the
 * instance's projects area (`botsProjectsRoot()`, i.e. `<data>/projects`, where
 * workspacePathFor puts every project workspace). A missing/unreadable dir, a
 * dir outside that area, and a dir that is a symlink resolving outside it all
 * grant nothing; so does every granted ENTRY whose own realpath leaves the
 * area. With no projects root to check against, nothing is granted at all
 * (fail closed) and one line says so.
 *
 * The denylist below stays as an extra belt (a root at or above the projects
 * area would otherwise pass the allowlist whenever the two are configured
 * oddly): `/`, the user's home or any parent of it, the projects root's parent,
 * the Crow home (equal to it or above it), and <crowHome>/secrets.
 *
 * The entries are listed at SPAWN time, so a top-level file or directory
 * created after this spawn is outside the running child's reach until the next
 * spawn. The roots are per-SPAWN in any case: pi's native file tools get them
 * fixed at spawn, while the MCP tools are re-checked on every call
 * (resolveBotAccess).
 *
 * @param {{workspace_dir?: string|null, level?: string, suspended?: boolean}[]|null} shares
 * @param {{crowHome?: string|null, projectsRoot?: string|null, log?: (m: string) => void,
 *   botsTreeMaxEntries?: number}} [opts]
 *   `crowHome` is the active Crow instance home and `projectsRoot` this
 *   instance's projects area (`botsProjectsRoot()`), both for the refusal
 *   rules; `log` gets one line per share that granted nothing for a reason
 *   worth naming; `botsTreeMaxEntries` overrides the holdout walk's entry
 *   bound (defaults to BOTS_TREE_MAX_ENTRIES — tests pass a small one instead
 *   of building a six-figure tree).
 * @returns {{read: string[], write: string[]}}
 */
export function shareWorkspaceRoots(shares, {
  crowHome = null, projectsRoot = null, log = () => {}, botsTreeMaxEntries = BOTS_TREE_MAX_ENTRIES,
} = {}) {
  const read = [];
  const write = [];
  const list = Array.isArray(shares) ? shares : [];
  // Nothing to grant, nothing to resolve (and no warning on every turn of a bot without shares).
  if (!list.length) return { read, write };
  const root = realProjectsRoot(projectsRoot);
  if (!root) {
    log("share workspace not granted (no projects root to check it against)");
    return { read, write };
  }
  for (const s of list) {
    if (!s || s.suspended === true || !isValidReadPath(s.workspace_dir)) continue;
    const dir = normalizeReadPath(s.workspace_dir);
    const dangerous = dangerousShareRoot(dir, crowHome, root);
    if (dangerous) {
      log("share workspace not granted (" + dangerous + "): " + dir);
      continue;
    }
    let realDir = null;
    try { realDir = normalizeReadPath(realpathSync(dir)); } catch { realDir = null; }
    if (!realDir) {
      log("share workspace not granted (missing or unreadable): " + dir);
      continue;
    }
    if (!strictlyUnder(realDir, root)) {
      log("share workspace not granted (outside the projects area): " + dir);
      continue;
    }
    for (const entryRoot of shareEntryRoots(dir, { realDir, projectsRoot: root, crowHome, log, botsTreeMaxEntries })) {
      if (!read.includes(entryRoot)) read.push(entryRoot);
      if (s.level === "read_write" && !write.includes(entryRoot)) write.push(entryRoot);
    }
  }
  return { read, write };
}

/** `p` is inside `root` and is not `root` itself (both real paths). */
function strictlyUnder(p, root) {
  return p !== root && p.startsWith(root + "/");
}

/** The real projects area, or null when there is none to check a share against. */
function realProjectsRoot(projectsRoot) {
  if (!isValidReadPath(projectsRoot)) return null;
  try { return normalizeReadPath(realpathSync(normalizeReadPath(projectsRoot))); } catch { return null; }
}

/**
 * The most top-level entries one share may contribute as roots. A workspace
 * with more grants nothing at all: a thousand roots in a spawn policy is not a
 * project anybody meant to share, and failing loudly beats a slow spawn.
 */
export const SHARE_ROOT_ENTRY_CAP = 200;

/**
 * How deep below `<workspace>/bots` the bot-home holdout walk goes. A bot home
 * is `<id>/sessions/<file>`, `<id>/outputs/<sessionId>/…`, `<id>/.pi/…`, so six
 * levels reaches far past any shape a bot home has today; a tree that goes
 * deeper is refused rather than half-inspected (an unseen subtree's links
 * cannot be vouched for).
 */
export const BOTS_TREE_MAX_DEPTH = 6;

/**
 * The most entries (directories, files, links alike) the holdout walk looks at
 * across the WHOLE `<workspace>/bots` tree. A larger tree is refused, for the
 * same reason as a deeper one: a walk that stopped at the bound has not seen
 * every link in the tree.
 *
 * Sized for a real bot home rather than for a tidy one: pi keeps every session
 * transcript under `<bot home>/sessions`, and every turn's files under
 * `<bot home>/outputs/<session>/`, so both grow for as long as the bot lives —
 * a long-running bot homed at a shared project passes a few thousand entries
 * without anybody doing anything unusual. The bound is here to stop a walk that
 * would never finish, not to cap the size of an honest tree.
 */
export const BOTS_TREE_MAX_ENTRIES = 100000;

/**
 * How deep below a granted top-level entry the granted-entry walk goes (RULE 2:
 * only a dangerous link target refuses an entry, so the walk has to see the
 * links a real project puts deep inside one). 32 levels passes any shape a
 * checkout, a `.venv` or a `node_modules` tree has; deeper is refused rather
 * than half-inspected.
 */
export const SHARE_ENTRY_MAX_DEPTH = 32;

/**
 * The most entries (directories, files, links alike) the granted-entry walk
 * looks at across ALL of one share's granted entries. A larger set is refused,
 * for the reason SHARE_ROOT_ENTRY_CAP exists: a share that is a whole checkout
 * with a full dependency tree is not what anybody meant to grant, and a walk
 * that stopped at the bound has not seen every link.
 */
export const SHARE_ENTRY_MAX_ENTRIES = 200000;

/**
 * Why `dir` must never become a share root, or null: the filesystem root, the
 * user's own home or any parent of it, the projects area's parent, the Crow
 * home (equal to it or above it), or anything under <crowHome>/secrets. The
 * allowlist in shareWorkspaceRoots is the rule; this is the belt for a
 * projects root configured somewhere it should not be. `projectsRoot` is the
 * resolved projects area.
 */
function dangerousShareRoot(dir, crowHome, projectsRoot) {
  if (dir === "/") return "the filesystem root";
  let home = null;
  try { home = normalizeReadPath(homedir()); } catch { home = null; }
  if (home && home !== "/") {
    if (dir === home) return "the user's home";
    if (home.startsWith(dir + "/")) return "above the user's home";
  }
  if (projectsRoot) {
    const parent = dirname(projectsRoot);
    if (dir === parent || parent.startsWith(dir + "/")) return "the projects area's parent or above";
  }
  if (!crowHome || !isValidReadPath(crowHome)) return null;
  const ch = normalizeReadPath(crowHome);
  if (dir === ch) return "the Crow home";
  if (ch.startsWith(dir + "/")) return "above the Crow home";
  const secrets = ch + "/secrets";
  if (dir === secrets || dir.startsWith(secrets + "/")) return "under the Crow home's secrets";
  return null;
}

/**
 * The roots ONE share contributes: the real top-level entries of its workspace,
 * one root each — never the workspace itself, never its `bots` subtree (see
 * shareWorkspaceRoots). An entry that cannot be resolved is skipped; an entry
 * whose realpath leaves the projects area is skipped; a symlink is followed
 * only when it resolves strictly inside the workspace, to neither the
 * workspace itself nor its `bots` subtree, and a granted entry becomes the
 * root as its REALPATH (never the link's own path).
 *
 * The bots subtree is held out by name, by its realpath, AND by the realpath of
 * every bot home under it: `<workspace>/bots` may be a symlink to a sibling
 * entry, and `<workspace>/bots/<id>` may be one too, in which case that bot's
 * state lives at the link's target — possibly an ordinary top-level entry this
 * share would otherwise grant. The whole tree below `bots` is therefore walked
 * (never through a link) by botsHoldout(): ANY link in it refuses the WHOLE
 * share's roots with one warning, with exactly one accepted shape — Crow's own
 * moved-bot link, whose target subtree is then walked the same way. A tree the
 * walk could not finish (deeper than BOTS_TREE_MAX_DEPTH, larger than
 * BOTS_TREE_MAX_ENTRIES, or unreadable) refuses the share too: a tree the
 * holdout has not seen all of is not one it can vouch for.
 *
 * Every OTHER entry is walked as well (grantedEntryRefusal/walkGrantedEntryLinks
 * below): a link inside
 * it is harmless unless its realpath lands in another project, in this
 * project's bots tree, in the Crow home, or in the data directory outside this
 * workspace. Such an entry is left out (one line names the reason) and its
 * siblings are still granted; an entry reached through another, refused entry's
 * realpath is left out too.
 *
 * More top-level entries than SHARE_ROOT_ENTRY_CAP grants nothing for the share.
 * @param {string} dir       the workspace_dir as the share row names it
 * @param {{realDir?: string|null, projectsRoot: string, crowHome?: string|null,
 *   log?: (m: string) => void, botsTreeMaxEntries?: number}} opts
 *   `realDir` is dir's own realpath (already checked to be under projectsRoot),
 *   `crowHome` the active Crow instance home (a link target inside it is refused)
 * @returns {string[]}
 */
function shareEntryRoots(dir, {
  realDir = null, projectsRoot, crowHome = null, log = () => {}, botsTreeMaxEntries = BOTS_TREE_MAX_ENTRIES,
} = {}) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    log("share workspace not granted (unreadable): " + dir);
    return [];
  }
  if (entries.length > SHARE_ROOT_ENTRY_CAP) {
    log("share workspace not granted (" + entries.length + " top-level entries, cap " + SHARE_ROOT_ENTRY_CAP + "): " + dir);
    return [];
  }
  const under = (p, root) => p === root || p.startsWith(root + "/");
  const botsDir = realDir ? join(realDir, "bots") : null;
  let botsReal = null;
  let botHomes = [];
  if (botsDir) {
    const held = botsHoldout(botsDir, { realDir, projectsRoot, maxEntries: botsTreeMaxEntries });
    if (!held.ok) {
      log("share workspace not granted (" + held.reason + "): " + dir);
      return [];
    }
    botsReal = held.real;
    botHomes = held.homes;
  }
  const botsPaths = [botsDir, botsReal, ...botHomes].filter(Boolean);
  const linkCtx = {
    realDir, projectsRoot, dataDir: dirname(projectsRoot), crowHome: realDirOrNull(crowHome),
  };
  const budget = { entries: 0, max: SHARE_ENTRY_MAX_ENTRIES };
  const granted = [];
  const refused = [];
  for (const entry of entries) {
    // `<workspace>/bots` holds every bot homed at this project.
    if (entry.name === "bots") continue;
    const full = join(dir, entry.name);
    // A broken symlink, or a race with a delete: nothing to grant.
    let real = null;
    try { real = normalizeReadPath(realpathSync(full)); } catch { continue; }
    /** One line naming why this entry is left out (the siblings still grant). */
    const skipEntry = (reason) => {
      log("share entry not granted (" + reason + "): " + full);
      refused.push(real);
    };
    if (entry.isSymbolicLink()) {
      // Never follow a link out of the workspace, and never to the workspace itself: that is
      // `<workspace>/bots` by another name. One line names why; the siblings are still granted.
      if (!realDir || real === realDir) {
        skipEntry("a symlink resolving to the workspace itself");
        continue;
      }
      if (!under(real, realDir)) {
        skipEntry(dangerousLinkTarget(real, linkCtx) || "a symlink resolving outside this workspace");
        continue;
      }
    } else if (!strictlyUnder(real, projectsRoot)) continue;
    // An entry at, above or inside the bots home is that subtree by another name, whichever
    // spelling of the bots home it reaches: the entry named `bots` (skipped above), any bot home
    // under it, or anything under either. The only link in `bots` was accepted by the holdout.
    if (botsPaths.some((bots) => under(bots, real) || under(real, bots))) {
      // Say why for a LINK into the bots tree (a real directory there is just that directory).
      if (entry.isSymbolicLink()) skipEntry("a symlink resolving into this project's bots tree");
      continue;
    }
    const danger = grantedEntryRefusal(entry, full, real, linkCtx, budget);
    if (danger) {
      if (danger.share) {
        log("share workspace not granted (" + danger.reason + "): " + dir);
        return [];
      }
      log("share entry not granted (" + danger.reason + "): " + full);
      refused.push(real);
      continue;
    }
    granted.push(real);
  }
  // A refused entry's realpath is never granted — not even through a sibling link that points at it.
  const roots = [];
  for (const root of granted) {
    if (refused.includes(root)) continue;
    if (!roots.includes(root)) roots.push(root);
  }
  return roots;
}

/** The real path `p` resolves to, or null when it is not a usable path or does not resolve. */
function realDirOrNull(p) {
  if (!isValidReadPath(p)) return null;
  try { return normalizeReadPath(realpathSync(normalizeReadPath(p))); } catch { return null; }
}

/**
 * Why this granted top-level entry is left out, or null when it may be a root:
 * `{reason}` for an entry of its own (one line, the siblings stay), `{reason,
 * share: true}` for a walk that hit a bound and so cannot speak for the rest of
 * the share either.
 *
 * A link inside the entry (or the entry itself, when it is one) is judged by its
 * FINAL realpath: dangling is harmless (ENOENT — it reaches nothing), any other
 * resolve error refuses the entry, and a realpath that lands somewhere this
 * share must not reach (dangerousLinkTarget) refuses it. Never followed deeper.
 */
function grantedEntryRefusal(entry, full, real, ctx, budget) {
  if (entry.isSymbolicLink()) {
    const why = dangerousLinkTarget(real, ctx);
    return why ? { reason: why } : null;
  }
  if (!entry.isDirectory()) return null;
  const walked = walkGrantedEntryLinks(full, ctx, budget);
  return walked.ok ? null : walked;
}

/**
 * The bounded, never-following walk of one granted top-level entry: the shapes
 * that are fine (a `.venv`'s `bin/python -> /usr/bin/python3.12`, `lib64 ->
 * lib`, a chain ending inside the workspace, a dangling link) pass, and the
 * first dangerous target refuses the entry. `{ok: true}` or `{reason, share?}`.
 */
function walkGrantedEntryLinks(entryDir, ctx, budget) {
  let frontier = [{ dir: entryDir, depth: 0 }];
  while (frontier.length) {
    const next = [];
    for (const at of frontier) {
      let kids;
      try { kids = readdirSync(at.dir, { withFileTypes: true }); } catch (err) {
        if (isMissing(err)) continue; // raced with a delete: nothing left to look at here
        return { reason: "unreadable directory in a granted entry (" + errCode(err) + ")" };
      }
      for (const kid of kids) {
        budget.entries += 1;
        if (budget.entries > budget.max) {
          return { reason: "granted entries over " + budget.max + " entries", share: true };
        }
        if (kid.isSymbolicLink()) {
          // Never descended into: only resolved, to see where it finally lands.
          let target = null;
          try { target = normalizeReadPath(realpathSync(join(at.dir, kid.name))); } catch (err) {
            if (isMissing(err)) continue; // a dangling link reaches nothing
            return { reason: "unresolvable symlink in a granted entry (" + errCode(err) + ")" };
          }
          const why = dangerousLinkTarget(target, ctx);
          if (why) return { reason: "a symlink in a granted entry " + why };
          continue;
        }
        if (!kid.isDirectory()) continue;
        const depth = at.depth + 1;
        if (depth > SHARE_ENTRY_MAX_DEPTH) {
          return { reason: "granted entries deeper than " + SHARE_ENTRY_MAX_DEPTH + " levels", share: true };
        }
        next.push({ dir: join(at.dir, kid.name), depth });
      }
    }
    frontier = next;
  }
  return { ok: true };
}

/**
 * Why a link's FINAL realpath is a place this share must not reach, or null.
 * `ctx` carries the workspace's realpath, the projects area, its parent (the
 * data directory) and the Crow home.
 *
 * Refused: this project's own `bots` tree; another project's tree anywhere
 * under the projects area (a sibling workspace, another project's bots); the
 * Crow home; and the data directory outside this workspace. Everything else is
 * allowed — a system path (`/usr/bin/python3`), a path elsewhere on the disk, a
 * dangling link (its caller skips it), and anything under this workspace that
 * is not its `bots` tree (a `.venv`'s `lib64 -> lib`).
 */
function dangerousLinkTarget(real, { realDir, projectsRoot, dataDir, crowHome }) {
  const under = (p, root) => !!root && (p === root || p.startsWith(root + "/"));
  const botsDir = realDir ? join(realDir, "bots") : null;
  if (under(real, botsDir)) return "lands in this project's bots tree";
  if (under(real, projectsRoot)) {
    if (under(real, realDir)) return null;
    return "lands in another project under the projects area";
  }
  if (under(real, realDir)) return null;
  if (under(real, crowHome)) return "lands inside the Crow home";
  if (under(real, dataDir)) return "lands in the data directory outside this workspace";
  return null;
}

/** A bare `code` off a filesystem error, for a warning line. */
function errCode(err) {
  return (err && typeof err.code === "string" && err.code) || "unknown error";
}

/** `err` is the filesystem saying "not there" (the one error that is not a refusal). */
function isMissing(err) {
  return !!err && err.code === "ENOENT";
}

/**
 * The bot-home holdout for one workspace: after a bounded, link-following-free
 * walk of the WHOLE `<workspace>/bots` tree, the realpath of `bots`, of every
 * direct child (a bot home) and of every accepted moved-bot link's target — the
 * paths a granted entry must never reach.
 *
 * `{ok: true, real, homes}` or `{ok: false, reason}`; a reason always refuses
 * the share's roots. Fail closed: `bots` itself a link, ANY link in the tree
 * that is not Crow's moved-bot shape (a carried-over world, a link deeper in a
 * bot home, a cross-share link, a link chain, a dangling link), a moved-bot
 * link whose target subtree holds a link, and a tree the walk could not finish
 * all refuse — a tree the holdout has not seen all of is not one it can vouch
 * for.
 *
 * Exported: the callers are shareEntryRoots, and the holdout's own answer is
 * what the share-roots suite checks a moved-bot link against.
 *
 * @param {string} botsDir  `<workspace>/bots`
 * @param {{realDir?: string|null, projectsRoot?: string|null, maxEntries?: number}} [opts]
 *   `realDir` is the workspace's realpath, `projectsRoot` the instance's real
 *   projects area (what a moved-bot link's target is measured against),
 *   `maxEntries` the walk's entry bound
 *
 * Errors refuse too, with two ENOENT exceptions: ENOENT on `<workspace>/bots`
 * means this project homes no bot (no holdout needed), and ENOENT on a child is
 * a race with a delete (that child holds nothing out). Every other error —
 * EACCES, ENOTDIR, ELOOP, EIO, … — must not read as "no bots".
 */
export function botsHoldout(botsDir, { realDir = null, projectsRoot = null, maxEntries = BOTS_TREE_MAX_ENTRIES } = {}) {
  let st = null;
  try { st = lstatSync(botsDir); } catch (err) {
    if (isMissing(err)) return { ok: true, real: null, homes: [] };
    return { ok: false, reason: "unreadable <workspace>/bots (" + errCode(err) + ")" };
  }
  // `<workspace>/bots` itself a link: the tree the entries were listed from is not the bot homes' tree.
  if (st.isSymbolicLink()) return { ok: false, reason: "<workspace>/bots is a symlink" };
  const walked = walkBotsTree(botsDir, { realDir, projectsRoot, maxEntries });
  if (!walked.ok) return walked;

  let real = null;
  try { real = normalizeReadPath(realpathSync(botsDir)); } catch (err) {
    if (!isMissing(err)) return { ok: false, reason: "unresolvable <workspace>/bots (" + errCode(err) + ")" };
  }
  const homes = walked.movedHomes.slice();
  for (const name of walked.children) {
    try {
      const home = normalizeReadPath(realpathSync(join(botsDir, name)));
      if (!homes.includes(home)) homes.push(home);
    } catch (err) {
      // A child deleted between the walk and here holds nothing out; anything else refuses.
      if (!isMissing(err)) return { ok: false, reason: "unresolvable bot home (" + errCode(err) + ")" };
    }
  }
  return { ok: true, real, homes };
}

/**
 * Why `<workspace>/bots/<name>` is not Crow's moved-bot link, or null when it
 * is: the ONLY shape the bots tree accepts. `real` is the link's resolved
 * target, which must sit under the instance's projects area as exactly
 * `<slug>/workspace/bots/<name>` — the `bots` tree of another project, holding
 * a home of the same bot — and must not be this workspace or anything inside
 * it (that would hand the share a way back to its own `bots` tree).
 *
 * With no projects root there is nothing to measure against, so no link is
 * accepted (fail closed).
 */
function movedBotLinkRefusal(name, real, { realDir = null, projectsRoot = null } = {}) {
  if (!projectsRoot) return "a symlink in the bots tree and no projects area to check its target against";
  const rel = relative(projectsRoot, real);
  const parts = rel.split(sep);
  const shaped = rel !== "" && !rel.startsWith("..") && parts.length === 4
    && !!parts[0] && parts[1] === "workspace" && parts[2] === "bots" && parts[3] === name;
  if (!shaped) {
    return "a symlink in the bots tree that is not Crow's moved-bot link (" + name + " -> a target that is not <slug>/workspace/bots/" + name + ")";
  }
  if (realDir && (real === realDir || real.startsWith(realDir + "/"))) {
    return "a symlink in the bots tree that is not Crow's moved-bot link (its target is this workspace)";
  }
  return null;
}

/**
 * Walks everything below `<workspace>/bots`, breadth first, WITHOUT following a
 * symlink: a Dirent from readdirSync({withFileTypes}) is the lstat answer, so a
 * link is never descended into. The tree is an ALLOWLIST: the one accepted link
 * is Crow's moved-bot link as a DIRECT child of `bots` (movedBotLinkRefusal),
 * whose target subtree is then walked the same way (walkMovedBotHome) and whose
 * realpath joins `movedHomes`. Every other link — carried over to a legacy
 * root, nested in a bot home, cross-share, a chain, dangling — and any tree
 * deeper than BOTS_TREE_MAX_DEPTH or past `maxEntries` ends the walk with a
 * refusal rather than a partial answer.
 * @param {string} botsDir
 * @param {{realDir?: string|null, projectsRoot?: string|null, maxEntries?: number}} [opts]
 * @returns {{ok: true, children: string[], movedHomes: string[], entries: number}|{ok: false, reason: string}}
 *   `children` are the direct children of `bots` (the bot homes), `movedHomes`
 *   the realpaths accepted moved-bot links point at.
 */
function walkBotsTree(botsDir, { realDir = null, projectsRoot = null, maxEntries = BOTS_TREE_MAX_ENTRIES } = {}) {
  const counter = { entries: 0, max: maxEntries };
  let children = null;
  const movedHomes = [];
  let frontier = [{ dir: botsDir, depth: 0 }];
  while (frontier.length) {
    const next = [];
    for (const at of frontier) {
      let kids;
      try { kids = readdirSync(at.dir, { withFileTypes: true }); } catch (err) {
        if (isMissing(err)) continue; // raced with a delete: nothing left to look at here
        return { ok: false, reason: "unreadable bots tree (" + errCode(err) + ")" };
      }
      if (at.depth === 0) children = kids.map((kid) => kid.name);
      for (const kid of kids) {
        counter.entries += 1;
        if (counter.entries > counter.max) {
          return { ok: false, reason: "bots tree over " + maxEntries + " entries" };
        }
        if (kid.isSymbolicLink()) {
          // Never followed: only resolved, and only to be measured against the one accepted shape.
          let real = null;
          try { real = normalizeReadPath(realpathSync(join(at.dir, kid.name))); } catch (err) {
            return { ok: false, reason: "unresolvable symlink in the bots tree (" + errCode(err) + ")" };
          }
          if (at.depth !== 0) {
            return { ok: false, reason: "a symlink inside a bot home (" + kid.name + ")" };
          }
          const why = movedBotLinkRefusal(kid.name, real, { realDir, projectsRoot });
          if (why) return { ok: false, reason: why };
          // Crow's own link: the home it points at is held to the same rules as a real bot home.
          const home = walkMovedBotHome(real, counter);
          if (!home.ok) return home;
          if (!movedHomes.includes(real)) movedHomes.push(real);
          continue;
        }
        if (!kid.isDirectory()) continue;
        const depth = at.depth + 1;
        if (depth > BOTS_TREE_MAX_DEPTH) {
          return { ok: false, reason: "bots tree deeper than " + BOTS_TREE_MAX_DEPTH + " levels below <workspace>/bots" };
        }
        next.push({ dir: join(at.dir, kid.name), depth });
      }
    }
    frontier = next;
  }
  return { ok: true, children: children || [], movedHomes, entries: counter.entries };
}

/**
 * Everything below an accepted moved-bot link's target, walked like a bot home
 * inside `bots`: never through a link, refusing on the FIRST link found and on
 * the same depth/entry bounds (`counter` is the bots-tree walk's). The target
 * starts at depth 1, the depth a real `<bots>/<id>` home has.
 * @returns {{ok: true}|{ok: false, reason: string}}
 */
function walkMovedBotHome(homeDir, counter) {
  let frontier = [{ dir: homeDir, depth: 1 }];
  while (frontier.length) {
    const next = [];
    for (const at of frontier) {
      let kids;
      try { kids = readdirSync(at.dir, { withFileTypes: true }); } catch (err) {
        if (isMissing(err)) continue; // raced with a delete
        return { ok: false, reason: "unreadable moved bot home (" + errCode(err) + ")" };
      }
      for (const kid of kids) {
        counter.entries += 1;
        if (counter.entries > counter.max) {
          return { ok: false, reason: "bots tree over " + counter.max + " entries" };
        }
        if (kid.isSymbolicLink()) {
          return { ok: false, reason: "a symlink inside a moved bot's home (" + kid.name + ")" };
        }
        if (!kid.isDirectory()) continue;
        const depth = at.depth + 1;
        if (depth > BOTS_TREE_MAX_DEPTH) {
          return { ok: false, reason: "bots tree deeper than " + BOTS_TREE_MAX_DEPTH + " levels below <workspace>/bots" };
        }
        next.push({ dir: join(at.dir, kid.name), depth });
      }
    }
    frontier = next;
  }
  return { ok: true };
}

/**
 * Write (or, in fd mode, build) the per-bot MCP config for this turn, with its
 * actor signatures bound to `sessionId` (bot_sessions.id, or null). A
 * key-less host (the pibot-* systemd units) first asks its gateway's loopback
 * signing relay for this turn's signatures (actor-sig.mjs presignActors); the
 * key never reaches it. Without a session or job the gateway signs nothing,
 * so no request is made. Never throws: a failed build leaves no config.
 * @returns {Promise<{mcpConfig: object|null, signedSessionId: number|null}>}
 */
async function writeWorldMcp(a, sessionId) {
  const sid = sessionId == null ? null : Number(sessionId);
  let signed = hasActorKey();
  if (!signed && (sid != null || a.jobId)) {
    const port = process.env.CROW_GATEWAY_PORT || 3001;
    signed = await presignActors({
      gatewayUrl: "http://127.0.0.1:" + port, botId: a.botId, sessionId: sid, threadId: a.threadId,
      gatewayType: a.gatewayType, jobId: a.jobId,
      kinds: sid != null ? [...PRESIGN_KINDS, "peer-relay"] : PRESIGN_KINDS,
    });
    if (!signed) a.log("actor signatures unavailable from the gateway; this turn's actor headers are unsigned");
  }
  let mcpConfig = null;
  try {
    // acceptance F2: a card-bound session (or a job turn) must be able to
    // call board_report_result — ensure the board entry is minted. A bot
    // linked to a project that shows it its cards gets the board on EVERY
    // channel too: asked to "put this on the board", a bot without board
    // verbs wrote project notes instead and reported the board organized.
    // The board server scopes a bot to its own project's cards (board-mcp.js),
    // so a mail or Discord turn can be handed it without exposing any other
    // project. The voice bot never gets it (its turn loop has no board).
    const w = writeBotMcp(a.def, {
      sessionDir: a.sessionDir, crowHome: a.crowHome, remoteEnabled: a.remoteEnabled, peerGatewayUrls: a.peerGatewayUrls,
      botId: a.botId, jobId: a.jobId, threadId: a.threadId, gatewayType: a.gatewayType, sessionId: sid,
      displayName: a.displayName,
      // Phase 1 shares: a bot holding a live share gets no remote-proxy blocks (mcp_writer.mjs);
      // the world's own share read decides, so the next build after a revoke restores them.
      holdsShare: a.holdsShare === true,
      ensureServers: (a.jobId || a.cardBound || a.projectBoard) ? ["board"] : [],
      // Credential card: the implied crow-secrets entry only for a Perch (interactive) turn,
      // never a channel or job turn (mcp_writer.mjs buildBotMcp).
      interactive: a.gatewayType === "perch" && !a.jobId,
      write: a.mcpDelivery === "file",
    });
    mcpConfig = w.json || null;
    // Project services (Task 18, R6 vs PR-B): withServiceBlocks stored this turn's blocks here
    // before the tool-budget preflight; every rebuild (bindWorldSession) re-applies them, or the
    // child would be pinned with tools its config no longer carries. Only a blocks result whose
    // scope still names this turn: a job scope (it binds no session), or this very session.
    const sb = a.serviceBlocks;
    if (mcpConfig && sb && sb.blocks && ((a.jobId != null && sb.scopeRef === scopeRefFor({ jobId: a.jobId })) || (sid != null && sb.scopeRef === "s:" + sid))) {
      mcpConfig = applyServiceBlocks(mcpConfig, sb);
    }
    // Satellite tools (SAT-7 part B): the same rebuild rule for the same reason — withSatelliteBlocks
    // stored this turn's blocks here before the preflight, and a child pinned with tools its config
    // no longer carries has no satellite tool at all. Only a blocks result whose scope still names
    // this turn.
    const satb = a.satelliteBlocks;
    if (mcpConfig && satb && satb.blocks && ((a.jobId != null && satb.scopeRef === scopeRefFor({ jobId: a.jobId })) || (sid != null && satb.scopeRef === "s:" + sid))) {
      mcpConfig = applySatelliteBlocks(mcpConfig, satb);
    }
    if (w.warnings.length) a.log("mcp.json warnings: " + w.warnings.join("; "));
    if (w.remoteWarnings && w.remoteWarnings.length) {
      for (const warn of w.remoteWarnings) a.log("remote-tool: " + warn);
    }
    if (w.journalGuarded.length) a.log("mcp.json journal-guarded: " + w.journalGuarded.join(","));
    if (w.minted && w.minted.length) a.log("mcp.json minted from extensions: " + w.minted.join(","));
  } catch (e) {
    a.log("per-bot mcp.json write skipped (non-fatal): " + (e && e.message || e));
    // fd mode: a failed build must still not leave an earlier turn's signed
    // file behind (pi ignores it — no PI_BOT_MCP_CONFIG — but another reader
    // would not). The child then gets an empty bot layer, as a missing file did.
    if (a.mcpDelivery === "fd") removeStaleBotMcp(join(a.sessionDir, ".mcp.json"));
  }
  return { mcpConfig, signedSessionId: signed && sid != null ? sid : null };
}

/**
 * Item 46 PR-B: make the world's config bind THIS turn's session. Called by a
 * caller once its bot_sessions row exists (after its own upsert, before the
 * spawn). When the config was built for another session — or for none (a
 * first turn: no row existed at buildBotWorld time), or a key-less host could
 * not get signatures then (the session was not live yet) — the config is
 * rebuilt with the row's id; otherwise nothing happens. The session rows are
 * not touched. Returns true when it rebuilt; the caller then hands
 * `world.mcpConfig` to the spawn (prepareSpawn copied the old one).
 */
export async function bindWorldSession(world, session) {
  if (!world || !world._mcpArgs || !session || session.id == null) return false;
  const id = Number(session.id);
  if (world.signedSessionId === id) return false;
  const { mcpConfig, signedSessionId } = await writeWorldMcp(world._mcpArgs, id);
  world.mcpConfig = mcpConfig;
  world.sessionId = id;
  world.signedSessionId = signedSessionId;
  return true;
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
 *          projectShares, sessionDir, cwd, tasksDbPath, remoteEnabled, peerGatewayUrls,
 *          session, narrowedTools, gatewayType, kitInstalled, houseStyle,
 *          extraReadPaths, extraWritePaths}>}
 *   `projectShares` is loadBotShares(botId) as read for THIS spawn
 *   ({project_id, level, workspace_dir, name, suspended}), so a UI can list the
 *   bot's shared projects; only its non-suspended shares' top-level workspace
 *   entries reach extraReadPaths (and extraWritePaths for `read_write`) — never
 *   a shared workspace's `bots` subtree (shareWorkspaceRoots).
 */
export async function buildBotWorld({ botId, threadId, gatewayType = null, log = () => {}, jobId = null, cardBound = false, cwd = null, repoSkillsDir = undefined }) {
  const B = await loadBridge();
  const bot = B.loadBot(botId);
  // Active Crow instance home (CROW_HOME env -> ~/.crow-mpa on MPA, else
  // ~/.crow). Governs per-instance skills + mcp-addons resolution; the DB
  // still routes on CROW_DB_PATH, independent of this.
  const crowHome = resolveCrowHome();
  // A selected repo skill's declared `server/tool` entries (skill-tools.mjs),
  // on a COPY of the def so writeBotMcp, prepareSpawn and buildToolsCsv all
  // see the same list; never past the model's tool cap, never a declined one.
  // M3b atomic cutover: column is authoritative. JSON copy is ignored even
  // if present (legacy fixtures may still carry it; new bots don't write it).
  const projectId = bot.project_id == null ? null : Number(bot.project_id);
  // Whether this turn mounts the board server (writeWorldMcp's ensureServers):
  // a job turn, a card-bound session, or a turn of a project bot that is shown
  // its cards — on every channel, because the board server itself scopes what
  // a bot may read and write to its own project (board-mcp.js). The voice bot
  // stays out: it answers as speech, and its turn loop has no board.
  const projectBoard = !isVoiceBotDef(bot.def) && projectShowsCards(projectId, bot.def);
  // Writes come from a Perch chat, a card-bound session or a job; any other channel turn gets
  // the read verbs only (board-mcp.js refuses its card writes as well).
  const boardReadOnly = !jobId && !cardBound && gatewayType !== "perch";
  const def = await withBoardTools(await withSkillTools(bot.def, { crowHome, log, repoSkillsDir }),
    { wanted: !!(jobId || cardBound || projectBoard), readOnly: boardReadOnly, log });
  const projectSpace = B.loadProjectSpace(projectId);
  const projectMembers = B.loadProjectMembers(projectId);
  // Phase 1 bot↔project shares (Task 10): the projects this bot holds a live
  // share of, read fresh on EVERY world build. FILE-SYSTEM REACH FOLLOWS THE
  // SHARE AT THE NEXT SPAWN: read_paths/write_paths are fixed when pi starts,
  // so a revoke or a suspension cannot recall a root from a running child (a
  // live Perch session picks it up at its next spawn/wake; a channel turn at
  // its next turn). THE MCP TOOLS ARE RECHECKED PER CALL (resolveBotAccess), so
  // tool calls are never one session behind. A `read` share contributes a read
  // root only; a `read_write` share adds its workspace to the write roots too.
  const projectShares = B.loadBotShares(botId);
  // The projects area this instance creates its project workspaces under
  // (botsProjectsRoot): a share's workspace_dir, and each entry it contributes,
  // must really sit there — see shareWorkspaceRoots' allowlist.
  const shareRoots = shareWorkspaceRoots(projectShares, { crowHome, projectsRoot: botsProjectsRoot(), log });
  // The remote-proxy rule is a different question with a different answer: NOT "does this list have
  // an entry" (it leaves out archived/tombstoned projects and dead bot defs) but "does the bot hold
  // any live project_bot_shares row" — the one rule mcp_writer's CLI, the regen panel and
  // server-side share checks apply. A suspension still counts, so it can never be used to regain
  // the proxy, and a failed read fails closed.
  const holdsShare = B.botHoldsLiveShareSync(botId);

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
  // Item 46 PR-B: the session this turn's actor signatures bind (the v2
  // relay signature names bot_sessions.id). A pure read, moved up from after
  // the config write so the config can carry it. A first turn of a thread has
  // no row yet: the caller stamps one, then bindWorldSession() rebuilds the
  // config with its id before anything is spawned.
  const session = B.getSession(botId, threadId);
  const mcpArgs = { def, sessionDir, crowHome, remoteEnabled, peerGatewayUrls, botId, jobId, threadId, gatewayType,
    displayName: bot.display_name, cardBound, projectBoard, mcpDelivery, log,
    // A live share (suspended ones included: a suspension must not be usable to regain the proxy
    // blocks) keeps every remote-proxy block out of this turn's config. projectShares above stays
    // the file-roots/reporting read; it is not what decides this.
    holdsShare };
  const { mcpConfig, signedSessionId } = await writeWorldMcp(mcpArgs, session ? session.id : null);

  // Install-approval gate (Phase 2.4): refuse non-allowlisted pi_extensions
  // that reached pi_bot_defs via an out-of-band DB edit (the GUI only offers
  // allowlisted ones). The bridge NEVER runs `pi install`; pi-lab is the
  // fixed package set. This is an audit/refusal surface, not a turn-killer.
  const extCheck = validateExtensions((def.tools && def.tools.pi_extensions) || []);
  if (extCheck.rejected.length) {
    log("REFUSED non-allowlisted pi_extensions: " + extCheck.rejected.join(", ") +
      " — Bot Builder never runs `pi install`; add via the pi-lab repo + scripts/pi-bots/pi_extensions_allowlist.mjs");
  }

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
  return { def, bot, crowHome, projectId, projectSpace, projectMembers, projectShares, sessionDir,
    cwd: resolvedCwd, mcpConfigPath: mcpDelivery === "file" ? join(sessionDir, ".mcp.json") : null,
    mcpDelivery, mcpConfig, tasksDbPath, remoteEnabled, peerGatewayUrls, session, botClassifier,
    narrowedTools, gatewayType, kitInstalled, houseStyle,
    // Item 46 PR-B: the session id the config's actor signatures bind, or
    // null when it binds none (no row yet, or a key-less host whose gateway
    // signed nothing). bindWorldSession() compares against it.
    sessionId: session ? Number(session.id) : null, signedSessionId, _mcpArgs: mcpArgs,
    // "Turn on a board" fallback carry-over (world-root.mjs): entries linked
    // one by one from the bot's own pre-project root resolve outside every
    // root pi-lab's realpath read gate knows, so that old root joins the read
    // roots. [] for every other bot. Then the share roots (Task 10): one read
    // root per live, non-suspended share's top-level workspace entry, and a
    // write root as well only for a `read_write` one (never the workspace's
    // `bots` subtree — see shareWorkspaceRoots).
    extraReadPaths: [
      ...carriedReadRoots({ worldRoot: sessionDir, legacyRoot: worldRootFor({ workspaceDir: null, def, crowHome, botId }) }),
      ...shareRoots.read,
    ],
    extraWritePaths: shareRoots.write };
}

/**
 * Phase B — spawn readiness. The system-prompt file, the resolved model, and
 * the PiRpc option bag. The CALLER adds piSessionId (the resume decision is
 * channel policy, not world state) and any test seams.
 *
 * @param {object} world  the object buildBotWorld() returned
 * @param {{escalate?: boolean, log?: (m: string) => void, probe?: Function}} [opts]
 *   `probe` is the bare-server listing seam (threaded into primeBareServerTools), for
 *   a caller that must not spawn a real MCP server.
 * @returns {Promise<{sysFile, selfAuthoringDir, resolved, piRpcOpts}>}
 */
export async function prepareSpawn(world, { escalate = false, log = () => {}, probe } = {}) {
  const def = world.def, crowHome = world.crowHome;
  // A BARE crow_mcp entry (e.g. "studio") only expands to that server's real tool names
  // (`mcp__studio__<tool>`, the shape pi-lab registers) when its list is known BEFORE the
  // spawn — toolAllowlist() is synchronous and reads only the snapshot it is handed. So the
  // listing is taken here and RETURNED as this spawn's map: it goes onto piRpcOpts below,
  // and the budget check in handleInbound reads the same piRpcOpts.bareServerTools, so the
  // count and the spawn see one listing. Never throws: a server that cannot be listed keeps
  // today's spelling and warns once.
  const bareServerTools = await primeBareServerTools(def, { crowHome, log, probe });

  const sysFile = join(mkdtempSync(join(tmpdir(), "pibot-")), "sys.md");
  writeFileSync(sysFile, def.system_prompt || "You are a Crow bot.", { mode: 0o600 });
  // Crow defaults (crow-defaults.mjs): the operator's writing rules, the board
  // habits when this turn has the board, and honesty about actions. Not for
  // the voice bot, whose prompt is shaped for speech.
  if (!isVoiceBotDef(def)) {
    appendFileSync(sysFile, "\n\n" + crowDefaultsBlock({ writingRules: readWritingRules(), boardOn: botGrantsServer(def, "board") }));
  }

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
  // Task 17: the pi provider (crow-c-* for a consented cloud row), mapped
  // here, before the bridge records the session as active.
  const piProvider = piProviderIdHere(resolved.provider);
  if (piProvider == null) throw new PiModelUnavailableError(`model "${resolved.provider}/${resolved.model}" is not available to the bot engine`);

  // Task 10: the share-derived WRITE roots a `read_write` share contributes
  // (PiRpc appends them to write_paths); a `read` share never appears here.
  // The key is set ONLY when it has entries: PiRpc treats a present-but-empty
  // list as "rewrite write_paths", which would add a `write_paths` key to a
  // def whose policy never carried one. Absent on a hand-built world, too.
  const extraWritePaths = Array.isArray(world.extraWritePaths) ? world.extraWritePaths : [];

  return {
    sysFile,
    selfAuthoringDir,
    resolved,
    piRpcOpts: {
      def,
      sessionDir: world.sessionDir,
      resolved,
      piProvider,
      selfAuthoringDir,
      remoteEnabled: world.remoteEnabled,
      botClassifier: world.botClassifier || null,
      narrowedTools: world.narrowedTools,
      // The bare-entry listing snapshot taken above ({} when the def has none): the
      // spawn's --tools csv and the channel budget check both read exactly this.
      bareServerTools,
      appendSystemPromptFile: sysFile,
      // S6-CROW: the bot's project workspace joins its read roots (PiRpc,
      // bot-read-paths.mjs); null for a bot without a project.
      projectWorkspaceDir: (world.projectId != null && world.projectSpace && world.projectSpace.workspace_dir) || null,
      // The bot's id, for the workspace env (bot-workspace-env.mjs).
      botId: (world.bot && world.bot.bot_id) || null,
      extraReadPaths: world.extraReadPaths || [],
      ...(extraWritePaths.length ? { extraWritePaths } : {}),
      // S6-CROW: how the MCP config reaches pi. Absent on a hand-built world
      // (test seams) => PiRpc's pre-S6 file env.
      mcpDelivery: world.mcpDelivery,
      mcpConfig: world.mcpConfig,
    },
  };
}
