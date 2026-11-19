/**
 * Channel 3 of the AI Companion retirement: every security fix reaches every install.
 *
 * A public install made before the Companion was removed still has it — an
 * `installed.json` record and/or `~/.crow/bundles/companion/`. It must be told, and it
 * must be able to fix it in one click. This file pins both halves:
 *
 *   1. the boot-time Fix-it detector raises exactly one card per retired bundle that is
 *      still installed, with text in the dashboard's language (en/es) taken from CODE;
 *   2. the card's Remove action runs the product's OWN uninstall path (the handler the
 *      Extensions page's Remove button posts to), driven by the code-held stub manifest
 *      because the repo no longer ships the bundle — so the skill, the env lines, the
 *      firewall port and the Serve mapping are cleaned up, the folder and the record go,
 *      and the add-on's data folder is KEPT (nothing else is deleted).
 *
 * bundles.js resolves CROW_HOME at module load, so the scratch roots are set before the
 * import (tests/retired-companion-store.test.js has the pattern).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rmScratch } from "./helpers/safe-rm.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const CROW_HOME = mkdtempSync(join(tmpdir(), "crow-retired-card-"));
const DATA_DIR = mkdtempSync(join(tmpdir(), "crow-retired-card-data-"));
process.env.CROW_HOME = CROW_HOME;
process.env.CROW_DATA_DIR = DATA_DIR;
process.env.CROW_DB_PATH = join(DATA_DIR, "crow.db");
process.env.CROW_AUTO_UPDATE = "0";
process.env.CROW_DISABLE_HEALTH_MONITOR = "1";
process.env.CROW_DISABLE_INSTANCE_SYNC = "1";
process.env.CROW_DISABLE_NOSTR = "1";

const BUNDLE_DIR = join(CROW_HOME, "bundles", "companion");
const INSTALLED_PATH = join(CROW_HOME, "installed.json");
const GATEWAY_ENV = join(CROW_HOME, "gateway.env");

let db = null;
let B = null;
let fixIt = null;
let store = null;
let detector = null;
let removedModules = {};
let remedy = null;
/** Captured by the two test seams in `before`. */
let portCalls = [];
let restarts = [];

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env },
    stdio: "pipe",
    cwd: ROOT,
  });
  // A fake installed Companion: the record, the folder (with an installed-copy manifest
  // and nothing else — a live install has no compose file), and the data folder the
  // kept-data rules must leave alone.
  mkdirSync(BUNDLE_DIR, { recursive: true });
  writeFileSync(join(BUNDLE_DIR, "manifest.json"), JSON.stringify({ id: "companion", name: "AI Companion", type: "bundle", version: "1.0.6" }));
  mkdirSync(join(DATA_DIR, "companion"), { recursive: true });
  writeFileSync(join(DATA_DIR, "companion", "keep-me.json"), "{}");
  writeFileSync(INSTALLED_PATH, JSON.stringify([{ id: "companion", type: "bundle", version: "1.0.6" }]));
  writeFileSync(GATEWAY_ENV, "COMPANION_AVATAR=mao_pro\n# COMPANION_PERSONA=old\n");

  const { createDbClient } = await import("../servers/db.js");
  db = createDbClient();
  B = await import("../servers/gateway/routes/bundles.js");
  fixIt = await import("../servers/gateway/fix-it/index.js");
  store = await import("../servers/shared/fix-it/store.js");
  detector = await import("../servers/gateway/fix-it/detectors/retired-bundle.js");
  removedModules = await import("../servers/gateway/retired-bundles.js");
  remedy = await import("../servers/gateway/fix-it/remedies/remove-retired-bundle.js");

  // Never let a test touch the operator's firewall, Serve config or gateway restarts.
  B._setAppEnvPathForTest(GATEWAY_ENV);
  B._setAppBundlesForTest(join(ROOT, "bundles"));
  B._setUninstallAffectedForTest(async () => []);
  B._setClosePortsRunForTest(async (...call) => { portCalls.push(call); return { stdout: "", stderr: "" }; });
  B._setRestartHookForTest(() => { restarts.push(1); });
});

after(() => {
  try { remedy?._setOwnerCheckForTest(null); } catch { /* best effort */ }
  try { B?._setRestartHookForTest(null); } catch { /* best effort */ }
  try { B?._setClosePortsRunForTest(null); } catch { /* best effort */ }
  try { B?._setUninstallAffectedForTest(null); } catch { /* best effort */ }
  try { B?._setAppEnvPathForTest(null); } catch { /* best effort */ }
  try { B?._setAppBundlesForTest(join(ROOT, "bundles")); } catch { /* best effort */ }
  try { db?.close?.(); } catch { /* best effort */ }
  for (const d of [CROW_HOME, DATA_DIR]) rmScratch(d);
});

