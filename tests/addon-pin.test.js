/**
 * Version pinning for an add-on whose launcher fetches its own code
 * (scripts/addon-sandbox/pin.mjs): one exact version per install, resolved by
 * an injected resolver, and the install-time gate that keeps a host with the
 * walls off byte-for-byte as it was.
 *
 * No npm, no PyPI, no network: both resolvers are fakes that record their calls.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { pinEntryIfWalled, pinLauncherArgs, PinRefused } from "../scripts/addon-sandbox/pin.mjs";

const INTEGRITY = "sha512-" + "A".repeat(64) + "==";
const GIT_SHA = "0".repeat(39) + "1";

/** A fake npm resolver that answers one version and records what it was asked. */
function fakeNpm(answer = { version: "1.2.3", integrity: INTEGRITY }) {
  const calls = [];
  return {
    calls,
    npmView: async (spec) => {
      calls.push(spec);
      return typeof answer === "function" ? answer(spec) : answer;
    },
  };
}

/** A fake PyPI resolver. */
function fakePypi(version = "0.4.1") {
  const calls = [];
  return {
    calls,
    pypiVersion: async (name) => {
      calls.push(name);
      return typeof version === "function" ? version(name) : version;
    },
  };
}

// ---- npx ------------------------------------------------------------------

test("an unpinned npx package becomes one exact version, with npm's integrity", async () => {
  const npm = fakeNpm({ version: "1.2.3", integrity: INTEGRITY });
  const out = await pinLauncherArgs({ command: "npx", args: ["-y", "@scope/pkg"] }, { npmView: npm.npmView });
  assert.equal(out.pinned, true);
  assert.deepEqual(out.entry.args, ["-y", "@scope/pkg@1.2.3"]);
  assert.equal(out.entry.npx_integrity, INTEGRITY);
  assert.equal(out.entry.command, "npx", "the launcher is left as it was");
  assert.deepEqual(npm.calls, ["@scope/pkg"], "the scope is not a version");

  const bare = fakeNpm();
  const plain = await pinLauncherArgs({ command: "/usr/local/bin/npx", args: ["pkg"] }, { npmView: bare.npmView });
  assert.deepEqual(plain.entry.args, ["pkg@1.2.3"], "the launcher is decided by its program name");
  assert.deepEqual(bare.calls, ["pkg"]);
});

test("an npx arg that already names one version is left alone, with no lookup", async () => {
  const npm = fakeNpm();
  const entry = { command: "npx", args: ["-y", "pkg@1.2.3"] };
  const out = await pinLauncherArgs(entry, { npmView: npm.npmView });
  assert.deepEqual(out.entry.args, ["-y", "pkg@1.2.3"]);
  assert.deepEqual(npm.calls, [], "no resolver runs for a version that is already exact");
  assert.equal("npx_integrity" in out.entry, false);
});

test("an npx range is resolved through npm, which is asked for the range", async () => {
  const npm = fakeNpm({ version: "2.0.0", integrity: INTEGRITY });
  const out = await pinLauncherArgs({ command: "npx", args: ["pkg@^1"] }, { npmView: npm.npmView });
  assert.deepEqual(out.entry.args, ["pkg@2.0.0"]);
  assert.deepEqual(npm.calls, ["pkg@^1"]);
});

test("an npm answer that is not one exact version and a sha512 is refused", async () => {
  for (const answer of [
    { version: "^1.2.3", integrity: INTEGRITY },
    { version: "1.2.3", integrity: "sha1-deadbeef" },
    { version: "1.2.3" },
    { integrity: INTEGRITY },
    null,
  ]) {
    await assert.rejects(
      pinLauncherArgs({ command: "npx", args: ["pkg"] }, { npmView: async () => answer }),
      (err) => err instanceof PinRefused && err.name === "PinRefused",
      JSON.stringify(answer),
    );
  }
});

// ---- uvx ------------------------------------------------------------------

test("a bare uvx tool becomes one exact version from the package index", async () => {
  const pypi = fakePypi("0.4.1");
  const out = await pinLauncherArgs({ command: "uvx", args: ["tool"] }, { pypiVersion: pypi.pypiVersion });
  assert.deepEqual(out.entry.args, ["tool==0.4.1"]);
  assert.deepEqual(pypi.calls, ["tool"]);
  assert.equal(out.entry.npx_integrity, undefined, "an integrity is an npm thing");
});

