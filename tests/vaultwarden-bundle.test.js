/** Vaultwarden adopts generate+keychain+argon2id (Task 9). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { formatEnvLines } from "../servers/gateway/bundle-env-codec.js";
import { argon2idPhc, verifyArgon2idPhc } from "../servers/gateway/keychain/argon2-phc.js";

const DIR = join(import.meta.dirname, "..", "bundles", "vaultwarden");
const manifest = JSON.parse(readFileSync(join(DIR, "manifest.json"), "utf8"));
const token = manifest.env_vars.find((v) => v.name === "VAULTWARDEN_ADMIN_TOKEN");

test("the admin token is generated, kept in the keychain, and stored as an Argon2id hash", () => {
  assert.equal(manifest.version, "1.1.0");
  assert.equal(token.generate, "secret");
  assert.equal(token.keychain, true);
  assert.equal(token.store_as, "argon2id");
  assert.equal(token.keychain_url, "${VAULTWARDEN_DOMAIN}/admin");
  assert.doesNotMatch(token.description, /openssl|vaultwarden hash|paste/i, "no terminal instructions");
  assert.ok(!manifest.server.envKeys.includes("VAULTWARDEN_ADMIN_TOKEN"), "the MCP child never gets generated values");
  assert.ok(!JSON.stringify(manifest.requires).includes("VAULTWARDEN_ADMIN_TOKEN"));
  for (const lang of ["en", "es"]) assert.doesNotMatch(manifest.install_consent_messages[lang], /plaintext|texto plano/i);
});

test("the bundle pins the Bitwarden CLI exactly, installs it as a hard requirement, and runs a Vaultwarden it supports", () => {
  const pkg = JSON.parse(readFileSync(join(DIR, "package.json"), "utf8"));
  assert.equal(pkg.dependencies["@bitwarden/cli"], "2026.8.0");
  assert.equal(manifest.npm_required, true, "S5: npm ci with the lock file, hard-fail instead of a half-installed MCP server");
  assert.ok(manifest.verify_paths.includes("node_modules/@bitwarden/cli/build/bw.js"));
  // Vaultwarden 1.37.0 release notes: "required for support with clients with version 2026.7.0+".
  assert.match(readFileSync(join(DIR, "docker-compose.yml"), "utf8"), /image: vaultwarden\/server:1\.37\.3\n/);
});

test("skill and MCP server no longer describe the old flow", () => {
  const skill = readFileSync(join(DIR, "skills", "vaultwarden.md"), "utf8");
  assert.doesNotMatch(skill, /openssl rand/);
  assert.match(skill, /Settings → Passwords/);
  const server = readFileSync(join(DIR, "server", "server.js"), "utf8");
  assert.match(skill, /sudo tailscale serve --bg --https=<port> http:\/\/127\.0\.0\.1:8097/);
  assert.match(skill, /VAULTWARDEN_DOMAIN=https:\/\/<host>\.<tailnet>\.ts\.net:<port>/);
  const domain = manifest.env_vars.find((v) => v.name === "VAULTWARDEN_DOMAIN");
  assert.match(domain.description, /vault.*needs this to be a secure https URL/is);
  assert.doesNotMatch(skill, /how many accounts, via the admin API/, "the skill must not claim user_count returns a count");
  assert.match(skill, /vaultwarden_user_count.*explains where to see accounts/);
  assert.doesNotMatch(server, /Bearer/, "the admin API is cookie-only on 1.32.7; a Bearer call can never work");
});

const hasCompose = spawnSync("docker", ["compose", "version"], { encoding: "utf8" }).status === 0;
test("compose hands the container the exact PHC string (real docker compose config)", { skip: !hasCompose && "docker compose not available" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "vw-compose-"));
  writeFileSync(join(dir, "docker-compose.yml"), readFileSync(join(DIR, "docker-compose.yml"), "utf8"));
  const phc = argon2idPhc("the-token");
  writeFileSync(join(dir, ".env"), formatEnvLines({ VAULTWARDEN_ADMIN_TOKEN: phc, VAULTWARDEN_DATA_DIR: join(dir, "data") }));
  const r = spawnSync("docker", ["compose", "config", "--format", "json"], { cwd: dir, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const envList = JSON.parse(r.stdout).services.vaultwarden.environment;
  const admin = String(envList.ADMIN_TOKEN).replace(/\$\$/g, "$");
  assert.equal(admin, phc);
  assert.equal(verifyArgon2idPhc("the-token", admin), true);
});
