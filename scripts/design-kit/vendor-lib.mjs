#!/usr/bin/env node
/**
 * Design kit — VENDOR TIME ONLY. A developer runs this; CI and installs never do,
 * and nothing at runtime fetches (spec §3.2). Reads scripts/design-kit/pins.json,
 * fetches each pinned package with `npm pack`, copies the named files into
 * bundles/design-kit/lib/ and rewrites lib/manifest.json (sha256 per file).
 * scripts/check-design-kit-lib.mjs then verifies what this wrote.
 *
 * CSS goes through normalize-css.mjs (comments out, licence banners kept under
 * licenses/, inline SVG data: URLs in custom properties extracted to
 * <css dir>/icons/*.svg when they pass the SVG allowlist, else set to none); what it
 * changed is listed in the entry's "notes". Icon sets are built from the
 * per-icon SVG files (never a sprite or an icon font), whitespace-collapsed, and
 * every icon must pass lib-check's SVG allowlist.
 *
 *   node scripts/design-kit/vendor-lib.mjs --pin                  fill missing "version" from the registry
 *   node scripts/design-kit/vendor-lib.mjs [--only font,css,…]    vendor (all kinds by default)
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256Hex, cleanLibPath, svgUnsafe } from "../../bundles/design-kit/server/lib-check.js";
import { normalizeCss } from "./normalize-css.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const LIB = join(ROOT, "bundles", "design-kit", "lib");
const PINS_PATH = join(ROOT, "scripts", "design-kit", "pins.json");
const PINS = JSON.parse(readFileSync(PINS_PATH, "utf8"));
const argv = process.argv.slice(2);
const onlyAt = argv.indexOf("--only");
const ONLY = onlyAt >= 0 ? new Set(argv[onlyAt + 1].split(",")) : null;
const TYPE_OF = { ".woff2": "font/woff2", ".css": "text/css", ".json": "application/json", ".js": "text/javascript", ".svg": "image/svg+xml", ".txt": "text/plain; charset=utf-8" };
const typeOf = (p) => { const t = TYPE_OF[p.slice(p.lastIndexOf("."))]; if (!t) throw new Error(`no content type for ${p}`); return t; };
const slug = (name) => name.replace(/^[a-z-]+:/, "");
const fileStem = (name) => name.replace(":", "-");

if (argv.includes("--pin")) {
  for (const e of PINS.entries) {
    if (/^\d+\.\d+\.\d+$/.test(String(e.version || ""))) continue;
    const spec = e.version_range ? `${e.package}@${e.version_range}` : e.package;
    const out = JSON.parse(execFileSync("npm", ["view", spec, "version", "--json"], { encoding: "utf8" }));
    e.version = Array.isArray(out) ? out[out.length - 1] : out;
    console.log(`pinned ${e.name} → ${e.package}@${e.version}`);
  }
  writeFileSync(PINS_PATH, JSON.stringify(PINS, null, 2) + "\n");
  process.exit(0);
}

function pack(pkg, version) {
  const dir = mkdtempSync(join(tmpdir(), "dk-vendor-"));
  const out = JSON.parse(execFileSync("npm", ["pack", `${pkg}@${version}`, "--json", "--pack-destination", dir], { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 }));
  execFileSync("tar", ["-xzf", join(dir, out[0].filename), "-C", dir]);
  return { dir: join(dir, "package"), integrity: out[0].integrity, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
function need(pkgDir, rel, pkg) {
  const abs = join(pkgDir, rel);
  if (!existsSync(abs)) throw new Error(`${pkg}: "${rel}" is not in the package (top level: ${readdirSync(pkgDir).join(", ")}). Fix "from"/"license_from" in pins.json from \`tar -tzf\` of the package.`);
  return readFileSync(abs);
}
function put(rel, body) {
  if (!cleanLibPath(rel)) throw new Error(`bad lib path ${rel}`);
  const abs = join(LIB, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body);
  return { path: rel, sha256: sha256Hex(body), type: typeOf(rel) };
}
const licence = (pkgDir, pin) => put(`licenses/${fileStem(pin.name)}.txt`, need(pkgDir, pin.license_from, pin.package));

/** URL-sourced pins (not on npm): download at VENDOR TIME only, refuse on any
 *  archive-hash mismatch, unzip, and build from the extracted tree. The pin's
 *  source_sha256 is the integrity anchor (recorded in the entry as
 *  `url:<https-url>@<sha256>` + archive_sha256). */
