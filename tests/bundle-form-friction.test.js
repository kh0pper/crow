/**
 * Config-friction stage 1 (survey: ~/crow-weekend-push/reports/config-friction-survey.md).
 *
 * Every shipped manifest is checked, so a new bundle that asks a human for a DB password,
 * or a required field with no explanation, fails here instead of reaching an install form:
 *   - internal machine secrets (DB/Redis passwords, app signing keys, JWT/OTP/VAPID, shared
 *     runner secrets) carry `generate` — never a typed field
 *   - every survey F1 key is generated, or exempt with a written reason
 *   - every generated key of a docker bundle is consumed by its compose file
 *   - every required human field has a description
 *   - optional fields with a default fold under "Advanced" (bundle-env-form.js)
 *   - the fediverse bundles carry no dead per-bundle S3 fields
 * Plus the generation mechanics the manifests rely on (laravel_key, the VAPID pair, legacy
 * compose fallbacks, uninstall retention, propagate:true) and the executed client fold.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { webcrypto, createECDH } from "node:crypto";
import { readdirSync, readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseHTML } from "linkedom";

process.env.CROW_HOME = mkdtempSync(join(tmpdir(), "crow-friction-home-"));
process.env.CROW_DATA_DIR = mkdtempSync(join(tmpdir(), "crow-friction-data-"));
process.env.CROW_AUTO_UPDATE = "0";
process.env.CROW_DISABLE_HEALTH_MONITOR = "1";
process.env.CROW_DISABLE_INSTANCE_SYNC = "1";
process.env.CROW_DISABLE_NOSTR = "1";

const S = await import("../servers/gateway/bundle-env-secrets.js");
const F = await import("../servers/gateway/bundle-env-form.js");
const B = await import("../servers/gateway/routes/bundles.js");
const { validateManifest } = await import("../scripts/lib/bundle-contract.mjs");
const { buildExtensionsHTML } = await import("../servers/gateway/dashboard/panels/extensions/html.js");
const { extensionsClientJS } = await import("../servers/gateway/dashboard/panels/extensions/client.js");
const { t } = await import("../servers/gateway/dashboard/shared/i18n.js");

after(() => {
  rmSync(process.env.CROW_HOME, { recursive: true, force: true });
  rmSync(process.env.CROW_DATA_DIR, { recursive: true, force: true });
});

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLES = join(ROOT, "bundles");
const MANIFESTS = readdirSync(BUNDLES)
  .filter((d) => existsSync(join(BUNDLES, d, "manifest.json")))
  .map((d) => ({ dir: d, m: JSON.parse(readFileSync(join(BUNDLES, d, "manifest.json"), "utf8")) }));
const composeText = (dir) => {
  const p = join(BUNDLES, dir, "docker-compose.yml");
  return existsSync(p) ? readFileSync(p, "utf8") : null;
};
const nonBlank = (v) => v !== undefined && v !== null && String(v).trim() !== "";

/** Names that only ever hold a machine-to-machine secret inside one bundle. */
const INTERNAL_SECRET_PATTERNS = [
  /_DB_(ROOT_)?PASS(WORD)?$/,
  /POSTGRES_PASS(WORD)?$/,
  /MYSQL_(ROOT_)?PASSWORD$/,
  /REDIS_PASS(WORD)?$/,
  /SECRET_KEY_BASE$/,
  /(DJANGO|AUTH|APP|SEARXNG)_SECRET_KEY$/,
  /_APP_KEY$/,
  /JWT_SECRET$/,
  /OTP_SECRET$/,
  /VAPID_(PRIVATE|PUBLIC)_KEY$/,
  /_ENCRYPTION_(KEY|DETERMINISTIC_KEY|KEY_DERIVATION_SALT|PRIMARY_KEY)$/,
  /(REGISTRATION|RUNNER)_SHARED_SECRET$|_RUNNER_SECRET$/,
  /^TURN_SECRET$/,
  /PICTRS_API_KEY$/,
  /^PEERTUBE_SECRET$/,
  /_VNC_PASSWORD$/,
  /^MINIO_ROOT_PASSWORD$/,
  /FIRSTRUN_ADMIN_PASSWORD$/,
];

/**
 * Survey §1.3 keys that are NOT generated, each with the reason. Keep this short: a new
 * entry needs a reason a reviewer would accept.
 */
