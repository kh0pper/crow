// Crow Mail's MIME normaliser (servers/gateway/mail/parse.js): one raw RFC 822 message in, one
// ParsedMessage out — plus, from parseRawMessageFull, the attachment bytes in the same order as
// ParsedMessage.attachments. Hand-written RFC 822 so each case is exactly what a sender can put on
// the wire. Every unparseable or oversized input comes back as the placeholder, never a rejection.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_BODY_CHARS,
  MAX_RAW_BYTES,
  MAX_RECIPIENTS,
  parseRawMessage,
  parseRawMessageFull,
} from "../servers/gateway/mail/parse.js";

const CRLF = "\r\n";

/** A raw message from header lines and body lines, CRLF-joined. */
function raw(...lines) {
  return lines.join(CRLF);
}

const collapsed = (s) => s.replace(/\s+/g, " ").trim();

/** An html-only message (no plain part), so the text comes from the markup alone. */
function htmlOnlyMessage(html) {
  return raw(
    "From: alex@example.com",
    "To: sam@example.com",
    "Subject: Hostile markup",
    "Content-Type: text/html; charset=utf-8",
    "",
    html,
  );
}

const MB = 1024 * 1024;

/** Parse one html-only message and report how long the whole normaliser took, in ms. */
async function timedParse(html) {
  const message = htmlOnlyMessage(html);
  const started = performance.now();
  const parsed = await parseRawMessage(message);
  return { parsed, elapsed: performance.now() - started };
}

/** A message body nested in `depth` multipart/mixed wrappers around one text/plain part. */
function nestedMultipart(depth) {
  let message = raw("Content-Type: text/plain; charset=utf-8", "", "inner body");
  for (let i = 0; i < depth; i++) {
    const boundary = `depth-${i}`;
    message = raw(
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      message,
      `--${boundary}--`,
      "",
    );
  }
  return message;
}

/** A message whose whole payload is larger than MAX_RAW_BYTES. */
function oversizedMessage() {
  return Buffer.alloc(MAX_RAW_BYTES + 1, 0x61);
}

test("a plain text message yields its headers, body, date and a 200-character snippet", async () => {
  const body = `Hello Sam,${CRLF}${CRLF}${"word ".repeat(60)}${CRLF}Thanks, Alex`;
  const parsed = await parseRawMessage(raw(
    "From: Alex <alex@example.com>",
    "To: Sam <sam@example.com>",
    "Subject: Lunch on Friday",
    "Date: Tue, 12 Nov 2024 10:00:00 +0000",
    "Message-ID: <m1@mail.example.test>",
    "Content-Type: text/plain; charset=utf-8",
    "",
    body,
  ));

  assert.equal(parsed.parseError, null);
  assert.equal(parsed.messageId, "<m1@mail.example.test>");
  assert.deepEqual(parsed.from, { name: "Alex", address: "alex@example.com" });
  assert.deepEqual(parsed.to, [{ name: "Sam", address: "sam@example.com" }]);
  assert.deepEqual(parsed.cc, []);
  assert.deepEqual(parsed.replyTo, []);
  assert.deepEqual(parsed.references, []);
  assert.equal(parsed.inReplyTo, null);
  assert.equal(parsed.subject, "Lunch on Friday");
  assert.equal(parsed.date, Date.UTC(2024, 10, 12, 10, 0, 0));
  assert.ok(parsed.text.startsWith("Hello Sam,"), "the plain body is kept");
  assert.ok(parsed.text.includes("word word"));
  assert.equal(parsed.html, null);
  assert.equal(parsed.truncated, false);
  assert.deepEqual(parsed.attachments, []);

  const text = collapsed(parsed.text);
  assert.equal(parsed.snippet.length, 200);
  assert.equal(parsed.snippet, text.slice(0, 200));
  assert.doesNotMatch(parsed.snippet, /\s\s/);
});

test("a multipart/alternative message keeps the text part and the html part", async () => {
  const parsed = await parseRawMessage(raw(
    "From: alex@example.com",
    "To: sam@example.com",
    "Subject: Two versions",
    'Content-Type: multipart/alternative; boundary="alt"',
    "",
    "--alt",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Plain version",
    "--alt",
    "Content-Type: text/html; charset=utf-8",
    "",
    "<p>Html version</p>",
    "--alt--",
    "",
  ));

  assert.equal(parsed.parseError, null);
  assert.equal(parsed.text.trim(), "Plain version");
  assert.ok(parsed.html.includes("<p>Html version</p>"));
  assert.equal(parsed.truncated, false);
});

