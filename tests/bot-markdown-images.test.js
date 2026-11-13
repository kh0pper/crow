/**
 * A bot's markdown reply is rendered as HTML in the OWNER's browser, so every
 * `<img src>` in it is a request the VIEWER makes, same-origin and carrying
 * the viewer's cookies. `![x](/dashboard/logout)` therefore signed the owner
 * out just by reading a reply; `/api/…` and `/dashboard/…` were the same trick
 * against other routes, and `//evil.example/x.png` / `https://evil.example/x.png`
 * pinged a third party on every read.
 *
 * Fix: the bot path keeps exactly ONE image source — the public blog media
 * route. Everything else loses its <img> and keeps only its alt text (never a
 * link). The owner's renderer (renderMarkdown — blog preview, memory, KB, file
 * view) is unchanged.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderMarkdown, renderBotMarkdown, isAllowedBotImageSrc } from "../servers/blog/renderer.js";

const text = (html) => html.replace(/<[^>]+>/g, "");

// ---- the src rule itself --------------------------------------------------

test("isAllowedBotImageSrc: only a same-origin path under /blog/media/", () => {
  for (const ok of ["/blog/media/p.png", "/blog/media/a/b.png", "/blog/media/p.png?v=2"]) {
    assert.equal(isAllowedBotImageSrc(ok), true, ok);
  }
  for (const bad of [
    "", null, undefined, "p.png", "storage:p.png",
    "/dashboard/logout", "/blog/media", "/blog/mediax/p.png", "/api/x",
    "/blog/media/../dashboard/logout",
    "/blog/media/%2e%2e/dashboard/logout", "/blog/media/a%2e%2e/b.png",
    "//evil.example/x.png", "///evil.example/x.png", "/blog/media//evil.example/x.png",
    "https://evil.example/x.png", "http://localhost:3001/blog/media/p.png",
    "javascript:alert(1)", "data:image/png;base64,AAAA",
    String.raw`\blog\media\x`, String.raw`/blog/media\..\x`,
  ]) {
    assert.equal(isAllowedBotImageSrc(bad), false, String(bad));
  }
});

// ---- the attack ----------------------------------------------------------

test("a reply's ![x](/dashboard/logout) fires nothing and shows its alt text", () => {
  const html = renderBotMarkdown("![x](/dashboard/logout)");
  assert.doesNotMatch(html, /<img/i, html);
  assert.doesNotMatch(html, /dashboard\/logout/, "the refused src is not rendered at all (not even as a link): " + html);
  assert.equal(text(html).trim(), "x", "the alt text stays, escaped, as plain text");
});

test("a raw HTML <img> written by a bot is dropped before the browser sees it", () => {
  for (const md of [
    '<img src="/dashboard/logout">',
    '<img src="/dashboard/logout" alt="x">',
    '<p><img src="/api/x" width="10"></p>',
  ]) {
    const html = renderBotMarkdown(md);
    assert.doesNotMatch(html, /<img/i, `${md} → ${html}`);
    assert.doesNotMatch(html, /(dashboard\/logout|api\/x)/, html);
  }
});

test("reference-style images are the same rule", () => {
  const html = renderBotMarkdown("![x][r]\n\n[r]: /dashboard/logout");
  assert.doesNotMatch(html, /<img/i, html);
  assert.equal(text(html).trim(), "x");
});

test("every refused src: no <img>, no link, only the alt text", () => {
  const refused = [
    "/dashboard/logout",
    "/blog/media/../dashboard/logout",
    "/blog/media/%2e%2e/dashboard/logout",
    "//evil.example/x.png",
    "https://evil.example/x.png",
    "/api/x",
    "javascript:x",
    "data:image/png;base64,AAAA",
  ];
  for (const src of refused) {
    const html = renderBotMarkdown(`![x](${src})`);
    assert.doesNotMatch(html, /<img/i, `${src}: ${html}`);
    assert.doesNotMatch(html, /<a[\s>]/i, `${src}: a refused image never becomes a link: ${html}`);
    assert.equal(text(html).trim(), "x", `${src}: alt text only, got ${html}`);
  }
  // Backslash spellings of the same media path (a browser may read `\` as `/`).
  for (const src of [String.raw`\\blog\\media\\x`, String.raw`\blog\media\x`]) {
    const html = renderBotMarkdown(`![x](${src})`);
    assert.doesNotMatch(html, /<img/i, `${src}: ${html}`);
    assert.doesNotMatch(html, /<a[\s>]/i, `${src}: ${html}`);
  }
});

test("alt text is escaped: it is character data, not markup", () => {
  const html = renderBotMarkdown("![a & b](/dashboard/x)");
  assert.match(html, /a &amp; b/, html);
  assert.doesNotMatch(html, /&amp;amp;/, "escaped once, not twice: " + html);
  const hostile = renderBotMarkdown("![<img src=x onerror=alert(1)>](/dashboard/y)");
  assert.doesNotMatch(hostile, /<img/i, hostile);
  assert.match(hostile, /&lt;img src=x onerror=alert\(1\)&gt;/, "shown as text, never as a tag");
});

test("an image with no alt text disappears entirely", () => {
  const html = renderBotMarkdown("![](/dashboard/logout)");
  assert.doesNotMatch(html, /<img/i, html);
  assert.equal(text(html).trim(), "");
});

// ---- what a bot may still show -------------------------------------------

test("an image already on /blog/media/ is kept", () => {
  const html = renderBotMarkdown("![a](/blog/media/p.png)");
  assert.match(html, /<img[^>]*src="\/blog\/media\/p\.png"/, html);
  assert.match(html, /alt="a"/, html);
});

test("a storage: key still becomes /blog/media/<key>", () => {
  const html = renderBotMarkdown("![a](storage:p.png)");
  assert.match(html, /<img[^>]*src="\/blog\/media\/p\.png"/, html);
  assert.match(html, /alt="a"/, html);
});

test("a refused image inside a link keeps the link, without the image", () => {
  const html = renderBotMarkdown("[![x](/dashboard/logout)](https://example.com/doc)");
  assert.doesNotMatch(html, /<img/i, html);
  assert.match(html, /<a href="https:\/\/example\.com\/doc"/, html);
  assert.doesNotMatch(html, /dashboard\/logout/, html);
});

// ---- the owner's renderer is untouched ------------------------------------

test("renderMarkdown keeps an ordinary external image unchanged", () => {
  const html = renderMarkdown("![a](https://example.com/x.png)");
  assert.match(html, /<img[^>]*src="https:\/\/example\.com\/x\.png"/, html);
  assert.match(html, /alt="a"/, html);
  assert.doesNotMatch(html, /<a[\s>]/i, "no link is invented on the owner's path either");
});

test("renderMarkdown keeps its own storage: rewrite and its no-rule image behaviour", () => {
  assert.match(renderMarkdown("![a](storage:p.png)"), /<img[^>]*src="\/blog\/media\/p\.png"/);
  // The bot-only restriction does not leak into the owner's page: its images
  // are the owner's own, exactly as before this change.
  assert.match(renderMarkdown("![x](/dashboard/logout)"), /<img[^>]*src="\/dashboard\/logout"/);
});