const EXEMPT = {
  "campaigns:CROW_CAMPAIGNS_ENCRYPTION_KEY": "data-at-rest key for an MCP-server bundle (no compose); losing it loses the data, so generation waits for the recovery-key decision (survey §5 Q5)",
  "tax:CROW_TAX_ENCRYPTION_KEY": "data-at-rest key for an MCP-server bundle (no compose); losing it loses the data, so generation waits for the recovery-key decision (survey §5 Q5)",
  "crowdsec:CROWDSEC_API_KEY": "minted by `cscli bouncers add` after first boot and read by the MCP/panel from process.env, not by compose — a post-install hook, not pre-generation (survey §1.3)",
  "frigate:FRIGATE_RTSP_PASSWORD": "the operator's camera RTSP password, substituted into config.yml camera URLs ({FRIGATE_RTSP_PASSWORD}) — human input, not an internal secret",
  "lemmy:LEMMY_JWT": "an admin login JWT obtained from the running app after the admin registers (survey F2), not a value Crow can invent",
  "rookery:ROOKERY_MCP_CROW_TOKEN": "must be a Crow-issued local MCP token (local-token.js), not random bytes; optional and only used with ROOKERY_MCP_CROW_URL",
};

/** Survey §1.3 F1 table (31 keys) + MINIO_ROOT_PASSWORD (§1.3 note). */
const SURVEY_F1 = [
  "bookstack:BOOKSTACK_DB_PASSWORD", "browser:CROW_BROWSER_VNC_PASSWORD", "campaigns:CROW_CAMPAIGNS_ENCRYPTION_KEY",
  "coturn:TURN_SECRET", "crowdsec:CROWDSEC_API_KEY", "frigate:FRIGATE_RTSP_PASSWORD", "funkwhale:FUNKWHALE_DJANGO_SECRET_KEY",
  "lemmy:LEMMY_DB_PASSWORD", "lemmy:LEMMY_PICTRS_API_KEY", "lemmy:LEMMY_JWT", "mastodon:MASTODON_DB_PASSWORD",
  "mastodon:MASTODON_SECRET_KEY_BASE", "mastodon:MASTODON_OTP_SECRET", "mastodon:MASTODON_VAPID_PRIVATE_KEY",
  "mastodon:MASTODON_VAPID_PUBLIC_KEY", "matrix-dendrite:MATRIX_POSTGRES_PASSWORD", "matrix-dendrite:MATRIX_REGISTRATION_SHARED_SECRET",
  "miniflux:MINIFLUX_DB_PASSWORD", "paperless:PAPERLESS_DB_PASSWORD", "peertube:PEERTUBE_DB_PASSWORD", "peertube:PEERTUBE_SECRET",
  "phone:PHONE_RUNNER_SECRET", "pixelfed:PIXELFED_DB_PASSWORD", "pixelfed:PIXELFED_APP_KEY", "romm:ROMM_DB_PASSWORD",
  "romm:ROMM_AUTH_SECRET_KEY", "rookery:ROOKERY_MCP_CROW_TOKEN", "searxng:SEARXNG_SECRET_KEY", "tax:CROW_TAX_ENCRYPTION_KEY",
  "vaultwarden:VAULTWARDEN_ADMIN_TOKEN", "wallabag:WALLABAG_DB_PASSWORD", "minio:MINIO_ROOT_PASSWORD",
];

function envVar(bundle, key) {
  const entry = MANIFESTS.find((x) => x.dir === bundle);
  return entry && (entry.m.env_vars || []).find((v) => v && v.name === key);
}

test("survey F1: every internal secret is generated, or exempt with a reason", () => {
  assert.equal(SURVEY_F1.length, 32);
  for (const ref of SURVEY_F1) {
    const [bundle, key] = ref.split(":");
    const v = envVar(bundle, key);
    assert.ok(v, `${ref} is gone from its manifest — update this list (and the survey) deliberately`);
    if (EXEMPT[ref]) {
      assert.ok(!v.generate, `${ref} is generated now — drop its exemption`);
      assert.ok(EXEMPT[ref].length > 40, `${ref}: exemption needs a real reason`);
    } else {
      assert.ok(S.generatedEnvKeys({ env_vars: [v] }).length === 1, `${ref} must carry a known generate kind`);
    }
  }
});

