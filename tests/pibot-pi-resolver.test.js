/**
 * pi engine resolution ladder — the bridge must find the pi CLI without
 * assuming the maintainer's nvm layout, and must resolve node from the
 * running process, not a hardcoded version path.
 *
 * Ladder (first hit wins):
 *   1. PIBOT_PI_CLI env (explicit operator override — trusted verbatim)
 *   2. <CROW_HOME>/bundles/bot-engine/node_modules/@earendil-works/pi-coding-agent/dist/cli.js
 *      (the future bot-engine extension payload)
 *   3. <repo>/node_modules/@earendil-works/pi-coding-agent/dist/cli.js
 *      (pi as a declared dependency, if that packaging is ever chosen)
 *   4. <dirname(execPath)>/../lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js
 *      (global npm root of the RUNNING node — covers nvm, /usr/local, and /usr layouts)
 *   5. null → callers surface an honest "bot engine not installed" error.
 */
import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

const PI_REL = "node_modules/@earendil-works/pi-coding-agent/dist/cli.js";

function scratchWith(relPath) {
  const root = mkdtempSync(join(tmpdir(), "pi-resolve-"));
  if (relPath) {
    const p = join(root, relPath);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, "// stub cli\n");
    return { root, cli: p };
  }
  return { root, cli: null };
}

const { resolvePiCli, resolveNodeBin } = await import("../scripts/pi-bots/pi_resolver.mjs");

test("env override PIBOT_PI_CLI wins verbatim, even if the file is absent", () => {
  const out = resolvePiCli({
    env: { PIBOT_PI_CLI: "/explicit/operator/path/cli.js" },
    crowHome: "/nonexistent-a",
    repoRoot: "/nonexistent-b",
    execPath: "/nonexistent-c/bin/node",
  });
  assert.deepStrictEqual(out, { cliPath: "/explicit/operator/path/cli.js", source: "env" });
});

test("bot-engine bundle payload under CROW_HOME is found", () => {
  const { root, cli } = scratchWith(join("bundles", "bot-engine", PI_REL));
  const out = resolvePiCli({ env: {}, crowHome: root, repoRoot: "/nonexistent-b", execPath: "/nonexistent-c/bin/node" });
  assert.deepStrictEqual(out, { cliPath: cli, source: "bundle" });
});

test("repo node_modules dependency is found when no bundle exists", () => {
  const { root, cli } = scratchWith(PI_REL);
  const out = resolvePiCli({ env: {}, crowHome: "/nonexistent-a", repoRoot: root, execPath: "/nonexistent-c/bin/node" });
  assert.deepStrictEqual(out, { cliPath: cli, source: "repo" });
});

test("global npm root of the running node is found (nvm/apt/usr-local layouts)", () => {
  // Simulate <prefix>/bin/node + <prefix>/lib/node_modules/... (the invariant
  // shared by nvm, /usr/local, and Debian's /usr node).
  const { root } = scratchWith(null);
  const cli = join(root, "lib", PI_REL);
  mkdirSync(dirname(cli), { recursive: true });
  writeFileSync(cli, "// stub cli\n");
  const execPath = join(root, "bin", "node");
  const out = resolvePiCli({ env: {}, crowHome: "/nonexistent-a", repoRoot: "/nonexistent-b", execPath });
  assert.deepStrictEqual(out, { cliPath: cli, source: "global" });
});

test("nothing found → null (callers must surface an honest missing-engine error)", () => {
  const out = resolvePiCli({ env: {}, crowHome: "/nonexistent-a", repoRoot: "/nonexistent-b", execPath: "/nonexistent-c/bin/node" });
  assert.strictEqual(out, null);
});

test("resolveNodeBin is the running node, never a hardcoded version path", () => {
  assert.strictEqual(resolveNodeBin(), process.execPath);
});

test("requirePiCli throws the honest missing-engine message when nothing resolves", async () => {
  const { requirePiCli } = await import("../scripts/pi-bots/pi_resolver.mjs");
  assert.throws(
    () => requirePiCli({ env: {}, crowHome: "/nonexistent-a", repoRoot: "/nonexistent-b", execPath: "/nonexistent-c/bin/node" }),
    (e) => {
      assert.match(e.message, /bot engine \(pi\) is not installed/);
      assert.match(e.message, /bot-engine extension/);
      assert.match(e.message, /PIBOT_PI_CLI/);
      return true;
    }
  );
  // And passes through a successful resolution unchanged.
  const { root, cli } = scratchWith(join("bundles", "bot-engine", PI_REL));
  const ok = requirePiCli({ env: {}, crowHome: root, repoRoot: "/nonexistent-b", execPath: "/nonexistent-c/bin/node" });
  assert.deepStrictEqual(ok, { cliPath: cli, source: "bundle" });
});
