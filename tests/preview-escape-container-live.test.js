/**
 * The preview render's escape cases, live in the REAL preview container (R4-C6): the
 * same case list as tests/preview-escape-live.test.js (tests/fixtures/
 * preview-escape-cases.mjs), driven through renderer.acquire() against the real image,
 * with renderInContext on the leased cdp and the real artifact origin reached through
 * createOriginFetcher. It also checks that the container under test runs under seccomp
 * (Seccomp: 2) with only a loopback interface.
 *
 * Runs only with CROW_REQUIRE_DOCKER=1 (required on the box before the preview renderer
 * merges); without it every case skips, even where Docker is present. With it, missing
 * Docker is a failure. CPU only. Every container it starts is removed in `after`.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createPreviewRenderer } from "../servers/gateway/preview/renderer.js";
import { startEscapeHarness, ESCAPE_CASES } from "./fixtures/preview-escape-cases.mjs";

const REQUIRED = process.env.CROW_REQUIRE_DOCKER === "1";
const docker = (args) => spawnSync("docker", args, { encoding: "utf8", timeout: 60_000 });
const HAVE_DOCKER = REQUIRED && docker(["version", "--format", "{{.Server.Version}}"]).status === 0 && docker(["compose", "version"]).status === 0;
if (REQUIRED && !HAVE_DOCKER) {
  test("Docker is available (CROW_REQUIRE_DOCKER=1)", () => assert.fail("CROW_REQUIRE_DOCKER=1 but `docker` / `docker compose` is not usable here"));
}
const live = (name, fn) => test(name, { skip: HAVE_DOCKER ? false : (REQUIRED ? "Docker not available" : "Docker-gated: set CROW_REQUIRE_DOCKER=1 to run"), timeout: 20 * 60_000 }, fn);

const SCRATCH = mkdtempSync(join(tmpdir(), "crow-preview-escape-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const names = new Set();
let renderer = null;
let h = null;
let label = null;

function settingsDb() {
  const rows = new Map([["previews_enabled", "true"]]);
  return {
    async execute(q) {
      const sql = typeof q === "string" ? q : q.sql;
      const args = (typeof q === "string" ? [] : q.args) || [];
      if (/^\s*SELECT value FROM dashboard_settings WHERE key/i.test(sql)) return { rows: rows.has(args[0]) ? [{ value: rows.get(args[0]) }] : [] };
      return { rows: [] };
    },
  };
}

/** acquire(), waiting out a first build of the image if it isn't there yet. */
async function acquireReady(r) {
  const deadline = Date.now() + 15 * 60_000;
  for (;;) {
    const lease = await r.acquire();
    if (lease.cdp) { names.add(r.runName()); return lease; }
    assert.equal(lease.off, "building", `acquire: ${JSON.stringify(lease)} (build ${r.buildState()})\n${r.stderrTail().slice(-2000)}`);
    assert.ok(Date.now() < deadline, "the image build finished in 15 minutes");
    await sleep(2_000);
  }
}

/** One lease per call; released with timedOut when the render inside timed out (R2). */
async function withCdp(fn) {
  const lease = await acquireReady(renderer);
  let out;
  try {
    out = await fn(lease.cdp);
    return out;
  } finally {
    lease.release({ timedOut: out?.err?.code === "preview_timeout" });
  }
}

before(async () => {
  if (!HAVE_DOCKER) return;
  h = await startEscapeHarness({ withCdp });
  renderer = createPreviewRenderer({
    crowHome: mkdtempSync(join(SCRATCH, "home-")), db: settingsDb(),
    instanceId: `escape-${randomBytes(6).toString("hex")}`,
    // The browser sees the origin's public base; the fetcher reaches its bind address.
    originInfo: () => ({ baseUrl: h.base }),
  });
});

after(async () => {
  if (HAVE_DOCKER) {
    try { await renderer?.stop(); } catch {}
    for (const n of names) docker(["rm", "-f", n]);
    for (const l of new Set([...names].map((n) => n.split("-")[2]))) {
      const left = docker(["ps", "-aq", "--filter", "label=crow.component=preview-renderer", "--filter", `label=crow.instance=${l}`]).stdout.trim();
      if (left) docker(["rm", "-f", ...left.split(/\s+/)]);
      assert.equal(docker(["ps", "-aq", "--filter", `label=crow.instance=${l}`]).stdout.trim(), "", "every test container is gone");
    }
    await h?.close();
  }
  rmSync(SCRATCH, { recursive: true, force: true });
});

live("the container under test runs under seccomp with only loopback", async () => {
  await withCdp(async () => {
    const name = renderer.runName();
    label = name.split("-")[2];
    const exec = (...cmd) => docker(["exec", name, ...cmd]);
    const ps = exec("sh", "-c", "for p in /proc/[0-9]*; do c=$(tr '\\0' ' ' < $p/cmdline 2>/dev/null); case \"$c\" in /usr/lib/chromium/chromium*) case \"$c\" in *--type=*) ;; *) grep '^Seccomp:' $p/status;; esac;; esac; done");
    assert.match(ps.stdout, /^Seccomp:\t2$/m, ps.stderr);
    const net = exec("ls", "/sys/class/net");
    assert.deepEqual(net.stdout.split(/\s+/).filter(Boolean), ["lo"]);
    console.log(`[escape container] ${name}: browser ${ps.stdout.trim()}, interfaces ${net.stdout.trim().split(/\s+/).join(",")}`);
  });
});

for (const c of ESCAPE_CASES) {
  live(`${c.name} (container)`, async () => {
    await c.run(h, (line) => console.log(`[escape container] ${line}`), withCdp);
  });
}

live("the same container served every case", async () => {
  assert.equal(names.size, 1, `containers used: ${[...names].join(", ")}`);
  assert.ok(label);
});
