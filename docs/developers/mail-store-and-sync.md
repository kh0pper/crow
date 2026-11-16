# Mail store and sync

Crow can hold a person's IMAP/SMTP mailboxes in its own database, keep the last 90 days in sync, fetch
older mail on demand, and serve a private JSON API to the reader. The code lives in core, not in a
bundle: it has tables in `scripts/init-db.js`, rows in the instance-sync local-only list, a boot hook
and (later) a model role, so it cannot drift from its schema the way a bundle copy can.

This page describes the architecture, the feature flag, the tables, the provider-neutral adapter
contract, the one-instance-per-address rule, and the limits this first version accepts.

Nothing here is user-visible while `CROW_MAIL` is unset, and this plan adds **no MCP tool, no router
category and no nav link**: a bot has no mail surface, and the reader that consumes the API is a
hidden owner-only panel (see "The reader" below).

## Layout

| Path | Role |
| --- | --- |
| `servers/shared/mail-schema.js` | `MAIL_DDL`, `MAIL_TABLES` — the tables, indexes, FTS5 index and triggers |
| `scripts/migrations/<N>-mail-store.mjs` | the numbered migration (`rollbackSafe`) that applies the same DDL |
| `servers/gateway/mail/flag.js` | `mailEnabled(env)` — true only for `CROW_MAIL=1` |
| `servers/gateway/mail/errors.js` | `MailError`, `MAIL_ERROR_CODES`, `MAIL_ERROR_TEXT`, `toMailError` |
| `servers/gateway/mail/credentials.js` | the sealed-keychain reader, `authFor`, the rotation writer |
| `servers/gateway/mail/claims.js` | per-instance claims: which Crow holds an address |
| `servers/gateway/mail/parse.js` | `postal-mime` normalisation with hostile-input limits |
| `servers/gateway/mail/thread-key.js` | thread assignment and merge rules |
| `servers/gateway/mail/sanitize.js` | HTML sanitiser and the remote-image policy |
| `servers/gateway/mail/store/{accounts,messages}.js` | the stores (libsql-style `db.execute({sql,args})`) |
| `servers/gateway/mail/adapter/{interface,imap-smtp}.js` | the adapter contract and the imapflow/nodemailer implementation |
| `servers/gateway/mail/sync/{engine,supervisor}.js` | one pass over a mailbox, and the per-account loops |
| `servers/gateway/boot/mail-boot.js` | `startMailSync` / `stopMailSync` — the boot wiring |
| `servers/gateway/routes/mail-api*.js` | the owner-only JSON API under `/dashboard/mail/api` |

Data flows one way: the **supervisor** decides when an account syncs; the **engine** lists folders,
fetches UIDs and writes rows; the **store** owns every SQL statement; the **routes** read the store and
never talk to a server except through the supervisor's short-lived adapter (`withAdapter`).

## The flag

```bash
CROW_MAIL=1                 # the whole feature: boot, routes, later nav entries
CROW_DISABLE_MAIL_SYNC=1    # keep the routes, run no sync loop (a debugging / load-shedding switch)
```

- Read per use through `mailEnabled(env)`, so unsetting it makes the API answer 404 on the next
  request. A supervisor that is already running keeps syncing until the gateway restarts: the flag is
  read when the boot hook starts it, not on every pass.
