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
import { extensionStyles } from "../servers/gateway/dashboard/panels/extensions/css.js";

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

// ─── The horizontal-scroll guard (the bug this page's overhaul exists to fix) ───
//
// The 2555px document overflow lived in the STYLESHEET, not the markup:
//   .ext-tabs { overflow-x:auto }  +  .ext-tab { white-space:nowrap; flex-shrink:0 }
// So asserting on the HTML alone is vacuous — it passes on the buggy code. These
// two tests read css.js's actual output.

/** Split a stylesheet into { selector, body } rule blocks (flat CSS; no nesting here). */
function cssRules(css) {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, ""); // comments can mention "nowrap"
  const rules = [];
  for (const m of stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    rules.push({ selector: m[1].trim(), body: m[2] });
  }
  return rules;
}

test("the stylesheet declares no horizontal scroller", () => {
  const css = extensionStyles();
  const offenders = cssRules(css).filter((r) => /overflow-x\s*:\s*(auto|scroll)/.test(r.body));
  assert.deepEqual(
    offenders.map((r) => r.selector),
    [],
    "a rule scrolls horizontally — this is exactly the 2555px overflow bug",
  );
});

test("the stylesheet has no nowrap row (nowrap is only legal when the rule also clips)", () => {
  const css = extensionStyles();
  // `white-space:nowrap` + `overflow:hidden` is the single-line truncation idiom
  // (.ext-stores__url) and cannot inflate a parent. A bare nowrap CAN: it is what
  // made 19 category tabs push the page to 2555px.
  const offenders = cssRules(css).filter(
    (r) => /white-space\s*:\s*nowrap/.test(r.body) && !/overflow\s*:\s*hidden/.test(r.body),
  );
  assert.deepEqual(
    offenders.map((r) => r.selector),
    [],
    "a rule sets white-space:nowrap without clipping — it can inflate the page horizontally",
  );
});

test("no horizontal-scroll patterns are emitted in the markup either", () => {
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

test("overflow cards are hidden by CLASS, never by an inline display style", () => {
  const many = Array.from({ length: 10 }, (_, i) => ({
    id: `m${i}`, name: `Media ${i}`, description: "d", type: "bundle",
    category: "media", version: "1.0.0", author: "Crow", tags: [],
  }));
  const { viewsHtml } = render({ available: many });

  // The client's search filter assigns card.style.display across every .addon-card.
  // An inline `display:none` would be clobbered on the first keystroke, revealing
  // every card past the cap; a class-driven hide survives it.
  const allCards = viewsHtml.match(/<div class="ext-card addon-card[^>]*>/g) || [];
  assert.equal(allCards.length, 10);
  for (const card of allCards) {
    assert.ok(
      !/style="[^"]*display/.test(card),
      `an add-on card carries an inline display — the search filter would clobber it: ${card}`,
    );
  }

  const overflowCards = viewsHtml.match(/<div class="ext-card addon-card ext-card--overflow"[^>]*>/g) || [];
  assert.equal(overflowCards.length, 2, "10 add-ons, cap 8 → 2 overflow cards");
  for (const card of overflowCards) {
    assert.ok(!/style="[^"]*display/.test(card), `overflow card carries an inline display: ${card}`);
  }
  // ...and the stylesheet is what actually hides them — see the cascade test below.
  // (A string match for the RULE is NOT proof: the rule can be present and still
  //  lose the cascade to `.ext-card { display:flex }`. Resolve, don't grep.)
});

/** Specificity (a,b,c) of a single selector: #id, .class/[attr]/:pseudo-class, element. */
function specificity(sel) {
  const ids = (sel.match(/#[\w-]+/g) || []).length;
  const classes = (sel.match(/\.[\w-]+|\[[^\]]+\]|:[\w-]+(?!:)/g) || []).length;
  const elements = (sel.match(/(^|[\s>+~])[a-zA-Z][\w-]*/g) || []).length;
  return [ids, classes, elements];
}
const cmpSpec = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/** Classes of the compound selector at the far right (what must match the element). */
function rightmostClasses(sel) {
  const last = sel.trim().split(/[\s>+~]+/).pop();
  return (last.match(/\.[\w-]+/g) || []).map((c) => c.slice(1));
}

/**
 * Resolve `display` for an element with the given classes, the way a browser would:
 * highest specificity wins; on a tie, the LAST rule in source order wins.
 * @returns {{value:string, selector:string}|null}
 */
function resolveDisplay(css, elementClasses) {
  const owned = new Set(elementClasses);
  let winner = null;
  cssRules(css).forEach((rule, order) => {
    const decl = [...rule.body.matchAll(/(?:^|;)\s*display\s*:\s*([^;]+)/g)].pop();
    if (!decl) return;
    for (const sel of rule.selector.split(",")) {
      const s = sel.trim();
      if (!s || s.startsWith("@")) continue;
      const right = rightmostClasses(s);
      // Only class-only compounds can match our element; every class must be present.
      // Deliberately ignores ancestor qualifiers (e.g. `.foo .ext-card`) and skips
      // @media-conditioned rules outright (see the `startsWith("@")` guard above) —
      // nothing sets `display` on an .ext-card under either today, so a simpler
      // rightmost-compound match is enough; revisit if that ever changes.
      if (right.length === 0 || !right.every((c) => owned.has(c))) continue;
      const spec = specificity(s);
      if (!winner || cmpSpec(spec, winner.spec) > 0 || (cmpSpec(spec, winner.spec) === 0 && order >= winner.order)) {
        winner = { value: decl[1].trim(), selector: s, spec, order };
      }
    }
  });
  return winner;
}

test("CASCADE: an overflow card actually resolves to display:none in a browser", () => {
  // The regression this catches: `.ext-card--overflow { display:none }` (0-1-0) TIES
  // with `.ext-card { display:flex }` (0-1-0) and loses on source order, so every
  // "hidden" card past the cap renders and the Show-all cap is dead. The rule is
  // *present* in the stylesheet the whole time — only resolving the cascade catches it.
  const css = extensionStyles();
  const winner = resolveDisplay(css, ["ext-card", "addon-card", "ext-card--overflow"]);
  assert.ok(winner, "no rule sets display on an overflow card");
  assert.equal(
    winner.value,
    "none",
    `an overflow card resolves to display:${winner.value} via "${winner.selector}" — it is NOT hidden`,
  );
});

test("CASCADE: a normal (non-overflow) add-on card still resolves to display:flex", () => {
  // The other half: the fix must not hide every card.
  const winner = resolveDisplay(extensionStyles(), ["ext-card", "addon-card"]);
  assert.ok(winner);
  assert.equal(winner.value, "flex", `a visible card resolves to display:${winner.value}`);
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
