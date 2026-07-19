/**
 * bundle-inference-contract — Task 16 (G-6 anti-rot contract, PR G-E part 2).
 *
 * Adds three contract rules to scripts/lib/bundle-contract.mjs, closing the
 * gap Task 15 could only fix by hand-auditing once:
 *
 *   1. `inference: true` requires a non-empty `providers[]` array (a manifest
 *      that claims to be an inference endpoint but ships no way to reach it
 *      is the exact "installed but inert" bug Task 15 fixed by hand).
 *   2. `no_auto_provider`, when present at all, must be a real non-empty
 *      reason string — an empty stub defeats the purpose of the field.
 *   3. A manifest declaring NEITHER flag, whose compose file exposes a port
 *      and runs something that smells like an OpenAI-compat inference
 *      server (--served-model-name / llama-server / vllm / ollama), gets a
 *      WARN — heuristics don't hard-gate the build, they just flag drift.
 *
 * Plus a fourth, unrelated-but-adjacent rule added in the same task: a
 * generalized instance-identity leak scan (the #217 leak class, generalized
 * beyond the one hardcoded string Task 15 grepped for by hand) — no manifest
 * string value anywhere may contain a Tailscale-range IP or a *.ts.net
 * hostname, and no "host" field may carry a pinned 32-hex instance id.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateManifest } from "../scripts/lib/bundle-contract.mjs";
import { buildRegistry } from "../scripts/build-registry.mjs";

/** Make a throwaway bundle dir <root>/<id> with optional files {relpath: content}. */
function tmpBundle(id, files = {}) {
  const root = mkdtempSync(join(tmpdir(), "crowbundle-inf-"));
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const p = join(dir, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, content);
  }
  return dir;
}

const BASE = { id: "demo", name: "Demo", description: "d", type: "bundle", category: "misc" };

const ONE_PROVIDER = [
  {
    id: "demo-provider",
    baseUrlTemplate: "http://{host_ip}:{port}/v1",
    apiKey: "none",
    description: "test",
    models: [{ id: "demo-model", warm: true }],
  },
];

// --- 1. inference: true requires providers[] ---

test("inference: true with no providers field fails", () => {
  const dir = tmpBundle("demo");
  const r = validateManifest({ ...BASE, inference: true }, dir);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("inference: true requires a non-empty providers[]")));
});

test("inference: true with an empty providers[] array fails", () => {
  const dir = tmpBundle("demo");
  const r = validateManifest({ ...BASE, inference: true, providers: [] }, dir);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("inference: true requires a non-empty providers[]")));
});

test("inference: true with a non-empty providers[] array passes", () => {
  const dir = tmpBundle("demo");
  const r = validateManifest({ ...BASE, inference: true, providers: ONE_PROVIDER }, dir);
  assert.equal(r.ok, true, r.errors.join("; "));
});

test("providers[] without inference: true is not itself an error (e.g. future opt-out)", () => {
  const dir = tmpBundle("demo");
  const r = validateManifest({ ...BASE, providers: ONE_PROVIDER }, dir);
  assert.equal(r.ok, true, r.errors.join("; "));
});

// --- 2. no_auto_provider must be a non-empty string when present ---

test("no_auto_provider: empty string fails", () => {
  const dir = tmpBundle("demo");
  const r = validateManifest({ ...BASE, no_auto_provider: "" }, dir);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("no_auto_provider must be a non-empty string")));
});

test("no_auto_provider: whitespace-only string fails", () => {
  const dir = tmpBundle("demo");
  const r = validateManifest({ ...BASE, no_auto_provider: "   " }, dir);
  assert.equal(r.ok, false);
});

test("no_auto_provider: non-string value fails", () => {
  const dir = tmpBundle("demo");
  const r = validateManifest({ ...BASE, no_auto_provider: true }, dir);
  assert.equal(r.ok, false);
});