- The API answers 404 for every route while it is unset, before a database client is opened.
- `startMailSync` builds no adapter, no credentials reader and no supervisor when the flag is unset, when
  the gateway runs `--no-auth` (a secondary loopback gateway is nobody's dashboard), or when sync is
  disabled.
- The tables are created regardless: the DDL is additive and idempotent, so turning the flag on later
  needs no migration run.

## Tables (local only, never synced)

`mail_accounts`, `mail_folders`, `mail_threads`, `mail_messages`, `mail_messages_fts`, `mail_sync_state`
and `mail_image_allow`. They are listed in `LOCAL_ONLY_TABLES` in `servers/sharing/instance-sync.js` and
in none of the synced sets, which means:

- no mail row is ever replicated to a peer, put in the outbox, or included in the local backup's
  peer-shared portion;
- the one thing that does travel between a person's own instances is a **claim** — a hash, an instance
  id and a time in `dashboard_settings` (see below), never an address, a host, a username or a password.

Secrets live in the sealed keychain, not in `mail_accounts`: a row of kind `service` with
`connection_uuid` = the account id, `bundle_id = "crow-mail"`, and one of
`MAIL_PASSWORD` / `MAIL_REFRESH_TOKEN`. The password never appears in a page, a log, a sync status or a
response. Errors are reported as a `MailError` code and the fixed sentence in `MAIL_ERROR_TEXT`; a
library's message, a server's reply and a username are dropped, never copied into `detail`, a log line
or `status_detail`.

`mail_folders.floor_uid` is the lowest contiguous synced UID (older-mail paging goes below it);
`highest_uid` comes from `uidNext - 1`, never from the newest stored message, so an empty window still
advances and an expunge is detected by UID rather than by date.

## The adapter contract

Every provider implements `servers/gateway/mail/adapter/interface.js`:

```
connect(): Promise<void>
close(): Promise<void>                       // idempotent
listFolders(): {path, name, specialUse, delimiter, selectable}[]
list(folderPath, {sinceDate?, afterUid?, beforeUid?, fromUid?, limit?, newestFirst?}):
  {uidValidity, uidNext, items: {uid, flags, internalDate, size}[]}
get(folderPath, uids): {uid, flags, internalDate, raw: Buffer}[]
search(query, {folderPath?, limit?}): {folderPath, uid}[]
saveDraft(raw): {folderPath, uid|null}
send(OutgoingMessage): {messageId, accepted, rejected}
watch(folderPaths, {onChange, onError}): {stop()}
```

Things the contract pins, because the engine relies on them:

- `afterUid` filters on the client side: `UID SEARCH UID n:*` on a real server still returns the last
  message when `n` is above it, so the adapter never trusts the server's lower bound.
- `uidNext` is never missing: use `STATUS (UIDNEXT)` when a selection omits it, else the highest listed
  UID + 1.
- `sinceDate` is an internal-date bound at millisecond precision: the server-side `SINCE` is
  day-granular, so the adapter filters the rest.
- `watch` takes at most two folders and calls `onError` once when the connection dies; reconnecting is
  the caller's job. It must attach an `error` listener to every client it opens: an unhandled `error`
  on a dropped IMAP connection ends the whole gateway process.
- `send` accepts an `OutgoingMessage` and nothing else — no `envelope`, no raw headers, no file or URL
  access. `validateOutgoing` refuses those before a connection is opened.
- Every failure leaves the adapter as a `MailError` (`AUTH_FAILED`, `NETWORK`, `TLS`, `PROTOCOL`,
  `TIMEOUT`, `TOO_LARGE`, `CHANGED`, …), never as a library error.

`createImapSmtpAdapter({account, credentials, tokenProvider?, onTokenRotated?, clientFactory?, timeouts?,
maxRawBytes?})` is the IMAP/SMTP implementation (imapflow + nodemailer). `credentials` is the keychain
reader and is the only place a plaintext secret is read.

### Adding a Gmail API or Microsoft Graph adapter

Both are HTTP APIs with OAuth, not IMAP, but they implement the same interface:

1. Create `servers/gateway/mail/adapter/gmail.js` (or `graph.js`) exporting
   `createGmailAdapter({account, credentials, tokenProvider, onTokenRotated, timeouts, fetch?})` and
   return an object that passes `assertAdapter`. Keep one injectable HTTP seam (`fetch`) the way the IMAP
   adapter keeps `clientFactory`, so tests never reach the network.
2. Map the provider's folder model onto `listFolders`: labels for Gmail (`INBOX`, `SENT`, `DRAFT`,
   `TRASH`, `SPAM`; user labels as ordinary folders), mail folders for Graph. `specialUse` carries
   `\Inbox`, `\Sent`, `\Drafts`, `\Trash`, `\Junk`, `\Archive`.
