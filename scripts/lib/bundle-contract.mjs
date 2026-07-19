/**
 * Bundle manifest contract — the single source of validation logic, shared by
 * scripts/build-registry.mjs and tests/bundle-contract.test.js.
 *
 * Two layers: (1) shape via ajv against registry/manifest.schema.json, and
 * (2) filesystem referential integrity (declared surface files exist, id ==
 * dirname, dependency bundles exist) — which JSON Schema cannot express.
 */
import { readFileSync, existsSync } from "node:fs";
import { join, isAbsolute, basename } from "node:path";
import Ajv from "ajv";

const schema = JSON.parse(
  readFileSync(new URL("../../registry/manifest.schema.json", import.meta.url), "utf8"),
);
const ajv = new Ajv({ allErrors: true, strict: false });
const validateShape = ajv.compile(schema);

// --- G-6 anti-rot: inference-endpoint provider contract + instance-leak scan ---

/** A compose `ports:` stanza, list or inline-array form (heuristic — text match, not a YAML parse). */
const PORT_MAPPING_RE = /\bports:\s*(\n[ \t]*-[ \t]*\S.*|[ \t]*\[[^\]]*\])/;
/** Command/entrypoint markers that smell like an OpenAI-compat inference server. */
const INFERENCE_CMD_RE = /--served-model-name|llama-server|vllm|ollama/i;

/**
 * Heuristic-only (WARN, never fails the build): does this bundle's compose file
 * expose a host port AND run something that looks like an OpenAI-compat
 * inference server, per the marker list above? Matched against the raw file
 * text (not a real YAML parse — no yaml dependency in this repo, and a text
 * heuristic is all a WARN needs).
 */
function composeLooksLikeInferenceEndpoint(bundleDir, composefileRel) {
  if (typeof composefileRel !== "string" || !composefileRel) return false;
  const p = isAbsolute(composefileRel) ? composefileRel : join(bundleDir, composefileRel);
  if (!existsSync(p)) return false;
  let text;
  try {
    text = readFileSync(p, "utf8");
  } catch {
    return false;
  }
  return PORT_MAPPING_RE.test(text) && INFERENCE_CMD_RE.test(text);
}

/** Tailscale CGNAT range: 100.64.0.0/10 (100.64.x.x - 100.127.x.x). */
const TAILSCALE_IP_RE = /\b100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/;
/** Any *.ts.net hostname (Tailscale MagicDNS). */
const TS_NET_RE = /\b[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.ts\.net\b/i;
/** 32-hex-char instance-id shape (as minted by servers/shared instance-identity code). */
const INSTANCE_ID_HEX32_RE = /^[0-9a-f]{32}$/i;
const ALLOWED_HOST_VALUES = new Set(["local", "cloud"]);

/**
 * Recursively scan every string value in a manifest for a leaked Tailscale
 * identity: a tailnet IP, a *.ts.net hostname, or (scoped to keys literally
 * named "host") a 32-hex instance-id string other than "local"/"cloud".
 * This is the generalized form of the #217 leak class (see
 * bundles/vllm-cuda-*'s host de-pin, Task 15) — run against every string in
 * every manifest, not just a hardcoded field.
 */
function scanForInstanceLeaks(value, path, errors) {
  if (value == null) return;
  if (typeof value === "string") {
    if (TAILSCALE_IP_RE.test(value)) {
      errors.push(`leaked Tailscale-range IP in ${path}: "${value}"`);
    }
    if (TS_NET_RE.test(value)) {
      errors.push(`leaked *.ts.net hostname in ${path}: "${value}"`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => scanForInstanceLeaks(v, `${path}[${i}]`, errors));
    return;
  }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      const childPath = path ? `${path}.${k}` : k;
      if (k === "host" && typeof v === "string" && INSTANCE_ID_HEX32_RE.test(v) && !ALLOWED_HOST_VALUES.has(v)) {
        errors.push(`leaked instance-id-shaped value in ${childPath}: "${v}" (host must be "local"/"cloud", not a pinned peer id)`);
      }
      scanForInstanceLeaks(v, childPath, errors);
    }
  }
}

/** Surfaces a manifest declares, by key presence. */
export function detectSurfaces(manifest) {
  const s = [];
  if (manifest && manifest.docker) s.push("docker");
  if (manifest && manifest.server) s.push("server");
  if (manifest && manifest.panel) s.push("panel");
  if (manifest && manifest.panelRoutes) s.push("panelRoutes");
  if (manifest && Array.isArray(manifest.skills) && manifest.skills.length) s.push("skills");
  return s;
}

function fileExists(bundleDir, rel) {
  if (typeof rel !== "string" || !rel) return false;
  const p = isAbsolute(rel) ? rel : join(bundleDir, rel);
  return existsSync(p);
}

/**
 * Validate one manifest object against the contract.
 * @param {object} manifest parsed manifest.json
 * @param {string} bundleDir absolute path to the bundle directory
 * @param {{bundleExists?: (id:string)=>boolean}} [opts] resolver for requires.bundles / optional_bundles
 * @returns {{ok: boolean, errors: string[], warnings: string[]}}
 */
