// plan_ref: the card's pointer to its plan file. kind "repo" = markdown in
// the project's git repo (canonical, spec decision #1), resolved under
// project_spaces.repo_path; kind "workspace" = the legacy derived path
// <bot session_dir>/plans/<cardId>.md. Fail-closed everywhere: a ref that
// doesn't parse is null; a path that escapes its root is null.
import { existsSync, realpathSync } from "node:fs";

export function parsePlanRef(text) {
  if (text == null || text === "") return null;
  let o;
  try { o = JSON.parse(String(text)); } catch { return null; }
  if (!o || typeof o !== "object") return null;
  if (o.kind === "workspace") return { kind: "workspace" };
  if (o.kind === "repo") {
    const p = typeof o.path === "string" ? o.path : "";
    if (!p || p.startsWith("/") || p.split("/").includes("..")) return null;
    return { kind: "repo", path: p };
  }
  return null;
}

// Moved VERBATIM from bot-board-api.js (Task 3): resolved file must live
// under root; for a not-yet-existing file, resolve+contain the parent dir.
export function containedRealPath(path, root) {
  try {
    const rootReal = realpathSync(root);
    let real;
    if (existsSync(path)) {
      real = realpathSync(path);
    } else {
      const slash = path.lastIndexOf("/");
      const dir = path.slice(0, slash);
      if (!existsSync(dir)) return null;
      real = realpathSync(dir) + path.slice(slash);
    }
    if (real === rootReal || real.startsWith(rootReal + "/")) return real;
    return null;
  } catch {
    return null;
  }
}

// planRef + context → { path, root, kind } or null. repoRoot comes from
// project_spaces.repo_path; workspaceInfo is the legacy derivePlanPath()
// result ({ path, sessionDir }). Null planRef = legacy card → workspace.
export function resolvePlanFile(planRef, { repoRoot, workspaceInfo }) {
  if (planRef && planRef.kind === "repo") {
    if (!repoRoot) return null;
    const root = String(repoRoot).replace(/\/+$/, "");
    return { path: root + "/" + planRef.path, root, kind: "repo" };
  }
  if (workspaceInfo && workspaceInfo.path && workspaceInfo.sessionDir) {
    return { path: workspaceInfo.path, root: workspaceInfo.sessionDir, kind: "workspace" };
  }
  return null;
}
