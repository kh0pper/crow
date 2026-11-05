/**
 * compose-image-pins.test.js — security audit N1a-6.
 *
 * A third-party image must be pinned to a RELEASED tag (or a digest). `:latest`
 * turns every install/restart into a silent upgrade of software the owner never
 * chose to update, and an image with no tag at all is `:latest` spelled
 * differently. A digest pin (`repo@sha256:…`) is pinned by definition.
 *
 * Every `docker-compose*.yml` / `compose*.y*ml` in the repo (root and
 * bundles/**, node_modules skipped) is checked. Compose values are read as
 * written: `${VAR:-default}` resolves to its default (that is what compose does
 * with no .env entry), and an image that is ONLY a variable — no default to
 * fall back on — is reported rather than passed.
 *
 * The checker is exported so its red cases can be driven from fixture strings
 * instead of by editing a real compose file.
 *
 * `scripts/image-pin-allowlist.txt` holds the images this repo BUILDS itself
 * (`path image  # reason`) — those have no upstream tag to pin. An allowlist
 * entry that no longer matches a file is stale and fails this suite, so the
 * list cannot rot into a blanket exemption.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseImagePinAllowlist } from "../servers/shared/image-pin-allowlist.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ALLOWLIST_PATH = join(ROOT, "scripts", "image-pin-allowlist.txt");

/** Directories never worth walking: dependencies and VCS. */
const SKIP_DIRS = new Set(["node_modules", ".git", ".pi-brief"]);

/**
 * Skipped ONLY at the repo root: `data/` is the checkout's generated scratch
 * area. A bundle may legitimately keep its own `data/` folder, and a compose
 * file there is still a compose file this repo ships — skipping it everywhere
 * would let a bundle hide an unpinned image one directory deep.
 */
const ROOT_SKIP_DIRS = new Set(["data"]);

/** Whether a directory of this name is skipped (`isRoot`: it is the walk's start). */
export function isSkippedDir(name, isRoot = false) {
  return SKIP_DIRS.has(name) || (isRoot && ROOT_SKIP_DIRS.has(name));
}

/** docker-compose.yml / docker-compose.tailnet.yml / compose.yml / *.yaml … */
const COMPOSE_FILE_RE = /^(?:docker-)?compose(?:[.-][A-Za-z0-9_.-]+)?\.ya?ml$/;

/** The image line of a compose service. */
const IMAGE_LINE_RE = /^\s*(?:-\s*)?image:\s*(.+?)\s*$/;

/**
 * The same key written inline: flow style (`app: {image: foo:latest}`, the key
 * after `{`, `,` or whitespace) and JSON style (`"image": "foo:latest"`).
 * Scanning only lines that START with `image:` lets a whole compose file dodge
 * the check by switching style, so both are matched wherever they appear.
 */
const IMAGE_FLOW_RE = /(?:^|[\s{,])image\s*:\s*("[^"]*"|'[^']*'|[^,}\s]+)/g;
const IMAGE_JSON_RE = /"image"\s*:\s*"([^"]*)"/g;

/** A resolved reference: `repo[:port]/path[/path]` `:tag` `@sha256:…`. */
const DIGEST_RE = /@sha256:[0-9a-f]{64}$/;

/** Every compose file under `dir`, as repo-relative POSIX paths, sorted. */
export function findComposeFiles(dir = ROOT) {
  const out = [];
  const walk = (abs, isRoot = false) => {
    let entries;
    try { entries = readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (isSkippedDir(e.name, isRoot)) continue;
        walk(join(abs, e.name), false);
      } else if (e.isFile() && COMPOSE_FILE_RE.test(e.name)) {
        out.push(relative(dir, join(abs, e.name)).split(sep).join("/"));
      }
    }
  };
  walk(dir, true);
  return out.sort();
}

