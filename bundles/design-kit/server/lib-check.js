// Design kit — library integrity (spec §3.2, §7). The rules CI enforces on
// bundles/design-kit/lib/ (scripts/check-design-kit-lib.mjs) and the hash check
// the kit repeats when it copies a file. node: imports only: the installed copy,
// the CI script and the vendor script all load this file directly.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, sep } from "node:path";

export const LICENSE_IDS = new Set(["OFL-1.1", "MIT", "ISC", "BSD-3-Clause", "Apache-2.0"]);
export const TARGETS = new Set(["page", "document", "diagram"]);
export const KIND_PREFIX = Object.freeze({ font: "font:", css: "css:", "icon-set": "icons:", theme: "theme:", script: "" });
export const CONTENT_TYPES = new Set(["font/woff2", "text/css", "application/json", "text/javascript", "image/svg+xml"]);
export const LICENCE_TYPE = "text/plain; charset=utf-8";
export const FONT_FALLBACKS = new Set(["serif", "sans-serif", "monospace", "cursive", "fantasy"]);
export const NAME_RE = /^(?:font:|css:|icons:|theme:)?[a-z0-9][a-z0-9-]{0,39}$/;
const SOURCE_RE = /^(?:npm:(?:@[a-z0-9-]+\/)?[a-z0-9._-]+@\d+\.\d+\.\d+|github:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[0-9a-f]{40}|crow:generated)$/;
const VERSION_RE = /^\d+\.\d+\.\d+$/;
const SEG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const FAMILY_RE = /^[A-Za-z0-9 ]{1,60}$/;

export const sha256Hex = (buf) => createHash("sha256").update(buf).digest("hex");

/** A plain relative path of safe segments, or null. */
export function cleanLibPath(p) {
  if (typeof p !== "string" || !p || p.length > 200) return null;
  return p.split("/").every((s) => SEG_RE.test(s) && s !== "." && s !== "..") ? p : null;
}

function walk(dir, root = dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, root, out);
    else out.push(relative(root, p).split(sep).join("/"));
  }
  return out;
}

/** True when a CSS fetch target (text right after `url(`, a quote, ...) is a
 *  remote one: protocol-relative, or a scheme other than data:. */
function remoteTarget(low, from) {
  let j = from;
  while (j < low.length && (/\s/.test(low[j]) || low[j] === "'" || low[j] === '"')) j++;
  const head = low.slice(j, j + 16);
  if (head.startsWith("//")) return true;
  const colon = head.indexOf(":");
  return colon > 0 && /^[a-z][a-z0-9+.-]*$/.test(head.slice(0, colon)) && !head.startsWith("data:");
}

/** CSS that would fetch at runtime. Fails closed: any @import (also with an
 *  escaped name); url() / src() whose target is remote or contains a CSS
 *  escape; and any quoted string inside image-set() that is remote. Linear
 *  scans (no regex over the whole file). */
export function cssFetches(css) {
  const low = String(css).toLowerCase();
  if (low.includes("@import") || /@\s*\\/.test(low)) return true;
  for (const fn of ["url(", "src("]) {
    let i = 0;
    for (;;) {
      const k = low.indexOf(fn, i);
      if (k < 0) break;
      i = k + fn.length;
      if (fn === "src(" && /[a-z0-9_-]/.test(low[k - 1] || " ")) continue; // a name ending in src(, not the function
      const end = low.indexOf(")", i);
      if (low.slice(i, end < 0 ? low.length : end).includes("\\")) return true;
      if (remoteTarget(low, i)) return true;
    }
  }
  let i = 0;
  for (;;) {
    const k = low.indexOf("image-set(", i);
    if (k < 0) return false;
    i = k + 10;
    let stop = low.length;
    for (const c of [";", "}"]) { const x = low.indexOf(c, i); if (x >= 0 && x < stop) stop = x; }
    const seg = low.slice(i, stop);
    if (seg.includes("\\")) return true;
    for (const q of ["'", '"']) {
      let at = seg.indexOf(q);
      while (at >= 0) {
        if (remoteTarget(seg, at + 1)) return true;
        const close = seg.indexOf(q, at + 1);
        at = close < 0 ? -1 : seg.indexOf(q, close + 1);
      }
    }
  }
}