test("an html-only message fills text from the markup with tags stripped and entities decoded", async () => {
  const parsed = await parseRawMessage(raw(
    "From: alex@example.com",
    "Subject: Html only",
    "Content-Type: text/html; charset=utf-8",
    "",
    "<html><head><style>p { color: red }</style><script>alert('x')</script></head>",
    "<body><p>Hello&nbsp;&amp; welcome &#8212; enjoy</p></body></html>",
  ));

  assert.equal(parsed.parseError, null);
  assert.equal(parsed.text, "Hello & welcome — enjoy");
  assert.doesNotMatch(parsed.text, /color|alert/);
  // The html is the message's own markup; sanitising it is a later task's job.
  assert.ok(parsed.html.includes("<p>Hello&nbsp;&amp; welcome &#8212; enjoy</p>"));
  assert.ok(parsed.html.includes("<script>alert('x')</script>"));
  assert.equal(parsed.snippet, "Hello & welcome — enjoy");
});

test("an RFC 2047 subject and a quoted-printable UTF-8 body decode", async () => {
  const parsed = await parseRawMessage(raw(
    "From: alex@example.com",
    "To: sam@example.com",
    "Subject: =?UTF-8?B?SGVsbG8g8J+Zgg==?=",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: quoted-printable",
    "",
    "Gr=C3=BC=C3=9Fe aus M=C3=BCnchen",
  ));

  assert.equal(parsed.subject, "Hello 🙂");
  assert.equal(parsed.text.trim(), "Grüße aus München");
});

test("attachment metadata carries filename, content type, size and the unwrapped contentId", async () => {
  const parsed = await parseRawMessage(raw(
    "From: alex@example.com",
    "To: sam@example.com",
    "Subject: With attachments",
    'Content-Type: multipart/mixed; boundary="mix"',
    "",
    "--mix",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "See the two files.",
    "--mix",
    "Content-Type: image/png",
    'Content-Disposition: inline; filename="chart.png"',
    "Content-ID: <chart@mail.example.test>",
    "Content-Transfer-Encoding: base64",
    "",
    "iVBORw0KGgo=",
    "--mix",
    "Content-Type: application/pdf",
    'Content-Disposition: attachment; filename="doc.pdf"',
    "Content-Transfer-Encoding: base64",
    "",
    "JVBERi0xLjQK",
    "--mix--",
    "",
  ));

  assert.equal(parsed.parseError, null);
  assert.deepEqual(parsed.attachments, [
    {
      filename: "chart.png",
      contentType: "image/png",
      size: 8,
      contentId: "chart@mail.example.test",
      disposition: "inline",
    },
    {
      filename: "doc.pdf",
      contentType: "application/pdf",
      size: 9,
      contentId: null,
      disposition: "attachment",
    },
  ]);
  assert.equal(parsed.text.trim(), "See the two files.");
  // parseRawMessage is the metadata-only entry point: no bytes on the result.
  assert.equal("content" in parsed.attachments[0], false);
});

test("references and in-reply-to keep their order as sent", async () => {
  const parsed = await parseRawMessage(raw(
    "From: alex@example.com",
    "To: sam@example.com",
    "Subject: Re: a thread",
    "Message-ID: <m3@mail.example.test>",
    "In-Reply-To: <m2@mail.example.test>",
    "References: <m1@mail.example.test> <m2@mail.example.test>",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Replying.",
  ));

  assert.equal(parsed.messageId, "<m3@mail.example.test>");
  assert.equal(parsed.inReplyTo, "<m2@mail.example.test>");
  assert.deepEqual(parsed.references, ["<m1@mail.example.test>", "<m2@mail.example.test>"]);
});

test("RF1 a message with no Message-ID, Date or From gives nulls, not errors", async () => {
  const parsed = await parseRawMessage(raw("Subject: Only a subject", "", "Body here"));

  assert.equal(parsed.parseError, null);
  assert.equal(parsed.messageId, null);
  assert.equal(parsed.inReplyTo, null);
  assert.deepEqual(parsed.references, []);
  assert.equal(parsed.date, null);
  assert.equal(parsed.from, null);
  assert.deepEqual(parsed.to, []);
  assert.deepEqual(parsed.cc, []);
  assert.deepEqual(parsed.replyTo, []);
  assert.equal(parsed.text.trim(), "Body here");

  const badDate = await parseRawMessage(raw("Subject: Bad date", "Date: not a date", "", "Body"));
  assert.equal(badDate.date, null);
  assert.equal(badDate.parseError, null);
});