test("no manifest asks a human for a field that matches an internal-secret pattern", () => {
  const offenders = [];
  for (const { dir, m } of MANIFESTS) {
    for (const v of m.env_vars || []) {
      if (!v || typeof v.name !== "string" || v.generate) continue;
      if (EXEMPT[`${dir}:${v.name}`]) continue;
      if (INTERNAL_SECRET_PATTERNS.some((re) => re.test(v.name))) offenders.push(`${dir}:${v.name}`);
    }
  }
  assert.deepEqual(offenders, [], "mark these generate:\"secret\" (or a stricter kind) — a human should never type an internal secret");
});

test("the internal-secret patterns do not swallow human credentials", () => {
  for (const name of ["ADGUARD_PASSWORD", "MASTODON_SMTP_PASSWORD", "IGDB_CLIENT_SECRET", "GITEA_TOKEN", "BRAVE_API_KEY", "FRIGATE_PASSWORD", "WALLABAG_CLIENT_SECRET"]) {
    assert.ok(!INTERNAL_SECRET_PATTERNS.some((re) => re.test(name)), `${name} is a human/external credential`);
  }
});

test("every generated key of a docker bundle is consumed by its compose file", () => {
  for (const { dir, m } of MANIFESTS) {
    const keys = S.generatedEnvKeys(m);
    if (keys.length === 0) continue;
    const text = composeText(dir);
    assert.ok(text, `${dir}: generated keys only make sense for a compose bundle (the MCP env never receives them)`);
    const consumed = B.composeConsumedKeys(text);
    // Explicit interpolation only: an env_file .env would make `consumed.all` pass vacuously.
    for (const k of keys) assert.ok(consumed.keys.has(k), `${dir}: ${k} is generated but its compose never interpolates it`);
  }
});

test("every generated key is a secret or a derived public half, and is required", () => {
  for (const { dir, m } of MANIFESTS) {
    for (const v of m.env_vars || []) {
      if (!v?.generate) continue;
      assert.ok(v.secret === true || v.generate === "vapid_public_key", `${dir}:${v.name} — mark secret:true`);
      assert.ok(nonBlank(v.description), `${dir}:${v.name} needs a description`);
      assert.ok(!nonBlank(v.default), `${dir}:${v.name} — a generated key must not carry a manifest default`);
    }
  }
});

test("every required human field has a description", () => {
  const missing = [];
  for (const { dir, m } of MANIFESTS) {
    for (const v of F.visibleEnvVars(m)) {
      if (v.required && !nonBlank(v.default) && !nonBlank(v.description)) missing.push(`${dir}:${v.name}`);
    }
  }
  assert.deepEqual(missing, []);
});

test("every manifest passes the bundle contract (generate kinds, VAPID pair, advanced type)", () => {
  for (const { dir, m } of MANIFESTS) {
    const r = validateManifest(m, join(BUNDLES, dir));
    const errs = (r?.errors || []).filter((e) => /generate|advanced|pair|propagate/.test(e));
    assert.deepEqual(errs, [], dir);
  }
});

test("bundle contract refuses an unknown generate kind, an unpaired VAPID public key, a non-boolean advanced", () => {
  const base = { id: "demo", name: "Demo", description: "d", type: "bundle", version: "0.1.0", category: "productivity", author: "Crow" };
  const errsFor = (env_vars) => (validateManifest({ ...base, env_vars }, scratch("c-")).errors || []).join("\n");
  assert.match(errsFor([{ name: "A", secret: true, generate: "hex" }]), /generate/);
  assert.match(errsFor([{ name: "P", generate: "vapid_public_key", pair: "NOPE" }]), /vapid_public_key/);
  assert.match(errsFor([{ name: "A", advanced: "yes" }]), /advanced/);
  assert.match(errsFor([{ name: "T", secret: true, generate: "secret", keychain: true, store_as: "argon2id", propagate: true }]), /propagate/);
});

test("fediverse bundles: no dead per-bundle S3 fields; descriptions say where media lives", () => {
  for (const id of ["mastodon", "peertube", "pixelfed", "funkwhale"]) {
    const { m } = MANIFESTS.find((x) => x.dir === id);
    const s3 = (m.env_vars || []).filter((v) => /_S3_/.test(v.name)).map((v) => v.name);
    assert.deepEqual(s3, [], `${id}: the install flow never read these (compose reads only the translator's names)`);
    assert.match(`${m.description} ${m.notes || ""}`, /local disk/i, `${id}: say where media is stored`);
  }
  assert.deepEqual(MANIFESTS.find((x) => x.dir === "funkwhale").m.storage, { translator: "funkwhale", bucket: "funkwhale" }, "Shared Storage injection stays wired for funkwhale");
});

