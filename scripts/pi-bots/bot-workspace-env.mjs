/**
 * The bot's own project workspace, handed to pi-lab for its bash safety
 * check (the "own workspace is not sensitive" exemption).
 *
 * A bot whose board belongs to a project works inside that project's
 * workspace folder, which lives under the instance's data dir
 * (`<data>/projects/<slug>-<id>/workspace`). pi-lab's bash prefilter flags
 * any path under `~/.crow`, which made every routine command a bot ran in its
 * own workspace ask for approval. pi-lab relaxes that one tripwire for paths
 * that resolve inside the workspace, and it needs to know, from crow, which
 * folder that is and which root it must sit under.
 *
 * Fail closed: anything that is not an existing directory of the shape
 * `<projects root>/<one segment>/workspace` (after following symlinks, so `..` and links
 * cannot point it elsewhere), or a bot id outside a plain charset, yields NO
 * keys at all, and pi-lab then grants no exemption. The keys are
 * engine-reserved (PI_BOT_ prefix): the bridge strips them from a bot def's
 * spawn_env, so a bot can never choose its own workspace.
 *
 * Interactive (Perch) children only: the bridge decides that, and drops any
 * inherited copy of these keys first. pi-lab keeps `<workspace>/bots/**`
 * (every bot's engine world root, its own included) outside the exemption.
 * The interface is written down in the private engineering notes (the
 * pi-lab ask-timeout contract, 2026-10-20).
 */
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, sep } from "node:path";

export const BOT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

/** The keys this module may set; the bridge drops any inherited copy first. */
export const BOT_WORKSPACE_KEYS = Object.freeze(["PI_BOT_WORKSPACE", "PI_BOT_PROJECTS_ROOT", "PI_BOT_ID"]);

function realDir(p) {
  if (typeof p !== "string" || !p || !isAbsolute(p)) return null;
  try {
    const real = realpathSync(p);
    return statSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

/**
 * @param {{workspaceDir?: string|null, projectsRoot?: string|null, botId?: string|null}} opts
 * @returns {{PI_BOT_WORKSPACE?: string, PI_BOT_PROJECTS_ROOT?: string, PI_BOT_ID?: string}}
 */
export function botWorkspaceEnv({ workspaceDir = null, projectsRoot = null, botId = null } = {}) {
  if (typeof botId !== "string" || !BOT_ID_RE.test(botId)) return {};
  const root = realDir(projectsRoot);
  const ws = realDir(workspaceDir);
  if (!root || !ws) return {};
  // Exactly <root>/<one segment>/workspace: the shape project-spaces.js
  // writes (workspacePathFor). The root itself, anything deeper or shallower,
  // and anything a link resolves outside the root all fail.
  const prefix = root.endsWith(sep) ? root : root + sep;
  if (!ws.startsWith(prefix)) return {};
  const rest = ws.slice(prefix.length).split(sep);
  if (rest.length !== 2 || !rest[0] || rest[1] !== "workspace") return {};
  return { PI_BOT_WORKSPACE: ws, PI_BOT_PROJECTS_ROOT: root, PI_BOT_ID: botId };
}
