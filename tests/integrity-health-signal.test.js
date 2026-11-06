/**
 * integrity-health-signal.test.js — security audit N1c-18.
 *
 * The Nest's `integrity` card, in two parts:
 *
 *   (a) MODES of the Crow home, its data dir and crow.db (+ the WAL/SHM).
 *       Boot's tightenCrowHomePermissions has already chmod'ed what it could, so
 *       anything still readable OR WRITABLE by group/others is what it had to
 *       leave alone. WARN, naming the path's ROLE — never the path.
 *   (b) CHECKOUT state, for a git checkout only: off main → INFO, detached HEAD
 *       → INFO (the Updates card owns that warn), tracked local edits → INFO
 *       with a count and no file names. Untracked files are ignored. No `.git`
 *       (a container, a tarball install) or no git at all → no part (b).
 *
 * A check that could not run is INFO "unknown", never ok.
 *
 * Sibling signals are neutralized exactly as tests/system-updates-signal.test.js
 * and tests/external-engines-signal.test.js do, so nothing here depends on the
 * machine running the suite (its Docker, tailscale, apt, firewall, disk). The
 * modes part runs against a scratch home of our own, and git is a seam.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmScratch } from "./helpers/safe-rm.js";

// A scratch instance of our own: the modes part must never read the suite's
// shared CROW_HOME (a concurrent gateway boot may have tightened it already).
const ROOT = mkdtempSync(join(tmpdir(), "crow-integrity-"));
const HOME = join(ROOT, "home");
const DATA = join(HOME, "data");
const DB = join(DATA, "crow.db");
// A fake app root that IS a checkout: the card's first question is only whether
// `<app root>/.git` exists (git itself stays a seam below).
const APP = join(ROOT, "app");
const NO_CHECKOUT = join(ROOT, "no-checkout");
process.env.CROW_HOME = HOME;
process.env.CROW_DATA_DIR = DATA;
delete process.env.CROW_DB_PATH;

mkdirSync(DATA, { recursive: true });
mkdirSync(join(APP, ".git"), { recursive: true });
mkdirSync(NO_CHECKOUT, { recursive: true });
writeFileSync(DB, "db");
chmodSync(HOME, 0o700);
chmodSync(DATA, 0o700);
chmodSync(DB, 0o600);

// Sibling signals: inert, on any host.
process.env.CROW_PUBLISH_SNAPSHOT = "/tmp/__crow_test_no_publish_snapshot__.json";
process.env.CROW_BACKUP_DIR = "/tmp/__crow_test_nonexistent_backup_dir__";
process.env.CROW_GATEWAY_BIND = "127.0.0.1";
delete process.env.CROW_DASHBOARD_PUBLIC;
delete process.env.CROW_CSRF_STRICT;
delete process.env.CROW_ARTIFACT_ORIGIN_URL;

const {
  collectHealthSignals,
  invalidateHealthCache,
  countTrackedChanges,
  _setDiskReader,
  _setTailscaleReader,
  _setDockerPortsReader,
  _setFirewallReader,
  _setContainerReader,
  _setArtifactNodeReader,
  _setBundleImageReaders,
  _setSystemUpdateReaders,
  _setIntegrityReaders,
} = await import("../servers/gateway/dashboard/panels/nest/health-signals.js");
const { translations, SUPPORTED_LANGS, fill } = await import(
  "../servers/gateway/dashboard/shared/i18n.js"
);

_setTailscaleReader(() => { throw new Error("no tailscale"); });
_setDiskReader(() => "Avail Size\n500000M 1000000M\n");
_setDockerPortsReader(() => { throw new Error("no docker"); });
_setFirewallReader(() => { throw new Error("no ufw.conf"); });
_setContainerReader(() => false);
_setArtifactNodeReader(async () => null);
_setBundleImageReaders({ installed: () => [] });
_setSystemUpdateReaders({ aptPresent: () => false });

after(() => rmScratch(ROOT));

const mode = (p, m) => chmodSync(p, m);
const NOT_A_REPO = {
  stdout: "",
  stderr: "fatal: not a git repository (or any of the parent directories): .git",
  code: 128,
};

/**
 * A fake checkout, answering the two questions the card asks the way git does:
 * `rev-parse --abbrev-ref HEAD` ("HEAD" when detached) and `status --porcelain`.
 * Every call is recorded, so a test can pin the flags and the timeout.
 */
