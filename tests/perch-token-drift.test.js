/**
 * Decision 15 (Track 2): Crow's design-tokens.js is the authority for the Perch
 * palette. This test is the enforcement mechanism — it parses the vendored
 * `bundles/perch-hub/payload/hub/server.mjs` payload as TEXT (never imported or
 * executed; the payload is sha256-pinned and vendoring must stay untouched) and
 * fails loudly the moment PERCH_TOKENS and the payload's PERCH_CSS disagree, in
 * either direction.
 *
 * The payload writes its two custom-property blocks with no whitespace between
 * tokens (verified against the file this session):
 *   :root{--sky:#eef1f3;...;--line:#dde4e8}
 *   @media (prefers-color-scheme:dark){:root{--sky:#131a1f;...;--line:#2a353d}}
 * Both blocks wrap mid-declaration onto a second physical line inside the
 * template literal — regexes below tolerate that (and other whitespace
 * variants) without assuming a specific wrap point.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PERCH_TOKENS } from "../servers/gateway/dashboard/shared/design-tokens.js";
import { listPayloadFiles } from "../scripts/check-vendored-payloads.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PAYLOAD_DIR = join(REPO_ROOT, "bundles", "perch-hub", "payload");
const SERVER_MJS_REL = "hub/server.mjs";
const SERVER_MJS = join(PAYLOAD_DIR, SERVER_MJS_REL);

/** camelCase -> kebab-case CSS custom-property name, e.g. tealSoft -> teal-soft. */
function kebab(key) {
  return key.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());
}

/**
 * Parse a `--name:value;--name:value` custom-property block (whitespace and
 * embedded newlines tolerated) into { "--name": "value" }.
 */
function parseVarBlock(block) {
  const out = {};
  for (const raw of block.split(";")) {
    const piece = raw.trim();
    if (!piece) continue;
    const idx = piece.indexOf(":");
    if (idx === -1) continue;
    out[piece.slice(0, idx).trim()] = piece.slice(idx + 1).trim();
  }
  return out;
}

const serverText = readFileSync(SERVER_MJS, "utf8");

// Top-level `:root{...}` — anchored to the start of a line so the nested
// `:root{` inside the @media block (same line as `dark){`) is never matched.
const lightMatch = serverText.match(/^:root\s*\{([^}]*)\}/m);
// `@media (prefers-color-scheme:dark){:root{...}}`.
const darkMatch = serverText.match(
  /@media\s*\(\s*prefers-color-scheme\s*:\s*dark\s*\)\s*\{\s*:root\s*\{([^}]*)\}\s*\}/,
);

test("PERCH_CSS light and dark :root blocks are present in the vendored payload", () => {
  assert.ok(lightMatch, "expected a top-level :root{...} block in bundles/perch-hub/payload/hub/server.mjs");
  assert.ok(
    darkMatch,
    "expected an @media (prefers-color-scheme:dark){:root{...}} block in bundles/perch-hub/payload/hub/server.mjs",
  );
});

const lightVars = parseVarBlock(lightMatch[1]);
const darkVars = parseVarBlock(darkMatch[1]);

test("assertion 1: every PERCH_TOKENS.light entry appears in the light block with the exact value", () => {
  for (const [key, value] of Object.entries(PERCH_TOKENS.light)) {
    const cssName = `--${kebab(key)}`;
    assert.equal(
      lightVars[cssName],
      value,
      `${cssName} drifted: PERCH_TOKENS.light.${key} = ${value}, payload has ${lightVars[cssName]}`,
    );
  }
});

test("assertion 2: every PERCH_TOKENS.dark entry appears in the dark block with the exact value", () => {
  for (const [key, value] of Object.entries(PERCH_TOKENS.dark)) {
    const cssName = `--${kebab(key)}`;
    assert.equal(
      darkVars[cssName],
      value,
      `${cssName} drifted: PERCH_TOKENS.dark.${key} = ${value}, payload has ${darkVars[cssName]}`,
    );
  }
});

test("assertion 3: the dark block declares no property missing from PERCH_TOKENS.dark (alive/attn stay inherited)", () => {
  const expected = new Set(Object.keys(PERCH_TOKENS.dark).map((k) => `--${kebab(k)}`));
  const actual = new Set(Object.keys(darkVars));
  assert.deepEqual(
    [...actual].sort(),
    [...expected].sort(),
    "dark :root block's declared properties don't match PERCH_TOKENS.dark's key set exactly",
  );
  assert.ok(!actual.has("--alive"), "--alive must NOT be redeclared in the dark block — it inherits from light");
  assert.ok(!actual.has("--attn"), "--attn must NOT be redeclared in the dark block — it inherits from light");
});

test("assertion 4: the light block declares no property missing from PERCH_TOKENS.light", () => {
  const expected = new Set(Object.keys(PERCH_TOKENS.light).map((k) => `--${kebab(k)}`));
  const actual = new Set(Object.keys(lightVars));
  assert.deepEqual(
    [...actual].sort(),
    [...expected].sort(),
    "light :root block's declared properties don't match PERCH_TOKENS.light's key set exactly",
  );
});

test("assertion 5: payload-wide sweep — no CSS custom-property definition exists outside the two PERCH_CSS blocks", () => {
  const DEFINITION_RE = /--[a-z-]+\s*:/g;
  const expectedTotal = Object.keys(PERCH_TOKENS.light).length + Object.keys(PERCH_TOKENS.dark).length;

  const files = listPayloadFiles(PAYLOAD_DIR);
  assert.ok(files.includes(SERVER_MJS_REL), `expected ${SERVER_MJS_REL} in the payload file listing`);

  for (const rel of files) {
    const text = readFileSync(join(PAYLOAD_DIR, rel), "utf8");
    const count = (text.match(DEFINITION_RE) || []).length;
    if (rel === SERVER_MJS_REL) {
      assert.equal(
        count,
        expectedTotal,
        `${rel} has ${count} custom-property definitions, expected exactly ${expectedTotal} ` +
          `(light+dark) — a definition outside the two PERCH_CSS blocks would hide drift from assertions 1-4`,
      );
    } else {
      assert.equal(
        count,
        0,
        `${rel} defines ${count} CSS custom propert${count === 1 ? "y" : "ies"} — only hub/server.mjs's ` +
          "PERCH_CSS blocks may define Perch tokens; other payload files must only consume them via var(--x)",
      );
    }
  }
});
