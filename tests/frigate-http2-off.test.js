/**
 * Frigate bundle: nginx HTTP/2 is turned OFF for every install, unconditionally —
 * tests/frigate-http2-off.test.js
 *
 * CVE-2026-123007 and CVE-2026-123633 are only exploitable while nginx has HTTP/2 on.
 * Frigate's image ships `http2 on;` in a STATIC /usr/local/nginx/conf/nginx.conf (no
 * config or environment switch for it), and its plain-HTTP listener on 8971 then
 * accepts cleartext HTTP/2 from any process on the same machine. Frigate does not need
 * HTTP/2 — Crow proxies its UI over HTTP/1.1 — so the bundle ships an s6-overlay legacy
 * cont-init hook (cont-init/10-crow-http2-off, mounted read-only at
 * /etc/cont-init.d/10-crow-http2-off) that rewrites the config before nginx starts.
 *
 * What this file pins, and why:
 *   1. the hook's BEHAVIOUR, run as POSIX sh against a scratch conf dir (its real
 *      target, /usr/local/nginx/conf, exists only inside Frigate's image, so the
 *      fixture below reproduces the shipped excerpt plus a `listen … http2;` line):
 *      `http2 on;` → `http2 off;`, the `http2` parameter dropped from every `listen`,
 *      every other line byte-identical, a second run a no-op ("already off"), and a
 *      missing config dir still exits 0 — the container must never be kept down by
 *      this hook;
 *   2. the WIRING: the compose file mounts that script read-only from the bundle's own
 *      folder (a relative path, which resolves next to the INSTALLED compose file in
 *      ~/.crow/bundles/frigate/), the image pin is untouched by this change, and
 *      manifest.refreshFiles ships cont-init/ on the version bump — without that the
 *      installed copy (which is already 1.3.x on every host) would never receive the
 *      hook, and the compose catch-up would mount a path that does not exist.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLE = join(ROOT, "bundles", "frigate");
const HOOK_REL = "cont-init/10-crow-http2-off";
const HOOK = join(BUNDLE, HOOK_REL);
const COMPOSE = readFileSync(join(BUNDLE, "docker-compose.yml"), "utf8");
const MANIFEST = JSON.parse(readFileSync(join(BUNDLE, "manifest.json"), "utf8"));
const REGISTRY = JSON.parse(readFileSync(join(ROOT, "registry", "add-ons.json"), "utf8"));

/**
 * Frigate 0.18.2's shipped nginx.conf, around the directive that matters (the same
 * lines the release image carries), with the `include listen.conf;` the server block
 * uses — the listener parameters live in that included file.
 */
const NGINX_CONF = [
  "    upstream jsmpeg {",
  "        server 127.0.0.1:8082;",
  "        keepalive 1024;",
  "    }",
  "",
  "    include go2rtc_upstream.conf;",
  "",
  "    server {",
  "        include listen.conf;",
  "",
  "        # enable HTTP/2 for TLS connections to eliminate browser 6-connection limit",
  "        http2 on;",
  "",
  "        # vod settings",
  "        vod_base_url '';",
  "        vod_segments_base_url '';",
  "        vod_mode mapped;",
  "        vod_max_mapping_response_size 1m;",
  "        vod_upstream_location /api;",
  "        vod_align_segments_to_key_frames on;",
  "    }",
  "",
].join("\n");

/** A conf file with no HTTP/2 anywhere: every byte must survive untouched. */
const UNRELATED_CONF = [
  "upstream go2rtc {",
  "    server 127.0.0.1:1984;",
  "}",
  "",
].join("\n");

function scratchDir() {
  return mkdtempSync(join(tmpdir(), "crow-frigate-http2-"));
}

/** Run the hook the way s6-overlay does — `sh <hook>` with the conf dir pointed at a scratch copy. */
function runHook(confDir) {
  const r = spawnSync("/bin/sh", [HOOK], {
    encoding: "utf8",
    env: { ...process.env, CROW_NGINX_CONF_DIR: confDir },
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function readConf(dir, name) {
  return readFileSync(join(dir, name), "utf8");
}

test("the hook rewrites http2 out of the shipped config and leaves everything else alone", (t) => {
  const dir = scratchDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "nginx.conf"), NGINX_CONF);
  // The listener parameters Frigate keeps in its own *.conf beside nginx.conf.
  writeFileSync(join(dir, "listen.conf"), "listen 8971 http2;\n");
  // The http2 parameter is not always last — it must go from the middle too.
  writeFileSync(join(dir, "tls.conf"), "listen 443 ssl http2 default_server;\n");
  writeFileSync(join(dir, "go2rtc_upstream.conf"), UNRELATED_CONF);

  const run = runHook(dir);
  assert.equal(run.status, 0, `the hook always exits 0: ${run.stderr}`);
  assert.match(run.stdout, /^\[crow\] nginx HTTP\/2 disabled \(CVE-2026-123007, CVE-2026-123633\)$/m);
  assert.equal(run.stderr, "", "a clean run warns about nothing");

  const expectedConf = NGINX_CONF.replace("        http2 on;", "        http2 off;");
  assert.equal(readConf(dir, "nginx.conf"), expectedConf, "http2 on; became http2 off;");
  assert.doesNotMatch(readConf(dir, "nginx.conf"), /http2\s+on\b/, "no http2 on; is left");

  // Unrelated lines are byte-identical: exactly ONE line of the file changed.
  const before = NGINX_CONF.split("\n");
  const after = readConf(dir, "nginx.conf").split("\n");
  assert.equal(after.length, before.length, "no line was added or removed");
  assert.equal(after.map((l, i) => (l === before[i] ? null : i)).filter((i) => i !== null).length, 1,
    "exactly one line differs from the shipped config");
  assert.ok(readConf(dir, "nginx.conf").includes("        include listen.conf;"), "the include line survives");

  // The listen parameter, both shapes.
  assert.equal(readConf(dir, "listen.conf"), "listen 8971;\n", "a trailing http2 parameter is dropped with its space");
  assert.equal(readConf(dir, "tls.conf"), "listen 443 ssl default_server;\n", "a mid-line http2 parameter is dropped");

  // A file with no HTTP/2 at all is not touched.
  assert.equal(readConf(dir, "go2rtc_upstream.conf"), UNRELATED_CONF);

  // No temporary file is left beside the configs.
  assert.deepEqual(readdirSync(dir).sort(), ["go2rtc_upstream.conf", "listen.conf", "nginx.conf", "tls.conf"]);
});

test("a second run is a no-op and says so", (t) => {
  const dir = scratchDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "nginx.conf"), NGINX_CONF);
  writeFileSync(join(dir, "listen.conf"), "listen 8971 http2;\n");

  assert.match(runHook(dir).stdout, /HTTP\/2 disabled/);
  const settled = {
    nginx: readConf(dir, "nginx.conf"),
    listen: readConf(dir, "listen.conf"),
  };

  const again = runHook(dir);
  assert.equal(again.status, 0);
  assert.match(again.stdout, /^\[crow\] nginx HTTP\/2 already off \(CVE-2026-123007, CVE-2026-123633\)$/m);
  assert.equal(again.stderr, "");
  assert.equal(readConf(dir, "nginx.conf"), settled.nginx, "idempotent: nginx.conf is byte-identical");
  assert.equal(readConf(dir, "listen.conf"), settled.listen, "idempotent: listen.conf is byte-identical");
});

