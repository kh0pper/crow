/**
 * Build-input hash for a bundle that builds its own image (the AI Companion).
 *
 * The compose file stamps it on the image as a build label
 * (`labels: crow.build-inputs: "${CROW_BUILD_INPUTS:-}"`); every gateway `compose up`
 * passes CROW_BUILD_INPUTS = buildInputsHash(installed dir). Extensions compares the
 * running container's label with the hash of what the installed copy would build now:
 * a difference means the image is older than its build inputs ("Rebuild needed").
 *
 * What is hashed, per compose build: the Dockerfile, and every file its COPY/ADD lines
 * name inside the build context (a directory: all its files). COPY --from, ADD <url>
 * and anything outside the context (a .. path, a symlink that leaves it) are not read.
 * A source with a glob falls back to the whole context. Never read at all: .env*
 * files and local droppings (node_modules, .git, .venv, caches). The context's
 * .dockerignore is hashed too (it changes what reaches the build) but not applied, so a
 * directory COPY may count an ignored file: a false "Rebuild needed", never a false
 * "current". A source it can't follow (${ARG}, a heredoc, git@) makes the answer
 * "unknown". Bounded (5000 files, 2000 dirs, 32 MB: over that, "unknown"), and cached
 * on the inputs' size + mtime, so a page render re-reads only what changed.
 *
 * Text parsing on purpose (no YAML parser, no docker call): it runs on every
 * Extensions render. A form it does not understand only makes the answer "unknown".
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export const BUILD_INPUTS_LABEL = "crow.build-inputs";
const SKIP = new Set([".venv", "__pycache__", ".pytest_cache", "node_modules", ".git"]);
const NEVER_FILE = /^\.env(\..*)?$/i;
const MAX_FILES = 5000;
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_DIRS = 2000;

const clean = (v) => String(v).replace(/\s+#.*$/, "").trim().replace(/^["']|["']$/g, "");

/** [{context, dockerfile}] for every `build:` in a compose text (string or mapping form). */
export function composeBuildSpecs(text) {
  const lines = String(text || "").split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s+)build:\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    const inline = clean(m[2]);
    if (inline && !inline.startsWith("{")) { out.push({ context: inline, dockerfile: "Dockerfile" }); continue; }
    let context = ".";
    let dockerfile = "Dockerfile";
    for (let j = i + 1; j < lines.length; j++) {
      if (!lines[j].trim() || /^\s*#/.test(lines[j])) continue;
      if (/^(\s*)/.exec(lines[j])[1].length <= m[1].length) break;
      const c = /^\s+context:\s*(.+)$/.exec(lines[j]);
      if (c) context = clean(c[1]);
      const d = /^\s+dockerfile:\s*(.+)$/.exec(lines[j]);
      if (d) dockerfile = clean(d[1]);
    }
    out.push({ context, dockerfile });
  }
  return out;
}

