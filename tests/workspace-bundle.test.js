/** Static checks of the Crow Workspace bundle (W1 Task 4). Text-level: the repo has no YAML parser. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { validateManifest } from "../scripts/lib/bundle-contract.mjs";

const ROOT = join(import.meta.dirname, "..");
const DIR = join(ROOT, "bundles", "workspace");
const manifest = JSON.parse(readFileSync(join(DIR, "manifest.json"), "utf8"));
const compose = readFileSync(join(DIR, "docker-compose.yml"), "utf8");
const envVar = (n) => manifest.env_vars.find((v) => v.name === n);
const walk = (dir) => readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
function serviceBlocks() {
  const body = compose.split(/^services:\s*$/m)[1].split(/^networks:\s*$/m)[0];
  const names = [...body.matchAll(/^  ([a-z][a-z0-9-]*):\s*$/gm)].map((m) => m[1]);
  return names.map((name, i) => {
    const start = body.indexOf(`\n  ${name}:`);
    const end = i + 1 < names.length ? body.indexOf(`\n  ${names[i + 1]}:`) : body.length;
    return { name, text: body.slice(start, end) };
  });
}

test("manifest passes the bundle contract", () => {
  const r = validateManifest(manifest, DIR, { bundleExists: (id) => existsSync(join(ROOT, "bundles", id, "manifest.json")) });
  assert.equal(r.ok, true, r.errors.join("; "));
});

test("no 'changeme'-style default anywhere in the bundle", () => {
  for (const f of walk(DIR)) assert.doesNotMatch(readFileSync(f, "utf8"), /change_?me/i, f);
});

test("five services, each restart: unless-stopped and memory-limited", () => {
  const svcs = serviceBlocks();
  assert.deepEqual(svcs.map((s) => s.name).sort(), ["nextcloud", "nextcloud-cron", "nextcloud-db", "nextcloud-redis", "onlyoffice"]);
  for (const s of svcs) {
    assert.match(s.text, /^    restart: unless-stopped$/m, s.name);
    assert.match(s.text, /^    mem_limit: \d+[mg]$/m, s.name);
  }
  for (const n of ["nextcloud-db", "nextcloud-redis"]) assert.match(serviceBlocks().find((s) => s.name === n).text, /oom_score_adj: -500/);
});

test("only 127.0.0.1:3070 and 127.0.0.1:3071 are published", () => {
  const maps = [...compose.matchAll(/^\s*-\s*"([^"]*:\d+:\d+)"\s*$/gm)].map((m) => m[1]);
  assert.deepEqual(maps.sort(), ["127.0.0.1:3070:80", "127.0.0.1:3071:80"]);
});

test("project name fixed; network pinned to 10.89.70.0/24; binds under CROW_HOME/workspace", () => {
  assert.match(compose, /^name: crow-workspace$/m);
  assert.match(compose, /^networks:\n  default:\n    ipam:\n      config:\n        - subnet: 10\.89\.70\.0\/24$/m);
  assert.match(compose, /\$\{CROW_HOME:\?[^}]*\}\/workspace\/nextcloud:\/var\/www\/html/);
  assert.match(compose, /\$\{CROW_HOME:\?[^}]*\}\/workspace\/db:\/var\/lib\/mysql/);
  assert.deepEqual(manifest.docker.precreate, ["workspace", "workspace/backups-staging"]);
  assert.equal(manifest.docker.pull_timeout_s, 1800);
});

test("every image is pinned to an exact version and mirrored in manifest.images", () => {
  const images = [...new Set([...compose.matchAll(/^\s*image:\s*(\S+)\s*$/gm)].map((m) => m[1]))].sort();
  for (const i of images) { assert.doesNotMatch(i, /:latest$|:stable|^[^:]+$/, i); assert.match(i, /:\d+\.\d+\.\d+/, i); }
  assert.deepEqual([...manifest.images].sort(), images);
});

test("every compose var is declared; every secret it uses is generated and hard-fail", () => {
  const used = [...compose.matchAll(/\$\{([A-Z_][A-Z0-9_]*)([^}]*)\}/g)];
  for (const n of new Set(used.map((m) => m[1]))) if (n !== "CROW_HOME") assert.ok(envVar(n), `${n} not declared`);
  for (const n of ["WORKSPACE_FIRSTRUN_ADMIN_PASSWORD", "WORKSPACE_DB_ROOT_PASSWORD", "WORKSPACE_DB_PASSWORD", "WORKSPACE_REDIS_PASSWORD", "WORKSPACE_ONLYOFFICE_JWT_SECRET"]) {
    assert.equal(envVar(n).generate, "secret", n);
    for (const m of used.filter((u) => u[1] === n)) assert.match(m[2], /^:\?/, n);
  }
});

test("the human admin password never reaches a container and is install-gated, not badge-gated", () => {
  assert.doesNotMatch(compose, /WORKSPACE_ADMIN_PASSWORD/);
  const v = envVar("WORKSPACE_ADMIN_PASSWORD");
  assert.equal(v.install_required, true);
  assert.equal(v.check, "not_breached", "pre-install check against Nextcloud's default HIBP password policy");
  assert.notEqual(v.required, true, "required:true would raise 'Needs setup' after bootstrap scrubs it");
  assert.equal(v.secret, true);
  assert.equal(v.propagate, false);
  assert.equal(v.default, undefined);
  assert.ok(new RegExp(v.pattern).test("Correct-Horse-Battery-9"));
  assert.ok(!new RegExp(v.pattern).test("has $ dollar 123"));
  for (const v2 of manifest.env_vars) assert.ok(v2.propagate === false || v2.generate === "secret", `${v2.name} must stay out of the gateway .env`);
  for (const n of ["WORKSPACE_NC_SERVE_PORT", "WORKSPACE_OO_SERVE_PORT", "WORKSPACE_PUBLIC_HOST", "WORKSPACE_ADMIN_USER"]) assert.ok(envVar(n).pattern, `${n} must be pattern-gated (rendered into shell commands)`);
  assert.ok(new RegExp(envVar("WORKSPACE_PUBLIC_HOST").pattern).test("crow.example-tailnet.ts.net"));
  assert.ok(!new RegExp(envVar("WORKSPACE_PUBLIC_HOST").pattern).test("x; rm -rf ~"));
});

test("cron gets the DB/Redis env but never an admin password", () => {
  const cron = serviceBlocks().find((s) => s.name === "nextcloud-cron").text;
  assert.match(cron, /entrypoint: \/cron\.sh/);
  assert.match(cron, /environment: \*nextcloud-common-env/);
  assert.doesNotMatch(cron, /ADMIN/);
});

test("REVIEW FOCUS 5c — no secret-in-argv patterns in compose or ops scripts", () => {
  const files = [join(DIR, "docker-compose.yml"), ...(existsSync(join(DIR, "ops")) ? walk(join(DIR, "ops")) : []).filter((f) => /\.(sh|ya?ml)$/.test(f))];
  const banned = [/-p"\$/, /-a "\$/, /-a \$\$/, /--value="\$\{?[A-Z_]*(PASS|SECRET|JWT|TOKEN|KEY)/, /--requirepass/, /--admin-pass/, /-e [A-Z_]*(PASS|SECRET|JWT|TOKEN)\b/];
  for (const f of files) for (const re of banned) assert.doesNotMatch(readFileSync(f, "utf8"), re, `${f} ${re}`);
  assert.match(compose, /REDISCLI_AUTH=/);
  assert.match(compose, /exec \/bin\/setpriv --reuid redis --regid redis --clear-groups redis-server \/tmp\/redis\.conf/);
  assert.doesNotMatch(compose, /exec su-exec|gosu /);
  assert.match(compose, /rm -f \/tmp\/redis\.conf && printf/);
  assert.match(serviceBlocks().find((s) => s.name === "nextcloud-redis").text, /init: true/);
});

test("ONLYOFFICE has JWT on; manifest has no ports/webUI; RAM/disk declared; Office nav", () => {
  assert.match(compose, /JWT_ENABLED: "true"/);
  assert.match(compose, /JWT_SECRET: \$\{WORKSPACE_ONLYOFFICE_JWT_SECRET:\?/);
  assert.equal(manifest.ports, undefined);
  assert.equal(manifest.webUI, undefined);
  assert.ok(manifest.requires.min_ram_mb >= 3072 && manifest.requires.min_ram_mb <= 5120);
  assert.ok(manifest.requires.min_disk_mb >= 10240);
  assert.match(manifest.notes, /Uninstalling keeps/);
});

test("the old nextcloud bundle is a deprecated connect-only entry with no compose", () => {
  const nc = JSON.parse(readFileSync(join(ROOT, "bundles", "nextcloud", "manifest.json"), "utf8"));
  assert.equal(existsSync(join(ROOT, "bundles", "nextcloud", "docker-compose.yml")), false);
  assert.equal(nc.docker, undefined);
  assert.equal(nc.ports, undefined);
  assert.equal(nc.webUI, undefined);
  assert.equal(nc.deprecated.superseded_by, "workspace");
  assert.equal(JSON.parse(readFileSync(join(ROOT, "scripts", "known-port-conflicts.json"), "utf8"))["8080"], undefined);
});
