# Crow Workspace: design (overall + W1 Platform)

**Status:** spec written 2026-10-02 from an interactive brainstorm with Kevin. Overall plan and W1 are designed in detail; W2–W5 get their own brainstorm → spec → plan cycles.
**Origin:** phase 9 topic doc `kh0pp/crow-engineering` `backlog/2026-09-23-local-ai-office-suite.md`. It was pulled forward on 2026-10-02 because the Kitchen extension's design hit Google, and Kevin chose: "drop Google — start Crow Workspace first".

## 1. Purpose

A local, self-hosted replacement for the Google services Kevin's household depends on, running on crow:
- drive and documents;
- calendars and contacts that sync to both phones' normal apps;
- forms;
- dashboards.

The Crow assistant gets full control of it through a toolset at parity with the existing Google Workspace MCP. Nothing household-related has to leave hardware Kevin owns.

**Who it's for:** any Crow user, installed from the extension store. Kevin and Dayane's household is the first install.

**Success looks like:**
- Kevin and Dayane edit the same document from two devices.
- A "Menu" calendar shows on both phones' calendar apps.
- Crow's bot can read and edit their files and calendars, with every AI edit reversible.
- Nothing is reachable from the public internet.

## 2. Decisions (Kevin, 2026-10-02)

| # | Question | Decision |
|---|---|---|
| D1 | Scope (eventually) | Drive + Docs/Sheets/Slides, Calendar + Contacts, Forms, Dashboards |
| D2 | Platform | **Nextcloud** (files, sharing, CalDAV/CardDAV, Forms, accounts) + an office editor + a Crow toolset. Not oCIS, not all-Crow-built. |
| D3 | Editor | **ONLYOFFICE Docs** (Community Edition), OOXML-native |
| D4 | Storage | Nextcloud's own data directory as **plain files on crow's main NVMe** (285 GB free on 2026-10-02). Nightly backup to the 4 TB external drive. **Not** MinIO-as-primary (files would become opaque object ids). |
| D5 | Login | **Separate Nextcloud accounts** for Kevin (admin) and Dayane. Phones use per-device app passwords. Crow's bot gets its own account plus an app password. No SSO with Crow in v1. |
| D6 | How the AI edits | **Edits the saved file**, and every AI edit creates a Nextcloud version that can be rolled back. If the file is open in the editor (locked), the tool waits or asks; it never clobbers. Live AI typing in an open editor is deferred. |
| D7 | Toolset shape | **Mirror the Google Workspace MCP**: same tool names with a `ws_` prefix in place of `g`, the same behavior, and the same guardrails (no full-document replace; heading-style reset on insert; full comment pagination; atomic batch find/replace). |
| D8 | Google data | **Importer + coexistence.** A one-shot import of chosen Drive folders and calendars; Google keeps working side by side. |
| D9 | Forms | Nextcloud Forms. Responses can feed a spreadsheet in the drive. |
| D10 | Dashboards | Tool choice deferred to W5's own brainstorm (Metabase / Grafana / Superset / Evidence). |
| D11 | Exposure | Tailnet only, through Tailscale Serve HTTPS ports. **Never Funnel** (the network-exposure invariant). Dayane is a full tailnet member (decided 2026-09-30). |

## 3. Sub-projects and order

| # | Sub-project | Output | Depends on |
|---|---|---|---|
| **W1** | Platform | The `workspace` extension: Nextcloud + MariaDB + Redis + ONLYOFFICE + cron, accounts, apps, a phone setup page, backups. **This spec, §4.** | — |
| **W2** | Crow toolset | An MCP server with Drive/Docs/Sheets/Slides/Calendar/Contacts tools mirroring the Google MCP (D7), versioned edits (D6), and a lock check | W1 |
| **K** | Kitchen (resumes) | The Kitchen extension (Appendix A). The meal plan goes to a Workspace calendar, the recipe index to a Workspace spreadsheet. Then the "Grackle" Crow bot and Discord/Messages channels, OpenClaw retires, and grackle decommission W5 unblocks. | W2 |
| **W3** | Google import | Importer for chosen Drive folders (Docs→.docx, Sheets→.xlsx, Slides→.pptx) and calendars (ICS) | W2 |
| **W4** | Forms | Bot tools for creating forms and reading responses; responses → spreadsheet | W2 |
| **W5** | Dashboards | Pick the tool and build it | W2 |

Household finances (spending, budget, savings, debt goals) follows K and may use a Workspace spreadsheet.

**Critical path to retiring grackle:** W1 → W2 → K.

## 4. W1: Platform (detailed design)

### 4.1 Packaging
- **A new store extension, `workspace` ("Crow Workspace"), type `bundle`** with a compose file. It **supersedes** the existing `nextcloud` bundle. That bundle is not installed anywhere, ships `changeme` default DB passwords, and binds `127.0.0.1:8080`, which collides with LocalAI.
  - `nextcloud` stays in the registry only as a deprecated "connect to an existing Nextcloud over WebDAV" entry, with its compose removed.
  - Its insecure defaults are deleted, not carried forward.
