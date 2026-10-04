/**
 * A private, throwaway headless Chrome for the suite's live-layout tests.
 *
 * Why this exists (2026-10-04): the CDP tests used to drive the operator's
 * LIVE crow-browser container on :9223. That made them depend on prod state
 * (open tabs, load, background-tab timer throttling, a shared localStorage)
 * and made the suite poke a production service. Under full-suite load
 * "F1b live" (3 !== 2) and "crossing the breakpoint" flaked there.
 *
 * Now every test file that needs a browser starts its OWN Chrome: fresh
 * user-data-dir, --remote-debugging-port=0 (the OS picks a free port, so
 * concurrent files and concurrent suite runs never collide), renderer
 * backgrounding and timer throttling disabled (each test's tab is the only
 * thing that matters, and node --test runs files in parallel), killed and
 * wiped in after().
 *
 * Resolution order for the binary:
 *   1. CROW_TEST_CHROME            explicit path
 *   2. ~/.cache/ms-playwright      newest chromium_headless_shell-*, then chromium-*
 *   3. system chromium / chrome    (NOT under GitHub Actions — see below)
 * No binary → null, and the caller skips exactly as it did with no :9223.
 *
 * Under GITHUB_ACTIONS the system Chrome on the runner image is ignored unless
 * CROW_TEST_CHROME names it: these tests never ran in CI before this change,
 * and turning them on there is a separate decision, not a side effect.
 *
 * CROW_CDP_URL is still honoured as an explicit operator opt-in to an external
 * endpoint (e.g. a Dockerised browser); nothing defaults to 9223 any more.
 */
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readdirSync, existsSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";

function newestDir(base, prefix) {
  try {
    return readdirSync(base)
      .filter((d) => d.startsWith(prefix))
      .sort((a, b) => Number(b.slice(prefix.length)) - Number(a.slice(prefix.length)))
      .map((d) => join(base, d));
  } catch { return []; }
}

export function findChrome(env = process.env) {
  if (env.CROW_TEST_CHROME) return existsSync(env.CROW_TEST_CHROME) ? env.CROW_TEST_CHROME : null;
  const pw = env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), ".cache", "ms-playwright");
  for (const dir of newestDir(pw, "chromium_headless_shell-")) {
    for (const sub of ["chrome-linux", "chrome-headless-shell-linux64", "chrome-linux64"]) {
      const p = join(dir, sub, "chrome-headless-shell");
      if (existsSync(p)) return p;
    }
  }
  for (const dir of newestDir(pw, "chromium-")) {
    for (const sub of ["chrome-linux", "chrome-linux64"]) {
      const p = join(dir, sub, "chrome");
      if (existsSync(p)) return p;
    }
  }
  if (env.GITHUB_ACTIONS === "true") return null;
  for (const name of ["chromium", "chromium-browser", "google-chrome-stable", "google-chrome"]) {
    try {
      const p = execFileSync("which", [name], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      if (p) return p;
    } catch {}
  }
  return null;
}

/**
 * @returns {Promise<null | { cdp: string, pageHost: string, bindHost: string, close: () => Promise<void> }>}
 *   cdp       — http base of the DevTools endpoint (/json/version, /json/new …)
 *   pageHost  — the host the browser must use to reach a server the test binds
 *   bindHost  — the address the test's http server should listen on
 */
/**
 * Reap browsers a previous run could not clean up (its test process was
 * SIGKILLed or the host session died, 2026-10-04): every profile dir carries
 * owner.pid; if that pid is gone, kill any process whose cmdline names the
 * profile and remove the dir. Linux /proc only; a no-op elsewhere.
 */
export function reapStaleChromes() {
  if (!existsSync("/proc")) return 0;
  let reaped = 0;
  let dirs = [];
  try { dirs = readdirSync(tmpdir()).filter((d) => d.startsWith("crow-test-chrome-")).map((d) => join(tmpdir(), d)); } catch {}
  for (const dir of dirs) {
    let owner = 0;
    try { owner = Number(readFileSync(join(dir, "owner.pid"), "utf8")); } catch {
      // No owner.pid: still being created — or its creator died before writing
      // it. Only the latter is old; leave anything younger than 10 minutes.
      try { if (Date.now() - statSync(dir).mtimeMs > 600000) { rmSync(dir, { recursive: true, force: true }); reaped++; } } catch {}
      continue;
    }
    if (!Number.isInteger(owner) || owner <= 0) continue;   // partial write: not ours to judge
    let alive = false;
    try { process.kill(owner, 0); alive = true; } catch (e) { alive = e.code === "EPERM"; }
    if (alive) continue;
    for (const pid of readdirSync("/proc").filter((p) => /^\d+$/.test(p))) {
      try {
        if (readFileSync(`/proc/${pid}/cmdline`, "utf8").includes(`--user-data-dir=${dir}`)) process.kill(Number(pid), "SIGKILL");
      } catch {}
    }
    try { rmSync(dir, { recursive: true, force: true }); reaped++; } catch {}
  }
  return reaped;
}