test("RF1 a header with 4,000 recipients is capped at MAX_RECIPIENTS", async () => {
  const recipients = Array.from({ length: 4000 }, (_, i) => `u${i}@example.com`).join(", ");
  const parsed = await parseRawMessage(raw(
    "From: alex@example.com",
    `To: ${recipients}`,
    "Subject: A very wide To",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Hello everyone.",
  ));

  assert.equal(parsed.parseError, null);
  assert.equal(parsed.to.length, MAX_RECIPIENTS);
  assert.equal(parsed.to[0].address, "u0@example.com");
  assert.equal(parsed.to[MAX_RECIPIENTS - 1].address, `u${MAX_RECIPIENTS - 1}@example.com`);
});

test("RF1 a 30 MB message is refused unparsed as too_large", async () => {
  const parsed = await parseRawMessage(oversizedMessage());

  assert.equal(parsed.parseError, "too_large");
  assert.equal(parsed.messageId, null);
  assert.equal(parsed.inReplyTo, null);
  assert.deepEqual(parsed.references, []);
  assert.equal(parsed.subject, "");
  assert.equal(parsed.from, null);
  assert.deepEqual(parsed.to, []);
  assert.deepEqual(parsed.cc, []);
  assert.deepEqual(parsed.replyTo, []);
  assert.equal(parsed.date, null);
  assert.equal(parsed.text, "");
  assert.equal(parsed.html, null);
  assert.equal(parsed.snippet, "");
  assert.deepEqual(parsed.attachments, []);
  assert.equal(parsed.truncated, false);
});

test("RF1 an unknown charset still yields text", async () => {
  const parsed = await parseRawMessage(raw(
    "From: alex@example.com",
    "Subject: Odd charset",
    "Content-Type: text/plain; charset=x-no-such-charset",
    "",
    "hello from an unknown charset",
  ));

  assert.equal(parsed.parseError, null);
  assert.ok(parsed.text.includes("hello from an unknown charset"));
});

test("RF1 40 nested multiparts return", async () => {
  const parsed = await parseRawMessage(nestedMultipart(40));

  assert.equal(parsed.parseError, null);
  assert.ok(parsed.text.includes("inner body"));
});

test("RF1 a multipart bomb past the parser's depth limit returns unparseable, not a stack overflow", async () => {
  const parsed = await parseRawMessage(nestedMultipart(300));

  assert.equal(parsed.parseError, "unparseable");
  assert.equal(parsed.text, "");
});

test("RF1 an oversized body is cut at MAX_BODY_CHARS and marked truncated", async () => {
  const parsed = await parseRawMessage(raw(
    "From: alex@example.com",
    "Subject: Long body",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "a".repeat(MAX_BODY_CHARS + 5000),
  ));

  assert.equal(parsed.parseError, null);
  assert.equal(parsed.text.length, MAX_BODY_CHARS);
  assert.equal(parsed.truncated, true);
  assert.equal(parsed.snippet.length, 200);

  const short = await parseRawMessage(raw(
    "From: alex@example.com",
    "Subject: Short body",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "b".repeat(50),
  ), { maxBodyChars: 1000 });
  assert.equal(short.truncated, false);
});

test("opts.maxBodyChars cuts text and html alike and sets truncated", async () => {
  const htmlOnly = raw(
    "From: alex@example.com",
    "Subject: Long html",
    "Content-Type: text/html; charset=utf-8",
    "",
    `<p>${"b".repeat(3000)}</p>`,
  );
  const parsed = await parseRawMessage(htmlOnly, { maxBodyChars: 100 });

  assert.equal(parsed.parseError, null);
  // The html is cut to the limit first, and the text is derived from that cut: the three
  // characters of <p> take three of the hundred, so ninety-seven characters of body remain.
  assert.equal(parsed.html, `<p>${"b".repeat(97)}`);
  assert.equal(parsed.text, "b".repeat(97));
  assert.equal(parsed.html.length, 100);
  assert.equal(parsed.truncated, true);

  const plain = await parseRawMessage(raw(
    "From: alex@example.com",
    "Subject: Long plain",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "c".repeat(500),
  ), { maxBodyChars: 10 });
  assert.equal(plain.text, "c".repeat(10));
  assert.equal(plain.truncated, true);
});

test("an html body is cut to the body limit before its text is derived", async () => {
  const parsed = await parseRawMessage(htmlOnlyMessage(`<p>${"b".repeat(MAX_BODY_CHARS + 5000)}</p>`));

  assert.equal(parsed.parseError, null);
  assert.equal(parsed.html.length, MAX_BODY_CHARS);
  assert.equal(parsed.truncated, true);
  assert.ok(parsed.text.length <= MAX_BODY_CHARS);
  assert.ok(parsed.text.length > MAX_BODY_CHARS - 10, "the cut keeps nearly the whole body");
  assert.match(parsed.text, /^b+$/);
});