test("mastodon: the Active Record encryption keys Mastodon 4.3+ aborts without are generated and passed", () => {
  const text = composeText("mastodon");
  for (const [env, key] of [["ACTIVE_RECORD_ENCRYPTION_DETERMINISTIC_KEY", "MASTODON_AR_ENCRYPTION_DETERMINISTIC_KEY"], ["ACTIVE_RECORD_ENCRYPTION_KEY_DERIVATION_SALT", "MASTODON_AR_ENCRYPTION_KEY_DERIVATION_SALT"], ["ACTIVE_RECORD_ENCRYPTION_PRIMARY_KEY", "MASTODON_AR_ENCRYPTION_PRIMARY_KEY"]]) {
    assert.equal(text.split(`${env}: \${${key}}`).length - 1, 2, `${env} in web AND sidekiq`);
    assert.equal(envVar("mastodon", key)?.generate, "secret");
  }
});

// ── Advanced fold ──

test("isAdvancedEnvVar: optional-with-default folds; required-without-default and required secrets never do", () => {
  assert.equal(F.isAdvancedEnvVar({ name: "A", default: "8080" }), true);
  assert.equal(F.isAdvancedEnvVar({ name: "A", default: "8080", required: false }), true);
  assert.equal(F.isAdvancedEnvVar({ name: "A", default: " " }), false, "a blank default is no default");
  assert.equal(F.isAdvancedEnvVar({ name: "A" }), false, "optional with nothing to fall back on: show it");
  assert.equal(F.isAdvancedEnvVar({ name: "A", required: true, default: "x" }), false, "the automatic rule is required:false only");
  assert.equal(F.isAdvancedEnvVar({ name: "A", required: true, default: "x", advanced: true }), true, "opt-in");
  assert.equal(F.isAdvancedEnvVar({ name: "A", default: "x", advanced: false }), false, "opt-out");
  assert.equal(F.isAdvancedEnvVar({ name: "A", required: true, advanced: true }), false, "required with no default always needs a human");
  assert.equal(F.isAdvancedEnvVar({ name: "A", required: true, secret: true, default: "x", advanced: true }), false, "a secret's default never reaches the browser");
});

test("formEnvVars: generated keys never sent, a secret's default never sent, advanced flag computed", () => {
  const out = F.formEnvVars({ env_vars: [
    { name: "G", generate: "secret", secret: true },
    { name: "S", secret: true, default: "local" },
    { name: "P", default: "9000" },
    { name: "H", required: true, description: "your domain" },
  ] });
  assert.deepEqual(out.map((v) => v.name), ["S", "P", "H"]);
  assert.equal(out[0].default, "");
  // An optional secret with a default folds too: its default stays server-side (compose
  // fallback / MCP default), the browser just never sees it.
  assert.deepEqual(out.map((v) => v.advanced), [true, true, false]);
});

test("survey-wide: a typical install now shows far fewer fields", () => {
  let visible = 0, primary = 0;
  for (const { m } of MANIFESTS) {
    visible += F.visibleEnvVars(m).length;
    primary += F.primaryEnvVars(m).length;
  }
  // Survey baseline: 368 declared inputs, ~150 with defaults. Folding + generation must
  // remove at least a third of what the forms showed unfolded.
  assert.ok(primary <= Math.floor(visible * 0.75), `primary ${primary} of ${visible} visible`);
});

test("i18n: Advanced strings exist in en and es", () => {
  for (const k of ["extensions.advancedSettings", "extensions.advancedSettingsHint"]) {
    assert.ok(nonBlank(t(k, "en")) && t(k, "en") !== k, `${k} en`);
    assert.ok(nonBlank(t(k, "es")) && t(k, "es") !== k && t(k, "es") !== t(k, "en"), `${k} es`);
  }
});