export function validateManifest(manifest, bundleDir, opts = {}) {
  // 1. Shape (ajv)
  const shapeOk = validateShape(manifest);
  if (!shapeOk) {
    const errors = (validateShape.errors || []).map((e) => `shape ${e.instancePath || "/"} ${e.message}`);
    return { ok: false, errors, warnings: [] };
  }

  const errors = [];

  // 2. id must equal dirname
  const dirName = basename(String(bundleDir).replace(/[/\\]+$/, ""));
  if (manifest && manifest.id && dirName && manifest.id !== dirName) {
    errors.push(`id "${manifest.id}" must equal directory name "${dirName}"`);
  }

  // 3. Referential integrity per declared surface
  if (manifest && manifest.docker && !fileExists(bundleDir, manifest.docker.composefile)) {
    errors.push(`docker.composefile "${manifest.docker && manifest.docker.composefile}" not found`);
  }
  // server entry-file: only local node scripts with a non-flag path arg.
  // (typeof null === "object", so `manifest.server &&` correctly skips null.)
  if (manifest && manifest.server && typeof manifest.server === "object") {
    const command = manifest.server.command;
    const arg0 = Array.isArray(manifest.server.args) ? manifest.server.args[0] : undefined;
    if (command === "node" && typeof arg0 === "string" && !arg0.startsWith("-") && !fileExists(bundleDir, arg0)) {
      errors.push(`server entry "${arg0}" not found`);
    }
  }
  // panel: file-check only the string form; object panels resolve at runtime.
  if (manifest && typeof manifest.panel === "string" && !fileExists(bundleDir, manifest.panel)) {
    errors.push(`panel "${manifest.panel}" not found`);
  }
  if (manifest && typeof manifest.panelRoutes === "string" && !fileExists(bundleDir, manifest.panelRoutes)) {
    errors.push(`panelRoutes "${manifest.panelRoutes}" not found`);
  }
  if (manifest && Array.isArray(manifest.skills)) {
    for (const sk of manifest.skills) {
      if (!fileExists(bundleDir, sk)) errors.push(`skill "${sk}" not found`);
    }
  }

  // 4. Dependency bundles exist (via injected resolver)
  const deps = [
    ...(manifest && manifest.requires && Array.isArray(manifest.requires.bundles) ? manifest.requires.bundles : []),
    ...(manifest && Array.isArray(manifest.optional_bundles) ? manifest.optional_bundles : []),
  ];
  if (deps.length && typeof opts.bundleExists === "function") {
    for (const d of deps) {
      if (!opts.bundleExists(d)) errors.push(`required bundle "${d}" does not exist`);
    }
  }

  const warnings = [];

  // 5. Inference-endpoint provider contract (G-6 anti-rot).
  //    - `inference: true` promises a resolvable OpenAI-compat endpoint and
  //      must carry a non-empty providers[] array (see the 15 llamacpp-*/
  //      vllm-* manifests stamped by Task 16).
  //    - `no_auto_provider`, when present at all, must be a real non-empty
  //      reason string, not a stub/empty placeholder (see Task 15's 5
  //      side-channel/dynamic-model bundles).
  //    - a manifest declaring neither flag, whose compose looks like it runs
  //      an OpenAI-compat server on an exposed port, gets a WARN (heuristics
  //      don't hard-gate — this catches drift, it doesn't block it).
  const isInference = manifest && manifest.inference === true;
  const hasNoAutoProvider = Boolean(manifest) && Object.prototype.hasOwnProperty.call(manifest, "no_auto_provider");

  if (hasNoAutoProvider) {
    const reason = manifest.no_auto_provider;
    if (typeof reason !== "string" || reason.trim() === "") {
      errors.push(`no_auto_provider must be a non-empty string when present, got ${JSON.stringify(reason)}`);
    }
  }

  if (isInference) {
    if (!Array.isArray(manifest.providers) || manifest.providers.length === 0) {
      errors.push(`inference: true requires a non-empty providers[] array`);
    }
  } else if (!hasNoAutoProvider && manifest && manifest.docker) {
    if (composeLooksLikeInferenceEndpoint(bundleDir, manifest.docker.composefile)) {
      warnings.push(
        `compose exposes a port and a command matching an OpenAI-compat inference server ` +
          `(--served-model-name/llama-server/vllm/ollama), but the manifest declares neither ` +
          `"inference": true nor "no_auto_provider" — verify whether this bundle needs a providers[] block`,
      );
    }
  }

  // 6. Instance-identity leak scan (generalized #217 leak class): no manifest
  //    may carry a tailnet IP, a *.ts.net hostname, or (in a "host" field) a
  //    pinned 32-hex instance id.
  scanForInstanceLeaks(manifest, "", errors);

  return { ok: errors.length === 0, errors, warnings };
}