/**
 * Compose variable interpolation, as far as an image reference needs it.
 * `${VAR:-default}` and `${VAR-default}` yield the default; `${VAR}` and
 * `${VAR:?msg}` yield nothing to pin, which the caller reports.
 *
 * @returns {{value: string, unresolved: string[]}}
 */
export function resolveImageVars(raw) {
  const unresolved = [];
  const value = String(raw ?? "").replace(/\$\{([^}]*)\}/g, (whole, body) => {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)(?::?-([\s\S]*))?$/.exec(body);
    if (!m || m[2] === undefined) {
      unresolved.push(whole);
      return whole;
    }
    return m[2];
  });
  return { value, unresolved };
}

/**
 * The pin verdict for one already-resolved image reference.
 * @returns {{ok: boolean, code?: "latest-tag"|"no-tag"|"unresolved-variable", detail?: string}}
 */
export function checkImagePin(value) {
  const ref = String(value ?? "").trim();
  if (!ref) return { ok: false, code: "no-tag", detail: "empty image" };
  if (ref.includes("${")) return { ok: false, code: "unresolved-variable", detail: "image is a variable with no default" };
  if (DIGEST_RE.test(ref)) return { ok: true };
  // The tag is what follows the last ":" AFTER the last "/" (so a registry
  // port — registry:5000/img — is not mistaken for one).
  const slash = ref.lastIndexOf("/");
  const tail = slash >= 0 ? ref.slice(slash + 1) : ref;
  const colon = tail.lastIndexOf(":");
  if (colon < 0) return { ok: false, code: "no-tag", detail: "no tag and no @sha256: digest" };
  const tag = tail.slice(colon + 1);
  if (!tag) return { ok: false, code: "no-tag", detail: "empty tag" };
  if (tag.toLowerCase() === "latest") return { ok: false, code: "latest-tag", detail: "tag is :latest" };
  return { ok: true };
}

/** A compose scalar without the quotes compose allows around it. */
function unquote(raw) {
  const s = String(raw ?? "").trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1).trim();
  return s;
}

/**
 * The `image:` values in one compose file, with their line numbers and the
 * style they were written in (`line` block form, `flow`, or `json`).
 */
