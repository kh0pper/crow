/**
 * bundle-s6-init.test.js — an s6-overlay image cannot be run behind `init: true`.
 *
 * `init: true` puts docker-init (tini) in as PID 1. An image whose entrypoint is
 * /init (s6-overlay) refuses that: the supervisor must BE PID 1, so it exits at once
 * with "s6-overlay-suexec: fatal: can only run as pid 1" and the container
 * crash-loops. The s6 supervisor reaps zombies itself, so `init: true` buys nothing
 * there either.
 *
 * Text-level: the repo has no YAML parser, so this is a line-based scan in the
 * style of tests/workspace-bundle.test.js (serviceBlocks) and
 * tests/compose-image-pins.test.js (walk bundles/**\/docker-compose*.yml).
 *
 * A service is a violation when it sets `init: true`, its image matches a known
 * s6-overlay image, and it does not override `entrypoint`. An overridden
 * entrypoint replaces /init, so `init: true` is fine there — that is how
 * calibre-server runs linuxserver/calibre.
 *
 * The checker is exported so its red cases can be driven from fixture strings
 * instead of by editing a real compose file.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = join(import.meta.dirname, "..");

/** Directories never worth walking: dependencies and VCS. */
const SKIP_DIRS = new Set(["node_modules", ".git", ".pi-brief"]);

/** Skipped ONLY at the walk's start: the checkout's generated scratch area. */
const ROOT_SKIP_DIRS = new Set(["data"]);

/** docker-compose.yml / docker-compose.tailnet.yml / compose.yml / *.yaml … */
const COMPOSE_FILE_RE = /^(?:docker-)?compose(?:[.-][A-Za-z0-9_.-]+)?\.ya?ml$/;

/**
 * Images whose entrypoint is /init (s6-overlay) and whose supervisor must run as
 * PID 1: every linuxserver.io image (linuxserver/*, lscr.io/linuxserver/*,
 * ghcr.io/linuxserver/*), Paperless-ngx, and Frigate. `linuxserver/` also covers
 * the registries it is reachable through, since both spell the org the same way.
 */
const S6_IMAGE_RES = [
  /(?:^|\/)linuxserver\//,
  /paperlessngx\/paperless-ngx(?:[:@]|$)/,
  /ghcr\.io\/blakeblackshear\/frigate(?:[:@]|$)/,
];

/** Every compose file under `dir`, as repo-relative POSIX paths, sorted. */
export function findComposeFiles(dir = ROOT) {
  const out = [];
  const walk = (abs, isRoot = false) => {
    let entries;
    try { entries = readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || (isRoot && ROOT_SKIP_DIRS.has(e.name))) continue;
        walk(join(abs, e.name), false);
      } else if (e.isFile() && COMPOSE_FILE_RE.test(e.name)) {
        out.push(relative(dir, join(abs, e.name)).split(sep).join("/"));
      }
    }
  };
  walk(dir, true);
  return out.sort();
}

/**
 * The service blocks of a compose file: a name line is two spaces and a name,
 * `  app:`; the block runs to the next such line or to the file's next
 * top-level key. Comments and blank lines are dropped from the block text so a
 * NOTE about `init: true` is never read as the key itself.
 *
 * @returns {Array<{name: string, text: string}>}
 */