3. Map UIDs onto something stable. Gmail's per-message id and Graph's `id` work as the adapter's `uid`
   as long as `list`/`get`/`search` are consistent about the same value; `uidValidity` then has to be a
   value that changes when the mapping does (a mailbox generation counter you keep), because the engine
   wipes a folder when it changes. Virtual views (`\All`, `\Flagged`, `\Important`) are skipped by the
   engine; do not fake them as folders.
4. `get` returns the raw RFC 822 source (`format=raw` for Gmail, `/$value` for Graph) so the same
   `parse.js` normaliser and the same store apply. Above `maxRawBytes` return an empty Buffer.
5. `send` and `saveDraft` go through `validateOutgoing` first and report `{messageId, accepted,
   rejected}`. Never build a provider request out of caller-supplied headers.
6. Credentials: an OAuth account stores `MAIL_REFRESH_TOKEN` in the keychain and gets its access token
   from `tokenProvider({accountId, forceRefresh})`; a rotated refresh token is written back through
   `createRotationWriter(credentials)`. On `AUTH_FAILED` the adapter retries once with
   `forceRefresh: true`.
7. Register the adapter in the boot factory (`servers/gateway/boot/mail-boot.js`, `defaultAdapterFactory`)
   and in the route fallback in `servers/gateway/routes/mail-api.js`, choosing by `account.authKind` or
   `account.provider`.

The contract test lives in `tests/fixtures/mail-adapter-contract.mjs` (`runAdapterContract`): run it
against the new adapter with the provider's own fake, and skip nothing.

## Sync behaviour

- **Window.** The first sync of a folder lists `sinceDate = now - window_days` (default 90), stores what
  it finds, then sets `uid_validity`, `highest_uid = uidNext - 1` and `floor_uid`. Later syncs list
  `afterUid: highest_uid`, apply flags and expunges by UID (`fromUid: minUid`), and never delete
  anything older than the window.
- **Batches.** At most 25 UIDs and about 16 MiB of source per fetch, with a yield between messages, so a
  large batch cannot starve the event loop. Each message is parsed and stored in its own `try`/`catch`: a
  hostile or oversized message becomes a row with `parseError` (`unparseable`, `too_large`) and the
  folder still syncs.
- **Older mail.** `fetchOlder` pages below `floor_uid` by UID (not by date), `limit` at a time, and
  reports `reachedStart`. Remote search stores whatever it finds, including a UID far below the window.
- **Supervisor.** One worker per `active` account, one in-flight sync per account. IDLE on Inbox and
  Sent, a 15-minute poll for the other folders, exponential back-off (5 s doubling to 15 min) for
  connection faults, and a hard ten-minute deadline per run that closes the adapter so a hung socket
  cannot park the account forever. A refused sign-in marks the account `auth_failed`, notifies the owner
  once and stops retrying until the owner asks for a sync.