function bootClient(available, override = null) {
  const CLIENT_HTML = extensionsClientJS("en");
  const js = CLIENT_HTML.slice(CLIENT_HTML.indexOf("<script>") + 8, CLIENT_HTML.lastIndexOf("</script>"));
  const overlay = CLIENT_HTML.slice(0, CLIENT_HTML.indexOf("<script>"));
  const { viewsHtml, addonRegistryScript, collectionsScript } = buildExtensionsHTML({
    installed: {}, available, collections: [], registrySource: "local", communityStores: [], bundleStatus: {}, lang: "en",
  });
  const { window, document } = parseHTML(`<html><body><div class="main-content">${viewsHtml}${addonRegistryScript}${collectionsScript}${overlay}</div></body></html>`);
  const calls = [];
  const ctx = vm.createContext({
    window, document, console, AbortController, crypto: webcrypto,
    location: { hash: "", href: "https://crow.test/dashboard/extensions", reload() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    navigator: { clipboard: { writeText: () => Promise.resolve() } },
    fetch: (url, init) => {
      calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
      const o = override && override(String(url));
      if (o) return Promise.resolve({ ok: o.ok, status: o.status, json: () => Promise.resolve(o.body) });
      const body = String(url).includes("/consent-challenge/") ? { required: false, install_required: [] } : { ok: true, job_id: "1" };
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
    },
    setTimeout: () => 0, clearTimeout: () => {},
  });
  vm.runInContext(js, ctx);
  const click = (el) => el.dispatchEvent(new window.Event("click", { bubbles: true }));
  const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };
  return { document, click, settle, calls };
}

test("Install form (executed): defaults fold under a closed Advanced section; folded values are still submitted", async () => {
  const { document, click, settle, calls } = bootClient([{
    id: "demo", name: "Demo", description: "d", type: "bundle", category: "productivity", version: "1.0.0", author: "Crow", tags: [],
    env_vars: [
      { name: "DEMO_DOMAIN", description: "Your public domain", required: true },
      { name: "DEMO_PORT", description: "Port", default: "8080" },
      { name: "DEMO_RETENTION", description: "Days", default: "14", required: false },
      { name: "DEMO_TUNING", description: "Advanced knob", advanced: true },
      { name: "DEMO_DB_PASSWORD", description: "generated", secret: true, generate: "secret" },
    ],
  }]);
  click(document.querySelector('.bundle-install[data-id="demo"]'));
  await settle();
  const details = document.querySelector("details.ext-install__advanced");
  assert.ok(details, "an Advanced section is rendered");
  assert.equal(details.hasAttribute("open"), false, "collapsed by default");
  assert.match(details.querySelector("summary").textContent, /Advanced settings \(3\)/);
  for (const k of ["DEMO_PORT", "DEMO_RETENTION", "DEMO_TUNING"]) assert.ok(details.querySelector(`#env_${k}`), `${k} folded`);
  assert.equal(details.querySelector("#env_DEMO_DOMAIN"), null, "the human's field stays outside");
  assert.ok(document.getElementById("env_DEMO_DOMAIN"));
  assert.equal(document.getElementById("env_DEMO_DB_PASSWORD"), null, "generated fields never render");
  document.getElementById("env_DEMO_DOMAIN").value = "example.org";
  click(document.querySelector("#modal-content .btn-primary"));
  await settle();
  const install = calls.find((c) => c.url.endsWith("/bundles/api/install"));
  assert.ok(install, "install posted");
  assert.equal(install.body.env_vars.DEMO_DOMAIN, "example.org");
  assert.equal(install.body.env_vars.DEMO_PORT, "8080", "a folded default is still submitted");
  assert.equal(install.body.env_vars.DEMO_RETENTION, "14");
  assert.equal("DEMO_DB_PASSWORD" in install.body.env_vars, false);
});

test("Install form (executed): no Advanced section when nothing folds", async () => {
  const { document, click, settle } = bootClient([{
    id: "plain", name: "Plain", description: "d", type: "bundle", category: "productivity", version: "1.0.0", author: "Crow", tags: [],
    env_vars: [{ name: "PLAIN_TOKEN", description: "API token from the app", required: true, secret: true }],
  }]);
  click(document.querySelector('.bundle-install[data-id="plain"]'));
  await settle();
  assert.equal(document.querySelector("details.ext-install__advanced"), null);
  assert.ok(document.getElementById("env_PLAIN_TOKEN"));
});

// ── Generation mechanics the manifests rely on ──

const scratch = (p) => mkdtempSync(join(tmpdir(), p));