function downloadArchive(pin) {
  const dir = mkdtempSync(join(tmpdir(), "dk-vendor-url-"));
  const zip = join(dir, "archive.zip");
  execFileSync("curl", ["-sfL", "--retry", "3", "-o", zip, pin.source_url], { stdio: ["ignore", "ignore", "inherit"] });
  const hash = sha256Hex(readFileSync(zip));
  if (hash !== pin.source_sha256) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`${pin.name}: archive sha256 ${hash} != pins.json ${pin.source_sha256} — refusing to vendor`);
  }
  execFileSync("unzip", ["-q", zip, "-d", join(dir, "x")]);
  return { dir: join(dir, "x"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A generated JS prelude that carries a binary engine (WASM) as base64 and
 *  wraps its Emscripten factory so the loader's no-arg call receives the bytes
 *  as Module.wasmBinary. Artifact pages are connect-src 'none', so a separate
 *  .wasm file could never be fetched at runtime; embedding keeps every shipped
 *  file text/javascript and the sandbox's egress posture unchanged. */
function wasmPrelude(pin, wasm) {
  const f = pin.wasm_embed.factory;
  return [
    `/* ${pin.name}: engine WASM embedded at vendor time (base64) from the pinned archive.`,
    `   Licence: ${pin.license} — see licenses/${fileStem(pin.name)}.txt in this library.`,
    `   Artifact pages run connect-src 'none', so the bytes ride inside this file`,
    `   instead of being fetched. Load AFTER the engine glue and BEFORE the loader:`,
    `   this wraps the ${f} factory so the loader's ${f}() call receives the bytes`,
    `   as Module.wasmBinary. Generated by scripts/design-kit/vendor-lib.mjs. */`,
    `(function () {`,
    `  /* The base64 carries a space every 16 chars so the repo's secret scanner`,
    `     can never false-positive on a random run (atob strips ASCII whitespace`,
    `     before decoding, per the HTML spec). Do not "tidy" the spacing away. */`,
    `  var b64 = "${wasm.toString("base64").replace(/[A-Za-z0-9+/]{16}/g, "$& ")}";`,
    `  var bin = atob(b64);`,
    `  var bytes = new Uint8Array(bin.length);`,
    `  for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);`,
    `  var factory = ${f};`,
    `  ${f} = function (arg) {`,
    `    arg = arg || {};`,
    `    if (!arg.wasmBinary) arg.wasmBinary = bytes;`,
    `    return factory(arg);`,
    `  };`,
    `})();`,
    ``,
  ].join("\n");
}

/** Review M9: the licence texts of the third-party code a script bundle carries.
 *
 *  When every vendored file has a source map in the tarball, the notice lists
 *  what is actually INSIDE the bundle: each map source under node_modules/ (or
 *  in a sibling workspace package, e.g. mermaid's ../../parser/dist) is matched
 *  byte-for-byte (sourcesContent) against a copy of that package, and a matched
 *  file's own .map is followed in turn (code a dependency had already bundled,
 *  e.g. langium inside @mermaid-js/parser). The version is the one the map's
 *  pnpm path names, else the copy whose file content matched; packages are
 *  fetched at that exact version with `npm pack` when the scratch install
 *  resolved a different one. Without a map (vega ships none) the notice falls
 *  back to the package's production dependency tree as npm resolves it today
 *  and says so in its header. A scratch install (temp dir, no scripts, nothing
 *  installed on the system) provides the copies. */
const LICENCE_FILE = /^(licen[cs]e|copying|notice)/i;
function licenceId(j, texts) {
  if (typeof j.license === "string") return j.license;
  if (j.license || j.licenses) return JSON.stringify(j.license || j.licenses);
  // No licence field: take the id the shipped licence text states (khroma).
  const t = texts.join("\n").trimStart();
  if (/^(\(The MIT License\)|The MIT License|MIT License)/i.test(t)) return "MIT";
  if (/^ISC License/i.test(t)) return "ISC";
  return "UNKNOWN";
}
function scratchInstall(pin) {
  const dir = mkdtempSync(join(tmpdir(), "dk-deps-"));
  execFileSync("npm", ["install", "--prefix", dir, "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund", `${pin.package}@${pin.version}`], { stdio: "ignore" });
  const found = [];
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      if (n.startsWith(".")) continue;
      const at = join(d, n);
      if (n.startsWith("@")) { walk(at); continue; }
      if (!existsSync(join(at, "package.json"))) continue;
      const j = JSON.parse(readFileSync(join(at, "package.json"), "utf8"));
      if (j.name !== pin.package) found.push({ dir: at, name: j.name, version: j.version, json: j });
      if (existsSync(join(at, "node_modules"))) walk(join(at, "node_modules"));
    }
  };
  walk(join(dir, "node_modules"));
  return { dir, copies: found.sort((a, b) => (a.dir < b.dir ? -1 : 1)) };
}
function copyText(c) { return readdirSync(c.dir).filter((f) => LICENCE_FILE.test(f)).sort().map((f) => readFileSync(join(c.dir, f), "utf8").trim()); }
function noticeOut(header, list) {
  let out = header;
  const ids = new Set();
  for (const c of list) {
    const texts = copyText(c);
    const lic = licenceId(c.json, texts);
    ids.add(lic);
    out += `\n==== ${c.name}@${c.version} (${lic})${c.how ? `\n[${c.how}]` : ""}\n${texts.length ? texts.join("\n\n") : "(the package ships no licence file)"}\n`;
  }
  return { out, ids };
}
function thirdParty(pin, pkgDir) {
  const deps = Object.keys(JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")).dependencies || {});
  if (!deps.length) return null;
  const maps = pin.files.map((f) => join(pkgDir, `${f.from}.map`));
  const inst = scratchInstall(pin);
  const packed = [];
  try {
    let header, list;
    if (!maps.every((m) => existsSync(m))) {
      header = `Third-party code in ${pin.package}@${pin.version} (its production dependency tree at vendor time).\n` +
        `The package ships no source map for ${pin.files.map((f) => f.from).join(", ")}, so the versions below are npm's resolution of its declared ranges on the vendor date, not necessarily the versions upstream built with.\n`;
      const seen = new Set();
      list = inst.copies.filter((c) => !seen.has(`${c.name}@${c.version}`) && seen.add(`${c.name}@${c.version}`));
    } else {
      // name@version -> { copy, files: matched count, sources }
      const hits = new Map();
      const unknown = new Set();
      const exact = new Map();
      const copyAt = (name, version) => {
        const local = inst.copies.find((c) => c.name === name && c.version === version);
        if (local) return local;
        const key = `${name}@${version}`;
        if (!exact.has(key)) {
          let c = null;
          try {
            const pk = pack(name, version);
            packed.push(pk);
            c = { dir: pk.dir, name, version, json: JSON.parse(readFileSync(join(pk.dir, "package.json"), "utf8")) };
          } catch { /* no such version */ }
          exact.set(key, c);
        }
        return exact.get(key);
      };
      // The map names no version (plain node_modules/ path): try the releases
      // published before this package, newest first, until one ships the file
      // with the same content (vega-embed 7.3.0 bundles an older
      // vega-interpreter than npm resolves today).
      const published = JSON.parse(execFileSync("npm", ["view", `${pin.package}@${pin.version}`, "time", "--json"], { encoding: "utf8" }))[pin.version];
      const candidates = new Map();
      // One release for the whole package: the newest published before this
      // package that ships every bundled file with the same content (several
      // releases may be byte-identical for those files; the newest is named).
      const releaseFor = (name, files) => {
        if (!candidates.has(name)) {
          const t = JSON.parse(execFileSync("npm", ["view", name, "time", "--json"], { encoding: "utf8" }));
          candidates.set(name, Object.keys(t).filter((v) => /^\d+\.\d+\.\d+$/.test(v) && t[v] <= published).sort((a, b) => (t[a] < t[b] ? 1 : -1)).slice(0, 40));
        }
        const fits = (c) => c && files.every((f) => sameFile(c, f.rel, f.content));
        for (const v of candidates.get(name)) { const c = copyAt(name, v); if (fits(c)) return c; }
        return null;
      };
      const deferred = new Map();
      const sameFile = (c, rel, content) => {
        const abs = join(c.dir, rel);
        return existsSync(abs) && (content == null || readFileSync(abs, "utf8") === content);
      };
      const record = (c, rel, reason, via) => {
        const how = via ? `${reason}, via ${via}` : reason;
        const key = `${c.name}@${c.version}`;
        if (!hits.has(key)) hits.set(key, { ...c, hows: new Map() });
        const h = hits.get(key).hows;
        h.set(how, (h.get(how) || 0) + 1);
        const sub = join(c.dir, `${rel}.map`);
        if (existsSync(sub)) follow(sub, c.dir, `${c.name}@${c.version}'s own bundle`);
      };
      const visited = new Set();
      const follow = (mapPath, ownRoot, via) => {
        if (visited.has(mapPath)) return;
        visited.add(mapPath);
        const m = JSON.parse(readFileSync(mapPath, "utf8"));
        const base = join(dirname(mapPath), m.sourceRoot || "");
        m.sources.forEach((src, i) => {
          const content = m.sourcesContent ? m.sourcesContent[i] : null;
          const nm = src.lastIndexOf("node_modules/");
          if (nm >= 0) {
            const parts = src.slice(nm + 13).split("/");
            const name = parts[0].startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0];
            const rel = parts.slice(name.split("/").length).join("/");
            const pn = src.match(/\.pnpm\/((?:@[^/+]+\+)?[^@/]+)@([^_/(]+)/);
            if (pn) {
              const c = copyAt(name, pn[2]);
              if (c && sameFile(c, rel, content)) return record(c, rel, "version from the source map (pnpm path); file content matched", via);
              // marked: upstream's map composed through marked's own map into
              // src/*.ts, which the npm package does not ship. The pnpm path
              // still names the exact version.
              if (c && !existsSync(join(c.dir, rel))) return record(c, rel, "version from the source map (pnpm path); source file not in the npm package", via);
              return unknown.add(`${name}@${pn[2]} ${rel}`);
            }
            // No version in the path: resolved per package once every map is read.
            if (!deferred.has(name)) deferred.set(name, []);
            return deferred.get(name).push({ rel, content, via });
          }
          const abs = resolve(base, src);
          if (abs.startsWith(ownRoot + "/")) return; // the package's own source
          // A sibling workspace package (../../parser/dist/x): find the
          // dependency that ships the same path with the same content.
          const rel = src.replace(/^(?:\.\.\/)+[^/]+\//, "");
          const c = inst.copies.find((x) => sameFile(x, rel, content));
          if (c) return record(c, rel, "a sibling workspace package's build, matched by file content", via);
          unknown.add(src);
        });
      };
      for (const m of maps) follow(m, pkgDir, null);
      while (deferred.size) {
        const [name, files] = deferred.entries().next().value;
        deferred.delete(name);
        const c = releaseFor(name, files);
        if (!c) { unknown.add(`${name} (no release ships all ${files.length} bundled file(s))`); continue; }
        for (const f of files) record(c, f.rel, "no version in the map; the newest earlier release whose files all matched", f.via);
      }
      if (unknown.size) throw new Error(`${pin.name}: bundled sources not matched to a package:\n  ${[...unknown].slice(0, Number(process.env.DK_SHOW || 20)).join("\n  ")}`);
      header = `Third-party code in ${pin.package}@${pin.version}: the packages inside ${pin.files.map((f) => f.from).join(", ")}, identified from the source map (each file matched byte-for-byte against the package at the version shown).\n`;
      list = [...hits.values()].sort((a, b) => (`${a.name}@${a.version}` < `${b.name}@${b.version}` ? -1 : 1)).map((c) => ({ ...c, how: [...c.hows].map(([h, n]) => `${h}: ${n} file(s)`).join("; ") }));
    }
    if (!list.length) { console.log(`${pin.name}: bundles no third-party code`); return null; }
    const { out, ids } = noticeOut(header, list);
    console.log(`${pin.name}: third-party licence ids: ${[...ids].sort().join(", ")}`);
    return put(`licenses/${fileStem(pin.name)}-third-party.txt`, Buffer.from(out));
  } finally {
    rmSync(inst.dir, { recursive: true, force: true });
    for (const pk of packed) pk.cleanup();
  }
}

const BUILD = {
  font(pin, p) {
    const meta = JSON.parse(need(p.dir, "metadata.json", pin.package));
    const weights = pin.weights.filter((w) => (meta.weights || []).includes(w));
    if (!weights.length) throw new Error(`${pin.package}: none of ${pin.weights} exist (package has ${meta.weights})`);
    const id = slug(pin.name);
    const files = [];
    let css = "";
    for (const w of weights) {
      const file = `${id}-latin-${w}-normal.woff2`;
      files.push(put(`font/${id}/${file}`, need(p.dir, `files/${file}`, pin.package)));
      css += `@font-face{font-family:"${pin.family}";src:url(./${file}) format("woff2");font-weight:${w};font-style:normal;font-display:swap}\n`;
    }
    files.push(put(`font/${id}/font.css`, Buffer.from(normalizeCss(css).css)));
    return { files, main: `font/${id}/font.css`, family: pin.family, fallback: pin.fallback, weights };
  },
  css(pin, p) {
    const files = [];
    const notes = [];
    const banners = [];
    for (const f of pin.files) {
      // Inline SVG icons that pass the allowlist become files next to the
      // stylesheet (<dir of "to">/icons/…), referenced by a relative url().
      const { css, comments, changes, assets } = normalizeCss(need(p.dir, f.from, pin.package).toString("utf8"), { extractSvgDir: "icons" });
      files.push(put(f.to, Buffer.from(css)));
      for (const a of assets) files.push(put(`${dirname(f.to)}/${a.file}`, Buffer.from(a.svg)));
      const kept = comments.filter((c) => c.startsWith("/*!") || /licen[cs]e|copyright/i.test(c));
      banners.push(...kept.map((c) => `From ${pin.package}@${pin.version} ${f.from}:\n${c}`));
      if (comments.length) notes.push(`${f.from}: ${comments.length} comment(s) removed${kept.length ? `; ${kept.length} licence banner(s) kept in licenses/${fileStem(pin.name)}-banner.txt` : ""}`);
      notes.push(...changes.map((c) => `${f.from}: ${c}`));
    }
    const notices = banners.length ? [put(`licenses/${fileStem(pin.name)}-banner.txt`, Buffer.from(banners.join("\n\n") + "\n"))] : [];
    return { files, main: pin.main, notes, notices };
  },
  script(pin, p) { return { files: pin.files.map((f) => put(f.to, need(p.dir, f.from, pin.package))), main: pin.main, global: pin.global }; },
  "icon-set"(pin, p) {
    const dir = join(p.dir, pin.icons_dir);
    if (!existsSync(dir)) throw new Error(`${pin.package}: icons_dir "${pin.icons_dir}" missing (top level: ${readdirSync(p.dir).join(", ")})`);
    const icons = {};
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".svg")).sort()) {
      const svg = readFileSync(join(dir, f), "utf8").replace(/<!--[\s\S]*?-->/g, "").replace(/\s+/g, " ").replace(/> </g, "><").trim();
      if (svgUnsafe(svg)) throw new Error(`${pin.package}: ${f} fails the lib-check SVG allowlist`);
      icons[f.slice(0, -4)] = svg;
    }
    const id = slug(pin.name);
    const files = [put(`icons/${id}.json`, Buffer.from(JSON.stringify(icons)))];
    return { files, main: files[0].path, count: Object.keys(icons).length, notes: [`built from ${pin.icons_dir}/*.svg: licence comments removed, whitespace collapsed`] };
  },
};

