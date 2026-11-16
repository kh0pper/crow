/**
 * The OWNER's markdown renderer (renderMarkdown) draws content a BOT can write:
 * memories (dashboard/panels/memory.js), blog posts and previews
 * (panels/blog.js, routes/blog-public.js), workspace .md files
 * (routes/fileview.js), KB articles (bundles/knowledge-base) and meta-glasses
 * notes. In every one of them an `<img src>` is a same-origin GET fired in the
 * VIEWER's browser with the viewer's cookies, so `![x](/dashboard/logout)`
 * signed the owner out on read, `![x](/dashboard?project=7)` changed the saved
 * project scope, and `![x](/dashboard/login/2fa/setup)` regenerated a pending
 * 2FA secret.
 *
 * So the owner path keeps the bot path's rule — `/blog/media/` or the escaped
 * alt text — plus exactly three sources that are NOT a state-changing
 * same-origin GET:
 *   - a URL on the instance's storage origin (presigned object URLs),
 *   - an inline `data:image/(png|jpeg|gif|webp);base64,` (no request at all;
 *     never svg), and
 *   - a published case-study figure under `/blog/figures/` in the one filename
 *     shape its read-only route serves (data-dashboard's buildFigureHtml).
 * Anything else is refused, exactly like the bot path.
 *
 * The shared sanitizer also keeps an `<input>` only when it is a GFM task-list
 * checkbox (`type` absent or anything but `checkbox` is dropped whole).
 *
 * Links keep Turbo Drive — this is the owner's own navigation — but never get
 * prefetched (Turbo 8 fires a same-origin GET on hover, with the viewer's
 * cookies). The bot path is unchanged: both Turbo opt-outs, `/blog/media/` only.
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  renderMarkdown, renderBotMarkdown, setRendererStorageOrigin,
} from "../servers/blog/renderer.js";

const STORAGE = "https://storage.example.test:9000";
const text = (html) => html.replace(/<[^>]+>/g, "");

afterEach(() => setRendererStorageOrigin(null));

// ---- the attack -----------------------------------------------------------

test("state-changing same-origin GETs are refused; only the alt text is left", () => {
  const refused = [
    "/dashboard/logout",
    "/dashboard?project=7",
    "/dashboard/login/2fa/setup",
    "/api/memories?delete=1",
  ];
  for (const src of refused) {
    const html = renderMarkdown(`![x](${src})`);
    assert.doesNotMatch(html, /<img/i, `${src}: ${html}`);
    assert.doesNotMatch(html, /<a[\s>]/i, `${src}: a refused image never becomes a link: ${html}`);
    assert.equal(text(html).trim(), "x", `${src}: alt text only, got ${html}`);
    assert.ok(!html.includes(src.split("?")[0]), `${src} is not rendered at all: ${html}`);
  }
});

test("a raw HTML <img> in owner markdown is dropped, before the browser sees it", () => {
  for (const md of [
    '<img src="/dashboard/logout">',
    '<p><img src="/dashboard?project=7" alt="x"></p>',
    '<figure class="crow-chart"><img src="/api/x" width="10"></figure>',
  ]) {
    const html = renderMarkdown(md);
    assert.doesNotMatch(html, /<img/i, `${md} → ${html}`);
  }
  assert.match(renderMarkdown('<img src="/blog/media/a.png" alt="a">'), /<img[^>]*src="\/blog\/media\/a\.png"/);
});

test("an absolute or protocol-relative URL is judged by its pathname", () => {
  const refused = [
    "https://host.example/dashboard/x",
    "//host.example/blog/media/../x",
    "https://host.example/blog/media/%2e%2e/x",
    "https://host.example/blog/media/a%2fb.png",
    "https://host.example/blog/mediax/a.png",
  ];
  for (const src of refused) {
    const html = renderMarkdown(`![a](${src})`);
    assert.doesNotMatch(html, /<img/i, `${src}: ${html}`);
    assert.equal(text(html).trim(), "a", `${src}: alt text only, got ${html}`);
  }
});

test("a refused image inside a link keeps the link, without the image", () => {
  const html = renderMarkdown("[![x](/dashboard/logout)](https://example.com/doc)");
  assert.doesNotMatch(html, /<img/i, html);
  assert.match(html, /<a href="https:\/\/example\.com\/doc"/, html);
  assert.doesNotMatch(html, /dashboard\/logout/, html);
});

test("alt text is character data, never markup; an image with no alt disappears", () => {
  const html = renderMarkdown("![a & b](/dashboard/x)");
  assert.match(html, /a &amp; b/, html);
  assert.doesNotMatch(html, /&amp;amp;/, "escaped once, not twice: " + html);
  const hostile = renderMarkdown("![<img src=x onerror=alert(1)>](/dashboard/y)");
  assert.doesNotMatch(hostile, /<img/i, hostile);
  assert.match(hostile, /&lt;img src=x onerror=alert\(1\)&gt;/, "shown as text, never as a tag");
  assert.equal(text(renderMarkdown("![](/dashboard/logout)")).trim(), "");
});

// ---- what the owner may still show ---------------------------------------

test("the owner's own media route is kept, as a path and written out in full", () => {
  for (const src of ["/blog/media/a.png", "https://host.example/blog/media/a.png"]) {
    const html = renderMarkdown(`![a](${src})`);
    assert.match(html, /<img[^>]*/, `${src}: ${html}`);
    assert.match(html, /alt="a"/, `${src}: ${html}`);
  }
  assert.match(renderMarkdown("![a](/blog/media/a.png)"), /src="\/blog\/media\/a\.png"/);
  assert.match(renderMarkdown("![a](https://host.example/blog/media/a.png)"), /src="https:\/\/host\.example\/blog\/media\/a\.png"/);
});

