/**
 * mail-dependency-floor — the Crow Mail plan's Task 3 dependency floor.
 *
 * WHY THIS TEST EXISTS: the mail channel is built on three libraries whose
 * behaviour the rest of the plan assumes — `nodemailer` must be at least
 * 10.0.2 (the first release with the ESM entry + transport API the sender
 * relies on), and `imapflow` / `postal-mime` must actually load under the
 * repo's declared Node major (see tests/node-standard.test.js) rather than
 * only being listed in package.json. A dependency that is declared but
 * uninstallable, or installed below the floor while the manifest claims
 * otherwise, must fail here rather than at first send/receive.
 *
 * The version compare is written out instead of importing `semver`: semver is
 * only a transitive dependency, so importing it would make the suite depend on
 * a resolution detail no manifest promises.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

const MAIL_DEPS = ["imapflow", "nodemailer", "postal-mime"];
const NODEMAILER_FLOOR = "10.0.2";

/**
 * Compare two `major.minor.patch` versions numerically.
 * Returns -1, 0 or 1. A prerelease (`10.0.2-rc.1`) sorts BELOW its release,
 * and a missing component counts as 0 (`10.0` === `10.0.0`).
 */
function compareVersions(a, b) {
  const split = (v) => {
    const [core, ...rest] = String(v).trim().split("-");
    const nums = core.split(".").map((n) => {
      const parsed = Number.parseInt(n, 10);
      return Number.isFinite(parsed) ? parsed : 0;
    });
    return { nums, pre: rest.length ? rest.join("-") : null };
  };
  const left = split(a);
  const right = split(b);
  const len = Math.max(left.nums.length, right.nums.length);
  for (let i = 0; i < len; i++) {
    const l = left.nums[i] ?? 0;
    const r = right.nums[i] ?? 0;
    if (l !== r) return l < r ? -1 : 1;
  }
  if (left.pre === right.pre) return 0;
  if (left.pre === null) return 1; // release > prerelease
  if (right.pre === null) return -1;
  return left.pre < right.pre ? -1 : 1;
}

test("compareVersions compares major.minor.patch numerically", () => {
  assert.equal(compareVersions("10.0.2", "10.0.2"), 0);
  assert.equal(compareVersions("10.0", "10.0.0"), 0);
  assert.equal(compareVersions("10.0.1", "10.0.2"), -1);
  assert.equal(compareVersions("10.10.0", "10.9.9"), 1, "10.10.0 must beat 10.9.9 (string compare would not)");
  assert.equal(compareVersions("9.99.99", "10.0.0"), -1);
  assert.equal(compareVersions("10.0.2-rc.1", "10.0.2"), -1, "a prerelease is below its release");
});

const installedNodemailerPath = join(ROOT, "node_modules", "nodemailer", "package.json");

test("the mail dependencies are installed (node_modules is populated)", () => {
  assert.ok(
    existsSync(installedNodemailerPath),
    "node_modules/nodemailer/package.json is missing — run npm install before the suite",
  );
  for (const name of MAIL_DEPS) {
    assert.ok(existsSync(join(ROOT, "node_modules", name, "package.json")), `${name} is not installed`);
  }
});

test(`installed nodemailer is at least ${NODEMAILER_FLOOR}`, () => {
  const installed = JSON.parse(readFileSync(installedNodemailerPath, "utf8"));
  assert.equal(installed.name, "nodemailer", "node_modules/nodemailer holds the wrong package");
  assert.ok(installed.version, "installed nodemailer has no version field");
  assert.ok(
    compareVersions(installed.version, NODEMAILER_FLOOR) >= 0,
    `installed nodemailer ${installed.version} is below the required floor ${NODEMAILER_FLOOR}`,
  );
});

test("imapflow, nodemailer and postal-mime are runtime dependencies, not dev only", () => {
  const deps = pkg.dependencies || {};
  const devDeps = pkg.devDependencies || {};
  for (const name of MAIL_DEPS) {
    assert.ok(deps[name], `${name} must be listed in package.json dependencies`);
    assert.ok(!devDeps[name], `${name} must not be a devDependency (the mail channel ships at runtime)`);
  }
});

test("imapflow imports and exports ImapFlow", async () => {
  const mod = await import("imapflow");
  assert.equal(typeof mod.ImapFlow, "function", "imapflow must export the ImapFlow class");
});

test("nodemailer imports and exports createTransport", async () => {
  const mod = await import("nodemailer");
  assert.equal(typeof mod.createTransport, "function", "nodemailer must export createTransport");
});

test("postal-mime imports and its default export is a class with parse()", async () => {
  const mod = await import("postal-mime");
  const PostalMime = mod.default;
  assert.equal(typeof PostalMime, "function", "postal-mime must have a default export that is a class");
  assert.match(String(PostalMime).slice(0, 200), /\bclass\b/, "postal-mime default export should be a class");
  assert.equal(typeof PostalMime.prototype?.parse, "function", "PostalMime instances must have a parse() method");
});