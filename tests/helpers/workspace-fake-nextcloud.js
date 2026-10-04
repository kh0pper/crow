/**
 * Hermetic fake of the Nextcloud 34 + ONLYOFFICE 9.4 surface the W2 toolset uses (spec §10.1).
 * Behaviour mirrors what was verified live on crow 2026-10-03:
 *  - PUT on a file with a files_lock app/user lock → 423 (unless the lock owner is crow-bot);
 *  - versions listed incl. the current file, ids = mtime seconds; PROPPATCH labels; MOVE restore;
 *  - empty 207 for paths the bot cannot see; ONLYOFFICE info returns {error, users}.
 * Test-only: regex parsing of request bodies is fine here (product code uses xmldom).
 */
import http from "node:http";
import { createHmac } from "node:crypto";

const xmlEsc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]));
const encPath = (p) => p.split("/").map(encodeURIComponent).join("/");

export async function startFakeNextcloud({ secret = "jwt", instance = "ocinst" } = {}) {
  let nextId = 100, clockS = 1_791_000_000, etagN = 0;
  const nodes = new Map(); // path ('' = root) → node
  const state = {
    emptyMultistatusFor: new Set(), sessions: new Map() /* key → {users:[uid], onDrop: {releaseAfterMs, saveBytes}} */,
    shares: [], trash: [], keys: new Map() /* fileId → key */, now: 0, pendingReleases: [],
  };
  const calls = [];
  let lastSearch = "";
  // Real Nextcloud: mtime = wall-clock seconds; a write in the same second as the current version REPLACES that
  // version row (files_versions FileEventsListener.php:326-333). Tests opt in via state.realisticMtime = () => seconds.
  const touch = (n) => { n.etag = `"e${++etagN}"`; n.mtime = state.realisticMtime ? state.realisticMtime() : ++clockS; };
  const mkNode = (path, type, opts = {}) => { const n = { path, type, fileId: ++nextId, mime: opts.mime || null, owner: opts.owner || "crow-bot", perms: opts.perms || (type === "dir" ? "SRGDNVCK" : "SRGDNVW"), lock: opts.lock || null, bytes: Buffer.alloc(0), versions: [], label: null }; touch(n); nodes.set(path, n); return n; };
  mkNode("", "dir");
  const ensureParents = (path) => { const segs = path.split("/"); for (let i = 1; i < segs.length; i++) { const p = segs.slice(0, i).join("/"); if (!nodes.has(p)) mkNode(p, "dir", { owner: "admin" }); } };
  const api = {
    state, calls,
    addFolder(path, opts) { ensureParents(path); return nodes.get(path) || mkNode(path, "dir", opts); },
    addFile(path, bytes, opts = {}) { ensureParents(path); const n = mkNode(path, "file", opts); n.bytes = Buffer.from(bytes); n.versions.push({ id: n.mtime, bytes: n.bytes, label: null, author: n.owner }); return n; },
    node: (path) => nodes.get(path),
    nodeById: (id) => [...nodes.values()].find((n) => n.fileId === id),
    setLock(path, lock) { nodes.get(path).lock = lock; },
    openInEditor(path, users, { releaseAfterMs = 4000, typed = null } = {}) {
      const n = nodes.get(path); n.lock = { type: 1, owner: null, displayName: null, time: clockS }; // spike: while ONLYOFFICE holds a file nc:lock-owner is NULL
      const key = `k${n.fileId}`; state.keys.set(n.fileId, key);
      state.sessions.set(key, { path, users: users.map((u) => `${instance}_${u}`), releaseAfterMs, typed });
      return key;
    },
    advance(ms) { state.now += ms; for (const r of [...state.pendingReleases]) if (state.now >= r.at) { state.pendingReleases.splice(state.pendingReleases.indexOf(r), 1); r.fn(); } },
    lastSearchBody: () => lastSearch,
    versionsOf: (path) => nodes.get(path).versions,
  };

  const propsXml = (n) => {
    const isDir = n.type === "dir";
    const lock = n.lock;
    return `<d:propstat><d:prop>
<d:getetag>${xmlEsc(n.etag)}</d:getetag><d:getlastmodified>${new Date(n.mtime * 1000).toUTCString()}</d:getlastmodified>
${isDir ? "<d:resourcetype><d:collection/></d:resourcetype>" : `<d:resourcetype/><d:getcontentlength>${n.bytes.length}</d:getcontentlength><d:getcontenttype>${n.mime || "application/octet-stream"}</d:getcontenttype>`}
<oc:fileid>${n.fileId}</oc:fileid><oc:permissions>${n.perms}</oc:permissions><oc:owner-id>${n.owner}</oc:owner-id><oc:owner-display-name>${n.owner === "admin" ? "Kevin" : n.owner}</oc:owner-display-name>
<nc:lock>${lock ? 1 : ""}</nc:lock>${lock ? `<nc:lock-owner-type>${lock.type}</nc:lock-owner-type>${lock.owner == null ? "" : `<nc:lock-owner>${xmlEsc(lock.owner)}</nc:lock-owner>`}${(lock.displayName ?? lock.owner) == null ? "" : `<nc:lock-owner-displayname>${xmlEsc(lock.displayName ?? lock.owner)}</nc:lock-owner-displayname>`}<nc:lock-time>${lock.time || clockS}</nc:lock-time>` : ""}
</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>`;
  };
  const ms = (inner) => `<?xml version="1.0"?>\n<d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns" xmlns:nc="http://nextcloud.org/ns" xmlns:cal="urn:ietf:params:xml:ns:caldav">${inner}</d:multistatus>`;
  const respFor = (n) => `<d:response><d:href>/remote.php/dav/files/crow-bot/${encPath(n.path)}${n.type === "dir" && n.path ? "/" : ""}</d:href>${propsXml(n)}</d:response>`;
  const childrenOf = (p) => [...nodes.values()].filter((n) => n.path !== p && n.path.startsWith(p ? `${p}/` : "") && !n.path.slice(p ? p.length + 1 : 0).includes("/") && n.path !== "");
  const readBody = (req) => new Promise((r) => { const b = []; req.on("data", (c) => b.push(c)); req.on("end", () => r(Buffer.concat(b))); });
  const pathFromUrl = (u, prefix) => decodeURIComponent(u.slice(prefix.length)).replace(/\/$/, "");
  const lockBlocks = (n) => n.lock && !(n.lock.type === 0 && n.lock.owner === "crow-bot");
  const writeContent = (n, bytes, author = "crow-bot", mtime = null) => {
    n.bytes = Buffer.from(bytes); touch(n); if (mtime !== null) n.mtime = mtime;
    const last = n.versions.at(-1);
    if (last && last.id === n.mtime) Object.assign(last, { bytes: n.bytes, author }); // same-second overwrite, like NC
    else n.versions.push({ id: n.mtime, bytes: n.bytes, label: null, author });
  };

  const nc = http.createServer(async (req, res) => {
    const auth = Buffer.from((req.headers.authorization || "").replace(/^Basic /, ""), "base64").toString();
    const [user, pass] = auth.split(":");
    const body = await readBody(req);
    calls.push({ method: req.method, url: req.url, user, headers: req.headers });
    if (user !== "crow-bot" || !pass) { res.writeHead(401); return res.end(); }
    if (state.failNextWith) { const f = state.failNextWith; state.failNextWith = null; res.writeHead(f.status); return res.end(f.body); }
    const send = (code, text = "", headers = {}) => { res.writeHead(code, { "Content-Type": "application/xml; charset=utf-8", ...headers }); res.end(text); };
    const u = req.url;
    // extension routes run BEFORE the built-in branches so later tasks (calendar/contacts) can override any of them
    if (api.extraRoutes) { const handled = await api.extraRoutes(req, res, body, { send, ms, calls }); if (handled) return; }
    // ---- files ----
    if (u.startsWith("/remote.php/dav/files/crow-bot/") || u === "/remote.php/dav/files/crow-bot") {
      const p = pathFromUrl(u.split("?")[0], "/remote.php/dav/files/crow-bot/");
      if (state.emptyMultistatusFor.has(p)) return send(207, ms(""));
      const n = nodes.get(p);
      if (req.method === "PROPFIND") {
        if (!n) return send(404);
        const depth = req.headers.depth === "1" ? 1 : 0;
        return send(207, ms(respFor(n) + (depth && n.type === "dir" ? childrenOf(p).map(respFor).join("") : "")));
      }
      if (req.method === "GET") { if (!n || n.type === "dir") return send(404); return send(200, n.bytes, { "Content-Type": "application/octet-stream", ETag: n.etag, "Last-Modified": new Date(n.mtime * 1000).toUTCString(), "Content-Length": String(n.bytes.length) }); }
      if (req.method === "PUT") {
        if (n && lockBlocks(n)) return send(423, "<d:error xmlns:d=\"DAV:\"/>");
        if (req.headers["if-none-match"] === "*" && n) return send(412);
        if (req.headers["if-match"] && (!n || req.headers["if-match"] !== n.etag)) return send(412);
        if (!nodes.get(p.split("/").slice(0, -1).join("/"))) return send(409);
        if (!n) { const m = mkNode(p, "file"); m.bytes = body; m.versions.push({ id: m.mtime, bytes: body, label: null, author: "crow-bot" }); return send(201, "", { ETag: m.etag }); }
        writeContent(n, body); const putTag = n.etag; state.afterPutHook?.(n); return send(204, "", { ETag: putTag, "OC-ETag": putTag });
      }
      if (req.method === "MKCOL") { if (n) return send(405); mkNode(p, "dir"); return send(201); }
      const lockedInside = (p0) => [...nodes.values()].some((x) => (x.path === p0 || x.path.startsWith(`${p0}/`)) && lockBlocks(x));
      if (req.method === "DELETE") { if (!n) return send(404); if (lockedInside(p)) return send(423); for (const k of [...nodes.keys()]) if (k === p || k.startsWith(`${p}/`)) { state.trash.push(nodes.get(k)); nodes.delete(k); } return send(204); }
      if (req.method === "MOVE" || req.method === "COPY") {
        if (!n) return send(404);
        const dest = pathFromUrl(new URL(req.headers.destination).pathname, "/remote.php/dav/files/crow-bot/");
        if (nodes.has(dest) && req.headers.overwrite === "F") return send(412);
        if (req.method === "MOVE" && [...nodes.values()].some((x) => (x.path === p || x.path.startsWith(`${p}/`)) && lockBlocks(x))) return send(423);
        for (const k of [...nodes.keys()].filter((k) => k === p || k.startsWith(`${p}/`))) {
          const src = nodes.get(k); const nk = dest + k.slice(p.length);
          if (req.method === "MOVE") { nodes.delete(k); src.path = nk; nodes.set(nk, src); }
          else { const c = mkNode(nk, src.type, { owner: "crow-bot" }); c.bytes = src.bytes; c.versions.push({ id: c.mtime, bytes: c.bytes, label: null, author: "crow-bot" }); }
        }
        return send(201);
      }
    }
    // ---- search ----
    if (req.method === "SEARCH" && u === "/remote.php/dav/") {
      lastSearch = body.toString();
      const lit = (lastSearch.match(/<d:literal>([\s\S]*?)<\/d:literal>/) || [])[1] ?? "";
      const unesc = lit.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
      let hits = [...nodes.values()].filter((n) => n.path !== "");
      if (/<d:eq><d:prop><oc:fileid\/>/.test(lastSearch)) hits = hits.filter((n) => String(n.fileId) === unesc);
      else if (/<d:like>/.test(lastSearch)) { const needle = unesc.replace(/^%|%$/g, "").replace(/\\([%_\\])/g, "$1").toLowerCase(); hits = hits.filter((n) => n.path.split("/").pop().toLowerCase().includes(needle)); }
      else hits = hits.filter((n) => n.path.split("/").pop() === unesc);
      if (/<d:is-collection\/>/.test(lastSearch)) hits = hits.filter((n) => n.type === "dir");
      return send(207, ms(hits.map(respFor).join("")));
    }
    // ---- versions ----
    const vm = u.match(/^\/remote\.php\/dav\/versions\/crow-bot\/versions\/(\d+)(?:\/(\d+))?\/?$/);
    if (vm) {
      const n = api.nodeById(Number(vm[1])); if (!n) return send(404);
      if (req.method === "PROPFIND") return send(207, ms(`<d:response><d:href>/remote.php/dav/versions/crow-bot/versions/${n.fileId}/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>` +
        n.versions.map((v) => `<d:response><d:href>/remote.php/dav/versions/crow-bot/versions/${n.fileId}/${v.id}</d:href><d:propstat><d:prop><d:getlastmodified>${new Date(v.id * 1000).toUTCString()}</d:getlastmodified><d:getcontentlength>${v.bytes.length}</d:getcontentlength><nc:version-label>${xmlEsc(v.label || "")}</nc:version-label><nc:version-author>${v.author}</nc:version-author></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`).join("")));
      const v = n.versions.find((x) => String(x.id) === vm[2]); if (!v) return send(404);
      if (req.method === "PROPPATCH") { v.label = (body.toString().match(/<nc:version-label>([\s\S]*?)<\/nc:version-label>/) || [])[1] || null; return send(207, ms("")); }
      // Real NC restore touches the file back to the revision's mtime (files_versions Storage.php:408).
      // The pre-restore content stays as version <current mtime> (Storage.php:383-386); the restored revision's row
      // becomes current again (mtime touched back to it). Rows stay ordered by id. NOTE: after a restore, current = the restored row X (old id), and the
      // max id M is the content that was just undone; "newest id = current" is FALSE (re-review B1). Consumers compare with the file mtime.
      if (req.method === "MOVE") { if (lockBlocks(n)) return send(423); n.bytes = Buffer.from(v.bytes); n.etag = `"e${++etagN}"`; n.mtime = v.id; n.versions.sort((a, b) => a.id - b.id); return send(201); }
    }
    // ---- principals ----
    const pm = u.match(/^\/remote\.php\/dav\/principals\/users\/([^/]+)\/$/);
    if (pm && req.method === "PROPFIND") { const names = { admin: "Kevin", dayane: "Dayane", "crow-bot": "Crow bot" }; return names[pm[1]] ? send(207, ms(`<d:response><d:href>${u}</d:href><d:propstat><d:prop><d:displayname>${names[pm[1]]}</d:displayname><cal:calendar-user-address-set><d:href>mailto:${pm[1]}@crow.test</d:href></cal:calendar-user-address-set></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`)) : send(404); }
    // ---- OCS ----
    const cfgm = u.match(/^\/ocs\/v2\.php\/apps\/onlyoffice\/api\/v1\/config\/(\d+)/);
    if (cfgm) { const id = Number(cfgm[1]); if (!state.keys.has(id)) state.keys.set(id, `k${id}`); res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ document: { key: state.keys.get(id) }, editorConfig: { user: { id: `${instance}_crow-bot` } } })); }
    if (u.startsWith("/ocs/v2.php/apps/files_sharing/api/v1/shares")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      if (req.method === "POST") { const f = new URLSearchParams(body.toString()); const s = { id: String(state.shares.length + 1), path: f.get("path"), share_with: f.get("shareWith"), share_type: Number(f.get("shareType")), permissions: Number(f.get("permissions")) }; state.shares.push(s); return res.end(JSON.stringify({ ocs: { meta: { status: "ok", statuscode: 200 }, data: s } })); }
      return res.end(JSON.stringify({ ocs: { meta: { status: "ok", statuscode: 200 }, data: state.shares } }));
    }
    const dl = u.match(/^\/apps\/onlyoffice\/downloadas\?fileId=(\d+)&toExtension=([a-z]+)/);
    if (dl) { res.writeHead(200, { "Content-Type": "application/octet-stream" }); return res.end(Buffer.from(`%FAKE-${dl[2].toUpperCase()}-${dl[1]}`)); }
    send(404);
  });

  // ---- ONLYOFFICE command service ----
  const verify = (token) => { const [h, p, s] = String(token).split("."); return s === createHmac("sha256", secret).update(`${h}.${p}`).digest("base64url") ? JSON.parse(Buffer.from(p, "base64url").toString()) : null; };
  const oo = http.createServer(async (req, res) => {
    const body = JSON.parse((await readBody(req)).toString() || "{}");
    const payload = verify((req.headers.authorization || "").replace(/^Bearer /, ""));
    calls.push({ method: "OO", url: req.url, user: "oo", body: payload });
    res.writeHead(200, { "Content-Type": "application/json" });
    if (!payload || payload.c !== body.c) return res.end(JSON.stringify({ error: 6 }));
    const sess = state.sessions.get(payload.key);
    if (payload.c === "info") return res.end(JSON.stringify(sess ? { key: payload.key, error: 0, users: sess.users } : { key: payload.key, error: 1 }));
    if (payload.c === "drop") {
      if (!sess) return res.end(JSON.stringify({ error: 1 }));
      state.pendingReleases.push({ at: state.now + sess.releaseAfterMs, fn: () => { const n = nodes.get(sess.path); if (sess.typed) writeContent(n, sess.typed, "admin"); n.lock = null; state.sessions.delete(payload.key); } });
      return res.end(JSON.stringify({ key: payload.key, error: 0 }));
    }
    res.end(JSON.stringify({ error: 0 }));
  });
  await new Promise((r) => nc.listen(0, "127.0.0.1", r));
  await new Promise((r) => oo.listen(0, "127.0.0.1", r));
  api.ncUrl = `http://127.0.0.1:${nc.address().port}`;
  api.ooUrl = `http://127.0.0.1:${oo.address().port}`;
  api.close = () => { nc.close(); oo.close(); };
  return api;
}
