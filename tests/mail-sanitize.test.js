// Crow Mail's message sanitiser (servers/gateway/mail/sanitize.js): untrusted message HTML in, the
// small allow-list of tags and attributes the reader may render out — with remote images blocked
// unless the caller asks for them. Each hostile sample is exactly what a sender can put on the wire,
// so the evasions here are the shapes that get past a naive filter: entity-encoded and tab-split
// schemes, a tag split by another tag, protocol-relative URLs, and a marker attribute the sender
// tries to plant itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bodyForDisplay,
  MAX_SANITIZE_HTML_CHARS,
  sanitizeMessageHtml,
  textToSafeHtml,
} from "../servers/gateway/mail/sanitize.js";

const clean = (html, opts) => sanitizeMessageHtml(html, opts).html;

const REMOTE = "https://cdn.example.test/a.png";

test("script, event handlers and inline styles are gone", () => {
  const out = clean(
    '<p onclick="alert(1)">hi<script>alert("x")</script></p><img src="x" onerror="alert(1)">',
  );
  assert.doesNotMatch(out, /<script/i);
  assert.doesNotMatch(out, /onerror/i);
  assert.doesNotMatch(out, /onclick/i);
  assert.doesNotMatch(out, /alert/);
  assert.match(out, /<p>hi<\/p>/);
});

test("a script nested inside an allowed tag leaves only the surrounding text", () => {
  const out = clean("<p>before<script>alert(1)</script>after</p>");
  assert.equal(out, "<p>beforeafter</p>");
});

test("javascript: hrefs are dropped in every shape a sender writes them", () => {
  const samples = [
    '<a href="javascript:alert(1)">x</a>',
    '<a href="JAVASCRIPT:alert(1)">x</a>',
    '<a href="jav&#x61;script:alert(1)">x</a>',
    '<a href="java\tscript:alert(1)">x</a>',
    '<a href="&#106;&#97;&#118;&#97;&#115;&#99;&#114;&#105;&#112;&#116;&#58;alert(1)">x</a>',
    '<a href="//evil.example.test/x">x</a>',
    '<a href="data:text/html,<script>alert(1)</script>">x</a>',
  ];
  for (const sample of samples) {
    const out = clean(sample);
    assert.doesNotMatch(out, /javascript:/i, sample);
    assert.doesNotMatch(out, /evil\.example\.test/, sample);
    assert.doesNotMatch(out, /href=/, sample);
    assert.match(out, /target="_blank"/, sample);
    assert.match(out, /rel="noopener noreferrer nofollow"/, sample);
  }
});

test("leading whitespace or control characters in an href cannot smuggle a scheme", () => {
  const out = clean(
    '<a href=" &#9;https://example.test/ok">ok</a><a href="&#1;&#9;javascript:alert(1)">bad</a>',
  );
  assert.match(out, /href="https:\/\/example\.test\/ok"/);
  assert.doesNotMatch(out, /javascript:/i);
});

test("a tag split by another tag cannot assemble a script", () => {
  const out = clean("<scr<script>ipt>alert(1)</script>");
  assert.doesNotMatch(out, /<script/i);
  assert.doesNotMatch(out, /<scr/i);
  assert.doesNotMatch(out, /javascript:/i);

  const nested = clean('<svg><script>alert(1)</script></svg><p>after</p>');
  assert.doesNotMatch(nested, /<script/i);
  assert.doesNotMatch(nested, /alert\(1\)/);
  assert.match(nested, /<p>after<\/p>/);
});

test("a space inside a URL is refused, so a spaced scheme cannot pass as a relative link", () => {
  const samples = [
    '<a href="h ttps://x/../../dashboard/settings">x</a>',
    '<a href="https:// x">x</a>',
    '<a href="mail to:alex@example.com">x</a>',
    '<a href="h ttps://example.test/">x</a>',
  ];
  for (const sample of samples) {
    const out = clean(sample);
    assert.doesNotMatch(out, /href=/, sample);
    assert.doesNotMatch(out, /dashboard\/settings/, sample);
    assert.match(out, /target="_blank"/, sample);
    assert.match(out, /rel="noopener noreferrer nofollow"/, sample);
  }

  // An encoded space is part of the URL, not a spacing trick, and a trailing space is trimmed.
  assert.match(clean('<a href="https://example.test/a%20b">x</a>'), /href="https:\/\/example\.test\/a%20b"/);
  assert.match(clean('<a href="https://example.test/ok ">x</a>'), /href="https:\/\/example\.test\/ok"/);
  assert.doesNotMatch(clean('<a href="https://example.test/ok ">x</a>'), /href="[^"]* "$/);
});

