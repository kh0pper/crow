// Design kit (spec §3.2, §7): the library manifest integrity rules CI enforces —
// every hash, every licence file, exact pins, and no runtime fetch.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { checkLib, checkNoRemoteRefs, cssFetches, svgUnsafe, sha256Hex } from "../bundles/design-kit/server/lib-check.js";

const ROOT = new URL("..", import.meta.url).pathname;

function fixture(mutate = () => {}) {
  const dir = mkdtempSync(join(tmpdir(), "dk-lib-"));
  const lib = join(dir, "lib");
  mkdirSync(join(lib, "css", "demo"), { recursive: true });
  mkdirSync(join(lib, "licenses"), { recursive: true });
  const css = Buffer.from(":root{--x:1}.a{background:url(data:image/png;base64,AA)}");
  writeFileSync(join(lib, "css", "demo", "demo.css"), css);
  writeFileSync(join(lib, "licenses", "demo.txt"), "MIT License\n");
  const man = {
    schema: 1, kit_version: "1.0.0", meta_files: [],
    entries: [{
      name: "css:demo", kind: "css", version: "1.2.3", license: "MIT", license_file: "licenses/demo.txt", license_sha256: sha256Hex(Buffer.from("MIT License\n")),
      source: "npm:demo-css@1.2.3", allowed: ["page", "document", "diagram"],
      files: [{ path: "css/demo/demo.css", sha256: sha256Hex(css), type: "text/css" }], main: "css/demo/demo.css", requires: [],
    }],
  };
  mutate(man, lib);
  writeFileSync(join(lib, "manifest.json"), JSON.stringify(man));
  return { dir, lib, done: () => rmSync(dir, { recursive: true, force: true }) };
}
const errsOf = (mutate) => { const f = fixture(mutate); try { return checkLib(f.lib).errors.join("\n"); } finally { f.done(); } };

test("a clean fixture passes", () => {
  assert.equal(errsOf(() => {}), "");
});