test("no_auto_provider: real reason string passes", () => {
  const dir = tmpBundle("demo");
  const r = validateManifest({ ...BASE, no_auto_provider: "Model unknowable at install-time." }, dir);
  assert.equal(r.ok, true, r.errors.join("; "));
});

test("clean manifest (no inference, no providers, no no_auto_provider, no docker) passes", () => {
  const dir = tmpBundle("demo");
  const r = validateManifest({ ...BASE }, dir);
  assert.equal(r.ok, true, r.errors.join("; "));
  assert.deepEqual(r.warnings, []);
});

// --- 3. heuristic WARN: neither flag present + compose looks like an
//        OpenAI-compat inference server. Never fails the build. ---

const INFERENCE_LOOKING_COMPOSE = `services:
  demo:
    image: ghcr.io/ggml-org/llama.cpp:server
    ports:
      - "127.0.0.1:8099:8000"
    entrypoint: ["llama-server"]
    command:
      - -m
      - /models/demo.gguf
      - --port
      - "8000"
`;

test("WARN: compose exposes a port + llama-server, manifest has neither inference nor no_auto_provider", () => {
  const dir = tmpBundle("demo", { "docker-compose.yml": INFERENCE_LOOKING_COMPOSE });
  const r = validateManifest({ ...BASE, docker: { composefile: "docker-compose.yml" } }, dir);
  assert.equal(r.ok, true, "heuristic must warn, not fail: " + r.errors.join("; "));
  assert.equal(r.errors.length, 0);
  assert.ok(r.warnings.length >= 1, "expected a WARN for the inference-looking compose");
  assert.ok(r.warnings.some((w) => w.includes("OpenAI-compat")));
});

test("no WARN when inference: true + providers[] already present", () => {
  const dir = tmpBundle("demo", { "docker-compose.yml": INFERENCE_LOOKING_COMPOSE });
  const m = { ...BASE, inference: true, providers: ONE_PROVIDER, docker: { composefile: "docker-compose.yml" } };
  const r = validateManifest(m, dir);
  assert.equal(r.ok, true, r.errors.join("; "));
  assert.deepEqual(r.warnings, []);
});

test("no WARN when no_auto_provider carries a real reason (side-channel bundle)", () => {
  const dir = tmpBundle("demo", { "docker-compose.yml": INFERENCE_LOOKING_COMPOSE });
  const m = { ...BASE, no_auto_provider: "Dynamic model, unknowable at install-time.", docker: { composefile: "docker-compose.yml" } };
  const r = validateManifest(m, dir);
  assert.equal(r.ok, true, r.errors.join("; "));
  assert.deepEqual(r.warnings, []);
});

test("no WARN for an ordinary compose with a port but no inference-server command marker", () => {
  const ordinary = `services:\n  demo:\n    image: nginx\n    ports:\n      - "8080:80"\n`;
  const dir = tmpBundle("demo", { "docker-compose.yml": ordinary });
  const r = validateManifest({ ...BASE, docker: { composefile: "docker-compose.yml" } }, dir);
  assert.equal(r.ok, true);
  assert.deepEqual(r.warnings, []);
});

test("no WARN for a compose with an inference marker but no exposed port", () => {
  const noPort = `services:\n  demo:\n    image: ghcr.io/ggml-org/llama.cpp:server\n    entrypoint: ["llama-server"]\n    command: ["-m", "/models/demo.gguf"]\n`;
  const dir = tmpBundle("demo", { "docker-compose.yml": noPort });
  const r = validateManifest({ ...BASE, docker: { composefile: "docker-compose.yml" } }, dir);
  assert.equal(r.ok, true);
  assert.deepEqual(r.warnings, []);
});

// --- 4. generalized instance-identity leak scan ---

test("leak: tailnet IP nested inside an env_vars default fails", () => {
  const dir = tmpBundle("demo");
  const m = {
    ...BASE,
    env_vars: [{ name: "SOME_URL", description: "d", default: "http://100.118.41.122:8003/v1" }],
  };
  const r = validateManifest(m, dir);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("leaked Tailscale-range IP")), r.errors.join("; "));
});