test("an image URL with a space inside it is dropped, never shown as a remote image", () => {
  const { html, remoteImageCount, blockedRemoteImageCount } = sanitizeMessageHtml(
    '<img src="ht tps://x/a.png">',
    { allowRemoteImages: true },
  );
  assert.doesNotMatch(html, /src=/);
  assert.doesNotMatch(html, /data-crow-blocked/);
  assert.equal(remoteImageCount, 0, "a spaced scheme is not shown as a remote image");
  assert.equal(blockedRemoteImageCount, 0);

  const trailing = sanitizeMessageHtml('<img src="https://cdn.example.test/a.png ">', { allowRemoteImages: true });
  assert.match(trailing.html, /src="https:\/\/cdn\.example\.test\/a\.png"/);
  assert.equal(trailing.remoteImageCount, 1);
  assert.equal(trailing.blockedRemoteImageCount, 0);
});

test("style and class attributes, a style block and its @import vanish", () => {
  const out = clean(
    '<style>@import url("https://evil.example.test/x.css"); body { background: red }</style>' +
      '<p style="color:red" class="lead" id="intro">hi</p>',
  );
  assert.equal(out, "<p>hi</p>");
});

test("meta, base, form, iframe, object, embed, svg, math, link and noscript are dropped with their content", () => {
  const samples = [
    '<meta http-equiv="refresh" content="0;url=https://evil.example.test/">',
    '<base href="https://evil.example.test/">',
    '<form action="https://evil.example.test/"><input name="q" value="secret"></form>',
    '<iframe src="https://evil.example.test/"></iframe>',
    '<object data="https://evil.example.test/x.swf"></object>',
    '<embed src="https://evil.example.test/x">',
    '<svg onload="alert(1)"><text>sneaky</text></svg>',
    '<math><mtext>sneaky</mtext></math>',
    '<link rel="stylesheet" href="https://evil.example.test/x.css">',
    '<noscript><img src="https://evil.example.test/p.gif"></noscript>',
  ];
  for (const sample of samples) {
    const out = clean(`<p>a</p>${sample}`);
    assert.equal(out, "<p>a</p>", sample);
  }
  assert.equal(clean("<p>a</p><iframe src=\"https://evil.example.test/\"></iframe><p>b</p>"), "<p>a</p><p>b</p>");
});

test("an https image is blocked, marked and counted unless the caller allows remote images", () => {
  const { html, remoteImageCount, blockedRemoteImageCount } = sanitizeMessageHtml(
    `<p>hi</p><img src="${REMOTE}" alt="pixel" width="1" height="1">`,
  );
  assert.doesNotMatch(html, /src=/);
  assert.match(html, /data-crow-blocked="1"/);
  assert.match(html, /alt="pixel"/);
  assert.match(html, /width="1"/);
  assert.match(html, /height="1"/);
  assert.equal(remoteImageCount, 1);
  assert.equal(blockedRemoteImageCount, 1);
});

test("an https image is kept when remote images are allowed, and http is blocked anyway", () => {
  const shown = sanitizeMessageHtml(`<img src="${REMOTE}">`, { allowRemoteImages: true });
  assert.match(shown.html, /src="https:\/\/cdn\.example\.test\/a\.png"/);
  assert.doesNotMatch(shown.html, /data-crow-blocked/);
  assert.equal(shown.remoteImageCount, 1);
  assert.equal(shown.blockedRemoteImageCount, 0);

  const plain = sanitizeMessageHtml('<img src="http://cdn.example.test/a.png">', { allowRemoteImages: true });
  assert.doesNotMatch(plain.html, /src=/);
  assert.match(plain.html, /data-crow-blocked="1"/);
  assert.equal(plain.remoteImageCount, 1);
  assert.equal(plain.blockedRemoteImageCount, 1);
});

test("a protocol-relative image src is a remote image and is blocked even when images are allowed", () => {
  const { html, remoteImageCount, blockedRemoteImageCount } = sanitizeMessageHtml(
    '<img src="//cdn.example.test/a.png">',
    { allowRemoteImages: true },
  );
  assert.doesNotMatch(html, /src=/);
  assert.match(html, /data-crow-blocked="1"/);
  assert.equal(remoteImageCount, 1);
  assert.equal(blockedRemoteImageCount, 1);
});

test("a tracking pixel is blocked and carries the marker plan 2 reads", () => {
  const { html, blockedRemoteImageCount } = sanitizeMessageHtml(
    `<img src="${REMOTE}" width="1" height="1"><img src="${REMOTE}" width="600">`,
  );
  assert.equal(blockedRemoteImageCount, 2);
  assert.equal((html.match(/data-crow-blocked="1"/g) ?? []).length, 2);
  assert.doesNotMatch(html, /src=/);
});

