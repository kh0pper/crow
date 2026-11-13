# Mail store and sync

Crow can hold a person's IMAP/SMTP mailboxes in its own database, keep the last 90 days in sync, fetch
older mail on demand, and serve a private JSON API to the reader. The code lives in core, not in a
bundle: it has tables in `scripts/init-db.js`, rows in the instance-sync local-only list, a boot hook
and (later) a model role, so it cannot drift from its schema the way a bundle copy can.

This page describes the architecture, the feature flag, the tables, the provider-neutral adapter
contract, the one-instance-per-address rule, and the limits this first version accepts.

Nothing here is user-visible while `CROW_MAIL` is unset, and this plan adds **no MCP tool, no router
category and no nav link**: a bot has no mail surface, and the reader that consumes the API is a later
plan.

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
  short-lived action connection — an open message, a mark-read, an attachment fetch — which
  `withAdapter` keeps open for up to 30 seconds so a burst costs one login. `watch` refuses a third
  folder rather than opening another long-lived connection.

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