function fakeGit({ branch = "main", detached = false, edits = "", statusFails = false, failure = null } = {}) {
  const calls = [];
  const git = async (args, options) => {
    calls.push({ args, options });
    if (failure) return failure;
    if (args[0] === "rev-parse") {
      return { stdout: detached ? "HEAD" : branch, stderr: "", code: 0 };
    }
    if (args.includes("status")) {
      return statusFails
        ? { stdout: "", stderr: "fatal: unable to read index", code: 1 }
        : { stdout: edits, stderr: "", code: 0 };
    }
    return { stdout: "", stderr: `unexpected git ${args.join(" ")}`, code: 1 };
  };
  git.calls = calls;
  return git;
}

/** Run the Nest health collection and pick out the Integrity card and issues. */
async function integrity({ git = fakeGit(), stat, appRoot = APP, lang = "en" } = {}) {
  _setIntegrityReaders({ git, stat, appRoot });
  invalidateHealthCache();
  const r = await collectHealthSignals({ execute: async () => ({ rows: [] }) }, { lang, now: () => 1_800_000_000_000 });
  return {
    all: r,
    card: r.details.find((d) => d.id === "integrity"),
    issues: r.issues.filter((i) => i.id === "integrity" || i.id.startsWith("integrity:")),
  };
}

// ─── (a) modes ────────────────────────────────────────────────────────────────

test("owner-only home, data dir and database → ok card, no issue at all", async () => {
  mode(HOME, 0o700); mode(DATA, 0o700); mode(DB, 0o600);
  const { card, issues } = await integrity();
  assert.ok(card, "the Integrity card always exists");
  assert.equal(card.state, "ok");
  assert.deepEqual(issues, [], "nothing to report on a private instance");
});

test("a world-readable database → warn naming the ROLE, never the path", async () => {
  mode(DB, 0o644);
  try {
    const { all, card, issues } = await integrity();
    assert.equal(card.state, "warn");
    assert.equal(all.ok, false, "a warn issue fails the Nest roll-up");
    const issue = issues.find((i) => i.id === "integrity:mode:db");
    assert.ok(issue, "the database file is reported");
    assert.equal(issue.severity, "warn");
    assert.match(issue.label, /readable or writable by other users on this machine/);
    assert.match(issue.label, /database file/, "the role, in plain words");
    assert.ok(!issue.label.includes(DB), "the full path is never shown");
    assert.ok(!issue.label.includes(ROOT), "not even the scratch root");
  } finally {
    mode(DB, 0o600);
  }
});

test("a group-WRITABLE database (0o620) → warn too: another user could rewrite it", async () => {
  mode(DB, 0o620);
  try {
    const { card, issues } = await integrity();
    assert.equal(card.state, "warn", "a writable DB is the worse half of the same fault");
    const issue = issues.find((i) => i.id === "integrity:mode:db");
    assert.ok(issue, "write bits count, not just the read bits (0o044)");
    assert.equal(issue.severity, "warn");
    assert.match(issue.label, /readable or writable by other users on this machine/);
    assert.ok(!issue.label.includes(DB), "still the role, never the path");
  } finally {
    mode(DB, 0o600);
  }
});

test("a world-readable HOME and data dir → one warn per path role", async () => {
  mode(HOME, 0o755); mode(DATA, 0o755);
  try {
    const { card, issues } = await integrity({});
    assert.equal(card.state, "warn");
    const ids = issues.map((i) => i.id);
    assert.ok(ids.includes("integrity:mode:home"));
    assert.ok(ids.includes("integrity:mode:data"));
    assert.ok(!ids.includes("integrity:mode:db"), "an owner-only db is not reported");
  } finally {
    mode(HOME, 0o700); mode(DATA, 0o700);
  }
});

