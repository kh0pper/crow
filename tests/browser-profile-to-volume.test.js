// scripts/ops/browser-profile-to-volume.sh — the one-time move of a browser
// profile onto the named volume. Its argument checks, safety refusals,
// dry run and rollback, run against a stand-in `docker` (DOCKER=<shim>): no
// real container, volume or image is touched.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, statSync, chmodSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = new URL("../scripts/ops/browser-profile-to-volume.sh", import.meta.url).pathname;
const SOURCE = new URL("../bundles/browser/", import.meta.url).pathname;
const root = mkdtempSync(join(tmpdir(), "crow-profile-move-"));
after(() => rmSync(root, { recursive: true, force: true }));

// The stand-in docker: answers from env, logs every call (one per line) to $FAKE/calls.
const SHIM = `#!/usr/bin/env bash
echo "$*" >> "$FAKE/calls"
fmt=""; for a in "$@"; do case "$prev" in --format) fmt="$a";; esac; prev="$a"; done
case "$1" in
  inspect)
    [ "$2" = "$FAKE_CONTAINER_EXISTS" ] || exit 1
    case "$fmt" in
      '{{.Name}}') echo "/$FAKE_NAME" ;;
      *com.docker.compose.project.config_files*) echo "$FAKE_BUNDLE/docker-compose.yml" ;;
      *com.docker.compose.project*) echo "$FAKE_PROJECT" ;;
      *com.docker.compose.service*) echo "crow-browser" ;;
      *Mounts*) printf '%b' "$FAKE_MOUNTS" ;;
      '{{.Image}}') cat "$FAKE/image" 2>/dev/null || echo "sha256:fakeimage" ;;
      '{{.State.Running}}') echo "true" ;;
      *RestartPolicy*) echo "unless-stopped" ;;
    esac ;;
  compose)
    case " $* " in
      *" config "*) printf '%s' "$FAKE_RENDER" ;;
      *" up "*) [ -n "$FAKE_UP_REPLACES" ] && echo "sha256:new" > "$FAKE/image"; exit "\${FAKE_UP_EXIT:-0}" ;;
    esac ;;
  build) [ "$FAKE_FAIL" = build ] && exit 1; [ -n "$FAKE_SLOW_BUILD" ] && sleep "$FAKE_SLOW_BUILD"; exit 0 ;;
  volume)
    case "$2" in
      inspect) [ -n "$FAKE_VOLUME_EXISTS" ] && exit 0; exit 1 ;;
      create) [ "$FAKE_FAIL" = volume ] && exit 1; echo "\${@: -1}" ;;
    esac ;;
  exec) case " $* " in *" pgrep "*) exit 1 ;; esac; exit 0 ;;
  cp) [ "$FAKE_FAIL" = cp ] && exit 1; tar -cf - -C "$FAKE/profile-src" chromium-crow ;;
  run)
    case " $* " in
      *" --entrypoint tar "*) cat > /dev/null; [ "$FAKE_FAIL" = restore ] && exit 1; exit 0 ;;
    esac
    script="\${@: -1}"; script="\${script//\\/root\\/.config/$FAKE/profile-src}"
    if [ "$FAKE_FAIL" = hash ] && [[ "$script" == *sha256sum* ]]; then echo "0000  chromium-crow/Local State"; exit 0; fi
    sh -c "$script" ;;
esac
exit 0
`;

