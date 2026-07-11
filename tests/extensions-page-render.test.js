/**
 * Extensions page render — store IA (Task 10).
 *
 * Pure HTML-string assertions: buildExtensionsHTML() takes plain data in and
 * returns fragment strings. Nothing here touches ~/.crow (no import of
 * routes/bundles.js or data-queries.js), so the operator's real installed.json
 * and docker state are never read.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildExtensionsHTML } from "../servers/gateway/dashboard/panels/extensions/html.js";
import { loadCollections } from "../servers/gateway/dashboard/panels/extensions/collections.js";

const AVAILABLE = [
  { id: "jellyfin", name: "Jellyfin", description: "Media server", type: "bundle", category: "media", version: "1.0.0", author: "Crow", featured: true, tags: ["media"] },
  { id: "searxng", name: "SearXNG", description: "Private search", type: "bundle", category: "infrastructure", version: "1.0.0", author: "Crow", featured: true, tags: [] },
  { id: "kolibri", name: "Kolibri", description: "Learning platform", type: "bundle", category: "education", version: "1.0.0", author: "Crow", tags: [] },
];

function render(overrides = {}) {
  return buildExtensionsHTML({
    installed: {},
    available: AVAILABLE,
    collections: loadCollections(),
    registrySource: "local",
    communityStores: [],
    bundleStatus: {},
    lang: "en",
    ...overrides,
  });
}

test("renders both views and the segmented control", () => {
  const { viewsHtml } = render();
  assert.match(viewsHtml, /id="ext-view-browse"/);
  assert.match(viewsHtml, /id="ext-view-installed"/);
  assert.match(viewsHtml, /class="[^"]*ext-viewtab[^"]*"[^>]*data-view="browse"/);
  assert.match(viewsHtml, /data-view="installed"/);
});

test("renders a collection card per shipped collection", () => {
  const { viewsHtml } = render();
  for (const c of loadCollections()) {
    assert.ok(
      viewsHtml.includes(`data-collection-id="${c.id}"`),
      `missing collection card for ${c.id}`,
    );
  }
});

test("featured add-ons get their own section; non-featured do not appear in it", () => {
  const { viewsHtml } = render();
  const featured = viewsHtml.split('id="ext-featured"')[1].split("</section>")[0];
  assert.ok(featured.includes('data-addon-id="jellyfin"'));
  assert.ok(featured.includes('data-addon-id="searxng"'));
  assert.ok(!featured.includes('data-addon-id="kolibri"'), "kolibri is not featured");
});

test("every add-on lands in exactly one group section, tagged with its group", () => {
  const { viewsHtml } = render();
  assert.match(viewsHtml, /class="ext-group-section"[^>]*data-group="media"/);
  assert.match(viewsHtml, /data-addon-id="kolibri"[^>]*data-addon-group="productivity"/);
});

test("no horizontal-scroll patterns are emitted (the bug we are fixing)", () => {
  const { viewsHtml } = render();
  assert.ok(!/overflow-x\s*:\s*(auto|scroll)/.test(viewsHtml), "no inline horizontal scrollers in the markup");
});

test("collections registry JSON is embedded for the client modal", () => {
  const { collectionsScript } = render();
  assert.match(collectionsScript, /id="collection-registry"/);
  assert.ok(collectionsScript.includes("home-server"));
});

test("empty collections → the section is simply absent (crash-proof)", () => {
  const { viewsHtml } = render({ collections: [] });
  assert.ok(!viewsHtml.includes('id="ext-collections"'));
});

// ─── DOM contracts the Task 11 client binds to ───

test("group chips and Show-all buttons carry their group id", () => {
  const many = Array.from({ length: 10 }, (_, i) => ({
    id: `m${i}`, name: `Media ${i}`, description: "d", type: "bundle",
    category: "media", version: "1.0.0", author: "Crow", tags: [],
  }));
  const { viewsHtml } = render({ available: many });
  assert.match(viewsHtml, /class="[^"]*ext-group-chip[^"]*"[^>]*data-group="media"/);
  assert.match(viewsHtml, /class="[^"]*ext-group-more[^"]*"[^>]*data-group="media"/);
  // first 8 shown, the rest carry the overflow marker and start hidden
  const overflow = viewsHtml.match(/ext-card--overflow/g) || [];
  assert.equal(overflow.length, 2, "10 add-ons in one group → 2 overflow cards");
});

test("search input and both registry script blobs are emitted", () => {
  const { viewsHtml, addonRegistryScript, collectionsScript } = render();
  assert.match(viewsHtml, /id="ext-search"/);
  assert.match(addonRegistryScript, /id="addon-registry"/);
  assert.match(collectionsScript, /id="collection-registry"/);
});

test("no add-on card is emitted twice inside the browse groups", () => {
  const { viewsHtml } = render();
  const groups = viewsHtml.split('id="ext-featured"')[1] || "";
  const kolibri = groups.match(/data-addon-id="kolibri"/g) || [];
  assert.equal(kolibri.length, 1, "kolibri appears in exactly one group section");
});