test("a presigned storage-origin URL is kept once that origin is known", () => {
  const md = `![a](${STORAGE}/crow-files/obj.png?X-Amz-Signature=abc)`;
  assert.doesNotMatch(renderMarkdown(md), /<img/i, "no storage origin known: refused, alt text only");

  setRendererStorageOrigin(STORAGE);
  assert.match(renderMarkdown(md), /src="https:\/\/storage\.example\.test:9000\/crow-files\/obj\.png\?X-Amz-Signature=abc"/);

  // The per-call option overrides the module-wide value for that call only.
  assert.match(renderMarkdown(md, { storageOrigin: STORAGE }), /<img/i);
  setRendererStorageOrigin(null);
  assert.match(renderMarkdown(md, { storageOrigin: STORAGE }), /<img/i);
  assert.doesNotMatch(renderMarkdown(md), /<img/i, "the module value is unchanged by the per-call option");

  // Exact origin: another port, scheme or host is not the storage origin.
  setRendererStorageOrigin(STORAGE);
  for (const src of [
    "https://storage.example.test:9001/x.png",
    "http://storage.example.test:9000/x.png",
    "https://other.example.test:9000/x.png",
  ]) {
    assert.doesNotMatch(renderMarkdown(`![a](${src})`), /<img/i, src);
  }
});

test("an inline raster data: image is kept; svg and other data: types are not", () => {
  const png = "data:image/png;base64,iVBORw0KGgo=";
  assert.match(renderMarkdown(`![a](${png})`), /src="data:image\/png;base64,iVBORw0KGgo="/);
  for (const src of [
    "data:image/svg+xml;base64,PHN2Zz4=",
    "data:image/svg+xml,%3Csvg%3E",
    "data:text/html;base64,PHNjcmlwdD4=",
  ]) {
    const html = renderMarkdown(`![a](${src})`);
    assert.doesNotMatch(html, /<img/i, `${src}: ${html}`);
    assert.equal(text(html).trim(), "a", `${src}: alt text only, got ${html}`);
  }
});

// ---- links ---------------------------------------------------------------

test("an owner link is not prefetched, keeps Turbo Drive, and loses author data-*", () => {
  const html = renderMarkdown("[x](/dashboard/make/open/a/b)");
  assert.match(html, /<a href="\/dashboard\/make\/open\/a\/b" data-turbo-prefetch="false">x<\/a>/, html);
  assert.doesNotMatch(html, /data-turbo="false"/, "the owner's own navigation stays on Turbo Drive: " + html);

  const hostile = renderMarkdown('<a data-turbo-prefetch="true" data-turbo="true" data-evil="1" href="/x">x</a>');
  assert.match(hostile, /data-turbo-prefetch="false"/, "the renderer's value wins: " + hostile);
  assert.doesNotMatch(hostile, /="true"/, hostile);
  assert.doesNotMatch(hostile, /data-evil/, hostile);
  assert.doesNotMatch(hostile, /data-turbo="false"/, hostile);
});

// ---- published case-study figures (data-dashboard) ------------------------
//
// bundles/data-dashboard writes `<img src="/blog/figures/<section>-<hash>.png">`
// into a case-study post's markdown (buildFigureHtml), and the read-only route
// that serves it (blog-embed-api.js, GET /blog/figures/:filename) accepts
// exactly `/^(\d+)-[0-9a-f]{8,64}\.png$/`. So the owner renderer keeps that one
// shape — a PNG on a public route that only ever reads — and nothing else under
// /blog/figures/. A bot reply keeps refusing the whole path.