test("leak: *.ts.net hostname anywhere in a manifest string fails", () => {
  const dir = tmpBundle("demo");
  const m = { ...BASE, notes: "See https://crow.dachshund-chromatic.ts.net:8444/ for the dashboard." };
  const r = validateManifest(m, dir);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("leaked *.ts.net hostname")), r.errors.join("; "));
});

test("leak: 32-hex instance-id-shaped value in a host field fails", () => {
  const dir = tmpBundle("demo");
  const m = { ...BASE, host: "49cf71ca878643ba7717f344329266fd" };
  const r = validateManifest(m, dir);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("leaked instance-id-shaped value")), r.errors.join("; "));
});

test("leak: a 32-hex string in a field NOT named 'host' is not flagged by the hex rule", () => {
  const dir = tmpBundle("demo");
  const m = { ...BASE, notes: "checksum abcdef0123456789abcdef0123456789" };
  const r = validateManifest(m, dir);
  assert.equal(r.ok, true, r.errors.join("; "));
});

test("leak: host: 'local' and host: 'cloud' are allowed", () => {
  const dir = tmpBundle("demo");
  assert.equal(validateManifest({ ...BASE, host: "local" }, dir).ok, true);
  assert.equal(validateManifest({ ...BASE, host: "cloud" }, dir).ok, true);
});

test("leak: loopback URLs (127.0.0.1 / localhost) are allowed", () => {
  const dir = tmpBundle("demo");
  const m = {
    ...BASE,
    env_vars: [
      { name: "A", description: "d", default: "http://127.0.0.1:8003/v1" },
      { name: "B", description: "d", default: "http://localhost:11434" },
    ],
  };
  const r = validateManifest(m, dir);
  assert.equal(r.ok, true, r.errors.join("; "));
});

test("leak scan is recursive: catches a tailnet IP nested inside providers[].models[]", () => {
  const dir = tmpBundle("demo");
  const m = {
    ...BASE,
    inference: true,
    providers: [
      {
        id: "p",
        baseUrlTemplate: "http://{host_ip}:{port}/v1",
        description: "d",
        models: [{ id: "m", notes: "warmed from 100.90.1.2 during migration" }],
      },
    ],
  };
  const r = validateManifest(m, dir);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("leaked Tailscale-range IP")), r.errors.join("; "));
});

test("malformed manifest (null) does not throw when the leak scan runs", () => {
  const dir = tmpBundle("demo");
  const r = validateManifest(null, dir);
  assert.equal(r.ok, false);
  assert.ok(Array.isArray(r.errors) && r.errors.length > 0);
});

// --- Integration: the real bundles/ tree passes the FULL contract,
//     proving Task 15's providers/no_auto_provider fields + Task 16's
//     inference:true stamps are internally consistent and capstone-tracker's
//     leaked IP default is actually fixed. ---

test("all tracked real bundle manifests pass the full contract (inference + no_auto_provider + leak scan)", () => {
  const { audit } = buildRegistry();
  const invalid = audit.filter((a) => a.status === "invalid");
  assert.equal(invalid.length, 0, "invalid manifests: " + invalid.map((a) => `${a.id} [${a.errors.join(", ")}]`).join(" | "));
});

test("capstone-tracker no longer carries the leaked OCR_VISION_URL default IP", () => {
  const { audit } = buildRegistry();
  const entry = audit.find((a) => a.id === "capstone-tracker");
  assert.ok(entry, "capstone-tracker must still be a bundle in the tree");
  assert.equal(entry.ok, true, "capstone-tracker must pass the contract: " + entry.errors.join("; "));
});

test("every real inference bundle (providers[] present) is stamped inference: true", () => {
  const { registry } = buildRegistry();
  for (const entry of registry["add-ons"]) {
    if (Array.isArray(entry.providers) && entry.providers.length > 0) {
      assert.equal(entry.inference, true, `${entry.id} has providers[] but is not stamped inference: true`);
    }
  }
});
