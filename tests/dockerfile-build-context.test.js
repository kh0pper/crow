/**
 * Docker image build context.
 *
 * `docker build .` used to fail: `RUN node scripts/init-db.js` imports
 * ./pi-bots/bot-jobs-schema.mjs, the scripts/migrations it walks and many
 * servers/ files, but the Dockerfile copied only servers/ plus three single
 * scripts — and the gateway (servers/gateway/index.js) imports files under
 * scripts/ and bundles/ at runtime as well. The image now copies the whole build
 * context after the dependency layer, and a root .dockerignore keeps secrets,
 * runtime state and junk out of it.
 *
 * .dockerignore is an ALLOWLIST (`*` first, then the few paths the image needs),
 * because a developer's checkout holds untracked secrets a denylist would miss.
 * The tests below run the file through a small implementation of Docker's
 * documented ignore semantics and assert on paths, not on the presence of a
 * pattern string.
 *
 * Static only: no docker daemon, no build.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const read = (file) => readFileSync(join(ROOT, file), "utf-8");

/** Lines that are not comments and not blank, trimmed. */
const codeLines = (text) => text
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line !== "" && !line.startsWith("#"));

/** One .dockerignore pattern → an anchored RegExp over a context-relative path. */
function patternToRegExp(pattern) {
  const segments = pattern.split("/").map((segment) => {
    if (segment === "**") return null; // handled while joining
    // Escape regex metacharacters, then let `*` (inside one segment) and `?` through.
    return segment
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, "[^/]*")
      .replace(/\?/g, "[^/]");
  });
  let source = "";
  segments.forEach((segment, i) => {
    const last = i === segments.length - 1;
    if (segment === null) {
      // `**` = any number of path segments (including none).
      source += last ? ".*" : "(?:[^/]+/)*";
    } else {
      source += segment + (last ? "" : "/");
    }
  });
  return new RegExp(`^${source}$`);
}

/**
 * A Docker-ignore matcher following Docker's documented semantics:
 *  - patterns are matched against a path relative to the context root;
 *  - `**` matches any number of path segments, `*` only inside one segment;
 *  - a leading `!` negates (re-includes);
 *  - the LAST matching line wins;
 *  - a path is excluded when it, or any parent directory, is excluded and no
 *    later line re-includes it.
 */