test("each rule fails with a named reason", () => {
  assert.match(errsOf((m) => { m.entries[0].files[0].sha256 = "0".repeat(64); }), /sha256 mismatch/);
  assert.match(errsOf((m, lib) => writeFileSync(join(lib, "css", "stray.css"), "x")), /unlisted file in lib\/: css\/stray\.css/);
  assert.match(errsOf((m) => { m.entries[0].license_file = "licenses/none.txt"; }), /licence file missing/);
  assert.match(errsOf((m) => { m.entries[0].license_sha256 = "0".repeat(64); }), /licence sha256 mismatch/);
  assert.match(errsOf((m, lib) => { m.entries[0].notices = [{ path: "licenses/demo-third-party.txt", sha256: "0".repeat(64) }]; writeFileSync(join(lib, "licenses", "demo-third-party.txt"), "x"); }), /sha256 mismatch for licenses\/demo-third-party\.txt/);
  assert.match(errsOf((m) => { m.entries[0].notices = [{ path: "css/demo/demo.css", sha256: "0".repeat(64) }]; }), /notices must live under licenses\//);
  assert.match(errsOf((m) => { m.entries[0].license = "CC-BY-NC-4.0"; }), /not on the allowlist/);
  assert.match(errsOf((m) => { m.entries[0].version = "^1.2.3"; }), /exact x\.y\.z/);
  assert.match(errsOf((m) => { m.entries[0].source = "npm:demo-css@latest"; }), /exact pin/);
  assert.match(errsOf((m) => { m.entries[0].allowed = ["slides"]; }), /subset of page, document, diagram/);
  assert.match(errsOf((m) => { m.entries[0].requires = ["css:ghost"]; }), /requires unknown css:ghost/);
  assert.match(errsOf((m) => { m.entries[0].name = "demo"; }), /does not match kind css/);
  assert.match(errsOf((m) => { m.entries[0].main = "css/demo/other.css"; }), /main must be one of its files/);
  assert.match(errsOf((m) => { m.entries.push({ ...m.entries[0] }); }), /duplicate name/);
  assert.match(errsOf((m) => { m.entries[0].files[0].type = "text/html"; }), /type text\/html not allowed/);
});

test("font entries need a plain family and a generic fallback", () => {
  const font = (extra) => (m, lib) => {
    const woff = Buffer.from("wOF2fake");
    mkdirSync(join(lib, "font", "demo"), { recursive: true });
    writeFileSync(join(lib, "font", "demo", "demo-latin-400-normal.woff2"), woff);
    m.entries.push({ name: "font:demo", kind: "font", version: "5.0.0", license: "OFL-1.1", license_file: "licenses/demo.txt", license_sha256: sha256Hex(Buffer.from("MIT License\n")), source: "npm:@fontsource/demo@5.0.0",
      allowed: ["page"], files: [{ path: "font/demo/demo-latin-400-normal.woff2", sha256: sha256Hex(woff), type: "font/woff2" }], main: "font/demo/demo-latin-400-normal.woff2", requires: [], ...extra });
  };
  assert.equal(errsOf(font({ family: "Demo Sans", fallback: "sans-serif" })), "");
  assert.match(errsOf(font({ family: "Demo\";}body{", fallback: "sans-serif" })), /family/);
  assert.match(errsOf(font({ family: "Demo", fallback: "url(x)" })), /fallback/);
});

test("CSS that would fetch is refused; data: and relative urls are fine", () => {
  assert.equal(cssFetches("a{background:url(data:image/png;base64,AA)} b{src:url(./x.woff2)}"), false);
  assert.equal(cssFetches("@import 'x.css';"), true);
  assert.equal(cssFetches("a{background:url( 'https://evil.example/x.png')}"), true);
  assert.equal(cssFetches("a{background:url(//evil.example/x.png)}"), true);
  assert.match(errsOf((m, lib) => {
    const css = Buffer.from("a{background:url(https://evil.example/x.png)}");
    writeFileSync(join(lib, "css", "demo", "demo.css"), css);
    m.entries[0].files[0].sha256 = sha256Hex(css);
  }), /would fetch at runtime/);
});

test("kit code and skills may not name remote hosts (loopback is fine)", () => {
  const dir = mkdtempSync(join(tmpdir(), "dk-refs-"));
  try {
    mkdirSync(join(dir, "server")); mkdirSync(join(dir, "skills")); mkdirSync(join(dir, "renderer", "engines"), { recursive: true });
    writeFileSync(join(dir, "server", "kit.js"), "const u = 'http://127.0.0.1:8018';");
    writeFileSync(join(dir, "skills", "a.md"), "Use the kit.");
    writeFileSync(join(dir, "renderer", "engines", "x.mjs"), "// nothing remote");
    assert.deepEqual(checkNoRemoteRefs(dir), []);
    writeFileSync(join(dir, "skills", "a.md"), "Load https://cdn.example/lib.js");
    assert.match(checkNoRemoteRefs(dir).join("\n"), /skills\/a\.md names a remote URL/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the CLI exits 1 on a broken fixture and 0 on a clean one", () => {
  const f = fixture();
  const root = mkdtempSync(join(tmpdir(), "dk-root-"));
  try {
    mkdirSync(join(root, "bundles", "design-kit"), { recursive: true });
    cpSync(f.lib, join(root, "bundles", "design-kit", "lib"), { recursive: true });
    const ok = spawnSync(process.execPath, [join(ROOT, "scripts", "check-design-kit-lib.mjs"), "--root", root], { encoding: "utf8" });
    assert.equal(ok.status, 0, ok.stderr);
    writeFileSync(join(root, "bundles", "design-kit", "lib", "css", "demo", "demo.css"), "changed");
    const bad = spawnSync(process.execPath, [join(ROOT, "scripts", "check-design-kit-lib.mjs"), "--root", root], { encoding: "utf8" });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /sha256 mismatch/);
  } finally { f.done(); rmSync(root, { recursive: true, force: true }); }
});

test("the repo's own lib/ passes", () => {
  const r = checkLib(join(ROOT, "bundles", "design-kit", "lib"));
  assert.deepEqual(r.errors, []);
  assert.deepEqual(checkNoRemoteRefs(join(ROOT, "bundles", "design-kit")), []);
});

test("cssFetches fails closed on whitespace, escapes, image-set, src() and bare @import strings", () => {
  for (const css of [
    "a{background:url(\t'https://evil.example/x.png')}",
    "a{background:url(\n//evil.example/x.png)}",
    "a{background:url(\f\"https://evil.example/x.png\")}",
    "a{background:url(h\\74tps://evil.example/x.png)}",
    "a{background:url(./x\\.png)}",
    "a{background:image-set(\"https://evil.example/x.png\" 1x)}",
    "a{background:image-set(\"a.png\" 1x, \"//evil.example/b.png\" 2x)}",
    "a{background:-webkit-image-set(\n'ftp://evil.example/x.png' 1x)}",
    "a{background:src(\"https://evil.example/x.png\")}",
    "@import \"x.css\";",
    "@\\69mport 'x.css';",
  ]) assert.equal(cssFetches(css), true, css);
  for (const css of [
    "a{background:url(\n./x.png)}",
  ]) assert.equal(cssFetches(css), false, css);
});

test("remote-URL scan catches protocol-relative, other schemes and userinfo tricks", () => {
  const dir = mkdtempSync(join(tmpdir(), "dk-refs2-"));
  try {
    mkdirSync(join(dir, "server")); mkdirSync(join(dir, "skills"));
    const bad = (body) => { writeFileSync(join(dir, "server", "k.js"), body); return checkNoRemoteRefs(dir).length; };
    assert.equal(bad("const u = 'http://localhost:8018/x'; // note\nconst v = 'http://[::1]:80/'"), 0);
    assert.equal(bad("fetch('//evil.example/x.js')"), 1);
    assert.equal(bad("new WebSocket('wss://evil.example/s')"), 1);
    assert.equal(bad("const u = 'ftp://evil.example/f'"), 1);
    assert.equal(bad("const u = 'http://localhost:80@evil.example/'"), 1);
    assert.equal(bad("const u = 'http://127.0.0.1@evil.example/'"), 1);
    assert.equal(bad("const u = 'http://127.0.0.1.evil.example/'"), 1);
    assert.equal(bad("const u = 'HTTP://Evil.example/'"), 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("meta_files types are checked and licence files must live under licenses/", () => {
  assert.match(errsOf((m, lib) => {
    writeFileSync(join(lib, "meta.html"), "<p>x</p>");
    m.meta_files = [{ path: "meta.html", sha256: sha256Hex(Buffer.from("<p>x</p>")), type: "text/html" }];
  }), /meta_files: meta\.html: type text\/html not allowed/);
  assert.match(errsOf((m, lib) => {
    writeFileSync(join(lib, "css", "LICENSE"), "MIT License\n");
    m.entries[0].license_file = "css/LICENSE";
  }), /licence file must live under licenses\//);
});

test("cssFetches refuses comments and escapes outside strings, and image() targets", () => {
  for (const css of [
    "a{b:url(/**/\"https://e.x/a\")}",
    "a{b:u\\72l(https://e.x/a)}",
    "a{b:image-s\\65t(\"https://e.x/a\" 1x)}",
    "a{b:s\\72c(\"https://e.x/a\")}",
    "a{b:image(\"https://e.x/a\")}",
    "a{b:image(//e.x/a)}",
    "/* note */ a{color:red}",
  ]) assert.equal(cssFetches(css), true, css);
  // A backslash inside a quoted string (an icon-font content escape) is plain data.
  assert.equal(cssFetches(".i:before{content:\"\\e900\"}"), false);
});

const R = "https://e.x/a";
test("fail-closed CSS allowlist: every probed bypass is refused", () => {
  const bad = {
    "CR ends a string, then escaped url": `a{content:"x\r}b{c:u\\72l(${R})}`,
    "FF ends a string, then escaped url": `a{content:"x\f}b{c:u\\72l(${R})}`,
    "CR ends a string, then comment": `a{content:"x\r}/**/b{c:url(${R})}`,
    "TAB in a quoted scheme": `a{b:url("ht\ttps://e.x/a")}`,
    "C0 control before a quoted url": `a{b:url("\x01${R}")}`,
    "TAB in image() string": `a{b:image("ht\ttps://e.x/a")}`,
    "NUL in a scheme": `a{b:url("ht\0tps://e.x/a")}`,
    "DEL": `a{b:url(./x\x7f.png)}`,
    "; inside an earlier image-set string": `a{b:image-set("a;b" 1x,"${R}" 2x)}`,
    "} inside an earlier image-set string": `a{b:image-set("a}b" 1x,"${R}" 2x)}`,
    "mixed quotes in image-set": `a{b:image-set("it's" 1x,'${R}' 2x)}`,
    "var() string in image-set": `:root{--u:"${R}"}a{b:image-set(var(--u) 1x)}`,
    "var() string in image()": `:root{--u:"${R}"}a{b:image(var(--u))}`,
    "var() string in src()": `:root{--u:"${R}"}@font-face{font-family:x;src:src(var(--u))}`,
    "attr() in image-set": `a{b:image-set(attr(data-u) 1x)}`,
    "-webkit-image-set": `a{b:-webkit-image-set("${R}" 1x)}`,
    "cross-fade": `a{b:cross-fade(url(${R}),url(x))}`,
    "element()": `a{b:element(#x)}`,
    "@import url with layer": `@import url(${R}) layer(x) screen;`,
    "upper-case @IMPORT": `@IMPORT "${R}";`,
    "upper-case URL(": `a{b:URL(${R})}`,
    "@namespace url": `@namespace url(http://www.w3.org/1999/xhtml);`,
    "@namespace string": `@namespace "http://www.w3.org/1999/xhtml";`,
    "var url": `:root{--x:url(${R})}`,
    "content url": `a:before{content:url(${R})}`,
    "src url format": `@font-face{font-family:x;src:url(${R}) format("woff2")}`,
    "svg data url": `a{b:url("data:image/svg+xml,<svg><image href='${R}'/></svg>")}`,
    "unterminated string": `a{b:url("${R}`,
    "newline in a quoted url": `a{b:url("\n${R}")}`,
    "absolute path": `a{b:url(/x.png)}`,
    "double slash": `a{b:url(x//y.png)}`,
    "query char": `a{b:url(./x.png?a=1)}`,
    "colon in a string": `a{content:"see https://example.org"}`,
    "leading // in a string": `a{content:" //e.x/a"}`,
    "UTF-8 BOM": `\ufeffa{b:url(./x.png)}`,
    "UTF-16 BOM decoded as UTF-8": Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`a{b:url(${R})}`, "utf16le")]),
    "UTF-8 BOM bytes": Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("a{b:red}")]),
    "invalid UTF-8": Buffer.from([0x61, 0x7b, 0xc3, 0x28, 0x7d]),
    "CRLF": "a{b:red}\r\nc{d:red}",
  };
  for (const [k, v] of Object.entries(bad)) assert.equal(cssFetches(v), true, k);
});

test("fail-closed CSS allowlist: the shapes Task 2 vendors still pass", () => {
  const ok = {
    "fontsource font-face": `@font-face{font-family:'Inter';font-style:normal;font-display:swap;font-weight:400;src:url(./files/inter-latin-400-normal.woff2) format('woff2'),url(./files/inter-latin-400-normal.woff) format("woff");unicode-range:U+0000-00FF,U+0131}\n`,
    "src local": `@font-face{font-family:x;src:local(Foo),url(./x.woff2)}`,
    "open-props style": `:where(html){--size-1:.25rem;--gradient-1:linear-gradient(to bottom right,#1f005c,#5b0060);--ease-1:cubic-bezier(.25,0,.5,1);--font-mono:ui-monospace,"Cascadia Code",monospace}\n@media (prefers-color-scheme:dark){:root{color-scheme:dark}}\n.a::after{content:"\\e900"}`,
    "pico style": `a{--pico-x:calc(1rem*2)}\n:is(button,[type=submit]):focus{box-shadow:0 0 0 .1rem var(--pico-primary-focus)}\n@media (min-width:768px){.grid{grid-template-columns:repeat(auto-fit,minmax(0%,1fr))}}`,
    "relative targets": `a{b:url("../img/a-b_c.png")} c{d:url( ./a/b.svg )} e{f:url(x.png)}`,
    "raster data url": `a{background:url(data:image/png;base64,iVBORw0KGgo=)}`,
  };
  for (const [k, v] of Object.entries(ok)) assert.equal(cssFetches(v), false, k);
});

test("svgUnsafe: plain icon SVGs pass, active or fetching content does not", () => {
  const lucide = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"\n\tstroke-linecap="round" stroke-linejoin="round">\r\n  <path d="M20 6 9 17l-5-5"/><circle cx="12" cy="12" r="3"/>\n</svg>\n`;
  assert.equal(svgUnsafe(lucide), false);
  assert.equal(svgUnsafe(`<svg xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g"/></defs><rect fill="url(#g)"/><use href="#g"/></svg>`), false);
  for (const [k, v] of Object.entries({
    style: `<svg><style>a{}</style></svg>`,
    import: `<svg><style>@import "x"</style></svg>`,
    "url(remote)": `<svg><rect fill="url(${R})"/></svg>`,
    "href remote": `<svg><image href="${R}"/></svg>`,
    "xlink:href remote": `<svg><use xlink:href="${R}"/></svg>`,
    "unquoted href": `<svg><use href=${R}/></svg>`,
    script: `<svg><SCRIPT>1</SCRIPT></svg>`,
    foreignObject: `<svg><foreignObject/></svg>`,
    "on attr": `<svg onload="x()"/>`,
    "on attr spaced": `<svg onclick = "x()"/>`,
    doctype: `<!DOCTYPE svg [<!ENTITY a "b">]><svg/>`,
    animate: `<svg><animate attributeName="href" to="${R}"/></svg>`,
    "BOM": "\ufeff<svg/>",
    NUL: "<svg\0/>",
  })) assert.equal(svgUnsafe(v), true, k);
});

test("checkLib applies the CSS and SVG allowlists to listed files", () => {
  assert.match(errsOf((m, lib) => {
    const css = Buffer.from("a{b:image-set(\"x.png\" 1x)}");
    writeFileSync(join(lib, "css", "demo", "demo.css"), css);
    m.entries[0].files[0].sha256 = sha256Hex(css);
  }), /would fetch at runtime/);
  assert.match(errsOf((m, lib) => {
    mkdirSync(join(lib, "icons"), { recursive: true });
    const svg = Buffer.from("<svg><script>1</script></svg>");
    writeFileSync(join(lib, "icons", "a.svg"), svg);
    m.entries[0].files.push({ path: "icons/a.svg", sha256: sha256Hex(svg), type: "image/svg+xml" });
  }), /icons\/a\.svg is not a plain SVG/);
});
