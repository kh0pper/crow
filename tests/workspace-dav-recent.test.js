import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

let server, bodies, cfg, dav;
const MIMES = ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/vnd.oasis.opendocument.text"];

before(async () => {
  bodies = [];
  server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      bodies.push({ method: req.method, body: Buffer.concat(chunks).toString() });
      res.writeHead(207, { "Content-Type": "application/xml" });
      res.end(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns" xmlns:nc="http://nextcloud.org/ns">
        <d:response><d:href>/remote.php/dav/files/crow-bot/Shared%20with%20Crow/plan.docx</d:href><d:propstat><d:prop>
          <d:getlastmodified>Mon, 26 Oct 2026 10:00:00 GMT</d:getlastmodified><d:getcontentlength>12</d:getcontentlength>
          <d:getcontenttype>${MIMES[0]}</d:getcontenttype><d:resourcetype/><oc:fileid>4242</oc:fileid>
        </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`);
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const ncUrl = `http://127.0.0.1:${server.address().port}`;
  cfg = Object.freeze({ user: "crow-bot", appPassword: "pw", jwtSecret: "jwt", ncUrl, ooUrl: ncUrl, host: "h", webBase: "https://h:8456", secrets: ["pw", "jwt"] });
  dav = await import("../bundles/workspace/server/nc/dav.js");
});
after(() => new Promise((r) => server.close(r)));

test("listRecent sends a SEARCH ordered by last modified", async () => {
  await dav.listRecent(cfg, { limit: 40, mimes: MIMES });
  const b = bodies.at(-1);
  assert.equal(b.method, "SEARCH");
  assert.match(b.body, /<d:orderby>/);
  assert.match(b.body, /getlastmodified/);
  assert.match(b.body, /<d:nresults>40</);
  for (const m of MIMES) assert.ok(b.body.includes(`<d:literal>${m}</d:literal>`), m);
  assert.match(b.body, /<d:getcontenttype\/>/);
});

test("listRecent maps fileid", async () => {
  const out = await dav.listRecent(cfg, { limit: 5, mimes: MIMES });
  assert.equal(out.length, 1);
  assert.equal(out[0].fileId, 4242);
  assert.equal(out[0].name, "plan.docx");
});

test("listRecent with no mimes asks for nothing", async () => {
  const n = bodies.length;
  assert.deepEqual(await dav.listRecent(cfg, { mimes: [] }), []);
  assert.equal(bodies.length, n);
});
