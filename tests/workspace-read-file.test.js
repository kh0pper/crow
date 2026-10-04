import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startFakeNextcloud } from "./helpers/workspace-fake-nextcloud.js";
import { connectWorkspace } from "./helpers/workspace-client.js";
import { extractText } from "../bundles/workspace/server/ooxml/text-extract.js";

const FIX = join(import.meta.dirname, "fixtures", "workspace");
let fake, call, close, client;
before(async () => {
  fake = await startFakeNextcloud();
  for (const e of ["docx", "xlsx", "pptx"]) fake.addFile(`S/r.${e}`, readFileSync(join(FIX, `oo-rich.${e}`)), { owner: "admin" });
  fake.addFile("S/n.md", Buffer.from("# Hola\n" + "x".repeat(500)));
  fake.addFile("S/b.bin", Buffer.from([0, 1, 2, 255]));
  fake.addFile("S/receta.source", Buffer.from("Tacos de piña"), { mime: "text/x-source" });
  fake.addFile("S/bad.txt", Buffer.from([0x48, 0x6f, 0xc3, 0x28]));
  fake.addFolder("S/dir");
  ({ call, close, client } = await connectWorkspace(fake));
});
after(async () => { await close(); fake.close(); });

test("office files come back as text", async () => {
  assert.match((await call("ws_drive_read_file", { path: "S/r.docx" })).data.text, /^# Recetas de la semana/m);
  const x = (await call("ws_drive_read_file", { path: "S/r.xlsx" })).data.text;
  assert.match(x, /^## Recetas$/m); assert.match(x, /Tacos,4,12\.50/);
  assert.match((await call("ws_drive_read_file", { path: "S/r.pptx" })).data.text, /## Slide 2: Jueves[\s\S]*Notes: Recordar comprar piña/);
});
test("text files are returned as UTF-8 and truncated at max_chars", async () => {
  const r = await call("ws_drive_read_file", { path: "S/n.md", max_chars: 10 });
  assert.equal(r.data.text, "# Hola\nxxx"); assert.equal(r.data.truncated, true);
});
test("binary files are refused with metadata", async () => {
  const r = await call("ws_drive_read_file", { path: "S/b.bin" });
  assert.equal(r.code, "not_text"); assert.equal(r.data.size, 4);
});
test("a text/* MIME type is read whatever the extension (spec §4.2); invalid UTF-8 is refused; folders are refused", async () => {
  const r = await call("ws_drive_read_file", { path: "S/receta.source" });
  assert.equal(r.data.text, "Tacos de piña"); assert.equal(r.data.truncated, false);
  assert.equal((await call("ws_drive_read_file", { path: "S/bad.txt" })).code, "not_text");
  assert.equal((await call("ws_drive_read_file", { path: "S/dir" })).code, "not_a_file");
});
test("max_chars is capped at 1,000,000", async () => {
  const r = await client.callTool({ name: "ws_drive_read_file", arguments: { path: "S/n.md", max_chars: 1_000_001 } });
  assert.equal(r.isError, true); // schema-level refusal (plain-text SDK error)
  assert.equal((await call("ws_drive_read_file", { path: "S/n.md", max_chars: 1_000_000 })).data.truncated, false);
});
test("extractText: null for non-text types; a U+FFFD that really is in the file is kept", () => {
  assert.equal(extractText("a.bin", Buffer.from([1, 2, 3]), "application/octet-stream"), null);
  assert.equal(extractText("a.txt", Buffer.from("ok � ok"), "application/octet-stream"), "ok � ok");
  assert.equal(extractText("a.dat", Buffer.from("plain"), "text/plain; charset=utf-8"), "plain");
});