- **Connections per account.** Three long-lived connections (one read connection — the sync
  worker's — and up to two IDLE connections, one per watched folder: Inbox and Sent) plus a
  short-lived action connection — an attachment fetch today — which `withAdapter` keeps open for up
  to 30 seconds so a burst costs one login; the message actions of the next part (mark read/unread,
  archive, delete, move) will use that same connection. `watch` refuses a third folder rather than
  opening another long-lived connection.
- **Deleting an account.** `stopAccount(accountId)` retires the worker, its timers and its connections,
  but it does not by itself cancel work already running through `withAdapter` (a backfill page, a
  remote search): that work stops on the `cancelled` flag it is handed, and the flag reads the
  supervisor's removal set. So the delete path must call `beginRemoval(accountId)` before
  `stopAccount`, and `endRemoval` once the rows are gone — otherwise a batch already fetched can still
  be written.

## One address, one instance: claims

An address is connected on one instance only. `mail_accounts` never syncs, so the claim cannot be a
column; and a single shared `dashboard_settings` key per address cannot hold two claims, because those
rows replicate last-writer-wins per key — two instances would overwrite each other forever, and equal
timestamps would let the values flap.

So each instance writes only its **own** key, `mail_claim_<hash(address)>_<instance id>`, holding
`{instanceId, instanceName, claimedAt}`, and the holder is a pure function of the whole set: the earliest
`claimedAt`, then the lowest instance id. A released claim is a tombstone (`{released: true, …}`), never
a delete. A claim only counts while its instance is in `crow_instances` as `active` or `offline` (or is
the local instance), so a wiped or revoked instance cannot hold an address forever.

Consequences worth knowing:

- The claim key carries a sha256 prefix of the address, not the address, and the value carries no
  address, host, username or secret. The row travels only between a person's own paired instances.
- The supervisor re-checks the claim at start and on every poll tick, and rewrites its own claim at
  start and once a day — that refresh is how a peer paired *after* the claim was made ever receives it.
  A loser stops its watcher and timers, closes its connection and marks the account
  `claimed_elsewhere`; it is re-evaluated on each tick and restarts once the claim clears.
- Claims are written when an account is connected (the `POST /accounts` route), not at boot.
- **Partial-mesh limit.** Convergence assumes every instance sees the same set of claims. There is no
  relay: with A–B and B–C paired but not A–C, A and C never see each other's claim rows and can both
  connect the same address. Clock skew is accepted too: an earlier `claimedAt` wins by design.
- **Liveness is each instance's own view.** A claim only counts while its instance is in the *local*
  `crow_instances` as `active` or `offline`. If A has revoked B but B still lists A as active, the two
  disagree about which claims count, and both (or neither) can win until their views agree.

## The reader

With `CROW_MAIL=1` the owner opens **Mail** from the shell's drawer ("More of Crow") at
`/dashboard/mail`, on a phone or a desktop. It is one hidden dashboard panel —
`servers/gateway/dashboard/panels/mail.js` plus `panels/mail/{html,css,client,settings-html}.js` —
server-rendered like For You, with every view chosen by the query string. It reads this module's
stores directly (`mail/store/reader-queries.js` answers the link and conversation questions) and
calls `/dashboard/mail/api` only for actions. It is core code, never a bundle, so a copy cannot drift
from the schema.

Gates, in order, on every method: the flag, then `isLocalPasswordSessionOn` (the owner's own local
password session), then GET and HEAD only. A peer's SSO session, a shared-project member and an unset
flag all get 404 from the page, the page itself posts nothing, and `/dashboard/mail` is not in
`PUBLIC_FUNNEL_PREFIXES`. The JSON API under `/dashboard/mail/api` answers its own guards — 404 while
the flag is unset and 403 `owner_only` for a session that is not this machine's own — and a
Funnel-flagged request is refused before either reaches a mail row.

The panel's own client script (`panels/mail/client.js`) does only what a plain link cannot: build the
message frame, resize it, the image buttons, refresh, older mail, the server search, and the settings
verbs. Every sentence it can show comes from a `data-ml-*` attribute the server already translated; the
one hidden error element carries a fixed sentence per API code, so a response's own English `message`
is never put on screen.

### Decisions behind the shape

1. **A panel, not a gateway route set.** Pages follow `panels/for-you.js`: flag gate, owner gate, hidden
   panel, reached from the drawer. They are server-rendered with plain links (Turbo Drive navigates);
   the client script fills the gaps a link cannot.
2. **A frame route, not `srcdoc`.** The page's CSP (`img-src 'self' data: blob:`) cannot be loosened for
   one message, and a separate response can carry its own header. The frame response sets
   `sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox` — never `allow-same-origin` —
   and a `script-src` equal to the one helper's hash. Links in the frame keep an absolute `http`,
   `https`, `mailto` or `tel` only: a relative href would open a signed-in dashboard page in the tab
   the link asks for.
3. **This module's sanitiser is the first line** (`bodyForDisplay`), and the CSP plus the sandbox are
   the second. The frame document is rendered from the sanitised body on every load, never from stored
   html, so remote images are this load's decision and a stored body cannot smuggle markup in later.
4. **Seams for later plans.** The message view carries an empty
   `<div data-mail-reply-slot data-account data-mid data-thread>` (plan 3: Reply, Reply all, Forward,
   "Draft a reply with…", the bot picker and the "the bot sees only this thread" line; plan 4: the
   suggestion), and the inbox carries `<div data-mail-digest-slot>` on the All view only (plan 4). The
   reader draws nothing in either.
5. **Message actions (read/unread, archive, delete, move) are a separate part of the plan.** The
   reader's first parts ship without them (the unread dot then never clears, which is why the actions
   part follows immediately). That actions-part PR (Part C) guarantees every action refuses a UID
   whose folder UIDVALIDITY differs from the stored one; the reader shipped here does not act on a
   message at all, so the guarantee is not present yet.
