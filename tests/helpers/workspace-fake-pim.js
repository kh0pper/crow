/**
 * CalDAV/CardDAV extension of the fake Nextcloud (test-only regex parsing).
 * crow-bot's principal (incl. cal:calendar-user-address-set mailto:crow-bot@crow.test) comes from the built-in
 * principal branch of workspace-fake-nextcloud.js (preflight ruling F5); this extension only adds the
 * calendars/ and addressbooks/ homes.
 */
const xmlEsc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
export function installFakePim(fake) {
  let n = 0;
  const calendars = new Map(); const books = new Map();
  const etag = () => `"p${++n}"`;
  const api = {
    calendars, books, nextEtag: () => etag(),
    /** Test hook: the next REPORT on this collection answers with these raw hrefs (hostile-server tests). */
    injectHrefs: null,
    /** Test hooks: afterPut(collection, file) runs right after a PUT is stored (a person editing in the gap);
     *  omitPutEtag drops the ETag header from PUT answers; failNext = {method, status} fails the next such request. */
    afterPut: null, omitPutEtag: false, failNext: null,
    addCalendar(id, name, { writable = true, owner = "admin" } = {}) { calendars.set(id, { id, name, writable, owner, objects: new Map() }); },
    addEvent(calId, file, ics) { calendars.get(calId).objects.set(file, { text: ics, etag: etag() }); },
    addBook(id, name, { writable = true, owner = "admin" } = {}) { books.set(id, { id, name, writable, owner, objects: new Map() }); },
    addCard(bookId, file, vcf) { books.get(bookId).objects.set(file, { text: vcf, etag: etag() }); },
  };
  const coll = (kind) => (kind === "calendars" ? calendars : books);
  const nsFix = (s) => s.replace("<d:multistatus", '<d:multistatus xmlns:card="urn:ietf:params:xml:ns:carddav"');
  fake.extraRoutes = async (req, res, body, { send, ms }) => {
    const u = decodeURIComponent(req.url.split("?")[0]);
    const m = /^\/remote\.php\/dav\/(calendars|addressbooks\/users)\/crow-bot\/(?:([^/]+)\/(?:([^/]+))?)?$/.exec(u);
    if (!m) return false;
    const kind = m[1].startsWith("cal") ? "calendars" : "books"; const base = `/remote.php/dav/${m[1]}/crow-bot/`;
    const C = coll(kind);
    if (!m[2] && req.method === "PROPFIND") {
      const self = `<d:response><d:href>${base}</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
      const rows = [...C.values()].map((c) => `<d:response><d:href>${base}${encodeURIComponent(c.id)}/</d:href><d:propstat><d:prop><d:displayname>${xmlEsc(c.name)}</d:displayname><d:resourcetype><d:collection/>${kind === "calendars" ? "<cal:calendar/>" : "<card:addressbook/>"}</d:resourcetype>${kind === "calendars" ? `<cal:supported-calendar-component-set><cal:comp name="VEVENT"/></cal:supported-calendar-component-set>` : ""}<oc:owner-principal>principals/users/${c.owner || "admin"}</oc:owner-principal><d:current-user-privilege-set><d:privilege><d:read/></d:privilege>${c.writable === false ? "" : "<d:privilege><d:write/></d:privilege>"}</d:current-user-privilege-set></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`).join("");
      send(207, nsFix(ms(self + rows))); return true;
    }
    const c = C.get(m[2]); if (!c) { send(404); return true; }
    if (!m[3] && req.method === "REPORT") {
      const tag = kind === "calendars" ? "cal:calendar-data" : "card:address-data";
      if (api.injectHrefs) { const hrefs = api.injectHrefs; api.injectHrefs = null; send(207, nsFix(ms(hrefs.map((h) => `<d:response><d:href>${h}</d:href><d:propstat><d:prop><d:getetag>"x"</d:getetag><${tag}>BEGIN:VCALENDAR\r\nEND:VCALENDAR</${tag}></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`).join("")))); return true; }
      const b = body.toString(); const uid = (b.match(/<c:text-match[^>]*>([^<]*)<\/c:text-match>/) || [])[1];
      const q = (b.match(/<card:text-match[^>]*>([^<]*)<\/card:text-match>/) || [])[1];
      const hits = [...c.objects].filter(([, o]) => (!uid || o.text.includes(`UID:${uid}`)) && (!q || o.text.toLowerCase().includes(q.toLowerCase())));
      send(207, nsFix(ms(hits.map(([f, o]) => `<d:response><d:href>${base}${encodeURIComponent(m[2])}/${encodeURIComponent(f)}</d:href><d:propstat><d:prop><d:getetag>${o.etag}</d:getetag><${tag}>${xmlEsc(o.text)}</${tag}></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`).join(""))));
      return true;
    }
    const o = c.objects.get(m[3]);
    if (api.failNext && api.failNext.method === req.method) { const f = api.failNext; api.failNext = null; send(f.status); return true; }
    if (req.method === "GET") { if (!o) send(404); else send(200, o.text, { ETag: o.etag, "Content-Type": "text/calendar" }); return true; }
    if (req.method === "PUT") {
      if (c.writable === false) { send(403); return true; }
      if (req.headers["if-none-match"] === "*" && o) { send(412); return true; }
      if (req.headers["if-match"] && (!o || req.headers["if-match"] !== o.etag)) { send(412); return true; }
      const e = etag(); c.objects.set(m[3], { text: body.toString(), etag: e });
      if (api.afterPut) { const h = api.afterPut; api.afterPut = null; h(c, m[3]); }
      send(o ? 204 : 201, "", api.omitPutEtag ? {} : { ETag: e }); return true;
    }
    if (req.method === "DELETE") { if (!o) { send(404); return true; } if (req.headers["if-match"] && req.headers["if-match"] !== o.etag) { send(412); return true; } c.objects.delete(m[3]); send(204); return true; }
    return false;
  };
  return api;
}
