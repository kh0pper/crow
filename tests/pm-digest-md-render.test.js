import { test } from "node:test";
import assert from "node:assert/strict";
import { mdToHtml } from "../bundles/pm-workspace/server/digest/render.js";

test("heading levels render as distinct visual styles", () => {
  const html = mdToHtml("## Section\n\n### Subsection");
  const styles = [...html.matchAll(/<h3 style="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(styles.length, 2);
  assert.notEqual(styles[0], styles[1], "## and ### get different styles");
  assert.match(styles[0], /border-bottom/, "## carries the section rule");
  assert.match(styles[1], /uppercase/, "### renders as a small subhead");
});

test("blockquote lines render as one highlighted callout card", () => {
  const html = mdToHtml("> **Deadline TODAY**\n> - enroll in benefits\n\nNormal paragraph.");
  const callouts = html.match(/border-left:4px solid #e74c3c/g) || [];
  assert.equal(callouts.length, 1, "consecutive quote lines share one callout");
  assert.match(html, /<strong>Deadline TODAY<\/strong>/);
  assert.match(html, /<li[^>]*>enroll in benefits/);
  assert.ok(html.indexOf("Normal paragraph") > html.indexOf("</div>"), "paragraph sits outside the callout");
});

test("lists, links, and escaping still hold", () => {
  const html = mdToHtml("- item with [link](https://example.org) & <tags>");
  assert.match(html, /<a href="https:\/\/example\.org"/);
  assert.match(html, /&amp; &lt;tags&gt;/);
  assert.doesNotMatch(html, /<tags>/);
});