6. **Attachments: download is in, two gaps are named.** `mail/reader/attachments.js`
   (`extractAttachment`, `extractAttachmentFromParsed`) serves one part of the raw message by the same
   index `GET /messages/:id` lists, and plan 3 imports it to forward an attachment. Not covered:
   `cid:` inline images (the frame's `img-src` never allows them, so a body that only carries them
   renders without its pictures), and "open in Crow's file viewer" (a download link is v1). The
   sender's own content type is never echoed: every download is `application/octet-stream` with
   `Content-Disposition: attachment` and a `sandbox; default-src 'none'` policy.
7. **A minimal add-account form.** Label, address, password, IMAP and SMTP host, port and security —
   no provider presets, no Gmail app-password steps and no OAuth wizard. Plan 5 replaces the form's
   body; the settings page and its routes stay as they are.

### The URL contract

One route, `/dashboard/mail`, and a query string. Every value is read defensively: an unknown account
id falls back to the unified view, an edited `cursor` starts at the first page, and a `back` value that
is not a `/dashboard/mail?` path becomes the inbox.

| Parameter | Meaning |
| --- | --- |
| `view` | `inbox` (default), `message`, `search` or `settings` |
| `acct` | an account id, or `all`: the account chips. A folder link carries the folder's own account |
| `folder` | a `mail_folders.id`; lists that one folder instead of the inbox |
| `cursor` | plan 1's opaque keyset cursor for the next page ("Load more") |
| `a` | the account id of a message link |
| `mid` | the message's Message-ID, `encodeURIComponent`-ed; odd and very long ids round-trip |
| `row` | the row id, a hint used only when it belongs to `a` and its Message-ID is `mid` |
| `q` | the search words, trimmed and cut at 200 characters; an empty `q` draws the inbox |

Two more values travel without being a view: `back`, the list a message should return to (accepted
only as a `/dashboard/mail?...` path), and `flash`, the reload an action leaves behind (`older:<n>`,
`remote:<n>` or `start`), which the server turns back into a sentence so it survives the reload.

A message link therefore carries `a` + `mid` + `row`, and a message with no Message-ID is linked by
`a` + `row` alone. `resolveMessageRef` uses the row only when it belongs to that account and its
`message_id` equals `mid`; otherwise the Message-ID lookup runs, groups the account's candidates by
`(from_addr, date)`, and takes the group holding the lowest id (the real message arrived first) and
inside it the `inbox`-role row, else the lowest id. A conversation lists one entry per logical message:
rows that are copies of one another (same Message-ID, From and Date, another folder) collapse to the
row the reader stands on, while two rows that share only a Message-ID stay separate.

### The frame route

```
GET /dashboard/mail/api/messages/:id/frame            # remote images blocked
GET /dashboard/mail/api/messages/:id/frame?images=1   # this load only, nothing stored
```

An allow-listed sender (`mail_image_allow`, compared lower-case) gets images without `images=1`. The
response is `text/html; charset=utf-8` and carries its headers from `frameHeaders()`:

```
Content-Security-Policy: default-src 'none'; script-src 'sha256-<helper>'; img-src 'none'|https:;
  style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'self';
  sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
Cache-Control: no-store
```

The route sets that CSP in its handler, after the gateway's global middleware, so it replaces the
dashboard page's policy rather than adding to it. `img-src` is `'none'` unless this load allows
images, in which case it is `https:` and nothing else. `frame-ancestors 'self'` is the dashboard's own
origin: a dashboard that is itself embedded by another origin will not show the reader's frame, which
is acceptable because the reader is owner-only.

