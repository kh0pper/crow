/**
 * TOOL_MANIFESTS ↔ actual tool surface drift test (W5.5).
 *
 * The manifests power crow_discover, the router category descriptions, and
 * the chat/voice prompt builders. A phantom entry = discovery advertises a
 * tool that errors when called (crow_relay was live for months). A missing
 * entry = a real tool invisible to discovery (the whole W2-5 project-members
 * surface was). Pin key equality AND entry shape for every category whose
 * factory constructs in an isolated env. media (bundle) is
 * environment-dependent by design and skipped.
 *
 * The comparison runs in a CHILD process with an explicit process.exit():
 * importing the sharing server has side effects that leave live handles
 * (sync managers/timers), which would hang the test runner on exit.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = join(import.meta.dirname, "..");

const CHILD_SCRIPT = `
const { TOOL_MANIFESTS } = await import("./servers/gateway/tool-manifests.js");
const specs = [
  ["memory", "./servers/memory/server.js", "createMemoryServer"],
  ["projects", "./servers/research/server.js", "createProjectServer"],
  ["sharing", "./servers/sharing/server.js", "createSharingServer"],
  ["blog", "./servers/blog/server.js", "createBlogServer"],
  ["storage", "./servers/storage/server.js", "createStorageServer"],
  ["consulting", "./servers/consulting/server.js", "createConsultingServer"],
];
const report = {};
for (const [cat, path, fn] of specs) {
  const server = (await import(path))[fn]();
  report[cat] = {
    actual: Object.keys(server._registeredTools).sort(),
    manifest: Object.entries(TOOL_MANIFESTS[cat].tools).map(([name, entry]) => ({
      name,
      shapeOk: typeof entry === "object" && typeof entry.desc === "string" && typeof entry.params === "string",
    })),
  };
}
console.log("REPORT:" + JSON.stringify(report));
process.exit(0);
`;

test("every manifest category matches its server's registered tools exactly", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "manifest-drift-"));
  const env = { ...process.env, CROW_DATA_DIR: dataDir, CROW_DB_PATH: join(dataDir, "t.db") };
  try {
    execFileSync(process.execPath, ["scripts/init-db.js"], { env, stdio: "pipe", cwd: repoRoot });
    const out = execFileSync(
      process.execPath,
      ["--input-type=module", "-e", CHILD_SCRIPT],
      { env, cwd: repoRoot, encoding: "utf8", timeout: 90_000 }
    );
    const line = out.split("\n").find((l) => l.startsWith("REPORT:"));
    assert.ok(line, `child produced no report; output was: ${out.slice(0, 500)}`);
    const report = JSON.parse(line.slice("REPORT:".length));

    for (const [cat, { actual, manifest }] of Object.entries(report)) {
      const manifestNames = manifest.map((m) => m.name).sort();
      assert.deepEqual(manifestNames, actual, `manifest drift in category "${cat}"`);
      for (const m of manifest) {
        assert.ok(m.shapeOk, `${cat}.${m.name} entry must be { params, desc }`);
      }
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