test("a data-crow-blocked the sender supplied itself never reaches the output", () => {
  const allowed = sanitizeMessageHtml(`<img src="${REMOTE}" data-crow-blocked="1">`, { allowRemoteImages: true });
  assert.match(allowed.html, /src="https:\/\/cdn\.example\.test\/a\.png"/);
  assert.doesNotMatch(allowed.html, /data-crow-blocked/);

  const blocked = sanitizeMessageHtml(`<img src="${REMOTE}" data-CROW-BLOCKED="0">`);
  assert.equal((blocked.html.match(/data-crow-blocked/g) ?? []).length, 1);
  assert.match(blocked.html, /data-crow-blocked="1"/);

  const dropped = sanitizeMessageHtml('<img src="cid:part1@example.test" data-crow-blocked="1">');
  assert.match(dropped.html, /^<img\s*\/?>$/);
  assert.equal(dropped.blockedRemoteImageCount, 0);
});

test("srcset and background never survive", () => {
  const out = clean(
    `<img src="${REMOTE}" srcset="https://a.example.test/1 1x, https://b.example.test/2 2x">` +
      '<table background="https://evil.example.test/bg.png"><tr><td background="https://evil.example.test/bg2.png">x</td></tr></table>',
    { allowRemoteImages: true },
  );
  assert.doesNotMatch(out, /srcset/i);
  assert.doesNotMatch(out, /background/i);
  assert.doesNotMatch(out, /evil\.example\.test/);
  assert.match(out, /<td>x<\/td>/);
});

test("cid: and data: image sources are removed and not counted", () => {
  const { html, remoteImageCount, blockedRemoteImageCount } = sanitizeMessageHtml(
    '<img src="cid:part1.abc@example.test"><img src="data:image/png;base64,iVBORw0KGgo="><img>',
  );
  assert.doesNotMatch(html, /src=/);
  assert.doesNotMatch(html, /data-crow-blocked/);
  assert.equal(remoteImageCount, 0);
  assert.equal(blockedRemoteImageCount, 0);
});

test("links keep href and title, gain target and rel, and lose everything else", () => {
  const out = clean('<a href="https://example.test/x?a=1&b=2" title="Docs" data-track="1" onmouseover="alert(1)">x</a>');
  assert.match(out, /href="https:\/\/example\.test\/x\?a=1&amp;b=2"/);
  assert.match(out, /title="Docs"/);
  assert.match(out, /target="_blank"/);
  assert.match(out, /rel="noopener noreferrer nofollow"/);
  assert.doesNotMatch(out, /data-track/);
  assert.doesNotMatch(out, /onmouseover/);
});

test("mailto: and tel: hrefs survive", () => {
  const out = clean('<a href="mailto:alex@example.com">mail</a><a href="tel:+15550100">call</a>');
  assert.match(out, /href="mailto:alex@example\.com"/);
  assert.match(out, /href="tel:\+15550100"/);
  assert.equal((out.match(/target="_blank"/g) ?? []).length, 2);
});

test("textToSafeHtml escapes markup, keeps line breaks and never links anything", () => {
  assert.equal(
    textToSafeHtml('<script>alert("x")</script>\nline two'),
    "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;<br>line two",
  );
  assert.equal(textToSafeHtml("a\r\nb\rc"), "a<br>b<br>c");
  assert.equal(textToSafeHtml(""), "");
  assert.equal(textToSafeHtml(null), "");
  assert.equal(textToSafeHtml(42), "");
  assert.doesNotMatch(textToSafeHtml("see https://example.test/"), /<a/i);
});

test("bodyForDisplay prefers the html body, falls back to text, then to nothing", () => {
  const rich = bodyForDisplay({ bodyHtml: "<p>rich</p><script>alert(1)</script>", bodyText: "plain" });
  assert.equal(rich.source, "html");
  assert.match(rich.html, /<p>rich<\/p>/);
  assert.doesNotMatch(rich.html, /<script/);
  assert.equal(rich.remoteImageCount, 0);
  assert.equal(rich.blockedRemoteImageCount, 0);

  // The store's own row shape uses the column names.
  const columnar = bodyForDisplay({ body_html: "<b>hi</b>", body_text: "hi" });
  assert.equal(columnar.source, "html");
  assert.equal(columnar.html, "<b>hi</b>");

  const textOnly = bodyForDisplay({ bodyHtml: null, bodyText: "one\n<b>two</b>" });
  assert.equal(textOnly.source, "text");
  assert.equal(textOnly.html, "one<br>&lt;b&gt;two&lt;/b&gt;");
  assert.equal(textOnly.remoteImageCount, 0);
  assert.equal(textOnly.blockedRemoteImageCount, 0);

  const nothing = { html: "", remoteImageCount: 0, blockedRemoteImageCount: 0, source: "none" };
  assert.deepEqual(bodyForDisplay({}), nothing);
  assert.deepEqual(bodyForDisplay(null), nothing);
  assert.deepEqual(bodyForDisplay({ bodyHtml: "   ", bodyText: "\n" }), nothing);
});

