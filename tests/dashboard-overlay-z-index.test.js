/**
 * The stacking scale (2026-10-20): every dashboard layer that covers the page (a modal, a sheet and its
 * backdrop, a full-screen view) sits ABOVE the player bar.
 *
 * The report: the model-catalog, contacts and extensions modals used z-index 1000, the same as
 * #crow-player-bar; the bar comes later in the DOM (and is data-turbo-permanent), so it painted over
 * their backdrops. The scale lives on player.js Z; this guard scans the dashboard's own CSS and every
 * bundle panel for full-viewport fixed layers (tests/fixtures/fixed-overlays.mjs) and fails on any at
 * or below the bar, unless it is one of the named exceptions below.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { findFixedOverlays, overlaysInText } from "./fixtures/fixed-overlays.mjs";
import { Z, playerBarHtml } from "../servers/gateway/dashboard/shared/player.js";

const OVERLAYS = findFixedOverlays();
const FOUND = new Set(OVERLAYS.map((o) => o.file + "|" + o.selector));

/** Full-viewport layers allowed under the bar, each with its reason. */
const UNDER_BAR_OK = new Map([
  ["servers/gateway/dashboard/panels/bot-board/css.js|.bb-picker[open]>.bb-pick-btn::before",
    "a transparent click-catcher for an open picker: nothing to see, and the bar stays tappable"],
  ["servers/gateway/dashboard/panels/bot-board/drawer.js|.bb-bird-backdrop",
    "the bird drawer docks above the bar (its height leaves the bar's room), so its scrim stops at the bar too"],
  ["servers/gateway/dashboard/shared/layout.js|.sidebar-overlay",
    "99 on desktop, where it never shows (only the phone drawer opens it, and there it is 1090)"],
]);

test("the scale: the bar is Z.playerBar, the phone drawer above it, modals above that, toasts on top", () => {
  assert.equal(Z.playerBar, 1000);
  assert.ok(Z.playerBar < Z.phoneDrawer && Z.phoneDrawer < Z.modal && Z.modal < Z.toast, JSON.stringify(Z));
  const html = playerBarHtml("en");
  const z = /id="crow-player-bar"[^>]*z-index:(\d+)/.exec(html);
  assert.ok(z, "the bar carries a z-index");
  assert.equal(Number(z[1]), Z.playerBar, "the bar's z-index comes from the scale");
});

test("the scan reaches the layers it guards (the reported modals, the Give panels, the phone drawer's backdrop)", () => {
  for (const k of [
    "servers/gateway/dashboard/panels/model-catalog.js|#mcat-modal-overlay",
    "servers/gateway/dashboard/panels/contacts/css.js|.import-modal-backdrop",
    "servers/gateway/dashboard/panels/extensions/css.js|#modal-overlay",
    "servers/gateway/dashboard/panels/bot-builder/css.js|#engine-gate-modal-overlay",
    "servers/gateway/dashboard/panels/messages/css.js|.bot-dir-modal",
    "servers/gateway/dashboard/perch-hub/css.js|#perch-browse-modal",
    "servers/gateway/dashboard/panels/bot-builder/css.js|.btb-give",
    "servers/gateway/dashboard/panels/bot-board/css.js|.bb-give",
    "servers/gateway/dashboard/shared/layout.js|.sidebar-overlay",
  ]) assert.ok(FOUND.has(k), "the scan must find " + k + "; found: " + [...FOUND].join(", "));
});

test("no dashboard or panel modal/backdrop sits at or under the player bar", () => {
  const bad = OVERLAYS
    .filter((o) => !UNDER_BAR_OK.has(o.file + "|" + o.selector))
    .filter((o) => o.z === null || o.z <= Z.playerBar)
    .map((o) => `${o.file} ${o.selector} z=${o.z}`);
  assert.deepEqual(bad, [], "these full-screen layers are painted over by the player bar (raise them to Z.modal, "
    + Z.modal + ", or end them at the bar with bottom:var(--crow-player-h,0px)):\n" + bad.join("\n"));
});

test("the exceptions still exist (a stale entry would hide a new layer of the same name)", () => {
  for (const k of UNDER_BAR_OK.keys()) assert.ok(FOUND.has(k), "stale exception: " + k);
});

test("the scanner: a `${...}` inside a rule does not hide it, and an interpolated z-index counts as missing", () => {
  const src = "const css = `.a{color:${c}} .low{position:fixed;inset:0;background:${bg({x:1})};z-index:900} " +
    ".interp{position:fixed;inset:0;z-index:${Z.modal}} .ok{position:fixed;inset:0;z-index:1200}`;";
  const got = Object.fromEntries(overlaysInText(src).map((o) => [o.selector, o.z]));
  assert.deepEqual(got, { ".low": 900, ".interp": null, ".ok": 1200 });
});

test("the scanner: a selector's z-index is its LOWEST — a phone-only raise does not hide a desktop rule under the bar", () => {
  const src = ".m{position:fixed;inset:0;z-index:99} @media(max-width:768px){.m{z-index:1090}}";
  assert.deepEqual(overlaysInText(src), [{ selector: ".m", z: 99 }]);
});
