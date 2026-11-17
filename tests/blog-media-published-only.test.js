/**
 * GET /blog/media/:key is Funnel-public, so it may serve a stored object only
 * when a PUBLISHED PUBLIC blog post actually uses it:
 *
 *   (a) a storage_files row whose reference_id names such a post,
 *   (b) such a post's cover_image_key, or
 *   (c) a key one of their bodies links (`/blog/media/<key>`, the `storage:<key>`
 *       form the renderer/songbook turn into that path, or its encoded spelling).
 *
 * A bare `reference_type = 'blog_post'` row is NOT enough: the upload API
 * accepts it with no reference_id (the blog panel's own cover upload does), so
 * before this fix any caller with storage tools could host arbitrary files
 * publicly, and a draft's images were public before the post was published.
 *
 * The object store is stubbed through the router's `storage` seam, so no S3 is
 * needed and the assertions are about the DECISION, not the bytes.
 *
 * The last two tests cover the songbook + sunvox-studio pair end to end: the
 * URLs are the ones a song page itself emits (percent-encoded for the SunVox
 * project, raw for the audio, both reaching the key through its post's
 * `**SunVox:**`/`**Audio:** storage:<key>` lines), fetched through this route.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import { Readable } from "node:stream";
import express from "express";
import { renderSongPage } from "../servers/blog/songbook-renderer.js";

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
const ids = {};
const objects = new Map(); // key -> { bytes, mime }
const requested = [];      // keys getObject was asked for

/** Request path for a key: only `%` needs escaping (an invalid escape would
 *  make the URL parser's decode of the param throw rather than reach the route). */
function mediaPath(key) {
  return "/blog/media/" + key.replace(/%/g, "%25");
}

async function get(key) {
  const r = await fetch(base + mediaPath(key));
  return { status: r.status, contentType: r.headers.get("content-type"), text: await r.text() };
}

function row(s3_key, mime_type, reference_id = null) {
  return { s3_key, original_name: s3_key.split("/").pop(), mime_type, reference_type: "blog_post", reference_id };
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
    content: "![d](/blog/media/inline/draft.png)",
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

  for (const [slug, s] of Object.entries(SONGS)) {
    await post(slug, { status: s.status, visibility: s.visibility, content: songContent(s) });
  }

  const files = [
    row("unref/orphan.png", "image/png"),                                  // (no reference_id, unlinked)
    row("draft-ref/key.png", "image/png", ids["draft-post"]),              // names a draft
    row("private-ref/key.png", "image/png", ids["private-post"]),          // published but private
    row("public-ref/key.png", "image/png", ids["public-post"]),            // names a published public post
    row("cover/public.png", "image/png"),                                  // a published public post's cover
    row("cover/draft.png", "image/png"),                                   // a draft's cover
    row("inline/public.png", "image/png"),                                 // linked from published public content
    row("inline/draft.png", "image/png"),                                  // linked from a draft's content
    row("inline/stored.mp3", "audio/mpeg"),                                // linked in the `storage:` form
    row("encoded/with space.png", "image/png"),                            // linked, percent-encoded
    row("wild/lit_%one.png", "image/png"),                                 // linked, with a literal % in the key
    row("inline/publ_c.png", "image/png"),                                 // NOT linked: LIKE `_` would match inline/public.png
    row("inline/p%c.png", "image/png"),                                    // NOT linked: LIKE `%` would match inline/public.png
    // sunvox-studio's saves: reference_type blog_post, NO reference_id.
    ...[...Object.values(SONGS)].flatMap((s) => [row(s.sunvoxKey, "application/octet-stream"), row(s.audioKey, "audio/mpeg")]),
  ];
  for (const f of files) {
    await db.execute({
      sql: `INSERT INTO storage_files (s3_key, original_name, mime_type, bucket, reference_type, reference_id)
            VALUES (?, ?, ?, 'crow-files', ?, ?)`,
      args: [f.s3_key, f.original_name, f.mime_type, f.reference_type, f.reference_id],
    });
    objects.set(f.s3_key, { bytes: Buffer.from(`bytes of ${f.s3_key}`), mime: f.mime_type });
  }
  db.close();

  const { default: blogPublicRouter } = await import("../servers/gateway/routes/blog-public.js");
  const app = express();
  app.use(blogPublicRouter({
    storage: {
      async isAvailable() { return true; },
      async getObject(key) {
        requested.push(key);
        const o = objects.get(key);
        if (!o) throw new Error("Object not found");
        return { stream: Readable.from([o.bytes]), stat: { size: o.bytes.length } };
      },
    },
  }));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
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

test("a reference_id naming a published PUBLIC post is served", async () => {
  await expectServed("public-ref/key.png", "image/png");
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

test("every refusal is the same 404 with the same text, and never reaches storage", async () => {
  const keys = ["unref/orphan.png", "draft-ref/key.png", "private-ref/key.png", "cover/draft.png", "inline/draft.png", "inline/publ_c.png"];
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