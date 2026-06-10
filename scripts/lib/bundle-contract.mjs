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
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateManifest(manifest, bundleDir, opts = {}) {
  const errors = [];

  // 1. Shape (ajv)
  if (!validateShape(manifest)) {
    for (const e of validateShape.errors || []) {
      errors.push(`shape ${e.instancePath || "/"} ${e.message}`);
    }
  }

  // 2. id must equal dirname
  const dirName = basename(bundleDir);
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

  return { ok: errors.length === 0, errors };
}