export function findComposeImages(text) {
  const out = [];
  const lines = String(text ?? "").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = IMAGE_LINE_RE.exec(line);
    if (m) {
      // Drop a trailing comment, then the quotes compose allows around a scalar.
      const raw = unquote(m[1].replace(/\s+#.*$/, ""));
      if (raw) out.push({ line: i + 1, raw, style: "line" });
      continue;
    }
    // Not the block form — but the same key can still be inline on this line.
    // A comment cannot declare an image, and spec examples live in comments.
    if (/^\s*#/.test(line)) continue;
    const body = line.replace(/\s+#.*$/, "");
    for (const [re, style] of [[IMAGE_FLOW_RE, "flow"], [IMAGE_JSON_RE, "json"]]) {
      re.lastIndex = 0;
      let hit;
      while ((hit = re.exec(body)) !== null) {
        const raw = unquote(hit[1]);
        if (raw) out.push({ line: i + 1, raw, style });
        if (hit[0] === "") re.lastIndex++; // never loop on an empty match
      }
    }
  }
  return out;
}

/**
 * The findings for one compose file's text.
 * @param {string} text
 * @param {{file?: string, allowlist?: Array<{path: string, image: string}>}} [opts]
 * @returns {Array<{file: string, line: number, image: string, resolved: string, code: string, allowlisted: boolean}>}
 *   One entry per image that is not pinned; `allowlisted` says whether
 *   scripts/image-pin-allowlist.txt covers it.
 */
export function checkComposeText(text, { file = "(inline)", allowlist = [] } = {}) {
  const findings = [];
  for (const { line, raw } of findComposeImages(text)) {
    const { value } = resolveImageVars(raw);
    const verdict = checkImagePin(value);
    if (verdict.ok) continue;
    findings.push({
      file,
      line,
      image: raw,
      resolved: value,
      code: verdict.code,
      allowlisted: allowlist.some((e) => e.path === file && e.image === raw),
    });
  }
  return findings;
}

/** `path\timage` — the key that pairs an allowlist entry with a real image. */
export function composeImageKey(path, image) {
  return `${path}\t${image}`;
}

/** Every image in every compose file under `dir`, as `composeImageKey` strings. */
export function collectComposeImageKeys(dir = ROOT) {
  const keys = new Set();
  for (const file of findComposeFiles(dir)) {
    for (const { raw } of findComposeImages(readFileSync(join(dir, file), "utf8"))) keys.add(composeImageKey(file, raw));
  }
  return keys;
}

/**
 * The allowlist entries that match NO image seen in a compose file. This is the
 * whole staleness rule, in one place: an entry that no longer names a real
 * image has rotted into a blanket exemption and must fail the suite.
 *
 * @param {Array<{path: string, image: string}>} allowlist
 * @param {Set<string>} seenImages  `composeImageKey` values
 */
export function findStaleAllowlist(allowlist, seenImages) {
  return (allowlist || []).filter((e) => !seenImages.has(composeImageKey(e.path, e.image)));
}

const ALLOWLIST = parseImagePinAllowlist(readFileSync(ALLOWLIST_PATH, "utf8"));

test("every compose image is pinned to a released tag or a digest (or is a locally built image we allowlist)", () => {
  const files = findComposeFiles();
  assert.ok(files.includes("docker-compose.yml"), "the root compose file is walked");
  assert.ok(files.some((f) => f.startsWith("bundles/")), "bundle compose files are walked");
  assert.ok(!files.some((f) => f.includes("node_modules")), "node_modules is skipped");

  const unpinned = [];
  for (const file of files) {
    for (const f of checkComposeText(readFileSync(join(ROOT, file), "utf8"), { file, allowlist: ALLOWLIST })) {
      if (!f.allowlisted) unpinned.push(`${f.file}:${f.line} ${f.image} (${f.code})`);
    }
  }
  assert.deepEqual(unpinned, [], `unpinned images:\n  ${unpinned.join("\n  ")}`);
});

test("no allowlist entry is stale: each one still matches a real image in a real compose file", () => {
  const stale = findStaleAllowlist(ALLOWLIST, collectComposeImageKeys()).map((e) => `${e.path} ${e.image}`);
  assert.deepEqual(stale, [], `stale image-pin-allowlist.txt entries:\n  ${stale.join("\n  ")}`);
});

test("only the repo root's data/ directory is skipped, never a bundle's own", () => {
  assert.equal(isSkippedDir("data", true), true, "the checkout's generated data/ is scratch");
  assert.equal(isSkippedDir("data", false), false, "a bundle's data/ folder is still walked");
  assert.equal(isSkippedDir("node_modules", false), true, "dependencies are skipped at any depth");
  assert.equal(isSkippedDir(".git", false), true);
});

// ── the checker's red cases (fixture strings, never a real file) ──

test("red: a fixture compose with :latest fails the checker", () => {
  const findings = checkComposeText("services:\n  app:\n    image: nginx:latest\n");
  assert.equal(findings.length, 1);
  assert.equal(findings[0].line, 3);
  assert.equal(findings[0].code, "latest-tag");
});

test("red: an untagged image is treated as :latest by another name", () => {
  const findings = checkComposeText("services:\n  app:\n    image: ghcr.io/example/app\n");
  assert.equal(findings.length, 1);
  assert.equal(findings[0].code, "no-tag");
});

test("red: an image that is only a variable (no default) is reported, not passed", () => {
  const findings = checkComposeText("services:\n  app:\n    image: ${SOME_IMAGE}\n");
  assert.equal(findings.length, 1);
  assert.equal(findings[0].code, "unresolved-variable");
});

test("red: a flow-style image is caught too (it does not start with `image:`)", () => {
  const latest = checkComposeText('services:\n  app: {image: nginx:latest, ports: ["80:80"]}\n');
  assert.deepEqual(latest.map((f) => [f.line, f.code]), [[2, "latest-tag"]], "flow-style :latest");

  const untagged = checkComposeText("services:\n  app: {image: ghcr.io/example/app}\n");
  assert.deepEqual(untagged.map((f) => [f.line, f.code]), [[2, "no-tag"]], "flow-style with no tag");

  const pinned = checkComposeText("services:\n  app: {image: \"nginx:1.27.3\", ports: [\"80:80\"]}\n");
  assert.deepEqual(pinned, [], "a pinned flow-style image passes");
});

test("red: a JSON-style image key is caught too", () => {
  const latest = checkComposeText('{"services": {"app": {"image": "nginx:latest"}}}\n');
  assert.deepEqual(latest.map((f) => [f.line, f.code]), [[1, "latest-tag"]], "JSON-style :latest");

  const untagged = checkComposeText('{"services": {"app": {"image": "nginx"}}}\n');
  assert.deepEqual(untagged.map((f) => [f.line, f.code]), [[1, "no-tag"]], "JSON-style with no tag");

  const pinned = checkComposeText('{"services": {"app": {"image": "nginx:1.27.3"}}}\n');
  assert.deepEqual(pinned, [], "a pinned JSON-style image passes");
});

test("green: released tags, registry ports, digests and a variable WITH a default all pass", () => {
  const text = [
    "services:",
    "  a:",
    "    image: minio/minio:RELEASE.2025-09-07T16-13-09Z",
    "  b:",
    "    image: registry.example:5000/team/app:1.2.3",
    "  c:",
    "    image: parker/thing@sha256:9c96caa2612d3411acc5b0e6701fb238dbfba33e533a6d7d3d811a4b12d0d020",
    "  d:",
    "    image: ${VLLM_CUDA_IMAGE:-vllm/vllm-openai:v0.11.0}",
    "  e:",
    '    image: "quoted/app:2.0"  # a trailing comment is not part of the tag',
  ].join("\n");
  assert.deepEqual(checkComposeText(text), []);
});

test("green: a locally built image passes once the allowlist names it (and only for that path)", () => {
  const text = "services:\n  app:\n    image: crow-local\n";
  const allowlist = [{ path: "bundles/demo/docker-compose.yml", image: "crow-local" }];
  const off = checkComposeText(text, { file: "bundles/other/docker-compose.yml", allowlist });
  assert.equal(off.length, 1);
  assert.equal(off[0].allowlisted, false);
  const on = checkComposeText(text, { file: "bundles/demo/docker-compose.yml", allowlist });
  assert.equal(on.length, 1);
  assert.equal(on[0].allowlisted, true);
});

test("red: an allowlist entry that matches nothing is stale", () => {
  const entries = parseImagePinAllowlist("bundles/gone/docker-compose.yml  crow-gone  # removed bundle\n");
  assert.deepEqual(entries, [{ path: "bundles/gone/docker-compose.yml", image: "crow-gone" }]);
  // Through the REAL stale check, not a hand-rolled set lookup.
  const seen = collectComposeImageKeys();
  assert.deepEqual(findStaleAllowlist(entries, seen), entries, "the real check flags an entry whose file is gone");

  // …and it clears an entry that does match, so the red case is not a function
  // that simply says "stale" to everything.
  assert.deepEqual(findStaleAllowlist(ALLOWLIST, seen), [], "the live allowlist is not stale");
  const live = ALLOWLIST[0];
  assert.deepEqual(findStaleAllowlist([live], new Set([composeImageKey(live.path, live.image)])), []);
  assert.deepEqual(findStaleAllowlist([live], new Set([composeImageKey(live.path, "someone-else:1.0")])), [live],
    "the pair matters, not just the path");
});