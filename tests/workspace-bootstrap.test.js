/**
 * ops/bootstrap.sh, add-user.sh, reset-password.sh against a FAKE `docker compose`:
 * the fake answers occ from marker files in FAKE_STATE, logs each call's argv to
 * calls.log and its stdin (secrets travel there) to stdin.log.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const OPS = join(import.meta.dirname, "..", "bundles", "workspace", "ops");

const FAKE_DC = String.raw`#!/usr/bin/env bash
S="$FAKE_STATE"
printf '%s\n' "$*" >> "$S/calls.log"
{ printf '[%s] ' "$*"; cat; printf '\n'; } >> "$S/stdin.log"
for last; do :; done
case "$*" in
  *"occ status --output=json"*) if [ -f "$S/installed" ]; then echo '{"installed":true,"version":"34.0.4"}'; else echo '{"installed":false}'; fi ;;
  *"occ config:app:get "*" enabled"*) app=$(printf '%s' "$*" | sed -E 's/.*config:app:get ([a-z_]+) enabled.*/\1/'); if [ -f "$S/app-$app" ]; then echo yes; fi ;;
  *"occ app:install "*|*"occ app:enable "*) touch "$S/app-$last" ;;
  *"occ dav:list-calendars "*) echo "+------+"; if [ -f "$S/cal-Menu" ]; then echo "| Menu | Menu | principals/users/admin | admin |  ✓  |"; fi ;;
  *"occ dav:create-calendar "*) touch "$S/cal-$last" ;;
  *"occ user:info "*) [ -f "$S/user-$last" ] || exit 1 ;;
  *"user:add "*) touch "$S/user-$last" ;;
  *"occ user:auth-tokens:list "*) if [ -f "$S/tokens" ]; then echo '[{"id":7,"name":"crow-workspace-tools"},{"id":8,"name":"phone"}]'; else echo '[]'; fi ;;
  *"user:auth-tokens:add "*) n=$(( $(cat "$S/tokens" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$S/tokens"; printf 'app password:\n%s%s\n' "$(printf 'A%.0s' $(seq 1 71))" "$n" ;;
  *"onlyoffice:documentserver --check"*) echo "Document server is successfully connected" ;;
  *"user:resetpassword --password-from-env admin"*) [ -f "$S/reject-admin" ] && { echo "Password is among the 1,000,000 most common ones" >&2; exit 1; } ;;
  *) : ;;
