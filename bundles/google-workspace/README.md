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
from upstream in its packaging — these READMEs are Crow's own and the test
fixtures are scrubbed of personal data — and in a small set of fixes carried on
top: native Docs/Sheets/Slides conversion on upload, markdown links rendered as
real hyperlinks (inside table cells too, and only for http/https/mailto — any
other scheme stays plain text), table-aware Docs edits, a section replacement
that can end in a table, and the invite/mail/folder guards below.

## What it can do

| Family | Examples |
|---|---|
| Docs | read a doc or one section, append markdown, insert at a heading, find/replace, read and answer comments |
| Sheets | list and create, read (formulas included), write and append, tabs, number and visual formatting |
| Slides | read a deck, create one, add or reorder slides, text and image boxes, export |
| Drive | search, list, copy, move, rename, trash, share, export, read raw file content |
| Gmail | search and read threads, draft replies, labels and filters — sending is opt-in, to yourself only |
| Calendar | list calendars and events, create events, respond to invites |
| Apps Script | read, edit and run a project's script source (edit/run refused while `GWS_OUTBOUND_GUARD` is on) |
| Forms | read a form's structure, add or edit questions in place; link responses to a sheet through the shim |
| BigQuery | run SQL, sync a Sheet range into a table, list datasets and tables |
| Looker Studio | read-only: find assets and audit their sharing |

The guardrails are in the server, not in the prompt: there is no
"replace the whole document" tool (edits are surgical), and the only tool that
sends mail is restricted to an allowlist that is **empty by default** —
everything else writes drafts. The actions that make *Google* write to someone
else are guarded too; see "What leaves the account" below.

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
Optional knobs: `GWS_FILES_DIR` (the folder the tools that read or write a local
file may use — see "Local files" below), `GMAIL_SEND_TO_SELF_ALLOWLIST`
(comma-separated; empty keeps sending off), `GOOGLE_BIGQUERY_PROJECT`,
`GDOCS_DEFAULT_FONT`, `GWS_FORMS_SHIM_SCRIPT_ID`, `GWS_OAUTH_SCOPES`,
`GWS_CALENDAR_NO_INVITES`, `GWS_OUTBOUND_GUARD`, `GWS_OUTBOUND_ALLOWLIST`.

## What leaves the account

Five channels can make Google deliver something to an address the assistant
chose instead of you, leave your content somewhere someone else can read it, or
run code that can. Two switches decide what may happen:

- **Calendar** — an event's guests and the calendar it is written to, and
  replying to an invitation (that emails the organizer). A `calendar_id` other
  than `primary` has its own owners to notify — a calendar id looks like an
  address (`team@group.example.net`) — so it is checked like one;
- **Drive** — a share, and an ownership transfer. Granting someone access *is*
  the outbound effect; the "shared with you" email (`notify=true`) only adds
  Google's notification on top, so with the guard on the grantee is checked
  whether or not a mail would be sent;
- **Drive folders** — what a write lands *in*: `gdrive_upload_file`,
  `gdrive_copy_file`, `gdrive_move_file`, `gdrive_create_folder`,
  `gdrive_create_shortcut`, and the `folder_id` of `sheets_create`,
  `gdocs_create`, `gslides_create` and `forms_create`. Nothing is emailed, but
  the new file is readable by everyone who can read that folder. With the guard
  on, the destination folder's owners and permissions are read first (one Drive
  call) and the write is refused if anyone on them is off the allowlist, if the
  folder has an anyone-with-the-link or whole-domain permission, or if that check
  cannot be made at all. Your own address always counts as allowed, and a write
  with no folder (My Drive root) needs no check;
- **Gmail** — a filter's forward address;
- **Apps Script** — `apps_script_update_file`, `apps_script_update_content` and
  `apps_script_run`. Pushed script can send mail (`MailApp`, `GmailApp`), share
  Drive files, or call any API the token can reach, and this server cannot
  inspect what it will do. With the guard on, these three tools are refused
  outright, and so is a caller-supplied `shim_script_id` for
  `forms_set_destination` other than the one configured in
  `GWS_FORMS_SHIM_SCRIPT_ID`. `apps_script_get_content` (read-only) still works.