test("a uvx --from ref must name one full commit at once", async () => {
  const ref = `git+https://example.invalid/r@${GIT_SHA}`;
  const npm = fakeNpm();
  const pypi = fakePypi();
  const pinned = await pinLauncherArgs(
    { command: "uvx", args: ["--from", ref, "tool"] },
    { npmView: npm.npmView, pypiVersion: pypi.pypiVersion },
  );
  assert.deepEqual(pinned.entry.args, ["--from", ref, "tool"], "an exact ref is already pinned");
  assert.deepEqual([...npm.calls, ...pypi.calls], [], "nothing is looked up");

  for (const bad of [
    `git+https://example.invalid/r@main`,
    `git+https://example.invalid/r`,
    "--from tool",
  ]) {
    const args = bad.startsWith("--from ") ? bad.split(" ") : ["--from", bad, "tool"];
    await assert.rejects(
      pinLauncherArgs({ command: "uvx", args }, { pypiVersion: pypi.pypiVersion }),
      (err) => err instanceof PinRefused && /full commit or name==version/.test(err.message),
      bad,
    );
  }
});

test("a uvx --from=<name>==<version> is already pinned, and a bad shape is refused", async () => {
  const pypi = fakePypi();
  const ok = await pinLauncherArgs({ command: "uvx", args: ["--from=tool==1.0"] }, { pypiVersion: pypi.pypiVersion });
  assert.deepEqual(ok.entry.args, ["--from=tool==1.0"]);
  assert.deepEqual(pypi.calls, []);

  await assert.rejects(
    pinLauncherArgs({ command: "uvx", args: ["--from=tool>=1"] }, { pypiVersion: pypi.pypiVersion }),
    PinRefused,
  );
});

test("a bare uvx tool whose index answer is not one version is refused", async () => {
  for (const version of ["^0.4", "", null, "latest"]) {
    await assert.rejects(
      pinLauncherArgs({ command: "uvx", args: ["tool"] }, { pypiVersion: async () => version }),
      PinRefused,
      JSON.stringify(version),
    );
  }
});

// ---- everything else ------------------------------------------------------

test("an entry that is not npx or uvx is left alone, and nothing is ever mutated", async () => {
  const npm = fakeNpm();
  const pypi = fakePypi();
  const node = { command: "node", args: ["server/index.js"], env: { A: "1" } };
  const out = await pinLauncherArgs(node, { npmView: npm.npmView, pypiVersion: pypi.pypiVersion });
  assert.equal(out.pinned, false);
  assert.deepEqual(out.entry, node);
  assert.deepEqual([...npm.calls, ...pypi.calls], []);

  const npxEntry = { command: "npx", args: ["-y", "pkg"], env: { A: "1" }, ownerSet: ["A"] };
  const snapshot = JSON.stringify(npxEntry);
  const pinned = await pinLauncherArgs(npxEntry, { npmView: npm.npmView });
  assert.deepEqual(pinned.entry.args, ["-y", "pkg@1.2.3"]);
  assert.equal(JSON.stringify(npxEntry), snapshot, "the input entry is untouched");
  assert.notEqual(pinned.entry.args, npxEntry.args, "and its args array is a copy");
});

// ---- the install gate -----------------------------------------------------

test("with the walls off the entry is written exactly as built and no resolver runs", async () => {
  const entry = { command: "npx", args: ["-y", "pkg"], ownerSet: [] };
  let pinCalls = 0;
  const pin = async () => { pinCalls += 1; return { entry: { command: "npx", args: ["pkg@9.9.9"] }, pinned: true }; };

  const out = await pinEntryIfWalled(entry, { env: {}, pin });
  assert.equal(out, entry, "the very same entry");
  assert.equal(pinCalls, 0, "no resolver runs with the per-host default unset");

  const off = await pinEntryIfWalled(entry, { env: { CROW_ADDON_WALLS_DEFAULT: "off" }, pin });
  assert.equal(off, entry);
  const killed = await pinEntryIfWalled(entry, { env: { CROW_ADDON_WALLS_DEFAULT: "walled", CROW_ADDON_WALLS: "off" }, pin });
  assert.equal(killed, entry, "the kill switch wins");
  assert.equal(pinCalls, 0);
});

test("with the walls on the entry is pinned, and a refusal reaches the caller", async () => {
  const env = { CROW_ADDON_WALLS_DEFAULT: "walled" };
  const entry = { command: "npx", args: ["-y", "pkg"], ownerSet: [] };
  let seen = null;
  const out = await pinEntryIfWalled(entry, { env, pin: async (e) => { seen = e; return { entry: { ...e, args: ["-y", "pkg@1.2.3"] }, pinned: true }; } });
  assert.equal(seen, entry, "the built entry is what gets pinned");
  assert.deepEqual(out.args, ["-y", "pkg@1.2.3"]);

  await assert.rejects(
    pinEntryIfWalled(entry, { env, pin: async () => { throw new PinRefused("pin --from to a full commit or name==version"); } }),
    (err) => err instanceof PinRefused,
    "the refusal is the caller's to fail the install with",
  );
});