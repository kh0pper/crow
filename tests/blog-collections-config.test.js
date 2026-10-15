/**
 * The blog collections config loader (servers/gateway/blog/collections-config.js).
 *
 * The /blog/research page and the post chapter-nav read an optional, owner-edited
 * JSON file. These tests pin the loader's contract: a missing file is the default
 * (off, silent), anything broken disables the feature without throwing, warnings
 * are deduplicated and never echo field values, and the schema is strict.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, chmodSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCollectionsConfig, collectionsConfigPath } from "../servers/gateway/blog/collections-config.js";
import { resolveCrowHome } from "../servers/shared/crow-home.js";

let dir;
let warns;
let origWarn;

function fixture(overrides = {}) {
  return {
    enabled: true,
    navTitle: "Notes",
    pageTitle: "Example collection",
    intro: "Long-form notes.",
    sections: [
      { kind: "case-studies", heading: "Entries", projectId: 2 },
      { kind: "tag", heading: "Field notes", tag: "field-notes" },
    ],
    ...overrides,
  };
}

function write(name, value) {
  const p = join(dir, name);
  writeFileSync(p, typeof value === "string" ? value : JSON.stringify(value));
  return p;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "blog-collections-"));
  warns = [];
  origWarn = console.warn;
  console.warn = (...args) => warns.push(args);
});

afterEach(() => {
  console.warn = origWarn;
  rmSync(dir, { recursive: true, force: true });
});

test("C1: a missing file is disabled and logs nothing", () => {
  const cfg = loadCollectionsConfig({ path: join(dir, "nope.json") });
  assert.equal(cfg.enabled, false);
  assert.equal(warns.length, 0);
});

test("C2: a valid neutral fixture parses and is enabled", () => {
  const p = write("ok.json", fixture());
  const cfg = loadCollectionsConfig({ path: p });
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.navTitle, "Notes");
  assert.equal(cfg.lang, "en", "lang defaults to en");
  assert.equal(cfg.sections.length, 2);
  assert.equal(cfg.sections[0].projectId, 2);
  assert.equal(cfg.sections[1].tag, "field-notes");
  assert.equal(cfg.sections[1].hideIfEmpty, true, "hideIfEmpty defaults to true");
  assert.equal(warns.length, 0);
});

test("C2b: enabled:false in a valid file is disabled", () => {
  const p = write("off.json", fixture({ enabled: false }));
  assert.equal(loadCollectionsConfig({ path: p }).enabled, false);
});

test("C3: invalid JSON warns once per (mtime, code), re-warns after a touch", () => {
  const p = write("bad.json", "{ not json");
  for (let i = 0; i < 5; i++) {
    assert.equal(loadCollectionsConfig({ path: p }).enabled, false);
  }
  assert.equal(warns.length, 1);
  const later = new Date(Date.now() + 5000);
  utimesSync(p, later, later);
  loadCollectionsConfig({ path: p });
  loadCollectionsConfig({ path: p });
  assert.equal(warns.length, 2);
});

test("C4: a file deleted after a successful load is disabled on the next call", () => {
  const p = write("gone.json", fixture());
  assert.equal(loadCollectionsConfig({ path: p }).enabled, true);
  rmSync(p);
  let cfg;
  assert.doesNotThrow(() => { cfg = loadCollectionsConfig({ path: p }); });
  assert.equal(cfg.enabled, false);
});

test("C5: an unreadable file or a directory at the path disables with one warn", (t) => {
  const d = join(dir, "isdir.json");
  mkdirSync(d);
  let cfg;
  assert.doesNotThrow(() => { cfg = loadCollectionsConfig({ path: d }); });
  assert.equal(cfg.enabled, false);
  loadCollectionsConfig({ path: d });
  assert.equal(warns.length, 1);

  if (typeof process.getuid === "function" && process.getuid() === 0) {
    t.diagnostic("running as root: chmod 000 case skipped");
    return;
  }
  const p = write("locked.json", fixture());
  chmodSync(p, 0o000);
  try {
    assert.doesNotThrow(() => { cfg = loadCollectionsConfig({ path: p }); });
    assert.equal(cfg.enabled, false);
    loadCollectionsConfig({ path: p });
    assert.equal(warns.length, 2);
  } finally {
    chmodSync(p, 0o600);
  }
});

test("C6: the schema is strict and bounded", () => {
  const cases = {
    unknownTop: fixture({ surprise: 1 }),
    unknownSection: fixture({ sections: [{ kind: "tag", heading: "x", tag: "a", extra: true }] }),
    tooManySections: fixture({ sections: Array.from({ length: 9 }, () => ({ kind: "tag", heading: "x", tag: "a" })) }),
    projectZero: fixture({ sections: [{ kind: "case-studies", heading: "x", projectId: 0 }] }),
    projectNegative: fixture({ sections: [{ kind: "case-studies", heading: "x", projectId: -1 }] }),
    projectFraction: fixture({ sections: [{ kind: "case-studies", heading: "x", projectId: 1.5 }] }),
    projectString: fixture({ sections: [{ kind: "case-studies", heading: "x", projectId: "2" }] }),
    badTag: fixture({ sections: [{ kind: "tag", heading: "x", tag: "a b" }] }),
  };
  for (const [name, value] of Object.entries(cases)) {
    const p = write(`${name}.json`, value);
    assert.equal(loadCollectionsConfig({ path: p }).enabled, false, `${name} must be rejected`);
  }
});

test("C7: docLinks.base accepts /blog/ paths and http(s) URLs only", () => {
  const withBase = (base) => fixture({
    sections: [{ kind: "tag", heading: "x", tag: "a", docLinks: { base, rules: [], defaultFile: "doc.html" } }],
  });
  const rejected = ["javascript:alert(1)", "data:text/html,x", "//evil.example/", "/blog/../dashboard/", "/blog//x/", "/dashboard/"];
  const accepted = ["/blog/docs/", "https://example.com/docs/", "http://example.com/"];
  for (const base of rejected) {
    const p = write(`r-${rejected.indexOf(base)}.json`, withBase(base));
    assert.equal(loadCollectionsConfig({ path: p }).enabled, false, `${base} must be rejected`);
  }
  for (const base of accepted) {
    const p = write(`a-${accepted.indexOf(base)}.json`, withBase(base));
    assert.equal(loadCollectionsConfig({ path: p }).enabled, true, `${base} must be accepted`);
  }
});

test("C8: the warn payload names the path and issue code, never a field value", () => {
  const sentinel = "SENTINEL-VALUE-123";
  const p = write("sentinel.json", fixture({ navTitle: sentinel, lang: sentinel }));
  assert.equal(loadCollectionsConfig({ path: p }).enabled, false);
  assert.equal(warns.length, 1);
  const flat = JSON.stringify(warns[0]);
  assert.ok(!flat.includes(sentinel), "warn must not echo values");
  assert.ok(flat.includes(p), "warn names the path");
  assert.match(flat, /invalid_enum_value/);
});

test("C10: the env override is honoured; the default path is under resolveCrowHome()", () => {
  const prev = process.env.CROW_BLOG_COLLECTIONS_CONFIG;
  try {
    delete process.env.CROW_BLOG_COLLECTIONS_CONFIG;
    assert.equal(collectionsConfigPath(), join(resolveCrowHome(), "blog", "collections.json"));
    const p = write("env.json", fixture({ navTitle: "From env" }));
    process.env.CROW_BLOG_COLLECTIONS_CONFIG = p;
    assert.equal(collectionsConfigPath(), p);
    assert.equal(loadCollectionsConfig().navTitle, "From env");
  } finally {
    if (prev === undefined) delete process.env.CROW_BLOG_COLLECTIONS_CONFIG;
    else process.env.CROW_BLOG_COLLECTIONS_CONFIG = prev;
  }
});
