/**
 * GET /blog/media/:key is Funnel-public, so it may serve a stored object only
 * when a PUBLISHED PUBLIC blog post actually USES it:
 *
 *   (b) such a post's cover_image_key, or
 *   (c) a key one of their bodies links (`/blog/media/<key>`, the `storage:<key>`
 *       form the renderer/songbook turn into that path, or its encoded spelling —
 *       per segment AND whole-key).
 *
 * There is no third rule. A row's `reference_id` naming a published public post
 * is NOT a grant — the uploader supplies it, so trusting it let a bot host any
 * object publicly (a text/html page served on the dashboard's origin: stored
 * XSS) by pointing it at a published post's id. A file is public when a post
 * uses it, and not before.
 *
 * A row of ANOTHER kind is never served, however a public post uses it —
 * `research_source`/`research_note` stay off the Funnel — and a link only counts
 * as a WHOLE key: `a/b.pn` is not served because a post links `a/b.png`.
 *
 * What is served INLINE is servers/blog/media-policy.js's allowlist, shared with
 * the owner's route: a raster image, audio, video or a `.sunvox`
 * octet-stream. text/html, SVG and PDF (and anything else) go out as
 * `Content-Disposition: attachment` under `Content-Security-Policy: sandbox`,
 * always with `X-Content-Type-Options: nosniff`.
 *
 * Owner views are the other half: the draft preview, the editor's live preview,
 * the post list's thumbnails and the Files panel read the DASHBOARD's own media
 * route — `GET /dashboard/media/:key(*)` (routes/owner-media.js) — never a
 * loosened public route, and never `/storage/file/` (which sits behind the MCP
 * bearer auth an `<img>` cannot send). That route is fetched at the bottom of
 * this file through the REAL dashboardAuth, with a real session row.
 *
 * The object store is stubbed through each router's `storage` seam, so no S3 is
 * needed and the assertions are about the DECISION and the HEADERS, not real
 * bytes.
 *
 * The songbook + sunvox-studio tests cover that pair end to end: the URLs are
 * the ones a song page itself emits (percent-encoded for the SunVox project,
 * raw for the audio, both reaching the key through its post's
 * `**SunVox:**`/`**Audio:** storage:<key>` lines), fetched through this route.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import express from "express";
import { renderSongPage } from "../servers/blog/songbook-renderer.js";
import { actAsServe, serveHeaders } from "./fixtures/serve-peer.mjs";

// This process's HTTP client stands in for tailscaled (the Serve socket owner),
// so the REAL dashboardAuth's network gate admits these loopback requests.
actAsServe();

const ROOT = new URL("..", import.meta.url).pathname;
const tmp = mkdtempSync(join(tmpdir(), "blog-media-published-"));
const dataDir = join(tmp, "data");
mkdirSync(dataDir);
process.env.CROW_HOME = join(tmp, "home");
process.env.CROW_DATA_DIR = dataDir;
delete process.env.CROW_DB_PATH;

const DB_PATH = join(dataDir, "crow.db");

let server;
let base;
let ownerServer;
let ownerBase;
const ids = {};
const objects = new Map(); // key -> { bytes, mime }
const requested = [];      // keys getObject was asked for (the public route)
const ownerRequested = []; // the same, for the owner route
/** The owner's dashboard session token (its sha256 is the oauth_tokens row). */
const OWNER_SESSION = "owner-media-session";

/** Request path for a key: only `%` needs escaping (an invalid escape would
 *  make the URL parser's decode of the param throw rather than reach the route). */
function mediaPath(key) {
  return "/blog/media/" + key.replace(/%/g, "%25");
}

async function get(key) {
  const r = await fetch(base + mediaPath(key));
  return {
    status: r.status,
    contentType: r.headers.get("content-type"),
    nosniff: r.headers.get("x-content-type-options"),
    disposition: r.headers.get("content-disposition"),
    csp: r.headers.get("content-security-policy"),
    text: await r.text(),
  };
}

/** A storage_files row; `extra` can retype it (`reference_type: null` = an
 *  untyped old inline upload) or move it to another bucket. */
function row(s3_key, mime_type, reference_id = null, extra = {}) {
  return {
    s3_key,
    original_name: s3_key.split("/").pop(),
    mime_type,
    reference_type: "blog_post",
    reference_id,
    bucket: "crow-files",
    ...extra,
  };
}

/** A song page's ChordPro body. `crow_create_song` prepends these two metadata
 *  lines from sunvox-studio's saved keys, so the `storage:<key>` text in the
 *  post IS the post's reference to its project and its render. */
