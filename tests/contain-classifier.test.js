/**
 * A CONTAINED bot's bash "auto" safety classifier.
 *
 * The classifier is a model URL pi-lab fetches on its own, and a contained
 * bot reaches exactly one host port (its own gateway's) and there only the
 * door paths. So the block the bridge hands pi-lab must ride the same
 * /llm/p door the generated models.json uses — a provider row's door, or a
 * /llm/p door the operator named — and anything else is dropped, leaving
 * pi-lab to ask every command in a live chat and refuse it unattended.
 * An UNCONTAINED spawn keeps the raw endpoint (asserted end to end below).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { containedClassifierBlock, CONTAINED_CLASSIFIER_NO_DOOR } from "../scripts/pi-bots/pi_contain_agent.mjs";
import { isDoorPath } from "../servers/shared/bot-doors.js";

// An uncontained spawn, for the unchanged-block case. Set before the bridge is
// imported (lazily, below), like the other spawn tests do.
process.env.CROW_PI_SANDBOX = "off";

const GW = 3001;
const doorOf = (rowId) => `http://127.0.0.1:${GW}/llm/p/${encodeURIComponent(rowId)}/v1`;
const BLOCK = { url: "http://127.0.0.1:18299/v1", model: "qwen3.5-4b", timeout_ms: 6000 };
// A row the provider door forwards for (a bundle row), and one it does not
// (a plain LAN endpoint: doorKindOf calls it "unmanaged", so /llm/p refuses it).
const bundleRow = (o = {}) => ({ id: "crow-voice", baseUrl: "http://127.0.0.1:18299/v1", bundleId: "crow-voice-bundle",
  provider_type: "openai-compat", models: [{ id: "qwen3.5-4b" }], disabled: false, ...o });
const lanRow = (o = {}) => ({ id: "plain-lan", baseUrl: "http://192.168.13.7:8099/v1", bundleId: null, gpuPolicy: null,
  provider_type: "openai-compat", models: [{ id: "qwen3.5-4b" }], disabled: false, ...o });
const sel = (o = {}) => ({ ok: true, providerId: null, model: "qwen3.5-4b", url: BLOCK.url, source: "auto", ...o });
const quiet = { log: () => {} };

test("a contained bot's provider classifier goes through its provider door", () => {
  const out = containedClassifierBlock(BLOCK, sel({ providerId: "crow-voice" }), { gatewayPort: GW, rows: [bundleRow(), lanRow()], ...quiet });
  assert.deepEqual(out, { url: doorOf("crow-voice"), model: "qwen3.5-4b", timeout_ms: 6000 }, "the model stays; only the URL moves");
  // pi folds provider ids to lower case, so the row match is case-insensitive
  // and the door names the row's own id.
  const folded = containedClassifierBlock(BLOCK, sel({ providerId: "CROW-VOICE" }), { gatewayPort: GW, rows: [bundleRow()], ...quiet });
  assert.equal(folded.url, doorOf("crow-voice"));
});

test("an operator door endpoint is rewritten to this gateway's door", () => {
  const block = { ...BLOCK, url: "http://100.64.20.9:3001/llm/p/crow-voice/v1" };
  const out = containedClassifierBlock(block, sel(), { gatewayPort: GW, rows: [], ...quiet });
  assert.deepEqual(out, { url: doorOf("crow-voice"), model: "qwen3.5-4b", timeout_ms: 6000 });
});

test("a non-door endpoint drops the classifier in a contained bot, with the fixed log line", () => {
  const fixed = "[pi-bots] bash=auto: the safety classifier is not reachable from a contained bot (not a provider door), so commands will be asked (live chat) or refused (unattended)";
  assert.equal(CONTAINED_CLASSIFIER_NO_DOOR, fixed);
  const logs = [];
  assert.equal(containedClassifierBlock(BLOCK, sel(), { gatewayPort: GW, rows: [bundleRow()], log: (l) => logs.push(l) }), null);
  assert.deepEqual(logs, [fixed]);
  // Neither is a bare /llm/v1 or a cloud door a provider door: the rewrite
  // never builds a /llm/c URL (the selection already refuses cloud). A door
  // path that would need a percent-escape after the rewrite is refused by the
  // relay itself, so it is dropped here too.
  for (const url of ["http://100.64.20.9:3001/llm/v1", "http://100.64.20.9:3001/llm/c/qwen-cloud/v1", "http://100.64.20.9:3001/llm/p/a%20b/v1"]) {
    const seen = [];
    assert.equal(containedClassifierBlock({ ...BLOCK, url }, sel(), { gatewayPort: GW, rows: [], log: (l) => seen.push(l) }), null, url);
    assert.deepEqual(seen, [fixed], url);
  }
});

test("a row with no provider door drops the classifier", () => {
  const logs = [];
  const log = (l) => logs.push(l);
  assert.equal(containedClassifierBlock(BLOCK, sel({ providerId: "plain-lan" }), { gatewayPort: GW, rows: [lanRow()], log }), null);
  // a provider the rows do not carry (the DB read failed, or the row is gone)
  assert.equal(containedClassifierBlock(BLOCK, sel({ providerId: "gone" }), { gatewayPort: GW, rows: [bundleRow()], log }), null);
  // a door exists but speaks another API than the classifier's chat-completions
  assert.equal(containedClassifierBlock(BLOCK, sel({ providerId: "crow-voice" }), { gatewayPort: GW, rows: [bundleRow({ provider_type: "anthropic" })], log }), null);
  assert.deepEqual(logs, [CONTAINED_CLASSIFIER_NO_DOOR, CONTAINED_CLASSIFIER_NO_DOOR, CONTAINED_CLASSIFIER_NO_DOOR]);
});

test("isDoorPath accepts the classifier URL path", () => {
  const viaRow = containedClassifierBlock(BLOCK, sel({ providerId: "crow-voice" }), { gatewayPort: GW, rows: [bundleRow()], ...quiet });
  assert.equal(isDoorPath(new URL(viaRow.url).pathname), true);
  const viaEndpoint = containedClassifierBlock({ ...BLOCK, url: "http://100.64.20.9:3001/llm/p/crow-voice/v1" }, sel(), { gatewayPort: GW, rows: [], ...quiet });
  assert.equal(isDoorPath(new URL(viaEndpoint.url).pathname), true);
  // the raw provider endpoint is NOT a door: that is why the rewrite exists
  assert.equal(isDoorPath(new URL(BLOCK.url).pathname), false);
});

async function spawnedClassifier(botClassifier) {
  const { PiRpc } = await import("../scripts/pi-bots/bridge.mjs");
  const dir = mkdtempSync(join(tmpdir(), "crow-contain-cls-"));
  mkdirSync(join(dir, "sessions"), { recursive: true });
  const out = join(dir, "policy.json");
  const stub = join(dir, "stub-pi.mjs");
  writeFileSync(stub, [
    'import { writeFileSync } from "node:fs";',
    `writeFileSync(${JSON.stringify(out)}, process.env.PI_BOT_PERMISSION_POLICY || "");`,
    "setTimeout(() => process.exit(0), 20);",
  ].join("\n"));
  const pi = new PiRpc({
    def: { permission_policy: { bash: "auto", write_paths: [] } },
    sessionDir: dir, resolved: { provider: "p", model: "m", key: "p/m" },
    nodeBin: process.execPath, cliPath: stub, botClassifier,
    extraEnv: { PI_BOT_INTERACTIVE: "1" },
  });
  await new Promise((r) => pi.proc.on("exit", r));
  await new Promise((r) => setTimeout(r, 20));
  return JSON.parse(readFileSync(out, "utf8"));
}

test("an uncontained bot's classifier is unchanged", async () => {
  assert.equal(process.env.CROW_PI_SANDBOX, "off");
  // A provider-row classifier (the shape the contain rewrite acts on) stays the
  // raw endpoint when the spawn is not contained — no door, no DB read.
  const policy = await spawnedClassifier(sel({ providerId: "crow-voice" }));
  assert.equal(policy.bash, "auto");
  assert.deepEqual(policy.classifier, { url: BLOCK.url, model: "qwen3.5-4b", timeout_ms: 6000 });
});

test("the bridge applies the rewrite only to a contained spawn", () => {
  // The contained decision is made before the policy env is built, and the
  // helper is reached only inside it (a contained spawn cannot fetch a raw
  // endpoint; an uncontained one must keep it).
  const src = readFileSync(new URL("../scripts/pi-bots/bridge.mjs", import.meta.url), "utf8");
  assert.match(src, /if \(block && containedSpawn\) \{\s*block = containedClassifierBlock\(block, opts\.botClassifier/);
});