/** The local sources a Dockerfile's COPY/ADD lines name, in order. */
export function dockerfileSources(text) {
  const logical = [];
  let cur = "";
  for (const raw of String(text || "").split(/\r?\n/)) {
    if (!cur && /^\s*#/.test(raw)) continue;
    if (/\\\s*$/.test(raw)) { cur += raw.replace(/\\\s*$/, " "); continue; }
    logical.push(cur + raw);
    cur = "";
  }
  if (cur) logical.push(cur);
  const out = [];
  for (const line of logical) {
    const m = /^\s*(COPY|ADD)\s+(.*)$/i.exec(line);
    if (!m) continue;
    let rest = m[2].trim();
    const flags = [];
    while (/^--\S+/.test(rest)) {
      const f = /^(--\S+)\s*/.exec(rest);
      flags.push(f[1]);
      rest = rest.slice(f[0].length);
    }
    if (flags.some((f) => /^--from[=\s]/i.test(f) || f.toLowerCase() === "--from")) continue;
    let parts;
    if (rest.startsWith("[")) {
      try { parts = JSON.parse(rest); } catch { continue; }
      if (!Array.isArray(parts)) continue;
    } else {
      parts = rest.split(/\s+/).filter(Boolean);
    }
    for (const s of parts.slice(0, -1)) {
      if (typeof s !== "string" || /^[a-z][a-z0-9+.-]*:\/\//i.test(s)) continue;
      out.push(s);
    }
  }
  return out;
}

/** True when the compose text stamps the build-input label (the bundle opted in). */
export function tracksBuildInputs(text) {
  return /\$\{?CROW_BUILD_INPUTS\b/.test(String(text || ""));
}

/** The crow.build-inputs label of one `compose ps --format json` row ("" when absent). */
export function containerBuildLabel(row) {
  const labels = row?.Labels;
  if (labels && typeof labels === "object") return String(labels[BUILD_INPUTS_LABEL] || "");
  for (const kv of String(labels || "").split(",")) {
    const at = kv.indexOf("=");
    if (at > 0 && kv.slice(0, at).trim() === BUILD_INPUTS_LABEL) return kv.slice(at + 1).trim();
  }
  return "";
}

function inside(root, p) {
  const rel = relative(root, p);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * The files one build reads, as [{rel, real, size, mtimeMs}] plus the Dockerfile text, or
 * null when a spec can't be resolved or the bounds are exceeded.
 */
function collectInputs(bundleDir, specs) {
  let rootReal;
  try { rootReal = realpathSync(bundleDir); } catch { return null; }
  const files = [];
  const parts = [];
  const seen = new Set();
  const seenDirs = new Set();
  let bytes = 0;
  const addFile = (real, st, ctxReal) => {
    if (seen.has(real)) return true;
    seen.add(real);
    bytes += st.size;
    if (files.length >= MAX_FILES || bytes > MAX_BYTES) return false;
    files.push({ rel: relative(ctxReal, real).split(sep).join("/"), real, size: st.size, mtimeMs: st.mtimeMs });
    return true;
  };
  const addPath = (p, ctxReal) => {
    let real;
    try { real = realpathSync(p); } catch { return true; }
    if (!inside(ctxReal, real)) return true;
    let st;
    try { st = statSync(real); } catch { return true; }
    if (st.isDirectory()) {
      if (seenDirs.has(real)) return true; // a symlink loop, or the same dir named twice
      seenDirs.add(real);
      if (seenDirs.size > MAX_DIRS) return false;
      let names;
      try { names = readdirSync(real).sort(); } catch { return false; }
      for (const name of names) {
        if (SKIP.has(name) || NEVER_FILE.test(name)) continue;
        if (!addPath(join(real, name), ctxReal)) return false;
      }
      return true;
    }
    if (!st.isFile() || NEVER_FILE.test(real.split(sep).pop())) return true;
    return addFile(real, st, ctxReal);
  };
  for (const spec of specs) {
    if (!spec.context || isAbsolute(spec.context) || spec.context.includes("$") || /^[a-z][a-z0-9+.-]*:\/\//i.test(spec.context)) return null;
    let ctxReal;
    try { ctxReal = realpathSync(resolve(bundleDir, spec.context)); } catch { return null; }
    if (!inside(rootReal, ctxReal)) return null;
    let dfPath;
    try { dfPath = realpathSync(resolve(ctxReal, spec.dockerfile)); } catch { return null; }
    if (!inside(ctxReal, dfPath) || !existsSync(dfPath)) return null;
    let df;
    try { df = readFileSync(dfPath, "utf8"); } catch { return null; }
    parts.push(`d\0${spec.context}\0${spec.dockerfile}\0${df}\0`);
    if (!addPath(join(ctxReal, ".dockerignore"), ctxReal)) return null;
    const sources = dockerfileSources(df);
    // A source this parser can't follow (a build-arg, a heredoc, a git URL) → unknown.
    if (sources.some((x) => /[$<]|^git@/.test(x))) return null;
    if (sources.some((x) => /[*?[]/.test(x))) {
      if (!addPath(ctxReal, ctxReal)) return null;
      continue;
    }
    for (const x of sources) {
      const p = resolve(ctxReal, x.replace(/^\/+/, ""));
      if (!inside(ctxReal, p)) continue;
      if (!addPath(p, ctxReal)) return null;
    }
  }
  return { parts, files };
}

// stat key → hash. Small: one entry per bundle dir is kept.
const _cache = new Map();

/**
 * sha256 (first 20 hex) of the bundle's build inputs, or null when the compose has no
 * build, a Dockerfile is missing, or the inputs exceed the bounds.
 */
export function buildInputsHash(bundleDir, opts = {}) {
  // Advisory only: whatever goes wrong, the answer is "unknown", never a thrown start.
  try { return hashInputs(bundleDir, opts); } catch { return null; }
}

function hashInputs(bundleDir, { composeFile = "docker-compose.yml" } = {}) {
  let text;
  try { text = readFileSync(join(bundleDir, composeFile), "utf8"); } catch { return null; }
  const specs = composeBuildSpecs(text);
  if (!specs.length) return null;
  const inputs = collectInputs(bundleDir, specs);
  if (!inputs) return null;
  const key = createHash("sha256").update(JSON.stringify([inputs.parts, inputs.files.map((f) => [f.rel, f.real, f.size, f.mtimeMs])])).digest("hex");
  const hit = _cache.get(bundleDir);
  if (hit && hit.key === key) return hit.hash;
  const h = createHash("sha256");
  for (const part of inputs.parts) h.update(part);
  for (const f of inputs.files) {
    let buf;
    try { buf = readFileSync(f.real); } catch { return null; }
    h.update(`f\0${f.rel}\0`);
    h.update(createHash("sha256").update(buf).digest());
  }
  const hash = h.digest("hex").slice(0, 20);
  _cache.set(bundleDir, { key, hash });
  if (_cache.size > 64) _cache.delete(_cache.keys().next().value);
  return hash;
}