// A stand-in for the db-bound store the gateway hands a detector: it records the upserts
// and the resolves so the card's exact shape can be asserted.
function fakeStore() {
  const upserts = [];
  const resolved = [];
  return {
    upserts,
    resolved,
    db: null,
    upsertItem: async (item) => { upserts.push(item); return { id: upserts.length, notify: true }; },
    resolveByKey: async (source, key) => { resolved.push([source, key]); },
  };
}

test("the retired set is code-held and names the AI Companion with what Remove must undo", () => {
  assert.equal(removedModules.isRetiredBundle("companion"), true);
  const stub = removedModules.retiredBundleManifest("companion");
  assert.equal(stub.type, "bundle");
  assert.deepEqual(stub.ports, [12393], "Remove must still close the port an old install opened");
  assert.deepEqual(stub.webUI, { port: 12393, proxyMode: "direct" });
  assert.deepEqual(stub.skills, ["skills/companion.md"]);
  assert.ok(stub.env_vars.every((v) => typeof v.name === "string" && !("default" in v)), "names only: an env revert never writes a value");
  assert.equal(removedModules.retiredBundleManifest("caddy"), null, "an ordinary bundle is untouched");
});

test("a fake installed Companion raises one card, with the code-held text in both languages", async () => {
  const fake = fakeStore();
  const out = await detector.default.check(fake, { crowHome: CROW_HOME, installedPath: INSTALLED_PATH });
  assert.deepEqual(out.cards, ["companion"]);
  assert.equal(fake.upserts.length, 1);
  const item = fake.upserts[0];
  assert.equal(item.source, "retired-bundle");
  assert.equal(item.dedupKey, "retired:companion");
  assert.equal(item.severity, "warn");
  assert.deepEqual(item.context, { bundle: "companion" });
  assert.equal(item.remedies.length, 1);
  assert.equal(item.remedies[0].actionId, "remove-retired-bundle");
  assert.equal(item.remedies[0].kind, "instant", "one click, never a confirm dialog");
  assert.deepEqual(item.remedies[0].args, { bundle: "companion" });
  assert.match(item.title, /AI Companion was retired/);
  assert.match(item.why, /data folder/);

  // The rendered card is localized from code, not from the stored row: the same item with
  // junk in the stored title/why renders the code-held Spanish text.
  assert.match(detector.cardTitle("companion", "es"), /se retiró/);
  assert.match(detector.cardWhy("companion", "es"), /carpeta de datos/);
  assert.equal(detector.cardTitle("companion", "en"), "AI Companion was retired");
});

test("the folder alone (a half-removed install) raises the card; nothing installed resolves it", async () => {
  const fake = fakeStore();
  await detector.default.check(fake, { crowHome: CROW_HOME, installedPath: join(CROW_HOME, "no-such-installed.json") });
  assert.equal(fake.upserts.length, 1, "the folder is enough");
  assert.equal(fake.resolved.length, 0);

  const empty = fakeStore();
  const nowhere = mkdtempSync(join(tmpdir(), "crow-retired-none-"));
  try {
    await detector.default.check(empty, { crowHome: nowhere, installedPath: join(nowhere, "installed.json") });
    assert.equal(empty.upserts.length, 0);
    assert.deepEqual(empty.resolved, [["retired-bundle", "retired:companion"]], "a gone bundle answers its own card");
  } finally { rmScratch(nowhere); }
});