esac
exit 0
`;
const FAKE_TS = String.raw`#!/usr/bin/env bash
printf '%s\n' "ts $*" >> "$FAKE_STATE/calls.log"
[ -f "$FAKE_STATE/no-tailnet" ] && exit 1
echo '{"Self":{"DNSName":"box.tailnet-example.ts.net."}}'
`;
const FAKE_DOCKER = String.raw`#!/usr/bin/env bash
printf '%s\n' "docker $*" >> "$FAKE_STATE/calls.log"
echo 10.89.70.1
`;
const TOKEN1 = "A".repeat(71) + "1";
const TOKEN2 = "A".repeat(71) + "2";
const SECRETS = {
  WORKSPACE_ADMIN_PASSWORD: "Admin-Secret-Value-123",
  WORKSPACE_FIRSTRUN_ADMIN_PASSWORD: "firstrun-SECRET-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
  WORKSPACE_DB_ROOT_PASSWORD: "dbroot-SECRET-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  WORKSPACE_DB_PASSWORD: "db-SECRET-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  WORKSPACE_REDIS_PASSWORD: "redis-SECRET-ccccccccccccccccccccccccccccccccccc",
  WORKSPACE_ONLYOFFICE_JWT_SECRET: "jwt-SECRET-ddddddddddddddddddddddddddddddddddddd",
};
const GENERATED = ["WORKSPACE_FIRSTRUN_ADMIN_PASSWORD", "WORKSPACE_DB_ROOT_PASSWORD", "WORKSPACE_DB_PASSWORD", "WORKSPACE_REDIS_PASSWORD", "WORKSPACE_ONLYOFFICE_JWT_SECRET"];

function setup({ env = {}, state = ["installed"] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "ws-boot-"));
  const ctx = { root, bundle: join(root, "bundle"), st: join(root, "state"), bin: join(root, "bin"), home: join(root, "crowhome") };
  for (const d of [ctx.bundle, ctx.st, ctx.bin, ctx.home]) mkdirSync(d);
  for (const [n, body] of [["dc", FAKE_DC], ["ts", FAKE_TS], ["docker", FAKE_DOCKER]]) { writeFileSync(join(ctx.bin, n), body); chmodSync(join(ctx.bin, n), 0o755); }
  for (const s of state) writeFileSync(join(ctx.st, s), "");
  const vars = { WORKSPACE_ADMIN_USER: "admin", ...SECRETS, WORKSPACE_PUBLIC_HOST: "", WORKSPACE_NC_SERVE_PORT: "8456", WORKSPACE_OO_SERVE_PORT: "8457", ...env };
  writeFileSync(join(ctx.bundle, ".env"), Object.entries(vars).map(([k, v]) => `${k}=${v}`).join("\n") + "\n", { mode: 0o600 });
  return ctx;
}
function run(script, ctx, args = [], { input, env: extra = {} } = {}) {
  const r = spawnSync("bash", [join(OPS, script), ...args], {
    encoding: "utf8", input,
    env: {
      PATH: process.env.PATH, HOME: ctx.root, CROW_HOME: ctx.home, CROW_BUNDLE_DIR: ctx.bundle, FAKE_STATE: ctx.st,
      WORKSPACE_DC: join(ctx.bin, "dc"), WORKSPACE_TS: join(ctx.bin, "ts"), WORKSPACE_DOCKER: join(ctx.bin, "docker"),
      WORKSPACE_WAIT_S: "2", WORKSPACE_SLEEP_S: "1", ...extra,
    },
  });
  return { ...r, out: `${r.stdout}\n${r.stderr}` };
}
const read = (ctx, f) => (existsSync(join(ctx.st, f)) ? readFileSync(join(ctx.st, f), "utf8") : "");
const parseEnv = (p) => Object.fromEntries(readFileSync(p, "utf8").split("\n").filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
const envOf = (ctx) => parseEnv(join(ctx.bundle, ".env"));
const retained = (ctx) => join(ctx.home, "secrets", "bundle-env", "workspace.env");

test("fresh run configures everything once", () => {
  const ctx = setup();
  const r = run("bootstrap.sh", ctx);
  assert.equal(r.status, 0, r.out);
  const c = read(ctx, "calls.log");
  for (const app of ["calendar", "contacts", "forms", "onlyoffice"]) assert.match(c, new RegExp(`occ app:install ${app}`));
  assert.match(c, /occ background:cron/);
  assert.match(c, /docker network inspect crow-workspace_default/);
  assert.match(c, /occ config:system:set trusted_domains 1 --value=nextcloud/);
  assert.match(c, /occ config:system:set trusted_domains 2 --value=box\.tailnet-example\.ts\.net/);
  assert.match(c, /occ config:system:set trusted_proxies 0 --value=10\.89\.70\.1/);
  assert.match(c, /occ config:system:set overwritehost --value=box\.tailnet-example\.ts\.net:8456/);
  assert.match(c, /occ config:system:set overwritecondaddr --value=\^10\\\.89\\\.70\\\.1\$/);
  assert.match(c, /occ config:app:set onlyoffice DocumentServerUrl --value=https:\/\/box\.tailnet-example\.ts\.net:8457\//);
  assert.match(c, /occ config:app:set onlyoffice DocumentServerInternalUrl --value=http:\/\/onlyoffice\//);
  assert.match(c, /occ config:app:set onlyoffice StorageUrl --value=http:\/\/nextcloud\//);
  assert.match(c, /php occ config:import \/dev\/stdin/);
  assert.match(c, /occ dav:create-calendar admin Menu/);
  assert.match(c, /occ group:add household/);
  assert.match(c, /occ group:adduser household admin/);
  assert.match(c, /occ config:app:set core shareapi_allow_links_exclude_groups --value=\["crow-bots"\]/);
  assert.match(c, /occ config:app:set core shareapi_restrict_user_enumeration_to_group --value=yes/);
  assert.match(c, /user:add --password-from-env --display-name=Crow bot --group crow-bots crow-bot/);
  assert.doesNotMatch(c, /--group admin/);
  assert.equal(envOf(ctx).WORKSPACE_BOT_APP_PASSWORD, TOKEN1);
  assert.equal(envOf(ctx).WORKSPACE_PUBLIC_HOST, "box.tailnet-example.ts.net");
  assert.equal(statSync(join(ctx.bundle, ".env")).mode & 0o777, 0o600);
});

test("REVIEW FOCUS 5b — secrets travel on stdin, never argv or output; admin password scrubbed", () => {
  const ctx = setup();
  const r = run("bootstrap.sh", ctx);
  assert.equal(r.status, 0, r.out);
  const argv = read(ctx, "calls.log"); const stdin = read(ctx, "stdin.log");
  for (const v of [...Object.values(SECRETS), TOKEN1]) {
    assert.ok(!r.out.includes(v), `printed: ${v.slice(0, 8)}…`);
    assert.ok(!argv.includes(v), `in argv: ${v.slice(0, 8)}…`);
  }
  assert.ok(stdin.includes(SECRETS.WORKSPACE_ONLYOFFICE_JWT_SECRET), "JWT reached occ config:import via stdin");
  assert.match(stdin, /user:resetpassword --password-from-env admin\] Admin-Secret-Value-123/, "admin password applied via stdin");
  assert.equal(envOf(ctx).WORKSPACE_ADMIN_PASSWORD, undefined, "scrubbed from .env after use");
  assert.ok(!readFileSync(retained(ctx), "utf8").includes("Admin-Secret-Value-123"), "never in the kept-secrets copy");
});

test("REVIEW FOCUS 1 (restore) — bootstrap re-syncs the retained copy from .env (600, other keys kept)", () => {
  const ctx = setup();
  mkdirSync(join(ctx.home, "secrets", "bundle-env"), { recursive: true });
  writeFileSync(retained(ctx), "# header\nWORKSPACE_DB_PASSWORD=stale-from-a-fresh-install\nOTHER_KEY=keep-me\n", { mode: 0o644 });
  assert.equal(run("bootstrap.sh", ctx).status, 0);
  const kept = parseEnv(retained(ctx));
  for (const k of GENERATED) assert.equal(kept[k], SECRETS[k], k);
  assert.equal(kept.OTHER_KEY, "keep-me");
  assert.equal(statSync(retained(ctx)).mode & 0o777, 0o600);
  assert.equal(statSync(join(ctx.home, "secrets", "bundle-env")).mode & 0o777, 0o700);
});

test("REVIEW FOCUS 3 — second run changes nothing; lost token re-minted once, stale tokens revoked", () => {
  const ctx = setup();
  assert.equal(run("bootstrap.sh", ctx).status, 0);
  writeFileSync(join(ctx.st, "calls.log"), "");
  assert.equal(run("bootstrap.sh", ctx).status, 0);
  assert.doesNotMatch(read(ctx, "calls.log"), /app:install|app:enable|dav:create-calendar|user:add |user:resetpassword|auth-tokens:add|auth-tokens:delete/);
  assert.equal(envOf(ctx).WORKSPACE_BOT_APP_PASSWORD, TOKEN1);

  const kept = readFileSync(join(ctx.bundle, ".env"), "utf8").split("\n").filter((l) => !l.startsWith("WORKSPACE_BOT_APP_PASSWORD=")).join("\n");
  writeFileSync(join(ctx.bundle, ".env"), kept, { mode: 0o600 });
  writeFileSync(join(ctx.st, "calls.log"), "");
  assert.equal(run("bootstrap.sh", ctx).status, 0);
  const c = read(ctx, "calls.log");
  assert.doesNotMatch(c, /user:add /);
  assert.equal((c.match(/user:resetpassword --password-from-env crow-bot/g) || []).length, 1);
  assert.match(c, /occ user:auth-tokens:delete crow-bot 7/);
  assert.doesNotMatch(c, /auth-tokens:delete crow-bot 8/, "tokens with other names are left alone");
  assert.equal((c.match(/auth-tokens:add/g) || []).length, 1);
  assert.equal(envOf(ctx).WORKSPACE_BOT_APP_PASSWORD, TOKEN2);
});

test("Nextcloud rejecting the typed admin password → clear, recoverable failure; the password is NOT scrubbed", () => {
  const ctx = setup({ state: ["installed", "reject-admin"] });
  const r = run("bootstrap.sh", ctx);
  assert.notEqual(r.status, 0);
  assert.match(r.out, /Nextcloud rejected the admin password/);
  assert.match(r.out, /ops\/reset-password\.sh admin/);
  assert.match(r.out, /delete the WORKSPACE_ADMIN_PASSWORD line/);
  assert.ok(!r.out.includes(SECRETS.WORKSPACE_ADMIN_PASSWORD));
  assert.equal(envOf(ctx).WORKSPACE_ADMIN_PASSWORD, SECRETS.WORKSPACE_ADMIN_PASSWORD, "kept until it is applied or the operator removes it");
  assert.doesNotMatch(read(ctx, "calls.log"), /^ts /m, "the admin step runs before tailnet detection");
});

test("Nextcloud never finishing its install fails within the bounded wait", () => {
  const r = run("bootstrap.sh", setup({ state: [] }));
  assert.notEqual(r.status, 0);
  assert.match(r.out, /Nextcloud not ready after 2s/);
});

test("no tailnet name → refusal pointing at editing the .env (Configure has no field for it)", () => {
  const r = run("bootstrap.sh", setup({ state: ["installed", "no-tailnet"] }));
  assert.notEqual(r.status, 0);
  assert.match(r.out, /WORKSPACE_PUBLIC_HOST=<name> to .*\.env/);
  assert.doesNotMatch(r.out, /Configure/);
});

test("configured host used as-is (tailscale never asked); an unsafe host is refused", () => {
  const ctx = setup({ env: { WORKSPACE_PUBLIC_HOST: "office.example.lan" } });
  assert.equal(run("bootstrap.sh", ctx).status, 0);
  assert.doesNotMatch(read(ctx, "calls.log"), /^ts /m);
  assert.match(read(ctx, "calls.log"), /overwritehost --value=office\.example\.lan:8456/);
  const bad = run("bootstrap.sh", setup({ env: { WORKSPACE_PUBLIC_HOST: "x;rm" } }));
  assert.notEqual(bad.status, 0);
  assert.match(bad.out, /not a valid hostname/);
});

test("a scratch project name drives the network name (smoke/restore projects)", () => {
  const ctx = setup();
  assert.equal(run("bootstrap.sh", ctx, [], { env: { WORKSPACE_COMPOSE_PROJECT: "crow-ws-smoke" } }).status, 0);
  assert.match(read(ctx, "calls.log"), /docker network inspect crow-ws-smoke_default/);
});

test("add-user.sh: group household, one-time password printed once and sent via stdin; idempotent; bad logins refused", () => {
  const ctx = setup();
  const r1 = run("add-user.sh", ctx, ["dayane", "Dayane"]);
  assert.equal(r1.status, 0, r1.out);
  const pw = /One-time password for dayane: ([A-Za-z0-9]{20})\n/.exec(r1.stdout)[1];
  assert.match(read(ctx, "calls.log"), /user:add --password-from-env --display-name=Dayane --group household dayane/);
  assert.ok(!read(ctx, "calls.log").includes(pw));
  assert.ok(read(ctx, "stdin.log").includes(pw));
  const r2 = run("add-user.sh", ctx, ["dayane", "Dayane"]);
  assert.match(r2.stdout, /already exists/);
  assert.doesNotMatch(r2.stdout, /One-time password/);
  assert.notEqual(run("add-user.sh", ctx, ["Bad Login", "X"]).status, 0);
  assert.notEqual(run("add-user.sh", ctx, ["crow-bot", "X"]).status, 0);
});

test("reset-password.sh: new password via stdin (pattern-gated), never argv", () => {
  const ctx = setup();
  const r = run("reset-password.sh", ctx, ["admin"], { input: "New-Correct-Horse-7\n" });
  assert.equal(r.status, 0, r.out);
  assert.match(read(ctx, "stdin.log"), /user:resetpassword --password-from-env admin\] New-Correct-Horse-7/);
  assert.ok(!read(ctx, "calls.log").includes("New-Correct-Horse-7"));
  assert.notEqual(run("reset-password.sh", ctx, ["admin"], { input: "has $ bad\n" }).status, 0);
});

test("bootstrap.sh GENERATED_KEYS equals exactly the manifest's generate:secret keys (no drift)", () => {
  const manifest = JSON.parse(readFileSync(join(OPS, "..", "manifest.json"), "utf8"));
  const want = manifest.env_vars.filter((v) => v.generate === "secret").map((v) => v.name).sort();
  const m = /^GENERATED_KEYS="([^"]*)"/m.exec(readFileSync(join(OPS, "bootstrap.sh"), "utf8"));
  assert.ok(m, "GENERATED_KEYS assignment found in bootstrap.sh");
  assert.deepEqual(m[1].split(/\s+/).filter(Boolean).sort(), want);
  assert.deepEqual(GENERATED.slice().sort(), want);
});
