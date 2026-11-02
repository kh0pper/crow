/**
 * installed.json is written atomically (temp file + rename in the same directory). A torn file
 * reads as "nothing installed" (getInstalled swallows the parse error), so a save made after a
 * torn read would write that back and wipe every entry.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmScratch } from "./helpers/safe-rm.js";

const DIR = mkdtempSync(join(tmpdir(), "installed-atomic-"));
after(() => rmScratch(DIR));

test("saveInstalled writes the whole list and leaves no temp file behind", async () => {
  const { saveInstalled } = await import("../servers/gateway/routes/bundles.js");
  const path = join(DIR, "home", "installed.json");
  const list = Array.from({ length: 500 }, (_, i) => ({ id: `bundle-${i}`, type: "mcp-server", version: "1.0.0" }));
  saveInstalled(list, path);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), list);
  saveInstalled(list.slice(0, 3), path);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), list.slice(0, 3));
  assert.deepEqual(readdirSync(join(DIR, "home")), ["installed.json"], "no .tmp file is left");
});

test("no server code writes installed.json in place", () => {
  const offenders = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) { if (e.name !== "node_modules") walk(p); continue; }
      if (!/\.(m?js)$/.test(e.name)) continue;
      const src = readFileSync(p, "utf8");
      for (const [i, line] of src.split("\n").entries()) {
        if (/writeFileSync\(\s*(INSTALLED_PATH|installedPath)\b/.test(line)) offenders.push(`${p}:${i + 1}`);
      }
    }
  };
  walk(new URL("../servers", import.meta.url).pathname);
  assert.deepEqual(offenders, [], "use atomicWrite (servers/gateway/bundle-skill-sync.js)");
});
