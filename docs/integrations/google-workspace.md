---
title: Google Workspace
---

# Google Workspace

Google Workspace is one of Crow's own add-ons (a bundle). It gives the assistant
tools on **your** Google account — Drive, Docs, Sheets, Slides, Gmail, Calendar,
Forms, Apps Script, BigQuery and Looker Studio — and it runs on your computer,
signing in with your own OAuth client. Nothing is proxied through a third party.

## What it can do

| Family | Examples |
|---|---|
| Docs | read a doc or one section, append markdown, insert at a heading, find and replace, read and answer comments |
| Sheets | list, create, read (formulas included), write, append, tabs, number and visual formatting |
| Slides | read a deck, create one, add or reorder slides, text and image boxes, export |
| Drive | search, list, copy, move, rename, trash, share, export, read raw file content |
| Gmail | search and read threads, draft replies, labels and filters — sending is opt-in, to yourself only |
| Calendar | list calendars and events, create events, respond to invites |
| Forms | read a form's questions, add or edit them in place, link answers to a sheet |
| Apps Script | read, edit and run a project's script (edit and run are refused while the outbound guard is on) |
| BigQuery | run SQL, sync a Sheet range into a table, list datasets and tables |
| Looker Studio | read-only: find assets and audit their sharing |

Two rules live in the server rather than in a prompt: there is no "replace the
whole document" tool (edits are surgical), and the only tool that sends mail is
limited to a list that is **empty until you fill it in** — everything else writes
drafts.

## Setup

### 1. Create the sign-in in Google Cloud (once)

