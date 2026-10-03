# Crow Workspace W2: the Crow toolset (design)

**Status:** spec written 2026-10-03, from Kevin's W2 decisions of the same day and live probes of the W1 install on crow. It covers sub-project W2 of `docs/superpowers/specs/2026-10-02-crow-workspace-design.md`. Plan: `docs/superpowers/plans/2026-10-03-workspace-w2-toolset.md`.
**Binding inputs:** the parent spec's D6 (versioned edits with a lock check), D7 (mirror the Google Workspace MCP with a `ws_` prefix and the same guardrails), §5 (W2 preview) and Appendix A (Kitchen needs a Menu calendar and a recipe-index spreadsheet). W1 is live on crow: Nextcloud 34.0.4, ONLYOFFICE Docs 9.4.0, bundle `bundles/workspace` v0.1.2, bot account `crow-bot`.

## 1. Purpose

Give Crow's bots full, safe control of the household's Workspace through MCP tools, with no shell and no file access:
- **Drive:** files and folders.
- **Docs, Sheets, Slides:** edits to `.docx`, `.xlsx` and `.pptx` files that keep their formatting.
- **Calendar and Contacts:** CalDAV and CardDAV.

Every AI change can be undone in one call, and no change ever overwrites a document someone has open.

The same engine also drives a phone-friendly **Quick edit** page in Crow's Office panel. ONLYOFFICE Community can't edit in a phone browser, so this page covers that gap.

**Success looks like:**
- A bot asked "add tacos to Thursday's menu" puts the event on the Menu calendar, and both phones show it.
- A bot asked "fix the typo in the second paragraph" changes one run of text. Everything else in the file stays byte-identical, and a labeled version exists to roll back to.
- If Dayane has the file open, the bot waits up to 30 s. Then it says "Dayane has it open" and asks whether to go ahead.
- On a phone, Kevin can change one spreadsheet cell from Crow's Office panel and undo it.

## 2. Decisions

| # | Question | Decision | Source |
|---|---|---|---|
| K1 | What a write does when the file is open in the editor | **Wait up to ~30 s** for the editor lock to clear. If it's still held, return a structured "open by X" result so the bot can **ask the user** whether to go ahead anyway or try later. | Kevin 2026-10-03 |
| K2 | v1 scope | Drive + Docs (.docx), Sheets (.xlsx), **Slides (.pptx)**, Calendar + Contacts (CalDAV/CardDAV) | Kevin 2026-10-03 |
| K3 | Phone editing | The bot edits by chat, plus a phone-friendly **Quick edit** page in the Office panel for small text and cell changes (no layout editor). Every change is an undoable version. | Kevin 2026-10-03 |
| K4 | Model routing | None. The bot's normal model drives deterministic tools. | Kevin 2026-10-03 |
| D6 | How the AI edits | Edits the saved file. Every AI edit makes a Nextcloud version. It never clobbers. | parent spec |
| D7 | Toolset shape | Mirror the Google Workspace MCP with a `ws_` prefix and the same guardrails | parent spec |

### 2.1 What "go ahead anyway" really does (verified on crow 2026-10-03)

Kevin pictured going ahead as "the editor shows a reload prompt". The live system works differently, and the design follows the live system.

What the probes showed:
- **The ONLYOFFICE connector holds a hard lock.** `files_lock` is enabled. While a document is open, ONLYOFFICE's connector takes a `files_lock` **app lock** (`nc:lock-owner-type 1`, owner `onlyoffice`, timeout `-60` meaning no expiry): `CallbackController.php:657-663` locks on status 1 and unlocks on save/close.
- **crow-bot's write is refused.** A WebDAV `PUT` by crow-bot on a file locked that way returns **`423 Locked`**. This was verified on `acceptance-test.docx`, writing back identical bytes.
- **crow-bot can't break the lock.** `files_lock` lets only the lock's owner, or the file's owner with a *user* lock, unlock it (`LockService::canUnlock`). NC 34 ships no `files_lock` occ command.
- **ONLYOFFICE can say who is in a document.** The command service (`POST /coauthoring/CommandService.ashx` with the bundle's JWT secret) answers `{"c":"info","key":K}` with **the users in the session**: `{"error":0,"users":["<instanceid>_admin"]}`. It returns `error: 1` when no session exists.
- **crow-bot can get the document key.** The connector's OCS endpoint `GET /ocs/v2.php/apps/onlyoffice/api/v1/config/{fileId}` returns the key to any user who can open the file. crow-bot got it.

So "go ahead anyway" (`if_open: "proceed"`) means:
1. Ask ONLYOFFICE to **drop** the editing users (`{"c":"drop","key":K,"users":[…]}`).
2. ONLYOFFICE ends the session, **saves their edits first** (as their own version) and releases the lock.
3. The tool waits ≤ 30 s for the release, then makes its change on top.

The people editing see ONLYOFFICE's disconnect notice and reload. That is the "reload prompt" Kevin asked for, reached without losing anyone's typing. Task 1 (the live spike) confirms the drop → save → unlock timing before any code depends on it. If drop doesn't release the lock within 30 s, the tool returns `could_not_close_editor` and the bot offers "try later". Nothing escalates further.

**A manual lock is never overridden.** A person can lock a file from the Files app (lock type 0 = user, 2 = token). For those, `proceed` returns `locked_by_person` and the bot tells the user who holds the lock.

## 3. Architecture

```
bot (pi / AI chat / companion) ──MCP stdio──▶ bundles/workspace/server  (node, on the host)
                                              │  config.js  reads <CROW_HOME>/bundles/workspace/.env (codec)
                                              │  nc/*       WebDAV · versions · OCS · ONLYOFFICE command/convert
                                              │  ooxml/*    surgical .docx/.xlsx/.pptx editors (fflate + xmldom)
                                              │  pim/*      CalDAV · CardDAV · undo journal (ical.js)
                                              │  write-protocol.js  lock → wait → If-Match PUT → label → version_id
                                              ▼
                      127.0.0.1:3070 Nextcloud (as crow-bot)   127.0.0.1:3071 ONLYOFFICE (JWT)
Office panel (gateway) ── Quick edit forms ──▶ panel/routes.js ──▶ the same server/lib modules (as crow-bot)
```

- **One MCP server inside the existing `workspace` bundle.** The manifest gains `server: {command:"node", args:["server/index.js"], envKeys:[]}`, `skills: ["skills/workspace.md"]`, `panelRoutes: "panel/routes.js"`, and a version bump to **0.2.0**. Docker bundles with a server are an established pattern (paperless, vikunja and about 40 others).
- **All writes go through one module,** `write-protocol.js` (§5). There is no other path that PUTs to Nextcloud.
- **Library choice: surgical OOXML editing** with `fflate` (zip, MIT) and `@xmldom/xmldom` (DOM, MIT). Parts a tool doesn't touch are copied byte-for-byte. Inside a touched part, only the edited nodes change. The rejected options:

  | Library | Why not |
  |---|---|
  | `docx` / `pptxgenjs` | Generate new files only; they cannot round-trip an existing one |
  | `exceljs` | Rewrites the whole workbook and drops charts and other unsupported parts on save |
  | `xlsx` (SheetJS CE) | Drops cell styling on write |
  | `docxtemplater` | Placeholder templating, not general editing |

  Markdown parsing reuses **`marked`**, already a root dependency (its `lexer`). iCalendar and vCard use **`ical.js`** (MPL-2.0, unmodified dependency; it parses both and expands RRULEs). WebDAV, CalDAV and CardDAV are a small hand-written client on Node 24's `fetch`, because the surface is a dozen verbs and a hermetic fake must match it exactly. That rules out `webdav` and `tsdav`.
- **New npm packages:** `fflate`, `@xmldom/xmldom`, `ical.js`. They go in the bundle's `package.json` (per `tests/bundle-server-deps.test.js`) and in the root `devDependencies`, because CI resolves bundle imports through the root `node_modules`. Kevin's standing rule is to ask before installing a package, so **Task 3 opens with that approval gate**.

## 4. Tool catalog

### 4.1 Conventions (all tools)

- **Names:** `ws_<service>_<verb>`, with service in `drive | docs | sheets | slides | cal | contacts`. The Google `g` prefix (and the bare `sheets_`) becomes `ws_`: `gdocs_read` → `ws_docs_read`, `gdrive_search` → `ws_drive_search`, `sheets_write` → `ws_sheets_write`, `gcal_create_event` → `ws_cal_create_event`. Plus `ws_undo_last_change`. No existing Crow tool uses `ws_`. Addon tools are dispatched by bare name through `crow_tools` (`router.js:225-245`).
- **Addressing:**
  - A file is addressed by `path`, relative to crow-bot's files root, e.g. `"Shared with Crow/Casa Nueva/Menu.xlsx"`. Every file tool also accepts `file_id` (Nextcloud's numeric `oc:fileid`) in place of `path`. Results always return both.
  - Calendars and contacts are addressed by `calendar` / `addressbook` (display name or href id) plus the object `uid`.