export function checkLib(libDir) {
  const errors = [];
  const fail = (m) => errors.push(m);
  let man;
  try { man = JSON.parse(readFileSync(join(libDir, "manifest.json"), "utf8")); }
  catch (e) { return { errors: [`manifest.json: ${e.message}`], entries: 0 }; }
  if (man.schema !== 1 || !Array.isArray(man.entries)) return { errors: ["manifest.json: schema 1 with an entries list expected"], entries: 0 };
  const listed = new Set(["manifest.json"]);
  const names = new Set(man.entries.map((e) => e && e.name));
  const seen = new Set();
  const verify = (where, f) => {
    const p = cleanLibPath(f && f.path);
    if (!p) return fail(`${where}: bad path ${JSON.stringify(f && f.path)}`);
    listed.add(p);
    const abs = join(libDir, p);
    if (!existsSync(abs)) return fail(`${where}: missing file ${p}`);
    const body = readFileSync(abs);
    if (sha256Hex(body) !== f.sha256) fail(`${where}: sha256 mismatch for ${p}`);
    if (f.type === "text/css" && cssFetches(body.toString("utf8"))) fail(`${where}: ${p} would fetch at runtime (@import or a remote url())`);
  };
  for (const e of man.entries) {
    const where = e && typeof e.name === "string" ? e.name : "(unnamed entry)";
    if (!e || !NAME_RE.test(String(e.name))) { fail(`${where}: bad name`); continue; }
    if (seen.has(e.name)) fail(`${where}: duplicate name`);
    seen.add(e.name);
    if (!Object.hasOwn(KIND_PREFIX, e.kind)) fail(`${where}: unknown kind ${e.kind}`);
    else if (KIND_PREFIX[e.kind] ? !e.name.startsWith(KIND_PREFIX[e.kind]) : e.name.includes(":")) fail(`${where}: name does not match kind ${e.kind}`);
    if (!VERSION_RE.test(String(e.version))) fail(`${where}: version must be exact x.y.z`);
    if (!LICENSE_IDS.has(e.license)) fail(`${where}: licence ${e.license} is not on the allowlist`);
    const lf = cleanLibPath(e.license_file);
    if (lf && !lf.startsWith("licenses/")) fail(`${where}: licence file must live under licenses/`);
    if (!lf || !existsSync(join(libDir, lf)) || !readFileSync(join(libDir, lf), "utf8").trim()) fail(`${where}: licence file missing or empty`);
    else {
      listed.add(lf);
      // Licence texts travel with every copy (review M9), so they are hash-pinned like code.
      if (sha256Hex(readFileSync(join(libDir, lf))) !== e.license_sha256) fail(`${where}: licence sha256 mismatch for ${lf}`);
    }
    for (const n of e.notices || []) {
      const np = cleanLibPath(n && n.path);
      if (!np || !np.startsWith("licenses/")) { fail(`${where}: notices must live under licenses/`); continue; }
      verify(where, { ...n, type: "text/plain" });
    }
    if (!SOURCE_RE.test(String(e.source))) fail(`${where}: source must be an exact pin (npm:pkg@x.y.z, github:owner/repo@<40-hex>, crow:generated)`);
    if (!Array.isArray(e.allowed) || !e.allowed.length || e.allowed.some((t) => !TARGETS.has(t))) fail(`${where}: allowed must be a non-empty subset of page, document, diagram`);
    if (e.kind === "font") {
      if (!FAMILY_RE.test(String(e.family))) fail(`${where}: font family must be letters, digits and spaces`);
      if (!FONT_FALLBACKS.has(e.fallback)) fail(`${where}: font fallback must be a generic family`);
    }
    if (!Array.isArray(e.files) || !e.files.length) { fail(`${where}: no files`); continue; }
    for (const f of e.files) {
      if (!CONTENT_TYPES.has(f && f.type)) fail(`${where}: ${f && f.path}: type ${f && f.type} not allowed`);
      verify(where, f);
    }
    if (!e.files.some((f) => f.path === e.main)) fail(`${where}: main must be one of its files`);
    for (const r of e.requires || []) if (!names.has(r)) fail(`${where}: requires unknown ${r}`);
  }
  for (const m of man.meta_files || []) {
    if (!CONTENT_TYPES.has(m && m.type)) fail(`meta_files: ${m && m.path}: type ${m && m.type} not allowed`);
    verify("meta_files", m);
  }
  for (const p of existsSync(libDir) ? walk(libDir) : []) if (!listed.has(p)) fail(`unlisted file in lib/: ${p}`);
  return { errors, entries: man.entries.length };
}

/** The kit's own code and skills never name a remote host (spec §3.2 "no entry
 *  is fetched at runtime"). Loopback URLs are allowed (the renderer). The
 *  Dockerfile's build-time download is not runtime and is not scanned. */
const HOSTS_OK = new Set(["127.0.0.1", "localhost", "[::1]"]);
// A scheme followed by a slash pair and an authority, or a protocol-relative
// authority introduced by a quote, paren or equals sign.
const REMOTE_REF = /(?:\b[a-z][a-z0-9+.-]*:\/\/|["'`(=]\s*\/\/)([^\s"'`<>)\/?#\\]+)/gi;
function namesRemoteHost(text) {
  for (const m of text.matchAll(REMOTE_REF)) {
    // Authority = userinfo@host:port; the host is what follows the LAST "@".
    const hostport = m[1].slice(m[1].lastIndexOf("@") + 1).toLowerCase();
    const host = hostport.startsWith("[") ? hostport.slice(0, hostport.indexOf("]") + 1) : hostport.replace(/:\d*$/, "");
    if (!HOSTS_OK.has(host)) return true;
  }
  return false;
}
export function checkNoRemoteRefs(kitDir) {
  const out = [];
  const scan = (rel, test) => {
    const abs = join(kitDir, rel);
    if (!existsSync(abs)) return;
    for (const f of walk(abs)) {
      if (f.split("/").includes("node_modules") || !test(f)) continue;
      if (namesRemoteHost(readFileSync(join(abs, f), "utf8"))) out.push(`${rel}/${f} names a remote URL`);
    }
  };
  scan("server", (f) => f.endsWith(".js"));
  scan("renderer", (f) => f.endsWith(".mjs"));
  scan("skills", (f) => f.endsWith(".md"));
  return out;
}