export async function startHeadlessChrome({ timeoutMs = 20000 } = {}) {
  if (process.env.CROW_CDP_URL) {
    const cdp = process.env.CROW_CDP_URL;
    try {
      const r = await fetch(cdp + "/json/version", { signal: AbortSignal.timeout(2000) });
      if (!r.ok) return null;
    } catch { return null; }
    // An external (typically Dockerised) browser cannot reach host loopback.
    return { cdp, pageHost: process.env.CROW_CDP_HOST_IP || "172.17.0.1", bindHost: "0.0.0.0", close: async () => {} };
  }

  const bin = findChrome();
  if (!bin) return null;
  reapStaleChromes();
  const profile = mkdtempSync(join(tmpdir(), "crow-test-chrome-"));
  writeFileSync(join(profile, "owner.pid"), String(process.pid));
  const child = spawn(bin, [
    "--headless",
    "--remote-debugging-port=0",
    "--remote-debugging-address=127.0.0.1",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    // Ubuntu 24.04+ AppArmor blocks the unprivileged user namespaces Chrome's
    // sandbox needs; the browser only ever loads this test's loopback server.
    "--no-sandbox",
    "--disable-gpu",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-features=CalculateNativeWinOcclusion,IntensiveWakeUpThrottling",
    "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"], detached: true });

  let exited = false;
  child.on("exit", () => { exited = true; });
  // Never leak a browser if the test process dies before after() runs.
  const killer = () => { try { process.kill(-child.pid, "SIGKILL"); } catch {} };
  process.once("exit", killer);
  // The browser is its own process group (detached), so a runner that
  // SIGTERMs/SIGINTs this file (timeout, ctrl-C) would otherwise orphan it.
  // Kill it, then re-raise with the default disposition. (SIGKILL of the test
  // process cannot be caught; that case leaks one headless shell.)
  const onSignal = (sig) => {
    killer();
    try { rmSync(profile, { recursive: true, force: true }); } catch {}
    process.removeListener("SIGTERM", onSignal);
    process.removeListener("SIGINT", onSignal);
    process.kill(process.pid, sig);
  };
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);

  const close = async () => {
    process.removeListener("exit", killer);
    process.removeListener("SIGTERM", onSignal);
    process.removeListener("SIGINT", onSignal);
    if (!exited) {
      const gone = new Promise((r) => child.once("exit", r));
      try { process.kill(-child.pid, "SIGTERM"); } catch {}
      const t = setTimeout(killer, 3000);
      await Promise.race([gone, new Promise((r) => setTimeout(r, 4000))]);
      clearTimeout(t);
    }
    try { rmSync(profile, { recursive: true, force: true }); } catch {}
  };

  const wsUrl = await new Promise((resolve) => {
    let buf = "";
    const timer = setTimeout(() => resolve(null), timeoutMs);
    child.stderr.on("data", (d) => {
      buf += d.toString();
      const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) { clearTimeout(timer); resolve(m[1]); }
    });
    child.once("exit", () => { clearTimeout(timer); resolve(null); });
    child.once("error", () => { clearTimeout(timer); resolve(null); });
  });
  // Keep draining stderr so a chatty browser can never block on a full pipe.
  child.stderr.resume();
  if (!wsUrl) { await close(); return null; }
  const { host } = new URL(wsUrl);
  const cdp = "http://" + host;
  try {
    const r = await fetch(cdp + "/json/version", { signal: AbortSignal.timeout(5000) });
    if (!r.ok) { await close(); return null; }
  } catch { await close(); return null; }
  return { cdp, pageHost: "127.0.0.1", bindHost: "127.0.0.1", close };
}
