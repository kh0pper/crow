// Queue item 19, step 1: CROW_APP_ENV_PATH is the one way to say which app env
// file an instance uses. Every reader honors it; a new reader that joins
// "<root>/.env" on its own would make a hardened instance read (or fail on)
// the shared checkout .env.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dirname, "..");

test("env-manager resolveEnvPath: the instance's <CROW_HOME>/.env, else CROW_APP_ENV_PATH, never the checkout .env when that is set", async () => {
  const { resolveEnvPath, APP_ROOT } = await import("../servers/gateway/env-manager.js");
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const prev = { a: process.env.CROW_APP_ENV_PATH, h: process.env.CROW_HOME };
  const home = mkdtempSync(join(tmpdir(), "crow-envpath-"));
  try {
    process.env.CROW_HOME = home;
    process.env.CROW_APP_ENV_PATH = "/srv/instance-b/app.env";
    assert.equal(resolveEnvPath(), "/srv/instance-b/app.env");
    writeFileSync(join(home, ".env"), "X=1\n");
    assert.equal(resolveEnvPath(), join(home, ".env"), "the instance settings env keeps priority");
    rmSync(join(home, ".env"));
    delete process.env.CROW_APP_ENV_PATH;
    assert.equal(resolveEnvPath(), join(APP_ROOT, ".env"));
  } finally {
    for (const [k, v] of [["CROW_APP_ENV_PATH", prev.a], ["CROW_HOME", prev.h]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    rmSync(home, { recursive: true, force: true });
  }
});

function* files(dir) {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules") continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) yield* files(p);
    else if (/\.(m?js|cjs)$/.test(e)) yield p;
  }
}

test("no reader in servers/ builds <root>/.env without consulting CROW_APP_ENV_PATH", () => {
  const ALLOWED = new Set([
    "servers/gateway/env-manager.js", // resolveEnvPath: checks CROW_APP_ENV_PATH first (tested above)
  ]);
  const hits = [];
  for (const f of files(join(REPO, "servers"))) {
    const rel = f.slice(REPO.length + 1);
    readFileSync(f, "utf8").split("\n").forEach((line, i) => {
      if (/(join|resolve)\(\s*(APP_ROOT|ROOT|appRoot|REPO|REPO_ROOT|repoRoot|__appRoot|appDir)\s*,\s*["']\.env["']\)/.test(line) && !line.includes("CROW_APP_ENV_PATH") && !ALLOWED.has(rel)) {
        hits.push(`${rel}:${i + 1}`);
      }
    });
  }
  assert.deepEqual(hits, []);
});
