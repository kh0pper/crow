/**
 * XSS regression tests for the Nest panel carousel renderer.
 *
 * Peer-provided strings (peer name, tile name, offline timestamp) land in
 * server-rendered HTML. escapeHtml() is the only line of defense — this
 * suite asserts no unescaped `<` / `"` / `>` from peer inputs ever reaches
 * the output, even when the peer advertises script/event-handler payloads.
 *
 * If this suite ever fails, audit every peer-sourced interpolation in
 * panels/nest/html.js — a missed escapeHtml() turns one compromised peer
 * into every-peer RCE.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

const { buildNestHTML } = await import("../servers/gateway/dashboard/panels/nest/html.js");

function baseData(overrides = {}) {
  return {
    pinnedItems: [],
    bundles: [],
    instances: [],
    trustedInstances: [],
    peerOverviews: [],
    ...overrides,
  };
}

function assertNoUnescapedMarker(html, marker, context) {
  assert.ok(
    !html.includes(marker),
    `Unescaped "${marker}" reached rendered HTML (${context}) — an escapeHtml() call is missing.`
  );
}

test("nest-xss: peer name containing <script> — escaped to &lt;script&gt;", () => {
  const malicious = "<script>alert(1)</script>";
  const html = buildNestHTML(baseData({
    trustedInstances: [{ id: "peer-a", name: malicious, hostname: "bad.ts.net" }],
    peerOverviews: [{
      status: "ok",
      instance: { id: "peer-a", name: malicious, hostname: "bad.ts.net" },
      tiles: [],
    }],
  }), "en");
  assertNoUnescapedMarker(html, malicious, "raw <script> tag from peer name");
  assert.ok(html.includes("&lt;script&gt;"), "escaped form should be present");
});

test("nest-xss: peer name with double-quote attribute breakout — escaped", () => {
  const malicious = '" onclick="alert(1)"';
  const html = buildNestHTML(baseData({
    trustedInstances: [{ id: "peer-b", name: malicious, hostname: "bad.ts.net" }],
    peerOverviews: [{
      status: "ok",
      instance: { id: "peer-b", name: malicious, hostname: "bad.ts.net" },
      tiles: [],
    }],
  }), "en");
  assertNoUnescapedMarker(html, 'onclick="alert(1)"', "attribute-breakout in peer name");
  assert.ok(!html.includes('name=" onclick="'), "onclick attribute must not appear unescaped");
});

test("nest-xss: tile name with <img onerror=> — escaped", () => {
  const malicious = '<img src=x onerror=alert(1)>';
  const html = buildNestHTML(baseData({
    trustedInstances: [{ id: "peer-c", name: "crow", hostname: "crow.ts.net" }],
    peerOverviews: [{
      status: "ok",
      instance: { id: "peer-c", name: "crow", hostname: "crow.ts.net" },
      tiles: [
        { id: "memory", name: malicious, icon: "memory", pathname: "/dashboard/memory", port: null, category: "local-panel" },
      ],
    }],
  }), "en");
  assertNoUnescapedMarker(html, "<img src=x onerror=", "raw <img> in tile name");
  // Escaped form might collapse the attrs, but the opening < MUST be gone.
  assert.ok(html.includes("&lt;img") || !html.includes("<img src=x"), "malicious img must be escaped");
});

test("nest-xss: offline peer last_seen_at stays server-side (overview-cache never emits it) — offline section still renders safely with disambiguated name", () => {
  const malicious = "offline<script>alert(1)</script>";
  const html = buildNestHTML(baseData({
    trustedInstances: [{ id: "peer-d", name: malicious, hostname: "bad.ts.net", last_seen_at: "2026-04-19 12:00:00" }],
    peerOverviews: [{
      status: "unavailable",
      reason: "timeout",
    }],
  }), "en");
  assertNoUnescapedMarker(html, "<script>alert(1)</script>", "raw <script> in offline peer name");
  assert.ok(html.includes("nest-instance-section--offline"), "offline section must render");
});

test("nest-xss: peer hostname cannot break out of href — safeHost strips non-DNS chars", () => {
  // Even if the *local* hostname column somehow got a bad value, the href
  // builder strips anything outside [a-zA-Z0-9._-]. We assert the built
  // href never contains a `<` or a `javascript:` scheme even when the
  // local hostname is weird. (Overview-cache rejects peer-advertised bad
  // pathnames before they reach here — tested separately.)
  const html = buildNestHTML(baseData({
    trustedInstances: [{ id: "peer-e", name: "crow", hostname: "bad\"host<script>" }],
    peerOverviews: [{
      status: "ok",
      instance: { id: "peer-e", name: "crow", hostname: "bad\"host<script>" },
      tiles: [
        { id: "memory", name: "Memory", icon: "memory", pathname: "/dashboard/memory", port: null, category: "local-panel" },
      ],
    }],
  }), "en");
  assertNoUnescapedMarker(html, "bad\"host<script>", "raw bad hostname leaked into HTML");
  assert.ok(!/href="[^"]*<script/.test(html), "script tag must not appear inside an href");
  assert.ok(!/href="javascript:/i.test(html), "javascript: scheme must never be emitted");
});

test("nest-xss: peer tile href prefers gateway_url over bare hostname", () => {
  // Regression guard for the post-deploy bug where bare hostname "crow"
  // rendered as https://crow/... (unreachable). The gateway_url column
  // holds the operator-configured canonical base URL and MUST win.
  const html = buildNestHTML(baseData({
    trustedInstances: [{
      id: "peer-g",
      name: "crow",
      hostname: "crow",                                // bare, unresolvable
      gateway_url: "http://100.118.41.122:3001",        // canonical
    }],
    peerOverviews: [{
      status: "ok",
      instance: { id: "peer-g", name: "crow", hostname: "crow" },
      tiles: [
        { id: "memory", name: "Memory", icon: "memory", pathname: "/dashboard/memory", port: null, category: "local-panel" },
      ],
    }],
  }), "en");
  assert.ok(
    html.includes('href="http://100.118.41.122:3001/dashboard/memory"'),
    "tile href should be derived from gateway_url, not bare hostname. Hrefs found: " + (html.match(/href="[^"]+"/g) || []).join(", ")
  );
  assert.ok(
    !/href="https:\/\/crow\/dashboard/.test(html),
    "unreachable https://crow/... URL must NOT be emitted"
  );
});

test("nest-xss: tile icon allowlist — unknown icon key with HTML-looking content maps to 'default'", () => {
  // overview-cache should reject this before it reaches the renderer, but
  // defence-in-depth: the renderer's resolvePeerIcon() also allowlists.
  const html = buildNestHTML(baseData({
    trustedInstances: [{ id: "peer-f", name: "crow", hostname: "crow.ts.net" }],
    peerOverviews: [{
      status: "ok",
      instance: { id: "peer-f", name: "crow", hostname: "crow.ts.net" },
      tiles: [
        { id: "memory", name: "M", icon: '<svg onload=alert(1)>', pathname: "/dashboard/memory", port: null, category: "local-panel" },
      ],
    }],
  }), "en");
  assertNoUnescapedMarker(html, "<svg onload=alert(1)>", "unknown icon value leaked into HTML");
});
