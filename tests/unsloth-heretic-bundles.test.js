/**
 * Store entries for Unsloth (ROCm Studio) and Heretic (optional, AGPL, separate container).
 *
 * Pins the facts the manifests rest on, so a later edit cannot quietly undo them:
 *   - Unsloth's plain `unsloth/unsloth` image is CUDA-only; the store entry must use the
 *     ROCm build (`unsloth/unsloth-rocm`), pinned to a release tag AND a digest, and only
 *     ever offer itself to AMD ROCm hosts (the install refuses it on a CUDA box).
 *   - The `-studio` tag carries Unsloth Studio, which is AGPL-3.0: the manifest and the
 *     consent text must say so, and JupyterLab's public Cloudflare tunnel stays off.
 *   - Heretic is AGPL-3.0 and removes a model's safety refusals. It runs as its own
 *     container built from the unmodified PyPI release (never vendored, never linked into
 *     Crow), installs only behind explicit consent that says what it does, and stays a
 *     draft until a real build has been smoke-tested.
 * The generic gates (bundle contract, compose install check, form friction, ports,
 * registry drift) already cover every tracked bundle; this file adds the specifics.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { _validateComposeFileForTest as validate } from "../servers/gateway/routes/bundles.js";
import { checkGpuArchCompatible } from "../servers/gateway/gpu-arch.js";
import { validateManifest } from "../scripts/lib/bundle-contract.mjs";
import { parseComposeHostPorts } from "../servers/gateway/port-inventory.js";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const dir = (id) => join(REPO, "bundles", id);
const manifest = (id) => JSON.parse(readFileSync(join(dir(id), "manifest.json"), "utf8"));
const compose = (id) => readFileSync(join(dir(id), "docker-compose.yml"), "utf8");
const registry = () => JSON.parse(readFileSync(join(REPO, "registry", "add-ons.json"), "utf8"))["add-ons"];
const DIGEST = /@sha256:[0-9a-f]{64}\b/;

// ---- Unsloth --------------------------------------------------------------------------

test("unsloth: uses the ROCm image, pinned to a release tag and a digest (never the CUDA-only unsloth/unsloth)", () => {
  const c = compose("unsloth");
  const images = [...c.matchAll(/^\s*image:\s*["']?([^\s"']+)/gm)].map((m) => m[1]);
  assert.equal(images.length, 1, "one service, one image");
  const [img] = images;
  assert.match(img, /^unsloth\/unsloth-rocm:v\d+\.\d+\.\d+(?:-beta)?-studio@sha256:[0-9a-f]{64}$/, `pinned ROCm studio image, got ${img}`);
  assert.doesNotMatch(c, /image:\s*["']?unsloth\/unsloth[:@\s]/, "the CUDA-only image must never be referenced");
  assert.doesNotMatch(img, /:(latest|studio|nightly)\b/, "a moving tag is not a pin");
});

test("unsloth: offered to AMD ROCm hosts only (refused on CUDA and CPU-only hosts)", () => {
  const m = manifest("unsloth");
  assert.equal(m.requires.gpu, true);
  assert.deepEqual(m.requires.gpu_arch, ["rocm"]);
  assert.equal(m.requires.min_vram_gb, undefined, "no VRAM floor: an APU's carve-out is not its usable memory");
  assert.equal(checkGpuArchCompatible(m, ["gfx1151", "rocm", "cpu"], null).ok, true, "Strix Halo");
  assert.equal(checkGpuArchCompatible(m, ["sm_86", "cuda", "cpu"], null).ok, false, "NVIDIA host");
  assert.equal(checkGpuArchCompatible(m, ["cpu"], null).ok, false, "no GPU");
});

test("unsloth: reaches the AMD GPU through device nodes only, with no privilege, host IPC or per-host group ids", () => {
  const c = compose("unsloth");
  assert.match(c, /^\s*-\s+\/dev\/kfd\s*$/m);
  assert.match(c, /^\s*-\s+\/dev\/dri\s*$/m);
  assert.doesNotMatch(c, /^\s*(privileged|ipc|network_mode|pid|group_add|cap_add)\s*:/m);
  assert.doesNotMatch(c, /driver:\s*nvidia|NVIDIA_VISIBLE_DEVICES/, "no NVIDIA runtime");
  assert.match(c, /^\s*shm_size:/m, "PyTorch workers get shared memory without host IPC");
});

test("unsloth: compose passes the install security check without privileged consent", () => {
  const m = manifest("unsloth");
  const r = validate(join(dir("unsloth"), "docker-compose.yml"), "unsloth", { manifest: { ...m, privileged: false }, consentVerified: true });
  assert.equal(r.valid, true, r.reason);
  assert.notEqual(m.privileged, true);
});

test("unsloth: Studio and JupyterLab publish on loopback only, on the ports the manifest declares", () => {
  const m = manifest("unsloth");
  const c = compose("unsloth");
  const ports = parseComposeHostPorts(c);
  const hostPorts = ports.map((p) => Number(p.port ?? p.hostPort ?? p)).filter(Number.isFinite).sort((a, b) => a - b);
  assert.deepEqual(hostPorts, [3075, 3076]);
  assert.deepEqual(m.ports, [3075, 3076]);
  for (const line of c.split("\n").filter((l) => /:\d+:\d+/.test(l))) assert.match(line, /127\.0\.0\.1:/, `loopback only: ${line.trim()}`);
  // Studio's SPA loads root-absolute /assets and /api paths, so the gateway's /proxy/<id>/
  // subpath proxy would break it: direct mode (Tailscale Serve HTTPS on the same port).
  assert.deepEqual(m.webUI, { port: 3075, path: "/", label: "Unsloth Studio", proxyMode: "direct" });
  assert.match(c, /"127\.0\.0\.1:3075:8000"/);
  assert.match(c, /"127\.0\.0\.1:3076:8888"/);
});

test("unsloth: JupyterLab's public Cloudflare tunnel and remote SSH stay off", () => {
  const c = compose("unsloth");
  assert.match(c, /UNSLOTH_JUPYTER_CLOUDFLARE[=:]\s*["']?0["']?/, "tunnel pinned off");
  assert.doesNotMatch(c, /\b(PUBLIC_KEY|SSH_KEY)\b/, "no sshd key: the image's sshd program stays down");
});

test("unsloth: both web logins are generated, kept in the keychain and consumed by the compose file", () => {
  const m = manifest("unsloth");
  const c = compose("unsloth");
  for (const name of ["UNSLOTH_STUDIO_PASSWORD", "UNSLOTH_JUPYTER_PASSWORD"]) {
    const v = m.env_vars.find((e) => e.name === name);
    assert.ok(v, `${name} declared`);
    assert.equal(v.generate, "secret");
    assert.equal(v.keychain, true);
    assert.equal(v.secret, true);
    assert.match(c, new RegExp(`\\$\\{${name}:\\?`), `${name} is a hard-fail interpolation in compose`);
  }
  assert.match(c, /JUPYTER_PASSWORD=\$\{UNSLOTH_JUPYTER_PASSWORD:\?/, "the image reads JUPYTER_PASSWORD");
  const studio = m.env_vars.find((e) => e.name === "UNSLOTH_STUDIO_PASSWORD");
  assert.equal(studio.keychain_username, "unsloth", "Studio's admin user is named unsloth");
});

test("unsloth: healthcheck uses Studio's own /api/health; data lives in named volumes", () => {
  const c = compose("unsloth");
  assert.match(c, /healthcheck:[\s\S]*\/api\/health/);
  for (const t of ["/opt/unsloth-studio", "/workspace", "/workspace/.cache/huggingface"]) {
    assert.match(c, new RegExp(`^\\s*-\\s+[a-z0-9-]+:${t.replace(/[/.]/g, "\\$&")}\\s*$`, "m"), `named volume on ${t}`);
  }
});

test("unsloth: licence and consent text are honest about AGPL Studio, the GPU and the download", () => {
  const m = manifest("unsloth");
  assert.equal(m.license, "Apache-2.0 AND AGPL-3.0-only");
  assert.equal(m.consent_required, true);
  for (const lang of ["en", "es"]) {
    const msg = m.install_consent_messages?.[lang] || "";
    assert.match(msg, /AGPL/, `${lang}: names AGPL`);
    assert.match(msg, /GPU/, `${lang}: names the GPU`);
    assert.match(msg, /GB/, `${lang}: names the download size`);
  }
  assert.match(m.notes, /AGPL/);
  assert.match(m.notes, /CUDA/, "says the plain image is CUDA-only");
  assert.equal(typeof m.no_auto_provider, "string");
});

test("unsloth: listed in the store as official, not featured, in no starter collection", () => {
  const entry = registry().find((a) => a.id === "unsloth");
  assert.ok(entry, "in registry/add-ons.json");
  assert.equal(entry.official, true);
  assert.notEqual(entry.featured, true);
  const collections = JSON.parse(readFileSync(join(REPO, "registry", "collections.json"), "utf8"));
  const all = (collections.collections || collections).flatMap((c) => (c.members || []).map((x) => x.id));
  assert.equal(all.includes("unsloth"), false);
});

// ---- Heretic --------------------------------------------------------------------------

test("heretic: a draft (not in the store) until a real build has been smoke-tested", () => {
  const m = manifest("heretic");
  assert.equal(m.draft, true);
  assert.equal(registry().some((a) => a.id === "heretic"), false);
  assert.equal(validateManifest(m, dir("heretic")).ok, true);
});

test("heretic: built from the unmodified PyPI release on a digest-pinned ROCm base; no Heretic source in the repo", () => {
  const df = readFileSync(join(dir("heretic"), "Dockerfile"), "utf8");
  assert.match(df, /^FROM unsloth\/unsloth-rocm:v\d+\.\d+\.\d+(?:-beta)?@sha256:[0-9a-f]{64}\s*$/m, "ROCm torch base, pinned");
  const ver = df.match(/^ARG HERETIC_VERSION=(\d+\.\d+\.\d+)\s*$/m)?.[1];
  assert.ok(ver, "an exact PyPI release");
  assert.match(df, /"heretic-llm==\$\{HERETIC_VERSION\}"/);
  assert.match(compose("heretic"), new RegExp(`image:\\s*crow-heretic:${ver.replace(/\./g, "\\.")}\\s*$`, "m"), "the local tag names the same release");
  assert.doesNotMatch(df, /git\s+clone|git\+https?:|^\s*(COPY|ADD)\s/m, "nothing vendored, cloned or copied in");
  assert.match(df, /torch\.version\.hip/, "the build fails if pip swapped the ROCm torch out");
  const files = readdirSync(dir("heretic"), { recursive: true }).map(String);
  assert.equal(files.some((f) => f.endsWith(".py")), false, "no Python (Heretic code) shipped in the bundle");
});

test("heretic: a separate idle container with the GPU nodes, no ports, no privilege", () => {
  const c = compose("heretic");
  assert.match(c, /^\s*build:/m);
  assert.match(c, /^\s*-\s+\/dev\/kfd\s*$/m);
  assert.match(c, /^\s*-\s+\/dev\/dri\s*$/m);
  assert.doesNotMatch(c, /^\s*ports\s*:/m, "nothing listens");
  assert.doesNotMatch(c, /^\s*(privileged|ipc|network_mode|pid|group_add|cap_add)\s*:/m);
  assert.deepEqual(parseComposeHostPorts(c), []);
  const m = manifest("heretic");
  assert.equal(m.webUI, null);
  assert.equal(m.ports, undefined);
  const r = validate(join(dir("heretic"), "docker-compose.yml"), "heretic", { manifest: m, consentVerified: true });
  assert.equal(r.valid, true, r.reason);
});

test("heretic: consent says plainly that it strips safety refusals, and names AGPL", () => {
  const m = manifest("heretic");
  assert.equal(m.license, "AGPL-3.0-or-later");
  assert.equal(m.consent_required, true);
  assert.notEqual(m.featured, true);
  assert.match(m.install_consent_messages.en, /safety/i);
  assert.match(m.install_consent_messages.en, /refus/i);
  assert.match(m.install_consent_messages.en, /AGPL/);
  assert.match(m.install_consent_messages.es, /seguridad/i);
  assert.match(m.install_consent_messages.es, /AGPL/);
  assert.match(m.description, /refusal/i, "the card says what it does");
  assert.deepEqual(m.requires.gpu_arch, ["rocm"]);
});

test("both: skills exist and say what the tools do", () => {
  for (const id of ["unsloth", "heretic"]) {
    const m = manifest(id);
    assert.ok(Array.isArray(m.skills) && m.skills.length === 1);
    assert.ok(existsSync(join(dir(id), m.skills[0])));
  }
  const h = readFileSync(join(dir("heretic"), "skills", "heretic.md"), "utf8");
  assert.match(h, /safety/i);
  assert.match(h, /AGPL/);
});