function dockerIgnoreMatcher(text) {
  const patterns = codeLines(text)
    .map((line) => {
      const negated = line.startsWith("!");
      const body = (negated ? line.slice(1) : line).replace(/^\.?\//, "").replace(/\/+$/, "");
      return { line, negated, re: patternToRegExp(body) };
    });

  /** The last pattern matching one path, or undefined. */
  const lastMatch = (path) => {
    let hit;
    for (const pattern of patterns) if (pattern.re.test(path)) hit = pattern;
    return hit;
  };

  return (path) => {
    const parts = path.replace(/^\.?\//, "").replace(/\/+$/, "").split("/").filter(Boolean);
    assert.ok(parts.length > 0, `not a path: ${path}`);
    // Walk the ancestors down to the path itself: each prefix's last match
    // decides, and a prefix nothing matches inherits its parent's verdict (which
    // is why a file below an excluded directory stays out however it is named).
    let excluded = false;
    for (let i = 1; i <= parts.length; i++) {
      const hit = lastMatch(parts.slice(0, i).join("/"));
      if (hit) excluded = !hit.negated;
    }
    return excluded;
  };
}

test("Dockerfile copies the whole build context after the dependency layer", () => {
  const df = read("Dockerfile");
  const lines = codeLines(df);

  const ciIdx = lines.indexOf("RUN npm ci --omit=dev");
  assert.ok(ciIdx > -1, "the dependency layer must still run `npm ci --omit=dev`");
  // package*.json comes first so that layer stays cached when only code changes.
  const pkgIdx = lines.indexOf("COPY package*.json ./");
  assert.ok(pkgIdx > -1 && pkgIdx < ciIdx, "`COPY package*.json ./` must sit above `RUN npm ci`");

  const copyAllIdx = lines.indexOf("COPY . .");
  assert.ok(copyAllIdx > -1,
    "the image must copy the whole build context: init-db and the gateway import scripts/, migrations/ and bundles/");
  assert.ok(copyAllIdx > ciIdx, "`COPY . .` must come AFTER `RUN npm ci` so the dependency layer is not invalidated");
  // The DB init reads the files `COPY . .` now brings in.
  const initIdx = lines.findIndex((line) => line.startsWith("RUN mkdir -p data && node scripts/init-db.js"));
  assert.ok(initIdx > copyAllIdx, "the DB init runs against the copied tree");

  // The three single-script COPY lines are subsumed by `COPY . .`.
  assert.deepEqual(lines.filter((line) => /^COPY scripts\//.test(line)), [],
    "the per-file scripts/* COPY lines are redundant now");
  assert.deepEqual(lines.filter((line) => /^COPY servers/.test(line)), [],
    "…and so is the servers/ one");

  // Left as is: still root on purpose.
  assert.doesNotMatch(df, /^USER\s/m, "the image still runs as root (a non-root USER is a follow-up)");
  assert.match(df, /non-root USER/, "the follow-up is stated in a comment");
});

// ─── the allowlist, exercised through a matcher ─────────────────────────────

test(".dockerignore is an allowlist: `*` first, then only the paths the image needs", () => {
  assert.ok(existsSync(join(ROOT, ".dockerignore")), "a root .dockerignore must exist");
  const lines = codeLines(read(".dockerignore"));
  assert.equal(lines[0], "*",
    "the file must start by excluding everything — a denylist misses the next untracked secret");
  for (const needed of ["!servers", "!scripts", "!bundles", "!registry", "!package.json", "!package-lock.json"]) {
    assert.ok(lines.includes(needed), `.dockerignore must re-include ${needed}`);
  }
  // `servers/gateway/secrets/` is tracked code: no pattern may exclude a
  // directory called `secrets`, or the gateway loses its secret-handling modules.
  const secretsPatterns = lines.filter((line) => /(^|\/)secrets(\/|$)/.test(line.replace(/^!/, "")));
  assert.deepEqual(secretsPatterns, [], "servers/gateway/secrets/ is tracked code and must not be excluded");
});

test(".dockerignore keeps a developer's untracked secrets and junk out of the image", () => {
  const excludedBy = dockerIgnoreMatcher(read(".dockerignore"));

  // Every one of these lives in a real checkout's working tree: a filled-in
  // .mcp.json, config/models.json with API keys, per-bot state, nested bundle
  // .git dirs and .venvs, SQLite files, key material, logs and backups.
  for (const path of [
    ".mcp.json",
    "config/models.json",
    "models.json",
    "bots/x/def.json",
    "bundles/a/.git/config",
    "bundles/a/.venv/bin/python",
    "bundles/a/data/x.db",
    "bundles/a/.env",
    "bundles/a/key.pem",
    "data/crow.db",
    "undefined",
    "tests/x.test.js",
    "docs/index.md",
    ".git/HEAD",
    "node_modules/x/index.js",
    "servers/x.bak",
    "scripts/run.log",
    ".claude/settings.json",
    "GATEWAY-DB-INCIDENT-2026-08-03.md",
  ]) {
    assert.equal(excludedBy(path), true, `.dockerignore must keep ${path} out of the image`);
  }
});

test(".dockerignore keeps everything the image needs at runtime", () => {
  const excludedBy = dockerIgnoreMatcher(read(".dockerignore"));

  // The gateway imports from these at runtime and init-db walks scripts/, so
  // they have to survive BOTH the blanket `*` and the per-segment exclusions.
  for (const path of [
    "servers/gateway/index.js",
    "servers/gateway/secrets/mcp.js",
    "scripts/init-db.js",
    "scripts/pi-bots/bot-jobs-schema.mjs",
    "bundles/a/manifest.json",
    "bundles/a/.env.example",
    ".env.example",
    "registry/add-ons.json",
    "skills/x.md",
    "package.json",
    "package-lock.json",
    "LICENSE",
    "vendor/x.js",
    "templates/x.html",
  ]) {
    assert.equal(excludedBy(path), false, `.dockerignore must not strip ${path} from the image`);
  }
});