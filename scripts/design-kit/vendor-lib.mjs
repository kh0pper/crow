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

/** Review M9: the licence texts of the third-party code a package bundles. A
 *  scratch production install (temp dir, no scripts, nothing installed on the
 *  system) of the pinned package; every dependency's name, version, licence id
 *  and licence/NOTICE files go into licenses/<entry>-third-party.txt. Over-
 *  inclusive on purpose (a dependency not in the minified build costs nothing). */
function thirdParty(pin, pkgDir) {
  const deps = Object.keys(JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")).dependencies || {});
  if (!deps.length) return null;
  const dir = mkdtempSync(join(tmpdir(), "dk-deps-"));
  try {
    execFileSync("npm", ["install", "--prefix", dir, "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund", `${pin.package}@${pin.version}`], { stdio: "ignore" });
    const found = [];
    const walk = (d) => {
      for (const n of readdirSync(d)) {
        if (n.startsWith(".")) continue;
        const at = join(d, n);
        if (n.startsWith("@")) { walk(at); continue; }
        if (!existsSync(join(at, "package.json"))) continue;
        found.push(at);
        if (existsSync(join(at, "node_modules"))) walk(join(at, "node_modules"));
      }
    };
    walk(join(dir, "node_modules"));
    const seen = new Set();
    const ids = new Set();
    let out = `Third-party code in ${pin.package}@${pin.version} (its production dependency tree at vendor time).\n`;
    for (const at of found.sort()) {
      const j = JSON.parse(readFileSync(join(at, "package.json"), "utf8"));
      const key = `${j.name}@${j.version}`;
      if (j.name === pin.package || seen.has(key)) continue;
      seen.add(key);
      const lic = typeof j.license === "string" ? j.license : JSON.stringify(j.license || j.licenses || "UNKNOWN");
      ids.add(lic);
      const texts = readdirSync(at).filter((f) => /^(licen[cs]e|copying|notice)/i.test(f)).map((f) => readFileSync(join(at, f), "utf8").trim());
      out += `\n==== ${key} (${lic})\n${texts.length ? texts.join("\n\n") : "(the package ships no licence file)"}\n`;
    }
    console.log(`${pin.name}: third-party licence ids: ${[...ids].sort().join(", ")}`);
    return put(`licenses/${fileStem(pin.name)}-third-party.txt`, Buffer.from(out));
  } finally { rmSync(dir, { recursive: true, force: true }); }
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
  if (ONLY && !ONLY.has(pin.kind)) continue;
  if (!/^\d+\.\d+\.\d+$/.test(String(pin.version || ""))) throw new Error(`${pin.name}: no exact version — run with --pin first`);
  const old = byName.get(pin.name);
  if (old) for (const f of [...old.files, ...(old.notices || [])]) rmSync(join(LIB, f.path), { force: true });
  const p = pack(pin.package, pin.version);
  try {
    const { notices: builtNotices = [], notes = [], ...built } = BUILD[pin.kind](pin, p);
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
