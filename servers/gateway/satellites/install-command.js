/**
 * The satellite install command (SAT-1, spec §4.1): two lines that fetch
 * scripts/satellite-install.sh from GitHub at crow's own boot sha and check its sha256 (computed
 * from crow's checkout at that sha) before running it.
 *
 * SATELLITE_REPO is the ONE place the GitHub repo is named (the repo may move to an org later;
 * the pinned sha + checksum is what makes the command safe, not the repo path).
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getBootSha } from "../convergence.js";

export const SATELLITE_REPO = "kh0pper/crow";
export const INSTALL_SCRIPT_PATH = "scripts/satellite-install.sh";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const SHA_RE = /^[0-9a-f]{40}$/;

/** `git show <sha>:<path>` from crow's checkout as a Buffer, or null when absent / on error. */
export function defaultGitShow(sha, path, { appRoot = APP_ROOT } = {}) {
  return new Promise((done) => {
    execFile("git", ["-C", appRoot, "show", `${sha}:${path}`], { encoding: "buffer", maxBuffer: 4 * 1024 * 1024, timeout: 10000 },
      (err, stdout) => done(err ? null : stdout));
  });
}

/** {ok:true, sha, sha256, command} or {ok:false, code:"not_available"}. */
export async function buildInstallCommand({ sha = getBootSha(), gitShowImpl = defaultGitShow, repo = SATELLITE_REPO } = {}) {
  if (typeof sha !== "string" || !SHA_RE.test(sha)) return { ok: false, code: "not_available" };
  const script = await gitShowImpl(sha, INSTALL_SCRIPT_PATH);
  if (!script || !script.length) return { ok: false, code: "not_available" };
  const sha256 = createHash("sha256").update(script).digest("hex");
  const command =
    `curl -fsSL https://raw.githubusercontent.com/${repo}/${sha}/${INSTALL_SCRIPT_PATH} -o satellite-install.sh\n` +
    `echo "${sha256}  satellite-install.sh" | sha256sum -c - && bash satellite-install.sh --sha ${sha}`;
  return { ok: true, sha, sha256, command };
}