test("comments, script and style blocks go, mixed case too, and tags leave their text", async () => {
  const parsed = await parseRawMessage(htmlOnlyMessage(
    "<!-- a comment with <b>tags</b> inside --><P>Keep &amp; this</P>" +
    "<SCRIPT type=\"text/javascript\">alert('x')</SCRIPT>" +
    "<sTyLe>p { color: red }</sTyLe>" +
    "<ScRiPt>alert('y')</sCrIpT>" +
    "<div class=\"x\">and&nbsp;this</div>",
  ));

  assert.equal(parsed.parseError, null);
  assert.equal(parsed.text, "Keep & this and this");
  assert.doesNotMatch(parsed.text, /alert|color|comment/);
});

test("an unclosed script block, style block or comment drops the rest instead of leaking it", async () => {
  for (const html of [
    "<p>Visible</p><script>secret()",
    "<p>Visible</p><STYLE>.secret { color: red }",
    "<p>Visible</p><!-- secret <p>hidden</p>",
  ]) {
    const parsed = await parseRawMessage(htmlOnlyMessage(html));
    assert.equal(parsed.parseError, null);
    assert.equal(parsed.text, "Visible");
    assert.doesNotMatch(parsed.text, /secret|hidden|color/);
  }
});

test("a megabyte of '<' characters derives text in well under 200 ms", async () => {
  const { parsed, elapsed } = await timedParse("<".repeat(MB));

  assert.equal(parsed.parseError, null);
  assert.equal(parsed.text, "");
  assert.ok(elapsed < 200, `took ${elapsed.toFixed(1)} ms`);
});

test("a megabyte of unclosed comments derives text in well under 200 ms", async () => {
  const { parsed, elapsed } = await timedParse("<!--".repeat(MB / 4));

  assert.equal(parsed.parseError, null);
  assert.equal(parsed.text, "");
  assert.ok(elapsed < 200, `took ${elapsed.toFixed(1)} ms`);
});

test("a megabyte of unclosed script blocks derives text in well under 200 ms", async () => {
  for (const html of [
    "<script".repeat(MB / 7),          // never closed with '>'
    "<script>".repeat(MB / 8) + "alert(1)", // opened, never closed
  ]) {
    const { parsed, elapsed } = await timedParse(html);
    assert.equal(parsed.parseError, null);
    assert.equal(parsed.text, "");
    assert.ok(elapsed < 200, `took ${elapsed.toFixed(1)} ms`);
  }
});

test("a megabyte of unclosed '<a ' tags derives text in well under 200 ms", async () => {
  const { parsed, elapsed } = await timedParse("<a ".repeat(MB / 3));

  assert.equal(parsed.parseError, null);
  assert.equal(parsed.text, "");
  assert.ok(elapsed < 200, `took ${elapsed.toFixed(1)} ms`);
});