test("the card renders in the dashboard's language, from code (en + es)", async () => {
  const { id } = await store.upsertItem(db, {
    source: "retired-bundle",
    dedupKey: "retired:companion",
    title: "stored junk",
    why: "stored junk",
    severity: "warn",
    remedies: [{ actionId: "remove-retired-bundle", kind: "instant", label: "Remove it", args: { bundle: "companion" } }],
    context: { bundle: "companion" },
  });
  const req = { csrfToken: "tok123" };
  const en = await fixIt.renderFixItCards(db, { lang: "en", req });
  assert.match(en, /AI Companion was retired/);
  assert.match(en, /Remove it/, "the one-click button");
  // The body's instruction quotes the button's own words, so the two never disagree.
  // `escapeHtml` renders the straight quotes as `&quot;` (the card body is escaped HTML).
  assert.match(detector.cardWhy("companion", "en"), /Press "Remove it":/, "the body quotes the button in code");
  assert.match(en, /Press &quot;Remove it&quot;:/, "the rendered body quotes the button");
  assert.match(en, /value="remove-retired-bundle"/);
  assert.match(en, /data-fixit-kind="instant"/);
  assert.doesNotMatch(en, /stored junk/, "nothing is read from the stored row");
  const es = await fixIt.renderFixItCards(db, { lang: "es", req });
  assert.match(es, /se retiró/);
  // Label AND instruction are localized together (the stored row's label is English only).
  assert.match(es, /Quitarlo/, "the one-click button, in Spanish");
  // Spanish quotes with the guillemets every other quoted control name in i18n.js uses.
  assert.match(detector.cardWhy("companion", "es"), /Pulsa «Quitarlo»:/, "the body quotes the button in code");
  assert.match(es, /Pulsa «Quitarlo»:/, "the rendered body quotes the Spanish button");
  assert.match(es, /carpeta de datos de la extensión/, "the article agrees with extensión");
  assert.doesNotMatch(es, /Remove it/, "no English label leaks into the Spanish card");
  assert.doesNotMatch(es, /AI Companion was retired/);
  assert.doesNotMatch(es, /botbuilder\./, "no bare i18n keys in es");
  await store.markResolved(db, id);
});

test("a peer/SSO sign-in, a login made on this box, or no session at all cannot click Remove", async () => {
  B.default(); // publishes the shared uninstall handler (the refusal must happen before it)
  portCalls = [];
  const { id } = await store.upsertItem(db, {
    source: "retired-bundle",
    dedupKey: "retired:companion",
    title: "AI Companion was retired",
    why: "still installed",
    severity: "warn",
    remedies: [{ actionId: "remove-retired-bundle", kind: "instant", label: "Remove it", args: { bundle: "companion" } }],
    context: { bundle: "companion" },
  });

  // A real session row whose scopes are NOT 'dashboard': exactly what a peer's SSO sign-in
  // mints (mintSsoSession). The Extensions page's uninstall route is an owner action; the
  // card posts to the same work, so it has to apply the same rule.
  const ssh = (t) => createHash("sha256").update(t).digest("hex");
  const SSO = "sso-session-for-the-test";
  const ONHOST = "onhost-session-for-the-test";
  await db.execute({
    sql: `INSERT INTO oauth_tokens (token, token_type, client_id, scopes, expires_at) VALUES
            (?, 'access', 'dashboard', 'dashboard sso src:peer-1', datetime('now', '+1 day')),
            (?, 'access', 'dashboard', 'dashboard onhost', datetime('now', '+1 day'))`,
    args: [ssh(SSO), ssh(ONHOST)],
  });
  // The owner's laptop: a client address that is not this machine (the origin rule inside
  // isLocalPasswordSessionOn refuses a request from the box itself).
  const fromLaptop = (token) => ({ dashboardSession: token, headers: {}, socket: { remoteAddress: "203.0.113.7", remotePort: 4242 } });

  const refused = [
    ["a peer SSO session", fromLaptop(SSO)],
    ["a login made on this box", fromLaptop(ONHOST)],
    ["no session at all", {}],
    ["an unknown session", fromLaptop("not-a-session")],
  ];
  for (const [what, sessionReq] of refused) {
    let redirected = null;
    await fixIt.handleFixItAction(
      { body: { action: "remedy", item_id: String(id), action_id: "remove-retired-bundle" }, csrfToken: "tok", ...sessionReq },
      { redirectAfterPost: (u) => { redirected = u; } },
      { db },
    );
    assert.match(String(redirected), /flash=fixit_owner_only/, `${what}: the Nest answers with the owner-only flash`);
  }
  // Every click was a refusal, and the refusal flash is the Nest's owner-only sentence.
  const row = await store.getItem(db, id);
  assert.equal(row.status, "pending", "the card is still open: nothing ran");
  assert.equal(existsSync(BUNDLE_DIR), true, "the bundle folder is untouched");
  assert.deepEqual(JSON.parse(readFileSync(INSTALLED_PATH, "utf8")), [{ id: "companion", type: "bundle", version: "1.0.6" }], "the record is untouched");
  assert.equal(portCalls.length, 0, "no port or Serve command ran");
  await store.markResolved(db, id);
});