test("laravel_key: base64: + 32 random bytes (Pixelfed's APP_KEY shape), .env-bare-safe", () => {
  const out = S.resolveGeneratedEnv("px", { env_vars: [{ name: "APP_KEY", secret: true, generate: "laravel_key" }] }, { destDir: scratch("d-"), crowHome: scratch("h-") });
  assert.match(out.APP_KEY, /^base64:[A-Za-z0-9+/]{43}=$/);
  assert.equal(Buffer.from(out.APP_KEY.slice(7), "base64").length, 32);
});

const VAPID = { env_vars: [
  { name: "V_PRIV", secret: true, generate: "vapid_private_key" },
  { name: "V_PUB", generate: "vapid_public_key", pair: "V_PRIV" },
] };

test("VAPID pair: a real P-256 pair in the webpush gem's encoding; reinstall keeps it", () => {
  const home = scratch("h-");
  const a = S.resolveGeneratedEnv("mst", VAPID, { destDir: scratch("d-"), crowHome: home });
  const priv = Buffer.from(a.V_PRIV.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  const pub = Buffer.from(a.V_PUB.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  assert.equal(priv.length, 32);
  assert.equal(pub.length, 65);
  assert.equal(pub[0], 4, "uncompressed point");
  const ecdh = createECDH("prime256v1"); ecdh.setPrivateKey(priv);
  assert.ok(ecdh.getPublicKey().equals(pub), "the public key belongs to the private key");
  assert.match(a.V_PRIV, /^[A-Za-z0-9_-]+=*$/);
  const b = S.resolveGeneratedEnv("mst", VAPID, { destDir: scratch("d-"), crowHome: home });
  assert.deepEqual(b, a, "never regenerated: subscribed browsers hold the public key");
});

test("VAPID pair: a kept private key with no public half gets its own public key, not a new pair", () => {
  const home = scratch("h-"); const dest = scratch("d-");
  const a = S.newVapidKeypair();
  writeFileSync(join(dest, ".env"), `V_PRIV=${a.privateKey}\n`);
  const out = S.resolveGeneratedEnv("mst", VAPID, { destDir: dest, crowHome: home });
  assert.equal(out.V_PRIV, a.privateKey);
  assert.equal(out.V_PUB, a.publicKey);
});

test("legacy install: a key its .env left blank keeps the compose fallback its database was created with", () => {
  const home = scratch("h-"); const dest = scratch("d-");
  writeFileSync(join(dest, ".env"), "OTHER=1\n");
  const compose = "services:\n  db:\n    environment:\n      - POSTGRES_PASSWORD=${DEMO_DB_PASSWORD:-miniflux}\n";
  const m = { env_vars: [{ name: "DEMO_DB_PASSWORD", secret: true, generate: "secret" }] };
  assert.equal(S.resolveGeneratedEnv("legacy", m, { destDir: dest, crowHome: home, composeText: compose, priorInstall: true }).DEMO_DB_PASSWORD, "miniflux");
  // A fresh install (no .env yet) never uses the insecure fallback.
  const fresh = S.resolveGeneratedEnv("fresh", m, { destDir: scratch("d-"), crowHome: home, composeText: compose, priorInstall: true });
  assert.match(fresh.DEMO_DB_PASSWORD, /^[A-Za-z0-9_-]{43}$/);
  // An .env that only arrived with the copied source tree (a dev checkout) is not a prior
  // install: no fallback, a fresh secret.
  const srcCopy = scratch("d-");
  writeFileSync(join(srcCopy, ".env"), "OTHER=1\n");
  const notLegacy = S.resolveGeneratedEnv("srccopy", m, { destDir: srcCopy, crowHome: home, composeText: compose, priorInstall: false });
  assert.match(notLegacy.DEMO_DB_PASSWORD, /^[A-Za-z0-9_-]{43}$/);
});

test("composeFallbacks: only literal ${KEY:-value} defaults, never $$-escaped or nested", () => {
  assert.deepEqual(S.composeFallbacks("${A:-x} ${B:?no} ${C:-} $${D:-y} ${E-z} ${F:-${G}} ${H:-\"q\"}"), { A: "x", H: "q" },
    "${E-z} applies only when E is UNSET — Crow's .env always sets it");
});

test("uninstall retention: a pre-generation install's typed or fallback values are kept for the reinstall", () => {
  const home = scratch("h-"); const dest = scratch("d-");
  const m = { env_vars: [
    { name: "TYPED_DB_PASSWORD", secret: true, generate: "secret" },
    { name: "FALLBACK_DB_PASSWORD", secret: true, generate: "secret" },
    { name: "NEVER_SET", secret: true, generate: "secret" },
  ] };
  writeFileSync(join(dest, ".env"), "TYPED_DB_PASSWORD=typed-by-a-human\n");
  const compose = "x: ${FALLBACK_DB_PASSWORD:-bookstack}\n";
  assert.equal(S.retainGeneratedForReinstall("old", m, { destDir: dest, crowHome: home, composeText: compose }), 2);
  const kept = S.parseEnvText(readFileSync(S.retainedEnvPath(home, "old"), "utf8"));
  assert.deepEqual(kept, { TYPED_DB_PASSWORD: "typed-by-a-human", FALLBACK_DB_PASSWORD: "bookstack" });
  assert.equal(statSync(S.retainedEnvPath(home, "old")).mode & 0o777, 0o600);
  // Reinstall into a fresh dir: the kept values win; only the never-set key is minted.
  const re = S.resolveGeneratedEnv("old", m, { destDir: scratch("d-"), crowHome: home });
  assert.equal(re.TYPED_DB_PASSWORD, "typed-by-a-human");
  assert.equal(re.FALLBACK_DB_PASSWORD, "bookstack");
  assert.match(re.NEVER_SET, /^[A-Za-z0-9_-]{43}$/);
  // A data-deleting uninstall keeps typed values but never a publicly known fallback.
  const home2 = scratch("h-");
  assert.equal(S.retainGeneratedForReinstall("old", m, { destDir: dest, crowHome: home2, composeText: compose, includeFallbacks: false }), 1);
  assert.deepEqual(S.parseEnvText(readFileSync(S.retainedEnvPath(home2, "old"), "utf8")), { TYPED_DB_PASSWORD: "typed-by-a-human" });
  // An already-retained value is never overwritten by retention.
  writeFileSync(join(dest, ".env"), "TYPED_DB_PASSWORD=changed-later\n");
  S.retainGeneratedForReinstall("old", m, { destDir: dest, crowHome: home, composeText: compose });
  assert.equal(S.parseEnvText(readFileSync(S.retainedEnvPath(home, "old"), "utf8")).TYPED_DB_PASSWORD, "typed-by-a-human");
});

test("propagate:true: a generated key the gateway reads reaches the gateway .env; others and hashes never do", () => {
  const m = { env_vars: [
    { name: "RUNNER_SECRET", secret: true, generate: "secret", propagate: true },
    { name: "DB_PASSWORD", secret: true, generate: "secret" },
    { name: "ADMIN_TOKEN", secret: true, generate: "secret", keychain: true, store_as: "argon2id", propagate: true },
    { name: "PLAIN", description: "x" },
  ] };
  assert.deepEqual(S.gatewayGeneratedKeys(m), ["RUNNER_SECRET"]);
  assert.deepEqual(B.declaredEnvSubset(m, { RUNNER_SECRET: "r", DB_PASSWORD: "d", ADMIN_TOKEN: "h", PLAIN: "p" }), { RUNNER_SECRET: "r", PLAIN: "p" });
});

test("shipped gateway-read secrets propagate: phone runner, coturn TURN, MinIO root", () => {
  for (const [b, k] of [["phone", "PHONE_RUNNER_SECRET"], ["coturn", "TURN_SECRET"], ["minio", "MINIO_ROOT_PASSWORD"]]) {
    const { m } = MANIFESTS.find((x) => x.dir === b);
    assert.ok(S.gatewayGeneratedKeys(m).includes(k), `${b}:${k} is read from the gateway's process.env`);
  }
});

test("install (route-level wiring): generated + propagate:true secret lands in the bundle .env AND the gateway .env", async () => {
  const fixtures = scratch("app-");
  B._setAppBundlesForTest(fixtures);
  const gwEnv = join(scratch("gw-"), ".env");
  writeFileSync(gwEnv, "# gateway\n");
  B._setAppEnvPathForTest(gwEnv);
  try {
    const id = "demo-prop";
    mkdirSync(join(fixtures, id), { recursive: true });
    const manifest = { id, name: id, description: "d", type: "bundle", category: "productivity", version: "0.1.0",
      env_vars: [
        { name: "DEMO_RUNNER_SECRET", secret: true, generate: "secret", propagate: true, required: true },
        { name: "DEMO_DB_PASSWORD", secret: true, generate: "secret" },
      ] };
    writeFileSync(join(fixtures, id, "manifest.json"), JSON.stringify(manifest));
    const job = B._createJobForTest(id, "install");
    const r = await B.runInstallJob(id, {}, { job, installedSnapshot: [], consentVerified: false, manifest });
    assert.equal(r.ok, true, r.reason);
    const bundleEnv = S.parseEnvText(readFileSync(join(process.env.CROW_HOME, "bundles", id, ".env"), "utf8"));
    const gw = readFileSync(gwEnv, "utf8");
    assert.match(bundleEnv.DEMO_RUNNER_SECRET, /^[A-Za-z0-9_-]{43}$/);
    assert.ok(gw.includes(`DEMO_RUNNER_SECRET=${bundleEnv.DEMO_RUNNER_SECRET}`), "the gateway reads the same secret");
    assert.ok(!gw.includes("DEMO_DB_PASSWORD"), "a plain generated secret never reaches the gateway .env");
  } finally {
    B._setAppEnvPathForTest(null);
  }
});

test("uninstall route keeps a pre-generation install's typed secret, and the reinstall reuses it", async () => {
  const fixtures = scratch("app-");
  B._setAppBundlesForTest(fixtures);
  const express = (await import("express")).default;
  const id = "demo-legacy-typed";
  const manifest = { id, name: id, description: "d", type: "bundle", category: "productivity", version: "0.2.0",
    env_vars: [{ name: "DEMO_DB_PASSWORD", secret: true, generate: "secret" }] };
  mkdirSync(join(fixtures, id), { recursive: true });
  writeFileSync(join(fixtures, id, "manifest.json"), JSON.stringify(manifest));
  // Installed by an older Crow: the human typed it; no retained copy exists.
  const dir = join(process.env.CROW_HOME, "bundles", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ ...manifest, version: "0.1.0" }));
  writeFileSync(join(dir, ".env"), "DEMO_DB_PASSWORD=typed-long-ago\n");
  writeFileSync(join(process.env.CROW_HOME, "installed.json"), JSON.stringify([{ id, type: "bundle", version: "0.1.0" }]));
  const app = express(); app.use(express.json()); app.use(B.default());
  const server = app.listen(0, "127.0.0.1"); await new Promise((r) => server.once("listening", r));
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/bundles/api/uninstall`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ bundle_id: id }) });
    assert.equal(r.status, 200);
    const deadline = Date.now() + 10_000;
    while (existsSync(dir) && Date.now() < deadline) await new Promise((res) => setTimeout(res, 50));
  } finally { server.close(); }
  assert.equal(existsSync(dir), false, "uninstall removed the bundle dir");
  assert.equal(S.parseEnvText(readFileSync(S.retainedEnvPath(process.env.CROW_HOME, id), "utf8")).DEMO_DB_PASSWORD, "typed-long-ago");
  const job = B._createJobForTest(id, "install");
  const out = await B.runInstallJob(id, {}, { job, installedSnapshot: [], consentVerified: false, manifest });
  assert.equal(out.ok, true, out.reason);
  assert.equal(S.parseEnvText(readFileSync(join(dir, ".env"), "utf8")).DEMO_DB_PASSWORD, "typed-long-ago", "the kept database still expects it");
});

test("Install form (executed): a server rejection naming a folded field unfolds Advanced", async () => {
  const { document, click, settle } = bootClient([{
    id: "rej", name: "Rej", description: "d", type: "bundle", category: "productivity", version: "1.0.0", author: "Crow", tags: [],
    env_vars: [{ name: "REJ_PORT", description: "Port", default: "80" }],
  }], (url) => (url.includes("/bundles/api/install") ? { ok: false, status: 400, body: { code: "invalid_env", key: "REJ_PORT", error: "Environment variable 'REJ_PORT' is bad" } } : null));
  click(document.querySelector('.bundle-install[data-id="rej"]'));
  await settle();
  const details = document.querySelector("details.ext-install__advanced");
  assert.equal(details.hasAttribute("open"), false);
  click(document.querySelector("#modal-content .btn-primary"));
  await settle();
  assert.equal(details.hasAttribute("open"), true);
});
