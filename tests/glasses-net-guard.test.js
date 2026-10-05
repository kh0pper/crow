/**
 * The artwork proxy's outbound rule (bundles/meta-glasses/server/net-guard.js): private addresses
 * refused (v4, v6, v4-mapped, unspecified), the checked address is the one connected to, images
 * only, a size cap, no redirects. Loopback servers stand in for the far side; the private-address
 * refusal is exercised with allowPrivate off, everything else with it on (the music-origin case).
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { isPrivateAddress, fetchImagePinned, FetchRefused } from "../bundles/meta-glasses/server/net-guard.js";

const servers = [];
const serve = (handler) => new Promise((res) => { const s = http.createServer(handler); servers.push(s); s.listen(0, "127.0.0.1", () => res(s.address().port)); });
after(() => { for (const s of servers) { s.closeAllConnections?.(); s.close(); } });

test("isPrivateAddress: unspecified, loopback, private, link-local, CGNAT, multicast, IPv6 local and v4-mapped are private; public addresses are not", () => {
  for (const a of ["0.0.0.0", "0.1.2.3", "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "100.127.255.255", "224.0.0.1",
    "::", "::1", "fc00::1", "fd12:3456::1", "fe80::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "[::1]", "not-an-ip"]) assert.equal(isPrivateAddress(a), true, a);
  for (const a of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "100.128.0.1", "2606:4700::1111", "::ffff:8.8.8.8"]) assert.equal(isPrivateAddress(a), false, a);
});

test("a host that resolves to a private address is refused before any connection; 0.0.0.0 and [::1] too", async () => {
  let hits = 0;
  const port = await serve((req, res) => { hits += 1; res.writeHead(200, { "content-type": "image/png" }); res.end("PNG"); });
  await assert.rejects(fetchImagePinned(`http://art.example.invalid:${port}/a.png`, { lookup: async () => [{ address: "127.0.0.1", family: 4 }] }), (e) => e instanceof FetchRefused && e.code === "host_not_allowed" && e.status === 403);
  await assert.rejects(fetchImagePinned(`http://0.0.0.0:${port}/a.png`), (e) => e.code === "host_not_allowed");
  await assert.rejects(fetchImagePinned(`http://[::1]:${port}/a.png`), (e) => e.code === "host_not_allowed");
  await assert.rejects(fetchImagePinned(`http://mixed.example.invalid:${port}/a.png`, { lookup: async () => [{ address: "8.8.8.8", family: 4 }, { address: "10.0.0.5", family: 4 }] }), (e) => e.code === "host_not_allowed", "one private answer is enough to refuse");
  assert.equal(hits, 0);
});

test("the connection goes to the address that was checked (no second lookup), and only an image comes back", async () => {
  const port = await serve((req, res) => {
    if (req.url === "/a.png") { res.writeHead(200, { "content-type": "image/png" }); return res.end("PNGDATA"); }
    if (req.url === "/page") { res.writeHead(200, { "content-type": "text/html" }); return res.end("<script>"); }
    if (req.url === "/move") { res.writeHead(302, { location: "http://169.254.169.254/" }); return res.end(); }
    res.writeHead(200, { "content-type": "image/jpeg" }); res.end(Buffer.alloc(2048, 1));
  });
  let lookups = 0;
  const lookup = async () => { lookups += 1; return [{ address: "127.0.0.1", family: 4 }]; };
  const ok = await fetchImagePinned(`http://only-pinned.example.invalid:${port}/a.png`, { lookup, allowPrivate: true });
  assert.deepEqual([ok.contentType, ok.body.toString()], ["image/png", "PNGDATA"]);
  assert.equal(lookups, 1, "resolved once; the unresolvable name was reached only through the pinned address");
  await assert.rejects(fetchImagePinned(`http://127.0.0.1:${port}/page`, { allowPrivate: true }), (e) => e.code === "not_an_image" && e.status === 415);
  await assert.rejects(fetchImagePinned(`http://127.0.0.1:${port}/move`, { allowPrivate: true }), (e) => e.code === "redirect_refused");
  await assert.rejects(fetchImagePinned(`http://127.0.0.1:${port}/big`, { allowPrivate: true, maxBytes: 1024 }), (e) => e.code === "too_large");
  await assert.rejects(fetchImagePinned("file:///etc/passwd"), (e) => e.code === "unsupported_scheme");
});