test("a missing config directory never fails the container start", (t) => {
  const dir = scratchDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const missing = join(dir, "not-here");

  const run = runHook(missing);
  assert.equal(run.status, 0, "an unexpected image layout must not keep Frigate down");
  assert.match(run.stderr, /no nginx config directory/);
  assert.equal(run.stdout, "", "nothing is claimed to have been disabled");
});

test("a config directory with no *.conf files is a clean no-op", (t) => {
  const dir = scratchDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "conf.d"), { recursive: true });

  const run = runHook(dir);
  assert.equal(run.status, 0);
  assert.match(run.stdout, /already off/);
});

// ── the wiring: compose mount, image pin, and the refresh that ships it ──

test("the compose file mounts the hook read-only at /etc/cont-init.d/, from the bundle's own folder", () => {
  const mount = "      - ./cont-init/10-crow-http2-off:/etc/cont-init.d/10-crow-http2-off:ro";
  assert.ok(COMPOSE.includes(`${mount}\n`), `the frigate service mounts the hook read-only:\n${mount}`);
  // Relative (`./…`) so it resolves against the INSTALLED compose file's own directory
  // (where Crow copies the bundle), with :ro so the container cannot rewrite the hook.
  assert.match(COMPOSE, /^      - \.\/cont-init\/10-crow-http2-off:/m);
  assert.match(COMPOSE, /:\/etc\/cont-init\.d\/10-crow-http2-off:ro$/m);
});

test("the image pin is unchanged by this hardening", () => {
  const image = /^\s+image:\s*(\S+)\s*$/m.exec(COMPOSE);
  assert.ok(image, "the compose file pins an image");
  assert.equal(image[1],
    "ghcr.io/blakeblackshear/frigate:0.18.2@sha256:fd60f99ffd4eb6c42360ed4e14953e270586f239309ab3983e55b2e97ffac09a",
    "tag AND digest pin — a deliberate image bump changes this assertion too");
});

test("the hook ships in the repo and is POSIX sh", () => {
  assert.ok(existsSync(HOOK), `${HOOK_REL} exists`);
  const text = readFileSync(HOOK, "utf8");
  assert.equal(text.split("\n")[0], "#!/bin/sh", "POSIX sh: the image is busybox-based");
  assert.doesNotMatch(text, /\bbash\b/, "no bash-only syntax or shebang");
  // s6-overlay's legacy cont-init requires the file to be executable; git records that
  // mode (100755) with the commit, and the bind mount carries it into the container.
});

test("manifest.refreshFiles ships the hook on the version bump (installed copies get it too)", () => {
  assert.ok(Array.isArray(MANIFEST.refreshFiles), "the manifest declares refreshFiles");
  assert.ok(MANIFEST.refreshFiles.includes(HOOK_REL),
    `refreshFiles must carry ${HOOK_REL}: only a version bump refreshes an installed copy, and a docker bundle's fixed refresh dirs are server/panel/skills`);
  // The mount source must be one of those refreshed paths — a mount whose source is
  // never copied would be created as a directory by Docker on the next Start.
  const source = /^      - \.\/([^:]+):/m.exec(COMPOSE);
  assert.ok(source, "the mount has a relative source");
  assert.ok(MANIFEST.refreshFiles.includes(source[1]), `${source[1]} is refreshed with the bump`);
});

test("registry/add-ons.json is in step with the manifest (version + refreshFiles)", () => {
  const entry = REGISTRY["add-ons"].find((a) => a && a.id === "frigate");
  assert.ok(entry, "the registry publishes frigate");
  assert.equal(entry.version, MANIFEST.version, "registry version follows the manifest");
  assert.deepEqual(entry.refreshFiles, MANIFEST.refreshFiles, "registry refreshFiles follows the manifest");
});