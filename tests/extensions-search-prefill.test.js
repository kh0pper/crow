// Skills panel option C, PR 3: a skill's "Go to <extension>" links to
// /dashboard/extensions?q=<id>; the search box arrives filled in (the page's
// own filter runs on load and reads it), and the handler passes ?q= through.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildExtensionsHTML } from "../servers/gateway/dashboard/panels/extensions/html.js";

const build = (extra = {}) => buildExtensionsHTML({ installed: {}, available: [], collections: [], registrySource: "local", communityStores: [], bundleStatus: {}, lang: "en", ...extra }).viewsHtml;

test("?q=kiosk prefills #ext-search (escaped); no q leaves it empty", () => {
  assert.match(build({ searchQuery: "kiosk" }), /id="ext-search" autocomplete="off" value="kiosk"/);
  assert.match(build({ searchQuery: '"><x' }), /value="&quot;&gt;&lt;x"/);
  assert.match(build(), /id="ext-search" autocomplete="off" value=""/);
});

test("the extensions handler passes a single ?q= string through, capped", () => {
  const src = readFileSync(new URL("../servers/gateway/dashboard/panels/extensions.js", import.meta.url), "utf8");
  assert.match(src, /searchQuery: typeof req\.query\?\.q === "string" \? req\.query\.q\.slice\(0, 100\) : ""/);
});