test("references are capped to the last 50 ids", async () => {
  const ids = Array.from({ length: 30000 }, (_, i) => `<r${i}@mail.example.test>`);
  const parsed = await parseRawMessage(raw(
    "From: alex@example.com",
    "To: sam@example.com",
    "Subject: A very long References header",
    `References: ${ids.join(" ")}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Body.",
  ));

  assert.equal(parsed.parseError, null);
  assert.equal(parsed.references.length, 50, "a wider References header is cut");
  assert.deepEqual(parsed.references, ids.slice(-50), "the newest ancestors are the ones kept");
});

test("the id headers take their first bracketed id and ignore the rest of the header", async () => {
  const parsed = await parseRawMessage(raw(
    "From: alex@example.com",
    "To: sam@example.com",
    "Subject: ids with extras",
    "Message-ID: <m@mail.example.test> (c)",
    "In-Reply-To: <a@mail.example.test> <b@mail.example.test>",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Body.",
  ));

  assert.equal(parsed.parseError, null);
  assert.equal(parsed.messageId, "<m@mail.example.test>", "a trailing comment is not part of the id");
  assert.equal(parsed.inReplyTo, "<a@mail.example.test>", "only the first id is the reply target");
});

test("an id header with no angle brackets keeps its first token, and an empty one is null", async () => {
  const parsed = await parseRawMessage(raw(
    "From: alex@example.com",
    "Subject: bare ids",
    "Message-ID: m@mail.example.test extra words",
    "In-Reply-To:    ",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Body.",
  ));

  assert.equal(parsed.parseError, null);
  assert.equal(parsed.messageId, "m@mail.example.test");
  assert.equal(parsed.inReplyTo, null, "a header of nothing but whitespace names no id");
});

test("garbage text comes back as a message, with no error text anywhere", async () => {
  const hostile = "garbage\x00\xff not a message";
  let parsed;
  await assert.doesNotReject(async () => { parsed = await parseRawMessage(hostile); });

  // postal-mime is lenient about a body that has no headers at all, so the observed parseError is
  // null: the string is taken as a body and the parse succeeds. What the normaliser must guarantee
  // is that nothing throws and that no parser error text can reach the result.
  assert.equal(parsed.parseError, null);
  assert.equal(parsed.messageId, null);
  assert.equal(parsed.inReplyTo, null);
  assert.deepEqual(parsed.references, []);
  assert.equal(parsed.subject, "");
  assert.equal(parsed.date, null);
  assert.equal(parsed.from, null);
  assert.equal(parsed.html, null);
  assert.doesNotMatch(JSON.stringify(parsed), /Unsupported email input|Maximum MIME|Cannot read|undefined/);
});

test("an input that is not a message at all comes back as the unparseable placeholder", async () => {
  for (const input of [42, { raw: "no" }, ["From: alex@example.com"]]) {
    const parsed = await parseRawMessage(input);
    assert.equal(parsed.parseError, "unparseable");
    assert.equal(parsed.text, "");
    assert.equal(parsed.html, null);
    assert.equal(parsed.date, null);
    assert.equal(parsed.from, null);
    assert.deepEqual(parsed.attachments, []);
    assert.doesNotMatch(JSON.stringify(parsed), /Unsupported email input|Maximum MIME/);
  }
});

test("parseRawMessageFull returns each attachment's bytes in the order of parsed.attachments", async () => {
  const message = raw(
    "From: alex@example.com",
    "To: sam@example.com",
    "Subject: Three parts",
    'Content-Type: multipart/mixed; boundary="three"',
    "",
    "--three",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "The body.",
    "--three",
    "Content-Type: text/plain; charset=utf-8",
    'Content-Disposition: attachment; filename="notes.txt"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from("plain notes", "utf8").toString("base64"),
    "--three",
    "Content-Type: application/pdf",
    'Content-Disposition: attachment; filename="doc.pdf"',
    "Content-Transfer-Encoding: base64",
    "",
    "JVBERi0xLjQK",
    "--three",
    "Content-Type: text/html; charset=utf-8",
    'Content-Disposition: attachment; filename="page.html"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from("<p>hi</p>", "utf8").toString("base64"),
    "--three--",
    "",
  );

  const full = await parseRawMessageFull(message);
  assert.equal(full.parsed.parseError, null);
  assert.deepEqual(
    full.parsed.attachments.map((a) => [a.filename, a.contentType]),
    [["notes.txt", "text/plain"], ["doc.pdf", "application/pdf"], ["page.html", "text/html"]],
  );
  assert.equal(full.attachmentContents.length, full.parsed.attachments.length);
  for (const bytes of full.attachmentContents) assert.ok(bytes instanceof Uint8Array, "bytes are a Uint8Array");
  assert.equal(Buffer.from(full.attachmentContents[0]).toString("utf8"), "plain notes");
  assert.equal(Buffer.from(full.attachmentContents[1]).toString("utf8"), "%PDF-1.4\n");
  assert.equal(Buffer.from(full.attachmentContents[2]).toString("utf8"), "<p>hi</p>");
  assert.equal(full.attachmentContents[1].byteLength, full.parsed.attachments[1].size);

  assert.deepEqual((await parseRawMessage(message)), full.parsed);
});

test("the full parse of garbage and of an oversized message has no contents and does not throw", async () => {
  for (const input of [42, oversizedMessage()]) {
    let full;
    await assert.doesNotReject(async () => { full = await parseRawMessageFull(input); });
    assert.deepEqual(full.attachmentContents, []);
    assert.ok(["unparseable", "too_large"].includes(full.parsed.parseError));
    assert.deepEqual(full.parsed.attachments, []);
  }
});

test("no input reaches the parser as a rejection, not even null or a bare buffer of junk", async () => {
  for (const input of [null, undefined, "", Buffer.from([0x01, 0x02, 0x03]), "Subject: x\r\n\r\nbody"]) {
    let full;
    await assert.doesNotReject(async () => { full = await parseRawMessageFull(input); });
    assert.ok(full.parsed, "a parsed placeholder is always returned");
    assert.equal(full.parsed.parseError === null || typeof full.parsed.parseError === "string", true);
  }
});