test("a symlinked database is checked through to its target's mode", async () => {
  const target = join(ROOT, "elsewhere.db");
  writeFileSync(target, "db");
  chmodSync(target, 0o644);
  unlinkSync(DB);
  symlinkSync(target, DB);
  try {
    const { issues } = await integrity();
    assert.ok(
      issues.some((i) => i.id === "integrity:mode:db"),
      "boot never chmods through a symlink, so this is exactly what the card is for",
    );
  } finally {
    unlinkSync(DB);
    writeFileSync(DB, "db");
    chmodSync(DB, 0o600);
  }
});

// ─── (b) checkout state ───────────────────────────────────────────────────────

test("a checkout off main → INFO that it is on a branch, not a duplicate warn", async () => {
  const { card, issues } = await integrity({ git: fakeGit({ branch: "feat/integrity-signals" }) });
  assert.equal(card.state, "info", "the Updates card already warns while the updater is on");
  const issue = issues.find((i) => i.id === "integrity:checkout-off-main");
  assert.ok(issue, "the off-main checkout is reported");
  assert.equal(issue.severity, "info", "info never pushes a notification");
  assert.equal(issue.label, "The checkout is on branch feat/integrity-signals, not main");
  assert.ok(!/updates are skipped/i.test(issue.label), "no duplicate of the Updates card");
});

test("a detached HEAD → INFO (and not the off-main issue)", async () => {
  const { card, issues } = await integrity({ git: fakeGit({ detached: true }) });
  assert.equal(card.state, "info");
  const issue = issues.find((i) => i.id === "integrity:checkout-detached");
  assert.ok(issue, "the detached checkout is reported");
  assert.equal(issue.severity, "info");
  assert.equal(issue.label, "The checkout is on a detached HEAD");
  assert.ok(!issues.some((i) => i.id === "integrity:checkout-off-main"));
});

test("the git probes take no index lock and are bounded the way the df probe is", async () => {
  const git = fakeGit({ edits: " M notes.txt\n" });
  await integrity({ git });
  const status = git.calls.find((c) => c.args.includes("status"));
  assert.ok(status, "the card asks for the working tree");
  assert.deepEqual(
    status.args,
    ["--no-optional-locks", "status", "--porcelain", "--untracked-files=no"],
    "--no-optional-locks keeps `git status` from taking index.lock in the live checkout",
  );
  assert.equal(status.options?.timeout, 5000, "a hung git must not hold the Nest render for 120 s");
  const head = git.calls.find((c) => c.args.includes("rev-parse"));
  assert.ok(head, "the branch is read too");
  assert.equal(head.options?.timeout, 5000, "both probes are bounded");
});

test("tracked local edits → info with a count and no file names", async () => {
  const porcelain = " M notes.txt\nM  app.js\n?? scratch.txt\n?? bundle/tmp/\nA  added.md\n";
  const { card, issues } = await integrity({ git: fakeGit({ edits: porcelain }) });
  assert.equal(card.state, "info", "local edits are information, never a warn");
  const issue = issues.find((i) => i.id === "integrity:checkout-edits");
  assert.ok(issue, "the local edits are reported");
  assert.equal(issue.severity, "info");
  assert.match(issue.label, /^3 local changes in the checkout$/, "3 tracked entries; ?? never counts");
  for (const name of ["notes.txt", "app.js", "added.md", "scratch.txt"]) {
    assert.ok(!issue.label.includes(name), `no file names in the issue (${name})`);
  }
  assert.equal(countTrackedChanges(porcelain), 3);
  assert.equal(countTrackedChanges(""), 0);
  assert.equal(countTrackedChanges("?? only-untracked\n"), 0);
});

test("a clean checkout on main → ok, with no part-(b) issue", async () => {
  const { card, issues } = await integrity({ git: fakeGit({ edits: "" }) });
  assert.equal(card.state, "ok");
  assert.deepEqual(issues, []);
});

test("not a git checkout (a container) → no part (b) at all", async () => {
  const { card, issues } = await integrity({ git: async () => NOT_A_REPO });
  assert.equal(card.state, "ok", "no checkout to report on is not a fault");
  assert.deepEqual(issues.filter((i) => i.id.startsWith("integrity:checkout")), []);
  assert.deepEqual(issues, [], "and nothing is called unknown either");
});