| Setting | Default | Effect |
|---|---|---|
| `GWS_CALENDAR_NO_INVITES` | off | Events go on the `primary` calendar only: any other `calendar_id` is refused (another calendar has its own owner to notify), guests are refused, Google is never asked to email anyone, and replying to an invitation is refused. |
| `GWS_OUTBOUND_GUARD` | **off** | When on, every channel above is refused unless its recipient (or, for a folder write, every owner and grantee of the destination folder) is on `GWS_OUTBOUND_ALLOWLIST`, and no request is made to Google at all. A local-image `gdocs_insert_image` is refused, a Drive-hosted one must already be shared anyone-with-the-link (this server never adds an `anyone`/`domain` permission while the guard is on), and Apps Script's write/run tools are refused regardless of any address. |
| `GWS_OUTBOUND_ALLOWLIST` | empty | Addresses and domains that may be written to, e.g. `you@example.com,example.org` (a domain covers exactly that domain, no subdomains). Commas separate entries in the Extensions form; a semicolon or a space also works if you set the variable outside it. Only read while the guard is on; empty then means nothing may be sent (and only folders of your own may be written to). |

A recipient has to be **one** well-formed address: a single `@`, ASCII only, no
spaces and none of `, ; < > " ' ( )`. A value that is really two addresses
(`x@evil.com,y@example.com`), a display-name form (`Name <x@example.com>`) or two
`@`s is refused before the allowlist is consulted — it can never be matched by
the half of it that happens to be allowed.

A folder is the same question asked of a whole list: it is written to only if
every owner and everyone it is shared with is on the allowlist, and it is
refused outright when it carries an `anyone` (anyone with the link) or `domain`
(whole Workspace domain) permission. Your own address is always allowed — a
folder you own is shared with you — and it is found once through Drive's own
account endpoint and then remembered for the life of the server process (so a
change of signed-in account is noticed only after a restart); when that lookup
cannot answer, only the allowlist lets a folder through. A folder whose sharing
cannot be read is refused rather than assumed safe, and so is a folder that
reports no owner at all. Nothing is written in any of these cases, and the
refusal names the folder and what is wrong with it.

A folder in a **Shared Drive** is judged on the drive's *effective* permissions
— `permissions().list`, which includes the members the folder inherits from the
drive, since an item there has no owner of its own and its own permission list
does not mention them — under the same rule, and it is refused if that listing
fails or comes back empty. A file whose content is replaced in place
(`gdrive_upload_new_version`) gets the same check on its own sharing, because the
new content is readable by everyone who can already read that file.

`gdocs_insert_image` is the one tool that used to *make* a file public just long
enough to work: the Docs API only fetches an image it can read anonymously, so
the insert shared the file anyone-with-link and then un-shared it. `anyone` (and
`domain`) permissions are now created **only with the guard off**. With the guard
on, a **local** image is refused outright (it would have to be published to be
uploaded and embedded at all), and a Drive-hosted image is embedded only if it is
**already** shared anyone-with-the-link — put it in Drive, share it exactly as
you intend, and pass its file id. An image that is not shared that way (or whose
sharing cannot be read) is refused with nothing inserted and nothing changed:
under the outbound guard, images must already be shared for embedding; Crow won't
make a file public. In every mode the temporary grant is revoked by the exact
permission id Drive returned for it, and a revoke that fails is reported as a
**failure** naming the file that is still public — never as a success.

The guard ships **off** so an existing install keeps behaving exactly as before;
it is meant for an assistant that also reads untrusted mail, where a crafted
message could otherwise talk it into inviting or forwarding to a stranger.
Turning it on needs the list filled in (or nothing can be sent at all, and only
folders of your own can be written to).

### What the guard does not cover

It walls off the channels that *make Google contact someone* or *put a file
where someone else can read it*; it is not a sandbox on the account. In
particular it does **not** cover:

- **edits and comments on files others own** — a collaborator's file can be
  changed, or a comment added, with no mail-like call of the kind above;
- **who can read the folder later** — the destination is checked at the moment
  of the write; anyone granted access to that folder afterwards — including a
  member added to its Shared Drive afterwards — can read what landed there.

If that matters for an account, narrow what the account can do with
`GWS_OAUTH_SCOPES` (below) rather than relying on the guard alone.