export function serviceBlocks(text) {
  const lines = String(text ?? "").split("\n");
  const start = lines.findIndex((l) => /^services:\s*$/.test(l));
  if (start < 0) return [];

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    // A top-level key: no indentation, not a comment, `key:` (or `key: value`).
    if (/^[A-Za-z0-9_."'-]+:[^\n]*$/.test(lines[i])) { end = i; break; }
  }

  const body = lines.slice(start + 1, end)
    .filter((l) => !/^\s*#/.test(l) && l.trim() !== "")
    .join("\n");

  const names = [...body.matchAll(/^  ([A-Za-z0-9_-]+):\s*$/gm)].map((m) => m[1]);
  return names.map((name, i) => {
    const from = body.search(new RegExp(`^  ${name}:\\s*$`, "m"));
    const to = i + 1 < names.length ? body.search(new RegExp(`^  ${names[i + 1]}:\\s*$`, "m")) : body.length;
    return { name, text: body.slice(from, to) };
  });
}

/** Whether a service block sets `key:` to a scalar line (flow style is ignored). */
function hasKey(text, key) {
  return new RegExp(`^\\s+${key}\\s*:`, "m").test(text);
}

/** The `image:` value of a service block, unquoted, with any trailing comment dropped. */
function imageOf(text) {
  const m = /^\s+image\s*:\s*(.+?)\s*$/m.exec(text);
  if (!m) return "";
  const raw = m[1].replace(/\s+#.*$/, "").trim();
  const s = (raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))
    ? raw.slice(1, -1).trim()
    : raw;
  return s;
}

/**
 * Compose interpolation, as far as an image reference needs it: `${VAR:-default}`
 * (and `${VAR-default}`) resolves to its default, which is the image compose
 * would run when the .env leaves the variable unset.
 */
export function resolveImageVars(raw) {
  return String(raw ?? "").replace(/\$\{([^}]*)\}/g, (whole, body) => {
    const m = /^[A-Za-z_][A-Za-z0-9_]*:?-([\s\S]*)$/.exec(body);
    return m ? m[1] : whole;
  });
}

/** Whether an already-resolved image reference is an s6-overlay image. */
export function isS6Image(ref) {
  const value = String(ref ?? "").trim();
  return S6_IMAGE_RES.some((re) => re.test(value));
}

/**
 * The services in one compose file's text that set `init: true` on an s6-overlay
 * image without overriding `entrypoint`.
 *
 * @param {string} text
 * @returns {string[]} violating service names, in file order
 */
export function s6InitViolations(text) {
  const out = [];
  for (const svc of serviceBlocks(text)) {
    if (!hasKey(svc.text, "init")) continue;
    if (!/^\s+init\s*:\s*true\s*$/m.test(svc.text)) continue;
    const image = resolveImageVars(imageOf(svc.text));
    if (!image || !isS6Image(image)) continue;
    if (hasKey(svc.text, "entrypoint")) continue;
    out.push(svc.name);
  }
  return out;
}

// ── the repo itself ──

test("no compose service runs an s6-overlay image behind init: true", () => {
  const files = findComposeFiles();
  assert.ok(files.includes("docker-compose.yml"), "the root compose file is walked");
  assert.ok(files.some((f) => f.startsWith("bundles/")), "bundle compose files are walked");
  assert.ok(!files.some((f) => f.includes("node_modules")), "node_modules is skipped");

  const violations = [];
  for (const file of files) {
    for (const name of s6InitViolations(readFileSync(join(ROOT, file), "utf8"))) violations.push(`${file}: ${name}`);
  }
  assert.deepEqual(violations, [], `init: true on an s6-overlay service:\n  ${violations.join("\n  ")}`);
});

test("paperless, bookstack and calibre-web exist and keep init: true out of their service block", () => {
  const cases = [
    ["bundles/paperless/docker-compose.yml", "paperless"],
    ["bundles/bookstack/docker-compose.yml", "bookstack"],
    ["bundles/calibre-web/docker-compose.yml", "calibre-web"],
  ];
  for (const [file, name] of cases) {
    const svc = serviceBlocks(readFileSync(join(ROOT, file), "utf8")).find((s) => s.name === name);
    assert.ok(svc, `${file} declares its ${name} service`);
    assert.doesNotMatch(svc.text, /^\s+init\s*:/m, `${file}: ${name} does not set init`);
  }
});

// ── the checker's red cases (fixture strings, never a real file) ──

const svc = (name, image, extra = "") => `services:\n  ${name}:\n    image: ${image}\n${extra}`;

test("red: init: true on a linuxserver/ image is a violation", () => {
  assert.deepEqual(s6InitViolations(svc("bookstack", "linuxserver/bookstack:26.09.2", "    init: true\n")), ["bookstack"]);
});

test("red: init: true on an lscr.io/linuxserver/ image is a violation", () => {
  assert.deepEqual(s6InitViolations(svc("app", "lscr.io/linuxserver/code-server:4.96.4", "    init: true\n")), ["app"]);
});

test("red: init: true on a ghcr.io/linuxserver/ image is a violation", () => {
  assert.deepEqual(s6InitViolations(svc("app", "ghcr.io/linuxserver/paperless-ngx:2.15.3", "    init: true\n")), ["app"]);
});

test("red: init: true on paperlessngx/paperless-ngx is a violation", () => {
  assert.deepEqual(s6InitViolations(svc("paperless", "paperlessngx/paperless-ngx:3.4.2", "    init: true\n")), ["paperless"]);
});

test("red: init: true on Frigate is a violation", () => {
  assert.deepEqual(s6InitViolations(svc("frigate", "ghcr.io/blakeblackshear/frigate:stable", "    init: true\n")), ["frigate"]);
});

test("red: an image behind ${VAR:-default} is judged by its default", () => {
  assert.deepEqual(s6InitViolations(svc("app", "${APP_IMAGE:-lscr.io/linuxserver/sonarr:4.0.15}", "    init: true\n")), ["app"]);
});

test("green: an overridden entrypoint replaces /init, so init: true passes", () => {
  const text = svc("calibre-server", "linuxserver/calibre:9.17.0", '    entrypoint: ["sh", "-c"]\n    init: true\n');
  assert.deepEqual(s6InitViolations(text), []);
});

test("green: init: true on an image that is not s6-overlay passes", () => {
  assert.deepEqual(s6InitViolations(svc("cache", "redis:7-alpine", "    init: true\n")), []);
  assert.deepEqual(s6InitViolations(svc("db", "postgres:15-alpine", "    init: true\n")), []);
});

test("green: no init at all passes, and init: false is not init: true", () => {
  assert.deepEqual(s6InitViolations(svc("calibre-web", "linuxserver/calibre-web:0.6.27")), []);
  assert.deepEqual(s6InitViolations(svc("calibre-web", "linuxserver/calibre-web:0.6.27", "    init: false\n")), []);
});

test("a comment mentioning init: true is not the key", () => {
  const text = svc("frigate", "ghcr.io/blakeblackshear/frigate:stable", "    # NOTE: init: true breaks Frigate\n");
  assert.deepEqual(s6InitViolations(text), []);
});

test("the scan reads per service: one clean neighbour does not clear a violation", () => {
  const text = [
    "services:",
    "  cache:",
    "    image: redis:7-alpine",
    "    init: true",
    "  app:",
    "    image: lscr.io/linuxserver/sonarr:4.0.15",
    "    init: true",
    "volumes:",
    "  data:",
    "",
  ].join("\n");
  assert.deepEqual(s6InitViolations(text), ["app"]);
  assert.deepEqual(serviceBlocks(text).map((s) => s.name), ["cache", "app"], "volumes: ends the services block");
});