1. Open the [Google Cloud Console](https://console.cloud.google.com/) and pick or create a project.
2. Under **APIs & Services → Library**, enable the APIs you will use: Drive, Docs, Sheets, Slides, Gmail, Calendar, Apps Script, Forms, BigQuery, Looker Studio.
3. Under **APIs & Services → Credentials**, choose **Create credentials → OAuth client ID**. If you are asked to set up the consent screen first, fill it in and add your own address under **Test users**.
4. Choose **Desktop app**, create it, then press **Download JSON**. That file is your `credentials.json`.

### 2. Put it where the add-on will look for it

Make one folder for the sign-in and keep both files in it:

```bash
mkdir -p ~/.config/google-workspace-mcp
mv ~/Downloads/client_secret_*.json ~/.config/google-workspace-mcp/credentials.json
```

### 3. Install the add-on

In **Crow's Nest → Extensions**, find **Google Workspace** and install it. Two
fields are required:

| Field | What to put there |
|---|---|
| `GOOGLE_CREDENTIALS_FILE` | the `credentials.json` you just moved, e.g. `~/.config/google-workspace-mcp/credentials.json` |
| `GOOGLE_TOKEN_FILE` | where the sign-in token will live, e.g. `~/.config/google-workspace-mcp/token.json` |

Point both at `~/.config/google-workspace-mcp/`: the folder holding the token
is the one folder this add-on may write for its sign-in, and a default path is
never bound — only one you typed.

### 4. Authorize once, in your own terminal

The first sign-in happens outside Crow, in your own terminal, so the add-on never
gets a browser or a consent prompt of its own. From the installed copy:

```bash
cd ~/.crow/bundles/google-workspace
uv run google-workspace-mcp-authorize            # opens a browser
uv run google-workspace-mcp-authorize --manual   # copy-paste flow, no browser
```

The command reads `GOOGLE_CREDENTIALS_FILE` and `GOOGLE_TOKEN_FILE` from the
shell it runs in, not from the Extensions form, and it uses that folder by
default (`~/.config/google-workspace-mcp/credentials.json` and
`~/.config/google-workspace-mcp/token.json`). If you chose other paths in step 3,
run `export GOOGLE_CREDENTIALS_FILE=… GOOGLE_TOKEN_FILE=…` in the same terminal
first.

Sign in with your Google account and grant the scopes. This writes `token.json`
beside the credentials. It is a one-time step: the server refreshes the token
itself from then on.

### 5. Turn it on

In Extensions, enable the add-on. `uv` must be installed system-wide — Crow
refuses to install the bundle until it is — and `uv` brings its own Python.

## Optional settings

Every one of these is optional. The first column is the field name in the
Extensions form.

| Setting | What it does |
|---|---|
| `GOOGLE_BIGQUERY_PROJECT` | The Google Cloud project id the BigQuery tools use when a call names none. |
| `GDOCS_DEFAULT_FONT` | Font for text the Docs writing tools insert (e.g. `Arial`); empty keeps the document's own default. |
| `GMAIL_SEND_TO_SELF_ALLOWLIST` | Comma-separated addresses the one sending tool may write to; empty (the default) keeps sending off and everything else stays a draft. |
| `GWS_FORMS_SHIM_SCRIPT_ID` | The Apps Script project id for the Forms shim (deployment steps in the bundle's `apps-script-shim/`); unset, the tool returns those steps instead of failing. |
| `GWS_CALENDAR_NO_INVITES` | On: events go on your own `primary` calendar only, no guests, Google is never asked to email anyone, and replying to an invitation is refused. |
| `GWS_OAUTH_SCOPES` | Narrows what the server asks Google for (e.g. `gmail.compose,drive.file`); unset asks for the full set. Changing it means authorizing again. |
| `GWS_OUTBOUND_GUARD` | Off unless set. On: every action that makes Google contact someone is refused unless its address is on `GWS_OUTBOUND_ALLOWLIST` (see below). |
| `GWS_OUTBOUND_ALLOWLIST` | Addresses and domains that may be written to, e.g. `you@example.com,example.org`; read only while the guard is on, and empty then sends nothing. |
| `GWS_FILES_DIR` | The one folder the tools that read or write a local file may use; empty accepts any path except the sign-in folder and the operator's credential folders and files (`~/.ssh`, `~/.gnupg`, `~/.config/gcloud`, `~/.aws`, `~/.azure`, `~/.kube`, `~/.config/gh`, `~/.terraform.d`, and the files `~/.docker/config.json`, `~/.netrc`, `~/.npmrc`, `~/.pgpass`, `~/.config/containers/auth.json`) — unless the guard is on, which then refuses every local file. |

## Inside the add-on wall

Crow can run the add-on inside its [add-on wall](../architecture/addon-walls.md).
Walled, it can reach exactly three things:

- **the internet over HTTPS** — Google's public APIs and nothing else. No
  container, no port on this computer;
- **its sign-in folder, read-write** — the *folder* holding `GOOGLE_TOKEN_FILE`.
  A token refresh writes a temporary file there and then renames it, so the
  folder itself has to be writable. That folder is a reviewed, first-party grant
  (`ADDON_TOKEN_DIRS` in Crow's own code): one exact folder, for this add-on only;
- **the files folder** — `GWS_FILES_DIR`, read-write, when you name one. Unset,
  no files folder is bound at all.

**First-time authorization stays outside the wall on purpose.** You run the
authorize step in your own terminal (step 4 above), so the add-on never gets a
browser or a consent prompt of its own; inside the wall it only ever refreshes
the token it was given.

### The outbound guard: what it covers

The actions that make *Google* write to somebody else are decided before they
leave. With `GWS_OUTBOUND_GUARD` on, each of them is refused unless its recipient
is on `GWS_OUTBOUND_ALLOWLIST` — and refusing sends nothing and asks Google for
nothing:

- **Calendar** — an event's guests and the calendar it is written to, and
  replying to an invitation (that emails the organizer). A `calendar_id` other
  than `primary` has its own owners to notify, and a calendar id looks like an
  address, so it is checked like one.
- **Drive** — a share and an ownership transfer. Granting someone access *is*
  the outbound effect, and the "shared with you" mail only adds Google's
  notification on top, so the grantee is checked whether or not a mail would be
  sent.
- **Drive folders** — what a write lands *in*: upload, copy, move, create
  folder, create shortcut, and the target folder of a new sheet, doc, deck or
  form. Nothing is emailed, but the new file is readable by everyone who can read
  that folder, so the folder's owners and permissions are read first (one Drive
  call) and the write is refused if anyone on them is off the allowlist. Your own
  address always counts as allowed, and a write with no folder (My Drive root)
  needs no check. A folder shared by link (anyone with the link) or with a whole
  domain is always refused — no allowlist admits those — and a write is refused
  when the folder's sharing cannot be read at all.
- **Gmail** — a filter's forwarding address.
- **Apps Script** — writing or running a project's script is refused outright:
  pushed script can send mail, share Drive files or call any API the token can
  reach, and this server cannot see what it will do. Reading the script still
  works.

### What the guard does not cover

The guard walls off the channels that make Google contact someone or put a file
where someone else can read it. It is not a sandbox on the account. In
particular it does **not** cover:

- **edits and comments on files other people own** — a collaborator's file can
  be changed, or a comment added, with no mail-like call of the kind above;
- **who can read the folder later** — the destination is checked at the moment
  of the write; anyone granted access to that folder afterwards (including a
  member added to its Shared Drive later) can read what landed there.

If that matters for an account, narrow what the account can do with
`GWS_OAUTH_SCOPES` rather than relying on the guard alone.

## Moving an existing install

An install made before this bundle existed still launches the old
`uvx --from git+…` server, and its folder is little more than a stub. A migration
script moves it onto the bundle. Run it from the gateway's own checkout. Stop the
gateway first (recommended): the script itself doesn't check, but a running
gateway could rewrite the same files.

```bash
node scripts/addon-sandbox/migrate-gws-firstparty.mjs --dry-run   # print the plan, change nothing
node scripts/addon-sandbox/migrate-gws-firstparty.mjs             # do it
```

- It refuses unless the checkout it copies from is the gateway's own: a real
  checkout, on `main`, with `bundles/google-workspace` clean. `--repo-root <path>`
  names a different checkout that passes the same three checks, so the script's
  own folder may be a worktree.
- It refuses unless the existing add-on entry already carries a value for both
  `GOOGLE_CREDENTIALS_FILE` and `GOOGLE_TOKEN_FILE` (set them in Extensions
  first); with either unset it refuses and changes nothing.
- It backs everything up first, under
  `<CROW_HOME>/addon-walls-migrate/google-workspace-<stamp>/`, copies the old
  install folder aside as
  `<CROW_HOME>/bundles/google-workspace.pre-firstparty-<stamp>`, then copies the
  repo bundle into `<CROW_HOME>/bundles/google-workspace` exactly as an install
  does. It turns no guard on and adds no setting of its own.
- `--dry-run` prints what it would back up, copy and write, and changes nothing.
- Exit codes: `0` done — migrated, already migrated, or a dry run printed; `1`
  refused or failed, with the Crow home as it was; `2` wrong usage; `3` an undo
  refused because the home changed since the migration.
- The first start afterwards builds the virtualenv, which takes a minute. To warm
  it yourself first, run `uv sync --frozen` in the installed folder with the
  environment the migrated entry carries:
  ```bash
  cd ~/.crow/bundles/google-workspace
  UV_PROJECT_ENVIRONMENT=~/.crow/data/google-workspace/.venv uv sync --frozen
  ```
  Both paths are the defaults: `CROW_HOME` and `CROW_DATA_DIR` move them, and the
  data folder is `<CROW_DATA_DIR>/google-workspace`, which defaults to
  `<CROW_HOME>/data/google-workspace`.
- To go back: `node scripts/addon-sandbox/migrate-gws-firstparty.mjs --undo`
  (newest backup) or `--undo <stamp>`. It puts the entry, the old folder and
  `installed.json` back byte for byte, and refuses with exit `3` when the home
  has changed since the migration; `--force` restores anyway, surgically. A
  consumed backup is renamed, never deleted.
- **Never run `migrate-linked --undo google-workspace`.** The migration renames
  the older `migrate-linked` backups to `*.superseded-by-firstparty.json`
  precisely so that undo cannot put a symlink into the tracked checkout back. Use
  the `--undo` above instead.

## Troubleshooting

### "Access blocked: this app's request is invalid"

Your OAuth consent screen probably does not list your Google address as a test
user. Add it under **APIs & Services → OAuth consent screen → Test users**.

### "uv: command not found"

Install `uv` system-wide first, then open a new terminal.

### The authorization flow does not complete

Make sure the OAuth client is of type **Desktop app**, not **Web application**.
Desktop apps use a local redirect for the callback.

### "not authenticated" after changing `GWS_OAUTH_SCOPES`

The token on disk keeps the grant it was issued with. Revoke the app's access in
your Google account, then run the authorize step again.