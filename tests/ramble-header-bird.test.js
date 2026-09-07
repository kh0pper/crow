/**
 * Task 12 — the Nest header crow draws your hatched Ramble bird.
 *
 * tamagotchiJs(lang) returns ONE template literal that is later embedded
 * verbatim into a <script> tag on the dashboard page. Anything appended
 * inside it must contain no backtick and no `${` — either would close (or
 * interpolate into) the outer literal at *this* module's load time, not at
 * browser runtime. This suite guards that constraint directly by scanning
 * the raw module source, plus asserts the new ramble-bird wiring (pet
 * fetch, lazy-loaded draw engine, mood mapping, re-render guard) is present
 * in the emitted script and that the script still parses as valid JS.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const notificationsPath = join(
  __dirname,
  "../servers/gateway/dashboard/shared/notifications.js"
);

const { tamagotchiJs, tamagotchiCss } = await import(
  "../servers/gateway/dashboard/shared/notifications.js"
);

test("ramble-header-bird: tamagotchiJs('en') parses as valid JS", () => {
  const src = tamagotchiJs("en");
  assert.doesNotThrow(() => new Function(src));
});

test("ramble-header-bird: tamagotchiJs('es') parses as valid JS", () => {
  const src = tamagotchiJs("es");
  assert.doesNotThrow(() => new Function(src));
});

test("ramble-header-bird: emitted script wires up the ramble pet + bird engine", () => {
  const src = tamagotchiJs("en");
  assert.ok(src.includes("/api/ramble/pet"), "must poll the pet endpoint");
  assert.ok(
    src.includes("/ramble/static/bird-svg.js"),
    "must lazy-load the bird-drawing engine"
  );
  assert.ok(src.includes("RambleBird.drawBird"), "must draw with the engine");
  assert.ok(
    src.includes("crow-tama-bird"),
    "must create/target the crow-tama-bird group"
  );
  assert.ok(
    src.includes("display='none'"),
    "must hide the classic crow body group once a bird is drawn"
  );
  assert.ok(
    src.includes("credentials"),
    "pet fetch must be credentialed (same-origin)"
  );
  // Never use mountBird here — it replaces the whole SVG's innerHTML and
  // would destroy the bubble/exclaim siblings.
  assert.ok(
    !src.includes("RambleBird.mountBird"),
    "must not call RambleBird.mountBird from the header script"
  );
});

test("ramble-header-bird: tamagotchiCss carries #crow-tama-bird mood animations", () => {
  assert.ok(
    /\.crow-happy\s+#crow-tama-bird\s*\{[^}]*animation:/.test(tamagotchiCss),
    "happy mood must animate #crow-tama-bird"
  );
  assert.ok(
    /\.crow-tired\s+#crow-tama-bird\s*\{[^}]*animation:/.test(tamagotchiCss),
    "tired mood must animate #crow-tama-bird"
  );
  assert.ok(
    /\.crow-alarmed\s+#crow-tama-bird\s*\{[^}]*animation:/.test(tamagotchiCss),
    "alarmed mood must animate #crow-tama-bird"
  );
});

test("ramble-header-bird: the tamagotchiJs function body contains exactly one template literal (no nested backticks/${)", () => {
  const fileSrc = readFileSync(notificationsPath, "utf8");
  const startMarker = "export function tamagotchiJs";
  const start = fileSrc.indexOf(startMarker);
  assert.ok(start !== -1, "could not find tamagotchiJs in module source");

  // A standalone "}" line (module-level closing brace of the function) —
  // NOT a bare indexOf("\n}"), which would false-match the IIFE's own
  // "\n})();" invocation line inside the embedded script text.
  const rest = fileSrc.slice(start);
  const closeMatch = rest.match(/\n\}[ \t]*(\r?\n|$)/);
  assert.ok(closeMatch, "could not find the closing brace of tamagotchiJs");
  const closeIdx = start + closeMatch.index;

  const region = fileSrc.slice(start, closeIdx + 2);

  const backtickCount = (region.match(/`/g) || []).length;
  assert.equal(
    backtickCount,
    2,
    "tamagotchiJs body must contain exactly the outer template literal's own two backticks — " +
      `found ${backtickCount}`
  );

  // The whole-function region legitimately contains one pre-existing
  // `${sharedNotifJs(lang)}` interpolation (server-side, resolved when this
  // module loads — not something the ramble-bird change may touch). The
  // hazard this test guards against is new code accidentally introducing
  // ANOTHER `${...}` or backtick inside the browser-bound string, which
  // would either be evaluated now (wrong target, likely ReferenceError) or
  // terminate the outer literal early. So: scope the `${` prohibition to
  // just the newly-added ramble-bird sub-region, fenced by its own start/end
  // marker comments (see notifications.js), rather than the whole function.
  const addedStart = region.indexOf("ramble bird integration");
  assert.ok(
    addedStart !== -1,
    "expected a marker comment bracketing the added ramble-bird code"
  );
  const addedEnd = region.indexOf("end ramble bird integration");
  assert.ok(addedEnd !== -1, "expected the closing marker comment");
  const addedRegion = region.slice(addedStart, addedEnd);

  assert.ok(
    !addedRegion.includes("${"),
    "the added ramble-bird code must contain no `${` interpolation"
  );
  assert.ok(
    !addedRegion.includes("`"),
    "the added ramble-bird code must contain no backtick"
  );
});