const CHORDPRO = "{title: Ramona}\n{key: C}\n\n{soc}\n[C]Ramona, [G]come closer\n{eoc}\n";
function songContent({ sunvoxKey, audioKey }) {
  return `**Audio:** storage:${audioKey}\n**SunVox:** storage:${sunvoxKey}\n${CHORDPRO}`;
}

// sunvox-studio saves with reference_type blog_post and no reference_id (the
// song is created afterwards), so nothing but the post's own metadata line
// ties a key to it. Only the published PUBLIC song may play.
const SONGS = {
  "public-song": {
    title: "Ramona", status: "published", visibility: "public",
    sunvoxKey: "sunvox-studio/projects/1700000000000-aaaabbbb-ramona.sunvox",
    audioKey: "sunvox-studio/renders/1700000000001-aaaabbbb-ramona.mp3",
  },
  "draft-song": {
    title: "Draft", status: "draft", visibility: "private",
    sunvoxKey: "sunvox-studio/projects/1700000000002-ccccdddd-draft.sunvox",
    audioKey: "sunvox-studio/renders/1700000000003-ccccdddd-draft.mp3",
  },
  "private-song": {
    title: "Private", status: "published", visibility: "private",
    sunvoxKey: "sunvox-studio/projects/1700000000004-eeeeffff-private.sunvox",
    audioKey: "sunvox-studio/renders/1700000000005-eeeeffff-private.mp3",
  },
};

/** The /blog/media URLs a song page emits: the player's data-src, the audio
 *  element's src and the download links (no cover on these songs). */