A second pass over the already-sanitised body (`dropTrackingPixels`) drops any `<img>` declaring 2 px
or less on either side (`width`/`height`, `"1px"`, `0`), and strips the `href` of any link that is not
absolute. The document's `<meta name="crow-blocked-images">` carries the blocked count minus the
pixels this pass dropped after this module had already counted them as blocked, so a tracking pixel
never raises the banner twice.

### Option C: the opaque-origin frame

The body is never in the page and never in `srcdoc`. It is shown in an `<iframe>` with `sandbox`
`allow-scripts allow-popups allow-popups-to-escape-sandbox` (no `allow-same-origin`), so the document
has an opaque origin: a script inside it could not read the `crow_csrf` cookie or call the private
APIs, and there is no such script because the sanitiser drops `script` and every handler first.

Exactly one script runs in the frame — `FRAME_HELPER_SOURCE` in `mail/reader/frame-doc.js` — and
`script-src` is its `sha256-` hash and nothing else (no `'unsafe-inline'`, no host, no `'self'`).
Two things follow from this being a dashboard route rather than the artifact origin:

- **The helper is inline, not served from a path.** A subresource request from an opaque origin carries
  no session cookie, so a script path under the owner-guarded API would answer 403. A hash allows
  exactly that one piece of text and nothing else.
- **The nonce lives in the fragment.** The per-load nonce cannot be inside the pinned text, so the
  parent puts it in the iframe URL as `#n=<nonce>` (never sent to the server) and the helper reads
  `location.hash`, posting only when it matches `^[A-Za-z0-9_-]{16,64}$`.

The helper writes nothing, makes no request, and posts `{t: "crow-mail-frame", nonce, height, blocked}`
to `parent` with target `*` (an opaque frame cannot know its parent's origin, and the payload holds no
secret) on `load` and from a `ResizeObserver` on the body, at most four times a second. The parent's
one `message` listener accepts a report only when the source is that iframe's own `contentWindow`, the
type matches, the nonce equals the one it generated for this load, and the height is a finite number;
it floors and clamps the height to 120–20000 px and shows the image banner for a blocked count above
zero. It never reads the frame's document.

"Show images" rebuilds that one frame with `&images=1` and a **new** nonce. "Always show from
&lt;sender&gt;" first POSTs `/image-allow`, then rebuilds the frame the same way; nothing about images is
stored per view.

### Connections the reader borrows

The reader's attachment path never opens an adapter of its own and never reuses the sync worker's. A
download goes through `supervisor.withAdapter(accountId, fn)` for the one call at a time that account
allows, refused outright for a `claimed_elsewhere` or `auth_failed` account. On a success the adapter
stays open for up to 30 seconds; the message actions of the next part (open a message, mark it read,
archive it) will go through the same call, so a burst of them costs one login rather than three, and a
failure closes it at once. That is a fourth connection on top of this module's budget of three (the
sync worker's read connection and up to two IDLE connections, for Inbox and Sent), and every imapflow
call inside it takes the mailbox lock. The download route re-fetches the message from the server by UID
under that account's folder and compares its Message-ID, lower-cased From and Date with the stored row
before serving a byte; a mismatch is 409 `changed_on_server` and a requested full sync. An empty Buffer
is the adapter's way of saying the message is over `MAX_RAW_BYTES`, and it answers 413 with the "about
18 MB" sentence.

The account page's password update is the one path that dials on its own: `probeAccount` signs in with
the password just typed (through the injected adapter factory, holding no stored secret) before
anything is written, and only then is the secret sealed and the account restarted.

### Mail passwords in the Passwords page

A mail secret is a `kind: "service"` keychain row with `bundle_id = "crow-mail"` and no
`service_connections` row, which is exactly the shape the Passwords page treats as a deletable orphan.
So `deleteEntry` refuses any `crow-mail` row with `KeychainMailRowError` (code `KEYCHAIN_MAIL_ROW`),
the API answers 409 `{error: "mail_row"}`, and the page shows the extension column as "Crow Mail"
with the sentence "This password belongs to a Mail account. Remove the account in Mail settings."
Removing the account still works: `deleteSecrets` goes through `deleteServiceSecrets`, not
`deleteEntry`. Reveal and Copy keep their re-auth gate unchanged.