test("the Remove action runs the product's uninstall path: folder + record gone, kept data stays", async () => {
  portCalls = [];
  restarts = [];
  B.default(); // mounts the router, which publishes the shared uninstall handler
  // The click in this test IS the owner's (a real one needs a password session in crow.db).
  remedy._setOwnerCheckForTest(() => true);

  const { id } = await store.upsertItem(db, {
    source: "retired-bundle",
    dedupKey: "retired:companion",
    title: "AI Companion was retired",
    why: "still installed",
    severity: "warn",
    remedies: [{ actionId: "remove-retired-bundle", kind: "instant", label: "Remove it", args: { bundle: "companion" } }],
    context: { bundle: "companion" },
  });

  let redirected = null;
  await fixIt.handleFixItAction(
    { body: { action: "remedy", item_id: String(id), action_id: "remove-retired-bundle" }, csrfToken: "tok" },
    { redirectAfterPost: (u) => { redirected = u; } },
    { db },
  );

  // The remedy waits for the uninstall job, so by the time the redirect exists the folder and
  // the record are gone (a job slower than the wait answers "removal started" instead — which
  // this assertion refuses: the fake Companion has nothing to tear down).
  assert.ok(redirected, "the owner is sent back to the nest");
  assert.match(redirected, /flash=fixit_retired_removed/, redirected);

  assert.equal(existsSync(BUNDLE_DIR), false, "the bundle folder is removed");
  const installed = JSON.parse(readFileSync(INSTALLED_PATH, "utf8"));
  assert.deepEqual(installed, [], "the install record is removed");
  assert.equal(existsSync(join(DATA_DIR, "companion", "keep-me.json")), true, "the data folder is KEPT");
  assert.ok(portCalls.some(([, argv]) => argv.includes("12393")), "the retired stub closed the bundle's firewall port");
  assert.ok(portCalls.some(([, argv]) => argv.includes("serve") && argv.some((a) => String(a).includes("12393"))), "and its Tailscale Serve mapping");
  assert.ok(restarts.length >= 1, "Remove still schedules the gateway restart that unloads the web UI");

  const row = await store.getItem(db, id);
  assert.equal(row.status, "resolved", "the card answers itself once the bundle is gone");
});

test("a RECORD-only install (the folder is already gone) removes the record and answers the card", async () => {
  // A half-removed install: installed.json still names the Companion, ~/.crow/bundles/companion
  // does not exist. The uninstall used to answer 404 for it, so every click on the card was a
  // fixit_error that changed nothing. It now finishes the job: record gone, port and Serve
  // mapping closed from the code-held stub, card resolved.
  portCalls = [];
  restarts = [];
  writeFileSync(INSTALLED_PATH, JSON.stringify([{ id: "companion", type: "bundle", version: "1.0.6" }]));
  assert.equal(existsSync(BUNDLE_DIR), false, "precondition: the folder is already gone");

  const { id } = await store.upsertItem(db, {
    source: "retired-bundle",
    dedupKey: "retired:companion",
    title: "AI Companion was retired",
    why: "still installed",
    severity: "warn",
    remedies: [{ actionId: "remove-retired-bundle", kind: "instant", label: "Remove it", args: { bundle: "companion" } }],
    context: { bundle: "companion" },
  });

  let redirected = null;
  await fixIt.handleFixItAction(
    { body: { action: "remedy", item_id: String(id), action_id: "remove-retired-bundle" }, csrfToken: "tok" },
    { redirectAfterPost: (u) => { redirected = u; } },
    { db },
  );

  assert.ok(redirected, "the owner is sent back to the nest");
  assert.doesNotMatch(String(redirected), /flash=fixit_error/, "a record-only install is not an error");
  assert.match(redirected, /flash=fixit_retired_removed/, redirected);
  assert.deepEqual(JSON.parse(readFileSync(INSTALLED_PATH, "utf8")), [], "the stale record is removed");
  assert.ok(portCalls.some(([, argv]) => argv.includes("12393")), "the recorded port is closed");
  assert.ok(portCalls.some(([, argv]) => argv.includes("serve") && argv.some((a) => String(a).includes("12393"))), "and the Serve mapping");
  assert.equal(existsSync(join(DATA_DIR, "companion", "keep-me.json")), true, "the data folder is still KEPT");

  const row = await store.getItem(db, id);
  assert.equal(row.status, "resolved", "the card resolves");
  // And the detector that raised it answers a card left over from an older boot too.
  const fake = fakeStore();
  await detector.default.check(fake, { crowHome: CROW_HOME, installedPath: INSTALLED_PATH });
  assert.equal(fake.upserts.length, 0, "nothing is raised once the record is gone");
  assert.deepEqual(fake.resolved, [["retired-bundle", "retired:companion"]]);
  remedy._setOwnerCheckForTest(null);
});