let n = 0;
function setup(over = {}) {
  const dir = join(root, String(++n));
  const home = join(dir, "home"), bundle = join(home, "bundles", "browser");
  mkdirSync(bundle, { recursive: true });
  for (const f of ["docker-compose.yml", "entrypoint.sh", "Dockerfile"]) writeFileSync(join(bundle, f), "OLD " + f + "\n");
  writeFileSync(join(bundle, ".env"), "CROW_BROWSER_CDP_PORT=1\nCROW_BROWSER_VNC_PASSWORD=old-legacy\n", { mode: 0o600 });
  const fake = join(dir, "fake");
  mkdirSync(join(fake, "profile-src", "chromium-crow", "Default"), { recursive: true });
  writeFileSync(join(fake, "profile-src", "chromium-crow", "Default", "Cookies"), "cookie-db");
  writeFileSync(join(fake, "profile-src", "chromium-crow", "Default", "Preferences"), "{}");
  writeFileSync(join(fake, "profile-src", "chromium-crow", "Local State"), "{\"a\":1}");
  const shim = join(dir, "docker");
  writeFileSync(shim, SHIM); chmodSync(shim, 0o755);
  const project = over.project ?? "browser";
  const render = over.render ?? JSON.stringify({
    name: project, services: { "crow-browser": { container_name: "crow-browser", volumes: [{ type: "volume", source: "chromium-profile", target: "/root/.config/chromium-crow" }] } },
    volumes: { "chromium-profile": { name: `${project}-chromium-profile` } },
  });
  const env = {
    PATH: process.env.PATH, DOCKER: shim, FAKE: fake, FAKE_BUNDLE: bundle, FAKE_NAME: over.name ?? "crow-browser",
    FAKE_CONTAINER_EXISTS: over.exists ?? "crow-browser", FAKE_PROJECT: over.labelProject ?? project,
    FAKE_MOUNTS: over.mounts ?? "/downloads\\n", FAKE_RENDER: render, FAKE_VOLUME_EXISTS: over.volumeExists ?? "",
    FAKE_FAIL: over.fail ?? "", FAKE_UP_EXIT: over.upExit ?? "0", FAKE_UP_REPLACES: over.upReplaces ?? "", FAKE_SLOW_BUILD: over.slowBuild ?? "",
    CROW_MIGRATE_NOW: "20261029-120000", CROW_MIGRATE_CDP_WAIT: "1", CROW_MIGRATE_CLOSE_WAIT: "1",
  };
  const run = (args) => {
    const r = spawnSync("bash", [SCRIPT, ...args], { env, encoding: "utf8", timeout: 60000 });
    const calls = existsSync(join(fake, "calls")) ? readFileSync(join(fake, "calls"), "utf8").trim().split("\n") : [];
    return { code: r.status, out: r.stdout + r.stderr, calls };
  };
  const runAsync = (args) => spawn("bash", [SCRIPT, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
  const calls = () => existsSync(join(fake, "calls")) ? readFileSync(join(fake, "calls"), "utf8").trim().split("\n") : [];
  return { run, runAsync, calls, bundle, home, fake };
}
const ARGS = ["--container", "crow-browser", "--project", "browser", "--source", SOURCE];
const MUTATING = /^(stop|start|cp|tag|build|update|volume (create|rm)|run|compose .* up)/;

test("argument checks: usage without the three required flags, refusals for bad names, domains and sources", () => {
  const s = setup();
  assert.equal(s.run([]).code, 2, "no arguments: usage");
  assert.equal(s.run(["--container", "crow-browser", "--project", "browser"]).code, 2, "no --source");
  assert.equal(s.run(["--bogus"]).code, 2);
  for (const [args, re] of [
    [["--container", "../x", "--project", "browser", "--source", SOURCE], /not a container name/],
    [["--container", "crow-browser", "--project", "Browser!", "--source", SOURCE], /not a compose project name/],
    [[...ARGS, "--domains", "a.com;rm -rf /"], /comma-separated list/],
    [["--container", "crow-browser", "--project", "browser", "--source", "/nonexistent"], /not a directory/],
    [["--container", "crow-browser", "--project", "browser", "--source", s.home], /has no docker-compose.yml/],
  ]) {
    const r = s.run(args);
    assert.equal(r.code, 1, args.join(" "));
    assert.match(r.out, re);
    assert.ok(!r.calls.some((c) => MUTATING.test(c)), "nothing changed");
  }
});

test("safety refusals: wrong container, wrong project, already on a volume, volume exists, compose renders elsewhere", () => {
  const cases = [
    [{ exists: "other" }, /no container named 'crow-browser'/],
    [{ name: "crow-browser-r4" }, /resolves to another container/],
    [{ labelProject: "crow-browser-r4" }, /belongs to compose project 'crow-browser-r4', not 'browser'/],
    [{ mounts: "/downloads\\n/root/.config/chromium-crow\\n" }, /already has a volume/],
    [{ volumeExists: "1" }, /already exists: refusing to overwrite/],
    [{ render: JSON.stringify({ name: "crow-browser-r4", services: { "crow-browser": { container_name: "crow-browser", volumes: [] } }, volumes: {} }) }, /renders project 'crow-browser-r4'/],
  ];
  for (const [over, re] of cases) {
    const s = setup(over);
    const r = s.run(ARGS);
    assert.equal(r.code, 1, JSON.stringify(over));
    assert.match(r.out, re, r.out);
    assert.ok(!r.calls.some((c) => MUTATING.test(c)), "refused before any change: " + r.calls.join(" | "));
    assert.equal(readFileSync(join(s.bundle, "docker-compose.yml"), "utf8"), "OLD docker-compose.yml\n");
  }
});

test("--dry-run: every check, the plan, and no change at all", () => {
  const s = setup();
  const r = s.run([...ARGS, "--dry-run"]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /volume: +browser-chromium-profile → \/root\/\.config\/chromium-crow/);
  assert.match(r.out, /old image: +kept as crow-browser-prev:browser-20261029-120000/);
  assert.match(r.out, /built as browser-crow-browser .* BEFORE the old container stops/);
  assert.match(r.out, /backup: +.*\/home\/browser-profile-backup\/20261029-120000 \(mode 700\)/);
  assert.match(r.out, /dry run: all checks passed, nothing changed/);
  assert.ok(!r.calls.some((c) => MUTATING.test(c)), r.calls.join(" | "));
  assert.ok(!existsSync(join(s.home, "browser-profile-backup")), "no backup dir");
});

test("a failure before the new container is up puts everything back and starts the OLD container, unchanged", () => {
  for (const [fail, extra] of [["build", {}], ["cp", {}], ["volume", {}], ["restore", { volume: true }], ["hash", { volume: true }], ["up", { volume: true }]]) {
    const s = setup(fail === "up" ? { upExit: "1" } : { fail });
    const r = s.run(ARGS);
    assert.equal(r.code, 1, fail + ": " + r.out);
    assert.match(r.out, /FAILED or interrupted during/, fail);
    assert.ok(r.calls.includes("tag sha256:fakeimage crow-browser-prev:browser-20261029-120000"), fail + ": the rollback image is tagged first");
    if (fail === "build") {
      assert.ok(!r.calls.some((c) => /^stop /.test(c)), "a failed build never stops the old container");
    } else {
      assert.ok(r.calls.includes("stop -t 30 crow-browser"), fail);
      assert.ok(r.calls.includes("update --restart=unless-stopped crow-browser"), fail + ": the restart policy is restored");
    }
    assert.ok(r.calls.includes("tag sha256:fakeimage browser-crow-browser"), fail + ": the image name points at the old image again");
    assert.equal(r.calls.includes("volume rm browser-chromium-profile"), !!extra.volume, fail + ": a volume this run created is removed");
    assert.equal(r.calls.at(-1), "start crow-browser", fail + ": the old container is started again, last");
    assert.equal(readFileSync(join(s.bundle, "docker-compose.yml"), "utf8"), "OLD docker-compose.yml\n");
    assert.doesNotMatch(readFileSync(join(s.bundle, ".env"), "utf8"), /VNC_TOKEN/, fail + ": the .env unchanged");
  }
});

test("a recreate that already replaced the old container is not rolled back blindly: it says where everything is", () => {
  const s = setup({ upExit: "1", upReplaces: "1" });
  const r = s.run(ARGS);
  assert.equal(r.code, 1);
  assert.match(r.out, /already replaced the old container\. NOT rolling back/);
  assert.match(r.out, /crow-browser-prev:browser-20261029-120000/);
  assert.ok(!r.calls.includes("start crow-browser"));
  assert.ok(!r.calls.includes("volume rm browser-chromium-profile"), "the volume holds the profile now: kept");
});

test("an interrupt (SIGTERM / Ctrl-C) during the slow build rolls back: the old container keeps serving", async () => {
  const s = setup({ slowBuild: "5" });
  const child = s.runAsync(ARGS);
  let out = ""; child.stdout.on("data", (d) => (out += d)); child.stderr.on("data", (d) => (out += d));
  for (let i = 0; i < 100 && !s.calls().some((c) => /^build /.test(c)); i++) await new Promise((r) => setTimeout(r, 50));
  child.kill("SIGTERM");
  const code = await new Promise((r) => child.on("close", r));
  assert.notEqual(code, 0);
  assert.match(out, /interrupted during 'build'/);
  const calls = s.calls();
  assert.ok(!calls.some((c) => /^stop /.test(c)));
  assert.ok(calls.includes("tag sha256:fakeimage browser-crow-browser"));
  assert.equal(calls.at(-1), "start crow-browser");
});

test("the full run: tag, build, graceful close, stop, backup 700/600, volume + hashes, new compose, token, recreate; then the reminders", () => {
  const s = setup();
  const r = s.run([...ARGS, "--domains", "example.com"]);
  // The stand-in has no CDP: the run ends non-zero after the recreate, with the reminders.
  assert.equal(r.code, 1);
  assert.match(r.out, /CDP did not answer on 127\.0\.0\.1:1/);
  const backup = join(s.home, "browser-profile-backup", "20261029-120000");
  assert.equal(statSync(backup).mode & 0o777, 0o700);
  assert.equal(statSync(join(s.home, "browser-profile-backup")).mode & 0o777, 0o700);
  assert.equal(statSync(join(backup, "profile.tar")).mode & 0o777, 0o600);
  assert.match(execFileSync("tar", ["-tf", join(backup, "profile.tar")], { encoding: "utf8" }), /^chromium-crow\/Default\/Cookies$/m);
  assert.equal(readFileSync(join(backup, "bundle-files", "docker-compose.yml"), "utf8"), "OLD docker-compose.yml\n", "the old files are kept");
  const order = [
    "tag sha256:fakeimage crow-browser-prev:browser-20261029-120000",
    `build -t browser-crow-browser ${SOURCE.replace(/\/$/, "")}`,
    "update --restart=no crow-browser",
    'exec crow-browser sh -c pkill -TERM -o -f -- "--user-data-dir=/root/.config/chromium-crow"',
    "stop -t 30 crow-browser",
    "cp crow-browser:/root/.config/chromium-crow -",
    "volume create --label com.docker.compose.project=browser --label com.docker.compose.volume=chromium-profile browser-chromium-profile",
    "compose -p browser up -d --no-build --force-recreate",
  ];
  let at = -1;
  for (const c of order) { const i = r.calls.indexOf(c); assert.ok(i > at, c + " in order: " + r.calls.join(" | ")); at = i; }
  assert.match(r.out, /login files' hashes match/);
  assert.ok(!r.calls.includes("start crow-browser"), "no rollback after the recreate");
  assert.equal(readFileSync(join(s.bundle, "docker-compose.yml"), "utf8"), readFileSync(join(SOURCE, "docker-compose.yml"), "utf8"));
  assert.equal(statSync(join(s.bundle, "entrypoint.sh")).mode & 0o777, 0o755);
  const env = readFileSync(join(s.bundle, ".env"), "utf8");
  const tok = /^CROW_BROWSER_VNC_TOKEN=([0-9a-f]{64})$/m.exec(env);
  assert.ok(tok, "a 64-hex token added");
  assert.equal(statSync(join(s.bundle, ".env")).mode & 0o777, 0o600);
  assert.ok(!r.out.includes(tok[1]), "the token is never printed");
  assert.match(r.out, new RegExp("--delete-backup " + backup.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(r.out, /docker rmi crow-browser-prev:browser-20261029-120000/);
  // An existing token is kept.
  const again = setup();
  writeFileSync(join(again.bundle, ".env"), "CROW_BROWSER_VNC_TOKEN=" + "c".repeat(64) + "\n", { mode: 0o600 });
  again.run(ARGS);
  assert.equal(readFileSync(join(again.bundle, ".env"), "utf8"), "CROW_BROWSER_VNC_TOKEN=" + "c".repeat(64) + "\n");
});

test("--delete-backup removes only a backup this script made", () => {
  const s = setup();
  s.run(ARGS);
  const backup = join(s.home, "browser-profile-backup", "20261029-120000");
  assert.ok(existsSync(join(backup, "profile.tar")));
  for (const [p, re] of [[s.home, /is not <home>\/browser-profile-backup\/<stamp>/], [join(s.home, "nope"), /is not a directory/]]) {
    const r = s.run(["--delete-backup", p]);
    assert.equal(r.code, 1); assert.match(r.out, re);
  }
  const empty = join(s.home, "browser-profile-backup", "20261029-130000"); mkdirSync(empty);
  assert.match(s.run(["--delete-backup", empty]).out, /has no profile\.tar/);
  assert.equal(s.run(["--delete-backup", backup, "--container", "x"]).code, 1, "no other options");
  assert.match(s.run(["--delete-backup", backup, "--dry-run"]).out, /dry run: would delete/);
  assert.ok(existsSync(backup));
  const r = s.run(["--delete-backup", backup]);
  assert.equal(r.code, 0, r.out);
  assert.ok(!existsSync(backup));
});

test("the script never runs on its own: nothing in the repo calls it", () => {
  const out = spawnSync("git", ["grep", "-l", "browser-profile-to-volume", "--", ":!tests/", ":!scripts/ops/browser-profile-to-volume.sh"],
    { cwd: new URL("..", import.meta.url).pathname, encoding: "utf8" }).stdout.trim().split("\n").filter(Boolean);
  for (const f of out) assert.match(f, /\.(md|yml)$/, f + " may mention it, never run it");
  assert.doesNotMatch(readFileSync(SCRIPT, "utf8"), /^\s*(cp -r|rm -rf) \//m);
});