### Known limits

- **A forged Message-ID can win after a UIDVALIDITY reset.** The tie-break assumes the real message
  arrived first: the group of rows sharing `(from_addr, date)` with the lowest row id wins. Row ids
  survive nothing — a UIDVALIDITY reset wipes the folder and every row is stored again — so after a
  reset the ids no longer say which delivery came first, and a forged message reusing a known
  Message-ID can tie-break to the forged row. A link that still carries the original `row` and `mid`
  opens the original, because the row is used when its Message-ID matches; the gap is the
  Message-ID-only path. This is a spec gap, with no fix in this plan.
- **A message in a Gmail-style label folder shows once.** The label copy collapses into the inbox row
  (`copyRows`: same Message-ID, From and Date, different folder), so a conversation and the unified
  counts list one entry. Opening it from the label folder still serves that folder's copy, because the
  link's `row` hint names it.
- **The not-here page answers 404 for every unresolved link.** A message that never existed, one from
  another account, and one whose row a resync removed all get the same status and the same sentence.
  That is deliberate: one status for every miss leaks less about which ids exist.
- **The attachment GET talks to IMAP.** It fetches the message from the server for that one download,
  and on an identity mismatch it answers 409 and asks the supervisor for a full sync. So a download
  can be slow, can fail with a connection error, and can start a resync; nothing is stored locally to
  serve it from.
- **The All view re-encodes the cursor.** `listMessages` takes one account or every account, never a
  set of ids, so the panel reads across every account, steps over rows of accounts this instance may
  not read, and then re-encodes the last row it kept as plan 1's `date:id` cursor. Using the fetched
  page's own cursor would sit past usable rows and skip them.
- **No read POST ships yet.** The client keeps the mark-read timer slot (`window.__mlTimer`, cleared on
  every run and on `turbo:before-visit`) so the lifecycle is in place, but nothing arms it: opening a
  message writes nothing, and the unread dot stays until message actions land (Part C).

## Known gaps

- **OS-user trust.** The password lives in the sealed keychain, but `crow.db` and `keychain.key` are
  readable by anything running as the gateway's OS user. "Mail adds no MCP tool" is not "bots cannot
  read the inbox": keeping a bot away from mail depends on bot containment (the sandbox work runs bots
  as their own users with their own walls). Treat an instance's mail as readable by everything that can
  read its `CROW_HOME` until then.
- **A moved-in message with an old date can hide from local paging (accepted for v1).** `floor_uid` can
  sit *above* a message that was moved into a folder later (IMAP gives it a new, high UID while keeping
  its old date). Local sync will not show it until remote search runs; remote search does find it
  (`searchRemote` stores whatever the server matches, regardless of `floor_uid`). No code change is
  planned for this in the first version — it is a documented consequence of paging by UID.
- **Proton Bridge** serves a self-signed localhost certificate, which `tls.rejectUnauthorized: true`
  refuses. A per-account pinned-certificate option is a later plan, never a global off switch.
- **Two gateways on one `crow.db` share one instance id.** Nothing guards it: both read the same
  `mail_accounts` rows, both compute themselves the winner of the same claim and both sync the same
  folders into the same tables. The rule that one address is connected on one instance assumes each
  instance has its own database (the primary and a second instance are separate databases); running a
  second gateway against the primary's file breaks it.
- Virtual Gmail views (`\All`, `\Flagged`, `\Important`) are skipped; labels sync as ordinary folders and
  are deduplicated by `(account_id, message_id)` for search and counts.

## Working on it

```bash
npm test -- tests/mail-boot.test.js tests/mail-e2e.test.js
npm test -- tests/mail-sync-engine.test.js tests/mail-supervisor.test.js
```

The end-to-end test drives the whole path — the boot wiring, the routes, the real adapter, the engine and
the supervisor — against the in-process fake IMAP and SMTP servers in
`tests/fixtures/fake-mail-server.mjs`, with an injected clock so the back-off leg takes milliseconds.

The gateway starts cleanly with the flag unset or set; with no account connected nothing dials out, and
`node servers/gateway/index.js --no-auth` never runs a mail supervisor at all.