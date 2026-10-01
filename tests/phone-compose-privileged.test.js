import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { _validateComposeFileForTest as validate } from "../servers/gateway/routes/bundles.js";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "bundles", "phone");
const composePath = join(dir, "docker-compose.yml");
const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
const compose = readFileSync(composePath, "utf8");

test("phone compose uses host networking with no port mapping or extra_hosts", () => {
  assert.match(compose, /network_mode:\s*host/);
  assert.doesNotMatch(compose, /^\s*ports:/m);
  assert.doesNotMatch(compose, /extra_hosts/);
  assert.match(compose, /PHONE_GATEWAY_URL:\s*\$\{PHONE_GATEWAY_URL:-http:\/\/127\.0\.0\.1:\$\{CROW_GATEWAY_PORT:-3001\}\}/);
});

test("phone manifest is privileged with a consent message", () => {
  assert.equal(manifest.privileged, true);
  assert.match(manifest.install_consent_messages?.en || "", /127\.0\.0\.1 only/);
});

test("validateComposeFile accepts phone compose only with privileged manifest + verified consent", () => {
  assert.equal(validate(composePath, "phone", { manifest, consentVerified: true }).valid, true);
  assert.equal(validate(composePath, "phone", { manifest, consentVerified: false }).valid, false);
  assert.equal(validate(composePath, "phone", { manifest: { ...manifest, privileged: false }, consentVerified: true }).valid, false);
  assert.equal(validate(composePath, "phone", {}).valid, false);
});