test("an owner figure on /blog/figures/ is kept, as a path and written out in full", () => {
  const html = renderMarkdown("![a](/blog/figures/12-abcdef12.png)");
  assert.match(html, /<img[^>]*src="\/blog\/figures\/12-abcdef12\.png"/, html);
  assert.match(html, /alt="a"/, html);
  assert.match(
    renderMarkdown("![a](https://host.example/blog/figures/12-abcdef12.png)"),
    /src="https:\/\/host\.example\/blog\/figures\/12-abcdef12\.png"/
  );
  // the route's own bounds: 8 and 64 hex digits, any digit count for the id
  assert.match(renderMarkdown("![a](/blog/figures/7-0123abcd.png)"), /<img/i);
  assert.match(renderMarkdown(`![a](/blog/figures/9-${"a".repeat(64)}.png)`), /<img/i);
});

test("nothing else under /blog/figures/ is kept", () => {
  const refused = [
    "/blog/figures/12-abcdef12.png?x=1",
    "/blog/figures/12-abcdef12.png#x",
    "/blog/figures/../dashboard/x",
    "/blog/figures/a.png",
    "/blog/figures/12-ABCDEF12.png",
    "/blog/figures/12-abcdef1.png",
    `/blog/figures/12-${"a".repeat(65)}.png`,
    "/blog/figures/12-abcdefg2.png",
    "/blog/figures/12-abcdef12.jpg",
    "/blog/figures/12-abcdef12.png/extra",
    "/blog/figures/sub/12-abcdef12.png",
    "/blog/figures/%31%32-abcdef12.png",
    "/blog/figures/12-abcdef12.png\\..\\x",
    "https://host.example/blog/figures/12-abcdef12.png?x=1",
    "https://host.example/blog/figures/12-abcdef12.png#x",
  ];
  for (const src of refused) {
    const html = renderMarkdown(`![a](${src})`);
    assert.doesNotMatch(html, /<img/i, `${src}: ${html}`);
    assert.equal(text(html).trim(), "a", `${src}: alt text only, got ${html}`);
  }
});

test("a data-dashboard figure block keeps its img, class and caption", () => {
  const md = '<figure class="crow-chart" data-section-id="7">' +
    '<img src="/blog/figures/7-0123abcd.png" alt="c"><figcaption>x</figcaption></figure>';
  const html = renderMarkdown(md);
  assert.match(html, /<figure class="crow-chart" data-section-id="7">/, html);
  assert.match(html, /<img[^>]*src="\/blog\/figures\/7-0123abcd\.png"/, html);
  assert.match(html, /<figcaption>x<\/figcaption>/, html);
});

// ---- <input>: only a GFM task-list checkbox ------------------------------

const RENDERERS = [
  ["owner", renderMarkdown],
  ["bot", renderBotMarkdown],
];

test("a GFM task list keeps its checkbox in both renderers", () => {
  for (const [name, render] of RENDERERS) {
    const html = render("- [x] done\n- [ ] todo");
    assert.match(html, /<input[^>]*type="checkbox"/, `${name}: ${html}`);
    assert.match(html, /checked/, `${name}: the [x] box is checked: ${html}`);
    assert.equal((html.match(/<input/gi) || []).length, 2, `${name}: one box per item: ${html}`);
  }
});

test("every other <input> is dropped in both renderers", () => {
  const dropped = [
    '<input type="submit">',
    '<input type="text">',
    '<input type="image" src="/dashboard/x">',
    "<input>",
    '<input type="radio" name="r">',
    '<input type="hidden" name="t">',
  ];
  for (const [name, render] of RENDERERS) {
    for (const md of dropped) {
      const html = render(md);
      assert.doesNotMatch(html, /<input/i, `${name}: ${md} → ${html}`);
      assert.doesNotMatch(html, /dashboard\/x/, `${name}: ${md} → ${html}`);
    }
  }
});

test("the checkbox test is case-insensitive, and a raw checkbox keeps no other attribute", () => {
  for (const [name, render] of RENDERERS) {
    assert.match(render('<input type="CHECKBOX" checked>'), /<input[^>]*checked/, name);
    const html = render('<input type="checkbox" name="x" value="1" formaction="/dashboard/y">');
    assert.match(html, /<input[^>]*type="checkbox"/, `${name}: ${html}`);
    assert.doesNotMatch(html, /name=|value=|formaction=/, `${name}: ${html}`);
  }
});

// ---- the bot path is untouched -------------------------------------------

test("the bot path keeps its own, stricter rule", () => {
  const link = renderBotMarkdown("[x](/x)");
  assert.match(link, /data-turbo-prefetch="false"/, link);
  assert.match(link, /data-turbo="false"/, link);

  for (const src of ["data:image/png;base64,iVBORw0KGgo=", `${STORAGE}/crow-files/obj.png`]) {
    setRendererStorageOrigin(STORAGE);
    const html = renderBotMarkdown(`![a](${src})`);
    assert.doesNotMatch(html, /<img/i, `${src}: a bot reply keeps /blog/media/ only: ${html}`);
    assert.equal(text(html).trim(), "a", html);
    setRendererStorageOrigin(null);
  }
});