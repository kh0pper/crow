import assert from "node:assert/strict";
import { unzipSync, strFromU8 } from "fflate";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Every zip entry outside `allowed` (names or RegExps) is byte-identical after the edit. */
export function assertOnlyPartsChanged(before, after, allowed) {
  const a = unzipSync(new Uint8Array(before)), b = unzipSync(new Uint8Array(after));
  const changed = [];
  for (const n of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (!a[n] || !b[n] || Buffer.compare(Buffer.from(a[n]), Buffer.from(b[n])) !== 0) changed.push(n);
  }
  for (const n of changed) assert.ok(allowed.some((x) => (x instanceof RegExp ? x.test(n) : x === n)), `unexpected change in ${n}`);
  return changed;
}
export const partText = (bytes, name) => strFromU8(unzipSync(new Uint8Array(bytes))[name]);

/** Top-level <w:body> children, each re-serialized by the same serializer (so equal XML compares equal). */
export async function bodyBlocks(bytes) {
  const { DOMParser, XMLSerializer } = await import("@xmldom/xmldom");
  const doc = new DOMParser().parseFromString(partText(bytes, "word/document.xml"), "application/xml");
  const body = doc.getElementsByTagNameNS("http://schemas.openxmlformats.org/wordprocessingml/2006/main", "body")[0];
  const s = new XMLSerializer();
  return Array.from(body.childNodes).filter((n) => n.nodeType === 1).map((n) => s.serializeToString(n));
}
/** Blocks equal except the window [from, from+removed) replaced by `inserted` new ones. */
export function assertBlocksUnchangedOutside(before, after, from, removed, inserted) {
  assert.deepEqual(after.slice(0, from), before.slice(0, from), "blocks before the edit changed");
  assert.deepEqual(after.slice(from + inserted), before.slice(from + removed), "blocks after the edit changed");
}

/** LibreOffice smoke check: null when soffice is not installed (CI), else asserts a PDF came out. */
export function sofficeOpens(bytes, ext) {
  try { execFileSync("soffice", ["--version"], { stdio: "ignore", timeout: 20000 }); } catch { return null; }
  const dir = mkdtempSync(join(tmpdir(), "soffice-"));
  writeFileSync(join(dir, `t.${ext}`), Buffer.from(bytes));
  execFileSync("soffice", ["--headless", `-env:UserInstallation=file://${dir}/profile`, "--convert-to", "pdf", "--outdir", dir, join(dir, `t.${ext}`)], { stdio: "ignore", timeout: 120000 });
  assert.ok(existsSync(join(dir, "t.pdf")), `LibreOffice could not open the edited .${ext}`);
  return true;
}
