// Queue item 19, step 1: CROW_APP_ENV_PATH is the one way to say which app env
// file an instance uses. Every reader honors it; a new reader that joins
// "<root>/.env" on its own would make a hardened instance read (or fail on)
// the shared checkout .env.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dirname, "..");

test("env-manager resolveEnvPath honors CROW_APP_ENV_PATH first", async () => {
  const { resolveEnvPath } = await import("../servers/gateway/env-manager.js");
  const prev = process.env.CROW_APP_ENV_PATH;
  try {
    process.env.CROW_APP_ENV_PATH = "/srv/instance-b/app.env";
    assert.equal(resolveEnvPath(), "/srv/instance-b/app.env");
  } finally {
    if (prev === undefined) delete process.env.CROW_APP_ENV_PATH; else process.env.CROW_APP_ENV_PATH = prev;
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