- **Services**, all `restart: unless-stopped`, all published on `127.0.0.1` only:
  - `nextcloud` (official `nextcloud` image, apache variant), with the data dir bind-mounted from a host path (§4.4);
  - `nextcloud-db` (MariaDB 11, healthchecked);
  - `nextcloud-redis` (file locking + cache);
  - `onlyoffice` (`onlyoffice/documentserver`, JWT enabled);
  - `nextcloud-cron` (the same image running `cron.php` every 5 min; background jobs mode = cron).
- **Images:** pinned by tag at build time (no `latest`), and recorded in the manifest so image-freshness tooling can track them.
- **Host ports:** chosen at plan time after checking **all three registries**: `docs/developers/port-allocation.md`, every compose file, and live `ss -ltnp`. Also checked: `tailscale serve status`. The new ports are added to `port-allocation.md` (or `check-ports` fails CI).
- **Resources:** about 3–5 GB RAM, no GPU. The manifest declares `requires.min_ram_mb` and `min_disk_mb`.

### 4.2 Network and exposure
- Two Tailscale Serve HTTPS ports: one → Nextcloud, one → ONLYOFFICE. The browser loads the editor from the ONLYOFFICE origin, so it needs its own tailnet-reachable URL.
- **Nextcloud config:**
  - `trusted_domains` = the crow MagicDNS name;
  - `overwriteprotocol=https`, `overwritehost`/`overwrite.cli.url` = the Serve URL;
  - `trusted_proxies` = the local proxy address.
- **ONLYOFFICE:**
  - `JWT_ENABLED=true` with a generated secret, shared with Nextcloud's ONLYOFFICE connector;
  - the connector's internal URLs use the docker network (Nextcloud ↔ documentserver) so server-to-server callbacks never leave the host.
- **Nothing on Funnel** (port 443 public paths are untouched). `tests/auth-network.test.js` must still pass, and a public-internet probe of both Serve ports must fail.
- ufw: no new rules needed for Serve (it proxies to loopback). If a LAN path is ever wanted, that's a separate decision.

### 4.3 Install flow, with no hand-entered secrets
Applies the config-friction lesson (`~/crow-weekend-push/reports/config-friction-survey.md`).
- The installer **generates** every internal secret (DB root/user passwords, Redis password, ONLYOFFICE JWT secret, Nextcloud `instanceid`/`passwordsalt`/`secret` via first-run). They are written to the bundle's `.env` at **mode 600**.
- The only operator input is the **admin password**, typed once in the install form (never defaulted).
- **Post-install bootstrap**, an idempotent script run via `occ` inside the container:
  1. enable the apps `calendar`, `contacts`, `forms`, `onlyoffice`; set background jobs = cron; configure Redis locking;
  2. configure the ONLYOFFICE connector (document server URL, internal URLs, JWT secret) and make it the default editor for docx/xlsx/pptx (and the ODF formats);
  3. create a shared **"Menu"** calendar, owned by the admin and shareable;
  4. create the **Crow bot account** (`crow-bot`, not admin) and an app password for it, written to the bundle's secrets at 600. Folders and calendars are shared with `crow-bot` explicitly, so the bot reaches only what the household shares with it;
  5. create additional household accounts on request. Dayane's account is created during acceptance with a one-time password she changes at first login.
- Re-running the bootstrap is safe: each step checks existing state first.

### 4.4 Data location and backups
- **Data dir:** a host bind path on the main NVMe, under `~/.crow/workspace/` (holding `data/`, `db/` and `backups-staging/`), owned by the container uid. It is never on NTFS `/mnt/external` (no POSIX permissions there) and never on the full `/mnt/data`.
- **Nightly backup:** a user systemd timer at a quiet hour, registered in `~/CROW-SCHEDULE.md` as a standing automation:
  1. `occ maintenance:mode --on`;
  2. `mariadb-dump` (single-transaction);
  3. tar the data dir + config + bundle `.env` into one archive (tar keeps permissions; the archive itself is mode 600);
  4. `maintenance:mode --off`;
  5. copy to `/mnt/external/crow-workspace-backups/` and keep 14 days.
- Maintenance mode is held only for the dump + snapshot window. A trap guarantees `--off` on any failure, and the script's runtime is bounded by `timeout`.
- The archive contains secrets (the `.env`) and household documents. On NTFS it can't be 600, so **the archive is encrypted** with `gpg --symmetric` (AES256, already installed on crow; no new package), using a passphrase file stored at 600 under `~/.crow/workspace/`, which is also printed once for Kevin to keep offline before it's copied to `/mnt/external`.
- **Restore** is documented, and **tested once during W1 acceptance** into a scratch compose project.