function songMediaUrls(slug) {
  const s = SONGS[slug];
  const html = renderSongPage({
    slug, title: s.title, content: songContent(s), tags: "songbook",
    author: "alex", published_at: "2026-10-17", cover_image_key: null,
  });
  return [...new Set(html.match(/\/blog\/media\/[^"'\s)<>]+/g) || [])];
}

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dataDir, CROW_DB_PATH: DB_PATH },
    stdio: "pipe",
    cwd: ROOT,
  });

  const { createDbClient } = await import("../servers/db.js");
  const db = createDbClient(DB_PATH);
  const post = async (slug, { status, visibility, content = "Body.", cover = null }) => {
    const { rows } = await db.execute({
      sql: `INSERT INTO blog_posts (slug, title, content, excerpt, status, visibility, cover_image_key, published_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now')) RETURNING id`,
      args: [slug, slug, content, `Excerpt ${slug}`, status, visibility, cover],
    });
    ids[slug] = rows[0].id;
    return rows[0].id;
  };

  await post("draft-post", {
    status: "draft",
    visibility: "private",
    content: "![d](/blog/media/inline/draft.png)\n\n![s](storage:inline/draft-stored.png)",
    cover: "cover/draft.png",
  });
  await post("private-post", { status: "published", visibility: "private" });
  await post("public-post", {
    status: "published",
    visibility: "public",
    content: [
      "![inline](/blog/media/inline/public.png)",
      "![stored](storage:inline/stored.mp3)",
      "![wrapped](/blog/media/wild/lit_%one.png)",
    ].join("\n\n"),
    cover: "cover/public.png",
  });
  await post("other-public", {
    status: "published",
    visibility: "public",
    content: "![enc](/blog/media/encoded/with%20space.png)",
  });
  // A post that links a LONGER key than the one its request names: the shorter
  // key is a strict prefix of this link, not a link to anything.
  await post("prefix-post", {
    status: "published",
    visibility: "public",
    content: "![p](/blog/media/prefix/a/b.png)",
  });
  // The whole-key percent-encoded spelling (what the songbook emits, %2F and
  // all) written into the body itself.
  await post("whole-key-post", {
    status: "published",
    visibility: "public",
    content: "![w](/blog/media/whole%2Fkey%2Fenc%20oded.png)",
  });
  // A public post whose body spells a `research_source` key, and whose cover is
  // another: neither row may be served, whatever the post says.
  await post("typed-post", {
    status: "published",
    visibility: "public",
    content: "![t](/blog/media/typed/research-source.png)",
    cover: "typed/cover-source.png",
  });
  // The older inline uploads carry no reference_type at all.
  await post("untyped-post", {
    status: "published",
    visibility: "public",
    content: "![u](/blog/media/untyped/inline.png)",
  });
  await post("bucket-post", {
    status: "published",
    visibility: "public",
    content: "![b](/blog/media/bucket/other.png)",
  });
  // One published public post that links EVERY type the inline allowlist is
  // about: an HTML page and an SVG (attachments), a pdf, a video, and a SunVox
  // project stored as octet-stream (inline, the player fetches the bytes).
  await post("types-post", {
    status: "published",
    visibility: "public",
    content: [
      "![h](/blog/media/types/page.html)",
      "![s](/blog/media/types/icon.svg)",
      "![d](/blog/media/types/doc.pdf)",
      "![v](/blog/media/types/clip.mp4)",
      "![x](/blog/media/types/project.sunvox)",
      "![t](/blog/media/types/notes.txt)",
    ].join("\n\n"),
  });

  for (const [slug, s] of Object.entries(SONGS)) {
    await post(slug, { status: s.status, visibility: s.visibility, content: songContent(s) });
  }

  const files = [
    row("unref/orphan.png", "image/png"),                                  // (no reference_id, unlinked)
    row("draft-ref/key.png", "image/png", ids["draft-post"]),              // names a draft: no grant either way
    row("private-ref/key.png", "image/png", ids["private-post"]),          // published but private
    // Names a published PUBLIC post — and that alone is NOT a grant: the row's
    // reference_id is the uploader's claim (the bot-upload finding).
    row("public-ref/key.png", "image/png", ids["public-post"]),
    // An attacker-supplied HTML page "attached" to a published public post:
    // refused unless the post itself links it.
    row("typed-by-ref/page.html", "text/html", ids["public-post"]),
    row("cover/public.png", "image/png"),                                  // a published public post's cover
    row("cover/draft.png", "image/png"),                                   // a draft's cover
    row("inline/public.png", "image/png"),                                 // linked from published public content
    row("inline/draft.png", "image/png"),                                  // linked from a draft's content
    row("inline/stored.mp3", "audio/mpeg"),                                // linked in the `storage:` form
    row("encoded/with space.png", "image/png"),                            // linked, percent-encoded
    row("wild/lit_%one.png", "image/png"),                                 // linked, with a literal % in the key
    row("inline/publ_c.png", "image/png"),                                 // NOT linked: LIKE `_` would match inline/public.png
    row("inline/p%c.png", "image/png"),                                    // NOT linked: LIKE `%` would match inline/public.png
    // The prefix probe: a row of its own that nothing but a prefix-match would
    // have served (the post links `prefix/a/b.png`).
    row("prefix/a/b.pn", "image/png"),
    // Linked whole-key encoded from a public post's body.
    row("whole/key/enc oded.png", "image/png"),
    // Typed rows a published public post uses — and the route must still refuse.
    row("typed/research-source.png", "image/png", null, { reference_type: "research_source" }),
    row("typed/cover-source.png", "image/png", null, { reference_type: "research_note" }),
    // An UNTYPED (NULL) older inline upload, linked from a public post.
    row("untyped/inline.png", "image/png", null, { reference_type: null }),
    // A row in its own bucket, linked from a public post.
    row("bucket/other.png", "image/webp", null, { bucket: "blog-media-bucket" }),
    // The type allowlist (media-policy.js): an HTML page, an SVG, a PDF and a
    // plain text file are ATTACHMENTS; a video and a SunVox project are inline.
    row("types/page.html", "text/html"),
    row("types/icon.svg", "image/svg+xml"),
    row("types/doc.pdf", "application/pdf"),
    row("types/notes.txt", "text/plain"),
    row("types/clip.mp4", "video/mp4"),
    row("types/project.sunvox", "application/octet-stream"),
    // sunvox-studio's saves: reference_type blog_post, NO reference_id.
    ...[...Object.values(SONGS)].flatMap((s) => [row(s.sunvoxKey, "application/octet-stream"), row(s.audioKey, "audio/mpeg")]),
  ];
  for (const f of files) {
    await db.execute({
      sql: `INSERT INTO storage_files (s3_key, original_name, mime_type, bucket, reference_type, reference_id)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [f.s3_key, f.original_name, f.mime_type, f.bucket, f.reference_type, f.reference_id],
    });
    objects.set(f.s3_key, { bytes: Buffer.from(`bytes of ${f.s3_key}`), mime: f.mime_type });
  }
  db.close();

  const { default: blogPublicRouter } = await import("../servers/gateway/routes/blog-public.js");
  const app = express();
  app.use(express.json());
  app.use(blogPublicRouter({
    storage: {
      async isAvailable() { return true; },
      async getObject(key, opts = {}) {
        requested.push({ key, bucket: opts.bucket || null });
        const o = objects.get(key);
        if (!o) throw new Error("Object not found");
        return { stream: Readable.from([o.bytes]), stat: { size: o.bytes.length } };
      },
    },
  }));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;

  // --- the OWNER's media route, through the REAL dashboardAuth --------------
  // A dashboard session row, exactly as dashboard/auth.js stores one (the
  // sha256 of the token, client_id 'dashboard').
  const { hashToken, dashboardAuth } = await import("../servers/gateway/dashboard/auth.js");
  const ownerDb = createDbClient(DB_PATH);
  await ownerDb.execute({
    sql: "INSERT INTO oauth_tokens (token, token_type, client_id, scopes, expires_at) VALUES (?, 'access', 'dashboard', 'dashboard', datetime('now', '+1 day'))",
    args: [hashToken(OWNER_SESSION)],
  });
  ownerDb.close();

  const { default: ownerMediaRouter } = await import("../servers/gateway/routes/owner-media.js");
  const { rejectFunneledMiddleware } = await import("../servers/gateway/funnel.js");
  const ownerApp = express();
  // The gateway's own helpers/middleware, then the real Funnel guard and the
  // real dashboard session auth: `res.redirectAfterPost` is gateway middleware
  // (servers/gateway/index.js), and dashboardAuth answers a missing session
  // with it.
  ownerApp.use((req, res, next) => { res.redirectAfterPost = (url) => res.redirect(303, url); next(); });
  ownerApp.use(rejectFunneledMiddleware());
  ownerApp.use(ownerMediaRouter(dashboardAuth, {
    storage: {
      async isAvailable() { return true; },
      async getObject(key, opts = {}) {
        ownerRequested.push({ key, bucket: opts.bucket || null });
        const o = objects.get(key);
        if (!o) throw new Error("Object not found");
        return { stream: Readable.from([o.bytes]), stat: { size: o.bytes.length } };
      },
    },
  }));
  ownerServer = http.createServer(ownerApp);
  await new Promise((r) => ownerServer.listen(0, "127.0.0.1", r));
  ownerBase = `http://127.0.0.1:${ownerServer.address().port}`;
});

after(() => {
  server?.close();
  ownerServer?.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function expectRefused(key) {
  const r = await get(key);
  assert.equal(r.status, 404, `${key} must not be served`);
  assert.equal(r.text, "Not found", `${key}: the refusal text is the same for every case`);
  return r;
}

async function expectServed(key, mime) {
  const r = await get(key);
  assert.equal(r.status, 200, `${key} must be served`);
  assert.equal(r.contentType, mime, `${key}: the MIME type comes from storage_files`);
  assert.equal(r.text, `bytes of ${key}`);
  return r;
}

test("a blog_post row with no reference_id and no link anywhere is refused", async () => {
  await expectRefused("unref/orphan.png");
});

test("a reference_id naming a draft post is refused", async () => {
  await expectRefused("draft-ref/key.png");
});

test("a reference_id naming a published PRIVATE post is refused", async () => {
  await expectRefused("private-ref/key.png");
});

test("a reference_id naming a published PUBLIC post is not enough on its own", async () => {
  // The uploader supplies reference_id, so it can name any published post. Only
  // the post's own USE of the key — as its cover, or a link in its text — is a
  // grant; without it the object stays private, whatever id the row claims.
  await expectRefused("public-ref/key.png");
});

test("a text/html object pointed at a published post by reference_id is refused", async () => {
  // The stored-XSS probe: `text/html` is uploadable, and this row claims a
  // published public post. It is served only if that post links it, so it is a
  // 404 — never a page on the blog's (and dashboard's) origin.
  await expectRefused("typed-by-ref/page.html");
});

test("only media is inline: html, svg, pdf and text come back as attachments with a sandboxing CSP", async () => {
  // Express normalizes a text/* Content-Type with its charset; the DECISION is
  // the disposition, and that is what is asserted.
  for (const [key, mime] of [
    ["types/page.html", /^text\/html/],
    ["types/icon.svg", /^image\/svg\+xml/],
    ["types/doc.pdf", /^application\/pdf/],
    ["types/notes.txt", /^text\/plain/],
  ]) {
    const r = await get(key);
    assert.equal(r.status, 200, `${key} must be served (the post links it)`);
    assert.match(r.contentType, mime, `${key}: the MIME type comes from storage_files`);
    assert.equal(r.nosniff, "nosniff", `${key}: nosniff always`);
    assert.equal(r.disposition, "attachment", `${key}: never an inline document`);
    assert.equal(r.csp, "sandbox", `${key}: and a sandboxed one at that`);
  }
});

test("a video and a .sunvox project are inline; an octet-stream that is not a .sunvox is not", async () => {
  const video = await expectServed("types/clip.mp4", "video/mp4");
  assert.equal(video.disposition, null, "a video is played in the page");
  const project = await expectServed("types/project.sunvox", "application/octet-stream");
  assert.equal(project.disposition, null, "the SunVox player fetches these bytes");
  assert.equal(project.nosniff, "nosniff");
});

test("the inline allowlist helper is the one both media routes use", async () => {
  const { isInlineMediaType } = await import("../servers/blog/media-policy.js");
  for (const t of ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "audio/mpeg", "video/mp4"]) {
    assert.equal(isInlineMediaType(t, "a.bin"), true, t);
  }
  assert.equal(isInlineMediaType("application/octet-stream", "a.sunvox"), true);
  assert.equal(isInlineMediaType("application/octet-stream", "a.bin"), false);
  for (const t of ["text/html", "image/svg+xml", "application/pdf", "text/plain", "application/json", "", null]) {
    assert.equal(isInlineMediaType(t, "a.png"), false, String(t));
  }
});

test("a draft post's cover is refused; a published public post's cover is served", async () => {
  await expectRefused("cover/draft.png");
  await expectServed("cover/public.png", "image/png");
});

test("a key linked from a published public post's content is served", async () => {
  await expectServed("inline/public.png", "image/png");
});

test("a key linked only from a draft's content is refused", async () => {
  await expectRefused("inline/draft.png");
});

test("the `storage:<key>` form used by the renderer and the songbook counts as a link", async () => {
  await expectServed("inline/stored.mp3", "audio/mpeg");
});

test("a percent-encoded link in the content still matches the key", async () => {
  await expectServed("encoded/with space.png", "image/png");
});

test("a % or _ in a key is literal, never a LIKE wildcard", async () => {
  // Both refused keys are rows of their own that nothing links. Built into a
  // LIKE pattern they would match the linked `inline/public.png` (`_` one char,
  // `%` any run); instr matches the bytes only, so they stay refused. The
  // literal `%` in the last key is linked, so it is served.
  await expectRefused("inline/publ_c.png");
  await expectRefused("inline/p%c.png");
  await expectServed("wild/lit_%one.png", "image/png");
});

test("a strict prefix of a linked key is not served", async () => {
  // The post links `/blog/media/prefix/a/b.png`; `prefix/a/b.pn` is its head,
  // not a link. `instr` alone served it (the substring IS in the content), so
  // the character after each hit is checked in JS.
  await expectRefused("prefix/a/b.pn");
});

test("a whole-key percent-encoded link in a public post's body is served", async () => {
  // `whole/key/enc oded.png` spelled `whole%2Fkey%2Fenc%20oded.png`, the shape
  // the songbook emits for a SunVox project.
  await expectServed("whole/key/enc oded.png", "image/png");
});

test("a storage row of another kind is never served, however a public post uses it", async () => {
  // Both rows are `research_source`/`research_note`: linked from a published
  // public post's body, and used as another's cover_image_key. (b) and (c) are
  // about a BLOG post's use of a key, not a licence to publish any object.
  await expectRefused("typed/research-source.png");
  await expectRefused("typed/cover-source.png");
});

test("an untyped (NULL reference_type) inline upload linked from a public post is served", async () => {
  await expectServed("untyped/inline.png", "image/png");
});

test("every served object is nosniff, and the row's own bucket is the one read", async () => {
  const plain = await expectServed("inline/public.png", "image/png");
  assert.equal(plain.nosniff, "nosniff", "a Funnel-public object is never sniffed");
  assert.deepEqual(requested[requested.length - 1], { key: "inline/public.png", bucket: "crow-files" });

  const moved = await expectServed("bucket/other.png", "image/webp");
  assert.equal(moved.nosniff, "nosniff");
  assert.deepEqual(requested[requested.length - 1], { key: "bucket/other.png", bucket: "blog-media-bucket" },
    "the object is read from its own bucket, not the client's default");
});

test("every refusal is the same 404 with the same text, and never reaches storage", async () => {
  const keys = ["unref/orphan.png", "draft-ref/key.png", "private-ref/key.png", "cover/draft.png", "inline/draft.png", "inline/publ_c.png", "prefix/a/b.pn", "typed/research-source.png", "typed/cover-source.png"];
  const seen = [];
  for (const key of keys) {
    const before = requested.length;
    const r = await expectRefused(key);
    assert.equal(requested.length, before, `${key}: a refusal must not fetch the object`);
    seen.push(`${r.status} ${r.text}`);
  }
  assert.equal(new Set(seen).size, 1, `all refusals identical: ${JSON.stringify(seen)}`);
});

// --- a sunvox-studio song that a published public songbook post plays --------
// The URLs are not written out by hand here: they are the ones the song page
// itself emits (percent-encoded per segment for the SunVox project, raw for the
// audio), fetched through the same route the Funnel exposes.

test("a song saved by sunvox-studio plays on a published public song post", async () => {
  const urls = songMediaUrls("public-song");
  assert.equal(urls.length, 2, `the player and the audio element, nothing else: ${urls}`);
  assert.ok(urls.some((u) => u === "/blog/media/sunvox-studio%2Fprojects%2F1700000000000-aaaabbbb-ramona.sunvox"),
    `the SunVox card fetches the project percent-encoded: ${urls}`);
  assert.ok(urls.includes("/blog/media/sunvox-studio/renders/1700000000001-aaaabbbb-ramona.mp3"),
    `the audio element fetches the render: ${urls}`);
  for (const url of urls) {
    const r = await fetch(base + url);
    assert.equal(r.status, 200, `${url} must be served: the post is published and public`);
    await r.text();
  }
});

test("a song's SunVox project and audio 404 while its post is a draft or not public", async () => {
  for (const slug of ["draft-song", "private-song"]) {
    const urls = songMediaUrls(slug);
    assert.equal(urls.length, 2, `${slug}: the page still emits the player and the audio element`);
    for (const url of urls) {
      const before = requested.length;
      const r = await fetch(base + url);
      assert.equal(r.status, 404, `${slug}: ${url} must not be served`);
      assert.equal(await r.text(), "Not found");
      assert.equal(requested.length, before, `${slug}: a refusal must not fetch the object`);
    }
  }
});

// --- owner views of unpublished media --------------------------------------
// The public route above refuses a DRAFT's images — correctly. The owner's own
// views must still draw them, so they render media against the DASHBOARD's
// media route: `GET /dashboard/media/:key(*)` (servers/gateway/routes/
// owner-media.js), which is behind dashboardAuth and never public. NOT
// `/storage/file/`: that route sits behind the MCP bearer auth (requireBearerAuth
// reads only `Authorization`), and a browser `<img>` sends only the crow_session
// cookie, so every draft image there was a 401. The public blog pages keep
// `/blog/media/`.

/** Run a dashboard panel handler with a stub layout and capture what it sends. */
async function runPanel(panel, req, db) {
  let sent = null;
  const res = {
    headersSent: false,
    type() { return res; },
    send(html) { sent = html; res.headersSent = true; return res; },
    redirectAfterPost(url) { throw new Error(`unexpected redirect to ${url}`); },
  };
  const returned = await panel.handler({ method: "GET", body: {}, query: {}, headers: {}, ...req }, res, {
    db, lang: "en", layout: ({ content }) => content,
  });
  // A panel may send the page itself (the blog panel's preview) or RETURN what
  // the layout produced (the Files panel, whose handler returns layout(...)).
  const html = sent ?? returned;
  assert.equal(typeof html, "string", "the panel rendered a page");
  return html;
}

/** A db client for a panel test (the fixture client was closed in before()). */
async function openDb() {
  const { createDbClient } = await import("../servers/db.js");
  return createDbClient(DB_PATH);
}

test("the blog panel's draft preview points a draft's media at the dashboard media route", async () => {
  const { default: blogPanel } = await import("../servers/gateway/dashboard/panels/blog.js");
  const db = await openDb();
  try {
    const html = await runPanel(blogPanel, { query: { preview: String(ids["draft-post"]) } }, db);
    // Both markdown spellings the editor writes.
    assert.match(html, /<img[^>]*src="\/dashboard\/media\/inline\/draft\.png"/, html);
    assert.match(html, /<img[^>]*src="\/dashboard\/media\/inline\/draft-stored\.png"/, html);
    assert.doesNotMatch(html, /\/blog\/media\//, `an unpublished image never points at the public route: ${html}`);
    assert.doesNotMatch(html, /\/storage\/file\//, `nor at the MCP-bearer route an <img> cannot reach: ${html}`);
  } finally {
    db.close();
  }
});

test("the blog panel's post list thumbnails use the dashboard media route too", async () => {
  const { default: blogPanel } = await import("../servers/gateway/dashboard/panels/blog.js");
  const db = await openDb();
  try {
    const html = await runPanel(blogPanel, {}, db);
    assert.match(html, /<img src="\/dashboard\/media\/cover%2Fdraft\.png"/, html);
    assert.doesNotMatch(html, /\/storage\/file\//, html);
  } finally {
    db.close();
  }
});

test("the editor's live preview renders the same way (POST /blog/preview)", async () => {
  const res = await fetch(`${base}/blog/preview`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie: "crow_session=test" },
    body: JSON.stringify({ markdown: "![a](/blog/media/inline/draft.png)\n\n![b](storage:inline/draft-stored.png)" }),
  });
  assert.equal(res.status, 200);
  const { html } = await res.json();
  assert.match(html, /src="\/dashboard\/media\/inline\/draft\.png"/, html);
  assert.match(html, /src="\/dashboard\/media\/inline\/draft-stored\.png"/, html);
  assert.doesNotMatch(html, /\/blog\/media\//, html);
  assert.doesNotMatch(html, /\/storage\/file\//, html);
});

test("the live preview still requires a dashboard session", async () => {
  const res = await fetch(`${base}/blog/preview`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ markdown: "![a](/blog/media/x.png)" }),
  });
  assert.equal(res.status, 401);
});

test("the public page of a published post still uses /blog/media", async () => {
  const res = await fetch(`${base}/blog/public-post`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /src="\/blog\/media\/inline\/public\.png"/, html);
  assert.doesNotMatch(html, /\/dashboard\/media\//, `the public page never points at the owner's route: ${html}`);
  assert.doesNotMatch(html, /\/storage\/file\//, `the public page never points at the MCP-bearer route: ${html}`);
});

test("the owner preview's media base loosens nothing: a path that resolves out is still refused", async () => {
  // `mediaBase` only swaps the PREFIX of a path the public media route would
  // itself have served (rewriteMediaSrc / isMediaPathUnder). A reference that
  // escapes either route is refused exactly as it is on every other path, so a
  // draft's markdown cannot turn a preview into a same-origin GET on
  // /dashboard/logout — the trick the image rule exists to stop.
  const { renderMarkdown, OWNER_MEDIA_BASE } = await import("../servers/blog/renderer.js");
  assert.equal(OWNER_MEDIA_BASE, "/dashboard/media/", "the owner's media base is the dashboard route");
  for (const src of [
    "/blog/media/../dashboard/logout",
    "/blog/media/%2e%2e/dashboard/logout",
    "/dashboard/media/../../dashboard/logout",
    "/dashboard/media/%2e%2e/x",
    "/dashboard/logout",
  ]) {
    const html = renderMarkdown(`![x](${src})`, { mediaBase: OWNER_MEDIA_BASE });
    assert.doesNotMatch(html, /<img/i, `${src}: ${html}`);
    assert.doesNotMatch(html, /(?:dashboard\/logout|%2e)/i, `${src}: ${html}`);
  }
  // A cache-busting query travels with the key, exactly as the media route's
  // own shape allows.
  assert.match(
    renderMarkdown("![a](/blog/media/a/b.png?v=1)", { mediaBase: OWNER_MEDIA_BASE }),
    /src="\/dashboard\/media\/a\/b\.png\?v=1"/
  );
});

test("the Files panel links the dashboard media route, whatever the file's type", async () => {
  const { default: filesPanel } = await import("../servers/gateway/dashboard/panels/files.js");
  const db = await openDb();
  try {
    const html = await runPanel(filesPanel, {}, db);
    // A blog-typed row: the public route would 404 it until a post publishes.
    assert.match(html, /src="\/dashboard\/media\/public-ref%2Fkey\.png"/, html);
    assert.match(html, /src="\/dashboard\/media\/unref%2Forphan\.png"/, html);
    assert.doesNotMatch(html, /\/blog\/media\//, `no file card points at the public route: ${html}`);
    assert.doesNotMatch(html, /\/storage\/file\//, `nor at the MCP-bearer route an <img> cannot reach: ${html}`);
  } finally {
    db.close();
  }
});

// --- the OWNER's media route, through the REAL dashboardAuth ---------------
// GET /dashboard/media/:key(*), fetched over HTTP with the real session
// validator and the real Funnel guard. The requests carry Serve's headers
// (actAsServe at the top of the file): dashboardAuth's network gate admits a
// tailnet client through Serve, and refuses everything else.

const OWNER_HEADERS = { ...serveHeaders("owner@example.com"), cookie: `crow_session=${OWNER_SESSION}` };

function ownerPath(key) {
  return "/dashboard/media/" + key.replace(/%/g, "%25");
}

async function ownerGet(key, headers = OWNER_HEADERS) {
  const r = await fetch(ownerBase + ownerPath(key), { headers, redirect: "manual" });
  return {
    status: r.status,
    location: r.headers.get("location"),
    contentType: r.headers.get("content-type"),
    nosniff: r.headers.get("x-content-type-options"),
    cacheControl: r.headers.get("cache-control"),
    disposition: r.headers.get("content-disposition"),
    csp: r.headers.get("content-security-policy"),
    text: await r.text(),
  };
}

test("owner media: a dashboard session gets the bytes, proxied, private and nosniff", async () => {
  const r = await ownerGet("unref/orphan.png");
  assert.equal(r.status, 200);
  assert.equal(r.text, "bytes of unref/orphan.png");
  assert.equal(r.contentType, "image/png");
  assert.equal(r.nosniff, "nosniff");
  assert.equal(r.cacheControl, "private, no-store", "the owner's own view is never shared-cached");
  assert.equal(r.location, null, "the bytes are proxied, never a redirect to the http:// object store");
  assert.equal(r.disposition, null, "an image draws inline");
});

test("owner media: an unpublished file is served (that is the whole point)", async () => {
  for (const key of ["draft-ref/key.png", "cover/draft.png", "typed-by-ref/page.html"]) {
    const r = await ownerGet(key);
    assert.equal(r.status, 200, `${key}: the owner sees their own drafts`);
    assert.equal(r.text, `bytes of ${key}`);
  }
});

test("owner media: no session is a redirect to the login page, not the bytes", async () => {
  const r = await ownerGet("inline/public.png", { ...serveHeaders("owner@example.com") });
  assert.equal(r.status, 303);
  assert.match(r.location, /\/dashboard\/login$/);
  assert.equal(r.text.includes("bytes of"), false, "no object is leaked");
});

test("owner media: a bearer token alone is not a dashboard session", async () => {
  // /storage/file/ accepts exactly this; this route must not.
  const r = await ownerGet("inline/public.png", { ...serveHeaders("owner@example.com"), authorization: "Bearer some-mcp-token" });
  assert.equal(r.status, 303);
  assert.match(r.location, /\/dashboard\/login$/);
  assert.equal(r.text.includes("bytes of"), false);
});

test("owner media: a Tailscale-Funnel-Request is refused before the route", async () => {
  const { PUBLIC_FUNNEL_PREFIXES, isFunnelPublicPath } = await import("../servers/gateway/funnel.js");
  assert.equal(isFunnelPublicPath("/dashboard/media/x.png", PUBLIC_FUNNEL_PREFIXES), false,
    "/dashboard/media is never a Funnel-public path");
  const r = await ownerGet("inline/public.png", { ...OWNER_HEADERS, "tailscale-funnel-request": "?1" });
  assert.equal(r.status, 403);
  assert.equal(r.text.includes("bytes of"), false);
});

test("owner media: an unknown key is a 404 and never touches storage", async () => {
  const before = ownerRequested.length;
  const r = await ownerGet("no/such/object.png");
  assert.equal(r.status, 404);
  assert.equal(r.text, "Not found");
  assert.equal(ownerRequested.length, before);
});

test("owner media: the row's own bucket is the one read", async () => {
  const r = await ownerGet("bucket/other.png");
  assert.equal(r.status, 200);
  assert.deepEqual(ownerRequested[ownerRequested.length - 1], { key: "bucket/other.png", bucket: "blog-media-bucket" });
});

test("owner media: the same type rule as the public route (html and svg are attachments)", async () => {
  const html = await ownerGet("types/page.html");
  assert.equal(html.status, 200);
  assert.match(html.contentType, /^text\/html/);
  assert.equal(html.disposition, "attachment");
  assert.equal(html.csp, "sandbox");
  assert.equal(html.nosniff, "nosniff");

  const svg = await ownerGet("types/icon.svg");
  assert.equal(svg.disposition, "attachment", "an SVG is a document: never inline");
  assert.equal(svg.csp, "sandbox");

  const project = await ownerGet("types/project.sunvox");
  assert.equal(project.disposition, null, "the songbook player fetches these bytes");
});

test("owner media: a session without a tailnet-shaped client is refused by the network gate", async () => {
  // Same session, no Serve-shaped client address: the gate closes (403).
  const off = await ownerGet("inline/public.png", { cookie: `crow_session=${OWNER_SESSION}` });
  assert.equal(off.status, 403);
  assert.equal(off.text.includes("bytes of"), false);
});