`GWS_OAUTH_SCOPES` narrows what the server asks Google for: unset requests the
full set, and setting it (e.g. `gmail.readonly,gmail.compose,calendar.events`)
requests only those — worth doing for an account an assistant should not be able
to delete things with. Every name is checked against the scopes this server knows
(a short name like `gmail.compose`, or the full
`https://www.googleapis.com/auth/gmail.compose` URL); an unknown name is a
startup error naming the bad entry, rather than a scope that lands in the refresh
and fails later as a confusing "not authenticated". The narrowing applies at the
**next token refresh** (and at the authorize step): the refresh token already on
disk keeps the full grant it was issued with, so removing a scope here does not
take the permission away from Google's grant — revoke the app's access in your
Google account for that, then authorize again.

## Local files: the files folder

Six tools take a **local path**: `gdrive_upload_file` and
`gdrive_upload_new_version` (reading a file to upload), `gdrive_download_file`,
`gdrive_export` and `gslides_export` (writing a file out), and
`gdocs_insert_image` when `image` is a local file rather than a Drive id. A path
from a caller is a capability — an assistant that also reads untrusted mail can
be talked into uploading `~/.config/google-workspace-mcp/token.json` to Drive and
sharing it — so it is decided in one place (`local_paths.py`) and nowhere else.

**`GWS_FILES_DIR`** is the one folder of yours those tools may use:

- set it, and every path must land **strictly inside** it after symlinks are
  resolved; a relative path is relative to it, a leading `~` is your home. `..`,
  an absolute path elsewhere and a symlink pointing out are all refused;
- leave it empty and the outbound guard decides: with `GWS_OUTBOUND_GUARD` on,
  **every** local path is refused ("set a files folder"); with the guard off, an
  install that upgrades keeps behaving as it did — any path it is handed — so
  nothing breaks until you name a folder;
- downloads and exports are **created**, never overwritten: a target that
  already exists, or is a symlink, is refused (give a new name); files are created
  at mode 0600. A default name is built from the Google id with every character
  outside `[A-Za-z0-9._-]` replaced, so an id can never smuggle in a path
  separator. The default location is the files folder when it is set, and `/tmp`
  only for an install with neither a folder nor the guard;
- a local image for `gdocs_insert_image` must really be a PNG, JPEG, GIF or WebP
  (its first bytes are checked), not just a file with an image-looking name.

**Refused always, whatever else is set** — guard on or off, folder set or not:
anything inside the **Google sign-in folder** (the folders holding
`GOOGLE_TOKEN_FILE` and `GOOGLE_CREDENTIALS_FILE`, and any
`~/.config/google-workspace-mcp*` sibling), the token and credentials files
themselves, `~/.ssh` and `~/.gnupg`. The comparison is on the real path, so a
symlink pointing into them is refused too, and if those folders cannot be
resolved nothing local is allowed at all (it fails closed). A refused call makes
no Google request: the path is decided before any client is built.

## Inside Crow's add-on wall

The bundle declares `"sandbox": { "network": "internet", "files": {
"write": ["env:GWS_FILES_DIR"], "oauthDir": "env:GOOGLE_TOKEN_FILE" } }`:

- **network `internet`** — HTTPS to Google's public APIs and nothing else, no
  container, no host port;
- **one file grant** — the *folder* holding `GOOGLE_TOKEN_FILE`, read-write.
  An OAuth refresh writes a temp file and renames it, so the server needs its
  own folder writable. That folder is Crow's reviewed first-party grant
  (`ADDON_TOKEN_DIRS` in `servers/shared/addon-doors.js`) and applies to this
  add-on only;
- **the files folder** — `GWS_FILES_DIR`, when you name one, is bound read-write
  as well, so uploads can be read from it and downloads and exports written into
  it. Unset, no files folder is bound: with the guard off the local-path tools
  still accept any path they are handed (how they behaved before 1.2.0), and with
  the guard on every local path is refused.

Keep `credentials.json` in the same folder as the token so the server can read
it, and point both paths at `~/.config/google-workspace-mcp/` rather than at
your home folder — a default path is never bound, only one you typed.

## Requirements

`uv`, installed system-wide so it is root-owned (e.g. `/usr/local/bin/uv`);
Crow refuses to install the bundle until it is. `uv` brings its own Python.

## License

MIT — see `LICENSE` for the vendored upstream's copyright notice.