### 4.5 Phone and laptop setup
A Workspace panel page in Crow (tailnet) with:
- the Nextcloud URL and how to make a per-device app password;
- **Android:** the Nextcloud app (files) + **DAVx⁵** (calendars/contacts into the stock apps), with the exact server URL to paste;
- **iPhone/Mac:** native CalDAV/CardDAV account setup;
- **Laptop:** the browser, optionally the Nextcloud desktop sync client;
- a note that everything works only while the device is on the tailnet.

### 4.6 Box schedule
W1's first start and any later upgrades are registered windows in `~/CROW-SCHEDULE.md`. Workspace uses no GPU and never touches model containers; its steady-state RAM is added to crow's capacity notes.

### 4.7 W1 acceptance
1. Install from the Extensions page on crow with only the admin password typed. `.env` is 600, and no `changeme`-style value exists anywhere.
2. Both Serve URLs load over the tailnet. Public probes of both fail. `auth-network` passes 21/21.
3. Kevin and Dayane open the same .docx in ONLYOFFICE from two devices and see each other's edits.
4. A "Menu" calendar event made on Kevin's phone (via DAVx⁵) appears on Dayane's phone.
5. `crow-bot` can see only what was shared with it (WebDAV PROPFIND on a non-shared folder → 404/403).
6. The backup runs, the encrypted archive lands on `/mnt/external`, and a scratch restore boots and shows the test document.
7. crow's model services and gateways are unaffected (health checks before and after).

## 5. W2 preview (own brainstorm)
- An MCP server inside the `workspace` bundle, so the bot needs no shell or file access:
  - WebDAV for files;
  - OCS for shares/versions/locks;
  - CalDAV/CardDAV for calendar/contacts;
  - doc/sheet/slide edits via OOXML libraries on the saved file;
  - ONLYOFFICE's conversion service for exports.
- Tool names mirror the Google MCP (D7). The guardrails carry over verbatim.
- **Every write:**
  1. check the Nextcloud lock (open in the editor → wait/ask);
  2. write through WebDAV, so Nextcloud makes a version;
  3. return the version id, so "undo the AI's change" is one call.
- Auth is `crow-bot` + its app password, from the bundle secrets.

## 6. Risks
- **ONLYOFFICE Community limits:** about 20 simultaneous connections and no mobile *editing* in the browser. Fine for a household; documented for other users.
- **RAM:** ONLYOFFICE is the heaviest piece (~2 GB+). It's acceptable alongside resident models; to be watched on crow's capacity notes.
- **Nextcloud upgrade cadence:** major upgrades must be stepped one version at a time. The `update.sh` path does that deliberately, never auto-update.
- **Tailnet-only:** phones off the tailnet see nothing. That's intended, and stated on the setup page.

## Appendix A: Kitchen extension (design PAUSED at section 2, resumes after W2)
Decisions so far (Kevin, 2026-10-02):
- **Household split:** **Kitchen** first (recipe book, meal planning, grocery list, pantry), then **Household finances** (spending from receipts and Spanish bank screenshots; goals for budget, savings, debt paydown; the fate of the 81 old expense rows is decided there). A clean redesign, not an OpenClaw port. The old pantry/grocery data is discarded; the **28 recipes are imported** (markdown → structured; unparseable lines kept verbatim; an import report is produced).
- **Architecture:** a Ramble-style bundle `kitchen`: `kitchen_*` tables created by `init-tables.js` in crow.db, an MCP tool server (~20 narrow tools, no shell, no file access), a phone-first panel (Recipes / This week / Groceries / Pantry), and markdown export.
- **Recipes:**
  - added by **link** (schema.org scrape), **telling the bot**, or the **panel editor** (not photo-of-card);
  - search + tags, servings scaling, **cook mode** (big text, step by step, screen wake lock), a dish photo;
  - a 30-day trash.
- **Meal plan:** the Kitchen panel, mirrored to the Workspace **"Menu" calendar** (was Google; changed by the pivot).
- **Grocery list:** a Crow panel list only (no external mirror; Google Keep's API is enterprise-only). "Build from this week's plan" merges duplicates and subtracts the pantry estimate.
- **Pantry:**
  - estimate-based: + when a grocery item is checked off; − the recipe ingredients (scaled) when a planned meal is **assumed cooked the day after**, with undo / "swapped for X";
  - staples with a low level, which become grocery suggestions;
  - corrections via the bot ("we're out of rice") or a "pantry check" walk-through; a last-confirmed timestamp; a change log with reasons.
- **Spreadsheet sync:** the meal plan + recipe index go **two-way** to a Workspace spreadsheet (was a Google Sheet).
- **Audience:** any Crow user. Dayane uses Kitchen through the bot (Discord + Crow Messages) until a later "shared household across instances" phase gives her a live panel in her own Crow.
- **Still to design:** section 2 (panel + tools, presented and pending approval), section 3 (Workspace sync, replacing the Google sync), section 4 (import, errors, testing).
