// tests/tax-documents-crypto.test.js — uploaded tax documents encrypted at rest, and the
// safe, reversible migration of files stored before (recovery keys, queue item 30).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { createDbClient } from "../servers/db.js";
import * as D from "../bundles/tax/server/documents-crypto.js";

const ROOT = mkdtempSync(join(tmpdir(), "crow-taxdocs-"));
after(() => rmSync(ROOT, { recursive: true, force: true }));
const KEY = "k-" + "a".repeat(41);
const OLD = "o-" + "b".repeat(41);
const PDF = Buffer.from("%PDF-1.4\n% fake W-2 with SSN 000-00-0000\n%%EOF\n");
const EXAMPLE = "change-this-to-a-strong-passphrase";

async function fresh(name) {
  const docs = join(ROOT, name, "tax-documents");
  mkdirSync(docs, { recursive: true });
  const db = createDbClient(join(ROOT, name, "t.db"));
  after(() => { try { db.close(); } catch {} });
  await db.execute("CREATE TABLE tax_documents (id INTEGER PRIMARY KEY, filename TEXT, file_path TEXT NOT NULL)");
  return { docs, db };
}
async function addPlain(db, docs, id, bytes = PDF) {
  const p = join(docs, `${id}-w2.pdf`);
  writeFileSync(p, bytes);
  await db.execute({ sql: "INSERT INTO tax_documents (id, filename, file_path) VALUES (?, 'w2.pdf', ?)", args: [id, p] });
  return p;
}
const pathOf = async (db, id) => (await db.execute({ sql: "SELECT file_path FROM tax_documents WHERE id = ?", args: [id] })).rows[0].file_path;
const files = (dir) => readdirSync(dir).filter((f) => !f.startsWith("."));

test("round trip; the key id names the sealing key; a wrong key is refused; the previous key still opens", async () => {
  const enc = await D.encryptDocument(PDF, KEY);
  assert.equal(D.isEncryptedDocument(enc), true);
  assert.equal(enc.includes(Buffer.from("000-00-0000")), false, "no plaintext in the stored bytes");
  assert.ok((await D.decryptDocument(enc, [KEY])).plain.equals(PDF));
  assert.equal(D.sealedWith(enc, [OLD, KEY]), KEY);
  await assert.rejects(D.decryptDocument(enc, ["wrong-" + "c".repeat(40)]), /different tax key/);
  assert.ok((await D.decryptDocument(await D.encryptDocument(PDF, OLD), [KEY, OLD])).plain.equals(PDF));
  await assert.rejects(D.encryptDocument(PDF, ""), /not set/);
});

test("the example key published in the repo is never used to store a document", async () => {
  await assert.rejects(D.encryptDocument(PDF, EXAMPLE), /example value/);
  const { docs, db } = await fresh("ex");
  const p = await addPlain(db, docs, 1);
  const r = await D.encryptStoredDocuments(db, { key: EXAMPLE, docsDirs: [docs] });
  assert.equal(r.encrypted, 0);
  assert.ok(readFileSync(p).equals(PDF), "the plain file is left alone");
});

test("migration: plain → <name>.<rand>.enc (0600), row updated, plain file gone; a re-run changes nothing", async () => {
  const { docs, db } = await fresh("m1");
  const p = await addPlain(db, docs, 1);
  const r = await D.encryptStoredDocuments(db, { key: KEY, docsDirs: [docs] });
  assert.deepEqual([r.encrypted, r.errors], [1, []]);
  const np = await pathOf(db, 1);
  assert.match(basename(np), /^1-w2\.pdf\.[0-9a-f]{8}\.enc$/);
  assert.equal(existsSync(p), false);
  assert.equal(statSync(np).mode & 0o777, 0o600);
  assert.ok((await D.decryptDocument(readFileSync(np), [KEY])).plain.equals(PDF));
  const again = await D.encryptStoredDocuments(db, { key: KEY, docsDirs: [docs] });
  assert.deepEqual([again.encrypted, again.reencrypted, again.skipped], [0, 0, 1]);
  assert.deepEqual(files(docs), [basename(np)], "no temp or lock file is left");
});

test("a crash after the swap but before the unlink leaves a plain sibling: the next run removes it once the .enc is verified", async () => {
  const { docs, db } = await fresh("m2");
  const p = await addPlain(db, docs, 1);
  const enc = `${p}.0123abcd.enc`;
  D.writePrivateAtomic(enc, await D.encryptDocument(PDF, KEY));
  await db.execute({ sql: "UPDATE tax_documents SET file_path = ? WHERE id = 1", args: [enc] });
  const r = await D.encryptStoredDocuments(db, { key: KEY, docsDirs: [docs] });
  assert.equal(r.cleaned, 1);
  assert.equal(existsSync(p), false);
  assert.deepEqual(files(docs), [basename(enc)]);
});

test("a sibling that does NOT match the .enc's contents is never removed", async () => {
  const { docs, db } = await fresh("m2b");
  const p = await addPlain(db, docs, 1, Buffer.from("%PDF-1.4 a different file"));
  const enc = `${p}.0123abcd.enc`;
  D.writePrivateAtomic(enc, await D.encryptDocument(PDF, KEY));
  await db.execute({ sql: "UPDATE tax_documents SET file_path = ? WHERE id = 1", args: [enc] });
  const r = await D.encryptStoredDocuments(db, { key: KEY, docsDirs: [docs] });
  assert.equal(r.cleaned, 0);
  assert.equal(existsSync(p), true);
});