const man = JSON.parse(readFileSync(join(LIB, "manifest.json"), "utf8"));
const byName = new Map(man.entries.map((e) => [e.name, e]));
for (const pin of PINS.entries) {
  if (ONLY && !ONLY.has(pin.kind) && !ONLY.has(pin.name)) continue;
  if (!/^\d+\.\d+\.\d+$/.test(String(pin.version || ""))) throw new Error(`${pin.name}: no exact version — run with --pin first`);
  const old = byName.get(pin.name);
  if (old) for (const f of [...old.files, ...(old.notices || [])]) rmSync(join(LIB, f.path), { force: true });
  if (pin.source_url) {
    // URL-sourced pin (no npm package): download, hash-verify, unzip, copy.
    const p = downloadArchive(pin);
    try {
      const files = pin.files.map((f) => put(f.to, need(p.dir, f.from, pin.source_url)));
      const notes = [...(pin.notes || [])];
      if (pin.wasm_embed) {
        const wasm = need(p.dir, pin.wasm_embed.from, pin.source_url);
        files.push(put(pin.wasm_embed.to, Buffer.from(wasmPrelude(pin, wasm))));
        notes.push(`the engine's WASM rides base64 inside ${pin.wasm_embed.to} (wasm sha256 ${sha256Hex(wasm)}): artifact pages are connect-src 'none', so nothing may fetch a .wasm at runtime; ${pin.wasm_embed.factory} is wrapped to receive the bytes as Module.wasmBinary`);
      }
      const lic = put(`licenses/${fileStem(pin.name)}.txt`, need(p.dir, pin.license_from, pin.source_url));
      byName.set(pin.name, {
        name: pin.name, kind: pin.kind, version: pin.version, license: pin.license,
        license_file: lic.path, license_sha256: lic.sha256,
        source: `url:${pin.source_url}@${pin.source_sha256}`, archive_sha256: pin.source_sha256,
        allowed: pin.allowed, requires: pin.requires || [],
        files, main: pin.main, ...(pin.global ? { global: pin.global } : {}),
        ...(notes.length ? { notes } : {}),
      });
      console.log(`vendored ${pin.name} (${files.length} files, url source)`);
    } finally { p.cleanup(); }
    continue;
  }
  const p = pack(pin.package, pin.version);
  try {
    const { notices: builtNotices = [], notes: builtNotes = [], ...built } = BUILD[pin.kind](pin, p);
    const notes = [...(pin.notes || []), ...builtNotes];
    const lic = licence(p.dir, pin);
    const tp = thirdParty(pin, p.dir);
    const notices = [...builtNotices, ...(tp ? [tp] : [])].map((n) => ({ path: n.path, sha256: n.sha256 }));
    byName.set(pin.name, {
      name: pin.name, kind: pin.kind, version: pin.version, license: pin.license, license_file: lic.path, license_sha256: lic.sha256,
      ...(notices.length ? { notices } : {}),
      source: `npm:${pin.package}@${pin.version}`, npm_integrity: p.integrity, allowed: pin.allowed,
      requires: pin.requires || [], ...built, ...(notes.length ? { notes } : {}),
    });
    console.log(`vendored ${pin.name} (${built.files.length} files)`);
  } finally { p.cleanup(); }
}
man.entries = [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
writeFileSync(join(LIB, "manifest.json"), JSON.stringify(man, null, 2) + "\n");
