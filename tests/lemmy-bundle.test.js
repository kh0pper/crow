// tests/lemmy-bundle.test.js
//
// The Lemmy bundle never started: its entrypoint ran /app/lemmy, a path the pinned
// dessalines/lemmy image does not have (the binary is /usr/local/bin/lemmy_server);
// it wrote its config into a folder mounted read-only; its health checks called wget,
// which neither the lemmy nor the lemmy-ui image ships, so lemmy-ui (which waits for
// lemmy to be healthy) never started either; and pict-rs (uid 991) got a host folder
// the Docker daemon creates as root. These checks read the compose file and manifest
// so none of that comes back. The live proof (scratch home, real images) is in the PR.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const DIR = join(REPO, "bundles", "lemmy");
const compose = readFileSync(join(DIR, "docker-compose.yml"), "utf8");
const manifest = JSON.parse(readFileSync(join(DIR, "manifest.json"), "utf8"));

// The text of one service block (from its `  name:` line to the next top-level service).
const services = compose.slice(compose.search(/^services:\s*$/m));
function service(name) {
  const start = services.search(new RegExp(`^  ${name}:\\s*$`, "m"));
  assert.ok(start >= 0, `service ${name} exists`);
  const rest = services.slice(start + 1);
  const next = rest.search(/^  [a-z][a-z0-9-]*:\s*$/m);
  return next < 0 ? services.slice(start) : services.slice(start, start + 1 + next);
}
const lemmy = service("lemmy");

test("the entrypoint starts the binary the pinned image ships", () => {
  assert.match(lemmy, /image:\s*dessalines\/lemmy:0\.19\.\d+/);
  assert.match(lemmy, /^\s*exec lemmy_server\s*$/m, "exec lemmy_server (on PATH at /usr/local/bin)");
  assert.doesNotMatch(compose, /\/app\/lemmy/, "the image has no /app");
});

test("the config is written somewhere the container user can write, and read from there", () => {
  const loc = lemmy.match(/LEMMY_CONFIG_LOCATION:\s*"?([^"\s]+)"?/);
  assert.ok(loc, "LEMMY_CONFIG_LOCATION is set");
  assert.match(loc[1], /^\/tmp\//, "inside the container's own writable /tmp");
  assert.ok(lemmy.includes(`cat > ${loc[1]} <<`), "the entrypoint writes the file Lemmy reads");
  assert.match(lemmy, /umask 077/, "the file holding secrets is private to the container user");
  assert.doesNotMatch(lemmy, /^\s*-\s+\S+:\/config(?::ro)?\s*$/m, "no config folder mount");
});

test("health checks use a tool the images have (curl), not wget", () => {
  for (const name of ["lemmy", "lemmy-ui"]) {
    const s = service(name);
    assert.match(s, /healthcheck:[\s\S]*curl -fsS/, `${name} checks with curl`);
    assert.doesNotMatch(s, /wget/, `${name} images ship no wget`);
  }
});

test("pict-rs gets a Docker-managed volume (its uid 991 cannot write a root-created host folder)", () => {
  const p = service("pictrs");
  assert.match(p, /^\s*-\s+pictrs:\/mnt\s*$/m);
  assert.match(compose, /^volumes:[\s\S]*?^  pictrs:\s*$/m, "the named volume is declared");
});

test("all data lives in this compose project's own Docker volumes, never a host folder", () => {
  assert.doesNotMatch(compose, /~\/\.crow|LEMMY_DATA_DIR/);
  assert.match(service("postgres"), /^\s*-\s+postgres:\/var\/lib\/postgresql\/data\s*$/m);
  assert.match(compose, /^volumes:\s*\n\s+postgres:\s*\n\s+pictrs:/m);
});

test("the hostname reaches the script through the environment and is checked before use", () => {
  assert.match(lemmy, /CROW_LEMMY_HOSTNAME:\s*"\$\{LEMMY_HOSTNAME:\?[^}]*\}"/);
  assert.match(lemmy, /hostname:\s*"\$\$\{CROW_LEMMY_HOSTNAME\}"/);
  assert.match(lemmy, /case "\$\$\{CROW_LEMMY_HOSTNAME\}" in/);
  const body = lemmy.slice(lemmy.indexOf("- |"));
  assert.doesNotMatch(body, /(?<!\$)\$\{LEMMY_/, "no compose-interpolated LEMMY_* value inside the shell script");
});

test("the hostname check accepts bare lowercase hostnames and refuses everything else", () => {
  const m = lemmy.match(/case "\$\$\{CROW_LEMMY_HOSTNAME\}" in\n\s*(.*?)\) echo/);
  assert.ok(m, "found the case pattern");
  const script = `case "$1" in ${m[1]}) exit 64 ;; esac; exit 0`;
  const ok = (h) => spawnSync("sh", ["-c", script, "sh", h]).status === 0;
  for (const h of ["lemmy.example.com", "a-b.example.org", "lemmy.localhost", "host.test:8536"]) assert.ok(ok(h), `accepts ${h}`);
  for (const h of ["", "https://lemmy.example.com", "lemmy.example.com/x", "LEMMY.example.com", "host.", ".host", "-host", "a..b", "host:", "a\"b", "a b", "a$(id)", "a`id`", "a\nb"]) {
    assert.equal(ok(h), false, `refuses ${JSON.stringify(h)}`);
  }
});

test("pict-rs limits use the 0.5 key names (0.4 names are silently ignored)", () => {
  const p = service("pictrs");
  assert.match(p, /image:\s*asonix\/pictrs:0\.5\./);
  assert.doesNotMatch(p, /PICTRS__MEDIA__GIF__|PICTRS__MEDIA__VIDEO_CODEC/);
  assert.match(p, /PICTRS__MEDIA__ANIMATION__MAX_WIDTH/);
});

test("the generated admin password reaches Lemmy's first-start setup through the environment only", () => {
  assert.match(lemmy, /admin_username:\s*"admin_pending"/);
  assert.match(lemmy, /admin_password:\s*"\$\$\{CROW_LEMMY_ADMIN_PASSWORD\}"/);
  assert.match(lemmy, /CROW_LEMMY_ADMIN_PASSWORD:\s*"\$\{LEMMY_ADMIN_PASSWORD\}"/);
  const v = manifest.env_vars.find((e) => e.name === "LEMMY_ADMIN_PASSWORD");
  assert.equal(v.generate, "secret");
  assert.equal(v.keychain, true);
  assert.equal(v.keychain_username, "admin_pending");
});

test("only keys Lemmy 0.19 reads are written, and federation ids are https behind Caddy", () => {
  const script = lemmy.slice(lemmy.indexOf("<<HJSON"), lemmy.lastIndexOf("HJSON"));
  assert.doesNotMatch(script, /captcha:/, "captcha is a site setting since 0.19");
  assert.doesNotMatch(script, /\benabled:/, "federation on/off is a site setting since 0.19");
  assert.match(script, /tls_enabled:\s*true/);
  assert.equal(manifest.env_vars.some((e) => e.name === "LEMMY_FEDERATION_ENABLED"), false, "no env var that Lemmy ignores");
});

test("the manifest no longer says the bundle cannot start, and names the upstream licence", () => {
  const text = JSON.stringify(manifest);
  assert.doesNotMatch(text, /does not start yet/);
  assert.match(manifest.notes, /AGPL-3\.0/);
});
