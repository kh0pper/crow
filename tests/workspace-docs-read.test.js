import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startFakeNextcloud } from "./helpers/workspace-fake-nextcloud.js";
import { connectWorkspace } from "./helpers/workspace-client.js";

const FIX = join(import.meta.dirname, "fixtures", "workspace");
let fake, call, close;
before(async () => {
  fake = await startFakeNextcloud();
  fake.addFile("S/rich.docx", readFileSync(join(FIX, "rich.docx")), { owner: "admin" });
  fake.addFile("S/oo-rich.docx", readFileSync(join(FIX, "oo-rich.docx")), { owner: "admin" });
  ({ call, close } = await connectWorkspace(fake));
});
after(async () => { await close(); fake.close(); });

for (const f of ["rich.docx", "oo-rich.docx"]) {
  test(`${f}: ws_docs_read renders headings, lists, emphasis and the table`, async () => {
    const r = await call("ws_docs_read", { path: `S/${f}` });
    const md = r.data.markdown;
    assert.match(md, /^# Recetas de la semana$/m);
    assert.match(md, /^## Ingredientes$/m);
    assert.match(md, /^- Tortillas$/m);
    assert.match(md, /^1\. Marinar la carne$/m);
    assert.match(md, /\*\*Tacos al \*\*\*pastor\*/);
    assert.match(md, /^\| Día \| Plato \|$/m);
    assert.equal(r.data.title, f.replace(/\.docx$/, ""));
  });
  test(`${f}: structure and section boundaries (same-or-higher level ends a section)`, async () => {
    const s = await call("ws_docs_get_structure", { path: `S/${f}` });
    assert.deepEqual(s.data.headings.map((h) => [h.level, h.text]), [[1, "Recetas de la semana"], [2, "Ingredientes"], [2, "Pasos"], [1, "Notas"]]);
    const sec = await call("ws_docs_read_section", { path: `S/${f}`, heading: "  recetas DE la semana " });
    assert.match(sec.data.markdown, /Ingredientes/);
    assert.doesNotMatch(sec.data.markdown, /Última línea/);
    const miss = await call("ws_docs_read_section", { path: `S/${f}`, heading: "Postres" });
    assert.equal(miss.code, "heading_not_found");
    assert.match(miss.error, /Available: .*Ingredientes/);
  });
}

test("a non-docx path is refused with wrong_type", async () => {
  fake.addFile("S/x.txt", Buffer.from("hi"));
  assert.equal((await call("ws_docs_read", { path: "S/x.txt" })).code, "wrong_type");
});