test("a lost compare-and-swap (the row changed meanwhile) keeps the plain file and removes only this run's .enc", async () => {
  const { docs, db } = await fresh("m3");
  const p = await addPlain(db, docs, 1);
  const racing = { execute: async (q) => {
    if (typeof q === "object" && /^UPDATE tax_documents SET file_path/.test(q.sql)) await db.execute({ sql: "UPDATE tax_documents SET file_path = ? WHERE id = 1", args: [p + ".moved"] });
    return db.execute(q);
  } };
  const r = await D.encryptStoredDocuments(racing, { key: KEY, docsDirs: [docs] });
  assert.equal(r.encrypted, 0);
  assert.equal(existsSync(p), true, "nothing unverified was deleted");
  assert.deepEqual(files(docs), [basename(p)]);
});

test("two migrators at once: the second finds the lock and touches nothing; the document is encrypted exactly once", async () => {
  const { docs, db } = await fresh("m3b");
  await addPlain(db, docs, 1);
  const [a, b] = await Promise.all([
    D.encryptStoredDocuments(db, { key: KEY, docsDirs: [docs] }),
    D.encryptStoredDocuments(db, { key: KEY, docsDirs: [docs] }),
  ]);
  assert.equal(a.encrypted + b.encrypted, 1);
  assert.equal(a.locked || b.locked, true);
  const np = await pathOf(db, 1);
  assert.ok((await D.decryptDocument(readFileSync(np), [KEY])).plain.equals(PDF));
  assert.deepEqual(files(docs), [basename(np)]);
});

test("no key: nothing is touched", async () => {
  const { docs, db } = await fresh("m4");
  const p = await addPlain(db, docs, 1);
  const r = await D.encryptStoredDocuments(db, { key: "", docsDirs: [docs] });
  assert.equal(r.encrypted, 0);
  assert.ok(readFileSync(p).equals(PDF));
});

test("a file_path outside the documents folder (or a symlink out of it) is never read, rewritten or deleted", async () => {
  const { docs, db } = await fresh("m5");
  const outside = join(ROOT, "m5", "secret.txt");
  writeFileSync(outside, "not a tax document");
  await db.execute({ sql: "INSERT INTO tax_documents (id, filename, file_path) VALUES (1, 'x', ?)", args: [outside] });
  const link = join(docs, "link.pdf");
  symlinkSync(outside, link);
  await db.execute({ sql: "INSERT INTO tax_documents (id, filename, file_path) VALUES (2, 'y', ?)", args: [link] });
  const r = await D.encryptStoredDocuments(db, { key: KEY, docsDirs: [docs] });
  assert.deepEqual([r.encrypted, r.skipped], [0, 2]);
  assert.equal(readFileSync(outside, "utf8"), "not a tax document");
  assert.equal(D.storedDocumentPath(outside, [docs]), null);
  assert.equal(D.storedDocumentPath(link, [docs]), null);
});

test("re-encrypts a document only the previous key opens (after a key change)", async () => {
  const { docs, db } = await fresh("m6");
  const p = join(docs, "1-w2.pdf.0123abcd.enc");
  D.writePrivateAtomic(p, await D.encryptDocument(PDF, OLD));
  await db.execute({ sql: "INSERT INTO tax_documents (id, filename, file_path) VALUES (1, 'w2.pdf', ?)", args: [p] });
  const r = await D.encryptStoredDocuments(db, { key: KEY, previous: OLD, docsDirs: [docs] });
  assert.equal(r.reencrypted, 1);
  assert.equal(D.sealedWith(readFileSync(p), [OLD, KEY]), KEY);
});

test("a crow.db restored under another home: a row pointing at the old home resolves to the same name in this folder", async () => {
  const { docs, db } = await fresh("m8");
  const enc = join(docs, "1-w2.pdf.0123abcd.enc");
  D.writePrivateAtomic(enc, await D.encryptDocument(PDF, KEY));
  await db.execute({ sql: "INSERT INTO tax_documents (id, filename, file_path) VALUES (1, 'w2.pdf', ?)", args: ["/home/someone-else/.crow/tax-documents/1-w2.pdf.0123abcd.enc"] });
  const out = join(ROOT, "m8-export");
  const ex = await D.decryptStoredDocuments(db, { keys: [KEY], outDir: out, docsDirs: [docs] });
  assert.equal(ex.decrypted, 1);
  assert.ok(readFileSync(join(out, files(out)[0])).equals(PDF));
});

test("reverse in place restores the identical bytes and the row; export copies leave the database alone", async () => {
  const { docs, db } = await fresh("m7");
  const p = await addPlain(db, docs, 1);
  await D.encryptStoredDocuments(db, { key: KEY, docsDirs: [docs] });
  const enc = await pathOf(db, 1);
  const out = join(ROOT, "m7-export");
  const ex = await D.decryptStoredDocuments(db, { keys: [KEY], outDir: out, docsDirs: [docs] });
  assert.equal(ex.decrypted, 1);
  assert.ok(readFileSync(join(out, files(out)[0])).equals(PDF));
  assert.equal(statSync(join(out, files(out)[0])).mode & 0o777, 0o600);
  assert.equal(await pathOf(db, 1), enc, "export does not move the row");
  const back = await D.decryptStoredDocuments(db, { keys: [KEY], inPlace: true, docsDirs: [docs] });
  assert.equal(back.decrypted, 1);
  assert.equal(await pathOf(db, 1), p);
  assert.ok(readFileSync(p).equals(PDF));
  assert.equal(existsSync(enc), false);
});
