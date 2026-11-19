// Shared "is a Docker daemon reachable?" probe for tests that need a real one.
//
// Some CI environments (the Gitea runner's job containers, by design) have the
// docker CLI but no daemon socket. A test that needs a daemon passes
// `{ skip: dockerSkip() }` (or uses dockerTest) so it SELF-SKIPS there, and still
// runs everywhere a daemon is present. The reason is printed once per process.
// Never keyed off a CI env var: only what the daemon actually answers.
import { spawnSync } from "node:child_process";

/**
 * Probe for a reachable Docker daemon. `run` is injectable for tests.
 * Returns { available: boolean, reason: string } (reason is "" when available).
 */
export function probeDocker(run = (cmd, args) => spawnSync(cmd, args, { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] })) {
  let r;
  try { r = run("docker", ["version", "--format", "{{.Server.Version}}"]); }
  catch (e) { return { available: false, reason: `docker probe failed: ${String(e?.message || e).slice(0, 120)}` }; }
  if (r?.error) {
    return { available: false, reason: r.error.code === "ENOENT" ? "no docker CLI on this host" : `docker probe failed: ${String(r.error.message).slice(0, 120)}` };
  }
  if (r?.status !== 0 || !String(r?.stdout || "").trim()) {
    const why = String(r?.stderr || "").trim().split("\n")[0].slice(0, 120);
    return { available: false, reason: `no reachable Docker daemon${why ? ` (${why})` : ""}` };
  }
  return { available: true, reason: "" };
}

let cached = null;
let announced = false;

/** The memoised probe of the real host. */
export function dockerAvailable() {
  if (!cached) cached = probeDocker();
  return cached;
}

/** For `{ skip: dockerSkip() }`: false when a daemon is reachable, else the skip reason (printed once). */
export function dockerSkip() {
  const p = dockerAvailable();
  if (p.available) return false;
  const msg = `docker daemon not available: ${p.reason}`;
  if (!announced) { announced = true; console.error(`[docker-available] tests needing Docker will skip: ${msg}`); }
  return msg;
}
