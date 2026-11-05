/**
 * The CI gate's pure classification of a GitHub check-runs payload (A5), shared by the gateway's
 * auto-update and the satellite's follow-the-primary update (SAT-6). No imports: the satellite
 * agent must not load the gateway's auto-update module (it reaches crow.db).
 */

// The three branch-protection context names (the A1 contract). Other runs
// (deploy-docs, build, image-freshness) never block updates.
export const CI_GATE_CONTEXTS = ["suite", "static-checks", "audit"];

// Hosts whose check-runs api.github.com can answer for. `ssh.github.com` is
// GitHub's documented SSH-over-443 endpoint, so it is the same repository.
const GITHUB_HOSTS = new Set(["github.com", "www.github.com", "ssh.github.com"]);

/**
 * Parse a git remote URL into `{ owner, repo }` — but only when it really points
 * at github.com.
 *
 * A substring match on "github.com" was what the gate and the satellite update
 * used before (review round 1, S1): it read a LOCAL path containing
 * `github.com/o/r` as GitHub, and it missed every form whose host carries a
 * user, a port or different case (`ssh://git@ssh.github.com:443/o/r.git`,
 * `https://GitHub.com/o/r`, a trailing slash, `.git/`). Misses fail OPEN in the
 * gateway — the origin reads as "not GitHub", the gate says not-applicable and
 * the unverified commit deploys — so the host is parsed, lowercased and compared
 * exactly.
 *
 * Accepted forms:
 *   https://github.com/o/r(.git)      http://…      ssh://git@github.com/o/r(.git)
 *   ssh://git@ssh.github.com:443/o/r(.git)         git@github.com:o/r(.git)   (scp-like)
 * A local path, a `file://` URL and any other host return null: there is no
 * GitHub API to ask. Without a user part, `host:path` is still read as scp-like
 * (git accepts it), which is why the colon — not a leading path — decides.
 *
 * @param {string|null|undefined} url the output of `git remote get-url origin`
 * @returns {{owner: string, repo: string}|null}
 */
export function parseGithubRemote(url) {
  const raw = typeof url === "string" ? url.trim() : "";
  if (!raw) return null;

  let host;
  let path;
  const scheme = /^[a-z][a-z0-9+.-]*:\/\/(.*)$/i.exec(raw);
  if (scheme) {
    // <scheme>://[user[:pass]@]host[:port]/<path> — the authority ends at the
    // first slash; a `file://` URL has an empty authority and is not GitHub.
    const rest = scheme[1];
    const slash = rest.indexOf("/");
    const authority = slash === -1 ? rest : rest.slice(0, slash);
    path = slash === -1 ? "" : rest.slice(slash + 1);
    host = authority.slice(authority.lastIndexOf("@") + 1).replace(/:\d+$/, "");
  } else {
    // scp-like [user@]host:path. No colon (a local path, absolute or relative,
    // and a bare `host` with no path) means no remote host to read.
    const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/.exec(raw);
    if (!scp) return null;
    host = scp[1];
    path = scp[2];
  }

  if (!GITHUB_HOSTS.has(host.toLowerCase())) return null;

  // Trailing slashes (git accepts `o/r/` and `o/r.git/`) and the `.git` suffix
  // are transport details, not part of the repository's name.
  const parts = path.replace(/\/+$/, "").split("/").filter(Boolean);
  if (parts.length < 2) return null;
  const owner = parts[0];
  const repo = parts[1].replace(/\.git$/i, "");
  if (!owner || !repo) return null;
  return { owner, repo };
}

/** The runs in this payload that carry one of the three required contexts. */
export function ciGateRuns(payload) {
  return (payload?.check_runs || []).filter((r) => CI_GATE_CONTEXTS.includes(r?.name));
}

/**
 * The required contexts this payload has NO run for.
 *
 * classifyCheckRuns answers "pending" for two very different shapes: a context
 * that has not reported YET (its run is queued or in progress) and a context
 * that will NEVER report on this origin (a fork carrying only some of our
 * workflows). The gateway needs the difference to word its skip, and to stop
 * calling a partial-CI fork "still running" forever (review round 2). The
 * classifier's own return values are untouched — this is a second read of the
 * same payload, not a sixth verdict.
 */
export function missingCiContexts(payload) {
  const present = new Set(ciGateRuns(payload).map((r) => r.name));
  return CI_GATE_CONTEXTS.filter((name) => !present.has(name));
}

/**
 * Pure classification of a GitHub check-runs payload for the target sha.
 * "unknown" (no named runs — a fork without our CI, or a push that raced the
 * workflow) is not a deployment decision: nothing here can verify the sha, so it
 * is never green. The gateway's auto-update maps it to "no-ci" (a fork without
 * this repo's CI) and the satellite accepts only "green".
 *
 * Green requires ALL THREE contexts to be present and successful (review round
 * 1, S3): a sha where only `audit` has reported so far used to read green and be
 * deployed before `suite` and `static-checks` ever ran. A present-and-finished
 * subset is "pending" (the rest has not reported yet), a red run is "red" even
 * when another context is still missing, and no run at all is "unknown".
 *
 * A finished subset with a context missing is "pending" HERE — the gateway
 * turns that shape into "no-ci" when nothing is still running (review round 2,
 * see missingCiContexts); the satellite keeps treating it as a refusal.
 */
export function classifyCheckRuns(payload) {
  const runs = ciGateRuns(payload);
  if (runs.length === 0) return "unknown";
  if (runs.some((r) => r.status !== "completed")) return "pending";
  const ok = ["success", "neutral", "skipped"];
  if (!runs.every((r) => ok.includes(r.conclusion))) return "red";
  const present = new Set(runs.map((r) => r.name));
  return CI_GATE_CONTEXTS.every((name) => present.has(name)) ? "green" : "pending";
}