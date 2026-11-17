# Google Workspace

A stdio MCP server that gives the assistant tools on **your own** Google
Workspace account: Docs, Sheets, Slides, Drive, Gmail, Calendar, Apps Script,
Forms, BigQuery and Looker Studio. It runs on this computer as a `uv` project
from the installed copy — no container and no port — and it signs in with your
own OAuth client, so nothing is proxied through a third party.

The source here is the upstream MIT project of the same name, vendored from it
(see `LICENSE`): `google_workspace_mcp/` is the server, `apps-script-shim/` is
an optional Apps Script helper for one Forms tool, and `tests/` holds the
Python unit tests (`python3 -m unittest discover -s tests`). Crow's copy differs
from upstream in its packaging only: these READMEs are replaced with Crow's own
and the test fixtures are scrubbed of personal data.

## What it can do

| Family | Examples |
|---|---|
| Docs | read a doc or one section, append markdown, insert at a heading, find/replace, read and answer comments |
| Sheets | list and create, read (formulas included), write and append, tabs, number and visual formatting |
| Slides | read a deck, create one, add or reorder slides, text and image boxes, export |
| Drive | search, list, copy, move, rename, trash, share, export, read raw file content |
| Gmail | search and read threads, draft replies, labels and filters — sending is opt-in, to yourself only |
| Calendar | list calendars and events, create events, respond to invites |
| Apps Script | read, edit and run a project's script source |
| Forms | read a form's structure, add or edit questions in place; link responses to a sheet through the shim |
| BigQuery | run SQL, sync a Sheet range into a table, list datasets and tables |
| Looker Studio | read-only: find assets and audit their sharing |

The guardrails are in the server, not in the prompt: there is no
"replace the whole document" tool (edits are surgical), and the only tool that
sends mail is restricted to an allowlist that is **empty by default** —
everything else writes drafts.

## Setup

1. **In Google Cloud** (once): create or pick a project, enable the APIs you
   will use (Drive, Docs, Sheets, Slides, Gmail, Calendar, Apps Script, Forms,
   BigQuery, Looker Studio), then create a **Credentials → OAuth client ID** of
   type **Desktop app** and download its JSON.
2. **Put the JSON** in `~/.config/google-workspace-mcp/credentials.json` (or
   anywhere you like — you point the two paths below at it).
3. **Authorize once**, from the installed copy:

   ```bash
   cd ~/.crow/bundles/google-workspace
   uv run google-workspace-mcp-authorize            # opens a browser
   uv run google-workspace-mcp-authorize --manual   # copy-paste flow, no browser
   ```

   This writes `token.json` beside the credentials. It is a one-time step: the
   server refreshes the token itself from then on.
4. **Install the bundle** in Crow's Extensions page and fill in the two fields:
   `GOOGLE_CREDENTIALS_FILE` (the OAuth client JSON) and `GOOGLE_TOKEN_FILE`
   (the token the authorize step wrote).

Both are required and neither has a default, on purpose (see the wall section).
Optional knobs: `GMAIL_SEND_TO_SELF_ALLOWLIST` (comma-separated; empty keeps
sending off), `GOOGLE_BIGQUERY_PROJECT`, `GDOCS_DEFAULT_FONT`,
`GWS_FORMS_SHIM_SCRIPT_ID`.

## Inside Crow's add-on wall

The bundle declares `"sandbox": { "network": "internet", "files": {
"oauthDir": "env:GOOGLE_TOKEN_FILE" } }`:

- **network `internet`** — HTTPS to Google's public APIs and nothing else, no
  container, no host port;
- **one file grant** — the *folder* holding `GOOGLE_TOKEN_FILE`, read-write.
  An OAuth refresh writes a temp file and renames it, so the server needs its
  own folder writable. That folder is Crow's reviewed first-party grant
  (`ADDON_TOKEN_DIRS` in `servers/shared/addon-doors.js`) and applies to this
  add-on only.

Keep `credentials.json` in the same folder as the token so the server can read
it, and point both paths at `~/.config/google-workspace-mcp/` rather than at
your home folder — a default path is never bound, only one you typed.

## Requirements

`uv`, installed system-wide so it is root-owned (e.g. `/usr/local/bin/uv`);
Crow refuses to install the bundle until it is. `uv` brings its own Python.

## License

MIT — see `LICENSE` for the vendored upstream's copyright notice.