- **Result envelope:** `{ success: true, data }` or `{ success: false, error, code }`, the same contract as the Google MCP. It goes back as one JSON text content block.
- **Write results** always include:
  - `path`, `file_id`;
  - `version_id`, the undo handle (§5.4);
  - `version_label`;
  - `changed`, a count or boolean. A zero-match edit returns `changed: 0` and **makes no version**.
- **Destructive tools** (`ws_drive_trash_file`, `ws_sheets_delete_tab`, `ws_slides_delete_slide`, `ws_cal_delete_event`, `ws_contacts_delete`) carry "confirm intent with the user first" in their descriptions, as the Google MCP does.
- **No local filesystem.** No tool reads or writes a host path. Content comes in as `text` or `base64` parameters, and exports go into the drive (§4.2). This replaces Google's `local_path` parameters.

### 4.2 Drive (17 tools)

| Tool | Params | Behavior / guardrail | Google twin |
|---|---|---|---|
| `ws_drive_list_folder` | `path=""` | PROPFIND depth 1. Returns `name, path, file_id, type (folder/file), size, modified, mime, locked`. No cap. | `gdrive_list_folder` |
| `ws_drive_find_folder` | `name`, `parent=""` | Exact-name folder match via DAV `SEARCH` (`basicsearch`, `displayname` eq, collections only), scoped to `parent`. Input is XML-escaped (fixes the Google tool's unescaped query). | `gdrive_find_folder` |
| `ws_drive_get_metadata` | `path`\|`file_id` | Size, mime, modified, etag, owner (`oc:owner-id`, display name), crow-bot's `oc:permissions`, lock state (§5.2), `web_url` (the Serve URL `…/f/<fileid>`). | `gdrive_get_metadata` |
| `ws_drive_get_permissions` | `path`\|`file_id` | Read-only: owner, crow-bot's permission letters decoded (`R` share, `W` write, `D` delete, `C/K` create, `N/V` rename/move), and shares crow-bot itself made (OCS `shares?path=`). crow-bot can't see other people's shares, and the result says so. | `gdrive_get_permissions` |
| `ws_drive_read_file` | `path`\|`file_id`, `max_chars=200000` (≤1,000,000) | Office files become text through the readers: `.docx` → markdown, `.xlsx` → each tab as CSV-like text, `.pptx` → slide text + notes. `text/*`, `.md`, `.csv`, `.json`, `.ics`, `.vcf` are returned as UTF-8. Other binaries are refused with metadata. `truncated` flag. | `gdrive_read_file` |
| `ws_drive_search` | `query`, `max_results=20` (≤100) | DAV `SEARCH`, `displayname LIKE %query%` (`%`/`_` escaped), files and folders, newest first. | `gdrive_search` |
| `ws_drive_create_folder` | `name`, `parent=""` | MKCOL. Idempotent: returns `created:false` if it exists. | `gdrive_create_folder` |
| `ws_drive_move_file` | `path`, `new_parent` | MOVE with `Overwrite: F`. Returns `moved:false` if already there. | `gdrive_move_file` |
| `ws_drive_copy_file` | `path`, `new_name?`, `parent?` | COPY with `Overwrite: F`. A name clash adds ` (2)`, ` (3)`… | `gdrive_copy_file` |
| `ws_drive_rename` | `path`, `new_name` | MOVE within the same folder. Returns `old_name`/`name`. | `gdrive_rename` |
| `ws_drive_trash_file` | `path` | DELETE, which goes to Nextcloud's trash bin (recoverable). Refused if the file is open (§5.2). | `gdrive_trash_file` |
| `ws_drive_upload_file` | `folder`, `name`, `text`\|`base64`, `mime?` | Creates a **new** file (`If-None-Match: *`), ≤ 10 MB decoded. Never overwrites. | `gdrive_upload_file` |
| `ws_drive_upload_new_version` | `path`, `text`\|`base64` | Replaces the content of a non-office file through the write protocol. **Refused for .docx/.xlsx/.pptx**: that is a full-document replace (D7 guardrail). | `gdrive_upload_new_version` |
| `ws_drive_export` | `path`, `format` (`pdf`,`docx`,`odt`,`xlsx`,`ods`,`csv`,`pptx`,`odp`), `folder?` | Converts through the ONLYOFFICE connector (`GET /apps/onlyoffice/downloadas?fileId=&toExtension=`, verified as crow-bot) and saves the result **into the drive** next to the source (or in `folder`), never overwriting. ≤ 50 MB. | `gdrive_export`, `gdrive_download_file` |
| `ws_drive_share` | `path`, `user`, `role` (`reader`\|`writer`) | OCS user share (type 0) only. Nextcloud always shows the person an in-app notification; Crow sends no email. **Never a link share.** crow-bot is also barred from links at the server (`shareapi_allow_links_exclude_groups`). `user` must match a Nextcloud user id exactly. | `gdrive_share` |
| `ws_drive_list_versions` | `path`\|`file_id`, `limit=20` | `/remote.php/dav/versions/crow-bot/versions/<fileid>`: `version_id`, time, author, label, size. Newest first. | (new) |
| `ws_drive_restore_version` | `path`, `version_id` | Restores any listed version (MOVE to `…/restore/target`). Goes through the write protocol, so the current content becomes a version first and the restore can be undone too. | (new) |

**Omitted Google tools:**
- `gdrive_transfer_ownership`: ownership transfer is an admin operation in Nextcloud.
- `gdrive_create_shortcut`: Nextcloud has no shortcut equivalent.
- `gdrive_download_file`: no local filesystem; use `ws_drive_read_file` or `ws_drive_export`.

### 4.3 Docs (.docx, 11 tools)

The text model:
- A **paragraph** is a `w:p`. Its text is the concatenation of its runs' `w:t`. `w:tab`/`w:br` are segment boundaries that a search never matches across.
- **Headings** are paragraphs whose style resolves (via `styles.xml`) to a name `heading 1`–`heading 6` or carries `w:outlineLvl` 0–5. `Title`/`Subtitle` aren't headings, as in the Google MCP.
- **Search scope:**
  - `find_replace` and `format_text` cover body paragraphs, table cells, headers and footers.
  - `rewrite_passages` and section boundaries cover top-level body paragraphs only, as in the Google MCP.

| Tool | Params | Behavior / guardrail | Google twin |
|---|---|---|---|
| `ws_docs_read` | `path` | Whole document as markdown (headings, lists, bold/italic, links, GFM tables). Every call reads the live file; nothing is cached. Returns `title`, `markdown`, `etag`. | `gdocs_read` |
| `ws_docs_get_structure` | `path` | `[{level, text, index}]` heading outline (`index` = body paragraph index). | `gdocs_get_structure` |
| `ws_docs_read_section` | `path`, `heading` | Markdown of one section. The section ends at the next heading of the **same or higher level**. Not found → error listing the available headings. | `gdocs_read_section` |
| `ws_docs_find_replace` | `path`, `find?`, `replace?`, `match_case=true`, `pairs?` | **Atomic batch:** every pair is applied in order to the in-memory document, then **one** write and **one** version. `pairs` wins over `find`/`replace`. Matches can span runs inside a paragraph. The replacement takes the formatting of the run where the match starts, and other runs are trimmed. Returns per-pair `occurrences` + `total_changes`. | `gdocs_find_replace` |
| `ws_docs_append` | `path`, `markdown` | Appends at the end of the body (before `w:sectPr`). | `gdocs_append` |
| `ws_docs_insert_at_heading` | `path`, `heading`, `markdown` | Inserts right after the heading paragraph. **Heading-style reset:** each inserted paragraph is built fresh with the Normal style and no numbering, except where the markdown itself asks for a heading or list. It never copies the heading's `w:pPr`. Returns `heading_inheritance_fix_applied: true`. | `gdocs_insert_at_heading` |
| `ws_docs_replace_section` | `path`, `heading`, `markdown` | **Heading-to-heading** delete + reinsert. It removes every body element (paragraphs and tables) between the heading and the next same-or-higher heading (or the end), then inserts the markdown with the same reset. Subsections fall inside the range. **Atomic** (one write, an improvement on Google's two calls). An empty section can be filled (also an improvement). | `gdocs_replace_section` |
| `ws_docs_create` | `folder`, `title`, `content=""`, `find_existing=true` | Dedupe by exact `<title>.docx` in the folder (`created:false`). Otherwise copies the bundled blank template (§4.8), appends `content`, and creates the file with `If-None-Match: *`. | `gdocs_create` |
| `ws_docs_rewrite_passages` | `path`, `passages:[{match_prefix,new_text}]` | First top-level paragraph whose left-trimmed text starts with the trimmed prefix (≤ 100 chars, case-sensitive). No paragraph is matched twice. Keeps the paragraph's `w:pPr` and the **first run's `w:rPr`**. `\n` in `new_text` → extra paragraphs cloning that `w:pPr`. Unmatched prefixes are reported and the rest still apply. One version. | `gdocs_rewrite_passages` |
| `ws_docs_format_text` | `path`, `find`, `occurrence=0` (-1 = all), `bold?`, `italic?`, `underline?`, `link_url?`, `color_hex?` | Style-only change. Splits runs at the match edges and sets `w:b`/`w:i`/`w:u`/`w:color`, or wraps the match in `w:hyperlink` with a new external relationship. `link_url` must be `http(s):` or `mailto:`. At least one style is required. | `gdocs_format_text` |
| `ws_docs_insert_image` | `path`, `image_path`, `anchor_text?`, `index?`, `max_width_pt=450` | The image comes **from the drive** (png/jpeg/gif, ≤ 5 MB): no public URL, no temporary sharing. It is added as `word/media/imageN.*` + relationship + content type, inline `w:drawing` sized from the image header and scaled to `max_width_pt`. `anchor_text` (first match inside one run) is replaced by the image. Otherwise it goes before body paragraph `index` (default 0). | `gdocs_insert_image` |

**Markdown subset** (`marked.lexer`):
- Headings `#`–`######` map to the document's heading styles (they are added to `styles.xml` if missing).
- `-`/`*`/`+` bullets and `1.` lists use a bullet/decimal `w:abstractNum`, reused or added to `numbering.xml`.
- `**bold**`, `*italic*`, `[link](url)` and GFM tables (`w:tbl` with a bold header row) are supported.
- **Soft wraps** fold into one paragraph. A blank line, two trailing spaces or a trailing `\` makes a hard break. This is the Google MCP rule.

**There is deliberately no full-document replace tool** (D7). The description of `ws_drive_upload_new_version` points to `ws_docs_find_replace` / `ws_docs_replace_section`.

### 4.4 Doc comments (5 tools): comments inside the .docx

These are the comments ONLYOFFICE shows in its comment pane:
- `word/comments.xml`;
- range anchors `w:commentRangeStart/End` + `w:commentReference`;
- reply threads and resolved state in `word/commentsExtended.xml` (`w15:commentEx paraId/paraIdParent/done`).

Nextcloud's separate file-level sidebar comments are not used.

| Tool | Params | Behavior | Google twin |
|---|---|---|---|
| `ws_docs_list_comments` | `path`, `include_resolved=false` | **Every** comment (no paging limit exists in a file, so nothing is truncated): `id, author, date, content, quoted_text` (text between the anchors), `resolved`, `replies[]`. | `gdocs_list_comments` |
| `ws_docs_add_comment` | `path`, `content`, `quoted_text?` | Anchored to the **first occurrence** of `quoted_text`, a real anchor (Google's API can't do this). Without it, anchored to the first body paragraph. Author is `Crow bot` (`w:initials="CB"`). | `gdocs_add_comment` |
| `ws_docs_reply_comment` | `path`, `comment_id`, `content` | A new `w:comment` linked by `paraIdParent`. | `gdocs_reply_comment` |
| `ws_docs_resolve_comment` | `path`, `comment_id` | Sets `done="1"` on the thread root. | `gdocs_resolve_comment` |
| `ws_docs_apply_comment_edit` | `path`, `comment_id`, `replace_text`, `summary` | Replaces **only the anchored range** (Google replaced every occurrence in the doc; an improvement), then adds `summary` as a reply and resolves. Already resolved → error. No anchor or empty anchor → posts an explanatory reply, **leaves the thread unresolved** and returns `applied:false, reason`. The description says exactly that (fixes the Google description/code mismatch). One version for the whole operation. | `gdocs_apply_comment_edit` |

### 4.5 Sheets (.xlsx, 11 tools)

The model:
- A range is `Tab!A1:C10`, `Tab!A:A`, or `Tab` (the used range from `<dimension>`). A tab name with spaces or quotes may be single-quoted with `''` escaping.
- A cell's value comes from `<v>`, shared strings or `inlineStr`.
- **Written cells keep their `s` style attribute,** so their formatting survives.
- **Formula freshness:**
  - Any write sets `<calcPr fullCalcOnLoad="1">` and removes `xl/calcChain.xml` (plus its relationship and content-type override), so ONLYOFFICE and Excel recalculate on open.
  - Formula cells the toolset writes carry no cached `<v>`.
  - Reads report `stale_formulas: true` when the range contains a formula cell with no cached value. The workspace skill tells the bot to read formulas with `value_render_option:"FORMULA"` in that case.

| Tool | Params | Behavior / guardrail | Google twin |
|---|---|---|---|
| `ws_sheets_list` | `path` | Tab names in order. | `sheets_list` |
| `ws_sheets_get_tabs` | `path` | `sheet_id, index, title, rows, cols, frozen_rows, frozen_cols, hidden`. | `sheets_get_tabs` |
| `ws_sheets_read` | `path`, `range`, `value_render_option=FORMATTED_VALUE` | `FORMATTED_VALUE` \| `UNFORMATTED_VALUE` \| `FORMULA`, anything else errors. Formatted values cover General, `0`, `0.00`, `#,##0(.00)`, `%`, built-in date/time ids 14–22, custom `y/m/d/h/s` patterns and `@`. Other formats fall back to the raw value. Ragged rows (trailing empties trimmed). ≤ 50,000 cells per call. | `sheets_read` |
| `ws_sheets_write` | `path`, `range`, `values`, `value_input_option=USER_ENTERED` | Overwrites the range from its top-left cell. A flat row is wrapped. Values are scalarized (dict/list → JSON string, null → empty). `USER_ENTERED`: `=…` is a formula; numeric text → number; `TRUE`/`FALSE` → boolean; an ISO date into a date-formatted cell → serial. Everything else is an inline string. `RAW`: always strings. | `sheets_write` |
| `ws_sheets_append` | `path`, `sheet_name`, `values`, `value_input_option=USER_ENTERED` | Writes after the last non-empty row. Accepts a dict, list of dicts (mapped to row-1 headers; unknown keys are an error), a flat row or a 2D list. Empty → error. | `sheets_append` |
| `ws_sheets_create` | `title`, `folder?`, `tabs?`, `find_existing=true` | Blank template. The first `tabs` entry renames Sheet1. Dedupes by name when `folder` is given. | `sheets_create` |
| `ws_sheets_add_tab` | `path`, `title`, `index?` | New worksheet part + workbook entry + relationship + content type. | `sheets_add_tab` |
| `ws_sheets_rename_tab` | `path`, `title`, `new_title` | Also rewrites references to the old name in every formula, defined name and chart `c:f`. It skips text inside string literals. **Refused** if a pivot cache references the tab. | `sheets_rename_tab` |
| `ws_sheets_delete_tab` | `path`, `title` | Destructive; confirm first. Refused for the last visible tab. | `sheets_delete_tab` |
| `ws_sheets_set_number_format` | `path`, `range`, `pattern="@"`, `format_type="TEXT"` | Adds or reuses a custom `numFmt` (id ≥ 164) and clones each cell's `xf` with the new `numFmtId` (`applyNumberFormat="1"`). Other style fields are kept. The default forces text (keeps leading zeros). | `sheets_set_number_format` |
| `ws_sheets_batch_update` | `path`, `ops:[{op:"write"\|"append"\|"add_tab"\|"rename_tab"\|"delete_tab"\|"set_number_format", …same params}]` | Typed ops applied in order, **one** version. Google's raw request passthrough has no OOXML meaning, so it is replaced by this typed list. | `sheets_batch_update` |

### 4.6 Slides (.pptx, 16 tools)

Ids:
- A **slide** is addressed by `slide_id`, the stable `p:sldId/@id` from `presentation.xml`.
- A **shape** is addressed by `object_id` = `"<slide_id>:<cNvPr id>"`.
- Slide order is `sldIdLst` order. Titles come from `title`/`ctrTitle` placeholders. Notes are in `ppt/notesSlides/*`.

| Tool | Params | Behavior / guardrail | Google twin |
|---|---|---|---|
| `ws_slides_read` | `path`, `include_notes=true` | Per slide: id, index, title, shapes `{object_id, name, kind, text}`, notes. | `gslides_read` |
| `ws_slides_get_structure` | `path` | Slide ids, titles, element ids. | `gslides_get_structure` |
| `ws_slides_read_notes` | `path`, `slide_id?` | Notes text (read-only). | `gslides_read_notes` |
| `ws_slides_find_replace` | `path`, `find?`, `replace?`, `match_case=true`, `scope="slides"`, `slide_ids?`, `pairs?` | `scope` = `slides` \| `notes` \| `all`. **`slides` provably can't touch notes**: notes are separate parts and only `notes`/`all` loads them. `slide_ids` restricts. Atomic, one version. Zero occurrences = no match (no version). | `gslides_find_replace` |
| `ws_slides_create` | `title`, `folder?` | Blank deck from the template (§4.8). | `gslides_create` |
| `ws_slides_add_slide` | `path`, `layout="Blank"`, `index?` | Layout by `p:cSld/@name` among the deck's own layouts (case-insensitive). Unknown → error listing them. | `gslides_add_slide` |
| `ws_slides_duplicate_slide` | `path`, `slide_id` | Copies the slide part (+ its notes) and rels, new id after the source. | `gslides_duplicate_slide` |
| `ws_slides_delete_slide` | `path`, `slide_id` | Removes the slide, its notes and relationships. Destructive; confirm first. | `gslides_delete_slide` |
| `ws_slides_reorder_slides` | `path`, `slide_ids`, `insertion_index` | Moves in `sldIdLst`. | `gslides_reorder_slides` |
| `ws_slides_add_text_box` | `path`, `slide_id`, `text`, `x=1, y=1, width=8, height=1` (inches), `font_size?` | New `p:sp` text box (inches → EMU). | `gslides_add_text_box` |
| `ws_slides_add_image` | `path`, `slide_id`, `image_path`, `x=1, y=1, width=4, height=3` | Image **from the drive** (not a public URL), ≤ 5 MB. | `gslides_add_image` |
| `ws_slides_format_text` | `path`, `object_id`, `bold?`, `italic?`, `underline?`, `font_size?`, `color_hex?`, `font_family?` | All runs in the shape. At least one style is required; hex must be 6 digits. | `gslides_format_text` |
| `ws_slides_format_paragraph` | `path`, `object_id`, `alignment` (`START\|CENTER\|END\|JUSTIFIED`) | `a:pPr/@algn`. | `gslides_format_paragraph` |
| `ws_slides_edit_text` | `path`, `object_id`, `new_text` | Replaces the shape's text and **reapplies the first run's `a:rPr`**. `\n` → paragraphs cloning the first `a:pPr`. | `gslides_edit_text` |
| `ws_slides_edit_notes` | `path`, `slide_id`, `text`, `mode="replace"` | `replace` \| `append`. Missing notes slide → created from the deck's notes master. No notes master → error. | `gslides_edit_notes` |
| `ws_slides_batch_update` | `path`, `ops:[{op:"edit_text"\|"find_replace"\|"add_slide"\|"delete_slide"\|"reorder_slides"\|"edit_notes"\|"format_text", …}]` | Typed ops, one version (replaces the raw passthrough). | `gslides_batch_update` |

`gslides_export` maps to `ws_drive_export` (`pdf`/`pptx`/`odp`), so there is no separate tool.

### 4.7 Calendar (7 tools) and Contacts (6 tools)

Calendars:
- Calendars are crow-bot's CalDAV calendars under `/remote.php/dav/calendars/crow-bot/`. That includes calendars **shared with it**, which appear as `<name>_shared_by_<owner>`.
- On 2026-10-03 crow-bot had **none**: Menu is shared only with Dayane. Sharing Menu with crow-bot (edit rights) is a household action and an acceptance step. The bot reaches only what the household shares (D5).

| Tool | Params | Behavior / guardrail | Google twin |
|---|---|---|---|
| `ws_cal_list_calendars` | none | `id` (href segment), `name`, `owner`, `writable`, `color`. | `gcal_list_calendars` |
| `ws_cal_list_events` | `calendar`, `time_min?` (default now), `time_max?` (default +30 d, ≤ 366 d window), `max_results=20` (≤ 250), `query?`, `single_events=true` | `calendar-query` REPORT with a time-range filter. `single_events` expands RRULEs within the window (ical.js) and orders by start. `query` matches summary/description/location, case-insensitive. | `gcal_list_events` |
| `ws_cal_get_event` | `calendar`, `uid` | Parsed fields + raw ICS. | `gcal_get_event` |
| `ws_cal_create_event` | `calendar`, `summary`, `start`, `end`, `description?`, `location?`, `attendees?`, `send_updates="none"` | `YYYY-MM-DD` → all-day (`VALUE=DATE`, end exclusive). Datetimes need an offset or `Z`. `PUT` with `If-None-Match: *`. With `send_updates:"none"` (default), attendees get `SCHEDULE-AGENT=CLIENT`, so Nextcloud sends no invitations. | `gcal_create_event` |
| `ws_cal_update_event` | `calendar`, `uid`, fields to change | `If-Match` etag. Unspecified fields are kept. Recurring series: master only (v1). Journaled (§5.5). | (new: Kitchen moves meals) |
| `ws_cal_delete_event` | `calendar`, `uid` | `If-Match` DELETE. Nextcloud keeps it in the calendar trash bin. Also journaled. Destructive; confirm first. | (new; the Google MCP omitted it as destructive, but Kitchen needs it and the journal makes it undoable) |
| `ws_cal_respond_to_event` | `calendar`, `uid`, `response` (`accepted\|declined\|tentative`), `comment?` | Sets crow-bot's own `ATTENDEE` `PARTSTAT`. Error if crow-bot isn't an attendee. | `gcal_respond_to_event` |

| Tool | Params | Behavior |
|---|---|---|
| `ws_contacts_list_addressbooks` | none | Books crow-bot can see (own + shared). |
| `ws_contacts_search` | `query`, `addressbook?`, `max_results=20` | `addressbook-query` REPORT, text-match on FN/EMAIL/TEL/NICKNAME. |
| `ws_contacts_get` | `addressbook`, `uid` | Parsed vCard (name, emails, phones, address, birthday, note, org) + raw. |
| `ws_contacts_create` | `addressbook`, `full_name`, `emails?`, `phones?`, `address?`, `birthday?`, `note?`, `org?` | vCard 3.0 (what Nextcloud and DAVx⁵ store most reliably), with `N` derived from the full name. `If-None-Match: *`. |
| `ws_contacts_update` | `addressbook`, `uid`, fields | `If-Match`. Unknown vCard properties are preserved. Journaled. |
| `ws_contacts_delete` | `addressbook`, `uid` | `If-Match`. Journaled (CardDAV has no trash bin, so the journal is the only undo). Destructive; confirm first. |

### 4.8 Undo, and new-file templates

- **`ws_undo_last_change`** takes `path` + `version_id`. For calendar and contacts, `path` is the `ref` those tools return, e.g. `cal:<calendar>/<uid>`. Semantics are in §5.4.
- **Templates.** New files copy `server/templates/blank.docx|xlsx|pptx`:
  - They are generated once by a committed dev script (`server/templates/make-templates.py`, using python-docx / openpyxl / python-pptx, all MIT; already installed on crow). The binaries are committed.
  - The docx template defines Normal, Heading 1–6, List Bullet/Number and a Table Grid style. The pptx template has Title, Title and Content, and Blank layouts plus a notes master.
  - The ONLYOFFICE connector's own `new.*` templates are AGPL assets and are **not** copied into Crow (MIT).

### 4.9 Google → Workspace mapping (complete)

| Google | Workspace |
|---|---|
| `gdrive_list_folder`, `find_folder`, `get_metadata`, `get_permissions`, `read_file`, `search`, `create_folder`, `move_file`, `copy_file`, `rename`, `trash_file`, `upload_file`, `upload_new_version`, `share` | `ws_drive_` + same verb |
| `gdrive_export`, `gdrive_download_file` | `ws_drive_export` (into the drive) |
| `gdrive_transfer_ownership`, `gdrive_create_shortcut` | — (omitted, §4.2) |
| `gdocs_*` (11) and comment tools (5) | `ws_docs_` + same verb |
| `sheets_*` (11) | `ws_sheets_` + same verb (`batch_update` takes typed ops) |
| `gslides_*` (15 + export) | `ws_slides_` + same verb; export → `ws_drive_export` |
| `gcal_list_calendars`, `list_events`, `get_event`, `create_event`, `respond_to_event` | `ws_cal_` + same verb |
| — | `ws_cal_update_event`, `ws_cal_delete_event`, `ws_contacts_*` (6), `ws_drive_list_versions`, `ws_drive_restore_version`, `ws_undo_last_change` |

Total: 17 drive + 16 docs + 11 sheets + 16 slides + 7 calendar + 6 contacts + 1 undo = **74 tools**.

## 5. The write protocol (`server/write-protocol.js`)

Every file mutation (tools and Quick edit) is `withFileWrite(ref, mutate, opts)`:

1. **Resolve and validate** the path (§7.1), then PROPFIND depth 0. A folder, missing file or no `W` permission → error (`not_found` / `read_only`).
2. **Serialize per file.** An in-process mutex keyed by `file_id` covers the MCP server's own concurrency. Nextcloud's `If-Match` covers everyone else (step 6).
3. **Lock check** (§5.2). If locked, wait (poll every 2 s, ≤ `wait_s`, default 30). If still locked:
   - return `{success:false, code:"open_in_editor", data:{open_by:[names], since, lock_type:"editor", can_proceed:true, message}}`;
   - or `code:"locked_by_person"` (`can_proceed:false`);
   - or `code:"stale_editor_lock"` (§5.3).
4. **`if_open:"proceed"`** (only after the user agreed), and only for an editor lock with a live session:
   - send ONLYOFFICE `drop` for the session's users;
   - wait ≤ 30 s for the lock to clear;
   - otherwise return `could_not_close_editor`.
5. **Read** the file (`GET`, ≤ 50 MB) and remember its `etag` and current version id. Then run `mutate(bytes) → {bytes, changed, summary}`. `changed === 0` → return without writing (no version).
6. **Write:** `PUT` with `If-Match: <etag>`.
   - On `412`, re-read and re-run `mutate` once. Tools are deterministic edits, so re-applying is safe. A second `412` → `code:"changed_concurrently"`.
   - On `423` (the lock appeared between steps 3 and 6), go back to step 3 once.
7. **Label versions** via PROPPATCH `nc:version-label`:
   - the pre-edit version: `Before Crow: <summary>`;
   - the new current version: `Crow: <summary>`. Quick edit uses `Quick edit: <summary>`.
   - Labels make the history readable in Nextcloud's version sidebar, and labeled versions are exempt from automatic version expiry. Task 1 verifies this; if it's false, the plan's ruling R-EXPIRY applies.
8. **Return** `version_id` (§5.4), `version_label`, `changed`, plus the tool's own data.

`wait_s` (0–30) and `if_open` (`"wait"` default \| `"proceed"`) are optional params on every writing tool.

### 5.1 Why a version always exists

Nextcloud's `files_versions` makes a version of the previous content on every write by a user. Nextcloud 34 lists the current file as a version too (id = its mtime, verified on file 148).

Version ids are mtimes in seconds, so two writes inside one second could collide. The per-file mutex therefore spaces writes to the same file **≥ 1.1 s** apart.

### 5.2 Lock detection

- **Lock state:** PROPFIND `nc:lock`, `nc:lock-owner-type` (0 user, 1 app, 2 token), `nc:lock-owner`, `nc:lock-owner-displayname`, `nc:lock-time`, `nc:lock-timeout`.
- **App lock** (owner `onlyoffice`) = "open in the editor". To get the names:
  1. fetch the doc key via the connector OCS config endpoint;
  2. ask the command service `info`;
  3. map each `users[]` entry `<instanceid>_<uid>` to a display name via the DAV principal `/remote.php/dav/principals/users/<uid>/` (readable by crow-bot, verified).
- **User/token lock** = "locked by a person". Name from `nc:lock-owner-displayname`.

### 5.3 Stale editor locks

ONLYOFFICE app locks never expire on their own (timeout `-60`). If the browser died and the document server lost the session, `info` returns `error:1` while `nc:lock` is still set. The tool returns `stale_editor_lock`, with a message telling the bot to ask the file's owner to open the file's ⋯ menu in Workspace → **Unlock**. `canUnlock` allows the owner with a user-type request. crow-bot can't unlock it, and the protocol doesn't try.

(On 2026-10-03 `acceptance-test.docx` had an editor lock since 21:07 UTC. `info` showed a live session for `admin`, i.e. an open tab, not a stale lock.)

### 5.4 Version ids and undo

**`version_id`** (files) is a stateless opaque token: `v1.<fileid>.<before>.<afterEtag>`, base64url of JSON `{f, b, a}`. It is self-describing, needs no server state, and survives restarts.

**`ws_undo_last_change({path, version_id})`:**
1. Re-reads the file.
   - If its etag ≠ `afterEtag`, someone (or a later bot edit) changed it since. The tool **refuses** with `code:"changed_since"`, data `{modified, modified_by_label}`, and points at `ws_drive_list_versions` + `ws_drive_restore_version`. It never clobbers newer work.
2. Otherwise it restores version `before` through the write protocol. That makes undo itself undoable, and it returns a new `version_id`.
3. **Files the toolset created** carry `before = "0"`. Undoing them moves the new file to the Nextcloud trash (recoverable), again only if it is unchanged since.

**Calendar/contacts `version_id`** is `j1.<journal id>` (§5.5). Undo puts the journaled prior ICS/vCard back with `If-Match` on the post-change etag. A deleted object is re-created with `If-None-Match: *`; a created one is deleted. The same `changed_since` refusal applies.

### 5.5 The PIM undo journal

- **Where:** `<CROW_DATA_DIR or CROW_HOME/data>/workspace-tools/journal/` holds one JSON file per change: `{id, ref, op, before_text|null, after_etag, at}`.
- **Permissions:** dir 700, files 600. It holds household calendar data.
- **Pruning:** at server start and every 6 h, entries older than 30 days go, keeping ≤ 500.
- File changes need no journal: Nextcloud keeps the versions.

## 6. Auth and configuration

- **Where the server reads credentials:** `<CROW_HOME>/bundles/workspace/.env`, lazily on each request (a cached parse re-read when the file's mtime changes), through `servers/gateway/bundle-env-codec.js` `parseEnvText`. This is the `bundles/browser/server/instance.js` pattern, enforced by `tests/bundle-env-readers.test.js`.
- **Keys read:**
  - `WORKSPACE_BOT_APP_PASSWORD` (bot auth);
  - `WORKSPACE_ONLYOFFICE_JWT_SECRET` (command service);
  - `WORKSPACE_PUBLIC_HOST` + `WORKSPACE_NC_SERVE_PORT` (to build `web_url` and the `Host` header);
  - `WORKSPACE_BOOTSTRAP_DONE`.
- **Before setup finishes:** until `WORKSPACE_BOOTSTRAP_DONE=1` and the app password exist, every tool returns `code:"not_ready"`, naming the bootstrap command. Bootstrap writes the password after MCP registration, so a lazy read is required.
- **Endpoints:** Nextcloud at `http://127.0.0.1:3070` and ONLYOFFICE at `http://127.0.0.1:3071`. No `Host` override: DAV over loopback answers 207 with or without one (verified 2026-10-03), and `MOVE`/`COPY` `Destination` URLs use the same base. Both are loopback ports fixed by the W1 compose. Overridable by `WORKSPACE_NC_INTERNAL_URL` / `WORKSPACE_OO_INTERNAL_URL` in `process.env` for tests.
- **Secrets never appear in argv, mcp-addons.json, logs, tool results or errors.** The manifest's `server.envKeys` is empty.
- **Two gateway product fixes are required** (the "fix the product, not the instance" rule):
  1. **Secrets leak into mcp-addons.json.** `applyEnvToMcpAddons` (`servers/gateway/routes/bundles.js:1129`) copies every Configure-submitted value into the MCP entry, written without mode 600. With a workspace MCP entry, a Configure save would put `WORKSPACE_*` secrets there in plaintext. The fix: skip keys the manifest marks `secret: true` or `generate`, unless they're listed in `server.envKeys`.
  2. **Existing installs never get the server registered.** `refreshVersionedBundle` (`bundles.js:685`) copies the new `server/` on a version bump but **never writes mcp-addons.json**. So crow's installed Workspace would get the code and never register the server. The fix: after a successful refresh, if the repo manifest declares `server` and mcp-addons.json has no entry for that id, write the same entry install writes (`bundles.js:2189-2219`) and log "needs restart". Existing entries are never rewritten.

## 7. Security

### 7.1 Paths and input

- Every DAV URL is built **only** by `nc/paths.js` from `(root, segments)`:
  - `path` is NFC-normalized and split on `/` (a single leading `/` means the drive root, so `/Shared with Crow/x.docx` works);
  - each segment must be non-empty, not `.`/`..`, ≤ 255 bytes, and free of NUL, control characters and `\`;
  - segments are `encodeURIComponent`-encoded and joined under `/remote.php/dav/files/crow-bot/`.
- URLs (`scheme:`), backslashes and `.`/`..` segments are rejected before any request. A literal `%2e%2e` is just a name: it is re-encoded as `%252e%252e` and can never become `..`.
- `file_id` must be a positive integer and is resolved via `SEARCH` on `oc:fileid` within crow-bot's root.
- Image paths, `new_parent` and `folder` go through the same function.
- XML request bodies escape every interpolated value. Responses are parsed with xmldom; no regex parsing of multistatus.
- **Scope:** crow-bot sees only what is shared with it (D5). Other users' DAV paths return an **empty 207**, not 403 (W1 finding). The client treats an empty multistatus for a requested resource as `not_found` and never as success.

### 7.2 Size, zip and parsing caps

| Limit | Value |
|---|---|
| Edit/read download | ≤ 50 MB |
| Upload content | ≤ 10 MB decoded |
| Images | ≤ 5 MB |
| `read_file` output | ≤ 1,000,000 chars |
| Sheet reads | ≤ 50,000 cells per call |
| Zip entries | ≤ 5,000 |
| Total uncompressed | ≤ 200 MB |
| Per-entry compression ratio | ≤ 200:1 |

- The zip limits are checked from the central directory **before** inflating.
- XML parts > 30 MB are refused.
- xmldom runs with no external entity resolution. `<!DOCTYPE` in any OOXML part → reject (`malformed_document`).

### 7.3 Never

- Never link shares.
- Never admin endpoints.
- Never unlock another person's lock.
- Never write outside crow-bot's DAV root.
- Never log file contents or credentials. Logs carry the tool name, file id, status code and duration.

ONLYOFFICE `drop` is only sent for a key crow-bot fetched through its own access-checked config call, and only on `if_open:"proceed"`.

## 8. Quick edit (Office panel)

- **What it is:** a second view of the existing Office panel, `/dashboard/workspace?view=quick`, with tabs **Setup | Quick edit**.
  - Server-rendered HTML forms with **no client script**, so the template-literal/no-backtick panel rule is moot.
  - Phone-first: one column, ≥ 44 px tap targets, en/es strings with the existing parity test.
- **Browse:** folders and office files shared with crow-bot (exactly the bot's view).
- **.docx:** a numbered list of body paragraphs (50 per page; headings bold). Tap **Edit** → a textarea with the paragraph's plain text → **Save**. Under the hood this is `rewrite_passages` on that paragraph index: the paragraph style and first-run formatting are kept.
- **.xlsx:** pick a tab; a grid of formatted values (first 100 rows × columns A–Z, paged). Tap a cell → one input (a leading `=` makes a formula) → **Save**, through `ws_sheets_write` semantics.
- **.pptx:** slides with their text shapes. Tap a shape → textarea → **Save**, through `edit_text` semantics.
- **Every save:**
  - goes through `withFileWrite` with `wait_s: 10` (a phone shouldn't hang for 30 s);
  - is labeled `Quick edit: <what changed>`;
  - lands on a confirmation with an **Undo** button (carrying the `version_id`) and the file's last 20 versions, each with **Restore**.
  - If the file is open, the page says "Open in the editor by Dayane" and offers **Try again** and **Save anyway (closes their editor; their typing is saved first)**. The second re-posts with `if_open=proceed`.
- **Auth and plumbing:**
  - Forms POST to panel routes `/api/workspace/quick/{save,undo,restore}`, behind `authMiddleware` + `csrfMiddleware` (the phone-bundle pattern, `bundles/phone/panel/routes.js:96-112`). The hidden `_csrf` field is filled from `req.csrfToken`.
  - Responses are `303` redirects back to the view with a notice code (PRG).
  - It uses the dashboard session; there is no separate Workspace login.
  - Writes are made **as crow-bot** (the only Workspace credential Crow holds), so Quick edit can touch only what is shared with Crow, which the page states.
- **Not in Quick edit:** layout, styles, inserting tables/images, creating files. Those stay in ONLYOFFICE on a desktop, or with the bot.

## 9. Skill

`bundles/workspace/skills/workspace.md` (frontmatter `name/description/triggers/tools`, listed in `manifest.skills`). It teaches bots:
- **Find before you touch:** `ws_drive_search` / `list_folder`, then `ws_docs_get_structure` or `ws_sheets_get_tabs` before editing.
- **Prefer the narrowest tool:** find_replace > rewrite_passages > replace_section. No full rewrites.
- **Report every write's `version_id`** in the reply ("say 'undo' to revert"). On "undo", call `ws_undo_last_change` with it.
- **On `open_in_editor`:** tell the user who has it open and ask "go ahead anyway (their editor will reload; their typing is saved first) or try later?". Call again with `if_open:"proceed"` only on a clear yes. On `locked_by_person` / `stale_editor_lock`, relay the message; never retry in a loop.
- **Confirm intent** before destructive tools.
- **Sheets:** after writing formulas, read back with `FORMULA` (cached values are stale until the file is opened).
- **Calendar:** all-day = `YYYY-MM-DD`. Times need an offset. Ask which calendar if more than one is writable. Kitchen's Menu is `Menu`.
- **Scope:** the bot sees only what's shared with "Crow bot". If something is missing, ask the user to share it.

The parts of `skills/google-workspace.md` that still apply (the daily-briefing / meeting-prep workflow ideas) are ported. Its false claims (Gmail send, free-slot finding) are not. The deprecated `bundles/nextcloud/skills/nextcloud.md` points to the new skill.

## 10. Testing

### 10.1 Hermetic (CI, `npm test`)

- **`tests/helpers/workspace-fake-nextcloud.js`:** one `http.createServer` on port 0 that emulates:
  - WebDAV files (PROPFIND, GET, PUT with `If-Match`/`If-None-Match`, MKCOL, MOVE, COPY, DELETE, SEARCH by name and fileid);
  - lock props, scripted per file, with `423` enforcement;
  - versions (list, PROPPATCH label, restore);
  - OCS shares (create/list) and the ONLYOFFICE OCS config;
  - `downloadas` (returns fixed bytes);
  - the empty-207 behavior for foreign paths;
  - CalDAV/CardDAV (home PROPFIND, calendar-query with time-range, addressbook-query, PUT/DELETE with etags).

  A second handler fakes the **ONLYOFFICE command service** (JWT checked, `info`/`drop` driven by a scripted session table).
- **OOXML fixtures** in `tests/fixtures/workspace/`:
  - `rich.docx`, `rich.xlsx` and `rich.pptx` from the committed fixture script. They include headings, lists, a table, bold/italic/link runs, a comment thread, an image, header/footer, formulas, number formats, a chart, merged cells, frozen panes, layouts and notes.
  - `oo-rich.*`: the same files after an open/edit/save round in ONLYOFFICE, captured in Task 1, so the editors are tested against ONLYOFFICE-written XML.
- **"Formatting survives" assertions** (`tests/helpers/ooxml-assert.js`):
  - `assertOnlyPartsChanged(before, after, allowedParts)`: every other zip entry is byte-identical.
  - `assertSiblingsUnchanged(beforeXml, afterXml, editedIndexes)`: every untouched paragraph/row/shape serializes identically.
  - `rPr` of an edited run is preserved.
  - Each edit result re-opens with xmldom, has no `<!DOCTYPE`, and is valid zip.
  - In addition, one test per format runs **LibreOffice headless** (`soffice --convert-to pdf`) on the edited fixture when `soffice` is on PATH (crow has it). It is skipped with a logged reason in CI, where it isn't installed. This is a smoke check that the file still opens.
- **Protocol tests:**
  - lock wait then success;
  - wait timeout → `open_in_editor` with names;
  - proceed → drop → unlock → write;
  - drop doesn't release → `could_not_close_editor`;
  - user lock → `locked_by_person` and `proceed` refused;
  - stale lock;
  - `412` retry once, then `changed_concurrently`;
  - zero-change → no PUT;
  - version labels written;
  - undo success and undo refused `changed_since`;
  - writes to the same file spaced ≥ 1.1 s (fake clock).
- **Security tests:**
  - traversal/encoded-traversal/absolute/NUL paths rejected with **no request made**;
  - empty 207 → `not_found`;
  - zip bomb and DOCTYPE refused;
  - no secret string in any tool result, error or captured log;
  - mcp-addons secret skip;
  - refresh registers a missing server entry and leaves existing ones alone.
- **MCP surface test:** the registered tool list equals the §4 catalog exactly (74 names), every description ≤ 1024 chars, every destructive tool's description contains "confirm".
- **Quick edit tests:**
  - server-rendered pages (en/es parity, no secrets, CSRF field present, escaping);
  - routes with a fake session + CSRF: save → 303 + version, open-file → choice page, proceed, undo.

### 10.2 Live acceptance on crow (Task 14)

Runs as crow-bot against the real Workspace, after merge and deploy. Steps marked **[KEVIN]** need him:
- **[KEVIN]** shares Menu (edit) and an address book with crow-bot, and creates a `W2 acceptance` folder shared with crow-bot (edit).
- One scripted call per tool family through the gateway's `crow_tools`.
- A lock run: **[KEVIN]** keeps a doc open on the laptop and types. The bot write returns `open_in_editor` naming Kevin within ~30 s. On proceed, Kevin's editor shows the disconnect/reload, his typing is in a version, and the bot's change is on top. Then undo.
- Quick edit from Kevin's phone **[KEVIN]**.
- A Menu event created by the bot shows on Kevin's phone **[KEVIN]**. Dayane's phone is checked with the W1 deferred items.

## 11. Risks

| Risk | Mitigation |
|---|---|
| ONLYOFFICE `drop` might not release the lock in 30 s, or might lose typing | Task 1 measures it before code. Failure → `could_not_close_editor` (no escalation). The ONLYOFFICE session save happens before unlock by construction (`CallbackController` saves inside the lock scope). |
| ONLYOFFICE rewrites XML in ways the editors don't expect (e.g. `w14`/`w15` extensions, `mc:AlternateContent`) | The `oo-rich.*` fixtures. Unknown elements are preserved, never dropped (DOM edits are local). |
| Formula cached values are stale after bot writes | `fullCalcOnLoad`, `stale_formulas` flag, skill guidance. A recalc engine (e.g. HyperFormula) is rejected: GPL/commercial license. |
| Version expiry removes an undo point | Labeled versions (Task 1 verifies exemption). Otherwise R-EXPIRY: undo reports `version_gone` honestly. |
| 74 tools enlarge AI chat's tool list | Descriptions ≤ 120 useful chars up front (the system prompt truncates there). Follow-up: a per-bot tool allowlist if the prompt budget bites. |
| `files_lock` app locks never expire | `stale_editor_lock` path + owner-unlock instructions. Follow-up: Kevin may set the files_lock timeout. |
| crow-bot's view depends on household sharing | The skill + Quick edit say so. Acceptance steps share Menu/contacts. |
| Calendar recurring-instance edits (v1 updates the master only) | Documented in the tool description. Follow-up W2.1: `RECURRENCE-ID` overrides. |

## 12. Follow-ups (out of W2)

- **W3 Google import:** reuses `ws_drive_upload_file` + templates; the importer needs a bulk path.
- **W4 Forms:** `ws_forms_*` over the Nextcloud Forms API, responses → a sheet via `ws_sheets_append`.
- **W5 Dashboards.**
- **Kitchen** (Appendix A) consumes `ws_cal_*` (Menu) and `ws_sheets_*` (recipe index).
- Later: live AI typing inside an open editor (deferred by D6), recurring-instance edits, a per-bot tool allowlist, and Nextcloud sidebar comments.
