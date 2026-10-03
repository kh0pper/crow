# Crow Workspace W2: Crow Toolset Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship an MCP server inside the `workspace` bundle that gives Crow's bots safe, versioned, lock-aware control of the household's Nextcloud + ONLYOFFICE Workspace. It covers:
- **Drive, Docs, Sheets, Slides, Calendar, Contacts:** 74 `ws_*` tools mirroring the Google Workspace MCP;
- a phone-friendly **Quick edit** page in the Office panel.

**Architecture:**
- **Bundle server:** a node stdio MCP server in `bundles/workspace/server/`. It talks to Nextcloud (WebDAV/CalDAV/CardDAV/OCS) as `crow-bot` over loopback, and to ONLYOFFICE's command service with the bundle's JWT secret.
- **Office edits:** surgical OOXML edits (`fflate` zip + `@xmldom/xmldom` DOM). Untouched parts and nodes stay byte-identical.
- **Single write path:** every file write goes through `write-protocol.js`. That path does the lock check, waits ≤ 30 s, can optionally drop the editor, does an `If-Match` PUT, labels versions, and returns an undo `version_id`.
- **Quick edit:** server-rendered forms that reuse the same modules.

**Tech Stack:** Node 24 (ESM, global `fetch`), `@modelcontextprotocol/sdk`, `zod`, `fflate`, `@xmldom/xmldom`, `ical.js`, `marked` (already a root dep), Express panel routes, `node:test`.

**Spec:** `docs/superpowers/specs/2026-10-03-workspace-w2-toolset-design.md` (read it first; section refs below are §N of that spec). Parent: `docs/superpowers/specs/2026-10-02-crow-workspace-design.md`.

## Global Constraints

- **Implementation worktree:** `git -C ~/crow fetch -q origin && git -C ~/crow worktree add ~/crow-wt-w2-impl -b feat/workspace-w2-toolset origin/main`, then `npm ci` inside it. Never `git checkout` a branch in `~/crow`: a parked checkout silently disables fleet auto-update.
- Node 24 only (`engines` + CI). Tests run through `npm test -- tests/<file>.test.js` (scratch env). **Never** run raw `node --test` against the live `~/.crow`.
- **Commits.** Commit with a positional path: `git add <new files>` and then `git commit <paths> -m "…"`. Check `git show --stat HEAD` after each commit. **Never** attribute Claude as a co-author.
- **Tool names** are exactly the 74 names of spec §4 (`ws_<drive|docs|sheets|slides|cal|contacts>_<verb>` + `ws_undo_last_change`). The surface test in Task 12 pins the list.
- **Result envelope:** `{success:true,data}` / `{success:false,code,error,data?}` as one JSON text block. `isError:true` on failure.
- **No tool reads or writes a host filesystem path.** Every DAV URL is built by `server/nc/paths.js` only.
- **Credentials.**
  - Read only from `<CROW_HOME>/bundles/workspace/.env`, via `servers/gateway/bundle-env-codec.js` `parseEnvText`.
  - Never in argv, `mcp-addons.json`, logs, results or errors. `server.envKeys` is `[]`.
- **Caps:**
  - edit/read download 50 MB;
  - upload 10 MB decoded;
  - image 5 MB;
  - `read_file` ≤ 1,000,000 chars;
  - sheet read ≤ 50,000 cells;
  - zip ≤ 5,000 entries, ≤ 200 MB uncompressed, ratio ≤ 200:1;
  - XML part ≤ 30 MB;
  - `<!DOCTYPE` rejected.
- **Lock policy:** wait ≤ 30 s (poll 2 s) by default. `if_open:"proceed"` only drops ONLYOFFICE editor sessions, never a person's manual lock. Quick edit waits 10 s.
- **Same-file write spacing:** ≥ 1.1 s between two writes to the same file (version ids are mtimes).
- **Bundle code changes** bump `bundles/workspace/manifest.json` to **0.2.0**. The registry entry in `registry/add-ons.json` must match (`build-registry --check`).
- **Dependencies:** bundle deps are declared in `bundles/workspace/package.json` (`tests/bundle-server-deps.test.js`) AND in root `devDependencies` (CI resolves bundle imports through root `node_modules`).
  - New packages: `fflate`, `@xmldom/xmldom`, `ical.js`. **Kevin approves them before install** (Task 3 Step 0).
- **Panel code is server-rendered with no client script.** If any inline script is ever added, it must contain no backticks and no `${` (the panel template-literal rule).
- **Network invariant:** nothing new is exposed. No new host port, no Serve/Funnel change.
- **Before any gateway restart on crow:** read `~/CROW-SCHEDULE.md` and don't restart inside a registered window.

## Review Focus

Five inputs the spec implies but no tool table spells out. Each is pinned by a named test in the owning task.

1. **Accented and emoji names** (Dayane writes Spanish), e.g. `Menú semanal/Recetas – 2026 🌮.xlsx`, `find:"Jalapeño"`, an event `"Cena: tacos al pastor"`. Paths round-trip NFC-encoded, and text matching works on composed characters.
   - Pinned in Task 4 (`paths: accented + emoji segments round-trip`), Task 7 (`find_replace matches NFC/NFD-equivalent accents`) and Task 10 (`event summary with accents survives ICS round-trip`).
2. **Two bot calls hit the same file at once** (e.g. Kitchen appends two recipe rows in parallel). Both changes land, as two versions, ≥ 1.1 s apart, and neither is lost.
   - Pinned in Task 5 (`concurrent writes to one file serialize and both apply`).
3. **A match that spans runs separated by non-text nodes** (bookmark, comment anchor, proofErr, field) in an ONLYOFFICE-saved file. The text is replaced, the bookmark/comment anchors survive, and a match never crosses a tab or line break.
   - Pinned in Task 7 (`find_replace across runs keeps bookmarks and comment anchors`, `never matches across w:tab`).
4. **All-day and DST-crossing events** in America/Chicago (an all-day "Menu" item on 2026-11-01, the DST end day; a weekly recurring dinner across the change). Dates stay `VALUE=DATE`, list windows include them, and recurrences expand at the right local wall time.
   - Pinned in Task 10 (`all-day on DST day stays a date`, `weekly recurrence across DST keeps wall time`).
5. **Writing into a sheet where the target touches a shared formula, a merged area, or rows beyond the used range.** Writes beyond the range create ordered rows and update `<dimension>`. Writing into a merged area's non-anchor cell is refused with the anchor named. Overwriting part of a shared-formula group is refused, unless the write covers the whole group.
   - Pinned in Task 8 (`write beyond used range keeps row order`, `refuses merged non-anchor`, `refuses partial shared-formula overwrite`).

---

## Rulings (decided here; deviations need Kevin)

- **R-PROCEED:** `if_open:"proceed"` = ONLYOFFICE `drop` for the session users from `info`, then wait ≤ 30 s for the lock to clear, then write. If Task 1 finds `drop` doesn't release the lock, or loses typing, proceed returns `could_not_close_editor` (no other escalation) and the skill says "try later". Kevin is told in the Task 1 results.
- **R-EXPIRY:** if Task 1 shows labeled versions are **not** exempt from expiry, nothing changes in code. Undo already returns `version_gone` honestly. Note it in the spike results and the skill.
- **R-COLLIDE:** writes to one file are spaced ≥ 1.1 s. If Task 1 shows Nextcloud skips a version for two quick PUTs even 1.1 s apart, raise the spacing to the smallest observed safe gap + 0.5 s and record it.
- **R-HOST:** no `Host` header override. Loopback DAV answers 207 without it (verified 2026-10-03).
- **R-TEMPLATES:** new-file templates come from python-docx / openpyxl / python-pptx (MIT) through a committed script. ONLYOFFICE's AGPL `new.*` assets are never copied.
- **R-COMMENTS:** doc comments are in-file OOXML comments (what ONLYOFFICE shows), not Nextcloud sidebar comments.
- **R-NOLOCAL:** no tool takes a local path. Export goes into the drive.
- **R-SHAREDF:** a partial overwrite of a shared-formula group is refused (no formula translation in v1).
- **R-CAL-MASTER:** `ws_cal_update_event` edits the series master only. Instance overrides are a follow-up.
- **R-REG:** existing installs get the MCP entry through the new refresh-registration fix (Task 2). No manual mcp-addons edit is ever needed or allowed.

## File map

```
bundles/workspace/
  manifest.json                     MODIFY  0.2.0; server, skills, panelRoutes
  package.json                      CREATE  deps
  server/index.js                   CREATE  stdio entry
  server/server.js                  CREATE  createWorkspaceServer({clock}) → registers tools/*
  server/app-root.js                CREATE  CROW_APP_ROOT resolver (browser bundle pattern)
  server/result.js                  CREATE  WsError, ok/fail, handler()
  server/config.js                  CREATE  lazy .env read via codec → frozen config
  server/nc/paths.js                CREATE  the ONLY DAV URL builder; validation
  server/nc/http.js                 CREATE  authed fetch, timeout, size-capped body
  server/nc/multistatus.js          CREATE  xmldom multistatus parser
  server/nc/dav.js                  CREATE  stat/list/get/put/mkcol/move/copy/delete/search/resolveRef
  server/nc/versions.js             CREATE  list/label/restore
  server/nc/ocs.js                  CREATE  OCS GET/POST JSON helpers, shares, principal display names
  server/nc/onlyoffice.js           CREATE  JWT, command (info/drop), docKey, exportAs
  server/nc/locks.js                CREATE  lockInfo + classifyLock
  server/write-protocol.js          CREATE  withFileWrite / withFileRestore / undoFileChange / version ids
  server/ooxml/xml.js               CREATE  parse/serialize/ns helpers
  server/ooxml/zip.js               CREATE  OoxmlPackage (limits, order-preserving save)
  server/ooxml/opc.js               CREATE  rels + content types
  server/ooxml/image-size.js        CREATE  png/jpeg/gif dimensions
  server/ooxml/docx-model.js        CREATE  styles, headings, blocks, run/text maps
  server/ooxml/docx-read.js         CREATE  markdown, structure, sections
  server/ooxml/md-to-wml.js         CREATE  marked tokens → w:p/w:tbl (Normal reset)
  server/ooxml/docx-edit.js         CREATE  find_replace, rewrite, format, insert/append/replace_section, image
  server/ooxml/docx-comments.js     CREATE  list/add/reply/resolve/apply
  server/ooxml/xlsx.js              CREATE  workbook model, read/write/append/tabs/number formats/rename
  server/ooxml/xlsx-format.js       CREATE  formatted values
  server/ooxml/pptx.js              CREATE  slides model + edits
  server/ooxml/text-extract.js      CREATE  read_file text for the three formats
  server/pim/dav-xml.js             CREATE  CalDAV/CardDAV REPORT bodies
  server/pim/caldav.js              CREATE  calendars + events
  server/pim/carddav.js             CREATE  address books + contacts
  server/pim/journal.js             CREATE  undo journal (600/700)
  server/tools/drive.js docs.js docs-comments.js sheets.js slides.js calendar.js contacts.js undo.js   CREATE
  server/quick/view.js              CREATE  Quick edit HTML renderers
  server/quick/actions.js           CREATE  Quick edit save/undo/restore
  server/templates/make-templates.py + blank.docx|xlsx|pptx   CREATE (Task 1)
  panel/workspace.js                MODIFY  tabs Setup | Quick edit
  panel/routes.js                   CREATE  /api/workspace/quick/*
  skills/workspace.md               CREATE
servers/gateway/routes/bundles.js   MODIFY  secret-skip in applyEnvToMcpAddons; refresh registers missing MCP entry
registry/add-ons.json               MODIFY  workspace entry
package.json / package-lock.json    MODIFY  root devDependencies
bundles/nextcloud/skills/nextcloud.md  MODIFY  pointer to workspace skill
docs/guide/workspace.md             CREATE  user guide (toolset + Quick edit)
docs/superpowers/specs/2026-10-03-workspace-w2-spike-results.md   CREATE (Task 1)
scripts/workspace-w2-spike.mjs      CREATE  live probe (Task 1, kept for re-runs)
tests/fixtures/workspace/make-fixtures.py + rich.* + oo-rich.*   CREATE (Task 1)
tests/helpers/workspace-fake-nextcloud.js   CREATE
tests/helpers/ooxml-assert.js       CREATE
tests/workspace-*.test.js           CREATE (per task)
tests/workspace-bundle.test.js      MODIFY  walk skips node_modules + binaries
```

## Task list

1. Live spike + fixtures + templates (gate)
2. Gateway fixes: secret-skip + refresh registers MCP
3. Bundle scaffold, config, result envelope, deps
4. Paths, HTTP, multistatus, DAV client + fake Nextcloud + Drive read tools
5. Write protocol, locks, ONLYOFFICE, versions, undo + Drive write tools
6. OOXML core + docx read tools
7. Docx edit tools
8. Sheets tools
9. Slides tools
10. Calendar + Contacts + journal
11. Doc comments + read_file text extraction
12. Quick edit page + skill + docs + registry + surface test
13. PR, CI, merge, deploy on crow
14. Live acceptance on crow ([KEVIN] steps)

---

### Task 1: Live spike, fixtures and templates (GATE: no product code before this)

Verifies the live facts the protocol relies on, captures real ONLYOFFICE-written fixtures, and generates the blank templates. It runs on crow as crow-bot, in a scratch folder.

**Files:**
- Create: `scripts/workspace-w2-spike.mjs`
- Create: `tests/fixtures/workspace/make-fixtures.py`, `tests/fixtures/workspace/rich.{docx,xlsx,pptx}`, `tests/fixtures/workspace/oo-rich.{docx,xlsx,pptx}`
- Create: `bundles/workspace/server/templates/make-templates.py`, `bundles/workspace/server/templates/blank.{docx,xlsx,pptx}`
- Create: `docs/superpowers/specs/2026-10-03-workspace-w2-spike-results.md`

**Interfaces:**
- Produces: the fixtures/templates later tasks load by these exact paths, and the spike-results file that confirms or adjusts R-PROCEED / R-EXPIRY / R-COLLIDE.

- [ ] **Step 1: Write the fixture generator**

`tests/fixtures/workspace/make-fixtures.py`:

```python
#!/usr/bin/env python3
"""Generate the W2 OOXML test fixtures (dev-time only; python-docx/openpyxl/python-pptx, MIT).
Run: python3 tests/fixtures/workspace/make-fixtures.py  (writes rich.docx/.xlsx/.pptx next to this file)."""
import os, io, struct, zlib
from docx import Document
from docx.shared import Pt
from docx.oxml.ns import qn
from docx.oxml import OxmlElement
from openpyxl import Workbook
from openpyxl.chart import BarChart, Reference
from openpyxl.styles import Font, PatternFill
from pptx import Presentation
from pptx.util import Inches

HERE = os.path.dirname(os.path.abspath(__file__))

def png_1x1():
    raw = b"\x00\xff\x00\x00"
    def chunk(t, d): return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")

def add_bookmark(par, name, bid):
    start = OxmlElement("w:bookmarkStart"); start.set(qn("w:id"), str(bid)); start.set(qn("w:name"), name)
    end = OxmlElement("w:bookmarkEnd"); end.set(qn("w:id"), str(bid))
    runs = par._p.findall(qn("w:r"))
    runs[0].addnext(start); runs[1].addnext(end)

def docx():
    d = Document()
    d.sections[0].header.paragraphs[0].text = "Casa Nueva — header"
    d.sections[0].footer.paragraphs[0].text = "Página footer"
    d.add_heading("Recetas de la semana", level=1)
    p = d.add_paragraph()
    p.add_run("Tacos al ").bold = True
    p.add_run("pastor").italic = True
    p.add_run(" con piña y jalapeño.")
    add_bookmark(p, "tacos", 1)
    d.add_comment(p.runs[2], text="¿Con salsa verde?", author="Dayane", initials="D")  # python-docx >= 1.2
    d.add_heading("Ingredientes", level=2)
    for item in ["Tortillas", "Cebolla", "Cilantro"]:
        d.add_paragraph(item, style="List Bullet")
    d.add_heading("Pasos", level=2)
    for step in ["Marinar la carne", "Asar", "Servir"]:
        d.add_paragraph(step, style="List Number")
    t = d.add_table(rows=2, cols=2); t.style = "Table Grid"
    t.cell(0, 0).text, t.cell(0, 1).text = "Día", "Plato"
    t.cell(1, 0).text, t.cell(1, 1).text = "Jueves", "Tacos"
    pt = d.add_paragraph("Tab\tseparated text and a line"); pt.add_run().add_break(); pt.add_run("break here.")
    d.add_heading("Notas", level=1)
    d.add_paragraph("Última línea antes del final.")
    d.add_picture(io.BytesIO(png_1x1()))
    d.save(os.path.join(HERE, "rich.docx"))

def xlsx():
    wb = Workbook(); ws = wb.active; ws.title = "Recetas"
    ws.append(["Nombre", "Porciones", "Costo", "Fecha", "Total"])
    rows = [("Tacos", 4, 12.5), ("Pozole", 6, 20), ("Enchiladas", 4, 15.25)]
    for i, (n, s, c) in enumerate(rows, start=2):
        ws.append([n, s, c, None, None])
        ws.cell(row=i, column=4).value = "2026-10-0%d" % i
        ws.cell(row=i, column=5).value = "=B%d*C%d" % (i, i)
    ws["C2"].number_format = "#,##0.00"; ws["B2"].font = Font(bold=True)
    ws["A1"].fill = PatternFill("solid", fgColor="FFFF00")
    ws.merge_cells("A6:C6"); ws["A6"] = "Merged note"
    ws.freeze_panes = "A2"
    chart = BarChart(); chart.add_data(Reference(ws, min_col=3, min_row=1, max_row=4), titles_from_data=True); ws.add_chart(chart, "G2")
    ws2 = wb.create_sheet("Menú semanal"); ws2["A1"] = "Jueves"; ws2["B1"] = "='Recetas'!A2"
    wb.save(os.path.join(HERE, "rich.xlsx"))

def pptx():
    pr = Presentation()
    s1 = pr.slides.add_slide(pr.slide_layouts[0]); s1.shapes.title.text = "Menú de octubre"; s1.placeholders[1].text = "Casa Nueva"
    s2 = pr.slides.add_slide(pr.slide_layouts[1]); s2.shapes.title.text = "Jueves"; s2.placeholders[1].text = "Tacos al pastor\nAgua de jamaica"
    s2.notes_slide.notes_text_frame.text = "Recordar comprar piña"
    tb = s2.shapes.add_textbox(Inches(1), Inches(5), Inches(4), Inches(1)); tb.text_frame.text = "Texto libre"
    pr.save(os.path.join(HERE, "rich.pptx"))

docx(); xlsx(); pptx(); print("ok")
```

- [ ] **Step 2: Write the template generator**

`bundles/workspace/server/templates/make-templates.py`:

```python
#!/usr/bin/env python3
"""Blank new-file templates for ws_*_create (python-docx/openpyxl/python-pptx, MIT). Dev-time; output committed."""
import os
from docx import Document
from openpyxl import Workbook
from pptx import Presentation
HERE = os.path.dirname(os.path.abspath(__file__))
d = Document()
for s in ("Heading 1", "Heading 2", "Heading 3", "Heading 4", "Heading 5", "Heading 6", "List Bullet", "List Number", "Table Grid"):
    d.styles[s]  # KeyError if the default template ever loses one
body = d.element.body
for p in list(body.iterchildren()):
    if not p.tag.endswith("sectPr"):
        body.remove(p)
d.save(os.path.join(HERE, "blank.docx"))
wb = Workbook(); wb.active.title = "Sheet1"; wb.save(os.path.join(HERE, "blank.xlsx"))
pr = Presentation(); pr.save(os.path.join(HERE, "blank.pptx"))
print("ok")
```

- [ ] **Step 3: Generate both sets**

Run: `python3 tests/fixtures/workspace/make-fixtures.py && python3 bundles/workspace/server/templates/make-templates.py`
Expected: `ok` twice. Six binary files exist. Check `unzip -l bundles/workspace/server/templates/blank.pptx | grep -c slideLayout` ≥ 3 and `unzip -l …/blank.pptx | grep notesMaster` (if the notes master is missing, add `pr.notes_master` access before save; python-pptx creates it lazily).

- [ ] **Step 4: Write the spike script**

`scripts/workspace-w2-spike.mjs`. It probes and makes no product changes. It runs as crow-bot in `Shared with Crow/<first folder>/.w2-spike-<ts>/` and moves that folder to the trash at the end.

```js
#!/usr/bin/env node
// W2 spike: verifies the live Nextcloud/ONLYOFFICE behaviour the write protocol relies on.
// Usage: node scripts/workspace-w2-spike.mjs [--editor-test] [--capture-fixtures]
// Reads ~/.crow/bundles/workspace/.env via the bundle codec. Prints facts, never secrets.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHmac } from "node:crypto";
import { parseEnvText } from "../servers/gateway/bundle-env-codec.js";

const env = parseEnvText(readFileSync(join(process.env.CROW_HOME || join(homedir(), ".crow"), "bundles", "workspace", ".env"), "utf8"));
const NC = "http://127.0.0.1:3070", OO = "http://127.0.0.1:3071", U = "crow-bot";
const AUTH = "Basic " + Buffer.from(`${U}:${env.WORKSPACE_BOT_APP_PASSWORD}`).toString("base64");
const args = new Set(process.argv.slice(2));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const facts = [];
const fact = (k, v) => { facts.push([k, v]); console.log(`FACT ${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`); };
const dav = (method, path, { headers = {}, body } = {}) => fetch(`${NC}/remote.php/dav/${path}`, { method, headers: { Authorization: AUTH, ...headers }, body });
const enc = (p) => p.split("/").map(encodeURIComponent).join("/");
const prop = (xml, name) => (xml.match(new RegExp(`<${name}>([^<]*)<`)) || [])[1] ?? null; // spike-only; product code uses xmldom
const jwt = (payload) => { const b = (o) => Buffer.from(JSON.stringify(o)).toString("base64url"); const h = `${b({ alg: "HS256", typ: "JWT" })}.${b(payload)}`; return `${h}.${createHmac("sha256", env.WORKSPACE_ONLYOFFICE_JWT_SECRET).update(h).digest("base64url")}`; };
const cmd = async (payload) => { const t = jwt(payload); return (await fetch(`${OO}/coauthoring/CommandService.ashx`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${t}` }, body: JSON.stringify({ ...payload, token: t }) })).json(); };
const PF = `<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns" xmlns:nc="http://nextcloud.org/ns"><d:prop><d:getetag/><d:getlastmodified/><oc:fileid/><nc:lock/><nc:lock-owner-type/><nc:lock-owner/></d:prop></d:propfind>`;
const stat = async (p) => { const x = await (await dav("PROPFIND", `files/${U}/${enc(p)}`, { headers: { Depth: "0" }, body: PF })).text(); return { etag: prop(x, "d:getetag"), mtime: Date.parse(prop(x, "d:getlastmodified")) / 1000, fileid: Number(prop(x, "oc:fileid")), lock: prop(x, "nc:lock"), lockType: prop(x, "nc:lock-owner-type"), lockOwner: prop(x, "nc:lock-owner") }; };
const versions = async (fid) => { const x = await (await dav("PROPFIND", `versions/${U}/versions/${fid}`, { headers: { Depth: "1" } })).text(); return [...x.matchAll(/versions\/\d+\/(\d+)</g)].map((m) => m[1]); };

const list = await (await dav("PROPFIND", `files/${U}/Shared%20with%20Crow/`, { headers: { Depth: "1" } })).text();
const parent = decodeURIComponent((list.match(/<d:href>\/remote\.php\/dav\/files\/crow-bot\/(Shared%20with%20Crow\/[^<]+\/)<\/d:href>/) || [])[1] || "Shared%20with%20Crow/");
const DIR = `${parent}.w2-spike-${Date.now()}`;
fact("scratch_dir", DIR);
fact("mkcol", (await dav("MKCOL", `files/${U}/${enc(DIR)}`)).status);

// S1 versions per PUT; ids = mtimes
const f = `${DIR}/v.txt`;
await dav("PUT", `files/${U}/${enc(f)}`, { body: "one" }); await sleep(1500);
const s1 = await stat(f);
const put2 = await dav("PUT", `files/${U}/${enc(f)}`, { headers: { "If-Match": s1.etag }, body: "two" });
const s2 = await stat(f);
const v2 = await versions(s2.fileid);
fact("S1_put_if_match_status", put2.status);
fact("S1_versions_after_two_puts", v2);
fact("S1_current_listed_as_version", v2.includes(String(s2.mtime)));
fact("S1_previous_version_id_equals_old_mtime", v2.includes(String(s1.mtime)));

// S2 label a version; etag unchanged?
const pp = await dav("PROPPATCH", `versions/${U}/versions/${s2.fileid}/${s1.mtime}`, { headers: { "Content-Type": "application/xml" }, body: `<?xml version="1.0"?><d:propertyupdate xmlns:d="DAV:" xmlns:nc="http://nextcloud.org/ns"><d:set><d:prop><nc:version-label>Before Crow: spike</nc:version-label></d:prop></d:set></d:propertyupdate>` });
fact("S2_label_status", pp.status);
fact("S2_etag_unchanged_by_label", (await stat(f)).etag === s2.etag);
const pp2 = await dav("PROPPATCH", `versions/${U}/versions/${s2.fileid}/${s2.mtime}`, { headers: { "Content-Type": "application/xml" }, body: `<?xml version="1.0"?><d:propertyupdate xmlns:d="DAV:" xmlns:nc="http://nextcloud.org/ns"><d:set><d:prop><nc:version-label>Crow: spike</nc:version-label></d:prop></d:set></d:propertyupdate>` });
fact("S2b_label_current_version_status", pp2.status);

// S3 restore via MOVE
const mv = await dav("MOVE", `versions/${U}/versions/${s2.fileid}/${s1.mtime}`, { headers: { Destination: `${NC}/remote.php/dav/versions/${U}/restore/target` } });
fact("S3_restore_status", mv.status);
fact("S3_content_after_restore", await (await dav("GET", `files/${U}/${enc(f)}`)).text());
fact("S3_versions_after_restore", await versions(s2.fileid));

// S4 two PUTs 1.1 s apart → two versions?
const g = `${DIR}/fast.txt`;
await dav("PUT", `files/${U}/${enc(g)}`, { body: "a" }); await sleep(1100);
await dav("PUT", `files/${U}/${enc(g)}`, { body: "b" }); await sleep(1100);
await dav("PUT", `files/${U}/${enc(g)}`, { body: "c" });
fact("S4_versions_for_three_puts_1100ms", (await versions((await stat(g)).fileid)).length);

// S5 info on a never-opened key → error 1
const cfg = await (await fetch(`${NC}/ocs/v2.php/apps/onlyoffice/api/v1/config/${s2.fileid}?format=json`, { headers: { Authorization: AUTH, "OCS-APIRequest": "true" } })).json();
fact("S5_config_has_key", !!cfg?.document?.key);
fact("S5_info_no_session", await cmd({ c: "info", key: cfg.document.key }));

if (args.has("--editor-test")) {
  // S6 [KEVIN]: open <DIR>/editor.docx in Workspace, type a word, leave the tab open, press Enter here.
  const e = `${DIR}/editor.docx`;
  await dav("PUT", `files/${U}/${enc(e)}`, { body: readFileSync(join(import.meta.dirname, "..", "tests", "fixtures", "workspace", "rich.docx")) });
  console.log(`\n[KEVIN] Open "${e}" in Workspace (ONLYOFFICE), type the word SPIKE anywhere, keep the tab open, then press Enter here.`);
  await new Promise((r) => process.stdin.once("data", r));
  const st = await stat(e);
  fact("S6_lock_while_open", { lock: st.lock, type: st.lockType, owner: st.lockOwner });
  const before = await (await dav("GET", `files/${U}/${enc(e)}`)).arrayBuffer();
  fact("S6_put_while_open_status", (await dav("PUT", `files/${U}/${enc(e)}`, { headers: { "If-Match": st.etag }, body: Buffer.from(before) })).status);
  const key = (await (await fetch(`${NC}/ocs/v2.php/apps/onlyoffice/api/v1/config/${st.fileid}?format=json`, { headers: { Authorization: AUTH, "OCS-APIRequest": "true" } })).json()).document.key;
  const info = await cmd({ c: "info", key });
  fact("S6_info", info);
  const t0 = Date.now();
  fact("S6_drop", await cmd({ c: "drop", key, users: info.users || [] }));
  let cleared = null;
  for (let i = 0; i < 30; i++) { await sleep(1000); if ((await stat(e)).lock !== "1") { cleared = (Date.now() - t0) / 1000; break; } }
  fact("S6_seconds_until_unlock", cleared);
  const after = Buffer.from(await (await dav("GET", `files/${U}/${enc(e)}`)).arrayBuffer());
  fact("S6_typing_saved_contains_SPIKE", after.includes(Buffer.from("SPIKE")) || (await import("node:zlib")) && "check-manually");
  fact("S6_versions", await versions(st.fileid));
  console.log("[KEVIN] What did the editor tab show after the drop? Type a short description and press Enter:");
  fact("S6_editor_ui", String(await new Promise((r) => process.stdin.once("data", r))).trim());
}

if (args.has("--capture-fixtures")) {
  // S7 [KEVIN]: open each rich.* in ONLYOFFICE, type one character and delete it, close the tab; press Enter here.
  for (const ext of ["docx", "xlsx", "pptx"]) await dav("PUT", `files/${U}/${enc(`${DIR}/rich.${ext}`)}`, { body: readFileSync(join(import.meta.dirname, "..", "tests", "fixtures", "workspace", `rich.${ext}`)) });
  console.log(`\n[KEVIN] In "${DIR}": open rich.docx, rich.xlsx, rich.pptx one at a time, make a tiny edit (type and delete a character), close each tab. Wait 20 s after the last close, then press Enter.`);
  await new Promise((r) => process.stdin.once("data", r));
  const { writeFileSync } = await import("node:fs");
  for (const ext of ["docx", "xlsx", "pptx"]) {
    const b = Buffer.from(await (await dav("GET", `files/${U}/${enc(`${DIR}/rich.${ext}`)}`)).arrayBuffer());
    writeFileSync(join(import.meta.dirname, "..", "tests", "fixtures", "workspace", `oo-rich.${ext}`), b);
    fact(`S7_captured_oo-rich.${ext}_bytes`, b.length);
  }
}

fact("cleanup_delete", (await dav("DELETE", `files/${U}/${enc(DIR)}`)).status);
console.log("\nFACTS JSON\n" + JSON.stringify(Object.fromEntries(facts), null, 2));
```

- [ ] **Step 5: Check the box schedule, then run the non-interactive spike**

Read `~/CROW-SCHEDULE.md`. The spike uses no GPU and needs no window, but it must not run inside a registered window.
Run: `node scripts/workspace-w2-spike.mjs`
Expected:
- `S1_put_if_match_status` 204;
- `S1_current_listed_as_version` true;
- `S1_previous_version_id_equals_old_mtime` true;
- `S2_label_status` 207, `S2_etag_unchanged_by_label` true, and `S2b_label_current_version_status` 207 (if the current version can't be labeled, `finishWrite` keeps only the "Before" label and the results file says so);
- `S3_restore_status` 201 or 204, and the content after restore is `one`;
- `S4_versions_for_three_puts_1100ms` = 3;
- `S5_info_no_session.error` = 1.

Any other value: stop. Record it in the results file and apply R-COLLIDE / R-EXPIRY.

- [ ] **Step 6: Verify the labeled-version expiry exemption in Nextcloud's source**

Run: `grep -rn "label" ~/.crow/workspace/nextcloud/apps/files_versions/lib/Expiration.php ~/.crow/workspace/nextcloud/apps/files_versions/lib/Storage.php | head -20`
Expected: the expiry code skips versions that have a label (NC ≥ 26 behavior). Record the file:line as evidence, or record "not exempt" and apply R-EXPIRY.

- [ ] **Step 7: [KEVIN] Editor test**

Run: `node scripts/workspace-w2-spike.mjs --editor-test`. Kevin opens the file named in the prompt on his laptop, types `SPIKE`, keeps the tab open and presses Enter in the terminal.
Expected:
- `S6_lock_while_open.type` = `1`, owner `onlyoffice`;
- `S6_put_while_open_status` = 423;
- `S6_info.users` contains `<instanceid>_admin`;
- `S6_drop.error` = 0;
- `S6_seconds_until_unlock` ≤ 30;
- Kevin's `SPIKE` is in the saved file. If the byte check prints `check-manually`, run `unzip -p` on a downloaded copy and grep `word/document.xml` for SPIKE.

Kevin's description of the tab is recorded. **If unlock > 30 s or the typing is lost → R-PROCEED fallback.**

- [ ] **Step 8: [KEVIN] Capture ONLYOFFICE-written fixtures**

Run: `node scripts/workspace-w2-spike.mjs --capture-fixtures` and follow the prompt.
Expected: `tests/fixtures/workspace/oo-rich.{docx,xlsx,pptx}` exist and differ from `rich.*` (`cmp` reports a difference).

- [ ] **Step 9: Write the results file**

`docs/superpowers/specs/2026-10-03-workspace-w2-spike-results.md` contains:
- the FACTS JSON of each run;
- the Step 6 evidence;
- Kevin's S6 description;
- one line per ruling: R-PROCEED confirmed/fallback, R-EXPIRY exempt/not, R-COLLIDE spacing value.

- [ ] **Step 10: Commit**

```bash
git add scripts/workspace-w2-spike.mjs tests/fixtures/workspace bundles/workspace/server/templates docs/superpowers/specs/2026-10-03-workspace-w2-spike-results.md
git commit scripts/workspace-w2-spike.mjs tests/fixtures/workspace bundles/workspace/server/templates docs/superpowers/specs/2026-10-03-workspace-w2-spike-results.md -m "chore(workspace): W2 live spike, OOXML fixtures and blank templates"
git show --stat HEAD
```

---

### Task 2: Gateway fixes: keep secrets out of mcp-addons.json; refresh registers a missing MCP server

**Files:**
- Modify: `servers/gateway/routes/bundles.js` (`applyEnvToMcpAddons` ~1129-1145 and its caller ~3288; `refreshVersionedBundle` tail ~800-812)
- Test: `tests/mcp-addons-secret-skip.test.js`, `tests/bundle-refresh-mcp-register.test.js`

**Interfaces:**
- Produces: `applyEnvToMcpAddons(bundleId, envVars, path = MCP_ADDONS_PATH, manifest = null)` skips keys whose manifest entry has `secret: true` or `generate` set, unless the key is in `manifest.server.envKeys`.
- Produces: `refreshVersionedBundle` writes `{command, args, env?}` for `id` when the repo manifest has `server` and mcp-addons.json has no `id` entry. It adds `"mcp-addons entry"` to `touched` and never rewrites an existing entry.
- Produces: `export function mcpAddonEntryFor(manifest, reqEnv = null)`, extracted from install (bundles.js:2189-2216) and used by both install and refresh.

- [ ] **Step 1: Write the failing tests**

`tests/mcp-addons-secret-skip.test.js`:

```js
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let B, dir;
before(async () => {
  dir = mkdtempSync(join(tmpdir(), "mcpaddons-"));
  process.env.CROW_HOME = dir;
  B = await import("../servers/gateway/routes/bundles.js");
});

const manifest = {
  id: "workspace",
  server: { command: "node", args: ["server/index.js"], envKeys: ["PUBLIC_KEY_LISTED"] },
  env_vars: [
    { name: "WORKSPACE_ADMIN_PASSWORD", secret: true },
    { name: "WORKSPACE_DB_PASSWORD", secret: true, generate: "secret" },
    { name: "PUBLIC_KEY_LISTED", secret: true },
    { name: "WORKSPACE_PUBLIC_HOST" },
  ],
};

test("Configure never copies secret or generated keys into mcp-addons.json", () => {
  const p = join(dir, "mcp-addons.json");
  writeFileSync(p, JSON.stringify({ workspace: { command: "node", args: ["server/index.js"] } }));
  const wrote = B.applyEnvToMcpAddons("workspace", {
    WORKSPACE_ADMIN_PASSWORD: "hunter2-hunter2", WORKSPACE_DB_PASSWORD: "dbpw", PUBLIC_KEY_LISTED: "ok-listed", WORKSPACE_PUBLIC_HOST: "crow.example.ts.net",
  }, p, manifest);
  assert.equal(wrote, true);
  const text = readFileSync(p, "utf8");
  assert.doesNotMatch(text, /hunter2|dbpw/);
  const env = JSON.parse(text).workspace.env;
  assert.deepEqual(env, { PUBLIC_KEY_LISTED: "ok-listed", WORKSPACE_PUBLIC_HOST: "crow.example.ts.net" });
});

test("without a manifest the old behaviour is unchanged (back-compat)", () => {
  const p = join(dir, "mcp-addons-2.json");
  writeFileSync(p, JSON.stringify({ x: { command: "node" } }));
  B.applyEnvToMcpAddons("x", { A: "1" }, p);
  assert.deepEqual(JSON.parse(readFileSync(p, "utf8")).x.env, { A: "1" });
});

test("mcpAddonEntryFor mirrors the install shape", () => {
  assert.deepEqual(B.mcpAddonEntryFor({ server: { command: "node", args: ["server/index.js"] }, env_vars: [{ name: "P", default: "8456" }] }),
    { command: "node", args: ["server/index.js"], env: { P: "8456" } });
  assert.deepEqual(B.mcpAddonEntryFor({ server: { command: "node" } }), { command: "node", args: [] });
});
```

`tests/bundle-refresh-mcp-register.test.js` (same harness as `tests/bundle-version-refresh.test.js`):

```js
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

const put = (root, rel, c) => { const p = join(root, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, c); };
let HOME, repair;
before(async () => {
  HOME = mkdtempSync(join(tmpdir(), "crowhome-mcpreg-"));
  process.env.CROW_HOME = HOME;
  ({ repairInstalledBundleAssets: repair } = await import("../servers/gateway/routes/bundles.js"));
});
after(() => { delete process.env.CROW_HOME; });
const run = async () => ({ stdout: "", stderr: "" });

test("a version bump that adds `server` registers the MCP entry for an existing install", async () => {
  const repo = mkdtempSync(join(tmpdir(), "repo-"));
  put(repo, "dockerish/manifest.json", JSON.stringify({ id: "dockerish", version: "0.2.0", type: "bundle", docker: { composefile: "docker-compose.yml" },
    server: { command: "node", args: ["server/index.js"], envKeys: [] }, env_vars: [{ name: "PORTX", default: "8456" }, { name: "S", secret: true, generate: "secret" }] }));
  put(repo, "dockerish/server/index.js", "// v2\n");
  put(HOME, "bundles/dockerish/manifest.json", JSON.stringify({ id: "dockerish", version: "0.1.2", type: "bundle", docker: { composefile: "docker-compose.yml" } }));
  put(HOME, "installed.json", JSON.stringify([{ id: "dockerish" }]));
  put(HOME, "mcp-addons.json", JSON.stringify({ other: { command: "node", args: ["x.js"] } }));
  const { repaired } = await repair({ appBundles: repo, run });
  const addons = JSON.parse(readFileSync(join(HOME, "mcp-addons.json"), "utf8"));
  assert.deepEqual(addons.dockerish, { command: "node", args: ["server/index.js"], env: { PORTX: "8456" } });
  assert.deepEqual(addons.other, { command: "node", args: ["x.js"] });
  assert.match(repaired.join(" "), /mcp-addons entry/);
});

test("an existing entry is never rewritten by refresh", async () => {
  const repo = mkdtempSync(join(tmpdir(), "repo2-"));
  put(repo, "keepme/manifest.json", JSON.stringify({ id: "keepme", version: "2.0.0", type: "mcp-server", server: { command: "node", args: ["server/index.js"] } }));
  put(repo, "keepme/server/index.js", "// v2\n");
  put(HOME, "bundles/keepme/manifest.json", JSON.stringify({ id: "keepme", version: "1.0.0", type: "mcp-server" }));
  put(HOME, "installed.json", JSON.stringify([{ id: "keepme" }]));
  const custom = { command: "node", args: ["server/index.js"], env: { OPERATOR_SET: "1" }, cwd: "/custom" };
  put(HOME, "mcp-addons.json", JSON.stringify({ keepme: custom }));
  await repair({ appBundles: repo, run });
  assert.deepEqual(JSON.parse(readFileSync(join(HOME, "mcp-addons.json"), "utf8")).keepme, custom);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test -- tests/mcp-addons-secret-skip.test.js tests/bundle-refresh-mcp-register.test.js`
Expected: FAIL. The secrets appear in env, `mcpAddonEntryFor` is not exported, and `addons.dockerish` is undefined.

- [ ] **Step 3: Implement**

In `servers/gateway/routes/bundles.js`, add near `applyEnvToMcpAddons`:

```js
/**
 * The mcp-addons.json entry for a manifest that declares `server` — the single shape both
 * install and the version refresh write. envKeys values come only from an install request;
 * every truthy env_vars default rides along (unchanged install behaviour).
 */
export function mcpAddonEntryFor(manifest, reqEnv = null) {
  const env = {};
  for (const key of manifest?.server?.envKeys || []) if (reqEnv && reqEnv[key]) env[key] = reqEnv[key];
  for (const v of manifest?.env_vars || []) if (v.default && !env[v.name]) env[v.name] = v.default;
  return { command: manifest.server.command, args: manifest.server.args || [], ...(Object.keys(env).length > 0 ? { env } : {}) };
}

/** Keys Configure may push into an MCP entry: never a secret/generated one unless the server asks for it. */
function mcpForwardableKeys(manifest) {
  if (!manifest) return null; // legacy callers: no filter
  const listed = new Set(manifest.server?.envKeys || []);
  const blocked = new Set((manifest.env_vars || []).filter((v) => v && (v.secret === true || v.generate) && !listed.has(v.name)).map((v) => v.name));
  return (k) => !blocked.has(k);
}
```

Change `applyEnvToMcpAddons`:

```js
export function applyEnvToMcpAddons(bundleId, envVars, path = MCP_ADDONS_PATH, manifest = null) {
  const mcpAddons = readJsonSafe(path, {});
  const entry = mcpAddons[bundleId];
  if (!entry) return false; // not an MCP add-on — nothing to configure
  const allowed = mcpForwardableKeys(manifest);
  const merged = { ...(entry.env || {}) };
  for (const [k, v] of Object.entries(envVars || {})) {
    if (v && (!allowed || allowed(k))) merged[k] = v;
  }
  entry.env = merged;
  mcpAddons[bundleId] = entry;
  writeJsonSafe(path, mcpAddons);
  return true;
}
```

At the Configure caller (~3288):

```js
const mcpUpdated = applyEnvToMcpAddons(bundle_id, env_vars, MCP_ADDONS_PATH, getInstalledFirstManifest(bundle_id));
```

In the install path (~2189-2216), replace the inline env/entry building with:

```js
if (manifest?.server) {
  const mcpAddons = readJsonSafe(MCP_ADDONS_PATH, {});
  // (keep the existing CROW_DB_PATH comment block here verbatim)
  mcpAddons[bundleId] = mcpAddonEntryFor(manifest, reqEnv);
  writeJsonSafe(MCP_ADDONS_PATH, mcpAddons);
  appendLog(job, `Registered MCP server '${bundleId}'`);
  needsRestart = true;
}
```

In `refreshVersionedBundle`, just before the `// Commit marker last` copy of `manifest.json`:

```js
  // A version that ADDS an MCP server must register it for existing installs (W2: the
  // workspace bundle gained a server; refresh used to copy server/ and never register it).
  if (repoManifest.server && !repoManifest.server.url) {
    const addons = readJsonSafe(MCP_ADDONS_PATH, {});
    if (!addons[id]) {
      addons[id] = mcpAddonEntryFor(repoManifest, null);
      writeJsonSafe(MCP_ADDONS_PATH, addons);
      touched.push("mcp-addons entry (restart to load)");
    }
  }
```

- [ ] **Step 4: Run the new tests and the neighbours**

Run: `npm test -- tests/mcp-addons-secret-skip.test.js tests/bundle-refresh-mcp-register.test.js tests/bundle-version-refresh.test.js tests/bundle-env-secrets.test.js tests/bundle-lifecycle-hooks.test.js`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add tests/mcp-addons-secret-skip.test.js tests/bundle-refresh-mcp-register.test.js
git commit servers/gateway/routes/bundles.js tests/mcp-addons-secret-skip.test.js tests/bundle-refresh-mcp-register.test.js -m "fix(bundles): keep secret keys out of mcp-addons.json; version refresh registers a newly added MCP server"
git show --stat HEAD
```

---

### Task 3: Bundle scaffold: package.json, deps, config, result envelope, server entry

**Files:**
- Create: `bundles/workspace/package.json`, `bundles/workspace/server/{index.js,server.js,app-root.js,result.js,config.js}`
- Modify: root `package.json` + `package-lock.json` (devDependencies), `tests/workspace-bundle.test.js` (walk skips `node_modules` and binary files)
- Test: `tests/workspace-config.test.js`

**Interfaces:**
- Produces `server/result.js`:
  - `class WsError extends Error { code; data }`
  - `ok(data)`, `fail(code, message, data?)`
  - `handler(fn, { redactWith }?)`: wraps `async (args) => data` into an MCP result and maps WsError to `fail`. Other errors become `fail("internal", "Unexpected error: <name>: <redacted message>")`.
- Produces `server/config.js`:
  - `BOT_USER = "crow-bot"`
  - `getConfig()` returns `{ user, appPassword, jwtSecret, host, ncUrl, ooUrl, webBase, secrets }`, frozen, or throws `WsError("not_ready")`
  - `redact(text, cfg)`, `envPath()`
- Produces `server/server.js`: `createWorkspaceServer({ clock } = {})` returns `McpServer`. Each later task adds one `register<Family>(server, ctx)` import there. `ctx = { getConfig, clock }` with `clock = { now(): number, sleep(ms): Promise }`.

- [ ] **Step 0: [KEVIN] Approve the new npm packages**

Ask Kevin in one message, then wait: "W2 needs three new npm packages: `fflate` 0.8.x (MIT, zip), `@xmldom/xmldom` 0.9.x (MIT, XML DOM) and `ical.js` 2.2.x (MPL-2.0, iCalendar/vCard). They go into `bundles/workspace/package.json` and root devDependencies. OK to install?" Do not proceed without a yes.

- [ ] **Step 1: Write the failing test**

`tests/workspace-config.test.js`:

```js
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let C, home;
before(async () => {
  home = mkdtempSync(join(tmpdir(), "ws-config-"));
  process.env.CROW_HOME = home;
  C = await import("../bundles/workspace/server/config.js");
});
const writeEnv = (text) => { mkdirSync(join(home, "bundles", "workspace"), { recursive: true }); writeFileSync(join(home, "bundles", "workspace", ".env"), text, { mode: 0o600 }); };

test("not_ready until bootstrap finished and the app password exists", () => {
  writeEnv("WORKSPACE_PUBLIC_HOST=crow.example.ts.net\n");
  assert.throws(() => C.getConfig(), (e) => e.code === "not_ready" && /bootstrap\.sh/.test(e.message));
});

test("reads quoted values through the bundle codec and re-reads on change", async () => {
  writeEnv("WORKSPACE_BOOTSTRAP_DONE=1\nWORKSPACE_PUBLIC_HOST=crow.example.ts.net\nWORKSPACE_BOT_APP_PASSWORD='abc def$x'\nWORKSPACE_ONLYOFFICE_JWT_SECRET=jwt1\n");
  const c = C.getConfig();
  assert.equal(c.user, "crow-bot");
  assert.equal(c.appPassword, "abc def$x");
  assert.equal(c.webBase, "https://crow.example.ts.net:8456");
  assert.equal(Object.isFrozen(c), true);
  await new Promise((r) => setTimeout(r, 20));
  writeEnv("WORKSPACE_BOOTSTRAP_DONE=1\nWORKSPACE_PUBLIC_HOST=crow.example.ts.net\nWORKSPACE_BOT_APP_PASSWORD=second\nWORKSPACE_ONLYOFFICE_JWT_SECRET=jwt1\n");
  assert.equal(C.getConfig().appPassword, "second");
});

test("redact removes every secret occurrence", () => {
  const c = C.getConfig();
  assert.equal(C.redact("x second y jwt1 z second", c), "x [redacted] y [redacted] z [redacted]");
});

test("handler maps WsError and redacts unexpected errors", async () => {
  const { handler, WsError } = await import("../bundles/workspace/server/result.js");
  const r1 = await handler(async () => { throw new WsError("not_found", "nope", { a: 1 }); })({});
  assert.deepEqual(JSON.parse(r1.content[0].text), { success: false, code: "not_found", error: "nope", data: { a: 1 } });
  assert.equal(r1.isError, true);
  const r2 = await handler(async () => { throw new TypeError("boom second"); }, { redactWith: () => C.getConfig() })({});
  assert.equal(JSON.parse(r2.content[0].text).error, "Unexpected error: TypeError: boom [redacted]");
  const r3 = await handler(async () => ({ v: 1 }))({});
  assert.deepEqual(JSON.parse(r3.content[0].text), { success: true, data: { v: 1 } });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- tests/workspace-config.test.js`
Expected: FAIL with `Cannot find module …/bundles/workspace/server/config.js`.

- [ ] **Step 3: Install deps (after the Step 0 yes) and write the scaffold**

Run: `npm install --save-dev fflate@^0.8.3 @xmldom/xmldom@^0.9.12 ical.js@^2.2.1`

`bundles/workspace/package.json`:

```json
{
  "name": "crow-workspace",
  "version": "0.2.0",
  "description": "Crow Workspace MCP server: ws_* tools for Nextcloud files, OOXML documents, calendars and contacts",
  "type": "module",
  "main": "server/index.js",
  "private": true,
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.12.0",
    "@xmldom/xmldom": "^0.9.12",
    "fflate": "^0.8.3",
    "ical.js": "^2.2.1",
    "marked": "<copy the exact range from root package.json>",
    "zod": "^3.24.0"
  }
}
```

(Replace the `marked` placeholder with root `package.json`'s exact range before committing; run `node -e "console.log(require('./package.json').dependencies.marked)"`.)

`bundles/workspace/server/app-root.js`: copy `bundles/browser/server/app-root.js` verbatim (same header comment).

`bundles/workspace/server/result.js`:

```js
/** Crow Workspace tool result envelope (spec §4.1): {success,data} | {success:false,code,error,data?}. */
export class WsError extends Error {
  constructor(code, message, data) { super(message); this.name = "WsError"; this.code = code; this.data = data; }
}
const block = (obj) => [{ type: "text", text: JSON.stringify(obj) }];
export const ok = (data) => ({ content: block({ success: true, data }) });
export const fail = (code, error, data) => ({ content: block({ success: false, code, error, ...(data !== undefined ? { data } : {}) }), isError: true });

/** Wrap a tool body. Unexpected errors never leak a secret: messages pass through redactWith()'s config. */
export function handler(fn, { redactWith } = {}) {
  return async (args) => {
    try { return ok(await fn(args ?? {})); }
    catch (e) {
      if (e instanceof WsError) return fail(e.code, e.message, e.data);
      let msg = String(e?.message ?? e);
      try { const { redact } = await import("./config.js"); msg = redact(msg, redactWith ? redactWith() : null); } catch { msg = "(details withheld)"; }
      return fail("internal", `Unexpected error: ${e?.name || "Error"}: ${msg}`);
    }
  };
}
```

`bundles/workspace/server/config.js`:

```js
/**
 * Workspace toolset configuration, read lazily from <CROW_HOME>/bundles/workspace/.env.
 * Bootstrap writes WORKSPACE_BOT_APP_PASSWORD after the MCP server is registered, so the
 * file is re-parsed whenever its mtime changes. The bundle codec decodes installer quoting.
 * Nothing here is ever logged.
 */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { appImport } from "./app-root.js";
import { WsError } from "./result.js";
const { parseEnvText } = await appImport("servers/gateway/bundle-env-codec.js");

export const BOT_USER = "crow-bot";
const HOST_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;
const crowHome = () => process.env.CROW_HOME || join(homedir(), ".crow");
export const envPath = () => join(crowHome(), "bundles", "workspace", ".env");

let cache = null;
function readEnv() {
  const p = envPath();
  let st;
  try { st = statSync(p); } catch { return {}; }
  if (cache && cache.path === p && cache.mtimeMs === st.mtimeMs && cache.size === st.size) return cache.values;
  const values = parseEnvText(readFileSync(p, "utf8"));
  cache = { path: p, mtimeMs: st.mtimeMs, size: st.size, values };
  return values;
}

export function getConfig() {
  const e = readEnv();
  const host = HOST_RE.test(e.WORKSPACE_PUBLIC_HOST || "") ? e.WORKSPACE_PUBLIC_HOST : "";
  const port = /^[0-9]{2,5}$/.test(e.WORKSPACE_NC_SERVE_PORT || "") ? e.WORKSPACE_NC_SERVE_PORT : "8456";
  const appPassword = e.WORKSPACE_BOT_APP_PASSWORD || "";
  if (e.WORKSPACE_BOOTSTRAP_DONE !== "1" || !appPassword || !host) {
    throw new WsError("not_ready", `Crow Workspace setup has not finished. On the Crow machine run: bash ${join(crowHome(), "bundles", "workspace", "ops", "bootstrap.sh")}`);
  }
  const jwtSecret = e.WORKSPACE_ONLYOFFICE_JWT_SECRET || "";
  return Object.freeze({
    user: BOT_USER, appPassword, jwtSecret, host,
    ncUrl: (process.env.WORKSPACE_NC_INTERNAL_URL || "http://127.0.0.1:3070").replace(/\/+$/, ""),
    ooUrl: (process.env.WORKSPACE_OO_INTERNAL_URL || "http://127.0.0.1:3071").replace(/\/+$/, ""),
    webBase: `https://${host}:${port}`,
    secrets: Object.freeze([appPassword, jwtSecret].filter(Boolean)),
  });
}

/** Replace every secret occurrence; a null cfg tries the live config and tolerates not_ready. */
export function redact(text, cfg) {
  let s = String(text);
  let c = cfg;
  if (!c) { try { c = getConfig(); } catch { c = null; } }
  for (const v of c?.secrets || []) if (v) s = s.split(v).join("[redacted]");
  return s;
}
```

`bundles/workspace/server/server.js`:

```js
/** Crow Workspace MCP server (W2): ws_* tools over Nextcloud + ONLYOFFICE as crow-bot. */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getConfig } from "./config.js";

export const realClock = Object.freeze({ now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) });

export const WORKSPACE_INSTRUCTIONS = [
  "Crow Workspace tools (ws_*): files, .docx/.xlsx/.pptx, calendars and contacts in the household's private Nextcloud, as the 'Crow bot' account.",
  "Guardrails: no full-document replace; inserted text never inherits heading styles; comments are listed completely; batch find/replace is atomic; replace_section works heading-to-heading.",
  "Every write returns version_id: tell the user, and pass it to ws_undo_last_change to revert.",
  "If a result says open_in_editor, ask the user before calling again with if_open:'proceed'.",
].join("\n");

export function createWorkspaceServer({ clock = realClock } = {}) {
  const server = new McpServer({ name: "crow-workspace", version: "0.2.0" }, { instructions: WORKSPACE_INSTRUCTIONS });
  const ctx = Object.freeze({ getConfig, clock });
  void ctx; // tool families register here (Tasks 4-11)
  return server;
}
```

`bundles/workspace/server/index.js`:

```js
#!/usr/bin/env node
/** Crow Workspace MCP server: stdio entry point (args must stay ["server/index.js"]; proxy.js cleanup matches it). */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createWorkspaceServer } from "./server.js";
await createWorkspaceServer().connect(new StdioServerTransport());
```

In `tests/workspace-bundle.test.js`, change the walker so `node_modules` and the binary templates are skipped:

```js
const walk = (dir) => readdirSync(dir).flatMap((n) => {
  if (n === "node_modules") return [];
  const p = join(dir, n);
  return statSync(p).isDirectory() ? walk(p) : (/\.(docx|xlsx|pptx|png)$/i.test(n) ? [] : [p]);
});
```

- [ ] **Step 4: Run the tests**

Run: `npm test -- tests/workspace-config.test.js tests/workspace-bundle.test.js tests/bundle-server-deps.test.js tests/bundle-env-readers.test.js`
Expected: PASS. If `bundle-server-deps` complains, the manifest `server` block is not in yet; that is fine until Task 12. The test only walks bundles whose manifest declares `server`.

- [ ] **Step 5: Commit**

```bash
git add bundles/workspace/package.json bundles/workspace/server/index.js bundles/workspace/server/server.js bundles/workspace/server/app-root.js bundles/workspace/server/result.js bundles/workspace/server/config.js tests/workspace-config.test.js
git commit package.json package-lock.json bundles/workspace/package.json bundles/workspace/server tests/workspace-config.test.js tests/workspace-bundle.test.js -m "feat(workspace): W2 server scaffold — lazy .env config via codec, result envelope, deps"
git show --stat HEAD
```

---
### Task 4: Paths, HTTP, DAV client, the fake Nextcloud, and the Drive read tools

**Files:**
- Create: `bundles/workspace/server/nc/{paths.js,http.js,multistatus.js,dav.js,ocs.js}`, `bundles/workspace/server/ooxml/xml.js` (needed by multistatus), `bundles/workspace/server/tools/{define.js,common.js,drive.js}`
- Create: `tests/helpers/workspace-fake-nextcloud.js`
- Modify: `bundles/workspace/server/server.js` (register drive)
- Test: `tests/workspace-paths.test.js`, `tests/workspace-dav.test.js`, `tests/workspace-drive-read.test.js`

**Interfaces:**
- Produces `nc/paths.js`:
  - `splitPath(p) → string[]`, throws `WsError("bad_path")`
  - `joinPath(segs) → string`
  - `filesUrl(cfg, segs) → string`
  - `hrefToSegs(cfg, href) → string[]`
- Produces `nc/http.js`:
  - `ncFetch(cfg, method, url, {headers, body, timeoutMs}) → Response`
  - `readCapped(res, maxBytes) → Uint8Array`, throws `WsError("too_large")`
  - `httpFail(res, what) → WsError`
- Produces `nc/multistatus.js`: `parseMultistatus(text) → [{href, props: Map<"ns|local", Element>}]`
- Produces `nc/dav.js`:
  - `Entry = {path, name, isFolder, fileId, etag, mtime, modified, size, mime, permissions, ownerId, ownerName, lock, lockType, lockOwner, lockOwnerName, lockTime}`
  - `stat(cfg, ref) → Entry`, `list(cfg, ref) → Entry[]`
  - `resolveRef(cfg, {path?, file_id?}) → string[]`
  - `getFile(cfg, segs, {maxBytes}) → {bytes, etag, mtime}`
  - `putFile(cfg, segs, bytes, {ifMatch?, ifNoneMatch?}) → Response` (does not throw on 412/423)
  - `mkcol`, `move(cfg, fromSegs, toSegs)`, `copy`, `remove(cfg, segs)`
  - `searchNames(cfg, {scopeSegs, like?, eq?, foldersOnly?, limit}) → Entry[]`
  - `normEtag(s)`
- Produces `nc/ocs.js`:
  - `ocsGet(cfg, path) → any`, `ocsPost(cfg, path, form) → any`
  - `displayName(cfg, uid) → string`
  - `myShares(cfg, segs) → []`
  - `createUserShare(cfg, segs, user, permissions) → {id}`
- Produces `tools/define.js`: `defineTools(server, ctx, defs) → string[]` (registered names). Each def is `{name, description, schema, run: async (args, ctx) => data}`.
- Produces `tools/common.js`:
  - `fileRef`, `writeOpts` (zod shapes)
  - `refOf(args) → {path?|file_id?}`
  - `toPublic(entry, cfg) → {path, name, file_id, type, size, modified, mime, locked, web_url}`
- Produces the helper `startFakeNextcloud({ secret }) → { ncUrl, ooUrl, state, calls, addFile(path, bytes, opts), addFolder(path, opts), close() }` in `tests/helpers/workspace-fake-nextcloud.js`.

- [ ] **Step 1: Write the failing tests**

`tests/workspace-paths.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { splitPath, filesUrl, hrefToSegs, joinPath } from "../bundles/workspace/server/nc/paths.js";
const cfg = { ncUrl: "http://127.0.0.1:1", user: "crow-bot" };

test("traversal, URLs, control chars and backslashes are refused before any request", () => {
  for (const bad of ["../x", "a/../b", "a/./b", "a//b", "http://evil/x", "file:/etc/passwd", "a\\b", "a\u0000b", "a\nb", "", "/"]) {
    assert.throws(() => splitPath(bad), (e) => e.code === "bad_path", JSON.stringify(bad));
  }
});

test("leading slash means drive root; trailing slash ignored", () => {
  assert.deepEqual(splitPath("/Shared with Crow/Casa Nueva/"), ["Shared with Crow", "Casa Nueva"]);
});

test("paths: accented + emoji segments round-trip (Review Focus 1)", () => {
  const p = "Shared with Crow/Menú semanal/Recetas – 2026 🌮.xlsx"; // decomposed é
  const segs = splitPath(p);
  assert.equal(segs[1], "Menú semanal"); // NFC
  const url = filesUrl(cfg, segs);
  assert.equal(url, "http://127.0.0.1:1/remote.php/dav/files/crow-bot/Shared%20with%20Crow/Men%C3%BA%20semanal/Recetas%20%E2%80%93%202026%20%F0%9F%8C%AE.xlsx");
  assert.deepEqual(hrefToSegs(cfg, new URL(url).pathname), segs);
  assert.equal(joinPath(segs), "Shared with Crow/Menú semanal/Recetas – 2026 🌮.xlsx");
});

test("a literal %2e%2e segment is a name, re-encoded, never a parent hop", () => {
  const url = filesUrl(cfg, splitPath("a/%2e%2e/b"));
  assert.match(url, /\/a\/%252e%252e\/b$/);
  assert.doesNotMatch(url, /\/\.\.\//);
});

test("hrefToSegs refuses hrefs outside crow-bot's root", () => {
  assert.throws(() => hrefToSegs(cfg, "/remote.php/dav/files/admin/secret.docx"), (e) => e.code === "bad_path");
});
```

`tests/workspace-dav.test.js`:

```js
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startFakeNextcloud } from "./helpers/workspace-fake-nextcloud.js";

let fake, dav, cfg;
before(async () => {
  fake = await startFakeNextcloud({ secret: "jwt" });
  cfg = Object.freeze({ user: "crow-bot", appPassword: "pw", jwtSecret: "jwt", ncUrl: fake.ncUrl, ooUrl: fake.ooUrl, host: "h", webBase: "https://h:8456", secrets: ["pw", "jwt"] });
  dav = await import("../bundles/workspace/server/nc/dav.js");
  fake.addFolder("Shared with Crow/Casa", { owner: "admin" });
  fake.addFile("Shared with Crow/Casa/a.txt", Buffer.from("hola"), { owner: "admin" });
});
after(() => fake.close());

test("stat returns a typed entry", async () => {
  const e = await dav.stat(cfg, { path: "Shared with Crow/Casa/a.txt" });
  assert.equal(e.isFolder, false);
  assert.equal(e.size, 4);
  assert.equal(e.ownerId, "admin");
  assert.match(e.permissions, /W/);
  assert.equal(e.lock, false);
  assert.ok(Number.isInteger(e.fileId) && Number.isInteger(e.mtime));
});

test("an empty 207 (Nextcloud's answer for paths you can't see) is not_found, never success", async () => {
  fake.state.emptyMultistatusFor.add("Shared with Crow/Casa/hidden.txt");
  await assert.rejects(dav.stat(cfg, { path: "Shared with Crow/Casa/hidden.txt" }), (e) => e.code === "not_found");
});

test("getFile caps size before buffering", async () => {
  fake.addFile("Shared with Crow/Casa/big.bin", Buffer.alloc(2048));
  await assert.rejects(dav.getFile(cfg, ["Shared with Crow", "Casa", "big.bin"], { maxBytes: 1024 }), (e) => e.code === "too_large");
});

test("putFile with a stale If-Match returns 412 without throwing", async () => {
  const r = await dav.putFile(cfg, ["Shared with Crow", "Casa", "a.txt"], Buffer.from("x"), { ifMatch: '"stale"' });
  assert.equal(r.status, 412);
});

test("resolveRef by file_id goes through SEARCH", async () => {
  const e = await dav.stat(cfg, { path: "Shared with Crow/Casa/a.txt" });
  assert.deepEqual(await dav.resolveRef(cfg, { file_id: e.fileId }), ["Shared with Crow", "Casa", "a.txt"]);
});

test("the basic-auth header carries crow-bot; no request URL contains the password", () => {
  assert.ok(fake.calls.length > 0);
  for (const c of fake.calls) { assert.equal(c.user, "crow-bot"); assert.doesNotMatch(c.url, /pw/); }
});
```

`tests/workspace-drive-read.test.js`:

```js
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startFakeNextcloud } from "./helpers/workspace-fake-nextcloud.js";
import { connectWorkspace } from "./helpers/workspace-client.js";

let fake, call, close;
before(async () => {
  fake = await startFakeNextcloud({ secret: "jwt" });
  fake.addFolder("Shared with Crow/Casa Nueva", { owner: "admin" });
  fake.addFile("Shared with Crow/Casa Nueva/Menú.xlsx", Buffer.from("PK"), { owner: "admin" });
  fake.addFile("Shared with Crow/Casa Nueva/notes.md", Buffer.from("# hi"), { owner: "admin", lock: { type: 1, owner: "onlyoffice", displayName: "ONLYOFFICE" } });
  ({ call, close } = await connectWorkspace(fake));
});
after(async () => { await close(); fake.close(); });

test("ws_drive_list_folder lists children with lock state", async () => {
  const r = await call("ws_drive_list_folder", { path: "Shared with Crow/Casa Nueva" });
  assert.equal(r.success, true);
  const names = r.data.items.map((i) => i.name).sort();
  assert.deepEqual(names, ["Menú.xlsx", "notes.md"]);
  assert.equal(r.data.items.find((i) => i.name === "notes.md").locked, true);
  assert.match(r.data.items[0].web_url, /^https:\/\/crow\.test:8456\/f\/\d+$/);
});

test("ws_drive_search escapes LIKE wildcards and XML", async () => {
  const r = await call("ws_drive_search", { query: "Men<ú>%" });
  assert.equal(r.success, true);
  assert.match(fake.lastSearchBody(), /Men&lt;ú&gt;\\%/);
});

test("ws_drive_find_folder finds by exact name", async () => {
  const r = await call("ws_drive_find_folder", { name: "Casa Nueva" });
  assert.equal(r.data.found, true);
  assert.equal(r.data.path, "Shared with Crow/Casa Nueva");
});

test("ws_drive_get_metadata and get_permissions", async () => {
  const m = await call("ws_drive_get_metadata", { path: "Shared with Crow/Casa Nueva/notes.md" });
  assert.equal(m.data.owner.id, "admin");
  assert.equal(m.data.lock.type, "editor");
  const p = await call("ws_drive_get_permissions", { path: "Shared with Crow/Casa Nueva/notes.md" });
  assert.equal(p.data.crow_bot.can_write, true);
  assert.match(p.data.note, /cannot see other people's shares/);
});

test("bad paths fail without a request", async () => {
  const before = fake.calls.length;
  const r = await call("ws_drive_list_folder", { path: "../etc" });
  assert.equal(r.code, "bad_path");
  assert.equal(fake.calls.length, before);
});
```

`tests/helpers/workspace-client.js` (shared by all later tool tests):

```js
/** Connect an in-process Workspace MCP server to a fake Nextcloud. Instant clock: sleeps advance a virtual now. */
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function connectWorkspace(fake, { clock } = {}) {
  const home = mkdtempSync(join(tmpdir(), "ws-tools-"));
  mkdirSync(join(home, "bundles", "workspace"), { recursive: true });
  writeFileSync(join(home, "bundles", "workspace", ".env"),
    "WORKSPACE_BOOTSTRAP_DONE=1\nWORKSPACE_PUBLIC_HOST=crow.test\nWORKSPACE_BOT_APP_PASSWORD=pw-secret-123\nWORKSPACE_ONLYOFFICE_JWT_SECRET=jwt\n", { mode: 0o600 });
  process.env.CROW_HOME = home;
  process.env.CROW_DATA_DIR = join(home, "data");
  process.env.WORKSPACE_NC_INTERNAL_URL = fake.ncUrl;
  process.env.WORKSPACE_OO_INTERNAL_URL = fake.ooUrl;
  const virtual = clock || (() => { let t = 1_800_000_000_000; return { now: () => t, sleep: async (ms) => { t += ms; fake.advance?.(ms); } }; })();
  const { createWorkspaceServer } = await import("../../bundles/workspace/server/server.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const server = createWorkspaceServer({ clock: virtual });
  const client = new Client({ name: "ws-test", version: "0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st); await client.connect(ct);
  const call = async (name, args) => {
    const r = await client.callTool({ name, arguments: args });
    return JSON.parse(r.content[0].text);
  };
  return { call, client, clock: virtual, home, close: () => client.close() };
}
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -- tests/workspace-paths.test.js tests/workspace-dav.test.js tests/workspace-drive-read.test.js`
Expected: FAIL (modules missing).

- [ ] **Step 3: Write the fake Nextcloud**

`tests/helpers/workspace-fake-nextcloud.js`:

```js
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
  const touch = (n) => { n.etag = `"e${++etagN}"`; n.mtime = ++clockS; };
  const mkNode = (path, type, opts = {}) => { const n = { path, type, fileId: ++nextId, owner: opts.owner || "crow-bot", perms: opts.perms || (type === "dir" ? "SRGDNVCK" : "SRGDNVW"), lock: opts.lock || null, bytes: Buffer.alloc(0), versions: [], label: null }; touch(n); nodes.set(path, n); return n; };
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
      const n = nodes.get(path); n.lock = { type: 1, owner: "onlyoffice", displayName: "ONLYOFFICE", time: clockS };
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
${isDir ? "<d:resourcetype><d:collection/></d:resourcetype>" : `<d:resourcetype/><d:getcontentlength>${n.bytes.length}</d:getcontentlength><d:getcontenttype>application/octet-stream</d:getcontenttype>`}
<oc:fileid>${n.fileId}</oc:fileid><oc:permissions>${n.perms}</oc:permissions><oc:owner-id>${n.owner}</oc:owner-id><oc:owner-display-name>${n.owner === "admin" ? "Kevin" : n.owner}</oc:owner-display-name>
<nc:lock>${lock ? 1 : ""}</nc:lock>${lock ? `<nc:lock-owner-type>${lock.type}</nc:lock-owner-type><nc:lock-owner>${xmlEsc(lock.owner)}</nc:lock-owner><nc:lock-owner-displayname>${xmlEsc(lock.displayName || lock.owner)}</nc:lock-owner-displayname><nc:lock-time>${lock.time || clockS}</nc:lock-time>` : ""}
</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>`;
  };
  const ms = (inner) => `<?xml version="1.0"?>\n<d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns" xmlns:nc="http://nextcloud.org/ns">${inner}</d:multistatus>`;
  const respFor = (n) => `<d:response><d:href>/remote.php/dav/files/crow-bot/${encPath(n.path)}${n.type === "dir" && n.path ? "/" : ""}</d:href>${propsXml(n)}</d:response>`;
  const childrenOf = (p) => [...nodes.values()].filter((n) => n.path !== p && n.path.startsWith(p ? `${p}/` : "") && !n.path.slice(p ? p.length + 1 : 0).includes("/") && n.path !== "");
  const readBody = (req) => new Promise((r) => { const b = []; req.on("data", (c) => b.push(c)); req.on("end", () => r(Buffer.concat(b))); });
  const pathFromUrl = (u, prefix) => decodeURIComponent(u.slice(prefix.length)).replace(/\/$/, "");
  const lockBlocks = (n) => n.lock && !(n.lock.type === 0 && n.lock.owner === "crow-bot");
  const writeContent = (n, bytes, author = "crow-bot") => { n.bytes = Buffer.from(bytes); touch(n); n.versions.push({ id: n.mtime, bytes: n.bytes, label: null, author }); };

  const nc = http.createServer(async (req, res) => {
    const auth = Buffer.from((req.headers.authorization || "").replace(/^Basic /, ""), "base64").toString();
    const [user, pass] = auth.split(":");
    const body = await readBody(req);
    calls.push({ method: req.method, url: req.url, user, headers: req.headers });
    if (user !== "crow-bot" || !pass) { res.writeHead(401); return res.end(); }
    const send = (code, text = "", headers = {}) => { res.writeHead(code, { "Content-Type": "application/xml; charset=utf-8", ...headers }); res.end(text); };
    const u = req.url;
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
        writeContent(n, body); return send(204, "", { ETag: n.etag });
      }
      if (req.method === "MKCOL") { if (n) return send(405); mkNode(p, "dir"); return send(201); }
      if (req.method === "DELETE") { if (!n) return send(404); if (lockBlocks(n)) return send(423); for (const k of [...nodes.keys()]) if (k === p || k.startsWith(`${p}/`)) { state.trash.push(nodes.get(k)); nodes.delete(k); } return send(204); }
      if (req.method === "MOVE" || req.method === "COPY") {
        if (!n) return send(404);
        const dest = pathFromUrl(new URL(req.headers.destination).pathname, "/remote.php/dav/files/crow-bot/");
        if (nodes.has(dest) && req.headers.overwrite === "F") return send(412);
        if (req.method === "MOVE" && lockBlocks(n)) return send(423);
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
      if (req.method === "MOVE") { if (lockBlocks(n)) return send(423); writeContent(n, v.bytes); return send(201); }
    }
    // ---- principals ----
    const pm = u.match(/^\/remote\.php\/dav\/principals\/users\/([^/]+)\/$/);
    if (pm && req.method === "PROPFIND") { const names = { admin: "Kevin", dayane: "Dayane", "crow-bot": "Crow bot" }; return names[pm[1]] ? send(207, ms(`<d:response><d:href>${u}</d:href><d:propstat><d:prop><d:displayname>${names[pm[1]]}</d:displayname></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`)) : send(404); }
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
    if (api.extraRoutes) { const handled = await api.extraRoutes(req, res, body, { send, ms, calls }); if (handled) return; }
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
```

- [ ] **Step 4: Write `ooxml/xml.js`** (multistatus parsing needs it; the OOXML editors reuse it)

```js
/** XML helpers for DAV responses and OOXML parts. xmldom, no entity expansion, DOCTYPE refused. */
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import { WsError } from "../result.js";

export const NS = Object.freeze({
  d: "DAV:", oc: "http://owncloud.org/ns", nc: "http://nextcloud.org/ns", cal: "urn:ietf:params:xml:ns:caldav", card: "urn:ietf:params:xml:ns:carddav",
  w: "http://schemas.openxmlformats.org/wordprocessingml/2006/main", r: "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
  a: "http://schemas.openxmlformats.org/drawingml/2006/main", p: "http://schemas.openxmlformats.org/presentationml/2006/main",
  s: "http://schemas.openxmlformats.org/spreadsheetml/2006/main", rel: "http://schemas.openxmlformats.org/package/2006/relationships",
  ct: "http://schemas.openxmlformats.org/package/2006/content-types", wp: "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing",
  pic: "http://schemas.openxmlformats.org/drawingml/2006/picture", c: "http://schemas.openxmlformats.org/drawingml/2006/chart",
  w14: "http://schemas.microsoft.com/office/word/2010/wordml", w15: "http://schemas.microsoft.com/office/word/2012/wordml",
  xml: "http://www.w3.org/XML/1998/namespace",
});

export function parseXml(text, name = "xml") {
  if (/<!DOCTYPE/i.test(text)) throw new WsError("malformed_document", `${name}: DOCTYPE declarations are not allowed`);
  let doc;
  try {
    doc = new DOMParser({ onError: (level, msg) => { if (level !== "warning") throw new Error(msg); } }).parseFromString(text, "application/xml");
  } catch { throw new WsError("malformed_document", `${name}: not well-formed XML`); }
  if (!doc?.documentElement) throw new WsError("malformed_document", `${name}: empty XML`);
  doc.__decl = (text.match(/^\s*<\?xml[^?]*\?>/) || [""])[0].trim();
  return doc;
}

/** Serialize, keeping the original XML declaration (xmldom may drop it). */
export function serializeXml(doc) {
  let s = new XMLSerializer().serializeToString(doc);
  if (doc.__decl && !s.startsWith("<?xml")) s = `${doc.__decl}\r\n${s}`;
  return s;
}

export const isEl = (n, ns, local) => n && n.nodeType === 1 && (!ns || n.namespaceURI === ns) && (!local || n.localName === local);
export const kids = (node, ns, local) => Array.from(node?.childNodes || []).filter((n) => isEl(n, ns, local));
export const kid = (node, ns, local) => kids(node, ns, local)[0] || null;
export const all = (node, ns, local) => Array.from(node.getElementsByTagNameNS(ns, local));
export const attr = (node, ns, local) => (node ? (ns ? node.getAttributeNS(ns, local) : node.getAttribute(local)) : "") || "";

/** Create an element; attrs keys may be "w:val" style (namespace from NS by prefix) or plain. */
export function el(doc, ns, qname, attrs = {}, children = []) {
  const e = doc.createElementNS(ns, qname);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    const i = k.indexOf(":");
    if (i > 0) e.setAttributeNS(NS[k.slice(0, i)], k, String(v)); else e.setAttribute(k, String(v));
  }
  for (const c of children) if (c != null) e.appendChild(typeof c === "string" ? doc.createTextNode(c) : c);
  return e;
}

export const xmlEscape = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]));
export function insertAfter(node, ref) { ref.parentNode.insertBefore(node, ref.nextSibling); }
export function removeNode(n) { n?.parentNode?.removeChild(n); }
```

- [ ] **Step 5: Write `nc/paths.js`, `nc/http.js`, `nc/multistatus.js`**

`nc/paths.js`:

```js
/** The ONLY place a Nextcloud files URL is built (spec §7.1). */
import { WsError } from "../result.js";
const BAD = /[\u0000-\u001f\u007f\\]/;

export function splitPath(p) {
  if (typeof p !== "string") throw new WsError("bad_path", "path must be text");
  const s = p.normalize("NFC");
  if (s.length > 4096) throw new WsError("bad_path", "path is too long");
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) throw new WsError("bad_path", "use a path inside Crow's Workspace drive, not a URL");
  const body = s.replace(/^\//, "").replace(/\/$/, "");
  if (!body) throw new WsError("bad_path", "path is empty; use \"\" only where a folder may be the drive root");
  const segs = body.split("/");
  for (const seg of segs) {
    if (seg === "" || seg === "." || seg === "..") throw new WsError("bad_path", "path segments cannot be empty, '.' or '..'");
    if (BAD.test(seg)) throw new WsError("bad_path", "path contains a control character or backslash");
    if (Buffer.byteLength(seg) > 255) throw new WsError("bad_path", "a name in the path is longer than 255 bytes");
  }
  return segs;
}

/** Folder params may be "" (drive root). */
export const splitFolder = (p) => (p === undefined || p === null || p === "" || p === "/" ? [] : splitPath(p));
export const joinPath = (segs) => segs.join("/");
export const filesRoot = (cfg) => `${cfg.ncUrl}/remote.php/dav/files/${encodeURIComponent(cfg.user)}`;
export const filesUrl = (cfg, segs) => `${filesRoot(cfg)}/${segs.map((s) => encodeURIComponent(s)).join("/")}`;

export function hrefToSegs(cfg, href) {
  const prefix = `/remote.php/dav/files/${encodeURIComponent(cfg.user)}`;
  const path = href.startsWith("http") ? new URL(href).pathname : href;
  if (path !== prefix && !path.startsWith(`${prefix}/`)) throw new WsError("bad_path", "the server answered with a path outside Crow's drive");
  return path.slice(prefix.length).split("/").filter(Boolean).map((s) => decodeURIComponent(s).normalize("NFC"));
}
```

`nc/http.js`:

```js
import { WsError } from "../result.js";

export async function ncFetch(cfg, method, url, { headers = {}, body, timeoutMs = 30000 } = {}) {
  try {
    return await fetch(url, {
      method, body, redirect: "manual", signal: AbortSignal.timeout(timeoutMs),
      headers: { Authorization: `Basic ${Buffer.from(`${cfg.user}:${cfg.appPassword}`).toString("base64")}`, "OCS-APIRequest": "true", ...headers },
    });
  } catch (e) {
    throw new WsError("workspace_unreachable", `Crow Workspace did not answer (${e?.name === "TimeoutError" ? "timed out" : "connection failed"}). Is it running?`);
  }
}

export async function readCapped(res, maxBytes) {
  const len = Number(res.headers.get("content-length") || 0);
  if (len > maxBytes) { res.body?.cancel?.(); throw new WsError("too_large", `The file is ${(len / 1048576).toFixed(1)} MB; the limit is ${(maxBytes / 1048576).toFixed(0)} MB`); }
  const chunks = []; let total = 0;
  for await (const c of res.body) { total += c.length; if (total > maxBytes) throw new WsError("too_large", `The file is larger than ${(maxBytes / 1048576).toFixed(0)} MB`); chunks.push(c); }
  return new Uint8Array(Buffer.concat(chunks));
}

export function httpFail(res, what) {
  const map = { 401: ["not_ready", "Crow bot's Workspace app password was rejected; re-run Workspace setup"], 403: ["forbidden", `Crow bot is not allowed to ${what}`], 404: ["not_found", `Not found while trying to ${what}`], 409: ["conflict", `The parent folder does not exist (${what})`], 412: ["changed_concurrently", `Someone changed it first (${what})`], 423: ["locked", `It is locked (${what})`], 507: ["quota", "The Workspace is out of space"] };
  const [code, msg] = map[res.status] || ["workspace_error", `Workspace answered HTTP ${res.status} while trying to ${what}`];
  return new WsError(code, msg);
}
```

`nc/multistatus.js`:

```js
import { parseXml, NS, all, kid, kids } from "../ooxml/xml.js";
/** [{href, props: Map("ns|local" → Element)}] — only 200 propstats are kept. */
export function parseMultistatus(text) {
  const doc = parseXml(text, "multistatus");
  return all(doc, NS.d, "response").map((r) => {
    const props = new Map();
    for (const ps of kids(r, NS.d, "propstat")) {
      if (!/\s200\s/.test(kid(ps, NS.d, "status")?.textContent || "")) continue;
      for (const p of kids(kid(ps, NS.d, "prop"))) props.set(`${p.namespaceURI}|${p.localName}`, p);
    }
    return { href: kid(r, NS.d, "href")?.textContent || "", props };
  });
}
export const propText = (props, ns, local) => props.get(`${ns}|${local}`)?.textContent ?? null;
```

- [ ] **Step 6: Write `nc/dav.js` and `nc/ocs.js`**

`nc/dav.js`:

```js
import { WsError } from "../result.js";
import { NS, xmlEscape, kid } from "../ooxml/xml.js";
import { splitPath, joinPath, filesUrl, hrefToSegs } from "./paths.js";
import { ncFetch, readCapped, httpFail } from "./http.js";
import { parseMultistatus, propText } from "./multistatus.js";

const PROPS = "<d:getetag/><d:getlastmodified/><d:getcontentlength/><d:getcontenttype/><d:resourcetype/><oc:fileid/><oc:permissions/><oc:owner-id/><oc:owner-display-name/><nc:lock/><nc:lock-owner-type/><nc:lock-owner/><nc:lock-owner-displayname/><nc:lock-time/>";
const PROPFIND = `<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns" xmlns:nc="http://nextcloud.org/ns"><d:prop>${PROPS}</d:prop></d:propfind>`;
export const normEtag = (e) => String(e || "").replace(/^W\//, "").replace(/^"|"$/g, "").replace(/&quot;/g, "");

function toEntry(cfg, r) {
  const segs = hrefToSegs(cfg, r.href);
  const t = (ns, l) => propText(r.props, ns, l);
  const isFolder = !!kid(r.props.get(`${NS.d}|resourcetype`), NS.d, "collection");
  const lm = t(NS.d, "getlastmodified");
  const lock = ["1", "true"].includes(String(t(NS.nc, "lock") || "").trim());
  return {
    path: joinPath(segs), name: segs.at(-1) || "", isFolder, fileId: Number(t(NS.oc, "fileid")),
    etag: normEtag(t(NS.d, "getetag")), mtime: lm ? Math.floor(Date.parse(lm) / 1000) : 0, modified: lm ? new Date(lm).toISOString() : null,
    size: Number(t(NS.d, "getcontentlength") || 0), mime: t(NS.d, "getcontenttype") || (isFolder ? "inode/directory" : "application/octet-stream"),
    permissions: t(NS.oc, "permissions") || "", ownerId: t(NS.oc, "owner-id") || "", ownerName: t(NS.oc, "owner-display-name") || "",
    lock, lockType: lock ? Number(t(NS.nc, "lock-owner-type") ?? -1) : null, lockOwner: lock ? t(NS.nc, "lock-owner") : null,
    lockOwnerName: lock ? t(NS.nc, "lock-owner-displayname") : null, lockTime: lock ? Number(t(NS.nc, "lock-time") || 0) : null,
  };
}

async function propfind(cfg, segs, depth) {
  const res = await ncFetch(cfg, "PROPFIND", filesUrl(cfg, segs) + (depth ? "/" : ""), { headers: { Depth: String(depth), "Content-Type": "application/xml; charset=utf-8" }, body: PROPFIND });
  if (res.status === 404) throw new WsError("not_found", `Nothing named "${joinPath(segs)}" in Crow's Workspace drive (it may not be shared with Crow bot).`);
  if (res.status !== 207) throw httpFail(res, "read the folder");
  const entries = parseMultistatus(await res.text()).map((r) => toEntry(cfg, r));
  if (!entries.length) throw new WsError("not_found", `Nothing named "${joinPath(segs)}" in Crow's Workspace drive (it may not be shared with Crow bot).`);
  return entries;
}

export async function resolveRef(cfg, ref = {}) {
  if (ref.file_id !== undefined && ref.file_id !== null) {
    if (!Number.isInteger(ref.file_id) || ref.file_id <= 0) throw new WsError("bad_ref", "file_id must be a positive whole number");
    const hits = await search(cfg, `<d:eq><d:prop><oc:fileid/></d:prop><d:literal>${ref.file_id}</d:literal></d:eq>`, [], 1);
    if (!hits.length) throw new WsError("not_found", `No file with id ${ref.file_id} is shared with Crow bot`);
    return splitPath(hits[0].path);
  }
  if (typeof ref.path !== "string") throw new WsError("bad_ref", "give a path (or file_id)");
  return splitPath(ref.path);
}

export async function stat(cfg, ref) { return (await propfind(cfg, Array.isArray(ref) ? ref : await resolveRef(cfg, ref), 0))[0]; }
export async function list(cfg, segs) { const [self, ...children] = await propfind(cfg, segs, 1); if (!self.isFolder) throw new WsError("not_a_folder", `"${self.path}" is a file, not a folder`); return children; }

export async function getFile(cfg, segs, { maxBytes }) {
  const res = await ncFetch(cfg, "GET", filesUrl(cfg, segs), { timeoutMs: 120000 });
  if (!res.ok) throw httpFail(res, "read the file");
  const bytes = await readCapped(res, maxBytes);
  const lm = res.headers.get("last-modified");
  return { bytes, etag: normEtag(res.headers.get("etag")), mtime: lm ? Math.floor(Date.parse(lm) / 1000) : 0 };
}

export function putFile(cfg, segs, bytes, { ifMatch, ifNoneMatch } = {}) {
  const headers = { "Content-Type": "application/octet-stream" };
  if (ifMatch) headers["If-Match"] = `"${normEtag(ifMatch)}"`;
  if (ifNoneMatch) headers["If-None-Match"] = ifNoneMatch;
  return ncFetch(cfg, "PUT", filesUrl(cfg, segs), { headers, body: bytes, timeoutMs: 120000 });
}

export async function mkcol(cfg, segs) { const r = await ncFetch(cfg, "MKCOL", filesUrl(cfg, segs)); if (r.status === 405) return false; if (r.status !== 201) throw httpFail(r, "create the folder"); return true; }
async function moveOrCopy(cfg, method, from, to) {
  const r = await ncFetch(cfg, method, filesUrl(cfg, from), { headers: { Destination: filesUrl(cfg, to), Overwrite: "F" } });
  if (r.status === 412) throw new WsError("exists", `"${joinPath(to)}" already exists`);
  if (![201, 204].includes(r.status)) throw httpFail(r, method === "MOVE" ? "move it" : "copy it");
}
export const move = (cfg, from, to) => moveOrCopy(cfg, "MOVE", from, to);
export const copy = (cfg, from, to) => moveOrCopy(cfg, "COPY", from, to);
export async function remove(cfg, segs) { const r = await ncFetch(cfg, "DELETE", filesUrl(cfg, segs)); if (r.status !== 204) throw httpFail(r, "move it to the trash"); }

async function search(cfg, where, scopeSegs, limit, foldersOnly = false) {
  const scope = `/files/${cfg.user}${scopeSegs.length ? `/${scopeSegs.map(xmlEscape).join("/")}` : ""}`;
  const w = foldersOnly ? `<d:and>${where}<d:is-collection/></d:and>` : where;
  const body = `<?xml version="1.0" encoding="UTF-8"?><d:searchrequest xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns" xmlns:nc="http://nextcloud.org/ns"><d:basicsearch><d:select><d:prop>${PROPS}</d:prop></d:select><d:from><d:scope><d:href>${scope}</d:href><d:depth>infinity</d:depth></d:scope></d:from><d:where>${w}</d:where><d:orderby><d:order><d:prop><d:getlastmodified/></d:prop><d:descending/></d:order></d:orderby><d:limit><d:nresults>${limit}</d:nresults></d:limit></d:basicsearch></d:searchrequest>`;
  const res = await ncFetch(cfg, "SEARCH", `${cfg.ncUrl}/remote.php/dav/`, { headers: { "Content-Type": "text/xml; charset=utf-8" }, body });
  if (res.status !== 207) throw httpFail(res, "search");
  return parseMultistatus(await res.text()).map((r) => toEntry(cfg, r)).filter((e) => e.path);
}

export function searchNames(cfg, { scopeSegs = [], like, eq, foldersOnly = false, limit = 20 }) {
  if (like !== undefined) {
    const lit = xmlEscape(String(like).normalize("NFC").replace(/[\\%_]/g, (c) => `\\${c}`));
    return search(cfg, `<d:like><d:prop><d:displayname/></d:prop><d:literal>%${lit}%</d:literal></d:like>`, scopeSegs, limit, foldersOnly);
  }
  return search(cfg, `<d:eq><d:prop><d:displayname/></d:prop><d:literal>${xmlEscape(String(eq).normalize("NFC"))}</d:literal></d:eq>`, scopeSegs, limit, foldersOnly);
}
```

`nc/ocs.js`:

```js
import { WsError } from "../result.js";
import { ncFetch, httpFail } from "./http.js";
import { parseMultistatus, propText } from "./multistatus.js";
import { NS } from "../ooxml/xml.js";
import { joinPath } from "./paths.js";

export async function ocsGet(cfg, path) {
  const r = await ncFetch(cfg, "GET", `${cfg.ncUrl}${path}${path.includes("?") ? "&" : "?"}format=json`, { headers: { Accept: "application/json" } });
  if (!r.ok) throw httpFail(r, "ask Workspace");
  const j = await r.json(); return j?.ocs ? j.ocs.data : j;
}
export async function ocsPost(cfg, path, form) {
  const r = await ncFetch(cfg, "POST", `${cfg.ncUrl}${path}?format=json`, { headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form).toString() });
  const j = await r.json().catch(() => null);
  if (!r.ok || (j?.ocs?.meta && j.ocs.meta.status !== "ok")) throw new WsError("share_failed", j?.ocs?.meta?.message || `Workspace refused (HTTP ${r.status})`);
  return j.ocs.data;
}
const nameCache = new Map();
export async function displayName(cfg, uid) {
  if (nameCache.has(uid)) return nameCache.get(uid);
  const r = await ncFetch(cfg, "PROPFIND", `${cfg.ncUrl}/remote.php/dav/principals/users/${encodeURIComponent(uid)}/`, { headers: { Depth: "0", "Content-Type": "application/xml" }, body: `<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:displayname/></d:prop></d:propfind>` });
  const name = r.status === 207 ? (propText(parseMultistatus(await r.text())[0]?.props || new Map(), NS.d, "displayname") || uid) : uid;
  nameCache.set(uid, name); return name;
}
export const myShares = (cfg, segs) => ocsGet(cfg, `/ocs/v2.php/apps/files_sharing/api/v1/shares?path=${encodeURIComponent(`/${joinPath(segs)}`)}`);
export const createUserShare = (cfg, segs, user, permissions) => ocsPost(cfg, "/ocs/v2.php/apps/files_sharing/api/v1/shares", { path: `/${joinPath(segs)}`, shareType: "0", shareWith: user, permissions: String(permissions) });
```

- [ ] **Step 7: Write `tools/define.js`, `tools/common.js`, `tools/drive.js` (read half), and register**

`tools/define.js`:

```js
import { handler } from "../result.js";
/** Register tool defs; returns the names (the surface test compares them to spec §4). */
export function defineTools(server, ctx, defs) {
  for (const d of defs) {
    server.tool(d.name, d.description, d.schema, handler((args) => d.run(args, ctx), { redactWith: () => { try { return ctx.getConfig(); } catch { return null; } } }));
  }
  return defs.map((d) => d.name);
}
```

`tools/common.js`:

```js
import { z } from "zod";
import { WsError } from "../result.js";
export const fileRef = {
  path: z.string().max(4096).optional().describe("Path inside Crow's Workspace drive, e.g. 'Shared with Crow/Casa Nueva/Menu.xlsx'"),
  file_id: z.number().int().positive().optional().describe("Nextcloud file id (alternative to path)"),
};
export const writeOpts = {
  wait_s: z.number().int().min(0).max(30).optional().describe("Seconds to wait if the file is open in the editor (default 30)"),
  if_open: z.enum(["wait", "proceed"]).optional().describe("'proceed' only after the user agreed: closes the editor session (their typing is saved first), then writes"),
};
export function refOf(args) {
  if (args.file_id !== undefined) return { file_id: args.file_id };
  if (typeof args.path === "string") return { path: args.path };
  throw new WsError("bad_ref", "give a path (or file_id)");
}
export const writeOptsOf = (args) => ({ waitS: args.wait_s ?? 30, ifOpen: args.if_open ?? "wait" });
export function toPublic(e, cfg) {
  return { path: e.path, name: e.name, file_id: e.fileId, type: e.isFolder ? "folder" : "file", size: e.size, modified: e.modified, mime: e.mime, locked: e.lock, web_url: `${cfg.webBase}/f/${e.fileId}` };
}
```

`tools/drive.js` (read tools now; Task 5 appends the write tools to the same `defs` array):

```js
import { z } from "zod";
import { fileRef, refOf, toPublic } from "./common.js";
import { defineTools } from "./define.js";
import { stat, list, resolveRef, searchNames } from "../nc/dav.js";
import { splitFolder } from "../nc/paths.js";
import { myShares } from "../nc/ocs.js";
import { lockInfo } from "../nc/locks.js";

const PERMS = { R: "can_share", W: "can_write", D: "can_delete", C: "can_create", K: "can_create", N: "can_rename", V: "can_move" };

export const driveReadDefs = [
  { name: "ws_drive_list_folder", description: "List a folder in Crow's Workspace drive (\"\" = top level). Returns name, path, file_id, type, size, modified, locked.",
    schema: { path: z.string().max(4096).optional().default("") },
    run: async ({ path }, { getConfig }) => { const cfg = getConfig(); const items = await list(cfg, splitFolder(path)); return { path, items: items.map((e) => toPublic(e, cfg)) }; } },
  { name: "ws_drive_find_folder", description: "Find a folder by exact name (optionally under parent). Returns found, path, file_id.",
    schema: { name: z.string().min(1).max(255), parent: z.string().max(4096).optional().default("") },
    run: async ({ name, parent }, { getConfig }) => { const cfg = getConfig(); const hits = await searchNames(cfg, { scopeSegs: splitFolder(parent), eq: name, foldersOnly: true, limit: 5 }); return hits.length ? { found: true, path: hits[0].path, file_id: hits[0].fileId } : { found: false }; } },
  { name: "ws_drive_get_metadata", description: "Size, type, modified time, owner, Crow bot's permissions, lock state and web link of a file or folder.",
    schema: { ...fileRef },
    run: async (args, { getConfig }) => { const cfg = getConfig(); const e = await stat(cfg, refOf(args)); const l = lockInfo(e); return { ...toPublic(e, cfg), etag: e.etag, owner: { id: e.ownerId, name: e.ownerName }, permissions: e.permissions, lock: l ? { type: l.type, by: l.ownerName, since: l.since } : null }; } },
  { name: "ws_drive_get_permissions", description: "Read-only: who owns this, what Crow bot may do with it, and shares Crow bot made.",
    schema: { ...fileRef },
    run: async (args, { getConfig }) => {
      const cfg = getConfig(); const e = await stat(cfg, refOf(args));
      const crow_bot = Object.fromEntries(Object.values(PERMS).map((k) => [k, false]));
      for (const ch of e.permissions) if (PERMS[ch]) crow_bot[PERMS[ch]] = true;
      const shares = (await myShares(cfg, await resolveRef(cfg, refOf(args))).catch(() => [])).map((s) => ({ with: s.share_with, permissions: s.permissions }));
      return { path: e.path, owner: { id: e.ownerId, name: e.ownerName }, crow_bot, shares_by_crow_bot: shares, note: "Crow bot cannot see other people's shares of this item." };
    } },
  { name: "ws_drive_search", description: "Search file and folder names in Crow's Workspace drive (newest first).",
    schema: { query: z.string().min(1).max(200), max_results: z.number().int().min(1).max(100).optional().default(20) },
    run: async ({ query, max_results }, { getConfig }) => { const cfg = getConfig(); return { results: (await searchNames(cfg, { like: query, limit: max_results })).map((e) => toPublic(e, cfg)) }; } },
];

export function registerDrive(server, ctx, extraDefs = []) { return defineTools(server, ctx, [...driveReadDefs, ...extraDefs]); }
```

`nc/locks.js` (minimal now: `lockInfo`; Task 5 adds `classifyLock`):

```js
export function lockInfo(e) {
  if (!e.lock) return null;
  return { type: e.lockType === 1 ? "editor" : "person", ownerType: e.lockType, owner: e.lockOwner, ownerName: e.lockOwnerName || e.lockOwner, since: e.lockTime ? new Date(e.lockTime * 1000).toISOString() : null };
}
```

In `server.js`, replace `void ctx;` with:

```js
  const names = [];
  names.push(...registerDrive(server, ctx));
  server.__wsToolNames = names;
```

and add `import { registerDrive } from "./tools/drive.js";` at the top.

- [ ] **Step 8: Run the tests**

Run: `npm test -- tests/workspace-paths.test.js tests/workspace-dav.test.js tests/workspace-drive-read.test.js`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add bundles/workspace/server/nc bundles/workspace/server/ooxml/xml.js bundles/workspace/server/tools tests/helpers/workspace-fake-nextcloud.js tests/helpers/workspace-client.js tests/workspace-paths.test.js tests/workspace-dav.test.js tests/workspace-drive-read.test.js
git commit bundles/workspace/server tests/helpers/workspace-fake-nextcloud.js tests/helpers/workspace-client.js tests/workspace-paths.test.js tests/workspace-dav.test.js tests/workspace-drive-read.test.js -m "feat(workspace): DAV client, path guard, fake Nextcloud, Drive read tools"
git show --stat HEAD
```

---
### Task 5: Write protocol, lock classification, ONLYOFFICE commands, versions, undo + the Drive write tools

**Files:**
- Create: `bundles/workspace/server/nc/{versions.js,onlyoffice.js}`, `bundles/workspace/server/write-protocol.js`, `bundles/workspace/server/tools/undo.js`
- Modify: `bundles/workspace/server/nc/locks.js` (add `classifyLock`), `bundles/workspace/server/tools/drive.js` (write defs), `bundles/workspace/server/server.js`
- Test: `tests/workspace-write-protocol.test.js`, `tests/workspace-drive-write.test.js`

**Interfaces:**
- Consumes (Task 4): `stat`, `resolveRef`, `getFile`, `putFile`, `remove`, `normEtag`, `ocsGet`, `displayName`, `ncFetch`, `readCapped`, `httpFail`, `lockInfo`.
- Produces `nc/versions.js`:
  - `listVersions(cfg, fileId) → [{versionId:string, modified, size, label, author}]` (newest first)
  - `labelVersion(cfg, fileId, versionId, label)`
  - `restoreVersion(cfg, fileId, versionId)`
- Produces `nc/onlyoffice.js`:
  - `signJwt(payload, secret)`, `ooCommand(cfg, payload)`
  - `docSession(cfg, fileId) → {key, live, users, uids}`
  - `dropUsers(cfg, key, users)`
  - `exportAs(cfg, fileId, ext, maxBytes) → Uint8Array`
- Produces `nc/locks.js`: `classifyLock(cfg, entry) → {code, message, data, key?, users?}`
- Produces `write-protocol.js`:
  - `withFileWrite(cfg, ref, mutate, {waitS, ifOpen, label, clock}) → result`. `mutate(bytes, entry) → {bytes, changed, summary, data?}`.
  - `withFileRestore(cfg, ref, versionId, opts)`
  - `createFile(cfg, folderSegs, name, bytes, {label, summary}) → result`
  - `undoFileChange(cfg, ref, versionId, opts)`
  - `encodeVersionId({f,b,a})`, `decodeVersionId(id)`
  - `MAX_EDIT_BYTES`
  - result = `{path, file_id, changed, version_id, version_label, ...data}`
- Produces `tools/undo.js`: `registerUndo(server, ctx)`. Task 10 extends `undoDispatch` for `j1.` ids.

- [ ] **Step 1: Write the failing protocol tests**

`tests/workspace-write-protocol.test.js`:

```js
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startFakeNextcloud } from "./helpers/workspace-fake-nextcloud.js";

let fake, W, cfg, clock;
const text = (b) => Buffer.from(b).toString();
const appendMut = (s) => async (bytes) => ({ bytes: Buffer.from(text(bytes) + s), changed: 1, summary: `append ${s}` });
before(async () => {
  fake = await startFakeNextcloud({ secret: "jwt" });
  cfg = Object.freeze({ user: "crow-bot", appPassword: "pw", jwtSecret: "jwt", ncUrl: fake.ncUrl, ooUrl: fake.ooUrl, host: "h", webBase: "https://h:8456", secrets: ["pw", "jwt"] });
  W = await import("../bundles/workspace/server/write-protocol.js");
  let t = 0; clock = { now: () => t, sleep: async (ms) => { t += ms; fake.advance(ms); } };
});
after(() => fake.close());

test("unlocked write: one PUT, two labels, decodable version_id", async () => {
  const n = fake.addFile("S/a.txt", Buffer.from("x"), { owner: "admin" });
  const before = n.mtime;
  const r = await W.withFileWrite(cfg, { path: "S/a.txt" }, appendMut("y"), { clock });
  assert.equal(text(fake.node("S/a.txt").bytes), "xy");
  assert.equal(r.changed, 1);
  const v = W.decodeVersionId(r.version_id);
  assert.equal(v.f, n.fileId); assert.equal(v.b, String(before));
  const labels = fake.versionsOf("S/a.txt").map((x) => x.label);
  assert.ok(labels.includes("Before Crow: append y") && labels.includes("Crow: append y"));
});

test("zero changes → no PUT, no version", async () => {
  fake.addFile("S/z.txt", Buffer.from("x"));
  const puts = () => fake.calls.filter((c) => c.method === "PUT").length;
  const p0 = puts();
  const r = await W.withFileWrite(cfg, { path: "S/z.txt" }, async () => ({ changed: 0 }), { clock });
  assert.equal(r.version_id, null); assert.equal(puts(), p0);
});

test("editor lock clears inside 30 s → waits, then writes", async () => {
  fake.addFile("S/w.docx", Buffer.from("d"));
  fake.openInEditor("S/w.docx", ["admin"]);
  fake.state.pendingReleases.push({ at: fake.state.now + 6000, fn: () => { fake.node("S/w.docx").lock = null; } });
  const r = await W.withFileWrite(cfg, { path: "S/w.docx" }, appendMut("!"), { clock });
  assert.equal(r.changed, 1);
});

test("still open after 30 s → open_in_editor naming the person, can_proceed", async () => {
  fake.addFile("S/o.docx", Buffer.from("d"));
  fake.openInEditor("S/o.docx", ["dayane"]);
  await assert.rejects(W.withFileWrite(cfg, { path: "S/o.docx" }, appendMut("!"), { clock }),
    (e) => e.code === "open_in_editor" && e.data.open_by[0] === "Dayane" && e.data.can_proceed === true && /go ahead anyway/.test(e.message));
});

test("proceed → drop → editor saves its typing first → bot change on top", async () => {
  fake.addFile("S/p.docx", Buffer.from("base"));
  fake.openInEditor("S/p.docx", ["admin"], { releaseAfterMs: 5000, typed: Buffer.from("base+kevin") });
  const r = await W.withFileWrite(cfg, { path: "S/p.docx" }, appendMut("+bot"), { clock, ifOpen: "proceed" });
  assert.equal(text(fake.node("S/p.docx").bytes), "base+kevin+bot");
  assert.ok(fake.calls.some((c) => c.method === "OO" && c.body?.c === "drop" && c.body.users[0] === "ocinst_admin"));
  assert.ok(r.version_id);
});

test("drop that never releases → could_not_close_editor", async () => {
  fake.addFile("S/n.docx", Buffer.from("d"));
  fake.openInEditor("S/n.docx", ["admin"], { releaseAfterMs: 10 ** 9 });
  await assert.rejects(W.withFileWrite(cfg, { path: "S/n.docx" }, appendMut("!"), { clock, ifOpen: "proceed" }), (e) => e.code === "could_not_close_editor");
});

test("a person's manual lock is never overridden, even with proceed", async () => {
  fake.addFile("S/m.docx", Buffer.from("d"), { lock: { type: 0, owner: "dayane", displayName: "Dayane" } });
  await assert.rejects(W.withFileWrite(cfg, { path: "S/m.docx" }, appendMut("!"), { clock, ifOpen: "proceed", waitS: 0 }),
    (e) => e.code === "locked_by_person" && e.data.can_proceed === false);
  assert.ok(!fake.calls.some((c) => c.method === "OO" && c.body?.c === "drop" && c.body.key === "k" + fake.node("S/m.docx").fileId));
});

test("editor lock with no live session → stale_editor_lock, no drop", async () => {
  fake.addFile("S/s.docx", Buffer.from("d"), { owner: "admin", lock: { type: 1, owner: "onlyoffice", displayName: "ONLYOFFICE" } });
  await assert.rejects(W.withFileWrite(cfg, { path: "S/s.docx" }, appendMut("!"), { clock, waitS: 0, ifOpen: "proceed" }),
    (e) => e.code === "stale_editor_lock" && /Unlock/.test(e.message));
});

test("412 once → re-read and re-apply; twice → changed_concurrently", async () => {
  fake.addFile("S/c.txt", Buffer.from("1"));
  let n = 0;
  const r = await W.withFileWrite(cfg, { path: "S/c.txt" }, async (bytes) => { if (n++ === 0) { fake.node("S/c.txt").etag = '"bumped"'; } return { bytes: Buffer.from(text(bytes) + "2"), changed: 1, summary: "x" }; }, { clock });
  assert.equal(text(fake.node("S/c.txt").bytes), "12"); assert.ok(r.version_id);
  await assert.rejects(W.withFileWrite(cfg, { path: "S/c.txt" }, async (bytes) => { fake.node("S/c.txt").etag = `"b${Math.random()}"`; return { bytes, changed: 1, summary: "x" }; }, { clock }), (e) => e.code === "changed_concurrently");
});

test("concurrent writes to one file serialize and both apply (Review Focus 2)", async () => {
  fake.addFile("S/k.txt", Buffer.from(""));
  const v0 = fake.versionsOf("S/k.txt").length;
  const t0 = clock.now();
  const [a, b] = await Promise.all([
    W.withFileWrite(cfg, { path: "S/k.txt" }, appendMut("A"), { clock }),
    W.withFileWrite(cfg, { path: "S/k.txt" }, appendMut("B"), { clock }),
  ]);
  const final = text(fake.node("S/k.txt").bytes);
  assert.ok(final === "AB" || final === "BA", final);
  assert.equal(fake.versionsOf("S/k.txt").length, v0 + 2);
  assert.ok(clock.now() - t0 >= 1100, "second write waited ≥ 1.1 s");
  assert.notEqual(a.version_id, b.version_id);
});

test("undo restores the before-version; refuses once the file changed since", async () => {
  fake.addFile("S/u.txt", Buffer.from("orig"));
  const r = await W.withFileWrite(cfg, { path: "S/u.txt" }, appendMut("-bot"), { clock });
  const u = await W.undoFileChange(cfg, { path: "S/u.txt" }, r.version_id, { clock });
  assert.equal(text(fake.node("S/u.txt").bytes), "orig");
  assert.ok(u.version_id, "undo is itself undoable");
  const r2 = await W.withFileWrite(cfg, { path: "S/u.txt" }, appendMut("-again"), { clock });
  await W.withFileWrite(cfg, { path: "S/u.txt" }, appendMut("-human"), { clock });
  await assert.rejects(W.undoFileChange(cfg, { path: "S/u.txt" }, r2.version_id, { clock }), (e) => e.code === "changed_since");
});

test("undo of a created file moves it to the trash; a forged version_id is refused", async () => {
  fake.addFolder("S/new");
  const c = await W.createFile(cfg, ["S", "new"], "made.txt", Buffer.from("hi"), { label: "Crow", summary: "create" });
  await W.undoFileChange(cfg, { path: "S/new/made.txt" }, c.version_id, { clock });
  assert.equal(fake.node("S/new/made.txt"), undefined);
  assert.throws(() => W.decodeVersionId("v1.notbase64!!"), (e) => e.code === "bad_version_id");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- tests/workspace-write-protocol.test.js`
Expected: FAIL (module missing).

- [ ] **Step 3: Write `nc/versions.js` and `nc/onlyoffice.js`**

`nc/versions.js`:

```js
import { WsError } from "../result.js";
import { NS, xmlEscape } from "../ooxml/xml.js";
import { ncFetch, httpFail } from "./http.js";
import { parseMultistatus, propText } from "./multistatus.js";

const base = (cfg, fileId) => `${cfg.ncUrl}/remote.php/dav/versions/${encodeURIComponent(cfg.user)}/versions/${Number(fileId)}`;
const vid = (s) => { if (!/^\d{1,12}$/.test(String(s))) throw new WsError("bad_version_id", "not a Workspace version id"); return String(s); };

export async function listVersions(cfg, fileId) {
  const r = await ncFetch(cfg, "PROPFIND", `${base(cfg, fileId)}/`, { headers: { Depth: "1", "Content-Type": "application/xml" }, body: `<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:nc="http://nextcloud.org/ns"><d:prop><d:getlastmodified/><d:getcontentlength/><nc:version-label/><nc:version-author/></d:prop></d:propfind>` });
  if (r.status !== 207) throw httpFail(r, "list versions");
  return parseMultistatus(await r.text())
    .map((x) => ({ versionId: (x.href.match(/\/versions\/\d+\/(\d+)\/?$/) || [])[1], props: x.props }))
    .filter((x) => x.versionId)
    .map(({ versionId, props }) => ({ versionId, modified: new Date(Number(versionId) * 1000).toISOString(), size: Number(propText(props, NS.d, "getcontentlength") || 0), label: propText(props, NS.nc, "version-label") || "", author: propText(props, NS.nc, "version-author") || "" }))
    .sort((a, b) => Number(b.versionId) - Number(a.versionId));
}

export async function labelVersion(cfg, fileId, versionId, label) {
  const r = await ncFetch(cfg, "PROPPATCH", `${base(cfg, fileId)}/${vid(versionId)}`, { headers: { "Content-Type": "application/xml" }, body: `<?xml version="1.0"?><d:propertyupdate xmlns:d="DAV:" xmlns:nc="http://nextcloud.org/ns"><d:set><d:prop><nc:version-label>${xmlEscape(label)}</nc:version-label></d:prop></d:set></d:propertyupdate>` });
  if (r.status !== 207) throw httpFail(r, "label the version");
}

export async function restoreVersion(cfg, fileId, versionId) {
  return ncFetch(cfg, "MOVE", `${base(cfg, fileId)}/${vid(versionId)}`, { headers: { Destination: `${cfg.ncUrl}/remote.php/dav/versions/${encodeURIComponent(cfg.user)}/restore/target` } });
}
```

`nc/onlyoffice.js`:

```js
import { createHmac } from "node:crypto";
import { WsError } from "../result.js";
import { ocsGet } from "./ocs.js";
import { ncFetch, readCapped, httpFail } from "./http.js";

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
export function signJwt(payload, secret) { const h = `${b64({ alg: "HS256", typ: "JWT" })}.${b64(payload)}`; return `${h}.${createHmac("sha256", secret).update(h).digest("base64url")}`; }

export async function ooCommand(cfg, payload) {
  if (!cfg.jwtSecret) throw new WsError("not_ready", "The document editor's secret is missing from Workspace setup");
  const token = signJwt(payload, cfg.jwtSecret);
  let r;
  try { r = await fetch(`${cfg.ooUrl}/coauthoring/CommandService.ashx`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ ...payload, token }), signal: AbortSignal.timeout(15000) }); }
  catch { throw new WsError("editor_unreachable", "The document editor did not answer"); }
  if (!r.ok) throw new WsError("editor_unreachable", `The document editor answered HTTP ${r.status}`);
  return r.json();
}

export async function docSession(cfg, fileId) {
  const c = await ocsGet(cfg, `/ocs/v2.php/apps/onlyoffice/api/v1/config/${Number(fileId)}`);
  const key = c?.document?.key;
  if (!key) throw new WsError("editor_unreachable", "Could not read the editor's document key");
  const prefix = String(c?.editorConfig?.user?.id || "").slice(0, -(`_${cfg.user}`.length));
  const info = await ooCommand(cfg, { c: "info", key });
  const users = Array.isArray(info.users) ? info.users.map(String) : [];
  return { key, live: info.error === 0, users, uids: users.map((u) => (prefix && u.startsWith(`${prefix}_`) ? u.slice(prefix.length + 1) : u)) };
}

export async function dropUsers(cfg, key, users) {
  const r = await ooCommand(cfg, { c: "drop", key, users });
  if (r.error !== 0) throw new WsError("could_not_close_editor", "The editor would not close the session; try again later.");
}

export async function exportAs(cfg, fileId, ext, maxBytes) {
  const r = await ncFetch(cfg, "GET", `${cfg.ncUrl}/apps/onlyoffice/downloadas?fileId=${Number(fileId)}&toExtension=${encodeURIComponent(ext)}`, { timeoutMs: 180000 });
  if (!r.ok) throw httpFail(r, `convert it to ${ext}`);
  return readCapped(r, maxBytes);
}
```

- [ ] **Step 4: Add `classifyLock` to `nc/locks.js`**

```js
import { docSession } from "./onlyoffice.js";
import { displayName } from "./ocs.js";

const names = (xs) => (xs.length <= 1 ? xs[0] || "Someone" : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);

export async function classifyLock(cfg, e) {
  const l = lockInfo(e);
  if (l.ownerType !== 1) {
    return { code: "locked_by_person", message: `${l.ownerName} locked "${e.name}" in Workspace. Ask them to unlock it, or try later.`, data: { open_by: [l.ownerName], since: l.since, lock_type: "person", can_proceed: false } };
  }
  if (l.owner !== "onlyoffice") {
    return { code: "open_in_editor", message: `"${e.name}" is open in another Workspace editor (${l.ownerName}). Try again after it is closed.`, data: { open_by: [], since: l.since, lock_type: "editor", can_proceed: false } };
  }
  const s = await docSession(cfg, e.fileId);
  if (!s.live) {
    return { code: "stale_editor_lock", message: `"${e.name}" is still marked as open in the editor, but nobody is editing it. Ask ${e.ownerName || "the file's owner"} to open the file's ⋯ menu in Workspace and choose Unlock, then try again.`, data: { since: l.since, lock_type: "editor", can_proceed: false, owner: e.ownerName } };
  }
  const who = await Promise.all(s.uids.map((u) => displayName(cfg, u)));
  return {
    code: "open_in_editor", key: s.key, users: s.users,
    message: `${names(who)} ${who.length > 1 ? "have" : "has"} "${e.name}" open in the editor. Ask the user: go ahead anyway (their editor reloads; their typing is saved first) or try later?`,
    data: { open_by: who, since: l.since, lock_type: "editor", can_proceed: true },
  };
}
```

- [ ] **Step 5: Write `write-protocol.js`**

```js
/**
 * The ONE path that changes a Workspace file (spec §5). Lock check → wait → optional editor drop →
 * read → mutate → If-Match PUT (one retry) → label versions → version_id. Restores and creations
 * share the same guard. Writes to one file are serialized in-process and spaced ≥ 1.1 s.
 */
import { WsError } from "./result.js";
import { stat, resolveRef, getFile, putFile, remove, normEtag } from "./nc/dav.js";
import { httpFail } from "./nc/http.js";
import { classifyLock } from "./nc/locks.js";
import { dropUsers } from "./nc/onlyoffice.js";
import { listVersions, labelVersion, restoreVersion } from "./nc/versions.js";
import { joinPath } from "./nc/paths.js";

export const MAX_EDIT_BYTES = 50 * 1024 * 1024;
export const WRITE_SPACING_MS = 1100; // R-COLLIDE (Task 1 may raise it)
const queues = new Map();
const lastWrite = new Map();
const clip = (s, n) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s));

function serialized(key, fn) {
  const prev = queues.get(key) || Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  const tail = run.catch(() => {});
  queues.set(key, tail);
  tail.then(() => { if (queues.get(key) === tail) queues.delete(key); });
  return run;
}

export function encodeVersionId({ f, b, a }) { return `v1.${Buffer.from(JSON.stringify({ f, b: String(b), a: normEtag(a) })).toString("base64url")}`; }
export function decodeVersionId(id) {
  const bad = () => new WsError("bad_version_id", "That version_id was not issued by the Workspace tools.");
  if (typeof id !== "string" || !id.startsWith("v1.") || !/^[A-Za-z0-9_-]+$/.test(id.slice(3))) throw bad();
  let o; try { o = JSON.parse(Buffer.from(id.slice(3), "base64url").toString("utf8")); } catch { throw bad(); }
  if (!Number.isInteger(o?.f) || !/^\d{1,12}$/.test(String(o?.b)) || typeof o?.a !== "string") throw bad();
  return o;
}

async function waitUnlocked(cfg, segs, waitS, clock) {
  const deadline = clock.now() + waitS * 1000;
  for (;;) {
    const e = await stat(cfg, segs);
    if (!e.lock || clock.now() >= deadline) return e;
    await clock.sleep(Math.min(2000, deadline - clock.now()));
  }
}

async function settleLock(cfg, segs, { waitS, ifOpen, clock }) {
  let e = await waitUnlocked(cfg, segs, waitS, clock);
  if (!e.lock) return e;
  const c = await classifyLock(cfg, e);
  if (ifOpen !== "proceed" || !c.data.can_proceed) throw new WsError(c.code, c.message, c.data);
  await dropUsers(cfg, c.key, c.users);
  e = await waitUnlocked(cfg, segs, 30, clock);
  if (e.lock) throw new WsError("could_not_close_editor", "The editor did not close within 30 seconds. Try again later.", { open_by: c.data.open_by });
  return e;
}

async function spacing(fileId, clock) {
  const gap = clock.now() - (lastWrite.get(fileId) ?? -Infinity);
  if (gap < WRITE_SPACING_MS) await clock.sleep(WRITE_SPACING_MS - gap);
}

async function guard(cfg, ref, opts) {
  const segs = Array.isArray(ref) ? ref : await resolveRef(cfg, ref);
  const e0 = await stat(cfg, segs);
  if (e0.isFolder) throw new WsError("not_a_file", `"${e0.path}" is a folder`);
  if (!e0.permissions.includes("W")) throw new WsError("read_only", `Crow bot can read "${e0.name}" but was not given edit rights. Ask the owner to share it with edit permission.`);
  return { segs, e0 };
}

async function finish(cfg, segs, fileId, beforeVersion, out, label, clock) {
  lastWrite.set(fileId, clock.now());
  const after = await stat(cfg, segs);
  const summary = clip(out.summary || "edit", 100);
  const okB = beforeVersion === "0" ? true : await labelVersion(cfg, fileId, beforeVersion, clip(`Before ${label}: ${summary}`, 120)).then(() => true, () => false);
  const okA = await labelVersion(cfg, fileId, String(after.mtime), clip(`${label}: ${summary}`, 120)).then(() => true, () => false);
  return {
    ...(out.data || {}), path: after.path, file_id: fileId, changed: out.changed,
    version_id: encodeVersionId({ f: fileId, b: beforeVersion, a: after.etag }), version_label: `${label}: ${summary}`,
    ...(okA && okB ? {} : { label_warning: "Saved, but Workspace did not accept the version label." }),
  };
}

export async function withFileWrite(cfg, ref, mutate, { waitS = 30, ifOpen = "wait", label = "Crow", clock }) {
  const { segs, e0 } = await guard(cfg, ref);
  return serialized(e0.fileId, async () => {
    for (let attempt = 0; ; attempt++) {
      const e = await settleLock(cfg, segs, { waitS, ifOpen, clock });
      await spacing(e.fileId, clock);
      const cur = await getFile(cfg, segs, { maxBytes: MAX_EDIT_BYTES });
      const out = await mutate(cur.bytes, e);
      if (!out || !out.changed) return { ...(out?.data || {}), path: e.path, file_id: e.fileId, changed: 0, version_id: null };
      const res = await putFile(cfg, segs, out.bytes, { ifMatch: cur.etag });
      if ((res.status === 412 || res.status === 423) && attempt === 0) continue;
      if (res.status === 412) throw new WsError("changed_concurrently", `Someone else saved "${e.name}" at the same moment. Read it again and retry.`);
      if (res.status === 423) { const again = await stat(cfg, segs); if (again.lock) { const c = await classifyLock(cfg, again); throw new WsError(c.code, c.message, c.data); } throw new WsError("locked", "The file is locked; try again."); }
      if (!res.ok) throw httpFail(res, "save the change");
      return finish(cfg, segs, e.fileId, String(cur.mtime), out, label, clock);
    }
  });
}

export async function withFileRestore(cfg, ref, versionId, { waitS = 30, ifOpen = "wait", label = "Crow", summary = "restore", clock }) {
  const { segs, e0 } = await guard(cfg, ref);
  return serialized(e0.fileId, async () => {
    for (let attempt = 0; ; attempt++) {
      const e = await settleLock(cfg, segs, { waitS, ifOpen, clock });
      await spacing(e.fileId, clock);
      const res = await restoreVersion(cfg, e.fileId, versionId);
      if (res.status === 423 && attempt === 0) continue;
      if (![201, 204].includes(res.status)) throw httpFail(res, "restore that version");
      return finish(cfg, segs, e.fileId, String(e.mtime), { changed: 1, summary }, label, clock);
    }
  });
}

export async function createFile(cfg, folderSegs, name, bytes, { label = "Crow", summary = "create", clock = { now: Date.now } } = {}) {
  const segs = [...folderSegs, name];
  const res = await putFile(cfg, segs, bytes, { ifNoneMatch: "*" });
  if (res.status === 412) throw new WsError("exists", `"${joinPath(segs)}" already exists`);
  if (![201, 204].includes(res.status)) throw httpFail(res, "create the file");
  const e = await stat(cfg, segs);
  return finish(cfg, segs, e.fileId, "0", { changed: 1, summary }, label, clock);
}

export async function undoFileChange(cfg, ref, versionId, opts) {
  const v = decodeVersionId(versionId);
  const segs = await resolveRef(cfg, ref);
  const e = await stat(cfg, segs);
  if (e.fileId !== v.f) throw new WsError("bad_version_id", "That version_id belongs to a different file.");
  if (normEtag(e.etag) !== v.a) throw new WsError("changed_since", `"${e.name}" changed after that edit (last modified ${e.modified}). Nothing was undone. To go back anyway, use ws_drive_list_versions and ws_drive_restore_version.`, { modified: e.modified });
  if (v.b === "0") {
    await settleLock(cfg, segs, { waitS: opts.waitS ?? 30, ifOpen: opts.ifOpen ?? "wait", clock: opts.clock });
    await remove(cfg, segs);
    return { path: e.path, file_id: e.fileId, undone: "The file Crow created was moved to the Workspace trash." };
  }
  if (!(await listVersions(cfg, v.f)).some((x) => x.versionId === v.b)) throw new WsError("version_gone", "Workspace no longer keeps the version from before that edit, so it cannot be undone automatically.");
  return withFileRestore(cfg, segs, v.b, { ...opts, label: "Undo", summary: "undo of a Crow edit" });
}
```

- [ ] **Step 6: Run the protocol tests**

Run: `npm test -- tests/workspace-write-protocol.test.js`
Expected: PASS.

- [ ] **Step 7: Write the failing Drive-write tests**

`tests/workspace-drive-write.test.js`:

```js
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startFakeNextcloud } from "./helpers/workspace-fake-nextcloud.js";
import { connectWorkspace } from "./helpers/workspace-client.js";

let fake, call, close;
before(async () => {
  fake = await startFakeNextcloud({ secret: "jwt" });
  fake.addFolder("S", { owner: "admin" });
  fake.addFile("S/r.docx", Buffer.from("PK"), { owner: "admin" });
  fake.addFile("S/n.txt", Buffer.from("one"), { owner: "admin" });
  ({ call, close } = await connectWorkspace(fake));
});
after(async () => { await close(); fake.close(); });

test("create_folder is idempotent", async () => {
  assert.equal((await call("ws_drive_create_folder", { name: "Recetas", parent: "S" })).data.created, true);
  assert.equal((await call("ws_drive_create_folder", { name: "Recetas", parent: "S" })).data.created, false);
});

test("upload_file never overwrites; base64 and text; 10 MB cap", async () => {
  const a = await call("ws_drive_upload_file", { folder: "S", name: "a.txt", text: "hola" });
  assert.equal(a.success, true); assert.ok(a.data.version_id);
  assert.equal((await call("ws_drive_upload_file", { folder: "S", name: "a.txt", text: "x" })).code, "exists");
  assert.equal((await call("ws_drive_upload_file", { folder: "S", name: "b.bin", base64: "!!notb64" })).code, "bad_content");
  assert.equal((await call("ws_drive_upload_file", { folder: "S", name: "c.txt", text: "a", base64: "YQ==" })).code, "bad_content");
});

test("upload_new_version refuses office files (no full-document replace)", async () => {
  const r = await call("ws_drive_upload_new_version", { path: "S/r.docx", text: "x" });
  assert.equal(r.code, "full_replace_refused"); assert.match(r.error, /ws_docs_find_replace/);
  const ok = await call("ws_drive_upload_new_version", { path: "S/n.txt", text: "two" });
  assert.equal(ok.success, true);
  assert.equal(fake.node("S/n.txt").bytes.toString(), "two");
});

test("copy de-duplicates names; rename and move", async () => {
  const c1 = await call("ws_drive_copy_file", { path: "S/n.txt" });
  assert.equal(c1.data.path, "S/n (2).txt");
  assert.equal((await call("ws_drive_rename", { path: "S/n (2).txt", new_name: "m.txt" })).data.name, "m.txt");
  assert.equal((await call("ws_drive_move_file", { path: "S/m.txt", new_parent: "S/Recetas" })).data.moved, true);
  assert.equal((await call("ws_drive_rename", { path: "S/Recetas/m.txt", new_name: "../x" })).code, "bad_path");
});

test("export converts via the connector into the drive, never overwriting", async () => {
  const r = await call("ws_drive_export", { path: "S/r.docx", format: "pdf" });
  assert.equal(r.data.path, "S/r.pdf");
  const r2 = await call("ws_drive_export", { path: "S/r.docx", format: "pdf" });
  assert.equal(r2.data.path, "S/r (2).pdf");
  assert.equal((await call("ws_drive_export", { path: "S/r.docx", format: "xlsx" })).code, "bad_format");
});

test("share: user shares only, permissions by role", async () => {
  const r = await call("ws_drive_share", { path: "S/r.docx", user: "dayane", role: "writer" });
  assert.equal(r.success, true);
  assert.deepEqual(fake.state.shares.at(-1), { id: "1", path: "/S/r.docx", share_with: "dayane", share_type: 0, permissions: 3 });
  assert.equal((await call("ws_drive_share", { path: "S/r.docx", user: "bad user/../", role: "reader" })).code, "bad_user");
});

test("versions: list, restore (undoable), undo via ws_undo_last_change", async () => {
  const w = await call("ws_drive_upload_new_version", { path: "S/n.txt", text: "three" });
  const list = await call("ws_drive_list_versions", { path: "S/n.txt" });
  assert.ok(list.data.versions.length >= 3);
  const u = await call("ws_undo_last_change", { path: "S/n.txt", version_id: w.data.version_id });
  assert.equal(u.success, true);
  assert.equal(fake.node("S/n.txt").bytes.toString(), "two");
  const oldest = list.data.versions.at(-1).version_id;
  const rs = await call("ws_drive_restore_version", { path: "S/n.txt", version_id: oldest });
  assert.equal(fake.node("S/n.txt").bytes.toString(), "one"); assert.ok(rs.data.version_id);
});

test("trash refuses an open file and names who has it", async () => {
  fake.addFile("S/open.docx", Buffer.from("PK"));
  fake.openInEditor("S/open.docx", ["dayane"]);
  const r = await call("ws_drive_trash_file", { path: "S/open.docx", wait_s: 0 });
  assert.equal(r.code, "open_in_editor"); assert.deepEqual(r.data.open_by, ["Dayane"]);
});

test("no tool result ever contains the app password or JWT secret", () => {
  for (const c of fake.calls) assert.doesNotMatch(JSON.stringify(c.body || ""), /pw-secret-123/);
});
```

- [ ] **Step 8: Run to verify it fails**

Run: `npm test -- tests/workspace-drive-write.test.js`
Expected: FAIL (tools missing).

- [ ] **Step 9: Implement the Drive write tools and `tools/undo.js`**

Append to `tools/drive.js` (and pass `driveWriteDefs` in `registerDrive`):

```js
import { WsError } from "../result.js";
import { writeOpts, writeOptsOf } from "./common.js";
import { mkcol, move, copy, remove, putFile } from "../nc/dav.js";
import { splitPath, joinPath } from "../nc/paths.js";
import { createUserShare } from "../nc/ocs.js";
import { exportAs } from "../nc/onlyoffice.js";
import { listVersions } from "../nc/versions.js";
import { withFileWrite, withFileRestore, createFile, MAX_EDIT_BYTES } from "../write-protocol.js";
import { classifyLock } from "../nc/locks.js";

const OFFICE = /\.(docx|xlsx|pptx)$/i;
const NAME_RE = /^[^/\\\u0000-\u001f\u007f]{1,255}$/;
const EXPORTS = { doc: ["pdf", "docx", "odt"], sheet: ["pdf", "xlsx", "ods", "csv"], slide: ["pdf", "pptx", "odp"] };
const familyOf = (name) => (/\.(docx|odt|doc|rtf|txt|md)$/i.test(name) ? "doc" : /\.(xlsx|ods|xls|csv)$/i.test(name) ? "sheet" : /\.(pptx|odp|ppt)$/i.test(name) ? "slide" : null);
const checkName = (n) => { const s = String(n).normalize("NFC"); if (!NAME_RE.test(s) || s === "." || s === "..") throw new WsError("bad_path", "names cannot contain '/', '\\' or control characters"); return s; };

function decodeContent({ text, base64 }) {
  if ((text === undefined) === (base64 === undefined)) throw new WsError("bad_content", "give exactly one of text or base64");
  const bytes = text !== undefined ? Buffer.from(text, "utf8")
    : (/^[A-Za-z0-9+/]*={0,2}$/.test(base64) && base64.length % 4 === 0 ? Buffer.from(base64, "base64") : (() => { throw new WsError("bad_content", "base64 is not valid"); })());
  if (bytes.length > 10 * 1024 * 1024) throw new WsError("too_large", "uploads are limited to 10 MB");
  return bytes;
}

export async function uniqueName(cfg, folderSegs, name) {
  const dot = name.lastIndexOf(".");
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  for (let i = 1; i <= 50; i++) {
    const cand = i === 1 ? name : `${stem} (${i})${ext}`;
    try { await stat(cfg, [...folderSegs, cand]); } catch (e) { if (e.code === "not_found") return cand; throw e; }
  }
  throw new WsError("exists", "too many files with that name");
}

async function refuseIfOpen(cfg, e, waitS, clock) {
  const deadline = clock.now() + waitS * 1000;
  let cur = e;
  while (cur.lock && clock.now() < deadline) { await clock.sleep(2000); cur = await stat(cfg, splitPath(e.path)); }
  if (cur.lock) { const c = await classifyLock(cfg, cur); throw new WsError(c.code, c.message, { ...c.data, can_proceed: false }); }
}

export const driveWriteDefs = [
  { name: "ws_drive_create_folder", description: "Create a folder (idempotent: created:false if it already exists).",
    schema: { name: z.string().min(1).max(255), parent: z.string().max(4096).optional().default("") },
    run: async ({ name, parent }, { getConfig }) => { const cfg = getConfig(); const segs = [...splitFolder(parent), checkName(name)]; const created = await mkcol(cfg, segs); const e = await stat(cfg, segs); return { created, path: e.path, file_id: e.fileId }; } },
  { name: "ws_drive_move_file", description: "Move a file or folder into another folder (never overwrites).",
    schema: { path: z.string().max(4096), new_parent: z.string().max(4096) },
    run: async ({ path, new_parent }, { getConfig }) => { const cfg = getConfig(); const from = splitPath(path); const to = [...splitFolder(new_parent), from.at(-1)]; if (joinPath(from) === joinPath(to)) return { moved: false, path }; await move(cfg, from, to); return { moved: true, path: joinPath(to) }; } },
  { name: "ws_drive_copy_file", description: "Copy a file (adds ' (2)' etc. on a name clash).",
    schema: { path: z.string().max(4096), new_name: z.string().max(255).optional(), parent: z.string().max(4096).optional() },
    run: async ({ path, new_name, parent }, { getConfig }) => { const cfg = getConfig(); const from = splitPath(path); const folder = parent === undefined ? from.slice(0, -1) : splitFolder(parent); const name = await uniqueName(cfg, folder, checkName(new_name || from.at(-1))); await copy(cfg, from, [...folder, name]); const e = await stat(cfg, [...folder, name]); return { path: e.path, file_id: e.fileId }; } },
  { name: "ws_drive_rename", description: "Rename a file or folder in place (id unchanged).",
    schema: { path: z.string().max(4096), new_name: z.string().min(1).max(255) },
    run: async ({ path, new_name }, { getConfig }) => { const cfg = getConfig(); const from = splitPath(path); const name = checkName(new_name); await move(cfg, from, [...from.slice(0, -1), name]); return { old_name: from.at(-1), name, path: joinPath([...from.slice(0, -1), name]) }; } },
  { name: "ws_drive_trash_file", description: "Move a file or folder to the Workspace trash (recoverable). Destructive: confirm intent with the user first.",
    schema: { ...fileRef, wait_s: writeOpts.wait_s },
    run: async (args, { getConfig, clock }) => { const cfg = getConfig(); const segs = await resolveRef(cfg, refOf(args)); const e = await stat(cfg, segs); await refuseIfOpen(cfg, e, args.wait_s ?? 30, clock); await remove(cfg, segs); return { trashed: true, path: e.path }; } },
  { name: "ws_drive_upload_file", description: "Create a NEW file from text or base64 (max 10 MB). Never overwrites.",
    schema: { folder: z.string().max(4096), name: z.string().min(1).max(255), text: z.string().optional(), base64: z.string().optional() },
    run: async (args, { getConfig, clock }) => { const cfg = getConfig(); return createFile(cfg, splitFolder(args.folder), checkName(args.name), decodeContent(args), { summary: `upload ${args.name}`, clock }); } },
  { name: "ws_drive_upload_new_version", description: "Replace the content of a NON-office file (text, csv, images…). Refused for .docx/.xlsx/.pptx — use ws_docs_find_replace / ws_docs_replace_section / ws_sheets_write instead.",
    schema: { ...fileRef, text: z.string().optional(), base64: z.string().optional(), ...writeOpts },
    run: async (args, { getConfig, clock }) => {
      const cfg = getConfig(); const e = await stat(cfg, await resolveRef(cfg, refOf(args)));
      if (OFFICE.test(e.name)) throw new WsError("full_replace_refused", "Replacing a whole office document destroys its formatting. Use ws_docs_find_replace, ws_docs_replace_section or ws_sheets_write.");
      const bytes = decodeContent(args);
      return withFileWrite(cfg, refOf(args), async () => ({ bytes, changed: 1, summary: "new content" }), { ...writeOptsOf(args), clock });
    } },
  { name: "ws_drive_export", description: "Convert a document (pdf, docx, odt, xlsx, ods, csv, pptx, odp) with the document editor and save the result in the drive next to it (or in folder). Never overwrites.",
    schema: { ...fileRef, format: z.enum(["pdf", "docx", "odt", "xlsx", "ods", "csv", "pptx", "odp"]), folder: z.string().max(4096).optional() },
    run: async (args, { getConfig, clock }) => {
      const cfg = getConfig(); const segs = await resolveRef(cfg, refOf(args)); const e = await stat(cfg, segs);
      const fam = familyOf(e.name);
      if (!fam || !EXPORTS[fam].includes(args.format)) throw new WsError("bad_format", `"${e.name}" can be exported as: ${(EXPORTS[fam] || []).join(", ") || "nothing"}`);
      const bytes = await exportAs(cfg, e.fileId, args.format, MAX_EDIT_BYTES);
      const folder = args.folder === undefined ? segs.slice(0, -1) : splitFolder(args.folder);
      const name = await uniqueName(cfg, folder, `${e.name.replace(/\.[^.]+$/, "")}.${args.format}`);
      return createFile(cfg, folder, name, bytes, { summary: `export of ${e.name}`, clock });
    } },
  { name: "ws_drive_share", description: "Share a file or folder with one Workspace user (never a public link). role: reader or writer.",
    schema: { ...fileRef, user: z.string().min(1).max(64), role: z.enum(["reader", "writer"]) },
    run: async (args, { getConfig }) => {
      const cfg = getConfig();
      if (!/^[A-Za-z0-9_.@'-]{1,64}$/.test(args.user)) throw new WsError("bad_user", "user must be an exact Workspace login name");
      const segs = await resolveRef(cfg, refOf(args)); const e = await stat(cfg, segs);
      const permissions = args.role === "reader" ? 1 : e.isFolder ? 15 : 3;
      const s = await createUserShare(cfg, segs, args.user, permissions);
      return { shared: true, path: e.path, with: args.user, role: args.role, share_id: String(s.id) };
    } },
  { name: "ws_drive_list_versions", description: "List a file's saved versions (newest first): version_id, time, author, label.",
    schema: { ...fileRef, limit: z.number().int().min(1).max(100).optional().default(20) },
    run: async (args, { getConfig }) => { const cfg = getConfig(); const e = await stat(cfg, refOf(args)); const v = await listVersions(cfg, e.fileId); return { path: e.path, versions: v.slice(0, args.limit).map((x) => ({ version_id: x.versionId, modified: x.modified, author: x.author, label: x.label, size: x.size })) }; } },
  { name: "ws_drive_restore_version", description: "Restore a listed version. The current content is kept as a version first, so this can be undone too.",
    schema: { ...fileRef, version_id: z.string().regex(/^\d{1,12}$/), ...writeOpts },
    run: async (args, { getConfig, clock }) => withFileRestore(getConfig(), refOf(args), args.version_id, { ...writeOptsOf(args), clock, summary: `restore version ${args.version_id}` }) },
];
```

`registerDrive` becomes `defineTools(server, ctx, [...driveReadDefs, ...driveWriteDefs])`.

`tools/undo.js`:

```js
import { z } from "zod";
import { WsError } from "../result.js";
import { defineTools } from "./define.js";
import { undoFileChange } from "../write-protocol.js";

/** Task 10 adds the "j1." (calendar/contacts journal) branch. */
export const undoHandlers = { v1: (cfg, args, ctx) => undoFileChange(cfg, { path: args.path }, args.version_id, { clock: ctx.clock, waitS: args.wait_s ?? 30, ifOpen: args.if_open ?? "wait" }) };

export function registerUndo(server, ctx) {
  return defineTools(server, ctx, [{
    name: "ws_undo_last_change",
    description: "Undo one Crow change: pass the path (or the cal:/contacts: ref) and the version_id that change returned. Refuses if someone changed it since.",
    schema: { path: z.string().max(4096), version_id: z.string().max(2048), wait_s: z.number().int().min(0).max(30).optional(), if_open: z.enum(["wait", "proceed"]).optional() },
    run: async (args, c) => {
      const kind = String(args.version_id).split(".")[0];
      const h = undoHandlers[kind];
      if (!h) throw new WsError("bad_version_id", "That version_id was not issued by the Workspace tools.");
      return h(c.getConfig(), args, c);
    },
  }]);
}
```

In `server.js`: `names.push(...registerUndo(server, ctx));` (and the import).

- [ ] **Step 10: Run all Workspace tests so far**

Run: `npm test -- tests/workspace-write-protocol.test.js tests/workspace-drive-write.test.js tests/workspace-drive-read.test.js tests/workspace-dav.test.js`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add bundles/workspace/server/nc/versions.js bundles/workspace/server/nc/onlyoffice.js bundles/workspace/server/write-protocol.js bundles/workspace/server/tools/undo.js tests/workspace-write-protocol.test.js tests/workspace-drive-write.test.js
git commit bundles/workspace/server tests/workspace-write-protocol.test.js tests/workspace-drive-write.test.js -m "feat(workspace): lock-aware versioned write protocol, ONLYOFFICE drop-to-proceed, undo, Drive write tools"
git show --stat HEAD
```

---
### Task 6: OOXML core (zip, OPC, docx model) and the Docs read tools

**Files:**
- Create: `bundles/workspace/server/ooxml/{zip.js,opc.js,docx-model.js,docx-read.js}`, `bundles/workspace/server/tools/docs.js` (read defs + shared loader), `tests/helpers/ooxml-assert.js`
- Modify: `bundles/workspace/server/server.js`
- Test: `tests/workspace-ooxml-core.test.js`, `tests/workspace-docs-read.test.js`

**Interfaces:**
- Produces `ooxml/zip.js`:
  - `ZIP_LIMITS`
  - `class OoxmlPackage { static open(bytes); has(n); bytes(n); text(n); xml(n); markDirty(n); setXml(n, doc); setBytes(n, u8); remove(n); names(); changed(); save() → Uint8Array }`
- Produces `ooxml/opc.js`:
  - `REL`, `relsPath(part)`, `resolveTarget(fromPart, target)`
  - `readRels(pkg, part) → [{id,type,target,external}]`, `addRel(pkg, part, type, target, external?) → rId`, `removeRel(pkg, part, id)`, `relTarget(pkg, part, id) → string|null`
  - `partsOfType(pkg, part, type) → string[]`, `mainPart(pkg)`
  - `ensureDefault(pkg, ext, ct)`, `setOverride(pkg, part, ct)`, `removeOverride(pkg, part)`
- Produces `ooxml/docx-model.js`:
  - `openDocx(bytes) → Docx {pkg, part, doc, body, styles, numbering}`
  - `paragraphHeadingLevel(d, p) → 0..6`, `runsOf(p)`, `paragraphText(p)`, `textMap(p) → {text, segs:[{t, run, start, end}]}` (`\u0000` marks tab/break/drawing)
  - `topBlocks(d) → Element[]` (w:p | w:tbl | w:sdt; excludes w:sectPr)
  - `allParagraphs(d) → [{p, part}]` (body incl. tables, headers, footers)
  - `on(rPr, name) → boolean`, `RPR_ORDER`, `setOrdered(parent, order, name, node|null)`
- Produces `ooxml/docx-read.js`:
  - `toMarkdown(d, blocks?) → string`, `structure(d) → [{level, text, index}]`
  - `sectionRange(d, heading) → {start, end}`, throws `WsError("heading_not_found")` with the available headings
- Produces `tools/docs.js`:
  - `loadDocx(cfg, ref) → {entry, d}`
  - `docxWrite(ctx, args, fn) → write result`, where `fn(d) → {changed, summary, data}`
  - `docsReadDefs`, `registerDocs(server, ctx, extra=[])`

- [ ] **Step 1: Write the failing tests**

`tests/helpers/ooxml-assert.js`:

```js
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
```

`tests/workspace-ooxml-core.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { zipSync, strToU8, unzipSync } from "fflate";
import { OoxmlPackage, ZIP_LIMITS } from "../bundles/workspace/server/ooxml/zip.js";
import { addRel, readRels, resolveTarget, mainPart, setOverride } from "../bundles/workspace/server/ooxml/opc.js";
import { assertOnlyPartsChanged } from "./helpers/ooxml-assert.js";

const FIX = join(import.meta.dirname, "fixtures", "workspace");

for (const f of ["rich.docx", "oo-rich.docx", "rich.xlsx", "oo-rich.xlsx", "rich.pptx", "oo-rich.pptx"]) {
  test(`${f}: open + save with no edits keeps every part byte-identical and [Content_Types].xml first`, () => {
    const before = readFileSync(join(FIX, f));
    const after = OoxmlPackage.open(before).save();
    assertOnlyPartsChanged(before, after, []);
    assert.equal(Object.keys(unzipSync(after))[0], "[Content_Types].xml");
  });
}

test("zip bomb (ratio) and too many entries are refused before inflating", () => {
  const bomb = zipSync({ "[Content_Types].xml": strToU8("<x/>"), "big.xml": new Uint8Array(5 * 1024 * 1024) }, { level: 9 });
  assert.throws(() => OoxmlPackage.open(bomb), (e) => e.code === "malformed_document" && /compress/.test(e.message));
  const many = {}; for (let i = 0; i < 20; i++) many[`f${i}`] = strToU8("a");
  assert.throws(() => OoxmlPackage.open(zipSync({ "[Content_Types].xml": strToU8("<x/>"), ...many }), { ...ZIP_LIMITS, maxEntries: 10 }), (e) => e.code === "malformed_document");
});

test("DOCTYPE in any part is refused", () => {
  const z = zipSync({ "[Content_Types].xml": strToU8('<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "b">]><Types/>') });
  assert.throws(() => OoxmlPackage.open(z).xml("[Content_Types].xml"), (e) => e.code === "malformed_document");
});

test("not a zip → malformed_document", () => {
  assert.throws(() => OoxmlPackage.open(Buffer.from("hello")), (e) => e.code === "malformed_document");
});

test("rels: resolve, add with a fresh id, external link; content-type override", () => {
  const pkg = OoxmlPackage.open(readFileSync(join(FIX, "rich.docx")));
  assert.equal(mainPart(pkg), "word/document.xml");
  assert.equal(resolveTarget("word/document.xml", "../customXml/item1.xml"), "customXml/item1.xml");
  const ids = new Set(readRels(pkg, "word/document.xml").map((r) => r.id));
  const id = addRel(pkg, "word/document.xml", "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink", "https://example.org/a?b=1&c=2", true);
  assert.ok(!ids.has(id));
  setOverride(pkg, "/word/x.xml", "application/x-test");
  const out = OoxmlPackage.open(pkg.save());
  assert.equal(readRels(out, "word/document.xml").find((r) => r.id === id).target, "https://example.org/a?b=1&c=2");
  assert.match(out.text("[Content_Types].xml"), /PartName="\/word\/x\.xml"/);
});
```

`tests/workspace-docs-read.test.js`:

```js
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
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -- tests/workspace-ooxml-core.test.js tests/workspace-docs-read.test.js`
Expected: FAIL (modules missing).

- [ ] **Step 3: Write `ooxml/zip.js` and `ooxml/opc.js`**

`ooxml/zip.js`:

```js
/** Order-preserving OOXML package. Untouched entries are written back byte-identical (uncompressed content). */
import { unzipSync, zipSync, strFromU8, strToU8 } from "fflate";
import { WsError } from "../result.js";
import { parseXml, serializeXml } from "./xml.js";

export const ZIP_LIMITS = Object.freeze({ maxEntries: 5000, maxTotal: 200 * 1024 * 1024, maxRatio: 200, maxXml: 30 * 1024 * 1024 });

export class OoxmlPackage {
  constructor(files, order, levels, limits) { this.files = files; this.order = order; this.levels = levels; this.limits = limits; this.docs = new Map(); this.dirty = new Set(); this.removed = new Set(); }
  static open(bytes, limits = ZIP_LIMITS) {
    let count = 0, total = 0; const order = []; const levels = new Map();
    let files;
    try {
      files = unzipSync(new Uint8Array(bytes), {
        filter: (f) => {
          if (++count > limits.maxEntries) throw new WsError("malformed_document", `too many parts (> ${limits.maxEntries})`);
          total += f.originalSize;
          if (total > limits.maxTotal) throw new WsError("malformed_document", "the file unpacks to more than 200 MB");
          if (f.originalSize > 1024 * 1024 && f.size > 0 && f.originalSize / f.size > limits.maxRatio) throw new WsError("malformed_document", `"${f.name}" is compressed suspiciously well (possible zip bomb)`);
          order.push(f.name); levels.set(f.name, f.compression); return true;
        },
      });
    } catch (e) { if (e instanceof WsError) throw e; throw new WsError("malformed_document", "not a valid office file (zip)"); }
    if (!files["[Content_Types].xml"]) throw new WsError("malformed_document", "not an office file ([Content_Types].xml missing)");
    return new OoxmlPackage(files, order, levels, limits);
  }
  has(n) { return !this.removed.has(n) && (this.files[n] !== undefined || this.docs.has(n)); }
  names() { return [...this.order, ...[...this.docs.keys()].filter((n) => !this.order.includes(n))].filter((n) => this.has(n)); }
  bytes(n) { if (this.dirty.has(n)) return strToU8(serializeXml(this.docs.get(n))); return this.files[n]; }
  text(n) { const b = this.files[n]; if (!b) throw new WsError("malformed_document", `missing part ${n}`); if (b.length > this.limits.maxXml) throw new WsError("too_large", `part ${n} is larger than 30 MB`); return strFromU8(b); }
  xml(n) { if (!this.docs.has(n)) this.docs.set(n, parseXml(this.text(n), n)); return this.docs.get(n); }
  markDirty(n) { this.dirty.add(n); this.removed.delete(n); }
  setXml(n, doc) { this.docs.set(n, doc); this.markDirty(n); }
  setBytes(n, u8) { this.files[n] = u8; this.docs.delete(n); this.dirty.delete(n); this.removed.delete(n); if (!this.order.includes(n)) this.order.push(n); }
  remove(n) { this.removed.add(n); this.dirty.delete(n); }
  changed() { return new Set([...this.dirty, ...this.removed]); }
  save() {
    const out = {};
    for (const n of this.names()) out[n] = [this.bytes(n), { level: this.levels.get(n) === 0 ? 0 : 6 }];
    return zipSync(out);
  }
}
```

`ooxml/opc.js`:

```js
import { WsError } from "../result.js";
import { NS, parseXml, kids, el, attr, removeNode } from "./xml.js";

const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
export const REL = Object.freeze({
  officeDocument: `${R}/officeDocument`, styles: `${R}/styles`, numbering: `${R}/numbering`, hyperlink: `${R}/hyperlink`, image: `${R}/image`,
  comments: `${R}/comments`, commentsExtended: "http://schemas.microsoft.com/office/2011/relationships/commentsExtended",
  header: `${R}/header`, footer: `${R}/footer`, worksheet: `${R}/worksheet`, sharedStrings: `${R}/sharedStrings`, calcChain: `${R}/calcChain`,
  slide: `${R}/slide`, slideLayout: `${R}/slideLayout`, notesSlide: `${R}/notesSlide`, notesMaster: `${R}/notesMaster`, chart: `${R}/chart`,
  pivotCacheDefinition: `${R}/pivotCacheDefinition`, drawing: `${R}/drawing`,
});
const EMPTY_RELS = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>';

export function relsPath(part) { const i = part.lastIndexOf("/"); return `${part.slice(0, i + 1)}_rels/${part.slice(i + 1)}.rels`; }
export function resolveTarget(fromPart, target) {
  if (target.startsWith("/")) return target.slice(1);
  const base = fromPart.split("/").slice(0, -1);
  for (const seg of target.split("/")) { if (seg === "..") base.pop(); else if (seg && seg !== ".") base.push(seg); }
  return base.join("/");
}
function relsDoc(pkg, part, create) {
  const p = relsPath(part);
  if (!pkg.has(p)) { if (!create) return null; pkg.setXml(p, parseXml(EMPTY_RELS, p)); }
  return pkg.xml(p);
}
export function readRels(pkg, part) {
  const doc = relsDoc(pkg, part, false);
  return doc ? kids(doc.documentElement, NS.rel, "Relationship").map((e) => ({ id: e.getAttribute("Id"), type: e.getAttribute("Type"), target: e.getAttribute("Target"), external: e.getAttribute("TargetMode") === "External" })) : [];
}
export function addRel(pkg, part, type, target, external = false) {
  const doc = relsDoc(pkg, part, true);
  const ids = new Set(kids(doc.documentElement, NS.rel, "Relationship").map((e) => e.getAttribute("Id")));
  let n = ids.size + 1; while (ids.has(`rId${n}`)) n++;
  const id = `rId${n}`;
  doc.documentElement.appendChild(el(doc, NS.rel, "Relationship", { Id: id, Type: type, Target: target, TargetMode: external ? "External" : undefined }));
  pkg.markDirty(relsPath(part));
  return id;
}
export function removeRel(pkg, part, id) {
  const doc = relsDoc(pkg, part, false); if (!doc) return;
  for (const e of kids(doc.documentElement, NS.rel, "Relationship")) if (e.getAttribute("Id") === id) removeNode(e);
  pkg.markDirty(relsPath(part));
}
export function relTarget(pkg, part, id) { const r = readRels(pkg, part).find((x) => x.id === id); return r ? (r.external ? r.target : resolveTarget(part, r.target)) : null; }
export const partsOfType = (pkg, part, type) => readRels(pkg, part).filter((r) => r.type === type && !r.external).map((r) => resolveTarget(part, r.target)).filter((p) => pkg.has(p));
export function mainPart(pkg) {
  const r = readRels(pkg, "").find((x) => x.type === REL.officeDocument);
  if (!r) throw new WsError("malformed_document", "the office file has no main part");
  return resolveTarget("", r.target);
}
function types(pkg) { return pkg.xml("[Content_Types].xml"); }
export function ensureDefault(pkg, ext, ct) {
  const doc = types(pkg);
  if (kids(doc.documentElement, NS.ct, "Default").some((e) => e.getAttribute("Extension").toLowerCase() === ext.toLowerCase())) return;
  doc.documentElement.insertBefore(el(doc, NS.ct, "Default", { Extension: ext, ContentType: ct }), kids(doc.documentElement, NS.ct, "Override")[0] || null);
  pkg.markDirty("[Content_Types].xml");
}
export function setOverride(pkg, partName, ct) {
  const doc = types(pkg);
  const name = partName.startsWith("/") ? partName : `/${partName}`;
  const ex = kids(doc.documentElement, NS.ct, "Override").find((e) => e.getAttribute("PartName") === name);
  if (ex) ex.setAttribute("ContentType", ct); else doc.documentElement.appendChild(el(doc, NS.ct, "Override", { PartName: name, ContentType: ct }));
  pkg.markDirty("[Content_Types].xml");
}
export function removeOverride(pkg, partName) {
  const doc = types(pkg); const name = partName.startsWith("/") ? partName : `/${partName}`;
  for (const e of kids(doc.documentElement, NS.ct, "Override")) if (e.getAttribute("PartName") === name) removeNode(e);
  pkg.markDirty("[Content_Types].xml");
}
export { attr };
```

(`readRels(pkg, "")` reads `_rels/.rels`: `relsPath("")` yields `_rels/.rels`.)

- [ ] **Step 4: Write `ooxml/docx-model.js` and `ooxml/docx-read.js`**

`ooxml/docx-model.js`:

```js
import { WsError } from "../result.js";
import { NS, kids, kid, all, attr, el } from "./xml.js";
import { OoxmlPackage } from "./zip.js";
import { mainPart, partsOfType, REL } from "./opc.js";

const W = NS.w;
export const RUN_CONTAINERS = new Set(["hyperlink", "ins", "smartTag", "sdt", "sdtContent", "fldSimple", "customXml", "moveTo"]);
const SEP = new Set(["tab", "br", "cr", "drawing", "object", "pict", "fldChar", "instrText", "sym", "footnoteReference", "endnoteReference", "commentReference", "ptab"]);
export const RPR_ORDER = ["rStyle", "rFonts", "b", "bCs", "i", "iCs", "caps", "smallCaps", "strike", "dstrike", "outline", "shadow", "emboss", "imprint", "noProof", "snapToGrid", "vanish", "webHidden", "color", "spacing", "w", "kern", "position", "sz", "szCs", "highlight", "u", "effect", "bdr", "shd", "fitText", "vertAlign", "rtl", "cs", "em", "lang", "eastAsianLayout", "specVanish", "oMath"];

export const on = (pr, name) => { const e = kid(pr, W, name); if (!e) return false; const v = attr(e, W, "val"); return !["0", "false", "off", "none"].includes(v); };

/** Insert/replace/remove child `name` of `parent` keeping schema order. node=null removes. */
export function setOrdered(parent, order, name, node) {
  for (const c of kids(parent, W, name)) parent.removeChild(c);
  if (!node) return;
  const idx = order.indexOf(name);
  const after = kids(parent, W).find((c) => order.indexOf(c.localName) > idx);
  parent.insertBefore(node, after || null);
}

function loadStyles(pkg, part) {
  const sp = partsOfType(pkg, part, REL.styles)[0] || null;
  const byId = new Map();
  const doc = sp ? pkg.xml(sp) : null;
  if (doc) for (const s of kids(doc.documentElement, W, "style")) {
    const pPr = kid(s, W, "pPr"); const ol = kid(pPr, W, "outlineLvl"); const np = kid(pPr, W, "numPr");
    byId.set(attr(s, W, "styleId"), { name: attr(kid(s, W, "name"), W, "val"), type: attr(s, W, "type"), basedOn: attr(kid(s, W, "basedOn"), W, "val"), outline: ol ? Number(attr(ol, W, "val")) : null, numId: np ? attr(kid(np, W, "numId"), W, "val") : null, ilvl: np ? Number(attr(kid(np, W, "ilvl"), W, "val") || 0) : 0 });
  }
  const chain = (id, f, depth = 0) => { const s = byId.get(id); if (!s || depth > 12) return null; const v = f(s); return v !== null && v !== undefined ? v : s.basedOn ? chain(s.basedOn, f, depth + 1) : null; };
  return {
    part: sp, doc, byId,
    headingLevel: (id) => chain(id, (s) => { const m = /^heading ([1-9])$/i.exec(s.name); if (m) return Number(m[1]) <= 6 ? Number(m[1]) : 0; return s.outline !== null && s.outline <= 5 ? s.outline + 1 : null; }) || 0,
    numPr: (id) => chain(id, (s) => (s.numId ? { numId: s.numId, ilvl: s.ilvl } : null)),
    idByName: (name) => { for (const [id, s] of byId) if (s.name.toLowerCase() === name.toLowerCase()) return id; return null; },
  };
}

function loadNumbering(pkg, part) {
  const np = partsOfType(pkg, part, REL.numbering)[0] || null;
  const doc = np ? pkg.xml(np) : null;
  const fmt = (numId, ilvl) => {
    if (!doc) return "bullet";
    const num = kids(doc.documentElement, W, "num").find((n) => attr(n, W, "numId") === String(numId));
    const absId = num ? attr(kid(num, W, "abstractNumId"), W, "val") : null;
    const abs = kids(doc.documentElement, W, "abstractNum").find((a) => attr(a, W, "abstractNumId") === absId);
    const lvl = abs ? kids(abs, W, "lvl").find((l) => Number(attr(l, W, "ilvl")) === Number(ilvl)) : null;
    return lvl ? attr(kid(lvl, W, "numFmt"), W, "val") || "bullet" : "bullet";
  };
  return { part: np, doc, fmt };
}

export function openDocx(bytes) {
  const pkg = OoxmlPackage.open(bytes);
  const part = mainPart(pkg);
  const doc = pkg.xml(part);
  if (doc.documentElement.namespaceURI !== W || doc.documentElement.localName !== "document") throw new WsError("wrong_type", "this is not a Word (.docx) document");
  const body = kid(doc.documentElement, W, "body");
  return { pkg, part, doc, body, styles: loadStyles(pkg, part), numbering: loadNumbering(pkg, part) };
}

export function paragraphHeadingLevel(d, p) {
  const pPr = kid(p, W, "pPr");
  const ol = kid(pPr, W, "outlineLvl");
  if (ol) { const v = Number(attr(ol, W, "val")); if (v >= 0 && v <= 5) return v + 1; }
  const ps = kid(pPr, W, "pStyle");
  return ps ? d.styles.headingLevel(attr(ps, W, "val")) : 0;
}
export function paragraphNum(d, p) {
  const pPr = kid(p, W, "pPr"); const np = kid(pPr, W, "numPr");
  if (np) { const numId = attr(kid(np, W, "numId"), W, "val"); if (numId === "0") return null; return { numId, ilvl: Number(attr(kid(np, W, "ilvl"), W, "val") || 0) }; }
  const ps = kid(pPr, W, "pStyle"); return ps ? d.styles.numPr(attr(ps, W, "val")) : null;
}
export function runsOf(p) {
  const out = [];
  const walk = (n) => { for (const c of kids(n, W)) { if (c.localName === "r") out.push(c); else if (RUN_CONTAINERS.has(c.localName)) walk(c); } };
  walk(p); return out;
}
export function runText(r) { let s = ""; for (const c of kids(r, W)) { if (c.localName === "t") s += c.textContent; else if (c.localName === "tab") s += "\t"; else if (c.localName === "br" || c.localName === "cr") s += "\n"; } return s; }
export const paragraphText = (p) => runsOf(p).map(runText).join("");
export function textMap(p) {
  const segs = []; let text = "";
  for (const r of runsOf(p)) for (const c of kids(r, W)) {
    if (c.localName === "t") { const v = c.textContent; segs.push({ t: c, run: r, start: text.length, end: text.length + v.length }); text += v; }
    else if (SEP.has(c.localName)) text += "\u0000";
  }
  return { text, segs };
}
export const topBlocks = (d) => kids(d.body, W).filter((n) => n.localName === "p" || n.localName === "tbl" || n.localName === "sdt");
export function allParagraphs(d) {
  const out = all(d.body, W, "p").map((p) => ({ p, part: d.part }));
  for (const part of [...partsOfType(d.pkg, d.part, REL.header), ...partsOfType(d.pkg, d.part, REL.footer)]) for (const p of all(d.pkg.xml(part), W, "p")) out.push({ p, part });
  return out;
}
export const preserve = (t) => t.setAttributeNS(NS.xml, "xml:space", "preserve");
export function makeRun(doc, text, rPr) {
  const r = el(doc, W, "w:r");
  if (rPr) r.appendChild(rPr.cloneNode(true));
  const parts = String(text).split("\t");
  parts.forEach((piece, i) => { if (i) r.appendChild(el(doc, W, "w:tab")); if (piece) { const t = el(doc, W, "w:t", {}, [piece]); preserve(t); r.appendChild(t); } });
  return r;
}
```

`ooxml/docx-read.js`:

```js
import { WsError } from "../result.js";
import { NS, kids, kid, attr } from "./xml.js";
import { RUN_CONTAINERS, runText, paragraphText, paragraphHeadingLevel, paragraphNum, topBlocks, on } from "./docx-model.js";
import { relTarget } from "./opc.js";

const W = NS.w;
const escMd = (s) => s.replace(/([\\`*_[\]|])/g, "\\$1");
function inline(d, p) {
  const walk = (n) => {
    let out = "";
    for (const c of kids(n, W)) {
      if (c.localName === "r") {
        const t = runText(c); if (!t) continue;
        const rPr = kid(c, W, "rPr"); let s = escMd(t).replace(/\n/g, "  \n");
        if (on(rPr, "b") && s.trim()) s = `**${s}**`;
        if (on(rPr, "i") && s.trim()) s = `*${s}*`;
        out += s;
      } else if (c.localName === "hyperlink") {
        const id = attr(c, NS.r, "id"); const url = id ? relTarget(d.pkg, d.part, id) : null;
        const inner = walk(c); out += url ? `[${inner}](${url})` : inner;
      } else if (RUN_CONTAINERS.has(c.localName)) out += walk(c);
    }
    return out;
  };
  return walk(p);
}
function tableMd(d, tbl) {
  const rows = kids(tbl, W, "tr").map((tr) => kids(tr, W, "tc").map((tc) => kids(tc, W, "p").map((p) => inline(d, p)).join("<br>").replace(/\|/g, "\\|")));
  if (!rows.length) return "";
  const n = Math.max(...rows.map((r) => r.length));
  const line = (r) => `| ${Array.from({ length: n }, (_, i) => r[i] ?? "").join(" | ")} |`;
  return [line(rows[0]), `|${" --- |".repeat(n)}`, ...rows.slice(1).map(line)].join("\n");
}
export function blockMd(d, b) {
  if (b.localName === "tbl") return tableMd(d, b);
  if (b.localName === "sdt") return kids(kid(b, W, "sdtContent"), W).map((x) => blockMd(d, x)).filter(Boolean).join("\n\n");
  if (b.localName !== "p") return "";
  const level = paragraphHeadingLevel(d, b);
  const text = inline(d, b);
  if (level) return `${"#".repeat(level)} ${paragraphText(b).trim()}`;
  const num = paragraphNum(d, b);
  if (num) return `${"  ".repeat(num.ilvl)}${d.numbering.fmt(num.numId, num.ilvl) === "bullet" ? "-" : "1."} ${text}`;
  return text;
}
export function toMarkdown(d, blocks = topBlocks(d)) {
  const parts = []; let prevList = false;
  for (const b of blocks) {
    const md = blockMd(d, b);
    const isList = /^\s*(-|1\.) /.test(md) && b.localName === "p" && !!paragraphNum(d, b);
    if (md === "" && b.localName === "p") { prevList = false; continue; }
    parts.push((isList && prevList ? "\n" : "\n\n") + md);
    prevList = isList;
  }
  return parts.join("").trim() + "\n";
}
export function structure(d) {
  return topBlocks(d).map((b, index) => ({ b, index })).filter(({ b }) => b.localName === "p" && paragraphHeadingLevel(d, b))
    .map(({ b, index }) => ({ level: paragraphHeadingLevel(d, b), text: paragraphText(b).trim(), index }));
}
export function sectionRange(d, heading) {
  const blocks = topBlocks(d);
  const want = String(heading).normalize("NFC").trim().toLowerCase();
  const hs = structure(d);
  const h = hs.find((x) => x.text.normalize("NFC").toLowerCase() === want);
  if (!h) throw new WsError("heading_not_found", `Heading "${heading}" not found. Available: ${hs.map((x) => x.text).join(" | ") || "(no headings)"}`);
  const next = hs.find((x) => x.index > h.index && x.level <= h.level);
  return { start: h.index, end: next ? next.index : blocks.length, level: h.level };
}
```

- [ ] **Step 5: Write `tools/docs.js` (loader + read defs) and register**

```js
import { z } from "zod";
import { WsError } from "../result.js";
import { fileRef, refOf, writeOptsOf } from "./common.js";
import { defineTools } from "./define.js";
import { stat, getFile, resolveRef } from "../nc/dav.js";
import { withFileWrite, MAX_EDIT_BYTES } from "../write-protocol.js";
import { openDocx, topBlocks } from "../ooxml/docx-model.js";
import { toMarkdown, structure, sectionRange } from "../ooxml/docx-read.js";

export async function loadDocx(cfg, ref) {
  const segs = await resolveRef(cfg, ref);
  const entry = await stat(cfg, segs);
  if (!/\.docx$/i.test(entry.name)) throw new WsError("wrong_type", `"${entry.name}" is not a .docx document`);
  const { bytes, etag } = await getFile(cfg, segs, { maxBytes: MAX_EDIT_BYTES });
  return { entry: { ...entry, etag }, d: openDocx(bytes) };
}

/** Run fn(d) on the live file inside the write protocol; one save → one version. */
export function docxWrite(ctx, args, fn, label = "Crow") {
  return withFileWrite(ctx.getConfig(), refOf(args), async (bytes, entry) => {
    if (!/\.docx$/i.test(entry.name)) throw new WsError("wrong_type", `"${entry.name}" is not a .docx document`);
    const d = openDocx(bytes);
    const r = fn(d);
    if (!r.changed) return { changed: 0, data: r.data };
    return { bytes: d.pkg.save(), changed: r.changed, summary: r.summary, data: r.data };
  }, { ...writeOptsOf(args), clock: ctx.clock, label });
}

export const docsReadDefs = [
  { name: "ws_docs_read", description: "Read a .docx as markdown (headings, lists, bold/italic, links, tables). Always reads the live file.",
    schema: { ...fileRef },
    run: async (args, { getConfig }) => { const { entry, d } = await loadDocx(getConfig(), refOf(args)); return { path: entry.path, file_id: entry.fileId, title: entry.name.replace(/\.docx$/i, ""), etag: entry.etag, markdown: toMarkdown(d) }; } },
  { name: "ws_docs_get_structure", description: "Heading outline of a .docx: [{level, text, index}].",
    schema: { ...fileRef },
    run: async (args, { getConfig }) => { const { entry, d } = await loadDocx(getConfig(), refOf(args)); return { path: entry.path, headings: structure(d) }; } },
  { name: "ws_docs_read_section", description: "Markdown of one section: from the heading to the next heading of the same or higher level.",
    schema: { ...fileRef, heading: z.string().min(1).max(500) },
    run: async (args, { getConfig }) => { const { entry, d } = await loadDocx(getConfig(), refOf(args)); const r = sectionRange(d, args.heading); return { path: entry.path, heading: args.heading, markdown: toMarkdown(d, topBlocks(d).slice(r.start, r.end)) }; } },
];
export function registerDocs(server, ctx, extra = []) { return defineTools(server, ctx, [...docsReadDefs, ...extra]); }
```

In `server.js`: `names.push(...registerDocs(server, ctx, docsWriteDefs));`. `docsWriteDefs` arrives in Task 7; until then pass `[]`.

- [ ] **Step 6: Run the tests**

Run: `npm test -- tests/workspace-ooxml-core.test.js tests/workspace-docs-read.test.js`
Expected: PASS. If the `oo-rich.docx` markdown differs only in how ONLYOFFICE split runs, e.g. `**Tacos al **` arriving as two bold runs, merge adjacent same-format runs in `inline()` before wrapping. Do not loosen the assertion.

- [ ] **Step 7: Commit**

```bash
git add bundles/workspace/server/ooxml bundles/workspace/server/tools/docs.js tests/helpers/ooxml-assert.js tests/workspace-ooxml-core.test.js tests/workspace-docs-read.test.js
git commit bundles/workspace/server tests/helpers/ooxml-assert.js tests/workspace-ooxml-core.test.js tests/workspace-docs-read.test.js -m "feat(workspace): OOXML package/OPC core, docx model, Docs read tools"
git show --stat HEAD
```

---

### Task 7: Docs edit tools (guardrails carried over)

**Files:**
- Create: `bundles/workspace/server/ooxml/{md-to-wml.js,docx-edit.js,image-size.js}`
- Modify: `bundles/workspace/server/tools/docs.js` (`docsWriteDefs`), `bundles/workspace/server/server.js`
- Test: `tests/workspace-docs-edit.test.js`

**Interfaces:**
- Consumes: Task 6 model/read functions, `docxWrite`, `createFile` (Task 5), `uniqueName` (Task 5, exported from `tools/drive.js`).
- Produces `md-to-wml.js`: `markdownToBlocks(d, md) → Element[]`. New paragraphs carry no `w:pStyle` (Normal) and no `w:numPr` unless the markdown is a heading/list.
- Produces `docx-edit.js`:
  - `findReplace(d, pairs, matchCase) → {results:[{find, occurrences}], total}`
  - `rewritePassages(d, passages) → {results}`, `setParagraphText(d, p, text)`
  - `formatText(d, find, occurrence, style) → count`
  - `insertBlocksAt(d, beforeNode|null, nodes)`, `appendMarkdown(d, md)`, `insertAtHeading(d, heading, md)`, `replaceSection(d, heading, md)`
  - `insertImage(d, bytes, ext, {anchorText, index, maxWidthPt})`
- Produces `image-size.js`: `imageSize(bytes) → {type:"png"|"jpeg"|"gif", width, height}`, or throws `WsError("bad_image")`.

- [ ] **Step 1: Write the failing tests**

`tests/workspace-docs-edit.test.js`:

```js
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startFakeNextcloud } from "./helpers/workspace-fake-nextcloud.js";
import { connectWorkspace } from "./helpers/workspace-client.js";
import { assertOnlyPartsChanged, partText, bodyBlocks, assertBlocksUnchangedOutside, sofficeOpens } from "./helpers/ooxml-assert.js";

const FIX = join(import.meta.dirname, "fixtures", "workspace");
let fake, call, close;
const bytesOf = (p) => fake.node(p).bytes;
const put = (name, src) => fake.addFile(`S/${name}`, readFileSync(join(FIX, src)), { owner: "admin" });
before(async () => { fake = await startFakeNextcloud(); fake.addFolder("S", { owner: "admin" }); ({ call, close } = await connectWorkspace(fake)); });
after(async () => { await close(); fake.close(); });

for (const src of ["rich.docx", "oo-rich.docx"]) {
  test(`${src}: find_replace across runs keeps bookmarks and comment anchors (Review Focus 3)`, async () => {
    put(`fr-${src}`, src);
    const before = bytesOf(`S/fr-${src}`);
    const r = await call("ws_docs_find_replace", { path: `S/fr-${src}`, find: "al pastor", replace: "de canasta" });
    assert.equal(r.data.results[0].occurrences, 1);
    assertOnlyPartsChanged(before, bytesOf(`S/fr-${src}`), ["word/document.xml"]);
    const xml = partText(bytesOf(`S/fr-${src}`), "word/document.xml");
    assert.match(xml, /w:bookmarkStart[^>]*w:name="tacos"/); assert.match(xml, /w:bookmarkEnd/);
    const md = (await call("ws_docs_read", { path: `S/fr-${src}` })).data.markdown;
    assert.match(md, /\*\*Tacos de canasta\*\*/, "replacement takes the formatting of the run where the match starts");
  });

  test(`${src}: find_replace never matches across w:tab; NFC/NFD-equivalent accents match (Review Focus 1)`, async () => {
    put(`tab-${src}`, src);
    assert.equal((await call("ws_docs_find_replace", { path: `S/tab-${src}`, find: "Tabseparated", replace: "x" })).data.total_changes, 0);
    assert.equal((await call("ws_docs_find_replace", { path: `S/tab-${src}`, find: "jalapeño", replace: "chipotle" })).data.total_changes, 1);
  });

  test(`${src}: batch pairs are atomic — one PUT, one version`, async () => {
    put(`b-${src}`, src);
    const putsBefore = fake.calls.filter((c) => c.method === "PUT").length;
    const r = await call("ws_docs_find_replace", { path: `S/b-${src}`, pairs: [{ find: "Tortillas", replace: "Totopos" }, { find: "Totopos", replace: "Tostadas" }, { find: "Nada", replace: "x" }] });
    assert.deepEqual(r.data.results.map((x) => x.occurrences), [1, 1, 0]);
    assert.equal(fake.calls.filter((c) => c.method === "PUT").length - putsBefore, 1);
  });

  test(`${src}: insert_at_heading never inherits the heading style (heading-style reset)`, async () => {
    put(`h-${src}`, src);
    const blocksBefore = await bodyBlocks(bytesOf(`S/h-${src}`));
    const r = await call("ws_docs_insert_at_heading", { path: `S/h-${src}`, heading: "Pasos", markdown: "Primero, lavar.\n\nLuego **picar**." });
    assert.equal(r.data.heading_inheritance_fix_applied, true);
    const blocksAfter = await bodyBlocks(bytesOf(`S/h-${src}`));
    const idx = blocksBefore.findIndex((b) => b.includes(">Pasos<"));
    assertBlocksUnchangedOutside(blocksBefore, blocksAfter, idx + 1, 0, 2);
    for (const b of blocksAfter.slice(idx + 1, idx + 3)) { assert.doesNotMatch(b, /w:pStyle/); assert.doesNotMatch(b, /w:numPr/); }
  });

  test(`${src}: replace_section is heading-to-heading and atomic`, async () => {
    put(`rs-${src}`, src);
    const putsBefore = fake.calls.filter((c) => c.method === "PUT").length;
    await call("ws_docs_replace_section", { path: `S/rs-${src}`, heading: "Ingredientes", markdown: "- Maíz\n- Sal" });
    assert.equal(fake.calls.filter((c) => c.method === "PUT").length - putsBefore, 1);
    const md = (await call("ws_docs_read", { path: `S/rs-${src}` })).data.markdown;
    assert.match(md, /## Ingredientes\n\n- Maíz\n- Sal\n\n## Pasos/);
    assert.doesNotMatch(md, /Cilantro/);
  });

  test(`${src}: rewrite_passages keeps paragraph style and first-run formatting; reports misses`, async () => {
    put(`rw-${src}`, src);
    const r = await call("ws_docs_rewrite_passages", { path: `S/rw-${src}`, passages: [{ match_prefix: "Tacos al", new_text: "Tacos dorados.\nSegunda línea." }, { match_prefix: "No existe", new_text: "x" }, { match_prefix: "  ", new_text: "y" }] });
    assert.deepEqual(r.data.results.map((x) => x.matched), [true, false, false]);
    const md = (await call("ws_docs_read", { path: `S/rw-${src}` })).data.markdown;
    assert.match(md, /\*\*Tacos dorados\.\*\*\n\n\*\*Segunda línea\.\*\*/);
  });

  test(`${src}: format_text adds a link and bold without touching other runs`, async () => {
    put(`ft-${src}`, src);
    const r = await call("ws_docs_format_text", { path: `S/ft-${src}`, find: "piña", link_url: "https://example.org/piña", bold: true });
    assert.equal(r.data.formatted, 1);
    const md = (await call("ws_docs_read", { path: `S/ft-${src}` })).data.markdown;
    assert.match(md, /\[\*\*piña\*\*\]\(https:\/\/example\.org\/piña\)/);
    assert.equal((await call("ws_docs_format_text", { path: `S/ft-${src}`, find: "piña", link_url: "javascript:alert(1)" })).code, "bad_url");
    assert.equal((await call("ws_docs_format_text", { path: `S/ft-${src}`, find: "piña" })).code, "no_style");
  });

  test(`${src}: append keeps sectPr last and the result still opens in LibreOffice`, async () => {
    put(`ap-${src}`, src);
    await call("ws_docs_append", { path: `S/ap-${src}`, markdown: "## Postres\n\n| Día | Postre |\n|---|---|\n| Viernes | Flan & café |\n\n1. uno\n2. dos" });
    const blocks = await bodyBlocks(bytesOf(`S/ap-${src}`));
    assert.match(blocks.at(-1), /^<w:sectPr/);
    const md = (await call("ws_docs_read", { path: `S/ap-${src}` })).data.markdown;
    assert.match(md, /## Postres/); assert.match(md, /\| Viernes \| Flan & café \|/); assert.match(md, /1\. uno\n1\. dos/);
    const opened = sofficeOpens(bytesOf(`S/ap-${src}`), "docx");
    if (opened === null) console.log("# soffice not installed: LibreOffice smoke check skipped");
  });
}

test("insert_image embeds a drive image sized from its header", async () => {
  put("img.docx", "rich.docx");
  fake.addFile("S/dot.png", Buffer.from("89504e470d0a1a0a0000000d49484452000000c8000000640806000000", "hex").subarray(0, 24));
  const r = await call("ws_docs_insert_image", { path: "S/img.docx", image_path: "S/dot.png", index: 0, max_width_pt: 75 });
  assert.equal(r.success, true);
  const xml = partText(bytesOf("S/img.docx"), "word/document.xml");
  assert.match(xml, /<wp:extent cx="952500" cy="476250"\/>/); // 200x100 px scaled to 75 pt = 952500 EMU wide
  assert.equal((await call("ws_docs_insert_image", { path: "S/img.docx", image_path: "S/fr-rich.docx" })).code, "bad_image");
});

test("create dedupes by title and starts from the blank template", async () => {
  const a = await call("ws_docs_create", { folder: "S", title: "Menú", content: "# Semana 1\n\nTacos" });
  assert.equal(a.data.created, true); assert.equal(a.data.path, "S/Menú.docx");
  const b = await call("ws_docs_create", { folder: "S", title: "Menú.docx" });
  assert.equal(b.data.created, false);
  assert.match((await call("ws_docs_read", { path: "S/Menú.docx" })).data.markdown, /^# Semana 1/m);
});

test("no tool named like a full-document replace exists", async () => {
  const { client } = await connectWorkspace(fake);
  const names = (await client.listTools()).tools.map((t) => t.name);
  assert.ok(!names.some((n) => /^ws_docs_(replace|write|overwrite|set)(_all|_document)?$/.test(n)));
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- tests/workspace-docs-edit.test.js`
Expected: FAIL (tools not registered).

- [ ] **Step 3: Write `image-size.js` and `md-to-wml.js`**

`ooxml/image-size.js`:

```js
import { WsError } from "../result.js";
export function imageSize(b) {
  const u = Buffer.from(b);
  if (u.length >= 24 && u.readUInt32BE(0) === 0x89504e47) return { type: "png", width: u.readUInt32BE(16), height: u.readUInt32BE(20) };
  if (u.length >= 10 && u.toString("ascii", 0, 3) === "GIF") return { type: "gif", width: u.readUInt16LE(6), height: u.readUInt16LE(8) };
  if (u.length > 4 && u[0] === 0xff && u[1] === 0xd8) {
    let i = 2;
    while (i + 9 < u.length) {
      if (u[i] !== 0xff) { i++; continue; }
      const m = u[i + 1];
      if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return { type: "jpeg", height: u.readUInt16BE(i + 5), width: u.readUInt16BE(i + 7) };
      i += 2 + u.readUInt16BE(i + 2);
    }
  }
  throw new WsError("bad_image", "the image must be a PNG, JPEG or GIF file");
}
```

`ooxml/md-to-wml.js`:

```js
/**
 * Markdown → WordprocessingML blocks. Guardrail (D7 "heading-style reset"): every paragraph is built
 * fresh — plain paragraphs get NO w:pStyle (Normal) and NO w:numPr — so inserted text can never inherit
 * a neighbouring heading's or list's properties. Soft wraps fold; two trailing spaces or "\" break.
 */
import { marked } from "marked";
import { WsError } from "../result.js";
import { NS, el, kids, kid, attr, parseXml } from "./xml.js";
import { makeRun, preserve } from "./docx-model.js";
import { addRel, REL, partsOfType, setOverride } from "./opc.js";

const W = NS.w;
const unesc = (s) => String(s).replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
export const safeUrl = (u) => { const s = String(u || "").trim(); if (!/^(https?:|mailto:)/i.test(s)) throw new WsError("bad_url", "links must start with http://, https:// or mailto:"); return s; };

function inline(tokens, f = {}) {
  const out = [];
  for (const t of tokens || []) {
    if (t.type === "strong") out.push(...inline(t.tokens, { ...f, b: true }));
    else if (t.type === "em") out.push(...inline(t.tokens, { ...f, i: true }));
    else if (t.type === "link") out.push(...inline(t.tokens, { ...f, link: safeUrl(t.href) }));
    else if (t.type === "br") out.push({ ...f, br: true });
    else if (t.type === "del") out.push(...inline(t.tokens, f));
    else if ((t.type === "text" || t.type === "escape") && t.tokens) out.push(...inline(t.tokens, f));
    else if (t.text !== undefined) out.push({ ...f, text: unesc(t.text).replace(/\n/g, " ") });
  }
  return out;
}

function headingStyle(d, level) {
  const id = d.styles.idByName(`heading ${level}`);
  if (id) return id;
  if (!d.styles.doc) throw new WsError("malformed_document", "this document has no styles part");
  const sid = `Heading${level}`;
  const sizes = { 1: 32, 2: 26, 3: 24, 4: 22, 5: 22, 6: 22 };
  const style = el(d.styles.doc, W, "w:style", { "w:type": "paragraph", "w:styleId": sid }, [
    el(d.styles.doc, W, "w:name", { "w:val": `heading ${level}` }), el(d.styles.doc, W, "w:basedOn", { "w:val": "Normal" }), el(d.styles.doc, W, "w:next", { "w:val": "Normal" }), el(d.styles.doc, W, "w:qFormat"),
    el(d.styles.doc, W, "w:pPr", {}, [el(d.styles.doc, W, "w:keepNext"), el(d.styles.doc, W, "w:outlineLvl", { "w:val": level - 1 })]),
    el(d.styles.doc, W, "w:rPr", {}, [el(d.styles.doc, W, "w:b"), el(d.styles.doc, W, "w:sz", { "w:val": sizes[level] })]),
  ]);
  d.styles.doc.documentElement.appendChild(style);
  d.pkg.markDirty(d.styles.part);
  d.styles.byId.set(sid, { name: `heading ${level}`, type: "paragraph", basedOn: "Normal", outline: level - 1, numId: null, ilvl: 0 });
  return sid;
}

function numberingDoc(d) {
  if (d.numbering.doc) return d.numbering.doc;
  const part = "word/numbering.xml";
  const doc = parseXml(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<w:numbering xmlns:w="${W}"/>`, part);
  d.pkg.setXml(part, doc);
  addRel(d.pkg, d.part, REL.numbering, "numbering.xml");
  setOverride(d.pkg, part, "application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml");
  d.numbering.doc = doc; d.numbering.part = part;
  return doc;
}

function listNumId(d, ordered) {
  const doc = numberingDoc(d); const root = doc.documentElement; const want = ordered ? "decimal" : "bullet";
  let abs = kids(root, W, "abstractNum").find((a) => { const l0 = kids(a, W, "lvl").find((l) => attr(l, W, "ilvl") === "0"); return l0 && attr(kid(l0, W, "numFmt"), W, "val") === want; });
  if (!abs) {
    const id = Math.max(-1, ...kids(root, W, "abstractNum").map((a) => Number(attr(a, W, "abstractNumId")))) + 1;
    abs = el(doc, W, "w:abstractNum", { "w:abstractNumId": id }, [0, 1, 2].map((i) => el(doc, W, "w:lvl", { "w:ilvl": i }, [
      el(doc, W, "w:start", { "w:val": 1 }), el(doc, W, "w:numFmt", { "w:val": want }), el(doc, W, "w:lvlText", { "w:val": ordered ? `%${i + 1}.` : ["•", "◦", "▪"][i] }), el(doc, W, "w:lvlJc", { "w:val": "left" }),
      el(doc, W, "w:pPr", {}, [el(doc, W, "w:ind", { "w:left": 720 * (i + 1), "w:hanging": 360 })]),
    ])));
    root.insertBefore(abs, kids(root, W, "num")[0] || null);
  }
  const absId = attr(abs, W, "abstractNumId");
  if (!ordered) { const ex = kids(root, W, "num").find((n) => attr(kid(n, W, "abstractNumId"), W, "val") === absId); if (ex) return attr(ex, W, "numId"); }
  const numId = Math.max(0, ...kids(root, W, "num").map((n) => Number(attr(n, W, "numId")))) + 1;
  root.appendChild(el(doc, W, "w:num", { "w:numId": numId }, [el(doc, W, "w:abstractNumId", { "w:val": absId }), ordered ? el(doc, W, "w:lvlOverride", { "w:ilvl": 0 }, [el(doc, W, "w:startOverride", { "w:val": 1 })]) : null]));
  d.pkg.markDirty(d.numbering.part);
  return String(numId);
}

function runsInto(d, p, specs) {
  const doc = d.doc; const linkStyle = d.styles.idByName("Hyperlink");
  let link = null, host = p;
  for (const s of specs) {
    if ((s.link || null) !== link) {
      link = s.link || null;
      if (link) { host = el(doc, W, "w:hyperlink", { "r:id": addRel(d.pkg, d.part, REL.hyperlink, link, true) }); p.appendChild(host); } else host = p;
    }
    if (s.br) { host.appendChild(el(doc, W, "w:r", {}, [el(doc, W, "w:br")])); continue; }
    if (!s.text) continue;
    const rPr = el(doc, W, "w:rPr", {}, [
      s.link && linkStyle ? el(doc, W, "w:rStyle", { "w:val": linkStyle }) : null,
      s.b ? el(doc, W, "w:b") : null, s.i ? el(doc, W, "w:i") : null,
      s.link && !linkStyle ? el(doc, W, "w:color", { "w:val": "1155CC" }) : null, s.link && !linkStyle ? el(doc, W, "w:u", { "w:val": "single" }) : null,
    ]);
    host.appendChild(makeRun(doc, s.text, rPr.childNodes.length ? rPr : null));
  }
}

function para(d, { style, numId, ilvl = 0 }, specs) {
  const doc = d.doc;
  const pPr = el(doc, W, "w:pPr", {}, [style ? el(doc, W, "w:pStyle", { "w:val": style }) : null, numId ? el(doc, W, "w:numPr", {}, [el(doc, W, "w:ilvl", { "w:val": ilvl }), el(doc, W, "w:numId", { "w:val": numId })]) : null]);
  const p = el(doc, W, "w:p", {}, [pPr]);
  runsInto(d, p, specs);
  return p;
}

function table(d, t) {
  const doc = d.doc; const n = t.header.length; const tw = Math.floor(9000 / Math.max(1, n));
  const grid = d.styles.idByName("Table Grid");
  const border = (name) => el(doc, W, `w:${name}`, { "w:val": "single", "w:sz": 4, "w:space": 0, "w:color": "auto" });
  const tblPr = el(doc, W, "w:tblPr", {}, [grid ? el(doc, W, "w:tblStyle", { "w:val": grid }) : null, el(doc, W, "w:tblW", { "w:w": 0, "w:type": "auto" }), grid ? null : el(doc, W, "w:tblBorders", {}, ["top", "left", "bottom", "right", "insideH", "insideV"].map(border))]);
  const row = (cells, header) => el(doc, W, "w:tr", {}, cells.map((c) => el(doc, W, "w:tc", {}, [el(doc, W, "w:tcPr", {}, [el(doc, W, "w:tcW", { "w:w": tw, "w:type": "dxa" })]), para(d, {}, inline(c.tokens, header ? { b: true } : {}))])));
  return el(doc, W, "w:tbl", {}, [tblPr, el(doc, W, "w:tblGrid", {}, Array.from({ length: n }, () => el(doc, W, "w:gridCol", { "w:w": tw }))), row(t.header, true), ...t.rows.map((r) => row(r, false))]);
}

function blockInto(d, t, out, depth, listNum) {
  switch (t.type) {
    case "heading": out.push(para(d, { style: headingStyle(d, Math.min(t.depth, 6)) }, inline(t.tokens))); break;
    case "paragraph": out.push(para(d, {}, inline(t.tokens))); break;
    case "text": out.push(para(d, {}, inline(t.tokens || [{ type: "text", text: t.text }]))); break;
    case "list": {
      const numId = listNum?.ordered === t.ordered ? listNum.numId : listNumId(d, t.ordered);
      for (const item of t.items) {
        const [first, ...rest] = item.tokens;
        const lead = first && (first.type === "text" || first.type === "paragraph");
        out.push(para(d, { numId, ilvl: depth }, lead ? inline(first.tokens || [{ type: "text", text: first.text }]) : []));
        for (const sub of lead ? rest : item.tokens) blockInto(d, sub, out, sub.type === "list" ? Math.min(depth + 1, 2) : depth, { ordered: t.ordered, numId });
      }
      break;
    }
    case "table": out.push(table(d, t)); break;
    case "blockquote": for (const s of t.tokens) blockInto(d, s, out, depth, listNum); break;
    case "code": for (const line of t.text.split("\n")) out.push(para(d, {}, [{ text: line }])); break;
    default: break; // space, hr, html, def: no output
  }
}

export function markdownToBlocks(d, md) {
  const out = [];
  for (const t of marked.lexer(String(md ?? "").replace(/\r\n?/g, "\n"), { gfm: true })) blockInto(d, t, out, 0, null);
  return out;
}
export { preserve };
```

- [ ] **Step 4: Write `docx-edit.js`**

```js
import { WsError } from "../result.js";
import { NS, kids, kid, el, attr, insertAfter, removeNode, parseXml } from "./xml.js";
import { textMap, runsOf, paragraphText, topBlocks, allParagraphs, makeRun, preserve, setOrdered, RPR_ORDER } from "./docx-model.js";
import { sectionRange } from "./docx-read.js";
import { markdownToBlocks, safeUrl } from "./md-to-wml.js";
import { addRel, REL, ensureDefault } from "./opc.js";
import { imageSize } from "./image-size.js";

const W = NS.w;
const KEEP_ON_REWRITE = new Set(["pPr", "bookmarkStart", "bookmarkEnd", "commentRangeStart", "commentRangeEnd", "proofErr"]);

function normalizeParagraph(p) { for (const g of textMap(p).segs) { const n = g.t.textContent.normalize("NFC"); if (n !== g.t.textContent) g.t.textContent = n; } }
function findHits(p, find, matchCase) {
  let { text } = textMap(p);
  if (text.normalize("NFC") !== text) { if (!text.normalize("NFC").includes(find) && !(matchCase ? false : text.normalize("NFC").toLowerCase().includes(find.toLowerCase()))) return { hits: [], map: null }; normalizeParagraph(p); }
  const map = textMap(p); text = map.text;
  const hay = matchCase ? text : text.toLowerCase(); const needle = matchCase ? find : find.toLowerCase();
  const usable = hay.length === text.length;
  const H = usable ? hay : text, N = usable ? needle : find;
  const hits = []; let i = 0;
  while (N && (i = H.indexOf(N, i)) !== -1) { if (!text.slice(i, i + N.length).includes("\u0000")) hits.push(i); i += N.length; }
  return { hits, map };
}

function spliceText(segs, start, end, repl) {
  const hit = segs.filter((g) => g.end > start && g.start < end);
  if (!hit.length) return;
  const first = hit[0];
  const tail = end <= first.end ? first.t.textContent.slice(end - first.start) : "";
  first.t.textContent = first.t.textContent.slice(0, start - first.start) + repl + tail; preserve(first.t);
  for (const g of hit.slice(1)) {
    g.t.textContent = g.t.textContent.slice(Math.min(end, g.end) - g.start); preserve(g.t);
    if (!g.t.textContent) { removeNode(g.t); if (!kids(g.run, W).some((c) => c.localName !== "rPr")) removeNode(g.run); }
  }
}

export function findReplace(d, pairs, matchCase = true) {
  const results = []; let total = 0;
  for (const pr of pairs) {
    const find = String(pr.find ?? "").normalize("NFC"); const repl = String(pr.replace ?? "").normalize("NFC");
    if (!find) throw new WsError("bad_args", "find text cannot be empty");
    const mc = pr.match_case ?? matchCase; let count = 0;
    for (const { p, part } of allParagraphs(d)) {
      const { hits, map } = findHits(p, find, mc);
      if (!hits.length) continue;
      for (const s of [...hits].reverse()) spliceText(map.segs, s, s + find.length, repl);
      count += hits.length; d.pkg.markDirty(part);
    }
    results.push({ find: pr.find, occurrences: count }); total += count;
  }
  return { results, total };
}

export function setParagraphText(d, p, text) {
  const lines = String(text).normalize("NFC").split("\n");
  const pPr = kid(p, W, "pPr");
  const firstRun = runsOf(p)[0]; const rPr = firstRun ? kid(firstRun, W, "rPr") : null; const rPrCopy = rPr ? rPr.cloneNode(true) : null;
  for (const c of kids(p, W)) {
    if (KEEP_ON_REWRITE.has(c.localName)) continue;
    if (c.localName === "r" && kids(c, W, "commentReference").length) continue;
    removeNode(c);
  }
  const anchor = kids(p, W, "commentRangeEnd")[0] || null;
  p.insertBefore(makeRun(d.doc, lines[0], rPrCopy), anchor);
  let prev = p;
  for (const line of lines.slice(1)) {
    const np = el(d.doc, W, "w:p");
    if (pPr) { const c = pPr.cloneNode(true); for (const s of kids(c, W, "sectPr")) c.removeChild(s); np.appendChild(c); }
    np.appendChild(makeRun(d.doc, line, rPrCopy));
    insertAfter(np, prev); prev = np;
  }
  d.pkg.markDirty(d.part);
}

export function rewritePassages(d, passages) {
  const used = new Set(); const paras = kids(d.body, W, "p");
  const results = passages.map((ps) => {
    const prefix = String(ps.match_prefix ?? "").normalize("NFC").trim().slice(0, 100);
    if (!prefix) return { match_prefix: ps.match_prefix, matched: false, reason: "Empty match_prefix" };
    const p = paras.find((x) => !used.has(x) && paragraphText(x).normalize("NFC").replace(/^\s+/, "").startsWith(prefix));
    if (!p) return { match_prefix: ps.match_prefix, matched: false, reason: "No paragraph starts with this prefix" };
    used.add(p); const original_length = paragraphText(p).length;
    setParagraphText(d, p, ps.new_text);
    return { match_prefix: ps.match_prefix, matched: true, original_length, new_length: String(ps.new_text).length };
  });
  return { results };
}

function splitRun(run, tNode, offset) {
  const doc = run.ownerDocument; const text = tNode.textContent;
  if (offset <= 0 || offset >= text.length) return;
  const nr = el(doc, W, "w:r"); const rPr = kid(run, W, "rPr"); if (rPr) nr.appendChild(rPr.cloneNode(true));
  const nt = el(doc, W, "w:t", {}, [text.slice(offset)]); preserve(nt); nr.appendChild(nt);
  let sib = tNode.nextSibling; while (sib) { const next = sib.nextSibling; nr.appendChild(sib); sib = next; }
  tNode.textContent = text.slice(0, offset); preserve(tNode);
  insertAfter(nr, run);
}
function isolate(p, start, end) {
  for (const pos of [end, start]) { const g = textMap(p).segs.find((s) => s.start < pos && pos < s.end); if (g) splitRun(g.run, g.t, pos - g.start); }
  return [...new Set(textMap(p).segs.filter((s) => s.start >= start && s.end <= end && s.end > s.start).map((s) => s.run))];
}

export function formatText(d, find, occurrence, style) {
  const keys = ["bold", "italic", "underline", "link_url", "color_hex"].filter((k) => style[k] !== undefined && style[k] !== null);
  if (!keys.length) throw new WsError("no_style", "give at least one of bold, italic, underline, link_url, color_hex");
  if (style.color_hex !== undefined && !/^#?[0-9a-fA-F]{6}$/.test(style.color_hex)) throw new WsError("bad_color", "color_hex must be 6 hex digits");
  const url = style.link_url !== undefined ? safeUrl(style.link_url) : null;
  const needle = String(find).normalize("NFC");
  const all = [];
  for (const { p, part } of allParagraphs(d)) for (const h of findHits(p, needle, true).hits) all.push({ p, part, h });
  if (!all.length) throw new WsError("not_found", `"${find}" was not found`);
  const chosen = occurrence === -1 ? all : [all[occurrence]].filter(Boolean);
  if (!chosen.length) throw new WsError("bad_args", `occurrence ${occurrence} is out of range (found ${all.length})`);
  for (const { p, part, h } of [...chosen].reverse()) {
    const runs = isolate(p, h, h + needle.length);
    for (const r of runs) {
      let rPr = kid(r, W, "rPr"); if (!rPr) { rPr = el(d.doc, W, "w:rPr"); r.insertBefore(rPr, r.firstChild); }
      const tog = (name, v) => setOrdered(rPr, RPR_ORDER, name, v === undefined ? kid(rPr, W, name) : v ? el(r.ownerDocument, W, `w:${name}`) : el(r.ownerDocument, W, `w:${name}`, { "w:val": "0" }));
      if (style.bold !== undefined) tog("b", style.bold);
      if (style.italic !== undefined) tog("i", style.italic);
      if (style.underline !== undefined) setOrdered(rPr, RPR_ORDER, "u", el(r.ownerDocument, W, "w:u", { "w:val": style.underline ? "single" : "none" }));
      if (style.color_hex !== undefined) setOrdered(rPr, RPR_ORDER, "color", el(r.ownerDocument, W, "w:color", { "w:val": style.color_hex.replace("#", "").toUpperCase() }));
    }
    if (url) {
      const parents = new Set(runs.map((r) => r.parentNode));
      const relId = addRel(d.pkg, part, REL.hyperlink, url, true);
      if (parents.size === 1 && [...parents][0].localName === "hyperlink") [...parents][0].setAttributeNS(NS.r, "r:id", relId);
      else if ([...parents].some((x) => x.localName === "hyperlink")) throw new WsError("bad_args", "part of that text is already a link");
      else { const h = el(r0doc(runs), W, "w:hyperlink", { "r:id": relId }); runs[0].parentNode.insertBefore(h, runs[0]); for (const r of runs) h.appendChild(r); }
    }
    d.pkg.markDirty(part);
  }
  return chosen.length;
}
const r0doc = (runs) => runs[0].ownerDocument;

export function insertBlocksAt(d, before, nodes) { for (const n of nodes) d.body.insertBefore(n, before); d.pkg.markDirty(d.part); }
const sectPr = (d) => kids(d.body, W, "sectPr").at(-1) || null;
export function appendMarkdown(d, md) { const nodes = markdownToBlocks(d, md); insertBlocksAt(d, sectPr(d), nodes); return nodes.length; }
export function insertAtHeading(d, heading, md) {
  const r = sectionRange(d, heading); const blocks = topBlocks(d);
  const nodes = markdownToBlocks(d, md); insertBlocksAt(d, blocks[r.start].nextSibling, nodes); return nodes.length;
}
export function replaceSection(d, heading, md) {
  const r = sectionRange(d, heading); const blocks = topBlocks(d);
  const removed = blocks.slice(r.start + 1, r.end);
  const before = blocks[r.end] || sectPr(d);
  for (const b of removed) removeNode(b);
  const nodes = markdownToBlocks(d, md); insertBlocksAt(d, before, nodes);
  return { removed: removed.length, inserted: nodes.length };
}

export function insertImage(d, bytes, { anchorText, index = 0, maxWidthPt = 450 }) {
  const { type, width, height } = imageSize(bytes);
  const ext = type === "jpeg" ? "jpeg" : type;
  let n = 1; while (d.pkg.has(`word/media/crow-image-${n}.${ext}`)) n++;
  const part = `word/media/crow-image-${n}.${ext}`;
  d.pkg.setBytes(part, new Uint8Array(bytes));
  ensureDefault(d.pkg, ext, `image/${type}`);
  const rid = addRel(d.pkg, d.part, REL.image, `media/crow-image-${n}.${ext}`);
  const pxW = width * 9525, pxH = height * 9525; const maxW = Math.round(maxWidthPt * 12700);
  const cx = Math.min(pxW, maxW); const cy = Math.round(pxH * (cx / pxW));
  const docPrId = Math.max(0, ...Array.from(d.doc.getElementsByTagNameNS(NS.wp, "docPr")).map((e) => Number(e.getAttribute("id")) || 0)) + 1;
  const frag = parseXml(`<w:r xmlns:w="${W}" xmlns:wp="${NS.wp}" xmlns:a="${NS.a}" xmlns:pic="${NS.pic}" xmlns:r="${NS.r}"><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${docPrId}" name="Picture ${docPrId}"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="crow-image-${n}.${ext}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`, "image-run");
  const run = d.doc.importNode(frag.documentElement, true);
  if (anchorText) {
    for (const { p } of allParagraphs(d)) {
      const g = textMap(p).segs.find((s) => s.t.textContent.includes(anchorText));
      if (!g) continue;
      const off = g.t.textContent.indexOf(anchorText);
      splitRun(g.run, g.t, off + anchorText.length); splitRun(g.run, g.t, off);
      const target = off > 0 ? g.run.nextSibling : g.run;
      target.parentNode.replaceChild(run, target); d.pkg.markDirty(d.part); return { placed: "anchor" };
    }
    throw new WsError("not_found", `anchor_text "${anchorText}" was not found inside a single run`);
  }
  const blocks = topBlocks(d); const p = el(d.doc, W, "w:p", {}, [el(d.doc, W, "w:pPr"), run]);
  insertBlocksAt(d, blocks[Math.max(0, Math.min(index, blocks.length))] || sectPr(d), [p]);
  return { placed: "index" };
}
```

- [ ] **Step 5: Write `docsWriteDefs` in `tools/docs.js` and register**

Merge these imports with the ones already at the top of `tools/docs.js` (`writeOpts` and `z` are already imported there; do not import them twice).

```js
import { readFileSync } from "node:fs";
import { findReplace, rewritePassages, formatText, appendMarkdown, insertAtHeading, replaceSection, insertImage } from "../ooxml/docx-edit.js";
import { openDocx as openBlank } from "../ooxml/docx-model.js";
import { createFile } from "../write-protocol.js";
import { splitFolder, splitPath } from "../nc/paths.js";
import { uniqueName } from "./drive.js";

const TEMPLATE = (ext) => readFileSync(new URL(`../templates/blank.${ext}`, import.meta.url));
const MAX_IMAGE = 5 * 1024 * 1024;
const pairsSchema = z.array(z.object({ find: z.string().min(1).max(2000), replace: z.string().max(20000), match_case: z.boolean().optional() })).min(1).max(200);

export const docsWriteDefs = [
  { name: "ws_docs_find_replace", description: "Find/replace text in a .docx, keeping formatting. Batch mode (pairs) is atomic: one save, one version. Covers body, tables, headers and footers.",
    schema: { ...fileRef, find: z.string().min(1).max(2000).optional(), replace: z.string().max(20000).optional(), match_case: z.boolean().optional().default(true), pairs: pairsSchema.optional(), ...writeOpts },
    run: (args, ctx) => {
      const pairs = args.pairs || (args.find !== undefined && args.replace !== undefined ? [{ find: args.find, replace: args.replace }] : null);
      if (!pairs) throw new WsError("bad_args", "Provide find+replace or pairs");
      return docxWrite(ctx, args, (d) => { const r = findReplace(d, pairs, args.match_case); return { changed: r.total, summary: `replace ${pairs.map((p) => `"${p.find}"`).join(", ")}`, data: { results: r.results, total_changes: r.total } }; });
    } },
  { name: "ws_docs_append", description: "Append markdown at the end of a .docx (headings, lists, bold/italic, links, tables).",
    schema: { ...fileRef, markdown: z.string().min(1).max(200000), ...writeOpts },
    run: (args, ctx) => docxWrite(ctx, args, (d) => ({ changed: appendMarkdown(d, args.markdown), summary: "append text", data: {} })) },
  { name: "ws_docs_insert_at_heading", description: "Insert markdown right after a heading. Inserted text never inherits the heading style.",
    schema: { ...fileRef, heading: z.string().min(1).max(500), markdown: z.string().min(1).max(200000), ...writeOpts },
    run: (args, ctx) => docxWrite(ctx, args, (d) => ({ changed: insertAtHeading(d, args.heading, args.markdown), summary: `insert under "${args.heading}"`, data: { heading_inheritance_fix_applied: true } })) },
  { name: "ws_docs_replace_section", description: "Replace everything between a heading and the next heading of the same or higher level (subsections included). Atomic. The heading itself is kept.",
    schema: { ...fileRef, heading: z.string().min(1).max(500), markdown: z.string().max(200000), ...writeOpts },
    run: (args, ctx) => docxWrite(ctx, args, (d) => { const r = replaceSection(d, args.heading, args.markdown); return { changed: r.removed + r.inserted || 1, summary: `replace section "${args.heading}"`, data: { removed_blocks: r.removed, inserted_blocks: r.inserted, heading_inheritance_fix_applied: true } }; }) },
  { name: "ws_docs_rewrite_passages", description: "Rewrite whole paragraphs found by the start of their text (match_prefix, ≤100 chars, case-sensitive). Keeps paragraph style and the first run's formatting. Atomic.",
    schema: { ...fileRef, passages: z.array(z.object({ match_prefix: z.string().max(1000), new_text: z.string().max(20000) })).min(1).max(100), ...writeOpts },
    run: (args, ctx) => docxWrite(ctx, args, (d) => { const r = rewritePassages(d, args.passages); const n = r.results.filter((x) => x.matched).length; return { changed: n, summary: `rewrite ${n} paragraph(s)`, data: { total_passages: args.passages.length, matched: n, results: r.results } }; }) },
  { name: "ws_docs_format_text", description: "Style matching text: bold, italic, underline, color_hex, or link_url (http/https/mailto). occurrence 0 = first, -1 = all.",
    schema: { ...fileRef, find: z.string().min(1).max(2000), occurrence: z.number().int().min(-1).optional().default(0), bold: z.boolean().optional(), italic: z.boolean().optional(), underline: z.boolean().optional(), link_url: z.string().max(2000).optional(), color_hex: z.string().max(7).optional(), ...writeOpts },
    run: (args, ctx) => docxWrite(ctx, args, (d) => { const n = formatText(d, args.find, args.occurrence, args); return { changed: n, summary: `format "${args.find}"`, data: { formatted: n } }; }) },
  { name: "ws_docs_insert_image", description: "Insert a PNG/JPEG/GIF from the drive (≤5 MB) replacing anchor_text, or before body block `index`.",
    schema: { ...fileRef, image_path: z.string().max(4096), anchor_text: z.string().max(500).optional(), index: z.number().int().min(0).optional(), max_width_pt: z.number().min(10).max(2000).optional().default(450), ...writeOpts },
    run: async (args, ctx) => {
      const cfg = ctx.getConfig();
      const img = await getFile(cfg, splitPath(args.image_path), { maxBytes: MAX_IMAGE });
      return docxWrite(ctx, args, (d) => ({ changed: 1, summary: "insert image", data: insertImage(d, img.bytes, { anchorText: args.anchor_text, index: args.index, maxWidthPt: args.max_width_pt }) }));
    } },
  { name: "ws_docs_create", description: "Create a .docx in a folder from the blank template, optionally with markdown content. Dedupes by title unless find_existing is false.",
    schema: { folder: z.string().max(4096), title: z.string().min(1).max(200), content: z.string().max(200000).optional().default(""), find_existing: z.boolean().optional().default(true) },
    run: async (args, ctx) => {
      const cfg = ctx.getConfig(); const folder = splitFolder(args.folder);
      const base = args.title.normalize("NFC").replace(/\.docx$/i, "");
      let name = `${base}.docx`;
      if (args.find_existing) { try { const e = await stat(cfg, [...folder, name]); return { created: false, path: e.path, file_id: e.fileId }; } catch (e) { if (e.code !== "not_found") throw e; } }
      else name = await uniqueName(cfg, folder, name);
      const d = openBlank(TEMPLATE("docx"));
      if (args.content) appendMarkdown(d, args.content);
      return { created: true, ...(await createFile(cfg, folder, name, d.pkg.save(), { summary: `create ${name}`, clock: ctx.clock })) };
    } },
];
```

(`ws_docs_create`'s `checkName` rules apply through `splitFolder`/`createFile`. A title containing `/` is refused: add `if (/[\/\\]/.test(base)) throw new WsError("bad_path", "titles cannot contain / or \\")` before building `name`.)

In `server.js`: `names.push(...registerDocs(server, ctx, docsWriteDefs));`.

- [ ] **Step 6: Run the tests**

Run: `npm test -- tests/workspace-docs-edit.test.js tests/workspace-docs-read.test.js`
Expected: PASS. On crow, the soffice smoke check runs. In CI it logs `# soffice not installed`.

- [ ] **Step 7: Commit**

```bash
git add bundles/workspace/server/ooxml/md-to-wml.js bundles/workspace/server/ooxml/docx-edit.js bundles/workspace/server/ooxml/image-size.js tests/workspace-docs-edit.test.js
git commit bundles/workspace/server tests/workspace-docs-edit.test.js -m "feat(workspace): Docs edit tools with the Google MCP guardrails (atomic batch, heading reset, heading-to-heading sections)"
git show --stat HEAD
```

---
### Task 8: Sheets tools (.xlsx)

**Files:**
- Create: `bundles/workspace/server/ooxml/{xlsx.js,xlsx-format.js}`, `bundles/workspace/server/tools/sheets.js`
- Modify: `bundles/workspace/server/server.js`
- Test: `tests/workspace-sheets.test.js`

**Interfaces:**
- Consumes: `OoxmlPackage`, OPC helpers, `withFileWrite`, `createFile`, `uniqueName`, `loadDocx`-style loader pattern.
- Produces `xlsx.js`:
  - `openXlsx(bytes) → Wb {pkg, part, doc, sheets:[{name, sheetId, rid, part, state, index}], sst, styles}`
  - `parseRange(wb, str) → {sheet, r1, c1, r2, c2}`, `colName(n)`, `parseA1(ref)`
  - `readRange(wb, range, mode) → {values, stale_formulas}`
  - `writeRange(wb, range, values, inputOption) → cellsWritten`, `appendRows(wb, sheetName, values, inputOption) → {range, rows}`
  - `addTab`, `renameTab`, `deleteTab`, `setNumberFormat(wb, range, pattern) → cells`, `tabsInfo(wb)`
  - `markRecalc(wb)`
- Produces `xlsx-format.js`: `formatValue(raw, kind, fmt) → string` (kind = "n"|"s"|"b"|"e"; fmt = {id, code}).
- Produces `tools/sheets.js`: `sheetsDefs`, `registerSheets(server, ctx)`.

- [ ] **Step 1: Write the failing tests**

`tests/workspace-sheets.test.js`:

```js
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startFakeNextcloud } from "./helpers/workspace-fake-nextcloud.js";
import { connectWorkspace } from "./helpers/workspace-client.js";
import { assertOnlyPartsChanged, partText } from "./helpers/ooxml-assert.js";
import { OoxmlPackage } from "../bundles/workspace/server/ooxml/zip.js";

const FIX = join(import.meta.dirname, "fixtures", "workspace");
let fake, call, close;
const bytesOf = (p) => fake.node(p).bytes;
const put = (name, src) => fake.addFile(`S/${name}`, readFileSync(join(FIX, src)), { owner: "admin" });
const puts = () => fake.calls.filter((c) => c.method === "PUT").length;
before(async () => { fake = await startFakeNextcloud(); fake.addFolder("S", { owner: "admin" }); ({ call, close } = await connectWorkspace(fake)); });
after(async () => { await close(); fake.close(); });

test("rich.xlsx: formatted read; openpyxl formulas have no cached value → stale_formulas", async () => {
  put("r.xlsx", "rich.xlsx");
  const r = await call("ws_sheets_read", { path: "S/r.xlsx", range: "Recetas!A1:E2" });
  assert.deepEqual(r.data.values[0], ["Nombre", "Porciones", "Costo", "Fecha", "Total"]);
  assert.equal(r.data.values[1][2], "12.50");
  assert.equal(r.data.stale_formulas, true);
  const f = await call("ws_sheets_read", { path: "S/r.xlsx", range: "Recetas!E2", value_render_option: "FORMULA" });
  assert.equal(f.data.values[0][0], "=B2*C2");
  assert.equal((await call("ws_sheets_read", { path: "S/r.xlsx", range: "Recetas!A1", value_render_option: "PRETTY" })).success, false);
});

test("oo-rich.xlsx (ONLYOFFICE-saved): cached values are present and formatted", async () => {
  put("o.xlsx", "oo-rich.xlsx");
  const r = await call("ws_sheets_read", { path: "S/o.xlsx", range: "Recetas!E2:E4" });
  assert.deepEqual(r.data.values.map((x) => x[0]), ["50", "120", "61"]);
  assert.equal(r.data.stale_formulas, false);
  const t = await call("ws_sheets_read", { path: "S/o.xlsx", range: "'Menú semanal'!A1:B1" });
  assert.deepEqual(t.data.values[0], ["Jueves", "Tacos"]);
});

test("write keeps cell styles, sets fullCalcOnLoad, drops calcChain, touches only the sheet/workbook parts", async () => {
  put("w.xlsx", "oo-rich.xlsx");
  const before = bytesOf("S/w.xlsx");
  const r = await call("ws_sheets_write", { path: "S/w.xlsx", range: "Recetas!B2:C2", values: [5, "13.75"] });
  assert.equal(r.data.updated_cells, 2); assert.ok(r.data.version_id);
  const after = bytesOf("S/w.xlsx");
  assertOnlyPartsChanged(before, after, [/^xl\/worksheets\/sheet\d+\.xml$/, "xl/workbook.xml", "xl/calcChain.xml", "[Content_Types].xml", "xl/_rels/workbook.xml.rels"]);
  assert.match(partText(after, "xl/workbook.xml"), /fullCalcOnLoad="1"/);
  assert.ok(!OoxmlPackage.open(after).has("xl/calcChain.xml"));
  const sheetBefore = partText(before, "xl/worksheets/sheet1.xml").match(/<c r="C2"[^>]*s="(\d+)"/)[1];
  assert.match(partText(after, "xl/worksheets/sheet1.xml"), new RegExp(`<c r="C2"[^>]*s="${sheetBefore}"`));
  assert.equal((await call("ws_sheets_read", { path: "S/w.xlsx", range: "Recetas!C2" })).data.values[0][0], "13.75");
});

test("write beyond used range keeps row order and grows <dimension> (Review Focus 5)", async () => {
  put("b.xlsx", "rich.xlsx");
  await call("ws_sheets_write", { path: "S/b.xlsx", range: "Recetas!A10", values: [["Flan", 6]] });
  const xml = partText(bytesOf("S/b.xlsx"), "xl/worksheets/sheet1.xml");
  const rows = [...xml.matchAll(/<row r="(\d+)"/g)].map((m) => Number(m[1]));
  assert.deepEqual(rows, [...rows].sort((a, b) => a - b));
  assert.match(xml, /<dimension ref="A1:E10"\/>/);
});

test("refuses merged non-anchor; refuses partial shared-formula overwrite (Review Focus 5)", async () => {
  put("m.xlsx", "rich.xlsx");
  const m = await call("ws_sheets_write", { path: "S/m.xlsx", range: "Recetas!B6", values: [["x"]] });
  assert.equal(m.code, "merged_cell"); assert.match(m.error, /A6/);
  assert.equal((await call("ws_sheets_write", { path: "S/m.xlsx", range: "Recetas!A6", values: [["ok"]] })).success, true);
  const pkg = OoxmlPackage.open(bytesOf("S/m.xlsx"));
  const x = pkg.text("xl/worksheets/sheet1.xml").replace(/<row r="(\d+)"([^>]*)>([\s\S]*?)<\/row>/g, (m, r, a, inner) => {
    if (r === "2") return `<row r="2"${a}>${inner}<c r="F2"><f t="shared" ref="F2:F4" si="0">B2+1</f></c></row>`;
    if (r === "3" || r === "4") return `<row r="${r}"${a}>${inner}<c r="F${r}"><f t="shared" si="0"/></c></row>`;
    return m;
  });
  const { strToU8 } = await import("fflate"); pkg.setBytes("xl/worksheets/sheet1.xml", strToU8(x));
  fake.addFile("S/sf.xlsx", Buffer.from(pkg.save()));
  const part = await call("ws_sheets_write", { path: "S/sf.xlsx", range: "Recetas!F3", values: [["1"]] });
  assert.equal(part.code, "shared_formula"); assert.match(part.error, /F2:F4/);
  assert.equal((await call("ws_sheets_read", { path: "S/sf.xlsx", range: "Recetas!F3", value_render_option: "FORMULA" })).data.values[0][0], "=B3+1");
  assert.equal((await call("ws_sheets_write", { path: "S/sf.xlsx", range: "Recetas!F2:F4", values: [[1], [2], [3]] })).success, true);
});

test("USER_ENTERED vs RAW; text-formatted cells keep leading zeros", async () => {
  put("u.xlsx", "rich.xlsx");
  await call("ws_sheets_set_number_format", { path: "S/u.xlsx", range: "Recetas!A20" });
  await call("ws_sheets_write", { path: "S/u.xlsx", range: "Recetas!A20:D20", values: [["007", "=B2*2", "TRUE", "3.5"]] });
  const r = await call("ws_sheets_read", { path: "S/u.xlsx", range: "Recetas!A20:D20", value_render_option: "FORMULA" });
  assert.deepEqual(r.data.values[0], ["007", "=B2*2", true, 3.5]);
  await call("ws_sheets_write", { path: "S/u.xlsx", range: "Recetas!A21:B21", values: [["=1+1", 4]], value_input_option: "RAW" });
  assert.deepEqual((await call("ws_sheets_read", { path: "S/u.xlsx", range: "Recetas!A21:B21", value_render_option: "UNFORMATTED_VALUE" })).data.values[0], ["=1+1", 4]);
});

test("append maps dicts by header row and refuses unknown keys", async () => {
  put("a.xlsx", "rich.xlsx");
  const r = await call("ws_sheets_append", { path: "S/a.xlsx", sheet_name: "Recetas", values: [{ Nombre: "Mole", Porciones: 8 }, { Nombre: "Sopa", Costo: 3 }] });
  assert.equal(r.data.range, "Recetas!A7:E8");
  const bad = await call("ws_sheets_append", { path: "S/a.xlsx", sheet_name: "Recetas", values: [{ Sabor: "x" }] });
  assert.equal(bad.code, "bad_args"); assert.match(bad.error, /Nombre/);
  assert.equal((await call("ws_sheets_append", { path: "S/a.xlsx", sheet_name: "Recetas", values: [] })).code, "bad_args");
});

test("tabs: add, rename rewrites formulas and chart refs, delete; get_tabs reports frozen panes", async () => {
  put("t.xlsx", "rich.xlsx");
  await call("ws_sheets_add_tab", { path: "S/t.xlsx", title: "Compras" });
  await call("ws_sheets_rename_tab", { path: "S/t.xlsx", title: "Recetas", new_title: "Recetas 2026" });
  const b = bytesOf("S/t.xlsx");
  assert.match(partText(b, "xl/worksheets/sheet2.xml"), /'Recetas 2026'!A2/);
  const chartPart = Object.keys((await import("fflate")).unzipSync(new Uint8Array(b))).find((n) => /^xl\/charts\/chart\d+\.xml$/.test(n));
  assert.match(partText(b, chartPart), /'Recetas 2026'!\$C\$1/);
  const tabs = await call("ws_sheets_get_tabs", { path: "S/t.xlsx" });
  assert.deepEqual(tabs.data.tabs.map((t) => t.title), ["Recetas 2026", "Menú semanal", "Compras"]);
  assert.equal(tabs.data.tabs[0].frozen_rows, 1);
  assert.equal((await call("ws_sheets_delete_tab", { path: "S/t.xlsx", title: "Compras" })).success, true);
  assert.equal((await call("ws_sheets_add_tab", { path: "S/t.xlsx", title: "bad/name" })).code, "bad_args");
});

test("batch_update applies typed ops in one version; create with tabs; last tab cannot be deleted", async () => {
  put("bu.xlsx", "rich.xlsx");
  const p0 = puts();
  const r = await call("ws_sheets_batch_update", { path: "S/bu.xlsx", ops: [{ op: "add_tab", title: "X" }, { op: "write", range: "X!A1", values: [["hola"]] }, { op: "rename_tab", title: "X", new_title: "Y" }] });
  assert.equal(r.success, true); assert.equal(puts() - p0, 1);
  const c = await call("ws_sheets_create", { title: "Índice de recetas", folder: "S", tabs: ["Recetas"] });
  assert.equal(c.data.created, true);
  assert.equal((await call("ws_sheets_delete_tab", { path: c.data.path, title: "Recetas" })).code, "last_tab");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- tests/workspace-sheets.test.js`
Expected: FAIL. The asserted E2:E4 values (50, 120, 61) come from the fixture (4×12.5, 6×20, 4×15.25). Confirm them against `oo-rich.xlsx` after Task 1.

- [ ] **Step 3: Write `xlsx-format.js`**

```js
/** Display formatting for common number formats (spec §4.5). Unknown formats fall back to the raw value. */
const BUILTIN = { 0: "General", 1: "0", 2: "0.00", 3: "#,##0", 4: "#,##0.00", 9: "0%", 10: "0.00%", 11: "0.00E+00", 14: "yyyy-mm-dd", 15: "d-mmm-yy", 16: "d-mmm", 17: "mmm-yy", 18: "h:mm AM/PM", 19: "h:mm:ss AM/PM", 20: "h:mm", 21: "h:mm:ss", 22: "yyyy-mm-dd h:mm", 49: "@" };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const codeFor = (id, custom) => custom ?? BUILTIN[id] ?? "General";
const strip = (code) => code.replace(/"[^"]*"/g, "").replace(/\[[^\]]*\]/g, "").replace(/\\./g, "");
export const isDateCode = (code) => { const c = strip(code); return /[ydhms]/i.test(c) && !/[0#?]/.test(c) && !/^(General|@)$/i.test(code); };
export function serialToDate(n) { return new Date(Math.round((n - 25569) * 86400000)); }
export function dateToSerial(y, m, d) { return Date.UTC(y, m - 1, d) / 86400000 + 25569; }
const pad = (n, w = 2) => String(n).padStart(w, "0");

function fmtDate(n, code) {
  const dt = serialToDate(n); const c = strip(code.split(";")[0]);
  const ampm = /AM\/PM/i.test(c);
  let out = ""; const toks = c.match(/yyyy|yy|mmmm|mmm|mm|m|dd|d|hh|h|ss|s|AM\/PM|./gi) || [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]; const low = t.toLowerCase();
    const prevH = toks.slice(0, i).reverse().find((x) => /^[hdsym]/i.test(x)); const nextS = toks.slice(i + 1).find((x) => /^[hdsym]/i.test(x));
    const minute = (low === "mm" || low === "m") && ((prevH && /^h/i.test(prevH)) || (nextS && /^s/i.test(nextS)));
    const H = dt.getUTCHours();
    if (low === "yyyy") out += dt.getUTCFullYear(); else if (low === "yy") out += pad(dt.getUTCFullYear() % 100);
    else if (low === "mmmm") out += new Date(dt).toLocaleString("en", { month: "long", timeZone: "UTC" });
    else if (low === "mmm") out += MONTHS[dt.getUTCMonth()];
    else if (minute) out += low === "mm" ? pad(dt.getUTCMinutes()) : dt.getUTCMinutes();
    else if (low === "mm") out += pad(dt.getUTCMonth() + 1); else if (low === "m") out += dt.getUTCMonth() + 1;
    else if (low === "dd") out += pad(dt.getUTCDate()); else if (low === "d") out += dt.getUTCDate();
    else if (low === "hh") out += pad(ampm ? (H % 12 || 12) : H); else if (low === "h") out += ampm ? (H % 12 || 12) : H;
    else if (low === "ss") out += pad(dt.getUTCSeconds()); else if (low === "s") out += dt.getUTCSeconds();
    else if (low === "am/pm") out += H < 12 ? "AM" : "PM";
    else out += t;
  }
  return out;
}

function fmtNumber(n, code) {
  const sec = code.split(";"); const c = (n < 0 && sec[1]) ? sec[1] : sec[0];
  const lit = (c.match(/"([^"]*)"|\[\$([^\]-]*)[^\]]*\]|\\(.)/g) || []).map((x) => x.replace(/^"|"$/g, "").replace(/^\[\$([^\]-]*).*\]$/, "$1").replace(/^\\/, ""));
  const core = strip(c);
  const pct = core.includes("%"); const sci = /E\+/i.test(core);
  const dec = ((core.split(".")[1] || "").match(/[0#]/g) || []).length;
  const v = Math.abs(pct ? n * 100 : n) * (n < 0 && sec[1] ? 1 : 1);
  let s = sci ? v.toExponential(dec).toUpperCase().replace(/E\+?(-?)(\d)$/, "E+$10$2") : v.toFixed(dec);
  if (core.includes(",") && !sci) { const [i, f] = s.split("."); s = i.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (f !== undefined ? `.${f}` : ""); }
  const prefix = lit.length && c.trim().startsWith(c.match(/"[^"]*"|\[\$[^\]]*\]/)?.[0] || "\u0000") ? lit[0] : "";
  const suffix = !prefix && lit.length ? lit.join("") : lit.slice(1).join("");
  return `${n < 0 && !sec[1] ? "-" : ""}${prefix}${s}${pct ? "%" : ""}${suffix}`;
}

export function formatValue(raw, kind, fmt) {
  if (raw === null || raw === undefined || raw === "") return "";
  if (kind === "b") return raw === "1" || raw === true ? "TRUE" : "FALSE";
  if (kind !== "n") return String(raw);
  const n = Number(raw); const code = fmt.code;
  if (!Number.isFinite(n)) return String(raw);
  if (code === "@" ) return String(raw);
  if (code === "General") return String(Number(n.toPrecision(11)));
  try { return isDateCode(code) ? fmtDate(n, code) : fmtNumber(n, code); } catch { return String(raw); }
}
```

(`isDateCode`: a format is a date/time format when, after quoted literals, `[...]` blocks and escapes are removed, it has a y/d/h/m/s token and no `0`, `#` or `?` digit placeholders. Add this focused unit test to the task's test file: `formatValue(45567, "n", {code:"yyyy-mm-dd"}) === "2024-10-02"`, `formatValue(1234.5, "n", {code:"#,##0.00"}) === "1,234.50"` and `formatValue(0.25, "n", {code:"0%"}) === "25%"`.)

- [ ] **Step 4: Write `xlsx.js`**

```js
import { WsError } from "../result.js";
import { NS, kids, kid, attr, el, removeNode, parseXml } from "./xml.js";
import { OoxmlPackage } from "./zip.js";
import { mainPart, readRels, resolveTarget, addRel, removeRel, partsOfType, setOverride, removeOverride, relsPath, REL } from "./opc.js";
import { formatValue, codeFor, isDateCode, dateToSerial } from "./xlsx-format.js";

const S = NS.s;
const MAX_CELLS = 50000;
export const colName = (n) => { let s = ""; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };
const colNum = (s) => [...s.toUpperCase()].reduce((a, ch) => a * 26 + ch.charCodeAt(0) - 64, 0);
export function parseA1(ref) { const m = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})$/.exec(ref); if (!m) throw new WsError("bad_range", `"${ref}" is not a cell like B3`); return { c: colNum(m[1]), r: Number(m[2]) }; }
const a1 = (r, c) => `${colName(c)}${r}`;
const TAB_BAD = /[\[\]:*?/\\]/;
export function checkTabName(wb, name, except = null) {
  const s = String(name).normalize("NFC");
  if (!s || s.length > 31 || TAB_BAD.test(s) || s.startsWith("'") || s.endsWith("'")) throw new WsError("bad_args", "tab names are 1-31 characters without [ ] : * ? / \\ and cannot start or end with '");
  if (wb.sheets.some((x) => x !== except && x.name.toLowerCase() === s.toLowerCase())) throw new WsError("bad_args", `a tab named "${s}" already exists`);
  return s;
}

export function openXlsx(bytes) {
  const pkg = OoxmlPackage.open(bytes);
  const part = mainPart(pkg);
  const doc = pkg.xml(part);
  if (doc.documentElement.localName !== "workbook") throw new WsError("wrong_type", "this is not an Excel (.xlsx) workbook");
  const rels = readRels(pkg, part);
  const sheets = kids(kid(doc.documentElement, S, "sheets"), S, "sheet").map((e, index) => { const rid = attr(e, NS.r, "id"); const rel = rels.find((r) => r.id === rid); return { el: e, name: e.getAttribute("name"), sheetId: Number(e.getAttribute("sheetId")), rid, state: e.getAttribute("state") || "visible", part: rel ? resolveTarget(part, rel.target) : null, index }; });
  const sstPart = partsOfType(pkg, part, REL.sharedStrings)[0] || null;
  const sst = sstPart ? kids(pkg.xml(sstPart).documentElement, S, "si").map((si) => Array.from(si.getElementsByTagNameNS(S, "t")).filter((t) => t.parentNode.localName !== "rPh").map((t) => t.textContent).join("")) : [];
  const stylesPart = partsOfType(pkg, part, REL.styles)[0] || null;
  const sdoc = stylesPart ? pkg.xml(stylesPart) : null;
  const numFmts = new Map(sdoc ? kids(kid(sdoc.documentElement, S, "numFmts"), S, "numFmt").map((n) => [Number(n.getAttribute("numFmtId")), n.getAttribute("formatCode")]) : []);
  const xfs = sdoc ? kids(kid(sdoc.documentElement, S, "cellXfs"), S, "xf") : [];
  return { pkg, part, doc, sheets, sst, styles: { part: stylesPart, doc: sdoc, numFmts, xfs } };
}

export function sheetByName(wb, name) {
  const s = wb.sheets.find((x) => x.name === String(name).normalize("NFC")) || wb.sheets.find((x) => x.name.toLowerCase() === String(name).normalize("NFC").toLowerCase());
  if (!s) throw new WsError("tab_not_found", `No tab "${name}". Tabs: ${wb.sheets.map((x) => x.name).join(", ")}`);
  return s;
}
const sheetDoc = (wb, s) => wb.pkg.xml(s.part);
const sheetData = (wb, s) => kid(sheetDoc(wb, s).documentElement, S, "sheetData");

function usedRange(wb, s) {
  const dim = kid(sheetDoc(wb, s).documentElement, S, "dimension")?.getAttribute("ref");
  if (dim && dim.includes(":")) { const [a, b] = dim.split(":").map(parseA1); return { r1: a.r, c1: a.c, r2: b.r, c2: b.c }; }
  let r2 = 1, c2 = 1;
  for (const row of kids(sheetData(wb, s), S, "row")) for (const c of kids(row, S, "c")) { const p = parseA1(c.getAttribute("r")); r2 = Math.max(r2, p.r); c2 = Math.max(c2, p.c); }
  return { r1: 1, c1: 1, r2, c2 };
}

export function parseRange(wb, str) {
  const m = /^(?:'((?:[^']|'')+)'|([^!]+))(?:!(.+))?$/.exec(String(str).trim());
  if (!m) throw new WsError("bad_range", `"${str}" is not a range like Tab!A1:C10`);
  const sheet = sheetByName(wb, (m[1] ? m[1].replace(/''/g, "'") : m[2]).trim());
  if (!m[3]) return { sheet, ...usedRange(wb, sheet) };
  const [x, y = x] = m[3].split(":");
  if (/^[A-Za-z]{1,3}$/.test(x) && /^[A-Za-z]{1,3}$/.test(y)) { const u = usedRange(wb, sheet); return { sheet, r1: 1, c1: colNum(x), r2: u.r2, c2: colNum(y) }; }
  const a = parseA1(x), b = parseA1(y);
  return { sheet, r1: Math.min(a.r, b.r), c1: Math.min(a.c, b.c), r2: Math.max(a.r, b.r), c2: Math.max(a.c, b.c) };
}

function rowMap(wb, s) { const m = new Map(); for (const row of kids(sheetData(wb, s), S, "row")) m.set(Number(row.getAttribute("r")), row); return m; }
function cellAt(row, c) { return row ? kids(row, S, "c").find((x) => parseA1(x.getAttribute("r")).c === c) || null : null; }

function ensureCell(wb, s, r, c) {
  const doc = sheetDoc(wb, s); const sd = sheetData(wb, s);
  let row = kids(sd, S, "row").find((x) => Number(x.getAttribute("r")) === r);
  if (!row) { row = el(doc, S, "row", { r }); sd.insertBefore(row, kids(sd, S, "row").find((x) => Number(x.getAttribute("r")) > r) || null); }
  row.removeAttribute("spans");
  let cell = cellAt(row, c);
  if (!cell) { cell = el(doc, S, "c", { r: a1(r, c) }); row.insertBefore(cell, kids(row, S, "c").find((x) => parseA1(x.getAttribute("r")).c > c) || null); }
  return cell;
}

function fmtOf(wb, cell) {
  const i = Number(cell?.getAttribute("s") || 0); const xf = wb.styles.xfs[i];
  const id = xf ? Number(xf.getAttribute("numFmtId") || 0) : 0;
  return { id, code: codeFor(id, wb.styles.numFmts.get(id)) };
}

function sharedMaster(wb, s, si) {
  for (const row of kids(sheetData(wb, s), S, "row")) for (const c of kids(row, S, "c")) { const f = kid(c, S, "f"); if (f && f.getAttribute("t") === "shared" && f.getAttribute("si") === si && f.getAttribute("ref")) return { cell: c, f }; }
  return null;
}
export function shiftFormula(text, dr, dc) {
  return text.replace(/("(?:[^"]|"")*")|(\$?)([A-Z]{1,3})(\$?)(\d{1,7})(?![\d(A-Za-z_])/g, (m, str, d1, col, d2, row, off, all) => {
    if (str) return str;
    if (off > 0 && /[A-Za-z_\d.]/.test(all[off - 1])) return m;
    return `${d1}${d1 ? col : colName(colNum(col) + dc)}${d2}${d2 ? row : Number(row) + dr}`;
  });
}

function cellValue(wb, s, cell, mode) {
  if (!cell) return { v: "", formula: false, stale: false };
  const t = cell.getAttribute("t") || "n"; const vEl = kid(cell, S, "v"); const f = kid(cell, S, "f");
  let raw = vEl ? vEl.textContent : null;
  if (t === "s" && raw !== null) raw = wb.sst[Number(raw)] ?? "";
  if (t === "inlineStr") raw = Array.from(kid(cell, S, "is")?.getElementsByTagNameNS(S, "t") || []).map((x) => x.textContent).join("");
  if (mode === "FORMULA" && f) {
    let text = f.textContent;
    if (!text && f.getAttribute("t") === "shared") { const m = sharedMaster(wb, s, f.getAttribute("si")); if (m) { const a = parseA1(m.cell.getAttribute("r")), b = parseA1(cell.getAttribute("r")); text = shiftFormula(m.f.textContent, b.r - a.r, b.c - a.c); } }
    return { v: `=${text}`, formula: true, stale: false };
  }
  const stale = !!f && vEl === null;
  if (raw === null) return { v: "", formula: !!f, stale };
  if (mode === "UNFORMATTED_VALUE") return { v: t === "n" ? Number(raw) : t === "b" ? raw === "1" : raw, formula: !!f, stale };
  if (mode === "FORMULA") return { v: t === "n" ? Number(raw) : t === "b" ? raw === "1" : raw, formula: false, stale };
  return { v: formatValue(raw, t === "s" || t === "inlineStr" || t === "str" ? "s" : t, fmtOf(wb, cell)), formula: !!f, stale };
}

export function readRange(wb, range, mode = "FORMATTED_VALUE") {
  if (!["FORMATTED_VALUE", "UNFORMATTED_VALUE", "FORMULA"].includes(mode)) throw new WsError("bad_args", "value_render_option must be FORMATTED_VALUE, UNFORMATTED_VALUE or FORMULA");
  const R = parseRange(wb, range);
  if ((R.r2 - R.r1 + 1) * (R.c2 - R.c1 + 1) > MAX_CELLS) throw new WsError("too_large", `read at most ${MAX_CELLS} cells per call`);
  const rows = rowMap(wb, R.sheet); const values = []; let stale = false;
  for (let r = R.r1; r <= R.r2; r++) {
    const row = []; for (let c = R.c1; c <= R.c2; c++) { const x = cellValue(wb, R.sheet, cellAt(rows.get(r), c), mode); stale ||= x.stale; row.push(x.v); }
    while (row.length && (row.at(-1) === "" || row.at(-1) === null)) row.pop();
    values.push(row);
  }
  while (values.length && !values.at(-1).length) values.pop();
  return { range: `${R.sheet.name}!${a1(R.r1, R.c1)}:${a1(R.r2, R.c2)}`, values, stale_formulas: stale };
}

function merges(wb, s) { return kids(kid(sheetDoc(wb, s).documentElement, S, "mergeCells"), S, "mergeCell").map((m) => { const [a, b = a] = m.getAttribute("ref").split(":").map(parseA1); return { ref: m.getAttribute("ref"), r1: a.r, c1: a.c, r2: b.r, c2: b.c }; }); }
const inBox = (b, r, c) => r >= b.r1 && r <= b.r2 && c >= b.c1 && c <= b.c2;

function guardTargets(wb, s, R) {
  for (const m of merges(wb, s)) for (let r = R.r1; r <= R.r2; r++) for (let c = R.c1; c <= R.c2; c++)
    if (inBox(m, r, c) && !(r === m.r1 && c === m.c1)) throw new WsError("merged_cell", `${a1(r, c)} is inside the merged area ${m.ref}; write to its top-left cell ${a1(m.r1, m.c1)} instead.`);
  const rows = rowMap(wb, s); const groups = new Map();
  for (const row of rows.values()) for (const c of kids(row, S, "c")) { const f = kid(c, S, "f"); if (f?.getAttribute("t") === "shared") { const si = f.getAttribute("si"); if (f.getAttribute("ref")) groups.set(si, f.getAttribute("ref")); } }
  for (const [, ref] of groups) {
    const [a, b = a] = ref.split(":").map(parseA1); const g = { r1: a.r, c1: a.c, r2: b.r, c2: b.c };
    const touches = !(g.r2 < R.r1 || g.r1 > R.r2 || g.c2 < R.c1 || g.c1 > R.c2);
    const covers = R.r1 <= g.r1 && R.r2 >= g.r2 && R.c1 <= g.c1 && R.c2 >= g.c2;
    if (touches && !covers) throw new WsError("shared_formula", `Those cells are part of a shared formula over ${ref}. Write the whole range ${ref} at once, or edit it in the editor.`);
  }
}

const scalar = (v) => (v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : v);
const NUM = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;
function setCell(wb, s, cell, value, input) {
  const doc = sheetDoc(wb, s);
  for (const ch of kids(cell)) cell.removeChild(ch);
  cell.removeAttribute("t");
  const v = scalar(value);
  const textFmt = fmtOf(wb, cell).code === "@";
  const put = (t, child) => { if (t) cell.setAttribute("t", t); if (child) cell.appendChild(child); };
  if (v === "") return;
  if (typeof v === "boolean") return put("b", el(doc, S, "v", {}, [v ? "1" : "0"]));
  if (typeof v === "number") return put(null, el(doc, S, "v", {}, [String(v)]));
  const str = String(v).normalize("NFC");
  if (input === "USER_ENTERED" && !textFmt) {
    if (str.startsWith("=") && str.length > 1) return put(null, el(doc, S, "f", {}, [str.slice(1)]));
    if (NUM.test(str.trim())) return put(null, el(doc, S, "v", {}, [String(Number(str))]));
    if (/^(true|false)$/i.test(str)) return put("b", el(doc, S, "v", {}, [/^true$/i.test(str) ? "1" : "0"]));
    const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str);
    if (dm && isDateCode(fmtOf(wb, cell).code)) return put(null, el(doc, S, "v", {}, [String(dateToSerial(+dm[1], +dm[2], +dm[3]))]));
  }
  const t = el(doc, S, "t", {}, [str]); t.setAttributeNS(NS.xml, "xml:space", "preserve");
  put("inlineStr", el(doc, S, "is", {}, [t]));
}

function growDimension(wb, s, r2, c2) {
  const doc = sheetDoc(wb, s); let dim = kid(doc.documentElement, S, "dimension");
  const u = usedRange(wb, s); const ref = `A1:${a1(Math.max(u.r2, r2), Math.max(u.c2, c2))}`;
  if (!dim) { dim = el(doc, S, "dimension", { ref }); doc.documentElement.insertBefore(dim, kids(doc.documentElement)[0] || null); } else dim.setAttribute("ref", ref);
}

export function markRecalc(wb) {
  let calc = kid(wb.doc.documentElement, S, "calcPr");
  if (!calc) { calc = el(wb.doc, S, "calcPr", { calcId: "0" }); const after = kid(wb.doc.documentElement, S, "definedNames") || kid(wb.doc.documentElement, S, "sheets"); wb.doc.documentElement.insertBefore(calc, after.nextSibling); }
  calc.setAttribute("fullCalcOnLoad", "1");
  const cc = readRels(wb.pkg, wb.part).find((r) => r.type === REL.calcChain);
  if (cc) { const p = resolveTarget(wb.part, cc.target); wb.pkg.remove(p); removeRel(wb.pkg, wb.part, cc.id); removeOverride(wb.pkg, p); }
  wb.pkg.markDirty(wb.part);
}

function toRows(values) { if (!Array.isArray(values) || !values.length) throw new WsError("bad_args", "values cannot be empty"); return Array.isArray(values[0]) ? values : [values]; }

export function writeRange(wb, range, values, input = "USER_ENTERED") {
  if (!["USER_ENTERED", "RAW"].includes(input)) throw new WsError("bad_args", "value_input_option must be USER_ENTERED or RAW");
  const rows = toRows(values); const R0 = parseRange(wb, range);
  const R = { ...R0, r2: R0.r1 + rows.length - 1, c2: R0.c1 + Math.max(...rows.map((x) => x.length)) - 1 };
  if ((R.r2 - R.r1 + 1) * (R.c2 - R.c1 + 1) > MAX_CELLS) throw new WsError("too_large", `write at most ${MAX_CELLS} cells per call`);
  guardTargets(wb, R.sheet, R);
  let n = 0;
  rows.forEach((row, i) => row.forEach((v, j) => { setCell(wb, R.sheet, ensureCell(wb, R.sheet, R.r1 + i, R.c1 + j), v, input); n++; }));
  growDimension(wb, R.sheet, R.r2, R.c2);
  wb.pkg.markDirty(R.sheet.part); markRecalc(wb);
  return { cells: n, range: `${R.sheet.name}!${a1(R.r1, R.c1)}:${a1(R.r2, R.c2)}` };
}

export function appendRows(wb, sheetName, values, input) {
  const s = sheetByName(wb, sheetName);
  let rows;
  if (values && !Array.isArray(values) && typeof values === "object") values = [values];
  if (!Array.isArray(values) || !values.length) throw new WsError("bad_args", "values cannot be empty");
  if (values.every((v) => v && typeof v === "object" && !Array.isArray(v))) {
    const header = (readRange(wb, `'${s.name.replace(/'/g, "''")}'!1:1`.replace("!1:1", "!A1:ZZ1")).values[0] || []).map(String);
    rows = values.map((o) => { const bad = Object.keys(o).filter((k) => !header.includes(k)); if (bad.length) throw new WsError("bad_args", `Unknown column(s) ${bad.join(", ")}. Headers: ${header.join(", ")}`); return header.map((h) => (h in o ? o[h] : "")); });
  } else rows = toRows(values);
  let last = 0;
  for (const row of kids(sheetData(wb, s), S, "row")) if (kids(row, S, "c").some((c) => kid(c, S, "v") || kid(c, S, "is") || kid(c, S, "f"))) last = Math.max(last, Number(row.getAttribute("r")));
  const r = writeRange(wb, `'${s.name.replace(/'/g, "''")}'!A${last + 1}`, rows, input);
  return { range: r.range, rows: rows.length };
}

export function tabsInfo(wb) {
  return wb.sheets.map((s) => {
    const doc = sheetDoc(wb, s); const pane = kid(kid(kid(doc.documentElement, S, "sheetViews"), S, "sheetView"), S, "pane");
    const frozen = pane && /frozen/.test(pane.getAttribute("state") || "");
    const u = usedRange(wb, s);
    return { sheet_id: s.sheetId, index: s.index, title: s.name, rows: u.r2, cols: u.c2, frozen_rows: frozen ? Number(pane.getAttribute("ySplit") || 0) : 0, frozen_cols: frozen ? Number(pane.getAttribute("xSplit") || 0) : 0, hidden: s.state !== "visible" };
  });
}

export function addTab(wb, title, index) {
  const name = checkTabName(wb, title);
  let n = 1; while (wb.pkg.has(`xl/worksheets/sheet${n}.xml`)) n++;
  const part = `xl/worksheets/sheet${n}.xml`;
  wb.pkg.setXml(part, parseXml(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<worksheet xmlns="${S}" xmlns:r="${NS.r}"><dimension ref="A1"/><sheetData/></worksheet>`, part));
  const rid = addRel(wb.pkg, wb.part, REL.worksheet, `worksheets/sheet${n}.xml`);
  setOverride(wb.pkg, part, "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml");
  const sheetsEl = kid(wb.doc.documentElement, S, "sheets");
  const sheetId = Math.max(0, ...wb.sheets.map((s) => s.sheetId)) + 1;
  const e = el(wb.doc, S, "sheet", { name, sheetId, "r:id": rid });
  const at = index === undefined ? null : kids(sheetsEl, S, "sheet")[index] || null;
  sheetsEl.insertBefore(e, at);
  wb.pkg.markDirty(wb.part);
  wb.sheets = kids(sheetsEl, S, "sheet").map((x, i) => wb.sheets.find((s) => s.el === x) ? { ...wb.sheets.find((s) => s.el === x), index: i } : { el: x, name, sheetId, rid, state: "visible", part, index: i });
  return { sheet_id: sheetId, title: name };
}

const quoteTab = (n) => (/^[A-Za-z_][A-Za-z0-9_.]*$/.test(n) && !/^[A-Za-z]{1,3}\d+$/.test(n) ? n : `'${n.replace(/'/g, "''")}'`);
function rewriteRefs(text, oldName, newName) {
  const q = new RegExp(`'${oldName.replace(/'/g, "''").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}'!`, "g");
  const plain = /^[A-Za-z_][A-Za-z0-9_.]*$/.test(oldName) ? new RegExp(`(?<![A-Za-z0-9_.'])${oldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}!`, "g") : null;
  return text.split(/("(?:[^"]|"")*")/).map((part, i) => (i % 2 ? part : (plain ? part.replace(q, `${quoteTab(newName)}!`).replace(plain, `${quoteTab(newName)}!`) : part.replace(q, `${quoteTab(newName)}!`)))).join("");
}

export function renameTab(wb, title, newTitle) {
  const s = sheetByName(wb, title); const name = checkTabName(wb, newTitle, s);
  for (const pc of wb.pkg.names().filter((n) => /pivotCacheDefinition\d*\.xml$/.test(n))) if (wb.pkg.text(pc).includes(`sheet="${s.name}"`)) throw new WsError("pivot_refuses", "A pivot table reads from this tab; rename it in the editor instead.");
  const old = s.name;
  for (const t of wb.sheets) {
    const doc = sheetDoc(wb, t); let dirty = false;
    for (const f of Array.from(doc.getElementsByTagNameNS(S, "f"))) { const n = rewriteRefs(f.textContent, old, name); if (n !== f.textContent) { f.textContent = n; dirty = true; } }
    if (dirty) wb.pkg.markDirty(t.part);
  }
  for (const dn of kids(kid(wb.doc.documentElement, S, "definedNames"), S, "definedName")) dn.textContent = rewriteRefs(dn.textContent, old, name);
  for (const cp of wb.pkg.names().filter((n) => /^xl\/charts\/chart\d+\.xml$/.test(n))) {
    const doc = wb.pkg.xml(cp); let dirty = false;
    for (const f of Array.from(doc.getElementsByTagNameNS(NS.c, "f"))) { const n = rewriteRefs(f.textContent, old, name); if (n !== f.textContent) { f.textContent = n; dirty = true; } }
    if (dirty) wb.pkg.markDirty(cp);
  }
  s.el.setAttribute("name", name); s.name = name; wb.pkg.markDirty(wb.part);
  return { old_title: old, title: name };
}

export function deleteTab(wb, title) {
  const s = sheetByName(wb, title);
  if (wb.sheets.filter((x) => x.state === "visible" && x !== s).length === 0) throw new WsError("last_tab", "A workbook needs at least one visible tab.");
  const idx = s.index;
  removeNode(s.el); removeRel(wb.pkg, wb.part, s.rid); wb.pkg.remove(s.part); removeOverride(wb.pkg, s.part);
  if (wb.pkg.has(relsPath(s.part))) wb.pkg.remove(relsPath(s.part));
  for (const dn of kids(kid(wb.doc.documentElement, S, "definedNames"), S, "definedName")) {
    const l = dn.getAttribute("localSheetId"); if (l === null || l === "") continue;
    if (Number(l) === idx) removeNode(dn); else if (Number(l) > idx) dn.setAttribute("localSheetId", String(Number(l) - 1));
  }
  const bv = kid(kid(wb.doc.documentElement, S, "bookViews"), S, "workbookView"); if (bv && Number(bv.getAttribute("activeTab") || 0) >= wb.sheets.length - 1) bv.setAttribute("activeTab", "0");
  wb.sheets = wb.sheets.filter((x) => x !== s).map((x, i) => ({ ...x, index: i }));
  wb.pkg.markDirty(wb.part); markRecalc(wb);
  return { deleted: s.name };
}

export function setNumberFormat(wb, range, pattern = "@") {
  if (!wb.styles.doc) throw new WsError("malformed_document", "this workbook has no styles part");
  const sd = wb.styles.doc; const root = sd.documentElement;
  let id = [...wb.styles.numFmts].find(([, code]) => code === pattern)?.[0];
  if (id === undefined) id = pattern === "@" ? 49 : null;
  if (id === null) {
    let nf = kid(root, S, "numFmts"); if (!nf) { nf = el(sd, S, "numFmts", { count: 0 }); root.insertBefore(nf, kids(root)[0] || null); }
    id = Math.max(163, ...wb.styles.numFmts.keys()) + 1;
    nf.appendChild(el(sd, S, "numFmt", { numFmtId: id, formatCode: pattern })); nf.setAttribute("count", String(kids(nf, S, "numFmt").length));
    wb.styles.numFmts.set(id, pattern);
  }
  const cellXfs = kid(root, S, "cellXfs");
  const xfFor = (base) => {
    const src = wb.styles.xfs[base] || wb.styles.xfs[0];
    const clone = src.cloneNode(true); clone.setAttribute("numFmtId", String(id)); clone.setAttribute("applyNumberFormat", "1");
    const ser = clone.toString(); const found = wb.styles.xfs.findIndex((x) => x.toString() === ser);
    if (found >= 0) return found;
    cellXfs.appendChild(clone); wb.styles.xfs.push(clone); cellXfs.setAttribute("count", String(wb.styles.xfs.length)); return wb.styles.xfs.length - 1;
  };
  const R = parseRange(wb, range); let n = 0;
  if ((R.r2 - R.r1 + 1) * (R.c2 - R.c1 + 1) > MAX_CELLS) throw new WsError("too_large", `format at most ${MAX_CELLS} cells per call`);
  for (let r = R.r1; r <= R.r2; r++) for (let c = R.c1; c <= R.c2; c++) { const cell = ensureCell(wb, R.sheet, r, c); cell.setAttribute("s", String(xfFor(Number(cell.getAttribute("s") || 0)))); n++; }
  wb.pkg.markDirty(wb.styles.part); wb.pkg.markDirty(R.sheet.part);
  return n;
}
```

- [ ] **Step 5: Write `tools/sheets.js` and register**

```js
import { z } from "zod";
import { readFileSync } from "node:fs";
import { WsError } from "../result.js";
import { fileRef, refOf, writeOpts, writeOptsOf } from "./common.js";
import { defineTools } from "./define.js";
import { stat, getFile, resolveRef } from "../nc/dav.js";
import { splitFolder } from "../nc/paths.js";
import { withFileWrite, createFile, MAX_EDIT_BYTES } from "../write-protocol.js";
import { openXlsx, readRange, writeRange, appendRows, addTab, renameTab, deleteTab, setNumberFormat, tabsInfo, sheetByName } from "../ooxml/xlsx.js";

const cellV = z.union([z.string().max(32767), z.number(), z.boolean(), z.null(), z.record(z.any()), z.array(z.any())]);
const values2d = z.union([z.array(z.array(cellV)).min(1).max(50000), z.array(cellV).min(1).max(16384)]);
const appendVals = z.union([values2d, z.record(cellV), z.array(z.record(cellV)).min(1).max(50000)]);

async function loadXlsx(cfg, ref) {
  const segs = await resolveRef(cfg, ref); const e = await stat(cfg, segs);
  if (!/\.xlsx$/i.test(e.name)) throw new WsError("wrong_type", `"${e.name}" is not an .xlsx spreadsheet`);
  return { e, wb: openXlsx((await getFile(cfg, segs, { maxBytes: MAX_EDIT_BYTES })).bytes) };
}
function xlsxWrite(ctx, args, fn) {
  return withFileWrite(ctx.getConfig(), refOf(args), async (bytes, e) => {
    if (!/\.xlsx$/i.test(e.name)) throw new WsError("wrong_type", `"${e.name}" is not an .xlsx spreadsheet`);
    const wb = openXlsx(bytes); const r = fn(wb);
    return r.changed ? { bytes: wb.pkg.save(), changed: r.changed, summary: r.summary, data: r.data } : { changed: 0, data: r.data };
  }, { ...writeOptsOf(args), clock: ctx.clock });
}
function applyOp(wb, op) {
  switch (op.op) {
    case "write": { const r = writeRange(wb, op.range, op.values, op.value_input_option || "USER_ENTERED"); return `write ${r.range}`; }
    case "append": { const r = appendRows(wb, op.sheet_name, op.values, op.value_input_option || "USER_ENTERED"); return `append ${r.range}`; }
    case "add_tab": addTab(wb, op.title, op.index); return `add tab ${op.title}`;
    case "rename_tab": renameTab(wb, op.title, op.new_title); return `rename tab ${op.title}`;
    case "delete_tab": deleteTab(wb, op.title); return `delete tab ${op.title}`;
    case "set_number_format": setNumberFormat(wb, op.range, op.pattern ?? "@"); return `format ${op.range}`;
    default: throw new WsError("bad_args", `unknown op "${op.op}"`);
  }
}

export const sheetsDefs = [
  { name: "ws_sheets_list", description: "Tab names of an .xlsx, in order.", schema: { ...fileRef },
    run: async (a, c) => { const { e, wb } = await loadXlsx(c.getConfig(), refOf(a)); return { path: e.path, tabs: wb.sheets.map((s) => s.name) }; } },
  { name: "ws_sheets_get_tabs", description: "Tab details: sheet_id, index, title, rows, cols, frozen rows/cols, hidden.", schema: { ...fileRef },
    run: async (a, c) => { const { e, wb } = await loadXlsx(c.getConfig(), refOf(a)); return { path: e.path, tabs: tabsInfo(wb) }; } },
  { name: "ws_sheets_read", description: "Read a range ('Tab!A1:C10', 'Tab!A:A' or 'Tab'). value_render_option: FORMATTED_VALUE | UNFORMATTED_VALUE | FORMULA. stale_formulas=true means read with FORMULA.",
    schema: { ...fileRef, range: z.string().min(1).max(300), value_render_option: z.string().optional().default("FORMATTED_VALUE") },
    run: async (a, c) => { const { e, wb } = await loadXlsx(c.getConfig(), refOf(a)); return { path: e.path, ...readRange(wb, a.range, a.value_render_option) }; } },
  { name: "ws_sheets_write", description: "Overwrite cells starting at the range's top-left. USER_ENTERED parses '=formulas', numbers, TRUE/FALSE; RAW stores text as-is. Keeps cell formatting.",
    schema: { ...fileRef, range: z.string().min(1).max(300), values: values2d, value_input_option: z.enum(["USER_ENTERED", "RAW"]).optional().default("USER_ENTERED"), ...writeOpts },
    run: (a, c) => xlsxWrite(c, a, (wb) => { const r = writeRange(wb, a.range, a.values, a.value_input_option); return { changed: r.cells, summary: `write ${r.range}`, data: { updated_range: r.range, updated_cells: r.cells } }; }) },
  { name: "ws_sheets_append", description: "Append rows after the last non-empty row. Accepts rows, a dict, or a list of dicts keyed by the header row.",
    schema: { ...fileRef, sheet_name: z.string().min(1).max(31), values: appendVals, value_input_option: z.enum(["USER_ENTERED", "RAW"]).optional().default("USER_ENTERED"), ...writeOpts },
    run: (a, c) => xlsxWrite(c, a, (wb) => { const r = appendRows(wb, a.sheet_name, a.values, a.value_input_option); return { changed: r.rows, summary: `append ${r.rows} row(s)`, data: r }; }) },
  { name: "ws_sheets_create", description: "Create an .xlsx from the blank template; first tabs entry renames Sheet1. Dedupes by name when folder is given.",
    schema: { title: z.string().min(1).max(200), folder: z.string().max(4096).optional(), tabs: z.array(z.string().min(1).max(31)).max(50).optional(), find_existing: z.boolean().optional().default(true) },
    run: async (a, c) => {
      const cfg = c.getConfig(); const folder = splitFolder(a.folder ?? ""); const name = `${a.title.normalize("NFC").replace(/\.xlsx$/i, "")}.xlsx`;
      if (/[\/\\]/.test(name)) throw new WsError("bad_path", "titles cannot contain / or \\");
      if (a.folder !== undefined && a.find_existing) { try { const e = await stat(cfg, [...folder, name]); return { created: false, path: e.path, file_id: e.fileId }; } catch (e) { if (e.code !== "not_found") throw e; } }
      const wb = openXlsx(readFileSync(new URL("../templates/blank.xlsx", import.meta.url)));
      const [first, ...rest] = a.tabs || []; if (first) renameTab(wb, wb.sheets[0].name, first); for (const t of rest) addTab(wb, t);
      return { created: true, ...(await createFile(cfg, folder, name, wb.pkg.save(), { summary: `create ${name}`, clock: c.clock })) };
    } },
  { name: "ws_sheets_add_tab", description: "Add a tab (optional position index).", schema: { ...fileRef, title: z.string().min(1).max(64), index: z.number().int().min(0).optional(), ...writeOpts },
    run: (a, c) => xlsxWrite(c, a, (wb) => ({ changed: 1, summary: `add tab ${a.title}`, data: addTab(wb, a.title, a.index) })) },
  { name: "ws_sheets_rename_tab", description: "Rename a tab and update formulas, defined names and charts that reference it.", schema: { ...fileRef, title: z.string().min(1).max(64), new_title: z.string().min(1).max(64), ...writeOpts },
    run: (a, c) => xlsxWrite(c, a, (wb) => ({ changed: 1, summary: `rename tab ${a.title}`, data: renameTab(wb, a.title, a.new_title) })) },
  { name: "ws_sheets_delete_tab", description: "Delete a tab. Destructive: confirm intent with the user first. The last visible tab cannot be deleted.", schema: { ...fileRef, title: z.string().min(1).max(64), ...writeOpts },
    run: (a, c) => xlsxWrite(c, a, (wb) => ({ changed: 1, summary: `delete tab ${a.title}`, data: deleteTab(wb, a.title) })) },
  { name: "ws_sheets_set_number_format", description: "Set a number format on a range (default '@' = plain text, keeps leading zeros). Other cell formatting is kept.",
    schema: { ...fileRef, range: z.string().min(1).max(300), pattern: z.string().min(1).max(255).optional().default("@"), format_type: z.string().max(20).optional().default("TEXT"), ...writeOpts },
    run: (a, c) => xlsxWrite(c, a, (wb) => { const n = setNumberFormat(wb, a.range, a.pattern); return { changed: n, summary: `format ${a.range}`, data: { formatted_cells: n } }; }) },
  { name: "ws_sheets_batch_update", description: "Apply typed ops in order as ONE version: write, append, add_tab, rename_tab, delete_tab, set_number_format (same params as the single tools).",
    schema: { ...fileRef, ops: z.array(z.object({ op: z.enum(["write", "append", "add_tab", "rename_tab", "delete_tab", "set_number_format"]) }).passthrough()).min(1).max(200), ...writeOpts },
    run: (a, c) => xlsxWrite(c, a, (wb) => { const done = a.ops.map((op) => applyOp(wb, op)); return { changed: done.length, summary: `${done.length} sheet op(s)`, data: { applied: done } }; }) },
];
export const registerSheets = (server, ctx) => defineTools(server, ctx, sheetsDefs);
```

`sheetByName` is imported for future use; remove the import if lint complains. In `server.js`: `names.push(...registerSheets(server, ctx));`.

- [ ] **Step 6: Run the tests**

Run: `npm test -- tests/workspace-sheets.test.js`
Expected: PASS. If the `oo-rich.xlsx` cached values or chart refs differ from what the test asserts, check the fixture XML (`unzip -p`) and fix the code, not the assertion. Exception: a fixture fact that differs (e.g. ONLYOFFICE stores `C2` as `12.5` with its own xf) may be corrected in the test, with a comment citing the XML.

- [ ] **Step 7: Commit**

```bash
git add bundles/workspace/server/ooxml/xlsx.js bundles/workspace/server/ooxml/xlsx-format.js bundles/workspace/server/tools/sheets.js tests/workspace-sheets.test.js
git commit bundles/workspace/server tests/workspace-sheets.test.js -m "feat(workspace): Sheets tools — styled writes, formula freshness, merged/shared-formula guards, tab ops"
git show --stat HEAD
```

---
### Task 9: Slides tools (.pptx)

**Files:**
- Create: `bundles/workspace/server/ooxml/pptx.js`, `bundles/workspace/server/tools/slides.js`
- Modify: `bundles/workspace/server/server.js`
- Test: `tests/workspace-slides.test.js`

**Interfaces:**
- Consumes: OPC helpers, `imageSize`, `withFileWrite`, `createFile`, `getFile`.
- Produces `pptx.js`:
  - `openPptx(bytes) → Deck {pkg, part, doc, slides:[{id, rid, part, index}]}`, `slideById(deck, id)`
  - `readDeck(deck, includeNotes)`, `notesText(deck, slide)`
  - `findReplaceDeck(deck, pairs, matchCase, scope, slideIds) → {results, total}`
  - `addSlide(deck, layoutName, index)`, `duplicateSlide`, `deleteSlide`, `reorderSlides`
  - `addTextBox`, `addImage`, `formatShapeText`, `formatParagraphs`, `editShapeText`, `editNotes`
  - `shapeById(deck, objectId) → {slide, sp}` (`object_id` = `"<slideId>:<cNvPr id>"`)
- Produces `tools/slides.js`: `slidesDefs`, `registerSlides(server, ctx)`.

- [ ] **Step 1: Write the failing tests**

`tests/workspace-slides.test.js`:

```js
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startFakeNextcloud } from "./helpers/workspace-fake-nextcloud.js";
import { connectWorkspace } from "./helpers/workspace-client.js";
import { assertOnlyPartsChanged, sofficeOpens } from "./helpers/ooxml-assert.js";

const FIX = join(import.meta.dirname, "fixtures", "workspace");
let fake, call, close;
const bytesOf = (p) => fake.node(p).bytes;
const put = (name, src) => fake.addFile(`S/${name}`, readFileSync(join(FIX, src)), { owner: "admin" });
before(async () => { fake = await startFakeNextcloud(); fake.addFolder("S", { owner: "admin" }); ({ call, close } = await connectWorkspace(fake)); });
after(async () => { await close(); fake.close(); });

for (const src of ["rich.pptx", "oo-rich.pptx"]) {
  test(`${src}: read titles, shapes and notes`, async () => {
    put(`r-${src}`, src);
    const r = await call("ws_slides_read", { path: `S/r-${src}` });
    assert.deepEqual(r.data.slides.map((s) => s.title), ["Menú de octubre", "Jueves"]);
    assert.equal(r.data.slides[1].notes, "Recordar comprar piña");
    assert.ok(r.data.slides[1].shapes.some((s) => s.text === "Tacos al pastor\nAgua de jamaica"));
    assert.match(r.data.slides[0].shapes[0].object_id, /^\d+:\d+$/);
  });

  test(`${src}: scope "slides" provably cannot touch notes`, async () => {
    put(`f-${src}`, src);
    const before = bytesOf(`S/f-${src}`);
    const r = await call("ws_slides_find_replace", { path: `S/f-${src}`, find: "piña", replace: "mango", scope: "slides" });
    assert.equal(r.data.total_changes, 0);
    assert.equal(Buffer.compare(before, bytesOf(`S/f-${src}`)), 0, "no version when nothing matched");
    const n = await call("ws_slides_find_replace", { path: `S/f-${src}`, find: "piña", replace: "mango", scope: "notes" });
    assert.equal(n.data.total_changes, 1);
    assertOnlyPartsChanged(before, bytesOf(`S/f-${src}`), [/^ppt\/notesSlides\/notesSlide\d+\.xml$/]);
  });

  test(`${src}: edit_text keeps the first run's formatting; only that slide part changes`, async () => {
    put(`e-${src}`, src);
    const r = await call("ws_slides_read", { path: `S/e-${src}` });
    const box = r.data.slides[1].shapes.find((s) => s.text === "Texto libre");
    await call("ws_slides_format_text", { path: `S/e-${src}`, object_id: box.object_id, bold: true, color_hex: "336699" });
    const before = bytesOf(`S/e-${src}`);
    await call("ws_slides_edit_text", { path: `S/e-${src}`, object_id: box.object_id, new_text: "Nuevo\nTexto" });
    const changed = assertOnlyPartsChanged(before, bytesOf(`S/e-${src}`), [/^ppt\/slides\/slide\d+\.xml$/]);
    assert.equal(changed.length, 1);
    const again = await call("ws_slides_read", { path: `S/e-${src}` });
    assert.ok(again.data.slides[1].shapes.some((s) => s.text === "Nuevo\nTexto"));
    const { partText } = await import("./helpers/ooxml-assert.js");
    assert.match(partText(bytesOf(`S/e-${src}`), changed[0]), /<a:rPr[^>]*b="1"[^>]*>(?:(?!<\/a:rPr>)[\s\S])*336699[\s\S]*Nuevo/);
  });

  test(`${src}: add (by layout name), duplicate, reorder, delete; notes created on demand; still opens`, async () => {
    put(`s-${src}`, src);
    const bad = await call("ws_slides_add_slide", { path: `S/s-${src}`, layout: "Nope" });
    assert.equal(bad.code, "bad_args"); assert.match(bad.error, /Title and Content/);
    const add = await call("ws_slides_add_slide", { path: `S/s-${src}`, layout: "title and content", index: 1 });
    const dup = await call("ws_slides_duplicate_slide", { path: `S/s-${src}`, slide_id: add.data.slide_id });
    let st = await call("ws_slides_get_structure", { path: `S/s-${src}` });
    assert.equal(st.data.slides.length, 4);
    const ids = st.data.slides.map((s) => s.slide_id);
    await call("ws_slides_reorder_slides", { path: `S/s-${src}`, slide_ids: [ids[3]], insertion_index: 0 });
    st = await call("ws_slides_get_structure", { path: `S/s-${src}` });
    assert.equal(st.data.slides[0].slide_id, dup.data.slide_id);
    await call("ws_slides_delete_slide", { path: `S/s-${src}`, slide_id: dup.data.slide_id });
    await call("ws_slides_edit_notes", { path: `S/s-${src}`, slide_id: ids[0], text: "Saludo" });
    assert.equal((await call("ws_slides_read_notes", { path: `S/s-${src}`, slide_id: ids[0] })).data.notes[0].text, "Saludo");
    await call("ws_slides_add_text_box", { path: `S/s-${src}`, slide_id: ids[0], text: "Hola", x: 1, y: 1, width: 3, height: 1, font_size: 24 });
    fake.addFile("S/p.png", Buffer.from("89504e470d0a1a0a0000000d494844520000006400000064", "hex"));
    assert.equal((await call("ws_slides_add_image", { path: `S/s-${src}`, slide_id: ids[0], image_path: "S/p.png" })).success, true);
    if (sofficeOpens(bytesOf(`S/s-${src}`), "pptx") === null) console.log("# soffice not installed: LibreOffice smoke check skipped");
  });
}

test("create makes a one-slide deck titled with the deck name; batch is one version", async () => {
  const c = await call("ws_slides_create", { title: "Menú", folder: "S" });
  assert.equal(c.data.created, true);
  const r = await call("ws_slides_read", { path: c.data.path });
  assert.equal(r.data.slides.length, 1); assert.equal(r.data.slides[0].title, "Menú");
  const puts = fake.calls.filter((x) => x.method === "PUT").length;
  await call("ws_slides_batch_update", { path: c.data.path, ops: [{ op: "add_slide", layout: "Blank" }, { op: "find_replace", find: "Menú", replace: "Menú semanal" }] });
  assert.equal(fake.calls.filter((x) => x.method === "PUT").length - puts, 1);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- tests/workspace-slides.test.js`
Expected: FAIL.

- [ ] **Step 3: Write `pptx.js`**

```js
import { WsError } from "../result.js";
import { NS, kids, kid, all, attr, el, removeNode, parseXml, insertAfter } from "./xml.js";
import { OoxmlPackage } from "./zip.js";
import { mainPart, readRels, resolveTarget, addRel, removeRel, partsOfType, setOverride, removeOverride, relsPath, ensureDefault, REL } from "./opc.js";
import { imageSize } from "./image-size.js";

const P = NS.p, A = NS.a;
const EMU = 914400;
const CT_SLIDE = "application/vnd.openxmlformats-officedocument.presentationml.slide+xml";
const CT_NOTES = "application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml";
const ALIGN = { START: "l", CENTER: "ctr", END: "r", JUSTIFIED: "just" };

export function openPptx(bytes) {
  const pkg = OoxmlPackage.open(bytes); const part = mainPart(pkg); const doc = pkg.xml(part);
  if (doc.documentElement.localName !== "presentation") throw new WsError("wrong_type", "this is not a PowerPoint (.pptx) deck");
  const deck = { pkg, part, doc };
  loadSlides(deck);
  return deck;
}
function loadSlides(deck) {
  const rels = readRels(deck.pkg, deck.part);
  const lst = kid(deck.doc.documentElement, P, "sldIdLst");
  deck.slides = kids(lst, P, "sldId").map((e, index) => { const rid = attr(e, NS.r, "id"); const r = rels.find((x) => x.id === rid); return { el: e, id: e.getAttribute("id"), rid, part: resolveTarget(deck.part, r.target), index }; });
}
export function slideById(deck, id) {
  const s = deck.slides.find((x) => x.id === String(id));
  if (!s) throw new WsError("slide_not_found", `No slide ${id}. Slides: ${deck.slides.map((x) => x.id).join(", ")}`);
  return s;
}
const spTree = (doc) => kid(kid(doc.documentElement, P, "cSld"), P, "spTree");
const shapesOf = (doc) => all(spTree(doc), P, "sp");
const nvId = (sp) => kid(kid(sp, P, "nvSpPr"), P, "cNvPr");
const phType = (sp) => { const ph = kid(kid(kid(sp, P, "nvSpPr"), P, "nvPr"), P, "ph"); return ph ? ph.getAttribute("type") || "body" : null; };
export function paraText(p) { let s = ""; for (const c of kids(p, A)) { if (c.localName === "r" || c.localName === "fld") s += kid(c, A, "t")?.textContent || ""; else if (c.localName === "br") s += "\n"; } return s; }
export const shapeText = (sp) => kids(kid(sp, P, "txBody"), A, "p").map(paraText).join("\n");
const notesPart = (deck, s) => partsOfType(deck.pkg, s.part, REL.notesSlide)[0] || null;
export function notesText(deck, s) {
  const np = notesPart(deck, s); if (!np) return "";
  const body = shapesOf(deck.pkg.xml(np)).find((sp) => phType(sp) === "body");
  return body ? shapeText(body) : "";
}
export function shapeById(deck, objectId) {
  const m = /^(\d+):(\d+)$/.exec(String(objectId)); if (!m) throw new WsError("bad_args", "object_id looks like '256:3' (slide_id:shape id)");
  const slide = slideById(deck, m[1]);
  const sp = shapesOf(deck.pkg.xml(slide.part)).find((x) => nvId(x)?.getAttribute("id") === m[2]);
  if (!sp) throw new WsError("shape_not_found", `No shape ${objectId}`);
  return { slide, sp };
}
export function readDeck(deck, includeNotes = true) {
  return deck.slides.map((s) => {
    const doc = deck.pkg.xml(s.part); const shapes = shapesOf(doc);
    const title = shapes.find((sp) => ["title", "ctrTitle"].includes(phType(sp)));
    return { slide_id: s.id, index: s.index, title: title ? shapeText(title) : "", shapes: shapes.map((sp) => ({ object_id: `${s.id}:${nvId(sp).getAttribute("id")}`, name: nvId(sp).getAttribute("name"), kind: phType(sp) || "shape", text: shapeText(sp) })), ...(includeNotes ? { notes: notesText(deck, s) } : {}) };
  });
}

function textSegs(p) {
  const segs = []; let text = "";
  for (const c of kids(p, A)) {
    if (c.localName === "r") { const t = kid(c, A, "t"); if (t) { segs.push({ t, run: c, start: text.length, end: text.length + t.textContent.length }); text += t.textContent; } }
    else if (c.localName === "br" || c.localName === "fld") text += "\u0000";
  }
  return { text, segs };
}
function replaceInPara(p, find, repl, matchCase) {
  const { text, segs } = textSegs(p);
  const nText = text.normalize("NFC");
  if (nText !== text) for (const g of segs) g.t.textContent = g.t.textContent.normalize("NFC");
  const map = nText !== text ? textSegs(p) : { text, segs };
  const hay = matchCase ? map.text : map.text.toLowerCase(); const needle = matchCase ? find : find.toLowerCase();
  const hits = []; let i = 0; while ((i = hay.indexOf(needle, i)) !== -1) { if (!map.text.slice(i, i + needle.length).includes("\u0000")) hits.push(i); i += needle.length; }
  for (const s of hits.reverse()) {
    const e = s + find.length; const hit = map.segs.filter((g) => g.end > s && g.start < e);
    const first = hit[0]; const tail = e <= first.end ? first.t.textContent.slice(e - first.start) : "";
    first.t.textContent = first.t.textContent.slice(0, s - first.start) + repl + tail;
    for (const g of hit.slice(1)) { g.t.textContent = g.t.textContent.slice(Math.min(e, g.end) - g.start); if (!g.t.textContent) removeNode(g.run); }
  }
  return hits.length;
}

export function findReplaceDeck(deck, pairs, matchCase, scope = "slides", slideIds = null) {
  if (!["slides", "notes", "all"].includes(scope)) throw new WsError("bad_args", "scope must be slides, notes or all");
  const chosen = slideIds ? slideIds.map((id) => slideById(deck, id)) : deck.slides;
  if (!chosen.length) throw new WsError("bad_args", "no slides matched slide_ids");
  const parts = [];
  for (const s of chosen) { if (scope !== "notes") parts.push(s.part); if (scope !== "slides") { const np = notesPart(deck, s); if (np) parts.push(np); } }
  const results = []; let total = 0;
  for (const pr of pairs) {
    const find = String(pr.find).normalize("NFC"); if (!find) throw new WsError("bad_args", "find text cannot be empty");
    let count = 0;
    for (const part of parts) { let n = 0; for (const p of all(deck.pkg.xml(part), A, "p")) n += replaceInPara(p, find, String(pr.replace ?? "").normalize("NFC"), pr.match_case ?? matchCase); if (n) deck.pkg.markDirty(part); count += n; }
    results.push({ find: pr.find, occurrences: count }); total += count;
  }
  return { results, total };
}

function layouts(deck) {
  return deck.pkg.names().filter((n) => /^ppt\/slideLayouts\/slideLayout\d+\.xml$/.test(n)).map((part) => ({ part, name: kid(deck.pkg.xml(part).documentElement, P, "cSld")?.getAttribute("name") || "" }));
}
function nextPart(deck, dir, stem) { let n = 1; while (deck.pkg.has(`ppt/${dir}/${stem}${n}.xml`)) n++; return { part: `ppt/${dir}/${stem}${n}.xml`, n }; }
function insertSldId(deck, rid, index) {
  const lst = kid(deck.doc.documentElement, P, "sldIdLst");
  const id = Math.max(255, ...deck.slides.map((s) => Number(s.id))) + 1;
  const e = el(deck.doc, P, "p:sldId", { id, "r:id": rid });
  lst.insertBefore(e, index === undefined || index === null ? null : kids(lst, P, "sldId")[index] || null);
  deck.pkg.markDirty(deck.part); loadSlides(deck);
  return String(id);
}
const EMPTY_SLIDE = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<p:sld xmlns:a="${A}" xmlns:r="${NS.r}" xmlns:p="${P}"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;

export function addSlide(deck, layoutName = "Blank", index) {
  const ls = layouts(deck); const L = ls.find((l) => l.name.toLowerCase() === String(layoutName).toLowerCase());
  if (!L) throw new WsError("bad_args", `No layout "${layoutName}". Layouts: ${ls.map((l) => l.name).join(", ")}`);
  const { part } = nextPart(deck, "slides", "slide");
  const doc = parseXml(EMPTY_SLIDE, part); const tree = spTree(doc);
  for (const sp of shapesOf(deck.pkg.xml(L.part))) {
    const t = phType(sp); if (!t || ["dt", "ftr", "sldNum"].includes(t)) continue;
    const c = doc.importNode(kid(sp, P, "nvSpPr"), true);
    tree.appendChild(el(doc, P, "p:sp", {}, [c, el(doc, P, "p:spPr"), el(doc, P, "p:txBody", {}, [el(doc, A, "a:bodyPr"), el(doc, A, "a:lstStyle"), el(doc, A, "a:p")])]));
  }
  deck.pkg.setXml(part, doc);
  addRel(deck.pkg, part, REL.slideLayout, `../slideLayouts/${L.part.split("/").pop()}`);
  setOverride(deck.pkg, part, CT_SLIDE);
  const rid = addRel(deck.pkg, deck.part, REL.slide, `slides/${part.split("/").pop()}`);
  return { slide_id: insertSldId(deck, rid, index), layout: L.name };
}

function copyPartWithRels(deck, from, to) {
  deck.pkg.setBytes(to, deck.pkg.bytes(from));
  if (deck.pkg.has(relsPath(from))) deck.pkg.setBytes(relsPath(to), deck.pkg.bytes(relsPath(from)));
}
export function duplicateSlide(deck, slideId) {
  const s = slideById(deck, slideId); const { part } = nextPart(deck, "slides", "slide");
  copyPartWithRels(deck, s.part, part); setOverride(deck.pkg, part, CT_SLIDE);
  const np = notesPart(deck, s);
  if (np) {
    const old = readRels(deck.pkg, part).find((r) => r.type === REL.notesSlide); removeRel(deck.pkg, part, old.id);
    const n2 = nextPart(deck, "notesSlides", "notesSlide").part; copyPartWithRels(deck, np, n2); setOverride(deck.pkg, n2, CT_NOTES);
    const back = readRels(deck.pkg, n2).find((r) => r.type === REL.slide); removeRel(deck.pkg, n2, back.id);
    addRel(deck.pkg, n2, REL.slide, `../slides/${part.split("/").pop()}`); addRel(deck.pkg, part, REL.notesSlide, `../notesSlides/${n2.split("/").pop()}`);
  }
  const rid = addRel(deck.pkg, deck.part, REL.slide, `slides/${part.split("/").pop()}`);
  return { slide_id: insertSldId(deck, rid, s.index + 1) };
}
export function deleteSlide(deck, slideId) {
  const s = slideById(deck, slideId); const np = notesPart(deck, s);
  removeNode(s.el); removeRel(deck.pkg, deck.part, s.rid);
  for (const p of [s.part, np].filter(Boolean)) { deck.pkg.remove(p); removeOverride(deck.pkg, p); if (deck.pkg.has(relsPath(p))) deck.pkg.remove(relsPath(p)); }
  deck.pkg.markDirty(deck.part); loadSlides(deck);
  return { deleted: s.id };
}
export function reorderSlides(deck, slideIds, insertionIndex) {
  const moving = slideIds.map((id) => slideById(deck, id));
  const rest = deck.slides.filter((s) => !moving.includes(s));
  const at = Math.max(0, Math.min(insertionIndex, rest.length));
  const lst = kid(deck.doc.documentElement, P, "sldIdLst");
  const order = [...rest.slice(0, at), ...moving, ...rest.slice(at)];
  for (const s of order) lst.appendChild(s.el);
  deck.pkg.markDirty(deck.part); loadSlides(deck);
  return { order: deck.slides.map((s) => s.id) };
}
const nextShapeId = (doc) => Math.max(1, ...all(doc.documentElement, P, "cNvPr").map((e) => Number(e.getAttribute("id")) || 0)) + 1;
const inch = (v) => Math.round(Number(v) * EMU);

export function addTextBox(deck, slideId, text, { x = 1, y = 1, width = 8, height = 1, font_size }) {
  const s = slideById(deck, slideId); const doc = deck.pkg.xml(s.part); const id = nextShapeId(doc);
  const paras = String(text).normalize("NFC").split("\n").map((line) => el(doc, A, "a:p", {}, [el(doc, A, "a:r", {}, [el(doc, A, "a:rPr", { lang: "es-MX", sz: font_size ? Math.round(font_size * 100) : undefined, dirty: "0" }), el(doc, A, "a:t", {}, [line])])]));
  const sp = el(doc, P, "p:sp", {}, [
    el(doc, P, "p:nvSpPr", {}, [el(doc, P, "p:cNvPr", { id, name: `TextBox ${id}` }), el(doc, P, "p:cNvSpPr", { txBox: "1" }), el(doc, P, "p:nvPr")]),
    el(doc, P, "p:spPr", {}, [el(doc, A, "a:xfrm", {}, [el(doc, A, "a:off", { x: inch(x), y: inch(y) }), el(doc, A, "a:ext", { cx: inch(width), cy: inch(height) })]), el(doc, A, "a:prstGeom", { prst: "rect" }, [el(doc, A, "a:avLst")]), el(doc, A, "a:noFill")]),
    el(doc, P, "p:txBody", {}, [el(doc, A, "a:bodyPr", { wrap: "square", rtlCol: "0" }, [el(doc, A, "a:spAutoFit")]), el(doc, A, "a:lstStyle"), ...paras]),
  ]);
  spTree(doc).appendChild(sp); deck.pkg.markDirty(s.part);
  return { object_id: `${s.id}:${id}` };
}

export function addImage(deck, slideId, bytes, { x = 1, y = 1, width = 4, height = 3 }) {
  const { type } = imageSize(bytes); const ext = type === "jpeg" ? "jpeg" : type;
  const s = slideById(deck, slideId); const doc = deck.pkg.xml(s.part);
  let n = 1; while (deck.pkg.has(`ppt/media/crow-image-${n}.${ext}`)) n++;
  deck.pkg.setBytes(`ppt/media/crow-image-${n}.${ext}`, new Uint8Array(bytes)); ensureDefault(deck.pkg, ext, `image/${type}`);
  const rid = addRel(deck.pkg, s.part, REL.image, `../media/crow-image-${n}.${ext}`);
  const id = nextShapeId(doc);
  const pic = el(doc, P, "p:pic", {}, [
    el(doc, P, "p:nvPicPr", {}, [el(doc, P, "p:cNvPr", { id, name: `Picture ${id}` }), el(doc, P, "p:cNvPicPr", {}, [el(doc, A, "a:picLocks", { noChangeAspect: "1" })]), el(doc, P, "p:nvPr")]),
    el(doc, P, "p:blipFill", {}, [el(doc, A, "a:blip", { "r:embed": rid }), el(doc, A, "a:stretch", {}, [el(doc, A, "a:fillRect")])]),
    el(doc, P, "p:spPr", {}, [el(doc, A, "a:xfrm", {}, [el(doc, A, "a:off", { x: inch(x), y: inch(y) }), el(doc, A, "a:ext", { cx: inch(width), cy: inch(height) })]), el(doc, A, "a:prstGeom", { prst: "rect" }, [el(doc, A, "a:avLst")])]),
  ]);
  spTree(doc).appendChild(pic); deck.pkg.markDirty(s.part);
  return { object_id: `${s.id}:${id}` };
}

const RPR_KIDS = ["ln", "noFill", "solidFill", "gradFill", "blipFill", "pattFill", "grpFill", "effectLst", "effectDag", "highlight", "uLnTx", "uLn", "uFillTx", "uFill", "latin", "ea", "cs", "sym", "hlinkClick", "hlinkMouseOver", "rtl", "extLst"];
function setRprChild(rPr, name, node) {
  for (const c of kids(rPr, A)) if (c.localName === name || (name === "solidFill" && ["noFill", "gradFill", "blipFill", "pattFill", "grpFill"].includes(c.localName))) rPr.removeChild(c);
  const idx = RPR_KIDS.indexOf(name); rPr.insertBefore(node, kids(rPr, A).find((c) => RPR_KIDS.indexOf(c.localName) > idx) || null);
}
export function formatShapeText(deck, objectId, st) {
  const keys = ["bold", "italic", "underline", "font_size", "color_hex", "font_family"].filter((k) => st[k] !== undefined && st[k] !== null);
  if (!keys.length) throw new WsError("no_style", "give at least one style");
  if (st.color_hex !== undefined && !/^#?[0-9a-fA-F]{6}$/.test(st.color_hex)) throw new WsError("bad_color", "color_hex must be 6 hex digits");
  const { slide, sp } = shapeById(deck, objectId); const doc = sp.ownerDocument; let n = 0;
  for (const r of all(sp, A, "r")) {
    let rPr = kid(r, A, "rPr"); if (!rPr) { rPr = el(doc, A, "a:rPr", { lang: "es-MX" }); r.insertBefore(rPr, r.firstChild); }
    if (st.bold !== undefined) rPr.setAttribute("b", st.bold ? "1" : "0");
    if (st.italic !== undefined) rPr.setAttribute("i", st.italic ? "1" : "0");
    if (st.underline !== undefined) rPr.setAttribute("u", st.underline ? "sng" : "none");
    if (st.font_size !== undefined) rPr.setAttribute("sz", String(Math.round(st.font_size * 100)));
    if (st.color_hex !== undefined) setRprChild(rPr, "solidFill", el(doc, A, "a:solidFill", {}, [el(doc, A, "a:srgbClr", { val: st.color_hex.replace("#", "").toUpperCase() })]));
    if (st.font_family !== undefined) setRprChild(rPr, "latin", el(doc, A, "a:latin", { typeface: st.font_family }));
    n++;
  }
  deck.pkg.markDirty(slide.part); return n;
}
export function formatParagraphs(deck, objectId, alignment) {
  if (!ALIGN[alignment]) throw new WsError("bad_args", "alignment must be START, CENTER, END or JUSTIFIED");
  const { slide, sp } = shapeById(deck, objectId); const doc = sp.ownerDocument;
  for (const p of all(sp, A, "p")) { let pPr = kid(p, A, "pPr"); if (!pPr) { pPr = el(doc, A, "a:pPr"); p.insertBefore(pPr, p.firstChild); } pPr.setAttribute("algn", ALIGN[alignment]); }
  deck.pkg.markDirty(slide.part); return true;
}
function setBodyText(doc, txBody, text) {
  const ps = kids(txBody, A, "p"); const p0 = ps[0];
  const pPr = p0 ? kid(p0, A, "pPr") : null; const r0 = p0 ? all(p0, A, "r")[0] : null; const rPr = r0 ? kid(r0, A, "rPr") : null;
  const endRPr = p0 ? kid(p0, A, "endParaRPr") : null;
  for (const p of ps) txBody.removeChild(p);
  for (const line of String(text).normalize("NFC").split("\n")) {
    const p = el(doc, A, "a:p", {}, [pPr ? pPr.cloneNode(true) : null]);
    if (line) p.appendChild(el(doc, A, "a:r", {}, [rPr ? rPr.cloneNode(true) : el(doc, A, "a:rPr", { lang: "es-MX" }), el(doc, A, "a:t", {}, [line])]));
    if (endRPr) p.appendChild(endRPr.cloneNode(true));
    txBody.appendChild(p);
  }
}
export function editShapeText(deck, objectId, text) {
  const { slide, sp } = shapeById(deck, objectId); const doc = sp.ownerDocument;
  let tb = kid(sp, P, "txBody"); if (!tb) { tb = el(doc, P, "p:txBody", {}, [el(doc, A, "a:bodyPr"), el(doc, A, "a:lstStyle")]); sp.appendChild(tb); }
  setBodyText(doc, tb, text); deck.pkg.markDirty(slide.part); return true;
}
function createNotes(deck, s) {
  const master = partsOfType(deck.pkg, deck.part, REL.notesMaster)[0];
  if (!master) throw new WsError("no_notes_master", "This deck has no notes master, so speaker notes cannot be added here; add them once in the editor.");
  const { part } = nextPart(deck, "notesSlides", "notesSlide");
  deck.pkg.setXml(part, parseXml(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<p:notes xmlns:a="${A}" xmlns:r="${NS.r}" xmlns:p="${P}"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image Placeholder 1"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp><p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes Placeholder 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p/></p:txBody></p:sp></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>`, part));
  addRel(deck.pkg, part, REL.notesMaster, `../notesMasters/${master.split("/").pop()}`);
  addRel(deck.pkg, part, REL.slide, `../slides/${s.part.split("/").pop()}`);
  addRel(deck.pkg, s.part, REL.notesSlide, `../notesSlides/${part.split("/").pop()}`);
  setOverride(deck.pkg, part, CT_NOTES);
  return part;
}
export function editNotes(deck, slideId, text, mode = "replace") {
  if (!["replace", "append"].includes(mode)) throw new WsError("bad_args", "mode must be replace or append");
  const s = slideById(deck, slideId); const np = notesPart(deck, s) || createNotes(deck, s);
  const doc = deck.pkg.xml(np); const body = shapesOf(doc).find((sp) => phType(sp) === "body");
  if (!body) throw new WsError("no_notes_master", "This slide's notes page has no text area");
  const current = shapeText(body);
  let tb = kid(body, P, "txBody"); if (!tb) { tb = el(doc, P, "p:txBody", {}, [el(doc, A, "a:bodyPr"), el(doc, A, "a:lstStyle")]); body.appendChild(tb); }
  setBodyText(doc, tb, mode === "append" && current ? `${current}\n${text}` : text);
  deck.pkg.markDirty(np); return true;
}
```

- [ ] **Step 4: Write `tools/slides.js` and register**

```js
import { z } from "zod";
import { readFileSync } from "node:fs";
import { WsError } from "../result.js";
import { fileRef, refOf, writeOpts, writeOptsOf } from "./common.js";
import { defineTools } from "./define.js";
import { stat, getFile, resolveRef } from "../nc/dav.js";
import { splitFolder, splitPath } from "../nc/paths.js";
import { withFileWrite, createFile, MAX_EDIT_BYTES } from "../write-protocol.js";
import * as X from "../ooxml/pptx.js";

const MAX_IMAGE = 5 * 1024 * 1024;
async function loadDeck(cfg, ref) { const segs = await resolveRef(cfg, ref); const e = await stat(cfg, segs); if (!/\.pptx$/i.test(e.name)) throw new WsError("wrong_type", `"${e.name}" is not a .pptx deck`); return { e, deck: X.openPptx((await getFile(cfg, segs, { maxBytes: MAX_EDIT_BYTES })).bytes) }; }
function deckWrite(ctx, args, fn) {
  return withFileWrite(ctx.getConfig(), refOf(args), async (bytes, e) => {
    if (!/\.pptx$/i.test(e.name)) throw new WsError("wrong_type", `"${e.name}" is not a .pptx deck`);
    const deck = X.openPptx(bytes); const r = await fn(deck);
    return r.changed ? { bytes: deck.pkg.save(), changed: r.changed, summary: r.summary, data: r.data } : { changed: 0, data: r.data };
  }, { ...writeOptsOf(args), clock: ctx.clock });
}
const pairs = z.array(z.object({ find: z.string().min(1).max(2000), replace: z.string().max(20000), match_case: z.boolean().optional() })).min(1).max(200);
const fr = (deck, a) => { const p = a.pairs || (a.find !== undefined && a.replace !== undefined ? [{ find: a.find, replace: a.replace }] : null); if (!p) throw new WsError("bad_args", "Provide find+replace or pairs"); return X.findReplaceDeck(deck, p, a.match_case ?? true, a.scope ?? "slides", a.slide_ids ?? null); };
async function opRun(deck, op, cfg) {
  switch (op.op) {
    case "edit_text": X.editShapeText(deck, op.object_id, op.new_text); return 1;
    case "find_replace": return fr(deck, op).total;
    case "add_slide": X.addSlide(deck, op.layout ?? "Blank", op.index); return 1;
    case "delete_slide": X.deleteSlide(deck, op.slide_id); return 1;
    case "reorder_slides": X.reorderSlides(deck, op.slide_ids, op.insertion_index); return 1;
    case "edit_notes": X.editNotes(deck, op.slide_id, op.text, op.mode); return 1;
    case "format_text": return X.formatShapeText(deck, op.object_id, op);
    default: throw new WsError("bad_args", `unknown op "${op.op}"`);
  }
}

export const slidesDefs = [
  { name: "ws_slides_read", description: "Read a .pptx: per slide id, title, shapes (object_id, text) and notes.", schema: { ...fileRef, include_notes: z.boolean().optional().default(true) },
    run: async (a, c) => { const { e, deck } = await loadDeck(c.getConfig(), refOf(a)); return { path: e.path, slides: X.readDeck(deck, a.include_notes) }; } },
  { name: "ws_slides_get_structure", description: "Slide ids, titles and element ids of a .pptx.", schema: { ...fileRef },
    run: async (a, c) => { const { e, deck } = await loadDeck(c.getConfig(), refOf(a)); return { path: e.path, slides: X.readDeck(deck, false).map((s) => ({ slide_id: s.slide_id, index: s.index, title: s.title, object_ids: s.shapes.map((x) => x.object_id) })) }; } },
  { name: "ws_slides_read_notes", description: "Speaker notes (all slides, or one slide_id).", schema: { ...fileRef, slide_id: z.string().max(12).optional() },
    run: async (a, c) => { const { e, deck } = await loadDeck(c.getConfig(), refOf(a)); const ss = a.slide_id ? [X.slideById(deck, a.slide_id)] : deck.slides; return { path: e.path, notes: ss.map((s) => ({ slide_id: s.id, text: X.notesText(deck, s) })) }; } },
  { name: "ws_slides_find_replace", description: "Find/replace text. scope: slides (default; never touches notes), notes, or all. Atomic; 0 occurrences = no match.",
    schema: { ...fileRef, find: z.string().min(1).max(2000).optional(), replace: z.string().max(20000).optional(), match_case: z.boolean().optional().default(true), scope: z.enum(["slides", "notes", "all"]).optional().default("slides"), slide_ids: z.array(z.string().max(12)).max(500).optional(), pairs: pairs.optional(), ...writeOpts },
    run: (a, c) => deckWrite(c, a, (deck) => { const r = fr(deck, a); return { changed: r.total, summary: "replace text in slides", data: { results: r.results, total_changes: r.total } }; }) },
  { name: "ws_slides_create", description: "Create a .pptx with one title slide.", schema: { title: z.string().min(1).max(200), folder: z.string().max(4096).optional() },
    run: async (a, c) => {
      const cfg = c.getConfig(); const folder = splitFolder(a.folder ?? ""); const base = a.title.normalize("NFC").replace(/\.pptx$/i, "");
      if (/[\/\\]/.test(base)) throw new WsError("bad_path", "titles cannot contain / or \\");
      const deck = X.openPptx(readFileSync(new URL("../templates/blank.pptx", import.meta.url)));
      const { slide_id } = X.addSlide(deck, "Title Slide");
      const title = X.readDeck(deck, false)[0].shapes.find((s) => s.kind === "ctrTitle" || s.kind === "title");
      if (title) X.editShapeText(deck, title.object_id, base);
      return { created: true, slide_id, ...(await createFile(cfg, folder, `${base}.pptx`, deck.pkg.save(), { summary: `create ${base}.pptx`, clock: c.clock })) };
    } },
  { name: "ws_slides_add_slide", description: "Add a slide using one of the deck's layouts by name (e.g. 'Title and Content', 'Blank').", schema: { ...fileRef, layout: z.string().max(100).optional().default("Blank"), index: z.number().int().min(0).optional(), ...writeOpts },
    run: (a, c) => deckWrite(c, a, (deck) => ({ changed: 1, summary: "add slide", data: X.addSlide(deck, a.layout, a.index) })) },
  { name: "ws_slides_duplicate_slide", description: "Duplicate a slide (with its notes) right after it.", schema: { ...fileRef, slide_id: z.string().max(12), ...writeOpts },
    run: (a, c) => deckWrite(c, a, (deck) => ({ changed: 1, summary: "duplicate slide", data: X.duplicateSlide(deck, a.slide_id) })) },
  { name: "ws_slides_delete_slide", description: "Delete a slide and its notes. Destructive: confirm intent with the user first.", schema: { ...fileRef, slide_id: z.string().max(12), ...writeOpts },
    run: (a, c) => deckWrite(c, a, (deck) => ({ changed: 1, summary: "delete slide", data: X.deleteSlide(deck, a.slide_id) })) },
  { name: "ws_slides_reorder_slides", description: "Move slides (in the given order) to insertion_index.", schema: { ...fileRef, slide_ids: z.array(z.string().max(12)).min(1).max(500), insertion_index: z.number().int().min(0), ...writeOpts },
    run: (a, c) => deckWrite(c, a, (deck) => ({ changed: 1, summary: "reorder slides", data: X.reorderSlides(deck, a.slide_ids, a.insertion_index) })) },
  { name: "ws_slides_add_text_box", description: "Add a text box (position/size in inches).", schema: { ...fileRef, slide_id: z.string().max(12), text: z.string().max(20000), x: z.number().min(0).max(60).optional(), y: z.number().min(0).max(60).optional(), width: z.number().min(0.1).max(60).optional(), height: z.number().min(0.1).max(60).optional(), font_size: z.number().min(1).max(400).optional(), ...writeOpts },
    run: (a, c) => deckWrite(c, a, (deck) => ({ changed: 1, summary: "add text box", data: X.addTextBox(deck, a.slide_id, a.text, a) })) },
  { name: "ws_slides_add_image", description: "Add a PNG/JPEG/GIF from the drive (≤5 MB) to a slide (inches).", schema: { ...fileRef, slide_id: z.string().max(12), image_path: z.string().max(4096), x: z.number().min(0).max(60).optional(), y: z.number().min(0).max(60).optional(), width: z.number().min(0.1).max(60).optional(), height: z.number().min(0.1).max(60).optional(), ...writeOpts },
    run: async (a, c) => { const img = await getFile(c.getConfig(), splitPath(a.image_path), { maxBytes: MAX_IMAGE }); return deckWrite(c, a, (deck) => ({ changed: 1, summary: "add image", data: X.addImage(deck, a.slide_id, img.bytes, a) })); } },
  { name: "ws_slides_format_text", description: "Style all text in a shape: bold, italic, underline, font_size, color_hex, font_family.", schema: { ...fileRef, object_id: z.string().max(30), bold: z.boolean().optional(), italic: z.boolean().optional(), underline: z.boolean().optional(), font_size: z.number().min(1).max(400).optional(), color_hex: z.string().max(7).optional(), font_family: z.string().max(100).optional(), ...writeOpts },
    run: (a, c) => deckWrite(c, a, (deck) => { const n = X.formatShapeText(deck, a.object_id, a); return { changed: n || 1, summary: "format text", data: { runs: n } }; }) },
  { name: "ws_slides_format_paragraph", description: "Paragraph alignment in a shape: START, CENTER, END, JUSTIFIED.", schema: { ...fileRef, object_id: z.string().max(30), alignment: z.enum(["START", "CENTER", "END", "JUSTIFIED"]), ...writeOpts },
    run: (a, c) => deckWrite(c, a, (deck) => ({ changed: 1, summary: "align text", data: { aligned: X.formatParagraphs(deck, a.object_id, a.alignment) } })) },
  { name: "ws_slides_edit_text", description: "Replace a shape's text, keeping the first run's formatting. \\n makes new paragraphs.", schema: { ...fileRef, object_id: z.string().max(30), new_text: z.string().max(20000), ...writeOpts },
    run: (a, c) => deckWrite(c, a, (deck) => ({ changed: 1, summary: "edit slide text", data: { edited: X.editShapeText(deck, a.object_id, a.new_text) } })) },
  { name: "ws_slides_edit_notes", description: "Set or append speaker notes (creates the notes page if needed).", schema: { ...fileRef, slide_id: z.string().max(12), text: z.string().max(20000), mode: z.enum(["replace", "append"]).optional().default("replace"), ...writeOpts },
    run: (a, c) => deckWrite(c, a, (deck) => ({ changed: 1, summary: "edit notes", data: { edited: X.editNotes(deck, a.slide_id, a.text, a.mode) } })) },
  { name: "ws_slides_batch_update", description: "Typed ops in one version: edit_text, find_replace, add_slide, delete_slide, reorder_slides, edit_notes, format_text.",
    schema: { ...fileRef, ops: z.array(z.object({ op: z.enum(["edit_text", "find_replace", "add_slide", "delete_slide", "reorder_slides", "edit_notes", "format_text"]) }).passthrough()).min(1).max(200), ...writeOpts },
    run: (a, c) => deckWrite(c, a, async (deck) => { let n = 0; for (const op of a.ops) n += await opRun(deck, op); return { changed: n || a.ops.length, summary: `${a.ops.length} slide op(s)`, data: { applied: a.ops.length } }; }) },
];
export const registerSlides = (server, ctx) => defineTools(server, ctx, slidesDefs);
```

In `server.js`: `names.push(...registerSlides(server, ctx));`.

- [ ] **Step 5: Run the tests**

Run: `npm test -- tests/workspace-slides.test.js`
Expected: PASS. If python-pptx's layout names differ (`Title and Content` / `Blank` / `Title Slide` are its defaults), the error-listing test tells you the actual names. ONLYOFFICE keeps layout names on save.

- [ ] **Step 6: Commit**

```bash
git add bundles/workspace/server/ooxml/pptx.js bundles/workspace/server/tools/slides.js tests/workspace-slides.test.js
git commit bundles/workspace/server tests/workspace-slides.test.js -m "feat(workspace): Slides tools — notes-safe find/replace, layouts, notes pages, text boxes, images"
git show --stat HEAD
```

---
### Task 10: Calendar + Contacts (CalDAV/CardDAV) and the PIM undo journal

**Files:**
- Create: `bundles/workspace/server/pim/{dav-xml.js,caldav.js,carddav.js,journal.js}`, `bundles/workspace/server/tools/{calendar.js,contacts.js}`, `tests/helpers/workspace-fake-pim.js`
- Modify: `bundles/workspace/server/tools/undo.js` (add `j1`), `bundles/workspace/server/server.js`
- Test: `tests/workspace-calendar.test.js`, `tests/workspace-contacts.test.js`

**Interfaces:**
- Consumes: `ncFetch`, `httpFail`, `parseMultistatus`, `propText`, `displayName`, `normEtag`, `undoHandlers` (Task 5).
- Produces `pim/journal.js`:
  - `recordChange(entry) → "j1.<id>"`, where entry = `{kind:"cal"|"card", ref, href, op:"create"|"update"|"delete", before_text|null, after_etag|null}`
  - `loadChange(versionId)`, `pruneJournal({maxAgeDays=30, maxEntries=500})`
  - files are 600, directory is 700
- Produces `pim/caldav.js`:
  - `listCalendars(cfg)`, `resolveCalendar(cfg, nameOrId)`
  - `queryEvents(cfg, cal, startDate, endDate)`, `findByUid(cfg, collection, uid, kind)`
  - `getObject(cfg, href)`, `putObject(cfg, href, text, {ifMatch, ifNoneMatch})`, `deleteObject(cfg, href, etag)`
  - `expandEvents(ics, start, end, single) → [event]`, `buildEvent(fields) → ics`, `updateEvent(ics, fields) → ics`, `respond(ics, address, response, comment) → ics`
  - `myAddress(cfg)`
- Produces `pim/carddav.js`: `listBooks(cfg)`, `resolveBook(cfg, nameOrId)`, `searchContacts(cfg, book|null, query, max)`, `parseCard(vcf)`, `buildCard(fields)`, `updateCard(vcf, fields)`.
- Produces `pimUndo(cfg, args)`, registered as `undoHandlers.j1`.
- Produces the helper `installFakePim(fake) → { calendars, books }` (in-memory, with `addCalendar(id, name, {writable})`, `addEvent(calId, filename, ics)`, `addBook(id, name)`, `addCard(bookId, filename, vcf)`).

- [ ] **Step 1: Write the fake PIM extension**

`tests/helpers/workspace-fake-pim.js`:

```js
/** CalDAV/CardDAV extension of the fake Nextcloud (test-only regex parsing). */
const xmlEsc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
export function installFakePim(fake) {
  let n = 0;
  const calendars = new Map(); const books = new Map();
  const etag = () => `"p${++n}"`;
  const api = {
    calendars, books,
    addCalendar(id, name, { writable = true, owner = "admin" } = {}) { calendars.set(id, { id, name, writable, owner, objects: new Map() }); },
    addEvent(calId, file, ics) { calendars.get(calId).objects.set(file, { text: ics, etag: etag() }); },
    addBook(id, name) { books.set(id, { id, name, objects: new Map() }); },
    addCard(bookId, file, vcf) { books.get(bookId).objects.set(file, { text: vcf, etag: etag() }); },
  };
  const coll = (kind) => (kind === "calendars" ? calendars : books);
  fake.extraRoutes = async (req, res, body, { send, ms }) => {
    const u = decodeURIComponent(req.url.split("?")[0]);
    const m = /^\/remote\.php\/dav\/(calendars|addressbooks\/users)\/crow-bot\/(?:([^/]+)\/(?:([^/]+))?)?$/.exec(u);
    if (u === "/remote.php/dav/principals/users/crow-bot/" && req.method === "PROPFIND") { send(207, ms(`<d:response><d:href>${u}</d:href><d:propstat><d:prop><cal:calendar-user-address-set xmlns:cal="urn:ietf:params:xml:ns:caldav"><d:href>mailto:crow-bot@workspace.local</d:href></cal:calendar-user-address-set></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`)); return true; }
    if (!m) return false;
    const kind = m[1].startsWith("cal") ? "calendars" : "books"; const base = `/remote.php/dav/${m[1]}/crow-bot/`;
    const C = coll(kind);
    if (!m[2] && req.method === "PROPFIND") {
      const rows = [...C.values()].map((c) => `<d:response><d:href>${base}${encodeURIComponent(c.id)}/</d:href><d:propstat><d:prop><d:displayname>${xmlEsc(c.name)}</d:displayname><d:resourcetype><d:collection/>${kind === "calendars" ? "<cal:calendar/>" : "<card:addressbook/>"}</d:resourcetype>${kind === "calendars" ? `<cal:supported-calendar-component-set><cal:comp name="VEVENT"/></cal:supported-calendar-component-set>` : ""}<oc:owner-principal>principals/users/${c.owner || "admin"}</oc:owner-principal><d:current-user-privilege-set><d:privilege><d:read/></d:privilege>${c.writable === false ? "" : "<d:privilege><d:write/></d:privilege>"}</d:current-user-privilege-set></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`).join("");
      send(207, ms(rows).replace("<d:multistatus", '<d:multistatus xmlns:cal="urn:ietf:params:xml:ns:caldav" xmlns:card="urn:ietf:params:xml:ns:carddav"')); return true;
    }
    const c = C.get(m[2]); if (!c) { send(404); return true; }
    if (!m[3] && req.method === "REPORT") {
      const b = body.toString(); const uid = (b.match(/<c:text-match[^>]*>([^<]*)<\/c:text-match>/) || [])[1];
      const q = (b.match(/<card:text-match[^>]*>([^<]*)<\/card:text-match>/) || [])[1];
      const hits = [...c.objects].filter(([, o]) => (!uid || o.text.includes(`UID:${uid}`)) && (!q || o.text.toLowerCase().includes(q.toLowerCase())));
      const tag = kind === "calendars" ? "cal:calendar-data" : "card:address-data";
      send(207, ms(hits.map(([f, o]) => `<d:response><d:href>${base}${encodeURIComponent(m[2])}/${encodeURIComponent(f)}</d:href><d:propstat><d:prop><d:getetag>${o.etag}</d:getetag><${tag}>${xmlEsc(o.text)}</${tag}></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`).join("")).replace("<d:multistatus", '<d:multistatus xmlns:cal="urn:ietf:params:xml:ns:caldav" xmlns:card="urn:ietf:params:xml:ns:carddav"'));
      return true;
    }
    const o = c.objects.get(m[3]);
    if (req.method === "GET") { if (!o) send(404); else send(200, o.text, { ETag: o.etag, "Content-Type": "text/calendar" }); return true; }
    if (req.method === "PUT") {
      if (c.writable === false) { send(403); return true; }
      if (req.headers["if-none-match"] === "*" && o) { send(412); return true; }
      if (req.headers["if-match"] && (!o || req.headers["if-match"] !== o.etag)) { send(412); return true; }
      const e = etag(); c.objects.set(m[3], { text: body.toString(), etag: e }); send(o ? 204 : 201, "", { ETag: e }); return true;
    }
    if (req.method === "DELETE") { if (!o) { send(404); return true; } if (req.headers["if-match"] && req.headers["if-match"] !== o.etag) { send(412); return true; } c.objects.delete(m[3]); send(204); return true; }
    return false;
  };
  return api;
}
```

- [ ] **Step 2: Write the failing tests**

`tests/workspace-calendar.test.js`:

```js
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { statSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { startFakeNextcloud } from "./helpers/workspace-fake-nextcloud.js";
import { installFakePim } from "./helpers/workspace-fake-pim.js";
import { connectWorkspace } from "./helpers/workspace-client.js";

const CHICAGO = ["BEGIN:VTIMEZONE", "TZID:America/Chicago", "BEGIN:DAYLIGHT", "TZOFFSETFROM:-0600", "TZOFFSETTO:-0500", "TZNAME:CDT", "DTSTART:19700308T020000", "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU", "END:DAYLIGHT", "BEGIN:STANDARD", "TZOFFSETFROM:-0500", "TZOFFSETTO:-0600", "TZNAME:CST", "DTSTART:19701101T020000", "RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU", "END:STANDARD", "END:VTIMEZONE"].join("\r\n");
const cal = (...lines) => ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//test//EN", CHICAGO, ...lines, "END:VCALENDAR"].join("\r\n");
let fake, pim, call, close, home;
before(async () => {
  fake = await startFakeNextcloud(); pim = installFakePim(fake);
  pim.addCalendar("menu_shared_by_admin", "Menu"); pim.addCalendar("feriados", "Feriados", { writable: false });
  pim.addEvent("menu_shared_by_admin", "cena.ics", cal("BEGIN:VEVENT", "UID:cena-1", "DTSTAMP:20261001T000000Z", "DTSTART;TZID=America/Chicago:20261022T180000", "DTEND;TZID=America/Chicago:20261022T190000", "RRULE:FREQ=WEEKLY;COUNT=3", "SUMMARY:Cena: tacos al pastor", "END:VEVENT"));
  ({ call, close, home } = await connectWorkspace(fake));
});
after(async () => { await close(); fake.close(); });

test("list calendars with writability; ambiguous/unknown names list the options", async () => {
  const r = await call("ws_cal_list_calendars", {});
  assert.deepEqual(r.data.calendars.map((c) => [c.name, c.writable]), [["Menu", true], ["Feriados", false]]);
  assert.match((await call("ws_cal_list_events", { calendar: "Nope" })).error, /Menu.*Feriados/);
});

test("weekly recurrence across DST keeps wall time (Review Focus 4); accents survive", async () => {
  const r = await call("ws_cal_list_events", { calendar: "Menu", time_min: "2026-10-20T00:00:00Z", time_max: "2026-11-10T00:00:00Z" });
  assert.deepEqual(r.data.events.map((e) => e.start), ["2026-10-22T18:00:00-05:00", "2026-10-29T18:00:00-05:00", "2026-11-05T18:00:00-06:00"]);
  assert.equal(r.data.events[0].summary, "Cena: tacos al pastor");
});

test("all-day on the DST day stays a date (Review Focus 4); single-day end is made exclusive", async () => {
  const c = await call("ws_cal_create_event", { calendar: "Menu", summary: "Menú: pozole", start: "2026-11-01", end: "2026-11-01" });
  assert.equal(c.success, true); assert.match(c.data.ref, /^cal:menu_shared_by_admin\//);
  const obj = [...pim.calendars.get("menu_shared_by_admin").objects.values()].find((o) => o.text.includes("pozole")).text;
  assert.match(obj, /DTSTART;VALUE=DATE:20261101/); assert.match(obj, /DTEND;VALUE=DATE:20261102/);
  const l = await call("ws_cal_list_events", { calendar: "Menu", time_min: "2026-11-01T00:00:00-05:00", time_max: "2026-11-02T00:00:00-06:00", query: "POZOLE" });
  assert.deepEqual(l.data.events.map((e) => [e.start, e.all_day]), [["2026-11-01", true]]);
});

test("datetimes need an offset; attendees get SCHEDULE-AGENT=CLIENT by default", async () => {
  assert.equal((await call("ws_cal_create_event", { calendar: "Menu", summary: "x", start: "2026-10-10T18:00", end: "2026-10-10T19:00" })).code, "bad_time");
  await call("ws_cal_create_event", { calendar: "Menu", summary: "Con invitados", start: "2026-10-10T18:00:00-05:00", end: "2026-10-10T19:00:00-05:00", attendees: ["dayane@example.org"] });
  const obj = [...pim.calendars.get("menu_shared_by_admin").objects.values()].find((o) => o.text.includes("Con invitados")).text;
  assert.match(obj.replace(/\r\n /g, ""), /ATTENDEE;[^:]*SCHEDULE-AGENT=CLIENT[^:]*:mailto:dayane@example\.org/);
});

test("update + delete are journaled and undoable; undo refuses after a human edit; journal files are 600", async () => {
  const c = await call("ws_cal_create_event", { calendar: "Menu", summary: "Lunes: sopa", start: "2026-10-12", end: "2026-10-13" });
  const u = await call("ws_cal_update_event", { calendar: "Menu", uid: c.data.uid, summary: "Lunes: caldo" });
  assert.ok(u.data.version_id.startsWith("j1."));
  await call("ws_undo_last_change", { path: u.data.ref, version_id: u.data.version_id });
  assert.equal((await call("ws_cal_get_event", { calendar: "Menu", uid: c.data.uid })).data.summary, "Lunes: sopa");
  const d = await call("ws_cal_delete_event", { calendar: "Menu", uid: c.data.uid });
  await call("ws_undo_last_change", { path: d.data.ref, version_id: d.data.version_id });
  assert.equal((await call("ws_cal_get_event", { calendar: "Menu", uid: c.data.uid })).success, true);
  const u2 = await call("ws_cal_update_event", { calendar: "Menu", uid: c.data.uid, location: "Casa" });
  const file = [...pim.calendars.get("menu_shared_by_admin").objects.entries()].find(([, o]) => o.text.includes(c.data.uid))[0];
  pim.addEvent("menu_shared_by_admin", file, pim.calendars.get("menu_shared_by_admin").objects.get(file).text.replace("Casa", "Casa de Dayane"));
  assert.equal((await call("ws_undo_last_change", { path: u2.data.ref, version_id: u2.data.version_id })).code, "changed_since");
  const dir = join(home, "data", "workspace-tools", "journal");
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  for (const f of readdirSync(dir)) assert.equal(statSync(join(dir, f)).mode & 0o777, 0o600);
});

test("read-only calendar refuses writes with a clear code", async () => {
  assert.equal((await call("ws_cal_create_event", { calendar: "Feriados", summary: "x", start: "2026-10-10", end: "2026-10-11" })).code, "read_only");
});

test("respond_to_event sets crow-bot's own PARTSTAT; not an attendee → error", async () => {
  pim.addEvent("menu_shared_by_admin", "inv.ics", cal("BEGIN:VEVENT", "UID:inv-1", "DTSTAMP:20261001T000000Z", "DTSTART:20261015T230000Z", "DTEND:20261016T000000Z", "SUMMARY:Junta", "ORGANIZER:mailto:kevin@example.org", "ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:crow-bot@workspace.local", "END:VEVENT"));
  assert.equal((await call("ws_cal_respond_to_event", { calendar: "Menu", uid: "inv-1", response: "accepted" })).success, true);
  assert.match(pim.calendars.get("menu_shared_by_admin").objects.get("inv.ics").text, /PARTSTAT=ACCEPTED/);
  assert.equal((await call("ws_cal_respond_to_event", { calendar: "Menu", uid: "cena-1", response: "accepted" })).code, "not_attendee");
});
```

`tests/workspace-contacts.test.js`:

```js
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startFakeNextcloud } from "./helpers/workspace-fake-nextcloud.js";
import { installFakePim } from "./helpers/workspace-fake-pim.js";
import { connectWorkspace } from "./helpers/workspace-client.js";

let fake, pim, call, close;
before(async () => {
  fake = await startFakeNextcloud(); pim = installFakePim(fake);
  pim.addBook("casa_shared_by_admin", "Casa"); pim.addBook("z-server-generated--system", "System");
  pim.addCard("casa_shared_by_admin", "abuela.vcf", "BEGIN:VCARD\r\nVERSION:3.0\r\nUID:ab-1\r\nFN:Abuela Rosa\r\nN:Rosa;Abuela;;;\r\nTEL;TYPE=CELL:+52 55 1234 5678\r\nX-CUSTOM:keep-me\r\nEND:VCARD\r\n");
  ({ call, close } = await connectWorkspace(fake));
});
after(async () => { await close(); fake.close(); });

test("generated system books are hidden", async () => {
  assert.deepEqual((await call("ws_contacts_list_addressbooks", {})).data.addressbooks.map((b) => b.name), ["Casa"]);
});
test("search + get; update keeps unknown vCard properties; delete is undoable", async () => {
  const s = await call("ws_contacts_search", { query: "rosa" });
  assert.equal(s.data.contacts[0].full_name, "Abuela Rosa");
  const u = await call("ws_contacts_update", { addressbook: "Casa", uid: "ab-1", emails: ["rosa@example.org"] });
  const text = pim.books.get("casa_shared_by_admin").objects.get("abuela.vcf").text;
  assert.match(text, /X-CUSTOM:keep-me/); assert.match(text, /EMAIL[^:]*:rosa@example\.org/);
  assert.ok(u.data.version_id);
  const d = await call("ws_contacts_delete", { addressbook: "Casa", uid: "ab-1" });
  assert.equal(pim.books.get("casa_shared_by_admin").objects.size, 0);
  await call("ws_undo_last_change", { path: d.data.ref, version_id: d.data.version_id });
  assert.equal((await call("ws_contacts_get", { addressbook: "Casa", uid: "ab-1" })).data.full_name, "Abuela Rosa");
});
test("create writes vCard 3.0 with N derived from the name; accents survive", async () => {
  const c = await call("ws_contacts_create", { addressbook: "Casa", full_name: "José Peña", phones: ["+1 512 555 0100"] });
  const t = [...pim.books.get("casa_shared_by_admin").objects.values()].find((o) => o.text.includes("Peña")).text;
  assert.match(t, /VERSION:3\.0/); assert.match(t, /N:Peña;José;;;/); assert.ok(c.data.uid);
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `npm test -- tests/workspace-calendar.test.js tests/workspace-contacts.test.js`
Expected: FAIL.

- [ ] **Step 4: Write `pim/journal.js` and `pim/dav-xml.js`**

`pim/journal.js`:

```js
/** Undo journal for calendar/contact changes (spec §5.5): dir 700, files 600, 30 days / 500 entries. */
import { mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, unlinkSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { WsError } from "../result.js";

const dir = () => join(process.env.CROW_DATA_DIR || join(process.env.CROW_HOME || join(homedir(), ".crow"), "data"), "workspace-tools", "journal");
const ID = /^j1\.([0-9a-z]{6,12}-[0-9a-f]{12})$/;
export function recordChange(entry) {
  const d = dir(); mkdirSync(d, { recursive: true, mode: 0o700 }); chmodSync(d, 0o700);
  const id = `${Date.now().toString(36)}-${randomBytes(6).toString("hex")}`;
  writeFileSync(join(d, `${id}.json`), JSON.stringify({ id, ...entry, at: new Date().toISOString() }), { mode: 0o600 });
  return `j1.${id}`;
}
export function loadChange(versionId) {
  const m = ID.exec(String(versionId)); if (!m) throw new WsError("bad_version_id", "That version_id was not issued by the Workspace tools.");
  try { return JSON.parse(readFileSync(join(dir(), `${m[1]}.json`), "utf8")); }
  catch { throw new WsError("version_gone", "That change is no longer in the undo journal (changes are kept 30 days)."); }
}
export function pruneJournal({ maxAgeDays = 30, maxEntries = 500 } = {}) {
  let files; try { files = readdirSync(dir()).filter((f) => f.endsWith(".json")); } catch { return 0; }
  const withTime = files.map((f) => ({ f, t: statSync(join(dir(), f)).mtimeMs })).sort((a, b) => b.t - a.t);
  const cutoff = Date.now() - maxAgeDays * 86400000; let removed = 0;
  withTime.forEach((x, i) => { if (i >= maxEntries || x.t < cutoff) { unlinkSync(join(dir(), x.f)); removed++; } });
  return removed;
}
```

`pim/dav-xml.js`:

```js
import { xmlEscape } from "../ooxml/xml.js";
export const HOME_PROPFIND = `<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav" xmlns:oc="http://owncloud.org/ns" xmlns:x="http://apple.com/ns/ical/"><d:prop><d:displayname/><d:resourcetype/><cal:supported-calendar-component-set/><d:current-user-privilege-set/><oc:owner-principal/><x:calendar-color/></d:prop></d:propfind>`;
const utc = (d) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
export const calendarQuery = (start, end) => `<?xml version="1.0"?><c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/><c:calendar-data/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="${utc(start)}" end="${utc(end)}"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`;
export const uidQueryCal = (uid) => `<?xml version="1.0"?><c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/><c:calendar-data/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:prop-filter name="UID"><c:text-match collation="i;octet">${xmlEscape(uid)}</c:text-match></c:prop-filter></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`;
export const cardQuery = (text, props = ["FN", "EMAIL", "TEL", "NICKNAME"]) => `<?xml version="1.0"?><card:addressbook-query xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav"><d:prop><d:getetag/><card:address-data/></d:prop><card:filter test="anyof">${props.map((p) => `<card:prop-filter name="${p}"><card:text-match collation="i;unicode-casemap" match-type="contains">${xmlEscape(text)}</card:text-match></card:prop-filter>`).join("")}</card:filter></card:addressbook-query>`;
```

- [ ] **Step 5: Write `pim/caldav.js` and `pim/carddav.js`**

`pim/caldav.js`:

```js
import ICAL from "ical.js";
import { randomUUID } from "node:crypto";
import { WsError } from "../result.js";
import { NS, kid, kids } from "../ooxml/xml.js";
import { ncFetch, httpFail } from "../nc/http.js";
import { parseMultistatus, propText } from "../nc/multistatus.js";
import { normEtag } from "../nc/dav.js";
import { displayName } from "../nc/ocs.js";
import { HOME_PROPFIND, calendarQuery, uidQueryCal } from "./dav-xml.js";

const home = (cfg, kind) => `/remote.php/dav/${kind === "card" ? "addressbooks/users" : "calendars"}/${encodeURIComponent(cfg.user)}/`;
export const lastSeg = (href) => decodeURIComponent(href.replace(/\/$/, "").split("/").pop());
function assertUnder(href, prefix) { if (!href.startsWith(prefix) || href.slice(prefix.length).includes("/") || href.includes("..")) throw new WsError("bad_path", "the server answered with an unexpected object path"); return href; }

export async function listCollections(cfg, kind) {
  const r = await ncFetch(cfg, "PROPFIND", `${cfg.ncUrl}${home(cfg, kind)}`, { headers: { Depth: "1", "Content-Type": "application/xml" }, body: HOME_PROPFIND });
  if (r.status !== 207) throw httpFail(r, kind === "card" ? "list address books" : "list calendars");
  const out = [];
  for (const x of parseMultistatus(await r.text())) {
    const rt = x.props.get(`${NS.d}|resourcetype`);
    const isIt = kind === "card" ? !!kid(rt, NS.card, "addressbook") : !!kid(rt, NS.cal, "calendar");
    if (!isIt) continue;
    const comps = x.props.get(`${NS.cal}|supported-calendar-component-set`);
    if (kind !== "card" && comps && !kids(comps, NS.cal, "comp").some((c) => c.getAttribute("name") === "VEVENT")) continue;
    const id = lastSeg(x.href);
    if (kind === "card" && /^z-(server|app)-generated--/.test(id)) continue;
    const priv = x.props.get(`${NS.d}|current-user-privilege-set`);
    const writable = !priv || Array.from(priv.getElementsByTagNameNS(NS.d, "write")).length + Array.from(priv.getElementsByTagNameNS(NS.d, "write-content")).length > 0;
    const ownerP = propText(x.props, NS.oc, "owner-principal") || "";
    const ownerUid = ownerP.replace(/\/$/, "").split("/").pop();
    out.push({ id, href: x.href.endsWith("/") ? x.href : `${x.href}/`, name: propText(x.props, NS.d, "displayname") || id, writable, owner_uid: ownerUid, color: propText(x.props, "http://apple.com/ns/ical/", "calendar-color") || null });
  }
  for (const c of out) c.owner = c.owner_uid ? await displayName(cfg, c.owner_uid).catch(() => c.owner_uid) : null;
  return out;
}
export const listCalendars = (cfg) => listCollections(cfg, "cal");
export async function resolveCollection(cfg, kind, nameOrId) {
  const all = await listCollections(cfg, kind);
  const want = String(nameOrId).normalize("NFC");
  const byId = all.find((c) => c.id === want); if (byId) return byId;
  const byName = all.filter((c) => c.name.normalize("NFC").toLowerCase() === want.toLowerCase());
  if (byName.length === 1) return byName[0];
  const what = kind === "card" ? "address book" : "calendar";
  throw new WsError(byName.length ? "ambiguous" : `${kind === "card" ? "addressbook" : "calendar"}_not_found`, `${byName.length ? `More than one ${what} is named` : `No ${what} named`} "${nameOrId}" is shared with Crow bot. Available: ${all.map((c) => `${c.name} (${c.id})`).join(", ") || "none — ask the household to share one with Crow bot"}`);
}
export const resolveCalendar = (cfg, n) => resolveCollection(cfg, "cal", n);

async function report(cfg, href, body) {
  const r = await ncFetch(cfg, "REPORT", `${cfg.ncUrl}${href}`, { headers: { Depth: "1", "Content-Type": "application/xml; charset=utf-8" }, body });
  if (r.status !== 207) throw httpFail(r, "search the collection");
  return parseMultistatus(await r.text()).map((x) => ({ href: assertUnder(x.href, href), etag: normEtag(propText(x.props, NS.d, "getetag")), text: propText(x.props, NS.cal, "calendar-data") ?? propText(x.props, NS.card, "address-data") ?? "" }));
}
export const queryEvents = (cfg, cal, start, end) => report(cfg, cal.href, calendarQuery(start, end));
export async function findByUid(cfg, coll, uid, kind = "cal") {
  const { uidQueryCard } = await import("./carddav.js");
  const hits = await report(cfg, coll.href, kind === "card" ? uidQueryCard(uid) : uidQueryCal(uid));
  const hit = hits.find((h) => new RegExp(`^UID:${uid.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\r?$`, "m").test(h.text.replace(/\r\n[ \t]/g, "")));
  if (!hit) throw new WsError(kind === "card" ? "contact_not_found" : "event_not_found", `No ${kind === "card" ? "contact" : "event"} with uid ${uid} in "${coll.name}"`);
  return hit;
}
export async function getObject(cfg, href) {
  const r = await ncFetch(cfg, "GET", `${cfg.ncUrl}${href}`);
  if (r.status === 404) return null;
  if (!r.ok) throw httpFail(r, "read the item");
  return { etag: normEtag(r.headers.get("etag")), text: await r.text() };
}
export function putObject(cfg, href, text, { ifMatch, ifNoneMatch } = {}) {
  const headers = { "Content-Type": href.endsWith(".vcf") ? "text/vcard; charset=utf-8" : "text/calendar; charset=utf-8" };
  if (ifMatch) headers["If-Match"] = `"${normEtag(ifMatch)}"`; if (ifNoneMatch) headers["If-None-Match"] = ifNoneMatch;
  return ncFetch(cfg, "PUT", `${cfg.ncUrl}${href}`, { headers, body: text });
}
export async function deleteObject(cfg, href, etag) {
  const r = await ncFetch(cfg, "DELETE", `${cfg.ncUrl}${href}`, { headers: { "If-Match": `"${normEtag(etag)}"` } });
  if (r.status === 412) throw new WsError("changed_concurrently", "Someone changed it at the same moment; read it again.");
  if (r.status !== 204) throw httpFail(r, "delete it");
}
export async function myAddress(cfg) {
  const r = await ncFetch(cfg, "PROPFIND", `${cfg.ncUrl}/remote.php/dav/principals/users/${encodeURIComponent(cfg.user)}/`, { headers: { Depth: "0", "Content-Type": "application/xml" }, body: `<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-user-address-set/></d:prop></d:propfind>` });
  if (r.status !== 207) return [];
  const set = parseMultistatus(await r.text())[0]?.props.get(`${NS.cal}|calendar-user-address-set`);
  return set ? kids(set, NS.d, "href").map((h) => h.textContent.toLowerCase()) : [];
}

// ---------- iCalendar ----------
const DT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const D = /^\d{4}-\d{2}-\d{2}$/;
function registerZones(comp) { for (const tz of comp.getAllSubcomponents("vtimezone")) { const z = new ICAL.Timezone(tz); if (!ICAL.TimezoneService.has(z.tzid)) ICAL.TimezoneService.register(z.tzid, z); } }
function iso(t) {
  if (t.isDate) return t.toString();
  if (t.zone === ICAL.Timezone.utcTimezone) return `${t.toString().replace(/Z?$/, "")}Z`;
  const off = t.utcOffset(); const s = off < 0 ? "-" : "+"; const a = Math.abs(off);
  return `${t.toString().replace(/Z$/, "")}${s}${String(Math.floor(a / 3600)).padStart(2, "0")}:${String(Math.floor((a % 3600) / 60)).padStart(2, "0")}`;
}
export function parseCal(ics) { const comp = new ICAL.Component(ICAL.parse(ics)); registerZones(comp); return comp; }
function eventOut(ev, startT, endT, extra = {}) {
  return { uid: ev.uid, summary: ev.summary || "", description: ev.description || "", location: ev.location || "", start: iso(startT), end: endT ? iso(endT) : null, all_day: startT.isDate, recurring: ev.isRecurring(), attendees: (ev.attendees || []).map((a) => ({ address: String(a.getFirstValue()).replace(/^mailto:/i, ""), status: a.getParameter("partstat") || null })), ...extra };
}
export function expandEvents(ics, start, end, single = true) {
  const comp = parseCal(ics); const vevents = comp.getAllSubcomponents("vevent");
  const master = vevents.find((v) => !v.hasProperty("recurrence-id")) || vevents[0]; if (!master) return [];
  const ev = new ICAL.Event(master, { exceptions: vevents.filter((v) => v.hasProperty("recurrence-id")) });
  const ws = ICAL.Time.fromJSDate(start, true), we = ICAL.Time.fromJSDate(end, true);
  if (!ev.isRecurring() || !single) return ev.endDate.compare(ws) > 0 && ev.startDate.compare(we) < 0 ? [eventOut(ev, ev.startDate, ev.endDate)] : [];
  const out = []; const it = ev.iterator(); let next; let guard = 0;
  while ((next = it.next()) && guard++ < 2000) {
    if (next.compare(we) >= 0) break;
    const det = ev.getOccurrenceDetails(next);
    if (det.endDate.compare(ws) > 0) out.push(eventOut(det.item, det.startDate, det.endDate, { recurrence_id: iso(det.recurrenceId) }));
  }
  return out;
}
function timeOf(v, field) {
  if (D.test(v)) return ICAL.Time.fromDateString(v);
  if (DT.test(v)) return ICAL.Time.fromJSDate(new Date(v), true);
  throw new WsError("bad_time", `${field} must be YYYY-MM-DD (all-day) or a date-time with an offset, e.g. 2026-10-22T18:00:00-05:00`);
}
function setTimes(ve, start, end) {
  const s = timeOf(start, "start"); let e = timeOf(end, "end");
  if (s.isDate !== e.isDate) throw new WsError("bad_time", "start and end must both be dates or both be date-times");
  if (s.isDate && e.compare(s) <= 0) { e = s.clone(); e.day += 1; }
  if (e.compare(s) <= 0) throw new WsError("bad_time", "end must be after start");
  ve.updatePropertyWithValue("dtstart", s); ve.updatePropertyWithValue("dtend", e);
}
const stamp = (ve) => { const now = ICAL.Time.fromJSDate(new Date(), true); ve.updatePropertyWithValue("dtstamp", now); ve.updatePropertyWithValue("last-modified", now); };
function setText(ve, name, v) { if (v === undefined) return; if (v === "" || v === null) ve.removeProperty(name); else ve.updatePropertyWithValue(name, String(v).normalize("NFC")); }

export function buildEvent({ summary, start, end, description, location, attendees, send_updates = "none", organizer }) {
  const vcal = new ICAL.Component(["vcalendar", [], []]);
  vcal.updatePropertyWithValue("prodid", "-//Crow//Workspace W2//EN"); vcal.updatePropertyWithValue("version", "2.0");
  const ve = new ICAL.Component("vevent"); const uid = randomUUID();
  ve.updatePropertyWithValue("uid", uid); stamp(ve); setTimes(ve, start, end);
  setText(ve, "summary", summary); setText(ve, "description", description); setText(ve, "location", location);
  if (attendees?.length) {
    if (organizer) ve.updatePropertyWithValue("organizer", organizer);
    for (const a of attendees) {
      if (!/^[^\s@]+@[^\s@]+$/.test(a)) throw new WsError("bad_args", `"${a}" is not an email address`);
      const p = new ICAL.Property("attendee"); p.setValue(`mailto:${a}`); p.setParameter("partstat", "NEEDS-ACTION"); p.setParameter("role", "REQ-PARTICIPANT");
      if (send_updates !== "all") p.setParameter("schedule-agent", "CLIENT");
      ve.addProperty(p);
    }
  }
  vcal.addSubcomponent(ve);
  return { uid, ics: vcal.toString() };
}
const masterOf = (comp) => comp.getAllSubcomponents("vevent").find((v) => !v.hasProperty("recurrence-id"));
export function updateEvent(ics, f) {
  const comp = parseCal(ics); const ve = masterOf(comp);
  setText(ve, "summary", f.summary); setText(ve, "description", f.description); setText(ve, "location", f.location);
  if (f.start !== undefined || f.end !== undefined) setTimes(ve, f.start ?? iso(ve.getFirstPropertyValue("dtstart")), f.end ?? iso(ve.getFirstPropertyValue("dtend")));
  ve.updatePropertyWithValue("sequence", Number(ve.getFirstPropertyValue("sequence") || 0) + 1); stamp(ve);
  return comp.toString();
}
export function respond(ics, addresses, response, comment) {
  const comp = parseCal(ics); const ve = masterOf(comp);
  const me = ve.getAllProperties("attendee").find((p) => addresses.includes(String(p.getFirstValue()).toLowerCase()));
  if (!me) throw new WsError("not_attendee", "Crow bot is not invited to this event, so it cannot respond.");
  me.setParameter("partstat", response.toUpperCase()); if (comment) setText(ve, "comment", comment); stamp(ve);
  return comp.toString();
}
export const newObjectHref = (coll, uid, ext) => `${coll.href}${encodeURIComponent(uid)}.${ext}`;
```

`pim/carddav.js`:

```js
import ICAL from "ical.js";
import { randomUUID } from "node:crypto";
import { WsError } from "../result.js";
import { xmlEscape } from "../ooxml/xml.js";
import { listCollections, resolveCollection } from "./caldav.js";
import { cardQuery } from "./dav-xml.js";
import { ncFetch, httpFail } from "../nc/http.js";
import { parseMultistatus, propText } from "../nc/multistatus.js";
import { NS } from "../ooxml/xml.js";
import { normEtag } from "../nc/dav.js";

export const listBooks = (cfg) => listCollections(cfg, "card");
export const resolveBook = (cfg, n) => resolveCollection(cfg, "card", n);
export const uidQueryCard = (uid) => cardQuery(uid, ["UID"]).replace('match-type="contains"', 'match-type="equals"');
export async function searchContacts(cfg, book, query, max) {
  const books = book ? [book] : await listBooks(cfg); const out = [];
  for (const b of books) {
    const r = await ncFetch(cfg, "REPORT", `${cfg.ncUrl}${b.href}`, { headers: { Depth: "1", "Content-Type": "application/xml; charset=utf-8" }, body: cardQuery(String(query).normalize("NFC")) });
    if (r.status !== 207) throw httpFail(r, "search contacts");
    for (const x of parseMultistatus(await r.text())) { const text = propText(x.props, NS.card, "address-data"); if (text) out.push({ ...parseCard(text), addressbook: b.name, etag: normEtag(propText(x.props, NS.d, "getetag")) }); if (out.length >= max) return out; }
  }
  return out;
}
const vcardOf = (text) => { const c = new ICAL.Component(ICAL.parse(text)); return c.name === "vcard" ? c : c.getFirstSubcomponent("vcard"); };
export function parseCard(text) {
  const v = vcardOf(text); const all = (n) => v.getAllProperties(n).map((p) => String(p.getFirstValue()));
  const adr = v.getFirstPropertyValue("adr");
  return { uid: String(v.getFirstPropertyValue("uid") || ""), full_name: String(v.getFirstPropertyValue("fn") || ""), emails: all("email"), phones: all("tel"), address: Array.isArray(adr) ? adr.filter(Boolean).join(", ") : adr ? String(adr) : "", birthday: v.getFirstPropertyValue("bday") ? String(v.getFirstPropertyValue("bday")) : "", note: String(v.getFirstPropertyValue("note") || ""), org: String(v.getFirstPropertyValue("org") || "") };
}
function setMulti(v, name, values) { if (values === undefined) return; v.removeAllProperties(name); for (const x of values) v.addPropertyWithValue(name, String(x)); }
function setOne(v, name, value) { if (value === undefined) return; v.removeAllProperties(name); if (value) v.addPropertyWithValue(name, String(value).normalize("NFC")); }
function nameParts(full) { const parts = String(full).normalize("NFC").trim().split(/\s+/); const family = parts.length > 1 ? parts.pop() : ""; return [family, parts.join(" "), "", "", ""]; }
function applyFields(v, f) {
  if (f.full_name !== undefined) { setOne(v, "fn", f.full_name); v.removeAllProperties("n"); v.addPropertyWithValue("n", nameParts(f.full_name)); }
  setMulti(v, "email", f.emails); setMulti(v, "tel", f.phones);
  if (f.address !== undefined) { v.removeAllProperties("adr"); if (f.address) v.addPropertyWithValue("adr", ["", "", String(f.address), "", "", "", ""]); }
  if (f.birthday !== undefined && f.birthday && !/^\d{4}-\d{2}-\d{2}$/.test(f.birthday)) throw new WsError("bad_args", "birthday must be YYYY-MM-DD");
  setOne(v, "bday", f.birthday); setOne(v, "note", f.note); setOne(v, "org", f.org);
}
export function buildCard(f) {
  const v = new ICAL.Component("vcard"); const uid = randomUUID();
  v.addPropertyWithValue("version", "3.0"); v.addPropertyWithValue("uid", uid); v.addPropertyWithValue("prodid", "-//Crow//Workspace W2//EN");
  applyFields(v, f); return { uid, vcf: v.toString() };
}
export function updateCard(text, f) { const v = vcardOf(text); applyFields(v, f); v.updatePropertyWithValue("rev", ICAL.Time.fromJSDate(new Date(), true).toString()); return v.toString(); }
```

(Before committing, check `ical.js` 2.x's `removeAllProperties`/`addPropertyWithValue`/`updatePropertyWithValue` names against its README. They exist in ical.js 1.x and 2.x. `parseCal`/`vcardOf` use `ICAL.parse`, which handles both iCalendar and vCard.)

- [ ] **Step 6: Write `tools/calendar.js`, `tools/contacts.js`, the `j1` undo branch, and register**

`tools/calendar.js`:

```js
import { z } from "zod";
import { WsError } from "../result.js";
import { defineTools } from "./define.js";
import * as C from "../pim/caldav.js";
import { recordChange } from "../pim/journal.js";

const ref = (cal, uid) => `cal:${cal.id}/${uid}`;
const needWritable = (cal) => { if (!cal.writable) throw new WsError("read_only", `Crow bot can read "${cal.name}" but not change it. Ask the owner to share it with edit rights.`); };
const etagAfter = async (cfg, href) => (await C.getObject(cfg, href))?.etag ?? null;
const winDate = (v, fallback) => { if (v === undefined) return fallback; const d = new Date(v); if (Number.isNaN(d.getTime())) throw new WsError("bad_time", `${v} is not a date-time`); return d; };

export const calendarDefs = [
  { name: "ws_cal_list_calendars", description: "Calendars shared with Crow bot: id, name, owner, writable, color.", schema: {},
    run: async (_a, c) => ({ calendars: (await C.listCalendars(c.getConfig())).map(({ id, name, owner, writable, color }) => ({ id, name, owner, writable, color })) }) },
  { name: "ws_cal_list_events", description: "Events in a window (default now → +30 days, max 366 days). single_events expands repeats. query matches summary/description/location.",
    schema: { calendar: z.string().min(1).max(200), time_min: z.string().max(40).optional(), time_max: z.string().max(40).optional(), max_results: z.number().int().min(1).max(250).optional().default(20), query: z.string().max(200).optional(), single_events: z.boolean().optional().default(true) },
    run: async (a, c) => {
      const cfg = c.getConfig(); const cal = await C.resolveCalendar(cfg, a.calendar);
      const start = winDate(a.time_min, new Date(c.clock.now())); const end = winDate(a.time_max, new Date(start.getTime() + 30 * 86400000));
      if (end <= start || end - start > 366 * 86400000) throw new WsError("bad_time", "time_max must be after time_min and within 366 days");
      const q = a.query ? a.query.normalize("NFC").toLowerCase() : null; let events = [];
      for (const o of await C.queryEvents(cfg, cal, start, end)) events.push(...C.expandEvents(o.text, start, end, a.single_events).map((e) => ({ ...e, ref: ref(cal, e.uid) })));
      if (q) events = events.filter((e) => `${e.summary}\n${e.description}\n${e.location}`.normalize("NFC").toLowerCase().includes(q));
      events.sort((x, y) => new Date(x.start.length === 10 ? `${x.start}T00:00:00Z` : x.start) - new Date(y.start.length === 10 ? `${y.start}T00:00:00Z` : y.start));
      return { calendar: cal.name, events: events.slice(0, a.max_results) };
    } },
  { name: "ws_cal_get_event", description: "One event by uid: parsed fields plus raw ICS.", schema: { calendar: z.string().min(1).max(200), uid: z.string().min(1).max(500) },
    run: async (a, c) => { const cfg = c.getConfig(); const cal = await C.resolveCalendar(cfg, a.calendar); const o = await C.findByUid(cfg, cal, a.uid); const ev = C.expandEvents(o.text, new Date(0), new Date(8.64e15), false)[0] || {}; return { ...ev, ref: ref(cal, a.uid), ics: o.text }; } },
  { name: "ws_cal_create_event", description: "Create an event. start/end: YYYY-MM-DD for all-day (end exclusive; same day is fine) or date-times with an offset. send_updates 'none' (default) sends no invitations.",
    schema: { calendar: z.string().min(1).max(200), summary: z.string().min(1).max(500), start: z.string().max(40), end: z.string().max(40), description: z.string().max(20000).optional(), location: z.string().max(1000).optional(), attendees: z.array(z.string().max(320)).max(50).optional(), send_updates: z.enum(["none", "all"]).optional().default("none") },
    run: async (a, c) => {
      const cfg = c.getConfig(); const cal = await C.resolveCalendar(cfg, a.calendar); needWritable(cal);
      const organizer = a.attendees?.length ? (await C.myAddress(cfg))[0] : undefined;
      const { uid, ics } = C.buildEvent({ ...a, organizer });
      const href = C.newObjectHref(cal, uid, "ics");
      const r = await C.putObject(cfg, href, ics, { ifNoneMatch: "*" }); if (![201, 204].includes(r.status)) throw new WsError("write_failed", `Workspace refused the event (HTTP ${r.status})`);
      const version_id = recordChange({ kind: "cal", ref: ref(cal, uid), href, op: "create", before_text: null, after_etag: await etagAfter(cfg, href) });
      return { uid, ref: ref(cal, uid), calendar: cal.name, version_id };
    } },
  { name: "ws_cal_update_event", description: "Change fields of an event (series master for repeating events). Undoable.",
    schema: { calendar: z.string().min(1).max(200), uid: z.string().min(1).max(500), summary: z.string().max(500).optional(), start: z.string().max(40).optional(), end: z.string().max(40).optional(), description: z.string().max(20000).optional(), location: z.string().max(1000).optional() },
    run: async (a, c) => {
      const cfg = c.getConfig(); const cal = await C.resolveCalendar(cfg, a.calendar); needWritable(cal);
      const o = await C.findByUid(cfg, cal, a.uid); const next = C.updateEvent(o.text, a);
      const r = await C.putObject(cfg, o.href, next, { ifMatch: o.etag }); if (r.status === 412) throw new WsError("changed_concurrently", "Someone changed this event at the same moment; read it again."); if (![201, 204].includes(r.status)) throw new WsError("write_failed", `HTTP ${r.status}`);
      return { uid: a.uid, ref: ref(cal, a.uid), version_id: recordChange({ kind: "cal", ref: ref(cal, a.uid), href: o.href, op: "update", before_text: o.text, after_etag: await etagAfter(cfg, o.href) }) };
    } },
  { name: "ws_cal_delete_event", description: "Delete an event (Workspace keeps it in the calendar trash; also undoable here). Destructive: confirm intent with the user first.",
    schema: { calendar: z.string().min(1).max(200), uid: z.string().min(1).max(500) },
    run: async (a, c) => { const cfg = c.getConfig(); const cal = await C.resolveCalendar(cfg, a.calendar); needWritable(cal); const o = await C.findByUid(cfg, cal, a.uid); await C.deleteObject(cfg, o.href, o.etag); return { deleted: true, ref: ref(cal, a.uid), version_id: recordChange({ kind: "cal", ref: ref(cal, a.uid), href: o.href, op: "delete", before_text: o.text, after_etag: null }) }; } },
  { name: "ws_cal_respond_to_event", description: "Accept, decline or tentatively accept an event Crow bot is invited to.",
    schema: { calendar: z.string().min(1).max(200), uid: z.string().min(1).max(500), response: z.enum(["accepted", "declined", "tentative"]), comment: z.string().max(1000).optional() },
    run: async (a, c) => {
      const cfg = c.getConfig(); const cal = await C.resolveCalendar(cfg, a.calendar); const o = await C.findByUid(cfg, cal, a.uid);
      const next = C.respond(o.text, await C.myAddress(cfg), a.response, a.comment);
      const r = await C.putObject(cfg, o.href, next, { ifMatch: o.etag }); if (![201, 204].includes(r.status)) throw new WsError("write_failed", `HTTP ${r.status}`);
      return { uid: a.uid, response: a.response, version_id: recordChange({ kind: "cal", ref: ref(cal, a.uid), href: o.href, op: "update", before_text: o.text, after_etag: await etagAfter(cfg, o.href) }) };
    } },
];
export const registerCalendar = (server, ctx) => defineTools(server, ctx, calendarDefs);
```

`tools/contacts.js`:

```js
import { z } from "zod";
import { WsError } from "../result.js";
import { defineTools } from "./define.js";
import * as C from "../pim/caldav.js";
import * as K from "../pim/carddav.js";
import { recordChange } from "../pim/journal.js";

const ref = (b, uid) => `contacts:${b.id}/${uid}`;
const fields = { full_name: z.string().min(1).max(500).optional(), emails: z.array(z.string().max(320)).max(20).optional(), phones: z.array(z.string().max(60)).max(20).optional(), address: z.string().max(1000).optional(), birthday: z.string().max(10).optional(), note: z.string().max(5000).optional(), org: z.string().max(500).optional() };
const needW = (b) => { if (!b.writable) throw new WsError("read_only", `Crow bot can read "${b.name}" but not change it.`); };
export const contactsDefs = [
  { name: "ws_contacts_list_addressbooks", description: "Address books shared with Crow bot.", schema: {},
    run: async (_a, c) => ({ addressbooks: (await K.listBooks(c.getConfig())).map(({ id, name, owner, writable }) => ({ id, name, owner, writable })) }) },
  { name: "ws_contacts_search", description: "Find contacts by name, email, phone or nickname.", schema: { query: z.string().min(1).max(200), addressbook: z.string().max(200).optional(), max_results: z.number().int().min(1).max(100).optional().default(20) },
    run: async (a, c) => { const cfg = c.getConfig(); const b = a.addressbook ? await K.resolveBook(cfg, a.addressbook) : null; return { contacts: await K.searchContacts(cfg, b, a.query, a.max_results) }; } },
  { name: "ws_contacts_get", description: "One contact by uid (parsed + raw vCard).", schema: { addressbook: z.string().min(1).max(200), uid: z.string().min(1).max(500) },
    run: async (a, c) => { const cfg = c.getConfig(); const b = await K.resolveBook(cfg, a.addressbook); const o = await C.findByUid(cfg, b, a.uid, "card"); return { ...K.parseCard(o.text), ref: ref(b, a.uid), vcard: o.text }; } },
  { name: "ws_contacts_create", description: "Create a contact (vCard 3.0).", schema: { addressbook: z.string().min(1).max(200), ...fields, full_name: z.string().min(1).max(500) },
    run: async (a, c) => {
      const cfg = c.getConfig(); const b = await K.resolveBook(cfg, a.addressbook); needW(b);
      const { uid, vcf } = K.buildCard(a); const href = C.newObjectHref(b, uid, "vcf");
      const r = await C.putObject(cfg, href, vcf, { ifNoneMatch: "*" }); if (![201, 204].includes(r.status)) throw new WsError("write_failed", `HTTP ${r.status}`);
      return { uid, ref: ref(b, uid), version_id: recordChange({ kind: "card", ref: ref(b, uid), href, op: "create", before_text: null, after_etag: (await C.getObject(cfg, href))?.etag ?? null }) };
    } },
  { name: "ws_contacts_update", description: "Change contact fields; other vCard properties are kept. Undoable.", schema: { addressbook: z.string().min(1).max(200), uid: z.string().min(1).max(500), ...fields },
    run: async (a, c) => {
      const cfg = c.getConfig(); const b = await K.resolveBook(cfg, a.addressbook); needW(b);
      const o = await C.findByUid(cfg, b, a.uid, "card"); const r = await C.putObject(cfg, o.href, K.updateCard(o.text, a), { ifMatch: o.etag });
      if (r.status === 412) throw new WsError("changed_concurrently", "Someone changed this contact at the same moment."); if (![201, 204].includes(r.status)) throw new WsError("write_failed", `HTTP ${r.status}`);
      return { uid: a.uid, ref: ref(b, a.uid), version_id: recordChange({ kind: "card", ref: ref(b, a.uid), href: o.href, op: "update", before_text: o.text, after_etag: (await C.getObject(cfg, o.href))?.etag ?? null }) };
    } },
  { name: "ws_contacts_delete", description: "Delete a contact (undoable here; address books have no trash). Destructive: confirm intent with the user first.", schema: { addressbook: z.string().min(1).max(200), uid: z.string().min(1).max(500) },
    run: async (a, c) => { const cfg = c.getConfig(); const b = await K.resolveBook(cfg, a.addressbook); needW(b); const o = await C.findByUid(cfg, b, a.uid, "card"); await C.deleteObject(cfg, o.href, o.etag); return { deleted: true, ref: ref(b, a.uid), version_id: recordChange({ kind: "card", ref: ref(b, a.uid), href: o.href, op: "delete", before_text: o.text, after_etag: null }) }; } },
];
export const registerContacts = (server, ctx) => defineTools(server, ctx, contactsDefs);
```

Add to `tools/undo.js`:

```js
import { loadChange, recordChange, pruneJournal } from "../pim/journal.js";
import { getObject, putObject, deleteObject } from "../pim/caldav.js";

async function pimUndo(cfg, args) {
  const e = loadChange(args.version_id);
  if (args.path !== e.ref) throw new WsError("bad_version_id", `That version_id belongs to ${e.ref}`);
  const cur = await getObject(cfg, e.href);
  const changedSince = () => new WsError("changed_since", "It changed after that edit, so nothing was undone. Read it again and decide what to change.");
  if (e.op === "delete") {
    if (cur) throw changedSince();
    const r = await putObject(cfg, e.href, e.before_text, { ifNoneMatch: "*" }); if (![201, 204].includes(r.status)) throw new WsError("write_failed", `HTTP ${r.status}`);
    return { ref: e.ref, undone: "restored", version_id: recordChange({ ...e, op: "create", before_text: null, after_etag: (await getObject(cfg, e.href))?.etag ?? null }) };
  }
  if (!cur || cur.etag !== e.after_etag) throw changedSince();
  if (e.op === "create") { await deleteObject(cfg, e.href, cur.etag); return { ref: e.ref, undone: "removed", version_id: recordChange({ ...e, op: "delete", before_text: cur.text, after_etag: null }) }; }
  const r = await putObject(cfg, e.href, e.before_text, { ifMatch: cur.etag }); if (![201, 204].includes(r.status)) throw new WsError(r.status === 412 ? "changed_since" : "write_failed", `HTTP ${r.status}`);
  return { ref: e.ref, undone: "reverted", version_id: recordChange({ ...e, op: "update", before_text: cur.text, after_etag: (await getObject(cfg, e.href))?.etag ?? null }) };
}
undoHandlers.j1 = (cfg, args) => pimUndo(cfg, args);
```

In `createWorkspaceServer`, register calendar + contacts, and prune the journal at start and every 6 h (`const t = setInterval(() => { try { pruneJournal(); } catch {} }, 6 * 3600e3); t.unref();` plus one call at start inside try/catch).

- [ ] **Step 7: Run the tests**

Run: `npm test -- tests/workspace-calendar.test.js tests/workspace-contacts.test.js`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add bundles/workspace/server/pim bundles/workspace/server/tools/calendar.js bundles/workspace/server/tools/contacts.js tests/helpers/workspace-fake-pim.js tests/workspace-calendar.test.js tests/workspace-contacts.test.js
git commit bundles/workspace/server tests/helpers/workspace-fake-pim.js tests/workspace-calendar.test.js tests/workspace-contacts.test.js -m "feat(workspace): Calendar + Contacts tools over CalDAV/CardDAV with a 600-mode undo journal"
git show --stat HEAD
```

---
### Task 11: Doc comments (in-file OOXML) and `ws_drive_read_file` text extraction

**Files:**
- Create: `bundles/workspace/server/ooxml/{docx-comments.js,text-extract.js}`, `bundles/workspace/server/tools/docs-comments.js`
- Modify: `bundles/workspace/server/ooxml/docx-edit.js` (export `isolate`, `spliceText`), `bundles/workspace/server/tools/drive.js` (add `ws_drive_read_file`), `bundles/workspace/server/server.js`
- Test: `tests/workspace-docs-comments.test.js`, `tests/workspace-read-file.test.js`

**Interfaces:**
- Consumes: `openDocx`, `textMap`, `isolate`, `spliceText`, `RUN_CONTAINERS`, OPC helpers, `docxWrite`, `loadDocx`, `toMarkdown`, `openXlsx`/`readRange`, `openPptx`/`readDeck`.
- Produces `docx-comments.js`:
  - `listComments(d, includeResolved) → [{id, author, date, content, quoted_text, resolved, replies:[{id, author, date, content}]}]`
  - `addComment(d, content, quotedText?) → {comment_id}`, `replyComment(d, id, content) → {comment_id}`, `resolveComment(d, id)`
  - `applyCommentEdit(d, id, replaceText, summary) → {applied, reason?, left_unresolved?}`
- Produces `text-extract.js`: `extractText(name, bytes) → string|null` (null = not a text-bearing type).

- [ ] **Step 1: Write the failing tests**

`tests/workspace-docs-comments.test.js`:

```js
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startFakeNextcloud } from "./helpers/workspace-fake-nextcloud.js";
import { connectWorkspace } from "./helpers/workspace-client.js";
import { partText } from "./helpers/ooxml-assert.js";

const FIX = join(import.meta.dirname, "fixtures", "workspace");
let fake, call, close;
const put = (name, src) => fake.addFile(`S/${name}`, readFileSync(join(FIX, src)), { owner: "admin" });
before(async () => { fake = await startFakeNextcloud(); fake.addFolder("S", { owner: "admin" }); ({ call, close } = await connectWorkspace(fake)); });
after(async () => { await close(); fake.close(); });

for (const src of ["rich.docx", "oo-rich.docx"]) {
  test(`${src}: lists every comment with its anchored text`, async () => {
    put(`l-${src}`, src);
    const r = await call("ws_docs_list_comments", { path: `S/l-${src}` });
    const c = r.data.comments.find((x) => x.content === "¿Con salsa verde?");
    assert.equal(c.author, "Dayane"); assert.match(c.quoted_text, /con piña y jalapeño/);
  });

  test(`${src}: add (real anchor) → reply → resolve; resolved hidden unless asked`, async () => {
    put(`a-${src}`, src);
    const a = await call("ws_docs_add_comment", { path: `S/a-${src}`, content: "Revisar porciones", quoted_text: "Marinar la carne" });
    const xml = partText(fake.node(`S/a-${src}`).bytes, "word/document.xml");
    assert.match(xml, new RegExp(`<w:commentRangeStart w:id="${a.data.comment_id}"/>`));
    const rep = await call("ws_docs_reply_comment", { path: `S/a-${src}`, comment_id: a.data.comment_id, content: "Hecho" });
    assert.ok(rep.data.comment_id);
    let l = await call("ws_docs_list_comments", { path: `S/a-${src}` });
    const mine = l.data.comments.find((x) => x.id === a.data.comment_id);
    assert.equal(mine.quoted_text, "Marinar la carne"); assert.equal(mine.replies[0].content, "Hecho");
    await call("ws_docs_resolve_comment", { path: `S/a-${src}`, comment_id: a.data.comment_id });
    l = await call("ws_docs_list_comments", { path: `S/a-${src}` });
    assert.ok(!l.data.comments.some((x) => x.id === a.data.comment_id));
    l = await call("ws_docs_list_comments", { path: `S/a-${src}`, include_resolved: true });
    assert.equal(l.data.comments.find((x) => x.id === a.data.comment_id).resolved, true);
  });

  test(`${src}: apply_comment_edit replaces ONLY the anchored range, replies, resolves — one version`, async () => {
    put(`e-${src}`, src);
    const a = await call("ws_docs_add_comment", { path: `S/e-${src}`, content: "¿Mejor 'Servir caliente'?", quoted_text: "Servir" });
    await call("ws_docs_append", { path: `S/e-${src}`, markdown: "Servir con limón." });
    const v0 = fake.versionsOf(`S/e-${src}`).length;
    const r = await call("ws_docs_apply_comment_edit", { path: `S/e-${src}`, comment_id: a.data.comment_id, replace_text: "Servir caliente", summary: "Aplicado" });
    assert.equal(r.data.applied, true); assert.equal(fake.versionsOf(`S/e-${src}`).length, v0 + 1);
    const md = (await call("ws_docs_read", { path: `S/e-${src}` })).data.markdown;
    assert.match(md, /Servir caliente/); assert.match(md, /Servir con limón\./, "the other occurrence is untouched");
    assert.equal((await call("ws_docs_apply_comment_edit", { path: `S/e-${src}`, comment_id: a.data.comment_id, replace_text: "x", summary: "x" })).code, "already_resolved");
  });
}

test("apply_comment_edit with no usable anchor replies and leaves the thread unresolved", async () => {
  put("n.docx", "rich.docx");
  const a = await call("ws_docs_add_comment", { path: "S/n.docx", content: "general" });
  await call("ws_docs_find_replace", { path: "S/n.docx", find: "Recetas de la semana", replace: "" });
  const r = await call("ws_docs_apply_comment_edit", { path: "S/n.docx", comment_id: a.data.comment_id, replace_text: "x", summary: "s" });
  assert.equal(r.data.applied, false); assert.equal(r.data.left_unresolved, true); assert.equal(r.data.reason, "no_anchor");
});
```

`tests/workspace-read-file.test.js`:

```js
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
  for (const e of ["docx", "xlsx", "pptx"]) fake.addFile(`S/r.${e}`, readFileSync(join(FIX, `oo-rich.${e}`)), { owner: "admin" });
  fake.addFile("S/n.md", Buffer.from("# Hola\n" + "x".repeat(500)));
  fake.addFile("S/b.bin", Buffer.from([0, 1, 2, 255]));
  ({ call, close } = await connectWorkspace(fake));
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
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -- tests/workspace-docs-comments.test.js tests/workspace-read-file.test.js`
Expected: FAIL.

- [ ] **Step 3: Export the splice helpers from `docx-edit.js`**

Change `function spliceText` and `function isolate` to `export function`. No behavior change.

- [ ] **Step 4: Write `docx-comments.js`**

```js
import { randomBytes } from "node:crypto";
import { WsError } from "../result.js";
import { NS, kids, kid, all, attr, el, parseXml, insertAfter } from "./xml.js";
import { RUN_CONTAINERS, textMap, makeRun } from "./docx-model.js";
import { isolate, spliceText } from "./docx-edit.js";
import { addRel, partsOfType, setOverride, REL } from "./opc.js";

const W = NS.w, W14 = NS.w14, W15 = NS.w15;
const SEP = new Set(["tab", "br", "cr", "drawing", "object", "pict", "fldChar", "instrText", "sym", "footnoteReference", "endnoteReference", "commentReference", "ptab"]);

function commentsDoc(d, create) {
  const part = partsOfType(d.pkg, d.part, REL.comments)[0];
  if (part) return { part, doc: d.pkg.xml(part) };
  if (!create) return null;
  const p = "word/comments.xml";
  d.pkg.setXml(p, parseXml(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<w:comments xmlns:w="${W}" xmlns:w14="${W14}"/>`, p));
  addRel(d.pkg, d.part, REL.comments, "comments.xml");
  setOverride(d.pkg, p, "application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml");
  return { part: p, doc: d.pkg.xml(p) };
}
function extDoc(d, create) {
  const part = partsOfType(d.pkg, d.part, REL.commentsExtended)[0];
  if (part) return { part, doc: d.pkg.xml(part) };
  if (!create) return null;
  const p = "word/commentsExtended.xml";
  d.pkg.setXml(p, parseXml(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<w15:commentsEx xmlns:w15="${W15}"/>`, p));
  addRel(d.pkg, d.part, REL.commentsExtended, "commentsExtended.xml");
  setOverride(d.pkg, p, "application/vnd.openxmlformats-officedocument.wordprocessingml.commentsExtended+xml");
  return { part: p, doc: d.pkg.xml(p) };
}
const paraIdOf = (c) => { const ps = kids(c, W, "p"); return ps.length ? attr(ps.at(-1), W14, "paraId") : ""; };
const commentText = (c) => kids(c, W, "p").map((p) => all(p, W, "t").map((t) => t.textContent).join("")).join("\n");

function quotedTexts(d) {
  const open = new Map(); const out = new Map();
  const walk = (n) => {
    for (const c of kids(n)) {
      if (c.namespaceURI === W && c.localName === "commentRangeStart") open.set(attr(c, W, "id"), "");
      else if (c.namespaceURI === W && c.localName === "commentRangeEnd") { const id = attr(c, W, "id"); if (open.has(id)) { out.set(id, open.get(id)); open.delete(id); } }
      else if (c.namespaceURI === W && c.localName === "t") { for (const k of open.keys()) open.set(k, open.get(k) + c.textContent); }
      else if (c.namespaceURI === W && c.localName === "p" && open.size) { walk(c); for (const k of open.keys()) open.set(k, `${open.get(k)}\n`); continue; }
      else walk(c);
    }
  };
  walk(d.body);
  for (const [k, v] of out) out.set(k, v.replace(/\n+$/, ""));
  return out;
}

export function listComments(d, includeResolved = false) {
  const cd = commentsDoc(d, false); if (!cd) return [];
  const ex = extDoc(d, false);
  const exBy = new Map(ex ? kids(ex.doc.documentElement, W15, "commentEx").map((e) => [attr(e, W15, "paraId"), e]) : []);
  const quotes = quotedTexts(d);
  const all_ = kids(cd.doc.documentElement, W, "comment").map((c) => {
    const pid = paraIdOf(c); const e = exBy.get(pid);
    return { id: attr(c, W, "id"), author: attr(c, W, "author"), date: attr(c, W, "date") || null, content: commentText(c), quoted_text: quotes.get(attr(c, W, "id")) ?? "", paraId: pid, parent: e ? attr(e, W15, "paraIdParent") : "", done: e ? attr(e, W15, "done") === "1" : false };
  });
  const roots = all_.filter((c) => !c.parent);
  return roots.map((r) => ({ id: r.id, author: r.author, date: r.date, content: r.content, quoted_text: r.quoted_text, resolved: r.done, replies: all_.filter((x) => x.parent && x.parent === r.paraId).map(({ id, author, date, content }) => ({ id, author, date, content })) }))
    .filter((c) => includeResolved || !c.resolved);
}

const newParaId = () => (randomBytes(4).readUInt32BE(0) & 0x7fffffff).toString(16).toUpperCase().padStart(8, "0");
function newComment(d, content) {
  const cd = commentsDoc(d, true); const doc = cd.doc;
  const id = String(Math.max(-1, ...kids(doc.documentElement, W, "comment").map((c) => Number(attr(c, W, "id")))) + 1);
  const pid = newParaId();
  const p = el(doc, W, "w:p", { "w14:paraId": pid, "w14:textId": "77777777" });
  for (const [i, line] of String(content).normalize("NFC").split("\n").entries()) { if (i) p.appendChild(el(doc, W, "w:r", {}, [el(doc, W, "w:br")])); p.appendChild(makeRun(doc, line, null)); }
  doc.documentElement.appendChild(el(doc, W, "w:comment", { "w:id": id, "w:author": "Crow bot", "w:date": new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), "w:initials": "CB" }, [p]));
  d.pkg.markDirty(cd.part);
  return { id, pid };
}
function setEx(d, pid, { parent, done }) {
  const ex = extDoc(d, true); let e = kids(ex.doc.documentElement, W15, "commentEx").find((x) => attr(x, W15, "paraId") === pid);
  if (!e) { e = el(ex.doc, W15, "w15:commentEx", { "w15:paraId": pid }); ex.doc.documentElement.appendChild(e); }
  if (parent !== undefined) e.setAttributeNS(W15, "w15:paraIdParent", parent);
  if (done !== undefined) e.setAttributeNS(W15, "w15:done", done ? "1" : "0");
  d.pkg.markDirty(ex.part);
}
const refRun = (doc, id) => el(doc, W, "w:r", {}, [el(doc, W, "w:commentReference", { "w:id": id })]);

export function addComment(d, content, quotedText) {
  const { id, pid } = newComment(d, content); const doc = d.doc;
  let first, last;
  if (quotedText) {
    const needle = String(quotedText).normalize("NFC");
    for (const p of all(d.body, W, "p")) { const i = textMap(p).text.indexOf(needle); if (i < 0) continue; const runs = isolate(p, i, i + needle.length); first = runs[0]; last = runs.at(-1); break; }
    if (!first) throw new WsError("not_found", `quoted_text "${quotedText}" was not found in the document body`);
  } else {
    const p = kids(d.body, W, "p")[0]; if (!p) throw new WsError("bad_args", "the document has no paragraph to attach a comment to");
    const content_ = kids(p).filter((c) => c.localName !== "pPr"); first = content_[0] || null; last = content_.at(-1) || null;
    if (!first) { const r = makeRun(doc, "", null); p.appendChild(r); first = last = r; }
  }
  first.parentNode.insertBefore(el(doc, W, "w:commentRangeStart", { "w:id": id }), first);
  const end = el(doc, W, "w:commentRangeEnd", { "w:id": id }); insertAfter(end, last); insertAfter(refRun(doc, id), end);
  setEx(d, pid, { done: false }); d.pkg.markDirty(d.part);
  return { comment_id: id };
}

function findComment(d, id) {
  const cd = commentsDoc(d, false); const c = cd && kids(cd.doc.documentElement, W, "comment").find((x) => attr(x, W, "id") === String(id));
  if (!c) throw new WsError("comment_not_found", `No comment ${id}`);
  let pid = paraIdOf(c);
  if (!pid) { pid = newParaId(); const ps = kids(c, W, "p"); ps.at(-1).setAttributeNS(W14, "w14:paraId", pid); d.pkg.markDirty(cd.part); }
  const ex = extDoc(d, false); const e = ex && kids(ex.doc.documentElement, W15, "commentEx").find((x) => attr(x, W15, "paraId") === pid);
  return { c, pid, done: e ? attr(e, W15, "done") === "1" : false };
}

export function replyComment(d, id, content) {
  const root = findComment(d, id); const r = newComment(d, content);
  const s = all(d.body, W, "commentRangeStart").find((x) => attr(x, W, "id") === String(id));
  const e = all(d.body, W, "commentRangeEnd").find((x) => attr(x, W, "id") === String(id));
  if (s && e) { insertAfter(el(d.doc, W, "w:commentRangeStart", { "w:id": r.id }), s); const ne = el(d.doc, W, "w:commentRangeEnd", { "w:id": r.id }); const ref = e.nextSibling && kids(e.nextSibling, W, "commentReference").length ? e.nextSibling : e; insertAfter(ne, ref); insertAfter(refRun(d.doc, r.id), ne); d.pkg.markDirty(d.part); }
  setEx(d, r.pid, { parent: root.pid, done: false });
  return { comment_id: r.id };
}
export function resolveComment(d, id) { const root = findComment(d, id); setEx(d, root.pid, { done: true }); return { resolved: true }; }

function anchorOffsets(p, id) {
  let len = 0, s = null, e = null;
  const walk = (n) => { for (const c of kids(n, W)) {
    if (c.localName === "commentRangeStart" && attr(c, W, "id") === id) s = len;
    else if (c.localName === "commentRangeEnd" && attr(c, W, "id") === id) e = len;
    else if (c.localName === "r") { for (const k of kids(c, W)) { if (k.localName === "t") len += k.textContent.length; else if (SEP.has(k.localName)) len += 1; } }
    else if (RUN_CONTAINERS.has(c.localName)) walk(c);
  } };
  walk(p); return { s, e };
}

export function applyCommentEdit(d, id, replaceText, summary) {
  const root = findComment(d, id);
  if (root.done) throw new WsError("already_resolved", `Comment ${id} is already resolved.`);
  const startEl = all(d.body, W, "commentRangeStart").find((x) => attr(x, W, "id") === String(id));
  const p = startEl ? (startEl.localName === "p" ? startEl : (function up(n) { while (n && !(n.namespaceURI === W && n.localName === "p")) n = n.parentNode; return n; })(startEl)) : null;
  const off = p ? anchorOffsets(p, String(id)) : { s: null, e: null };
  if (!p || off.s === null || off.e === null || off.e <= off.s) {
    replyComment(d, id, "Crow could not find the highlighted text for this comment (it may span paragraphs or was removed). Highlight a shorter phrase within one paragraph and ask again.");
    return { applied: false, reason: "no_anchor", left_unresolved: true };
  }
  const map = textMap(p);
  if (map.text.slice(off.s, off.e).includes("\u0000")) { replyComment(d, id, "The highlighted text includes a tab, line break or image, so Crow left it unchanged."); return { applied: false, reason: "no_anchor", left_unresolved: true }; }
  spliceText(map.segs, off.s, off.e, String(replaceText).normalize("NFC"));
  replyComment(d, id, summary); resolveComment(d, id); d.pkg.markDirty(d.part);
  return { applied: true };
}
```

- [ ] **Step 5: Write `tools/docs-comments.js` and `text-extract.js`, add `ws_drive_read_file`, register**

`tools/docs-comments.js`:

```js
import { z } from "zod";
import { fileRef, refOf, writeOpts } from "./common.js";
import { defineTools } from "./define.js";
import { loadDocx, docxWrite } from "./docs.js";
import { listComments, addComment, replyComment, resolveComment, applyCommentEdit } from "../ooxml/docx-comments.js";

export const commentDefs = [
  { name: "ws_docs_list_comments", description: "ALL comments in a .docx (never truncated): id, author, quoted_text, resolved, replies. Resolved ones only with include_resolved.",
    schema: { ...fileRef, include_resolved: z.boolean().optional().default(false) },
    run: async (a, c) => { const { entry, d } = await loadDocx(c.getConfig(), refOf(a)); return { path: entry.path, comments: listComments(d, a.include_resolved) }; } },
  { name: "ws_docs_add_comment", description: "Add a comment anchored to the first occurrence of quoted_text (or the first paragraph).",
    schema: { ...fileRef, content: z.string().min(1).max(10000), quoted_text: z.string().max(2000).optional(), ...writeOpts },
    run: (a, c) => docxWrite(c, a, (d) => ({ changed: 1, summary: "add comment", data: addComment(d, a.content, a.quoted_text) })) },
  { name: "ws_docs_reply_comment", description: "Reply to a comment thread.",
    schema: { ...fileRef, comment_id: z.string().max(20), content: z.string().min(1).max(10000), ...writeOpts },
    run: (a, c) => docxWrite(c, a, (d) => ({ changed: 1, summary: "reply to comment", data: replyComment(d, a.comment_id, a.content) })) },
  { name: "ws_docs_resolve_comment", description: "Mark a comment thread resolved.",
    schema: { ...fileRef, comment_id: z.string().max(20), ...writeOpts },
    run: (a, c) => docxWrite(c, a, (d) => ({ changed: 1, summary: "resolve comment", data: resolveComment(d, a.comment_id) })) },
  { name: "ws_docs_apply_comment_edit", description: "Replace ONLY the comment's highlighted text with replace_text, reply with summary, and resolve. If the highlight cannot be found, it replies explaining why and leaves the thread UNRESOLVED (applied:false).",
    schema: { ...fileRef, comment_id: z.string().max(20), replace_text: z.string().max(20000), summary: z.string().min(1).max(2000), ...writeOpts },
    run: (a, c) => docxWrite(c, a, (d) => { const r = applyCommentEdit(d, a.comment_id, a.replace_text, a.summary); return { changed: 1, summary: r.applied ? "apply comment edit" : "reply to comment", data: r }; }) },
];
export const registerDocComments = (server, ctx) => defineTools(server, ctx, commentDefs);
```

`ooxml/text-extract.js`:

```js
import { openDocx } from "./docx-model.js";
import { toMarkdown } from "./docx-read.js";
import { openXlsx, readRange } from "./xlsx.js";
import { openPptx, readDeck } from "./pptx.js";

const csv = (row) => row.map((v) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }).join(",");
const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|ics|vcf|xml|html?|ya?ml|log|ini|conf)$/i;
export function extractText(name, bytes) {
  if (/\.docx$/i.test(name)) return toMarkdown(openDocx(bytes));
  if (/\.xlsx$/i.test(name)) { const wb = openXlsx(bytes); return wb.sheets.map((s) => `## ${s.name}\n${readRange(wb, `'${s.name.replace(/'/g, "''")}'`).values.map(csv).join("\n")}`).join("\n\n"); }
  if (/\.pptx$/i.test(name)) return readDeck(openPptx(bytes), true).map((s, i) => [`## Slide ${i + 1}: ${s.title}`, ...s.shapes.filter((x) => x.text && x.text !== s.title).map((x) => x.text), s.notes ? `Notes: ${s.notes}` : ""].filter(Boolean).join("\n")).join("\n\n");
  if (TEXT_EXT.test(name)) { const t = Buffer.from(bytes).toString("utf8"); return t.includes("�") ? null : t; }
  return null;
}
```

Add to `driveReadDefs` in `tools/drive.js`:

```js
  { name: "ws_drive_read_file", description: "Read a file as text: .docx → markdown, .xlsx → CSV per tab, .pptx → slide text + notes; text files as-is. Other files are refused.",
    schema: { ...fileRef, max_chars: z.number().int().min(1).max(1000000).optional().default(200000) },
    run: async (a, { getConfig }) => {
      const cfg = getConfig(); const segs = await resolveRef(cfg, refOf(a)); const e = await stat(cfg, segs);
      if (e.isFolder) throw new WsError("not_a_file", `"${e.path}" is a folder`);
      const { bytes } = await getFile(cfg, segs, { maxBytes: MAX_EDIT_BYTES });
      const text = extractText(e.name, bytes);
      if (text === null) throw new WsError("not_text", `"${e.name}" is not a document or text file Crow can read`, { size: e.size, mime: e.mime, path: e.path });
      return { path: e.path, file_id: e.fileId, text: text.slice(0, a.max_chars), truncated: text.length > a.max_chars };
    } },
```

(Add these imports to `drive.js`: `getFile` from dav, `MAX_EDIT_BYTES` from write-protocol, `extractText`.) In `server.js`: `names.push(...registerDocComments(server, ctx));`.

- [ ] **Step 6: Run the tests**

Run: `npm test -- tests/workspace-docs-comments.test.js tests/workspace-read-file.test.js tests/workspace-docs-edit.test.js`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add bundles/workspace/server/ooxml/docx-comments.js bundles/workspace/server/ooxml/text-extract.js bundles/workspace/server/tools/docs-comments.js tests/workspace-docs-comments.test.js tests/workspace-read-file.test.js
git commit bundles/workspace/server tests/workspace-docs-comments.test.js tests/workspace-read-file.test.js -m "feat(workspace): in-file doc comments (anchored, threaded, full listing) and read_file text extraction"
git show --stat HEAD
```

---

### Task 12: Quick edit page, skill, manifest/registry, docs, and the MCP surface test

**Files:**
- Create: `bundles/workspace/server/quick/{view.js,actions.js}`, `bundles/workspace/panel/routes.js`, `bundles/workspace/skills/workspace.md`, `docs/guide/workspace.md`
- Modify: `bundles/workspace/panel/workspace.js` (tabs + Quick edit view), `bundles/workspace/manifest.json` (0.2.0, `server`, `skills`, `panelRoutes`), `registry/add-ons.json` (regenerated), `skills/superpowers.md` (nextcloud row → workspace), `bundles/nextcloud/skills/nextcloud.md` (pointer), `docs/.vitepress/config.ts` (sidebar)
- Test: `tests/workspace-quick-edit.test.js`, `tests/workspace-mcp-surface.test.js`; existing `tests/workspace-panel.test.js`, `tests/workspace-bundle.test.js`, `tests/bundle-server-deps.test.js` must stay green.

**Interfaces:**
- Consumes: everything above. Quick edit writes with `withFileWrite(..., { label: "Quick edit", waitS: 10 })`.
- Produces `server/quick/actions.js`:
  - `quickSave(cfg, form, clock)`, where form = `{path, kind:"docx"|"xlsx"|"pptx", target, value, if_open}`. Returns `{version_id, version_label}` or throws `WsError`.
  - `quickUndo(cfg, {path, version_id}, clock)`, `quickRestore(cfg, {path, version_id}, clock)`
  - `QUICK_MAX_BYTES = 20 MB`
- Produces `server/quick/view.js`:
  - `QUICK_STRINGS` (en/es)
  - `renderQuick({ lang, csrf, query, cfg })` → Promise<HTML string>
  - `renderChoice({ lang, csrf, form, err })` → full standalone HTML page
- Produces the default export of `panel/routes.js`: `workspaceRouter(authMiddleware, seams={})`, routes:
  - `POST /api/workspace/quick/save`
  - `POST /api/workspace/quick/undo`
  - `POST /api/workspace/quick/restore`

- [ ] **Step 1: Write the failing tests**

`tests/workspace-mcp-surface.test.js`:

```js
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startFakeNextcloud } from "./helpers/workspace-fake-nextcloud.js";
import { connectWorkspace } from "./helpers/workspace-client.js";

const EXPECTED = [
  "ws_drive_list_folder", "ws_drive_find_folder", "ws_drive_get_metadata", "ws_drive_get_permissions", "ws_drive_read_file", "ws_drive_search", "ws_drive_create_folder", "ws_drive_move_file", "ws_drive_copy_file", "ws_drive_rename", "ws_drive_trash_file", "ws_drive_upload_file", "ws_drive_upload_new_version", "ws_drive_export", "ws_drive_share", "ws_drive_list_versions", "ws_drive_restore_version",
  "ws_docs_read", "ws_docs_get_structure", "ws_docs_read_section", "ws_docs_find_replace", "ws_docs_append", "ws_docs_insert_at_heading", "ws_docs_replace_section", "ws_docs_create", "ws_docs_rewrite_passages", "ws_docs_format_text", "ws_docs_insert_image",
  "ws_docs_list_comments", "ws_docs_add_comment", "ws_docs_reply_comment", "ws_docs_resolve_comment", "ws_docs_apply_comment_edit",
  "ws_sheets_list", "ws_sheets_get_tabs", "ws_sheets_read", "ws_sheets_write", "ws_sheets_append", "ws_sheets_create", "ws_sheets_add_tab", "ws_sheets_rename_tab", "ws_sheets_delete_tab", "ws_sheets_set_number_format", "ws_sheets_batch_update",
  "ws_slides_read", "ws_slides_get_structure", "ws_slides_read_notes", "ws_slides_find_replace", "ws_slides_create", "ws_slides_add_slide", "ws_slides_duplicate_slide", "ws_slides_delete_slide", "ws_slides_reorder_slides", "ws_slides_add_text_box", "ws_slides_add_image", "ws_slides_format_text", "ws_slides_format_paragraph", "ws_slides_edit_text", "ws_slides_edit_notes", "ws_slides_batch_update",
  "ws_cal_list_calendars", "ws_cal_list_events", "ws_cal_get_event", "ws_cal_create_event", "ws_cal_update_event", "ws_cal_delete_event", "ws_cal_respond_to_event",
  "ws_contacts_list_addressbooks", "ws_contacts_search", "ws_contacts_get", "ws_contacts_create", "ws_contacts_update", "ws_contacts_delete",
  "ws_undo_last_change",
];
const DESTRUCTIVE = ["ws_drive_trash_file", "ws_sheets_delete_tab", "ws_slides_delete_slide", "ws_cal_delete_event", "ws_contacts_delete"];
let fake, client, close;
before(async () => { fake = await startFakeNextcloud(); ({ client, close } = await connectWorkspace(fake)); });
after(async () => { await close(); fake.close(); });

test("exactly the 74 spec §4 tools are registered", async () => {
  const names = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.equal(EXPECTED.length, 74);
  assert.deepEqual(names, [...EXPECTED].sort());
});
test("descriptions: ≤1024 chars, destructive tools say confirm, useful first 120 chars", async () => {
  for (const t of (await client.listTools()).tools) {
    assert.ok(t.description.length <= 1024, t.name);
    assert.ok(t.description.slice(0, 120).trim().length >= 20, t.name);
    if (DESTRUCTIVE.includes(t.name)) assert.match(t.description, /confirm/i, t.name);
  }
});
test("instructions carry the guardrails; the manifest declares the server with NO envKeys", () => {
  const m = JSON.parse(readFileSync(join(import.meta.dirname, "..", "bundles", "workspace", "manifest.json"), "utf8"));
  assert.equal(m.version, "0.2.0");
  assert.deepEqual(m.server, { command: "node", args: ["server/index.js"], envKeys: [] });
  assert.deepEqual(m.skills, ["skills/workspace.md"]);
  assert.equal(m.panelRoutes, "panel/routes.js");
});
test("not_ready before bootstrap finished, naming the bootstrap command", async () => {
  const { writeFileSync } = await import("node:fs");
  const { call, home, close: c2 } = await connectWorkspace(fake);
  writeFileSync(join(home, "bundles", "workspace", ".env"), "WORKSPACE_PUBLIC_HOST=crow.test\n");
  const r = await call("ws_drive_list_folder", {});
  assert.equal(r.code, "not_ready"); assert.match(r.error, /bootstrap\.sh/);
  await c2();
});
```

`tests/workspace-quick-edit.test.js`:

```js
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { startFakeNextcloud } from "./helpers/workspace-fake-nextcloud.js";

const FIX = join(import.meta.dirname, "fixtures", "workspace");
let fake, base, server, V, home;
before(async () => {
  fake = await startFakeNextcloud();
  fake.addFolder("Shared with Crow/Casa", { owner: "admin" });
  for (const e of ["docx", "xlsx", "pptx"]) fake.addFile(`Shared with Crow/Casa/r.${e}`, readFileSync(join(FIX, `oo-rich.${e}`)), { owner: "admin" });
  home = mkdtempSync(join(tmpdir(), "ws-quick-")); mkdirSync(join(home, "bundles", "workspace"), { recursive: true });
  writeFileSync(join(home, "bundles", "workspace", ".env"), "WORKSPACE_BOOTSTRAP_DONE=1\nWORKSPACE_PUBLIC_HOST=crow.test\nWORKSPACE_BOT_APP_PASSWORD=pw-secret-123\nWORKSPACE_ONLYOFFICE_JWT_SECRET=jwt\n");
  Object.assign(process.env, { CROW_HOME: home, WORKSPACE_NC_INTERNAL_URL: fake.ncUrl, WORKSPACE_OO_INTERNAL_URL: fake.ooUrl });
  V = await import("../bundles/workspace/server/quick/view.js");
  const { default: router } = await import("../bundles/workspace/panel/routes.js");
  const app = express();
  const auth = (req, res, next) => (req.headers.cookie?.includes("crow_session=ok") ? next() : res.status(401).end());
  let t = 0; const clock = { now: () => t, sleep: async (ms) => { t += ms; fake.advance(ms); } };
  app.use(router(auth, { clock, csrf: (req, res, next) => (req.body?._csrf === "tok" ? next() : res.status(403).end("csrf")) }));
  server = app.listen(0); base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); fake.close(); });
const post = (path, form, cookie = "crow_session=ok") => fetch(`${base}${path}`, { method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie }, body: new URLSearchParams(form).toString() });

test("en/es string parity; no secret ever rendered; CSRF field present; values escaped", async () => {
  assert.deepEqual(Object.keys(V.QUICK_STRINGS.en).sort(), Object.keys(V.QUICK_STRINGS.es).sort());
  const html = await V.renderQuick({ lang: "es", csrf: "tok", query: { view: "quick", path: "Shared with Crow/Casa/r.docx" } });
  assert.doesNotMatch(html, /pw-secret-123|jwt/);
  assert.match(html, /name="_csrf" value="tok"/);
  assert.match(html, /Recetas de la semana/);
  assert.doesNotMatch(html, /<script/i, "server-rendered, no client script");
  const evil = await V.renderQuick({ lang: "en", csrf: "tok", query: { view: "quick", path: "Shared with Crow/<img src=x>" } });
  assert.doesNotMatch(evil, /<img src=x>/);
});

test("save a paragraph → 303 back with an undo handle; label is Quick edit", async () => {
  const r = await post("/api/workspace/quick/save", { _csrf: "tok", path: "Shared with Crow/Casa/r.docx", kind: "docx", target: "1", value: "Tacos dorados." });
  assert.equal(r.status, 303);
  const loc = new URL(r.headers.get("location"), base);
  assert.equal(loc.pathname, "/dashboard/workspace"); assert.equal(loc.searchParams.get("notice"), "saved"); assert.match(loc.searchParams.get("v"), /^v1\./);
  assert.ok(fake.versionsOf("Shared with Crow/Casa/r.docx").some((v) => /^Quick edit:/.test(v.label || "")));
  const u = await post("/api/workspace/quick/undo", { _csrf: "tok", path: "Shared with Crow/Casa/r.docx", version_id: loc.searchParams.get("v") });
  assert.equal(new URL(u.headers.get("location"), base).searchParams.get("notice"), "undone");
});

test("save a cell and a slide shape", async () => {
  assert.equal((await post("/api/workspace/quick/save", { _csrf: "tok", path: "Shared with Crow/Casa/r.xlsx", kind: "xlsx", target: "Recetas!B2", value: "5" })).status, 303);
  const { openPptx, readDeck } = await import("../bundles/workspace/server/ooxml/pptx.js");
  const id = readDeck(openPptx(fake.node("Shared with Crow/Casa/r.pptx").bytes), false)[1].shapes[0].object_id;
  assert.equal((await post("/api/workspace/quick/save", { _csrf: "tok", path: "Shared with Crow/Casa/r.pptx", kind: "pptx", target: id, value: "Viernes" })).status, 303);
});

test("file open in the editor → choice page naming who, with Save anyway (proceed)", async () => {
  fake.openInEditor("Shared with Crow/Casa/r.docx", ["dayane"], { releaseAfterMs: 3000, typed: null });
  const r = await post("/api/workspace/quick/save", { _csrf: "tok", path: "Shared with Crow/Casa/r.docx", kind: "docx", target: "1", value: "x" });
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /Dayane/); assert.match(html, /name="if_open" value="proceed"/); assert.match(html, /data-turbo="false"/);
  const p = await post("/api/workspace/quick/save", { _csrf: "tok", path: "Shared with Crow/Casa/r.docx", kind: "docx", target: "1", value: "x", if_open: "proceed" });
  assert.equal(p.status, 303);
});

test("no session → 401; bad CSRF → 403; traversal path → error notice, no request", async () => {
  assert.equal((await post("/api/workspace/quick/save", { _csrf: "tok", path: "x", kind: "docx", target: "0", value: "y" }, "")).status, 401);
  assert.equal((await post("/api/workspace/quick/save", { _csrf: "bad", path: "x", kind: "docx", target: "0", value: "y" })).status, 403);
  const n = fake.calls.length;
  const r = await post("/api/workspace/quick/save", { _csrf: "tok", path: "../etc/passwd", kind: "docx", target: "0", value: "y" });
  assert.equal(new URL(r.headers.get("location"), base).searchParams.get("notice"), "bad_path");
  assert.equal(fake.calls.length, n);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -- tests/workspace-mcp-surface.test.js tests/workspace-quick-edit.test.js`
Expected: FAIL. The surface test reports any missing names, the manifest has no server yet, and `quick/*` is missing.

- [ ] **Step 3: Write `server/quick/actions.js`**

```js
import { WsError } from "../result.js";
import { withFileWrite, withFileRestore, undoFileChange } from "../write-protocol.js";
import { splitPath } from "../nc/paths.js";
import { openDocx } from "../ooxml/docx-model.js";
import { setParagraphText } from "../ooxml/docx-edit.js";
import { kids } from "../ooxml/xml.js";
import { NS } from "../ooxml/xml.js";
import { openXlsx, writeRange } from "../ooxml/xlsx.js";
import { openPptx, editShapeText } from "../ooxml/pptx.js";

export const QUICK_MAX_BYTES = 20 * 1024 * 1024;
const opts = (form, clock, summary) => ({ label: "Quick edit", waitS: 10, ifOpen: form.if_open === "proceed" ? "proceed" : "wait", clock, summary });
export async function quickSave(cfg, form, clock) {
  const segs = splitPath(String(form.path || ""));
  const value = String(form.value ?? "").slice(0, 20000);
  const kind = String(form.kind || "");
  const ext = segs.at(-1).toLowerCase().split(".").pop();
  if (!["docx", "xlsx", "pptx"].includes(kind) || ext !== kind) throw new WsError("wrong_type", "Quick edit works on .docx, .xlsx and .pptx files");
  return withFileWrite(cfg, segs, async (bytes) => {
    if (bytes.length > QUICK_MAX_BYTES) throw new WsError("too_large", "Quick edit handles files up to 20 MB; use the editor on a computer");
    if (kind === "docx") {
      const d = openDocx(bytes); const p = kids(d.body, NS.w, "p")[Number(form.target)];
      if (!p) throw new WsError("bad_args", "That paragraph no longer exists; reload the page");
      setParagraphText(d, p, value); return { bytes: d.pkg.save(), changed: 1, summary: `paragraph ${Number(form.target) + 1}` };
    }
    if (kind === "xlsx") { const wb = openXlsx(bytes); const r = writeRange(wb, String(form.target), [[value]], "USER_ENTERED"); return { bytes: wb.pkg.save(), changed: 1, summary: `cell ${r.range}` }; }
    const deck = openPptx(bytes); editShapeText(deck, String(form.target), value); return { bytes: deck.pkg.save(), changed: 1, summary: "slide text" };
  }, opts(form, clock));
}
export const quickUndo = (cfg, form, clock) => undoFileChange(cfg, { path: String(form.path || "") }, String(form.version_id || ""), { clock, waitS: 10, ifOpen: form.if_open === "proceed" ? "proceed" : "wait" });
export function quickRestore(cfg, form, clock) {
  if (!/^\d{1,12}$/.test(String(form.version_id || ""))) throw new WsError("bad_version_id", "not a version");
  return withFileRestore(cfg, splitPath(String(form.path || "")), String(form.version_id), { ...opts(form, clock, `restore version ${form.version_id}`), label: "Quick edit" });
}
```

(`withFileWrite`'s first line calls `guard(cfg, ref)`, which accepts a `segs` array. Task 5's `guard` already does `Array.isArray(ref) ? ref : await resolveRef(cfg, ref)`.)

- [ ] **Step 4: Write `server/quick/view.js`**

```js
/** Quick edit (spec §8): server-rendered, phone-first, no client script. Every value is HTML-escaped. */
import { getConfig } from "../config.js";
import { WsError } from "../result.js";
import { list, stat, getFile } from "../nc/dav.js";
import { splitFolder, splitPath, joinPath } from "../nc/paths.js";
import { listVersions } from "../nc/versions.js";
import { openDocx, paragraphText, paragraphHeadingLevel } from "../ooxml/docx-model.js";
import { kids, NS } from "../ooxml/xml.js";
import { openXlsx, readRange, colName } from "../ooxml/xlsx.js";
import { openPptx, readDeck } from "../ooxml/pptx.js";
import { QUICK_MAX_BYTES } from "./actions.js";

export const QUICK_STRINGS = {
  en: { tabSetup: "Setup", tabQuick: "Quick edit", intro: "Small text and cell changes from your phone. Crow saves a version before every change, so you can always undo. You see exactly what is shared with “Crow bot”.", up: "Up", open: "Open", edit: "Edit", save: "Save", cancel: "Cancel", undo: "Undo", restore: "Restore", versions: "Recent versions", saved: "Saved.", undone: "Undone.", restored: "Restored.", empty: "Nothing here is shared with Crow bot yet. In Workspace, share a folder with “Crow bot”.", paragraph: "Paragraph", cell: "Cell", tab: "Tab", slide: "Slide", formulaHint: "Start with = for a formula.", openBy: "is editing this file right now.", tryAgain: "Try again", saveAnyway: "Save anyway (closes their editor; their typing is saved first)", errorPrefix: "Could not save:", more: "More", notConfigured: "Workspace is not set up yet (see Setup).", notSupported: "Quick edit works on .docx, .xlsx and .pptx files." },
  es: { tabSetup: "Configuración", tabQuick: "Edición rápida", intro: "Cambios pequeños de texto y celdas desde tu teléfono. Crow guarda una versión antes de cada cambio, así siempre puedes deshacer. Ves exactamente lo que está compartido con “Crow bot”.", up: "Subir", open: "Abrir", edit: "Editar", save: "Guardar", cancel: "Cancelar", undo: "Deshacer", restore: "Restaurar", versions: "Versiones recientes", saved: "Guardado.", undone: "Deshecho.", restored: "Restaurado.", empty: "Todavía no hay nada compartido con Crow bot. En Workspace, comparte una carpeta con “Crow bot”.", paragraph: "Párrafo", cell: "Celda", tab: "Hoja", slide: "Diapositiva", formulaHint: "Empieza con = para una fórmula.", openBy: "está editando este archivo ahora mismo.", tryAgain: "Intentar de nuevo", saveAnyway: "Guardar de todos modos (cierra su editor; lo que escribió se guarda primero)", errorPrefix: "No se pudo guardar:", more: "Más", notConfigured: "Workspace aún no está configurado (ver Configuración).", notSupported: "La edición rápida funciona con archivos .docx, .xlsx y .pptx." },
};
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const q = (o) => `/dashboard/workspace?${new URLSearchParams({ view: "quick", ...o }).toString()}`;
const STYLE = `<style>.wq a.btn,.wq button{display:inline-block;min-height:44px;padding:.55rem .9rem;border-radius:8px;border:1px solid var(--crow-border);background:var(--crow-bg-elevated);color:inherit;text-decoration:none;font-size:1rem}.wq ul{list-style:none;padding:0;margin:0}.wq li{padding:.5rem 0;border-bottom:1px solid var(--crow-border);display:flex;gap:.5rem;align-items:center;justify-content:space-between}.wq textarea,.wq input[type=text]{width:100%;font-size:1rem;padding:.5rem;box-sizing:border-box}.wq .note{border-left:3px solid var(--crow-accent);padding:.4rem .6rem;margin:.5rem 0}.wq table{border-collapse:collapse;display:block;overflow-x:auto}.wq td,.wq th{border:1px solid var(--crow-border);padding:.35rem .5rem;min-width:3rem}.wq .h{font-weight:600}</style>`;
const hidden = (csrf, o) => `<input type="hidden" name="_csrf" value="${esc(csrf)}">${Object.entries(o).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join("")}`;

async function versionsBlock(cfg, t, csrf, e) {
  const vs = (await listVersions(cfg, e.fileId).catch(() => [])).slice(1, 21);
  if (!vs.length) return "";
  return `<h3>${esc(t.versions)}</h3><ul>${vs.map((v) => `<li><span>${esc(new Date(v.modified).toLocaleString())} · ${esc(v.author)}${v.label ? ` · ${esc(v.label)}` : ""}</span><form method="post" action="/api/workspace/quick/restore" data-turbo="false">${hidden(csrf, { path: e.path, version_id: v.versionId })}<button>${esc(t.restore)}</button></form></li>`).join("")}</ul>`;
}

export async function renderQuick({ lang, csrf, query }) {
  const t = QUICK_STRINGS[lang === "es" ? "es" : "en"];
  let cfg; try { cfg = getConfig(); } catch { return `${STYLE}<div class="wq"><p class="note">${esc(t.notConfigured)}</p></div>`; }
  const notice = query.notice ? `<p class="note">${esc({ saved: t.saved, undone: t.undone, restored: t.restored }[query.notice] || `${t.errorPrefix} ${query.msg || query.notice}`)}${query.notice === "saved" && query.v ? ` <form method="post" action="/api/workspace/quick/undo" data-turbo="false" style="display:inline">${hidden(csrf, { path: query.path, version_id: query.v })}<button>${esc(t.undo)}</button></form>` : ""}</p>` : "";
  try {
    const path = query.path || "";
    const segs = path ? splitPath(path) : [];
    const e = segs.length ? await stat(cfg, segs) : { isFolder: true, path: "" };
    if (e.isFolder) {
      const items = (await list(cfg, splitFolder(path))).filter((x) => x.isFolder || /\.(docx|xlsx|pptx)$/i.test(x.name));
      const up = segs.length ? `<p><a class="btn" href="${esc(q({ path: joinPath(segs.slice(0, -1)) }))}">${esc(t.up)}</a></p>` : "";
      return `${STYLE}<div class="wq"><p>${esc(t.intro)}</p>${notice}${up}${items.length ? `<ul>${items.map((x) => `<li><span>${x.isFolder ? "📁" : "📄"} ${esc(x.name)}</span><a class="btn" href="${esc(q({ path: x.path }))}">${esc(t.open)}</a></li>`).join("")}</ul>` : `<p>${esc(t.empty)}</p>`}</div>`;
    }
    const kind = (e.name.split(".").pop() || "").toLowerCase();
    if (!["docx", "xlsx", "pptx"].includes(kind)) return `${STYLE}<div class="wq">${notice}<p>${esc(t.notSupported)}</p></div>`;
    const { bytes } = await getFile(cfg, segs, { maxBytes: QUICK_MAX_BYTES });
    const form = (target, label, value, multiline) => `<form method="post" action="/api/workspace/quick/save" data-turbo="false">${hidden(csrf, { path: e.path, kind, target })}<label>${esc(label)}${multiline ? `<textarea name="value" rows="5">${esc(value)}</textarea>` : `<input type="text" name="value" value="${esc(value)}">`}</label>${kind === "xlsx" ? `<small>${esc(t.formulaHint)}</small>` : ""}<p><button>${esc(t.save)}</button> <a class="btn" href="${esc(q({ path: e.path }))}">${esc(t.cancel)}</a></p></form>`;
    let body = "";
    if (kind === "docx") {
      const d = openDocx(bytes); const ps = kids(d.body, NS.w, "p"); const page = Math.max(0, Number(query.page || 0));
      if (query.target !== undefined) { const p = ps[Number(query.target)]; body = p ? form(query.target, `${t.paragraph} ${Number(query.target) + 1}`, paragraphText(p), true) : ""; }
      else body = `<ul>${ps.slice(page * 50, page * 50 + 50).map((p, i) => ({ p, i: page * 50 + i })).filter(({ p }) => paragraphText(p).trim()).map(({ p, i }) => `<li><span class="${paragraphHeadingLevel(d, p) ? "h" : ""}">${esc(paragraphText(p).slice(0, 160))}</span><a class="btn" href="${esc(q({ path: e.path, target: String(i) }))}">${esc(t.edit)}</a></li>`).join("")}</ul>${ps.length > (page + 1) * 50 ? `<p><a class="btn" href="${esc(q({ path: e.path, page: String(page + 1) }))}">${esc(t.more)}</a></p>` : ""}`;
    } else if (kind === "xlsx") {
      const wb = openXlsx(bytes); const tab = query.tab && wb.sheets.some((s) => s.name === query.tab) ? query.tab : wb.sheets[0].name; const page = Math.max(0, Number(query.page || 0));
      if (query.target) { const cur = readRange(wb, query.target, "FORMULA").values[0]?.[0] ?? ""; body = form(query.target, `${t.cell} ${query.target}`, cur, false); }
      else {
        const r1 = page * 100 + 1; const vals = readRange(wb, `'${tab.replace(/'/g, "''")}'!A${r1}:Z${r1 + 99}`).values;
        const tabs = wb.sheets.map((s) => `<a class="btn" href="${esc(q({ path: e.path, tab: s.name }))}">${esc(s.name)}</a>`).join(" ");
        body = `<p>${esc(t.tab)}: ${tabs}</p><table><tbody>${vals.map((row, i) => `<tr><th>${r1 + i}</th>${row.map((v, j) => `<td><a href="${esc(q({ path: e.path, tab, target: `'${tab.replace(/'/g, "''")}'!${colName(j + 1)}${r1 + i}` }))}">${esc(v) || "·"}</a></td>`).join("")}</tr>`).join("")}</tbody></table>${vals.length === 100 ? `<p><a class="btn" href="${esc(q({ path: e.path, tab, page: String(page + 1) }))}">${esc(t.more)}</a></p>` : ""}`;
      }
    } else {
      const slides = readDeck(openPptx(bytes), false);
      if (query.target) { const sh = slides.flatMap((s) => s.shapes).find((x) => x.object_id === query.target); body = sh ? form(query.target, t.slide, sh.text, true) : ""; }
      else body = slides.map((s, i) => `<h3>${esc(t.slide)} ${i + 1}: ${esc(s.title)}</h3><ul>${s.shapes.filter((x) => x.text).map((x) => `<li><span>${esc(x.text.slice(0, 160))}</span><a class="btn" href="${esc(q({ path: e.path, target: x.object_id }))}">${esc(t.edit)}</a></li>`).join("")}</ul>`).join("");
    }
    return `${STYLE}<div class="wq"><p><a class="btn" href="${esc(q({ path: joinPath(segs.slice(0, -1)) }))}">${esc(t.up)}</a> <strong>${esc(e.name)}</strong></p>${notice}${body}${await versionsBlock(cfg, t, csrf, e)}</div>`;
  } catch (err) {
    return `${STYLE}<div class="wq">${notice}<p class="note">${esc(t.errorPrefix)} ${esc(err instanceof WsError ? err.message : "unexpected error")}</p><p><a class="btn" href="${esc(q({}))}">${esc(t.up)}</a></p></div>`;
  }
}

export function renderChoice({ lang, csrf, form, err }) {
  const t = QUICK_STRINGS[lang === "es" ? "es" : "en"];
  const keep = { path: form.path, kind: form.kind, target: form.target, value: form.value };
  const who = (err.data?.open_by || []).join(", ") || "Someone";
  return `<!doctype html><html lang="${lang === "es" ? "es" : "en"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(t.tabQuick)}</title><style>body{font-family:system-ui,sans-serif;margin:16px;max-width:40rem}button{min-height:44px;padding:.55rem .9rem;font-size:1rem;margin:.25rem 0;width:100%}</style></head><body>
<p><strong>${esc(who)}</strong> ${esc(t.openBy)}</p>
<form method="post" action="/api/workspace/quick/save" data-turbo="false">${hidden(csrf, keep)}<button>${esc(t.tryAgain)}</button></form>
${err.data?.can_proceed ? `<form method="post" action="/api/workspace/quick/save" data-turbo="false">${hidden(csrf, { ...keep, if_open: "proceed" })}<button>${esc(t.saveAnyway)}</button></form>` : `<p>${esc(err.message)}</p>`}
<p><a href="${esc(q({ path: form.path }))}">${esc(t.cancel)}</a></p></body></html>`;
}
```

- [ ] **Step 5: Write `panel/routes.js`**

```js
/**
 * Workspace Quick edit routes (/api/workspace/quick/*). Copied ALONE to $CROW_HOME/panels/workspace-routes.js,
 * so bundle modules are imported by absolute URL from BUNDLE_DIR (ramble pattern). Every middleware is
 * path-scoped (STRICT_PANEL_MOUNT). Dashboard session + CSRF (phone-bundle pattern). Writes as crow-bot.
 */
import { Router } from "express";
import express from "express";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CANDIDATES = [join(process.env.CROW_HOME || join(homedir(), ".crow"), "bundles", "workspace"), process.env.CROW_APP_ROOT ? join(process.env.CROW_APP_ROOT, "bundles", "workspace") : null, resolve(__dirname, "..")].filter(Boolean);
const BUNDLE_DIR = CANDIDATES.find((p) => existsSync(join(p, "manifest.json")) && existsSync(join(p, "server", "quick", "actions.js"))) || CANDIDATES.at(-1);
const bundleImport = (rel) => import(pathToFileURL(join(BUNDLE_DIR, rel)).href);
const realClock = { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };

export default function workspaceRouter(authMiddleware, seams = {}) {
  const router = Router();
  const clock = seams.clock || realClock;
  let csrf = seams.csrf || null;
  const csrfMw = async (req, res, next) => {
    if (!csrf) { const root = process.env.CROW_APP_ROOT || resolve(BUNDLE_DIR, "..", ".."); csrf = (await import(pathToFileURL(join(root, "servers", "gateway", "dashboard", "shared", "csrf.js")).href)).csrfMiddleware; }
    return csrf(req, res, next);
  };
  router.use("/api/workspace/quick", express.urlencoded({ extended: false, limit: "64kb" }), authMiddleware, csrfMw);
  const back = (res, form, notice, extra = {}) => res.redirect(303, `/dashboard/workspace?${new URLSearchParams({ view: "quick", path: String(form.path || ""), notice, ...extra }).toString()}`);
  const handle = (fn, okNotice, { choice = false } = {}) => async (req, res) => {
    const form = req.body || {};
    const lang = (req.headers["accept-language"] || "").startsWith("es") ? "es" : "en";
    try {
      const [{ getConfig }, actions] = await Promise.all([bundleImport("server/config.js"), bundleImport("server/quick/actions.js")]);
      const r = await fn(actions, getConfig(), form);
      return back(res, form, okNotice, r?.version_id ? { v: r.version_id } : {});
    } catch (err) {
      if (choice && ["open_in_editor", "locked_by_person", "stale_editor_lock"].includes(err?.code)) {
        const { renderChoice } = await bundleImport("server/quick/view.js");
        return res.status(200).type("html").send(renderChoice({ lang, csrf: req.csrfToken || form._csrf, form, err }));
      }
      return back(res, form, err?.code || "error", { msg: String(err?.message || "").slice(0, 300) });
    }
  };
  router.post("/api/workspace/quick/save", handle((a, cfg, f) => a.quickSave(cfg, f, clock), "saved", { choice: true }));
  router.post("/api/workspace/quick/undo", handle((a, cfg, f) => a.quickUndo(cfg, f, clock), "undone"));
  router.post("/api/workspace/quick/restore", handle((a, cfg, f) => a.quickRestore(cfg, f, clock), "restored"));
  return router;
}
```

- [ ] **Step 6: Wire Quick edit into the Office panel**

In `bundles/workspace/panel/workspace.js`, add `tabSetup: "Setup", tabQuick: "Quick edit"` to `T.en` and `tabSetup: "Configuración", tabQuick: "Edición rápida"` to `T.es` (keeps the parity test green). Then add below the existing helpers:

```js
// Quick edit lives in the bundle (it needs the OOXML engine); this file is copied alone to
// $CROW_HOME/panels/, so resolve the bundle dir the same way panel/routes.js does.
const __wsBundleDir = (() => {
  const c = [join(process.env.CROW_HOME || join(homedir(), ".crow"), "bundles", "workspace"), process.env.CROW_APP_ROOT ? join(process.env.CROW_APP_ROOT, "bundles", "workspace") : null, join(dirname(fileURLToPath(import.meta.url)), "..")].filter(Boolean);
  return c.find((p) => existsSync(join(p, "server", "quick", "view.js"))) || c.at(-1);
})();

export function renderTabs(lang, view) {
  const t = T[lang === "es" ? "es" : "en"];
  const tab = (v, label) => `<a href="/dashboard/workspace?view=${v}" style="padding:.5rem .9rem;border-radius:8px;text-decoration:none;${view === v ? "font-weight:700;background:var(--crow-bg-elevated);" : ""}">${esc(label)}</a>`;
  return `<nav style="display:flex;gap:.25rem;margin:0 0 1rem">${tab("setup", t.tabSetup)}${tab("quick", t.tabQuick)}</nav>`;
}
```

Replace the default export's `handler` with:

```js
  async handler(req, res, { layout, lang }) {
    const crowHome = process.env.CROW_HOME || join(homedir(), ".crow");
    const t = T[lang === "es" ? "es" : "en"];
    const view = req.query?.view === "quick" ? "quick" : "setup";
    let content;
    if (view === "quick") {
      const { renderQuick } = await import(pathToFileURL(join(__wsBundleDir, "server", "quick", "view.js")).href);
      content = renderTabs(lang, view) + (await renderQuick({ lang, csrf: req.csrfToken, query: req.query || {} }));
    } else {
      content = renderTabs(lang, view) + renderWorkspacePage(readPublicSettings(crowHome), lang, crowHome);
    }
    res.send(layout({ title: t.title, content }));
  },
```

Add to `tests/workspace-panel.test.js`: `renderTabs("es", "quick")` contains `Edición rápida` and `view=quick`. The page stays script-free: assert `doesNotMatch(/<script/i)`.

- [ ] **Step 7: Manifest, registry, skill, docs**

`bundles/workspace/manifest.json`: set `"version": "0.2.0"` and add `"server": { "command": "node", "args": ["server/index.js"], "envKeys": [] }`, `"skills": ["skills/workspace.md"]`, `"panelRoutes": "panel/routes.js"`. Add one sentence to `notes`: "Includes Crow's Workspace tools (ws_*): the bot edits only what you share with “Crow bot”, every change is a version you can undo, and Office › Quick edit makes small changes from a phone."

Run: `npm run build-registry` (rewrites `registry/add-ons.json`), then `npm run build-registry -- --check`.
Expected: no diff on the second run.

`bundles/workspace/skills/workspace.md`:

```markdown
---
name: workspace
description: Use Crow Workspace (the household's private Nextcloud + ONLYOFFICE) — files, Word/Excel/PowerPoint documents, calendars (incl. Menu) and contacts — through the ws_* tools
triggers:
  - workspace
  - nextcloud
  - document
  - documento
  - spreadsheet
  - hoja de cálculo
  - presentation
  - calendar
  - calendario
  - menu calendar
  - contacts
  - contactos
tools:
  - crow-workspace
---

# Crow Workspace

## When to activate
The user asks about files, documents (.docx), spreadsheets (.xlsx), slides (.pptx), calendars or contacts in their own Workspace (not Google).

## What you can reach
Only what the household shared with the **Crow bot** account. If something is missing, say so and ask them to share it with "Crow bot" in Workspace (edit rights for changes).

## How to work
1. **Find before you touch.** `ws_drive_search` or `ws_drive_list_folder`, then `ws_docs_get_structure` / `ws_sheets_get_tabs` / `ws_slides_get_structure`.
2. **Use the narrowest edit.** `ws_docs_find_replace` (batch with `pairs`) > `ws_docs_rewrite_passages` > `ws_docs_insert_at_heading` > `ws_docs_replace_section`. There is no whole-document replace, on purpose.
3. **Every write returns `version_id`.** Tell the user what changed and that they can say "undo". On "undo", call `ws_undo_last_change` with the same `path` (or `ref`) and `version_id`. If it answers `changed_since`, explain that someone edited it after you and offer `ws_drive_list_versions` + `ws_drive_restore_version`.
4. **If a write answers `open_in_editor`:** tell the user who has it open (`data.open_by`) and ask: "Go ahead anyway — their editor reloads and their typing is saved first — or try later?" Only on a clear yes, call the same tool again with `if_open: "proceed"`. On `locked_by_person` or `stale_editor_lock`, relay the message. Never retry in a loop.
5. **Confirm first** before `ws_drive_trash_file`, `ws_sheets_delete_tab`, `ws_slides_delete_slide`, `ws_cal_delete_event`, `ws_contacts_delete`.

## Sheets
After writing formulas, cached results are stale until someone opens the file. Read formulas with `value_render_option: "FORMULA"`, and do not report computed totals from a `stale_formulas: true` read.

## Calendar
All-day events use `YYYY-MM-DD`; the same day is fine for a one-day event. Timed events need an offset (e.g. `2026-10-22T18:00:00-05:00`). If more than one calendar is writable, ask which. Kitchen's meal plan lives on **Menu**. No invitations are sent unless the user asks (`send_updates: "all"`).

## Daily briefing / meeting prep
"What's on this week?" → `ws_cal_list_events` on each calendar for the next 7 days, then a short summary. "Prep for X" → `ws_cal_get_event`, then `ws_drive_search` for related documents and `ws_docs_read_section` on the relevant part.
```

`skills/superpowers.md` line 79: change the nextcloud row to route `"workspace", "nextcloud", "documento", "calendario"` → `workspace`.
`bundles/nextcloud/skills/nextcloud.md`: add at the top: "**Deprecated.** For a self-hosted office use Crow Workspace and its `workspace` skill (ws_* tools)."

`docs/guide/workspace.md`, with sections:
- What Workspace is (pointer to the Office panel);
- What Crow can do (tool families, one line each);
- What Crow can see (only what's shared with Crow bot);
- Undo and versions;
- When a file is open (wait → ask → proceed; manual locks; the stale-lock Unlock steps);
- Quick edit from a phone;
- Limits (caps, recurring-event instance edits, formula freshness).

Add it to the guide sidebar in `docs/.vitepress/config.ts` next to the existing guide entries.

- [ ] **Step 8: Run the full suite**

Run: `npm test`
Expected: all pass (new baseline = previous + the new Workspace tests).
Also run: `node scripts/check-port-allocation.js && npm run build-registry -- --check && npm run sync-skills`. `sync-skills` only touches `docs/skills/index.md` when root `skills/` changed; commit the diff if any.

- [ ] **Step 9: Start the server once by hand**

Run: `CROW_HOME=$(mktemp -d) node bundles/workspace/server/index.js < /dev/null; echo exit=$?`
Expected: exits 0 when stdin closes, with no stack trace (the server must not throw at import time when Workspace isn't configured).

- [ ] **Step 10: Commit**

```bash
git add bundles/workspace/server/quick bundles/workspace/panel/routes.js bundles/workspace/skills/workspace.md docs/guide/workspace.md tests/workspace-quick-edit.test.js tests/workspace-mcp-surface.test.js
git commit bundles/workspace registry/add-ons.json skills/superpowers.md bundles/nextcloud/skills/nextcloud.md docs/guide/workspace.md docs/.vitepress/config.ts docs/skills/index.md tests/workspace-quick-edit.test.js tests/workspace-mcp-surface.test.js -m "feat(workspace): Quick edit page, workspace skill, guide, manifest 0.2.0 with the ws_* MCP server"
git show --stat HEAD
```

---

### Task 13: PR, CI, merge, deploy on crow

**Files:** none new (process task).

- [ ] **Step 1: Rebase and push**

Run: `git fetch -q origin && git rebase origin/main && npm test`. Then `git push -u origin <branch>`.
Expected: suite green after the rebase.

- [ ] **Step 2: Open the PR with the GitHub MCP** (`gh` is not installed on crow)

Title: "feat(workspace): W2 Crow toolset — 74 ws_* tools, versioned lock-aware edits, Quick edit". The body lists:
- the spec and plan paths;
- the two gateway fixes (secret-skip, refresh registration);
- the new deps;
- the spike results file;
- the acceptance plan.

No Claude attribution.

- [ ] **Step 3: Wait for CI and read the check-runs**

Query `https://api.github.com/repos/<owner>/<repo>/commits/<head sha>/check-runs`.
Expected: `suite`, `static-checks` and `audit` are all `completed`/`success`. An empty list means something is wrong; investigate.

- [ ] **Step 4: Merge** (standing grant for improvement-plan items; CI must be green), then delete the branch.

- [ ] **Step 5: Deploy on crow**

1. Read `~/CROW-SCHEDULE.md`.
2. `git -C ~/crow checkout main && git -C ~/crow pull --ff-only origin main`.
3. `sudo systemctl restart crow-gateway`.
4. `journalctl -u crow-gateway --since "-3 min" | grep -E "refreshed workspace|mcp-addons entry|workspace"`.

Expected:
- `refreshed workspace 0.1.2 -> 0.2.0` with `mcp-addons entry (restart to load)` and `npm install`;
- `~/.crow/bundles/workspace/node_modules/fflate` exists;
- `jq .workspace ~/.crow/mcp-addons.json` shows `{command, args, env}` with **no** `WORKSPACE_*_PASSWORD`/`SECRET` keys.

Restart once more: `sudo systemctl restart crow-gateway`. Then `journalctl` shows the workspace addon connected with 74 tools.

Confirm `auto_update_last_result` is not "Skipped". Check whether `crow-r4-gateway` shares `~/.crow`: if `systemctl cat crow-r4-gateway | grep CROW_HOME` points elsewhere, nothing to do there.

---

### Task 14: Live acceptance on crow ([KEVIN] steps marked)

**Files:**
- Create: `scripts/workspace-w2-acceptance.mjs` (kept for re-runs)
- Modify: `docs/superpowers/specs/2026-10-03-workspace-w2-spike-results.md` (append an "Acceptance" section)

- [ ] **Step 1: [KEVIN] Share what the bot needs**

In Workspace as admin:
- share the **Menu** calendar with Crow bot (**can edit**);
- create and share an address book "Casa" with Crow bot (can edit);
- create a folder `W2 acceptance` inside `Shared with Crow` (inherits edit).

- [ ] **Step 2: Write the acceptance script**

`scripts/workspace-w2-acceptance.mjs` spawns the **installed** server over stdio (the same binary the gateway runs), drives one call per family, and prints PASS/FAIL:

```js
#!/usr/bin/env node
// W2 live acceptance: runs the INSTALLED Workspace MCP server as crow-bot against the real Workspace.
// Usage: node scripts/workspace-w2-acceptance.mjs [--lock-test]
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { join } from "node:path";
import { homedir } from "node:os";
import { readFileSync } from "node:fs";

const HOME = process.env.CROW_HOME || join(homedir(), ".crow");
const DIR = join(HOME, "bundles", "workspace");
const client = new Client({ name: "w2-acceptance", version: "0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: ["server/index.js"], cwd: DIR, env: { ...process.env, CROW_HOME: HOME, CROW_APP_ROOT: join(homedir(), "crow") } }));
const call = async (name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);
const rows = []; const check = (name, ok, info = "") => { rows.push([ok ? "PASS" : "FAIL", name, info]); console.log(`${ok ? "PASS" : "FAIL"}  ${name}  ${info}`); };
const F = "Shared with Crow/W2 acceptance";
const FIX = join(homedir(), "crow", "tests", "fixtures", "workspace");

check("74 tools", (await client.listTools()).tools.length === 74);
const up = await call("ws_drive_upload_file", { folder: F, name: "acc.docx", base64: readFileSync(join(FIX, "oo-rich.docx")).toString("base64") });
check("upload", up.success, up.error);
const fr = await call("ws_docs_find_replace", { path: `${F}/acc.docx`, find: "Tortillas", replace: "Totopos" });
check("docs find_replace + version", fr.success && fr.data.total_changes === 1 && /^v1\./.test(fr.data.version_id));
const un = await call("ws_undo_last_change", { path: `${F}/acc.docx`, version_id: fr.data.version_id });
check("undo", un.success && (await call("ws_docs_read", { path: `${F}/acc.docx` })).data.markdown.includes("Tortillas"));
const sx = await call("ws_sheets_create", { title: "Índice de recetas", folder: F, tabs: ["Recetas"] });
const ap = await call("ws_sheets_append", { path: sx.data.path, sheet_name: "Recetas", values: [["Nombre", "Porciones"], ["Tacos", 4]] });
check("sheets create + append", sx.success && ap.success);
const sl = await call("ws_slides_create", { title: "Menú W2", folder: F });
check("slides create", sl.success);
const ex = await call("ws_drive_export", { path: `${F}/acc.docx`, format: "pdf" });
check("export via ONLYOFFICE", ex.success, ex.data?.path);
const ev = await call("ws_cal_create_event", { calendar: "Menu", summary: "W2: tacos (prueba)", start: "2026-10-08", end: "2026-10-08" });
check("Menu event", ev.success, ev.error);
const ct = await call("ws_contacts_create", { addressbook: "Casa", full_name: "Prueba W2", phones: ["+1 512 555 0100"] });
check("contact", ct.success, ct.error);
const ls = await call("ws_drive_list_versions", { path: `${F}/acc.docx` });
check("labels visible", ls.data.versions.some((v) => /Crow|Undo/.test(v.label)));

if (process.argv.includes("--lock-test")) {
  console.log(`\n[KEVIN] Open "${F}/acc.docx" in Workspace on the laptop, type the word KEVIN, keep the tab open, then press Enter.`);
  await new Promise((r) => process.stdin.once("data", r));
  const t0 = Date.now();
  const w = await call("ws_docs_append", { path: `${F}/acc.docx`, markdown: "Línea del bot." });
  check("open_in_editor names Kevin within ~30 s", w.code === "open_in_editor" && w.data.open_by.length > 0 && Date.now() - t0 < 40000, JSON.stringify(w.data?.open_by));
  const p = await call("ws_docs_append", { path: `${F}/acc.docx`, markdown: "Línea del bot.", if_open: "proceed" });
  check("proceed → write lands", p.success, p.error);
  const md = (await call("ws_docs_read", { path: `${F}/acc.docx` })).data.markdown;
  check("Kevin's typing kept and bot line on top", md.includes("KEVIN") && md.includes("Línea del bot."));
  console.log("[KEVIN] Describe what the editor tab showed, then press Enter:"); await new Promise((r) => process.stdin.once("data", r));
}

// cleanup (trash + delete; all recoverable)
for (const path of [`${F}/acc.docx`, ex.data?.path, sx.data?.path, sl.data?.path].filter(Boolean)) await call("ws_drive_trash_file", { path, wait_s: 0 });
if (ev.success) await call("ws_cal_delete_event", { calendar: "Menu", uid: ev.data.uid });
if (ct.success) await call("ws_contacts_delete", { addressbook: "Casa", uid: ct.data.uid });
await client.close();
console.log(`\n${rows.filter((r) => r[0] === "PASS").length}/${rows.length} passed`);
process.exit(rows.every((r) => r[0] === "PASS") ? 0 : 1);
```

- [ ] **Step 3: Run the scripted acceptance**

Run: `node scripts/workspace-w2-acceptance.mjs`
Expected: `11/11 passed`. Before cleanup runs, look at the Menu event on Kevin's phone **[KEVIN]**: DAVx⁵ sync shows "W2: tacos (prueba)" on 2026-10-08. To give Kevin time, run with `--lock-test` or add a pause.

- [ ] **Step 4: [KEVIN] Lock test**

Run: `node scripts/workspace-w2-acceptance.mjs --lock-test` and follow the prompts.
Expected: three more PASS lines. Kevin's description of the editor (disconnect/reload) is recorded.

- [ ] **Step 5: [KEVIN] Gateway path + Quick edit from the phone**

1. In Crow's AI chat, Kevin asks: "List what's in my Workspace W2 acceptance folder". The answer comes from `ws_drive_list_folder` through `crow_tools`. Check the gateway log for the call.
2. On his phone, Kevin opens Crow → Office → Quick edit, opens a .docx in `W2 acceptance`, edits a paragraph, saves, sees "Saved." with Undo, taps Undo, and sees "Undone."
3. Then he opens an .xlsx and edits a cell.

- [ ] **Step 6: Record and commit**

Append an "Acceptance (date)" section to `docs/superpowers/specs/2026-10-03-workspace-w2-spike-results.md`: the PASS table, Kevin's notes, and anything deferred (Dayane's phone check rides with the W1 deferred items).

```bash
git add scripts/workspace-w2-acceptance.mjs
git commit scripts/workspace-w2-acceptance.mjs docs/superpowers/specs/2026-10-03-workspace-w2-spike-results.md -m "test(workspace): W2 live acceptance script and results"
git push
```

(This lands on main through a small follow-up PR with green CI, per the CI-red-blocks-all rule.)

---

## Self-review notes (author)

- **Spec coverage:**

  | Spec | Task |
  |---|---|
  | §2.1 proceed | 1, 5 |
  | §4.2 Drive | 4, 5, 11 |
  | §4.3 Docs | 6, 7 |
  | §4.4 comments | 11 |
  | §4.5 Sheets | 8 |
  | §4.6 Slides | 9 |
  | §4.7 Calendar/Contacts | 10 |
  | §4.8 undo/templates | 1, 5, 10 |
  | §5 protocol | 5 |
  | §6 auth + gateway fixes | 2, 3 |
  | §7 security | 4 (paths), 6 (zip/DOCTYPE), 2 (mcp-addons), plus the secret checks in 5 and 12 |
  | §8 Quick edit | 12 |
  | §9 skill | 12 |
  | §10 testing | every task, plus 14 |

- **Review Focus pins:**
  1. Task 4 paths, Task 7 NFC, Task 10 accents.
  2. Task 5 concurrency.
  3. Task 7 bookmarks/tab.
  4. Task 10 DST.
  5. Task 8 beyond-range/merged/shared formula.
