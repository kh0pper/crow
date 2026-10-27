/**
 * The preview renderer's lifecycle, live (Docker-gated): the real image, started by
 * createPreviewRenderer through the real docker CLI, exactly as the gateway starts it.
 *
 *   (a) closing stdin ends it: after one render, a stop closes stdin; the child exits on
 *       its own and the container is gone within 5 s.
 *   (b) a killed compose CLI leaves nothing behind: SIGKILL the compose child while the
 *       container runs; within 10 s either the container is gone on its own or sweep()
 *       removes it. The test logs which (engineering question 1: what Compose does with
 *       `run --rm` and a dead client). It passes either way.
 *
 * Runs only with CROW_REQUIRE_DOCKER=1 (required on the box before the preview renderer
 * merges); without it every case skips, even where Docker is present. With it, missing
 * Docker is a failure. CPU only. Every container it starts is removed in `after`.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createPreviewRenderer, dockerCli } from "../servers/gateway/preview/renderer.js";

const REQUIRED = process.env.CROW_REQUIRE_DOCKER === "1";
const docker = (args) => spawnSync("docker", args, { encoding: "utf8", timeout: 60_000 });
const HAVE_DOCKER = REQUIRED && docker(["version", "--format", "{{.Server.Version}}"]).status === 0 && docker(["compose", "version"]).status === 0;
if (REQUIRED && !HAVE_DOCKER) {
  test("Docker is available (CROW_REQUIRE_DOCKER=1)", () => assert.fail("CROW_REQUIRE_DOCKER=1 but `docker` / `docker compose` is not usable here"));
}
const live = (name, fn) => test(name, { skip: HAVE_DOCKER ? false : (REQUIRED ? "Docker not available" : "Docker-gated: set CROW_REQUIRE_DOCKER=1 to run"), timeout: 20 * 60_000 }, fn);

const SCRATCH = mkdtempSync(join(tmpdir(), "crow-preview-live-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const gone = (name) => docker(["ps", "-aq", "--filter", `name=^${name}$`]).stdout.trim() === "";
const names = new Set();

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

/** A renderer of its own (fresh instance and home labels); `hold` parks its rm/ps calls. */
function makeRenderer() {
  const ctl = { hold: false, parked: [] };
  const wrapped = {
    exec(args, opts) {
      if (ctl.hold && (args[0] === "rm" || args[0] === "ps")) return new Promise((res) => ctl.parked.push({ args, run: () => dockerCli.exec(args, opts).then(res), skip: () => res({ code: 0, stdout: "", stderr: "" }) }));
      return dockerCli.exec(args, opts);
    },
    spawn: dockerCli.spawn,
  };
  const home = mkdtempSync(join(SCRATCH, "home-"));
  const r = createPreviewRenderer({
    crowHome: home, db: settingsDb(), docker: wrapped,
    instanceId: `live-${randomBytes(6).toString("hex")}`,
    originInfo: () => ({ baseUrl: "http://artifacts.example.test:3060" }),
  });
  return { r, ctl };
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

after(() => {
  if (HAVE_DOCKER) {
    for (const n of names) docker(["rm", "-f", n]);
    for (const label of new Set([...names].map((n) => n.split("-")[2]))) {
      const left = docker(["ps", "-aq", "--filter", "label=crow.component=preview-renderer", "--filter", `label=crow.instance=${label}`]).stdout.trim();
      if (left) docker(["rm", "-f", ...left.split(/\s+/)]);
      assert.equal(docker(["ps", "-aq", "--filter", `label=crow.instance=${label}`]).stdout.trim(), "", "every test container is gone");
    }
  }
  rmSync(SCRATCH, { recursive: true, force: true });
});

live("(a) closing stdin ends it", async () => {
  const { r } = makeRenderer();
  const lease = await acquireReady(r);
  // One render: a page, a script, closed.
  const { targetId } = await lease.cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await lease.cdp.send("Target.attachToTarget", { targetId, flatten: true });
  const v = await lease.cdp.send("Runtime.evaluate", { expression: "1 + 1", returnByValue: true }, sessionId);
  assert.equal(v.result.value, 2);
  await lease.cdp.send("Target.closeTarget", { targetId });
  const name = r.runName();
  const child = r._childForTest();
  lease.release();

  let exitedAt = null;
  child.once("exit", () => { exitedAt = Date.now(); });
  const t0 = Date.now();
  const stopping = r.stop(); // forced: stdin closes first
  let goneAt = null;
  while (Date.now() - t0 < 5_000) {
    if (gone(name)) { goneAt = Date.now(); break; }
    await sleep(100);
  }
  await stopping;
  console.log(`[live a] child exited ${exitedAt === null ? "never" : `${exitedAt - t0} ms`} after stdin closed; container gone at ${goneAt === null ? "not within 5 s" : `${goneAt - t0} ms`}`);
  assert.ok(exitedAt !== null && exitedAt - t0 < 5_000, "the child exits on stdin EOF, before the 5 s kill");
  assert.ok(goneAt !== null, "the container is gone within 5 s of stdin closing");
  assert.equal(r.state(), "stopped");
});

live("(b) a killed compose CLI leaves nothing behind", async () => {
  const { r, ctl } = makeRenderer();
  const lease = await acquireReady(r);
  const name = r.runName();
  const label = name.split("-")[2];
  const child = r._childForTest();
  assert.equal(docker(["inspect", "--format", "{{.State.Running}}", name]).stdout.trim(), "true", "the container runs");

  // Park the renderer's own cleanup (its exit handler's rm -f + sweep), so what we see
  // first is what Docker and Compose do by themselves.
  ctl.hold = true;
  const t0 = Date.now();
  child.kill("SIGKILL");
  let how = null;
  while (Date.now() - t0 < 8_000) {
    if (gone(name)) { how = `gone on its own after ${Date.now() - t0} ms`; break; }
    await sleep(200);
  }
  ctl.hold = false;
  const parked = ctl.parked.splice(0);
  for (const p of parked) p.skip();
  console.log(`[live b] the renderer's own cleanup was parked meanwhile: ${parked.map((p) => p.args.slice(0, 2).join(" ")).join(", ") || "nothing yet"}`);
  if (!how) {
    const state = docker(["inspect", "--format", "{{.State.Status}} exit={{.State.ExitCode}} autoremove={{.HostConfig.AutoRemove}}", name]).stdout.trim();
    const out = await r.sweep();
    assert.ok(out.removed.includes(name), `sweep removed it: ${JSON.stringify(out)}`);
    how = `still there after 8 s (${state}); sweep() removed it at ${Date.now() - t0} ms`;
  }
  console.log(`[live b] engineering question 1: after SIGKILL of the compose CLI the container was ${how}`);
  assert.ok(Date.now() - t0 <= 10_000, "within 10 s");
  assert.equal(docker(["ps", "-aq", "--filter", "label=crow.component=preview-renderer", "--filter", `label=crow.instance=${label}`]).stdout.trim(), "");
  lease.release();
  await sleep(200);
  assert.equal(r.state(), "stopped", "the renderer noticed its child died");
});
