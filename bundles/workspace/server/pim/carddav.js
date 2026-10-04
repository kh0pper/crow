/** CardDAV client + vCard helpers (spec §4.7). New cards are vCard 3.0; unknown properties are preserved on update. */
import ICAL from "ical.js";
import { randomUUID } from "node:crypto";
import { WsError } from "../result.js";
import { NS } from "../ooxml/xml.js";
import { ncFetch, httpFail } from "../nc/http.js";
import { parseMultistatus, propText } from "../nc/multistatus.js";
import { normEtag } from "../nc/dav.js";
import { pimHrefToSegs, pimCollectionUrl } from "../nc/paths.js";
import { listCollections, resolveCollection } from "./caldav.js";
import { cardQuery } from "./dav-xml.js";

export const listBooks = (cfg) => listCollections(cfg, "card");
export const resolveBook = (cfg, n) => resolveCollection(cfg, "card", n);
export async function searchContacts(cfg, book, query, max) {
  const books = book ? [book] : await listBooks(cfg); const out = [];
  for (const b of books) {
    const r = await ncFetch(cfg, "REPORT", pimCollectionUrl(cfg, "card", b.href), { headers: { Depth: "1", "Content-Type": "application/xml; charset=utf-8" }, body: cardQuery(String(query).normalize("NFC")) });
    if (r.status !== 207) throw httpFail(r, "search contacts");
    for (const x of parseMultistatus(await r.text())) {
      const segs = pimHrefToSegs(cfg, "card", x.href);
      if (segs.length !== 2 || segs[0] !== b.id) continue;
      const text = propText(x.props, NS.card, "address-data");
      if (!text) continue;
      let card; try { card = parseCard(text); } catch { continue; } // one unreadable card never hides the rest
      out.push({ ...card, addressbook: b.name, addressbook_id: b.id, ref: `contacts:${b.id}/${card.uid}`, etag: normEtag(propText(x.props, NS.d, "getetag")) });
      if (out.length >= max) return out;
    }
  }
  return out;
}
function vcardOf(text) {
  let c;
  try { c = new ICAL.Component(ICAL.parse(text)); } catch { throw new WsError("malformed_contact", "The contact's vCard data could not be read."); }
  const v = c.name === "vcard" ? c : c.getFirstSubcomponent("vcard");
  if (!v) throw new WsError("malformed_contact", "The contact's vCard data could not be read.");
  return v;
}
const nfc = (x) => String(x ?? "").normalize("NFC");
function dateOut(v) {
  if (v === null || v === undefined || v === "") return "";
  const s = String(v); const m = /^(\d{4})-?(\d{2})-?(\d{2})/.exec(s);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : s;
}
export function parseCard(text) {
  const v = vcardOf(text); const all = (n) => v.getAllProperties(n).map((p) => nfc(p.getFirstValue()));
  const adr = v.getFirstPropertyValue("adr"); const org = v.getFirstPropertyValue("org");
  return {
    uid: String(v.getFirstPropertyValue("uid") || ""), full_name: nfc(v.getFirstPropertyValue("fn")), emails: all("email"), phones: all("tel"),
    address: nfc(Array.isArray(adr) ? adr.flat().filter(Boolean).join(", ") : adr || ""), birthday: dateOut(v.getFirstPropertyValue("bday")),
    note: nfc(v.getFirstPropertyValue("note")), org: nfc(Array.isArray(org) ? org.flat().filter(Boolean).join(", ") : org || ""),
  };
}
function setMulti(v, name, values) { if (values === undefined) return; v.removeAllProperties(name); for (const x of values) if (String(x).trim()) v.addPropertyWithValue(name, nfc(x).trim()); }
function setOne(v, name, value) { if (value === undefined) return; v.removeAllProperties(name); if (value) v.addPropertyWithValue(name, nfc(value)); }
function nameParts(full) { const parts = nfc(full).trim().split(/\s+/); const family = parts.length > 1 ? parts.pop() : ""; return [family, parts.join(" "), "", "", ""]; }
function applyFields(v, f) {
  if (f.emails) for (const e of f.emails) if (String(e).trim() && !/^[^\s@]+@[^\s@]+$/.test(String(e).trim())) throw new WsError("bad_args", `"${e}" is not an email address`);
  if (f.birthday !== undefined && f.birthday && !/^\d{4}-\d{2}-\d{2}$/.test(f.birthday)) throw new WsError("bad_args", "birthday must be YYYY-MM-DD");
  if (f.full_name !== undefined) { setOne(v, "fn", f.full_name); v.removeAllProperties("n"); v.addPropertyWithValue("n", nameParts(f.full_name)); }
  setMulti(v, "email", f.emails); setMulti(v, "tel", f.phones);
  if (f.address !== undefined) { v.removeAllProperties("adr"); if (f.address) v.addPropertyWithValue("adr", ["", "", nfc(f.address), "", "", "", ""]); }
  setOne(v, "bday", f.birthday); setOne(v, "note", f.note); setOne(v, "org", f.org);
}
const crlf = (s) => (s.endsWith("\r\n") ? s : `${s}\r\n`);
export function buildCard(f) {
  // parsing a 3.0 skeleton gives ical.js's vCard 3 design set (a bare new Component("vcard") would serialize as 4.0)
  const v = vcardOf("BEGIN:VCARD\r\nVERSION:3.0\r\nEND:VCARD\r\n"); const uid = randomUUID();
  v.addPropertyWithValue("uid", uid); v.addPropertyWithValue("prodid", "-//Crow//Workspace W2//EN");
  applyFields(v, f); return { uid, vcf: crlf(v.toString()) };
}
export function updateCard(text, f) {
  const v = vcardOf(text); applyFields(v, f);
  v.updatePropertyWithValue("rev", ICAL.Time.fromJSDate(new Date(), true)); // review T10-I1: hand ical.js the Time, never a pre-formatted string
  return crlf(v.toString());
}