test("no <app root>/.git → not a checkout, without asking git at all", async () => {
  let asked = 0;
  const git = async () => { asked += 1; return NOT_A_REPO; };
  // The stderr is deliberately NOT the English "not a git repository": the
  // filesystem decides, so this also holds under a non-English locale.
  const { card, issues } = await integrity({ git, appRoot: NO_CHECKOUT });
  assert.equal(asked, 0, "a directory with no .git needs no git call");
  assert.equal(card.state, "ok");
  assert.deepEqual(issues, []);
});

test("git not installed (spawn ENOENT) → not a checkout, not a permanent 'unknown'", async () => {
  const { card, issues } = await integrity({
    git: async () => ({ stdout: "", stderr: "", code: "ENOENT" }),
  });
  assert.equal(card.state, "ok", "a box without git simply has no checkout to describe");
  assert.deepEqual(issues, [], "and nothing is called unknown");
});

// ─── Degraded: unknown, never ok ─────────────────────────────────────────────

test("git that could not answer → info 'unknown', never ok", async () => {
  const { card, issues } = await integrity({
    git: async () => ({ stdout: "", stderr: "spawn git EACCES", code: 1 }),
  });
  assert.equal(card.state, "info");
  assert.equal(card.value, "unknown");
  assert.notEqual(card.state, "ok");
  const issue = issues.find((i) => i.id === "integrity:check");
  assert.ok(issue, "the check that could not run is named");
  assert.equal(issue.severity, "info", "info issues stay strip-only — never a push");
  assert.match(issue.label, /couldn't check the checkout/);
});

test("a status that fails keeps the branch reading and reports the edits as unknown", async () => {
  const { issues } = await integrity({ git: fakeGit({ statusFails: true }) });
  const check = issues.find((i) => i.id === "integrity:check");
  assert.ok(check);
  assert.match(check.label, /local changes/);
  assert.equal(issues.find((i) => i.id === "integrity:checkout-edits"), undefined);
});

test("an lstat that cannot run → info 'unknown', never ok", async () => {
  const denied = () => { throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" }); };
  const { card, issues } = await integrity({ stat: denied });
  assert.equal(card.state, "info");
  assert.equal(card.value, "unknown");
  const issue = issues.find((i) => i.id === "integrity:check");
  assert.ok(issue);
  assert.match(issue.label, /file permissions/);
});

// ─── i18n ────────────────────────────────────────────────────────────────────

test("i18n: every integrity key has an en and a different es, with the same placeholders", () => {
  const keys = Object.keys(translations).filter((k) => k.startsWith("signals.integrity."));
  assert.ok(keys.length >= 16, `the Integrity card carries its own copy (found ${keys.length})`);
  const ph = (s) => (s.match(/\{[a-zA-Z0-9_]+\}/g) || []).sort().join(",");
  for (const k of keys) {
    for (const lang of SUPPORTED_LANGS) {
      assert.equal(typeof translations[k][lang], "string", `${k} missing ${lang}`);
      assert.ok(translations[k][lang].length > 0, `${k} has empty ${lang}`);
    }
    assert.notEqual(translations[k].es, translations[k].en, `${k} is untranslated (es === en)`);
    assert.equal(ph(translations[k].en), ph(translations[k].es), `${k}: placeholder mismatch`);
  }
});

test("i18n: the Spanish card reads the same way (role sentence, count, off-main)", async () => {
  mode(DB, 0o644);
  try {
    const { card, issues } = await integrity({ git: fakeGit({ branch: "otra-rama", edits: " M x\n" }), lang: "es" });
    assert.equal(card.label, "Integridad");
    const dbIssue = issues.find((i) => i.id === "integrity:mode:db");
    assert.match(dbIssue.label, /legible o modificable por otros usuarios de esta máquina/);
    assert.match(dbIssue.label, /El archivo de la base de datos/);
    assert.match(issues.find((i) => i.id === "integrity:checkout-edits").label, /1 cambios locales/);
    assert.equal(issues.find((i) => i.id === "integrity:checkout-off-main").label, "La copia de trabajo está en la rama otra-rama, no en main");
    assert.equal(fill(translations["signals.integrity.label"].es, {}), "Integridad");
  } finally {
    mode(DB, 0o600);
  }
});