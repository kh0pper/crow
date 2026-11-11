/**
 * The manifest half of an API-key card: `env_vars[].explain` / `signup_url` /
 * `signup_label` — what a third-party key is for, and where the operator gets one.
 *
 * Rules (scripts/lib/bundle-contract.mjs `validateEnvVarHelp`, plus the schema's shapes):
 * the three fields are allowed only on a key the operator TYPES (`secret: true`, no
 * `generate`), the URL is https only with no user name/password/whitespace/`${` and at
 * most 512 characters, `explain` is a string or `{ en, es }` (en required), and an env
 * name that controls how a program runs may not carry the help at all.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { validateManifest } from "../scripts/lib/bundle-contract.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

/** A throwaway bundle dir <root>/<id>; the contract checks id === dirname. */
function tmpBundle(id) {
  const root = mkdtempSync(join(tmpdir(), "crow-apikey-contract-"));
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const DIR = tmpBundle("apikey");
const BASE = { id: "apikey", name: "Demo", description: "d", type: "mcp-server", category: "misc" };

/** Validate one env_vars entry inside an otherwise-valid manifest. */
function check(ev) {
  return validateManifest({ ...BASE, env_vars: [ev] }, DIR);
}
const errorsFor = (ev) => check(ev).errors.join("\n");
const okFor = (ev) => check(ev).ok;

const SECRET = { name: "DEMO_API_KEY", secret: true, required: true, explain: { en: "the demo key" } };

test("contract: explain + an https signup_url is accepted on a typed secret", () => {
  const ok = check({ ...SECRET, signup_url: "https://keys.example.com/get", signup_label: { en: "Get a key" } });
  assert.equal(ok.ok, true, ok.errors.join("; "));
  // es is optional; a string explain and a string label are fine too.
  assert.equal(okFor({ ...SECRET, explain: "the demo key", signup_url: "https://keys.example.com/" }), true);
  assert.equal(okFor({ ...SECRET, explain: { en: "en text", es: "texto es" } }), true);
});

test("contract: signup_url is https only, with no user info, whitespace, ${} or absurd length", () => {
  for (const url of [
    "http://keys.example.com/",
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "https://user:pass@keys.example.com/",
    "https://user@keys.example.com/",
    "https://keys.example.com/a b",
    "https://keys.example.com/${X}",
    `https://keys.example.com/${"a".repeat(520)}`,
    "keys.example.com",
  ]) {
    const r = check({ ...SECRET, signup_url: url });
    assert.equal(r.ok, false, `expected a refusal for ${url}`);
    assert.match(r.errors.join("\n"), /signup_url/i, url);
  }
});

test("contract: the help needs a typed secret — not a plain var, not a generated one", () => {
  assert.match(errorsFor({ name: "DEMO_PLAIN", explain: "text" }), /need secret: true/);
  assert.match(errorsFor({ name: "DEMO_PLAIN", signup_url: "https://keys.example.com/" }), /need secret: true/);
  assert.match(errorsFor({ name: "DEMO_GENERATED", secret: true, generate: "secret", explain: "text" }), /not allowed on a generate key/);
  // An OPTIONAL typed secret is allowed (media's Brave key): it just never gets a card.
  assert.equal(okFor({ name: "DEMO_OPTIONAL", secret: true, required: false, explain: "text" }), true);
});

test("contract: explain / signup_label shapes — en required, es optional, bounded lengths", () => {
  assert.match(errorsFor({ ...SECRET, explain: { es: "solo español" } }), /explain/i);
  assert.match(errorsFor({ ...SECRET, explain: { en: "", es: "x" } }), /explain/i);
  assert.match(errorsFor({ ...SECRET, explain: `a`.repeat(601) }), /explain/i);
  assert.match(errorsFor({ ...SECRET, signup_label: `a`.repeat(61) }), /signup_label/i);
  assert.match(errorsFor({ ...SECRET, explain: { en: "x", fr: "y" } }), /explain/i);
  assert.equal(okFor({ ...SECRET, explain: { en: "x", es: "y" }, signup_label: { en: "l", es: "l" } }), true);
});

test("contract: an env name that controls how programs run may not carry the help", () => {
  for (const name of ["NODE_OPTIONS", "LD_PRELOAD", "PYTHONPATH", "HTTP_PROXY", "CROW_SMTP_PASS", "COMPOSE_FILE"]) {
    const r = check({ name, secret: true, explain: "text" });
    assert.equal(r.ok, false, name);
    assert.match(r.errors.join("\n"), /controls how programs run/i, name);
  }
});

test("contract: a signup_url without an explain is a link, not help", () => {
  assert.match(errorsFor({ name: "DEMO_API_KEY", secret: true, signup_url: "https://keys.example.com/" }), /signup_url needs explain/);
});

test("contract: the six manifests that carry API-key help stay valid", () => {
  const want = {
    tailscale: { env: "TS_AUTHKEY", url: "https://console.tailscale.com/admin/settings/keys" },
    plex: { env: "PLEX_TOKEN", url: null },
    media: { env: "BRAVE_API_KEY", url: "https://brave.com/search/api/" },
    "matrix-bridges": { env: "BRIDGE_TELEGRAM_API_ID", url: "https://my.telegram.org/apps" },
    unsloth: { env: "UNSLOTH_HF_TOKEN", url: "https://huggingface.co/settings/tokens" },
    vllm: { env: "VLLM_HF_TOKEN", url: "https://huggingface.co/settings/tokens" },
  };
  for (const [id, spec] of Object.entries(want)) {
    const dir = join(REPO, "bundles", id);
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    const r = validateManifest(manifest, dir);
    assert.equal(r.ok, true, `${id}: ${r.errors.join("; ")}`);
    const ev = (manifest.env_vars || []).find((v) => v.name === spec.env);
    assert.ok(ev, `${id} declares ${spec.env}`);
    assert.equal(ev.secret, true, `${id} ${spec.env} is a typed secret`);
    assert.ok(ev.explain && (typeof ev.explain === "object" ? ev.explain.en : ev.explain), `${id} ${spec.env} has an explain`);
    if (spec.url) assert.equal(ev.signup_url, spec.url, `${id} ${spec.env} link`);
    else assert.equal(ev.signup_url, undefined, `${id} ${spec.env} has no unverified link`);
  }
  // The Telegram hash rides with the same page, and the Brave copy says what the plan gives.
  const tg = JSON.parse(readFileSync(join(REPO, "bundles", "matrix-bridges", "manifest.json"), "utf8"));
  const hash = tg.env_vars.find((v) => v.name === "BRIDGE_TELEGRAM_API_HASH");
  assert.equal(hash.signup_url, "https://my.telegram.org/apps");
  assert.ok(hash.explain.en, "the hash explains where it comes from");
  const media = JSON.parse(readFileSync(join(REPO, "bundles", "media", "manifest.json"), "utf8"));
  const brave = media.env_vars.find((v) => v.name === "BRAVE_API_KEY");
  assert.match(brave.explain.en, /Includes \$5\/month free credit/);
});

test("contract: a manifest without help fields is unaffected", () => {
  assert.equal(check({ name: "DEMO_PLAIN" }).ok, true);
});