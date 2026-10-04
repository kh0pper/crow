import { z } from "zod";
import { WsError } from "../result.js";
import { defineTools } from "./define.js";
import * as C from "../pim/caldav.js";
import * as K from "../pim/carddav.js";

const ref = (b, uid) => `contacts:${b.id}/${uid}`;
const fields = { full_name: z.string().min(1).max(500).optional(), emails: z.array(z.string().max(320)).max(20).optional(), phones: z.array(z.string().max(60)).max(20).optional(), address: z.string().max(1000).optional(), birthday: z.string().max(10).optional(), note: z.string().max(5000).optional(), org: z.string().max(500).optional() };
const needW = (b) => { if (!b.writable) throw new WsError("read_only", `Crow bot can read "${b.name}" but not change it. Ask the owner to share it with edit rights.`); };
export const contactsDefs = [
  { name: "ws_contacts_list_addressbooks", description: "Address books shared with Crow bot.", schema: {},
    run: async (_a, c) => ({ addressbooks: (await K.listBooks(c.getConfig())).map(({ id, name, owner, writable }) => ({ id, name, owner, writable })) }) },
  { name: "ws_contacts_search", description: "Find contacts by name, email, phone or nickname.", schema: { query: z.string().min(1).max(200), addressbook: z.string().max(200).optional(), max_results: z.number().int().min(1).max(100).optional().default(20) },
    run: async (a, c) => { const cfg = c.getConfig(); const b = a.addressbook ? await K.resolveBook(cfg, a.addressbook) : null; return { contacts: await K.searchContacts(cfg, b, a.query, a.max_results) }; } },
  { name: "ws_contacts_get", description: "One contact by uid (parsed + raw vCard).", schema: { addressbook: z.string().min(1).max(200), uid: z.string().min(1).max(500) },
    run: async (a, c) => { const cfg = c.getConfig(); const b = await K.resolveBook(cfg, a.addressbook); const o = await C.findByUid(cfg, b, a.uid, "card"); return { ...K.parseCard(o.text), ref: ref(b, a.uid), vcard: o.text }; } },
  { name: "ws_contacts_create", description: "Create a contact (vCard 3.0, N derived from the full name). Undoable.", schema: { addressbook: z.string().min(1).max(200), ...fields, full_name: z.string().min(1).max(500) },
    run: async (a, c) => {
      const cfg = c.getConfig(); const b = await K.resolveBook(cfg, a.addressbook); needW(b);
      const { uid, vcf } = K.buildCard(a); const href = C.newObjectHref(cfg, b, uid, "vcf");
      const version_id = await C.journaledWrite(cfg, { kind: "card", ref: ref(b, uid), href, op: "create", before_text: null }, () => C.putChecked(cfg, href, vcf, { ifNoneMatch: "*" }, "add the contact"));
      return { uid, ref: ref(b, uid), version_id };
    } },
  { name: "ws_contacts_update", description: "Change contact fields; other vCard properties are kept. Undoable.", schema: { addressbook: z.string().min(1).max(200), uid: z.string().min(1).max(500), ...fields },
    run: async (a, c) => {
      const cfg = c.getConfig(); const b = await K.resolveBook(cfg, a.addressbook); needW(b);
      const o = await C.findByUid(cfg, b, a.uid, "card"); const next = K.updateCard(o.text, a);
      const version_id = await C.journaledWrite(cfg, { kind: "card", ref: ref(b, a.uid), href: o.href, op: "update", before_text: o.text }, () => C.putChecked(cfg, o.href, next, { ifMatch: o.etag }, "change the contact"));
      return { uid: a.uid, ref: ref(b, a.uid), version_id };
    } },
  { name: "ws_contacts_delete", description: "Delete a contact (undoable here; address books have no trash). Destructive: confirm intent with the user first.", schema: { addressbook: z.string().min(1).max(200), uid: z.string().min(1).max(500) },
    run: async (a, c) => {
      const cfg = c.getConfig(); const b = await K.resolveBook(cfg, a.addressbook); needW(b); const o = await C.findByUid(cfg, b, a.uid, "card");
      // review I12: journal FIRST (no CardDAV trash) — journaledWrite records before it deletes
      const version_id = await C.journaledWrite(cfg, { kind: "card", ref: ref(b, a.uid), href: o.href, op: "delete", before_text: o.text }, () => C.deleteObject(cfg, o.href, o.etag));
      return { deleted: true, ref: ref(b, a.uid), version_id };
    } },
];
export const registerContacts = (server, ctx) => defineTools(server, ctx, contactsDefs);