test("bodyForDisplay passes the remote-image choice through to the sanitiser", () => {
  const shown = bodyForDisplay({ bodyHtml: `<img src="${REMOTE}">`, bodyText: "" }, { allowRemoteImages: true });
  assert.match(shown.html, /src="https:\/\/cdn\.example\.test\/a\.png"/);
  assert.equal(shown.remoteImageCount, 1);
  assert.equal(shown.blockedRemoteImageCount, 0);

  const hidden = bodyForDisplay({ bodyHtml: `<img src="${REMOTE}">`, bodyText: "" });
  assert.doesNotMatch(hidden.html, /src=/);
  assert.equal(hidden.blockedRemoteImageCount, 1);
});

test("a script after the 2 MB cut never reaches the output, and the output stays bounded", () => {
  const html = "a".repeat(MAX_SANITIZE_HTML_CHARS) + '<script>alert(1)</script><p onclick="alert(1)">tail</p>';
  assert.ok(html.length > MAX_SANITIZE_HTML_CHARS);

  const out = sanitizeMessageHtml(html);
  assert.doesNotMatch(out.html, /<script/i);
  assert.doesNotMatch(out.html, /alert/);
  assert.doesNotMatch(out.html, /onclick/i);
  assert.ok(out.html.length <= MAX_SANITIZE_HTML_CHARS, `output length ${out.html.length}`);
});

test("a non-string body is an empty safe result, never a throw", () => {
  const nothing = { html: "", remoteImageCount: 0, blockedRemoteImageCount: 0 };
  for (const input of [null, undefined, 42, true, {}, [], { html: "<script>alert(1)</script>" }]) {
    assert.deepEqual(sanitizeMessageHtml(input), nothing, String(input));
    assert.deepEqual(sanitizeMessageHtml(input, { allowRemoteImages: true }), nothing, String(input));
  }
  assert.deepEqual(bodyForDisplay(42), { ...nothing, source: "none" });
  assert.deepEqual(bodyForDisplay({ bodyHtml: 42, bodyText: 7 }), { ...nothing, source: "none" });
});

test("a 5 MB html body is sanitised in well under two seconds", () => {
  const unit = '<p style="color:red">Hello <a href="https://example.test/">link</a> '
    + '<img src="https://tracker.example.test/p.gif" onerror="alert(1)"></p>\n';
  const html = unit.repeat(Math.ceil((5 * 1024 * 1024) / unit.length));
  assert.ok(html.length > MAX_SANITIZE_HTML_CHARS);

  const started = performance.now();
  const out = sanitizeMessageHtml(html);
  const elapsed = performance.now() - started;

  assert.ok(elapsed < 2000, `sanitising a 5 MB body took ${Math.round(elapsed)} ms`);
  assert.ok(out.html.length > 0);
  assert.doesNotMatch(out.html, /onerror|javascript:|<script/i);
});

test("fifteen hostile samples never emit javascript:, onerror or a script tag", () => {
  const samples = [
    '<img src=x onerror=alert(1)>',
    `<IMG SRC=JaVaScRiPt:alert('XSS')>`,
    '<img src="jav&#x09;ascript:alert(1)">',
    '<img src="java\nscript:alert(1)">',
    '<a href="javascript:alert(1)">x</a>',
    '<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">x</a>',
    '<scr<script>ipt>alert(1)</script>',
    '<<script>alert(1);//<</script>',
    '<svg/onload=alert(1)>',
    '<iframe src="javascript:alert(1)"></iframe>',
    '<body onload=alert(1)>',
    '<p style="background:url(javascript:alert(1))">x</p>',
    "<div><style>@import 'javascript:alert(1)';</style></div>",
    '<img src="x" onerror="alert(1)"//>',
    '<a href="&#106;avascript:alert(1)" onfocus="alert(1)">x</a>',
  ];
  assert.equal(samples.length, 15);
  for (const sample of samples) {
    const { html } = sanitizeMessageHtml(sample, { allowRemoteImages: true });
    assert.doesNotMatch(html, /javascript:/i, sample);
    assert.doesNotMatch(html, /onerror/i, sample);
    assert.doesNotMatch(html, /<script/i, sample);
  }
});