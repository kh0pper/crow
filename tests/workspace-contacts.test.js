import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startFakeNextcloud } from "./helpers/workspace-fake-nextcloud.js";
import { installFakePim } from "./helpers/workspace-fake-pim.js";
import { connectWorkspace } from "./helpers/workspace-client.js";

let fake, pim, call, close;
before(async () => {
  fake = await startFakeNextcloud(); pim = installFakePim(fake);
  pim.addBook("casa_shared_by_admin", "Casa"); pim.addBook("z-server-generated--system", "System"); pim.addBook("lectura", "Lectura", { writable: false });
  pim.addCard("casa_shared_by_admin", "abuela.vcf", "BEGIN:VCARD\r\nVERSION:3.0\r\nUID:ab-1\r\nFN:Abuela Rosa\r\nN:Rosa;Abuela;;;\r\nTEL;TYPE=CELL:+52 55 1234 5678\r\nX-CUSTOM:keep-me\r\nEND:VCARD\r\n");
  ({ call, close } = await connectWorkspace(fake));
});
after(async () => { await close(); fake.close(); });

test("generated system books are hidden", async () => {
  assert.deepEqual((await call("ws_contacts_list_addressbooks", {})).data.addressbooks.map((b) => [b.name, b.writable]), [["Casa", true], ["Lectura", false]]);
});
test("search + get; update keeps unknown vCard properties; update/delete are journaled and undoable", async () => {
  const s = await call("ws_contacts_search", { query: "rosa" });
  assert.equal(s.data.contacts[0].full_name, "Abuela Rosa"); assert.deepEqual(s.data.contacts[0].phones, ["+52 55 1234 5678"]);
  const u = await call("ws_contacts_update", { addressbook: "Casa", uid: "ab-1", emails: ["rosa@example.org"] });
  const text = pim.books.get("casa_shared_by_admin").objects.get("abuela.vcf").text;
  assert.match(text, /X-CUSTOM:keep-me/); assert.match(text, /EMAIL[^:]*:rosa@example\.org/);
  assert.match(text, /\r\nREV:\d{8}T\d{6}Z\r\n/, "T10-I1: REV keeps every digit"); assert.match(text, /TEL;TYPE=CELL:\+52 55 1234 5678/); assert.match(text, /VERSION:3\.0/);
  assert.ok(u.data.version_id.startsWith("j1."));
  const g = await call("ws_contacts_get", { addressbook: "Casa", uid: "ab-1" });
  assert.deepEqual(g.data.emails, ["rosa@example.org"]);
  assert.equal((await call("ws_undo_last_change", { path: u.data.ref, version_id: u.data.version_id })).data.undone, "reverted");
  assert.doesNotMatch(pim.books.get("casa_shared_by_admin").objects.get("abuela.vcf").text, /EMAIL/);
  const d = await call("ws_contacts_delete", { addressbook: "Casa", uid: "ab-1" });
  assert.equal(pim.books.get("casa_shared_by_admin").objects.size, 0);
  await call("ws_undo_last_change", { path: d.data.ref, version_id: d.data.version_id });
  assert.ok(pim.books.get("casa_shared_by_admin").objects.has("abuela.vcf"), "restored at the same href");
  assert.equal((await call("ws_contacts_get", { addressbook: "Casa", uid: "ab-1" })).data.full_name, "Abuela Rosa");
});
test("create writes vCard 3.0 with N derived from the name; accents survive", async () => {
  const c = await call("ws_contacts_create", { addressbook: "Casa", full_name: "José Peña", phones: ["+1 512 555 0100"], birthday: "1990-05-04" });
  assert.equal(c.success, true, JSON.stringify(c));
  const t = [...pim.books.get("casa_shared_by_admin").objects.values()].find((o) => o.text.includes("Peña")).text;
  assert.match(t, /VERSION:3\.0/); assert.match(t, /N:Peña;José;;;/); assert.match(t, /FN:José Peña/); assert.match(t, /TEL[^:]*:\+1 512 555 0100/); assert.ok(c.data.uid);
  const s = await call("ws_contacts_search", { query: "peña", addressbook: "Casa" });
  assert.equal(s.data.contacts[0].full_name, "José Peña"); assert.equal(s.data.contacts[0].birthday, "1990-05-04");
  assert.equal((await call("ws_contacts_create", { addressbook: "Casa", full_name: "x", birthday: "4/5/1990" })).code, "bad_args");
});
test("read-only address book refuses writes", async () => {
  assert.equal((await call("ws_contacts_create", { addressbook: "Lectura", full_name: "x" })).code, "read_only");
});
