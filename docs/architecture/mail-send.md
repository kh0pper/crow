# Mail Send

Crow Mail's outgoing side. A person asks a bot to write a reply, reads the draft on a card in chat, and
presses Send or Schedule themselves. Nothing else in Crow can put a message on the wire: the two owner
routes are the only way into a tap state, and the delivery path re-checks a seal before it opens a
socket. The engine lives in `servers/gateway/mail/send/` (`send-service.js`, `schedule-service.js`,
`hook.js`), the draft state in `servers/gateway/mail/drafts/store.js`, and the seal in
`servers/gateway/mail/drafts/seal.js`.

## What sends, and what cannot

A send starts at one of two routes on the owner's own session, under `/dashboard/mail/api/drafts`:

- `POST /:id/send` with the head hash the card was drawn from;
- `POST /:id/schedule` with that hash and a zone-qualified due time.

Both routes carry plan 1's guards: the feature flag (404 `{error:"not_found"}` while `CROW_MAIL` is
unset), an owner-only session (403 `{error:"owner_only"}` for anything else), `Cache-Control: no-store`,
the dashboard's CSRF header and the mail API's own 64 KB body limit.

Both call one service (`requestSend`, `scheduleDraft`), which runs preflight, checks the account and the
instance claim, then moves the row into `holding` or `scheduled` with one guarded UPDATE. Those two
states are the taps. No other writer in the codebase enters them: `transition()` refuses a move into
either state unless the same UPDATE carries a full seal, and the services are the only callers that
build one.

A bot cannot send. A drafting turn gets three tools — `mail_draft_read_thread`, `mail_draft_read_context`,
`mail_draft_propose` — from one gateway-served MCP server, `crow-mail-draft`, mounted at
`/mail-draft/mcp`. The mount admits a request only with a live per-turn `mdt_` token bound to that draft
and turn *and* a `mail-draft` actor signature over the same pair; it is not a Funnel path and not a
`pathScopedToken` family. A drafting turn's `--tools` list is exactly those three names (no built-in, no
subagent) and its MCP config holds exactly one server, so the spawn carries no credential-bearing child
the turn could call. `mail_draft_propose` writes a revision and nothing else: its schema is strict, and
`bcc`, `from`, attachments and headers are refused rather than ignored.

The scheduler does not compose a send either. The tick only completes a tap a person already took; a
`missed` row needs a fresh press with the current hash. `tests/mail-no-tap-invariant.test.js` reads this
from the code: no MCP door reaches a send or schedule module, the only importers of `requestSend` and
`scheduleDraft` are the owner routes, and no bot def, preset or `toolAllowlist` output can carry a name
matching `/mail.*(send|schedule)/i`.

## The state model

`mail_drafts.state` is one of nine values. The table carries no `CHECK`: the store validates every
value against `DRAFT_STATES` and every move goes through `transition()`.

| State | What it means | Who moves a draft there |
|---|---|---|
| `draft` | editable; a bot may revise it | `createDraft`; `undoSend` (from `holding`); `cancelSchedule` (from `scheduled`); `addRevision` with `cancelSchedule: true` (a user edit of a scheduled draft) |
| `holding` | Send was tapped; the undo window is running | `requestSend` (from `draft`, `failed`, `missed`, or `unknown` with a confirm) |
| `scheduled` | frozen until `due_at` | `scheduleDraft` (from `draft`, `failed`, `missed`) |
| `sending` | claimed; the adapter call is in flight | `deliver`'s claim, from `holding` or `scheduled` |
| `sent` | the provider accepted it | `settle`, from `sending` or `unknown`, by `claim_token` |
| `failed` | provably not sent; Send is allowed again | `deliver` (a failure that did not complete), `settle`, the sweep (an account gone, signed out or claimed elsewhere) |
| `unknown` | may or may not have gone out; no automatic retry | `deliver` (a failure whose outcome is unknowable), the stale sweep, account removal |
| `missed` | the due time passed beyond the grace window; needs a fresh press | the sweep |
| `discarded` | terminal; thrown away | `discardDraft` (from `draft`, `failed`, `missed`, `unknown`), account removal |

The other moves:

- **Revisions.** `addRevision` writes the next revision from `draft`, `failed` or `missed` (author `bot`
  or `user`). A `user` revision of a `scheduled` draft with `cancelSchedule: true` first returns the row
  to `draft` in the same transaction, so the edit is never lost to a frozen row. A bot revision of a
  `scheduled`, `holding` or `sending` draft is refused `frozen`, and so is any revision of a `sent`,
  `discarded` or `unknown` one. A stale `expectHash` is refused `changed` and writes nothing.
- **Discard.** `discardDraft` leaves `holding`, `scheduled` and `sending` alone: those belong to the
  send service, which is where an undo or a cancel lives.
- **The sweep.** `sweepMailSends` moves `holding`/`scheduled` rows past the grace window to `missed`,
  `sending` rows this process is not running and has not run for `STALE_SENDING_MS` to `unknown`, and an
  `unknown` row whose account is gone off the reconcile path with the `account_removed` reason.

Every move is one UPDATE whose `rowsAffected` is checked. Answers are booleans, and a losing writer
changes nothing.

## The tap hash and the seal

A revision's hash is `hashOf()`: the canonical snapshot's content hash over recipients, subject and body
(`servers/gateway/staged/canonical.js`), extended with a SHA-256 over what the snapshot does not keep —
display names per canonical address, `inReplyTo`, `references`, mode, the From, and the attachment
references sorted by source, identity and index. It is a pure function of a revision's fields, so a
caller that needs "the hash of the revision I just read" rebuilds the input from the row
(`revisionToInput`) and recomputes it. `deliver` does exactly that and compares the result with the
`head_hash` the seal covers; the stored `content_hash`/`head_hash` columns are never read for the
comparison.

The seal (`drafts/seal.js`) is an HMAC-SHA256 over eight fields, each length-prefixed with its own type
tag, in a fixed order: `draftId`, `headHash`, `action` (`send` or `schedule`), `when` (`hold_until` for a
send, `due_at` for a schedule), `attachDigest`, `accountId`, `fromAddress` (the account's address, a
newline, its display name) and `tapId`. The MAC key is a subkey derived from the keychain's own key file
— `HMAC(keychain seed, "crow-mail-tap-seal-v1")` — and `tapId` is 16 random bytes made per tap, so a seal
binds one tap rather than a content-and-time pair that can recur. Verification is a constant-time
comparison; an unverifiable seal is a refusal, not an error.

`transition()` nulls `tap_seal`, `tap_id`, `tap_action` and `attach_digest` in the same UPDATE as every
move that does not end in `holding` or `scheduled`, so a cancelled, discarded, failed, missed or sent
row keeps nothing a later send could revive. `deliver` verifies the seal over the row's own fields before
it claims anything, and any mismatch leaves the tap state through `transition()` with a fixed
`fail_reason` (`seal`, `account_removed`, `keychain_key_missing`) and no adapter call; a hold or a due
time already past the grace window leaves it as `missed` the same way. One further check happens after
the claim: an attachment digest that no longer matches the sealed one settles the row `failed` with
`attachment_changed`, again with no socket.

**The stated limit.** The seal is a tamper check, not a capability. It stops a stray writer, a bug or a
bot with database write access from forging or reviving a row. A process that can read
`<CROW_HOME>/secrets/keychain.key` could mint a seal, and a writer that copied a live row — seal and
`tap_id` together — could replay it until it is consumed or cleared. That case rests on bot containment
rather than on this check, which is the operator decision recorded for plan 3 (Q7).

A tap also refuses before anything is written when this Crow has no keychain key: `requestSend` and
`scheduleDraft` answer `not_sendable` with reason `keychain_key_missing` and the card shows the fixed
sentence about the missing key file. No silent refusal, and no row left in a tap state without a seal.

## The ten-second hold

`requestSend` writes `hold_until = now + 10_000` (`HOLD_MS`) and arms an unref'd in-process timer. The
window exists for Undo: `undoSend` is a `holding -> draft` compare-and-set, and `transition()` clears the
seal in the same statement, so an undone draft is an ordinary editable draft again. Too late to undo
(`sending`, `sent`, `unknown`) answers the fixed sentence "It already went out."

The timer is the primary path and the tick is the recovery path. A timer that fires while a later tap's
hold is still running answers `not_due` and re-arms for the rest of that longer hold, and it re-arms only
while the row is still `holding`: a row that has since been scheduled, discarded or sent has no hold to
wait out. Scheduled sends need no hold — Cancel send is available until the due time.

## The claim, the compare-and-set and the in-flight map

`deliver` claims the tap with one UPDATE from `holding` or `scheduled`, guarded by `tap_seal`, `tap_id`
and `head_hash`. It writes a fresh `claim_token`, `claimed_at`, a message id (`<uuid@account-domain>`,
kept if the row already has one), an empty `attempt_at` and a cleared reconcile. `rowsAffected !== 1` is
`lost_claim` and nothing else happens, so two racing deliveries — or two ticks, or two processes on one
`crow.db` — produce one claim and one SMTP call. Every write after the claim is guarded by that
`claim_token`.

Immediately after the claim the draft id goes into the module's `inFlight` map, and it leaves in a
`finally`. The map is per process, and it is what separates "slow" from "gone": `isStaleSending` only
calls a `sending` row stale when the row is **not** in the map and `now - attempt_at > STALE_SENDING_MS`
(10 minutes, `attempt_at` falling back to `claimed_at`). A row in the map is never marked `unknown` by a
sweep. The map's own limits: a second gateway on the same `crow.db`, or a restored copy, cannot see this
process's entries, so it could mark a live send `unknown`. The defences there are the adapter's deadline
destroying the SMTP socket, the `reconcile_count >= 1` gate on a resend, and plan 1's one-account-one-
instance claim row (a synced `dashboard_settings` row, so it carries up to `SYNC_DEADLINE_MS` of lag).

## Unknown, and the reconcile

An adapter failure after the claim is split in two. A code that proves the request did not complete
(`AUTH_FAILED`, `TLS`, `BAD_INPUT`, `TOO_LARGE`, `NOT_FOUND`, `CLAIMED_ELSEWHERE`, `CHANGED`) settles
`failed`, and Send is available again. A code whose outcome cannot be known (`NETWORK`, `TIMEOUT`,
`PROTOCOL`) settles `unknown`, keeping the `claim_token` so a late success can still be recorded. Either
is retried only by a person: a resend from `unknown` needs `confirmUnknown: true` **and**
`reconcile_count >= 1` (at least one Sent-folder check has run), and it reuses the row's original message
id. The card's copy never says "not sent"; it says the outcome could not be confirmed and asks the person
to look in Sent first.

`reconcileUnknown` is a bounded backoff of Sent-folder checks: one minute after `attempt_at`, then five,
then fifteen, then hourly, for at most 24 hours. Each check asks for a sync (not awaited) and looks the
message id up in the account's Sent-role folders; a stored copy settles `sent`, and after the window the
row stays `unknown` with no further check due.

`sweepMailSends` runs one check for each `unknown` row whose `next_reconcile_at` is due. A row whose
account no longer exists is taken off that path instead, with the `account_removed` reason and no further
check, because there is no Sent folder left to look in.

## The scheduler hook

`registerMailSendHook(db, deps)` (`mail/send/hook.js`) registers the one hook id `mail-send` with
`registerSchedulerHook`. The gateway's reminder scheduler ticks every 60 seconds; the hook's body is
`sweepMailSends`, and a sweep that throws is logged as a code and retried on the next tick rather than
escaping into the scheduler.

`boot/mail-boot.js` registers the hook after the sync supervisor starts, and only when `mailEnabled()`
(`CROW_MAIL=1`): a gateway that never turned mail on registers nothing and never looks at a draft table.
Shutdown unregisters it beside the supervisor, so no tick outlives the connection it would borrow.

One sweep, in order:

1. `holding` or `scheduled` rows due at or before now and inside the grace window (`GRACE_MS`, 10
   minutes): each delivery starts as a detached promise in a module-level set, so the tick returns
   promptly and a slow SMTP call never holds the reminder scheduler. Before a delivery the account is
   checked once: gone, signed out or claimed on another Crow fails the row with a fixed reason and no
   socket.
2. The same two states past the grace window: `missed`, and one bell (`source: "mail"`, type
   `attention`) whose text carries the due time and no recipient, subject or body. `notified_at` is
   written only when the creator returned an id; the card's `missed` state is the primary signal either
   way.
3. `sending` rows this process is not running and has not run for `STALE_SENDING_MS`: `unknown`, with
   the first check pointed a minute after the attempt.
4. One Sent-folder check per `unknown` row whose check is due and whose account still exists.
5. The daily prune (below).

Scheduled sends are held by this Crow, so the box must be on and the scheduler running at the due time.
That is stated on the schedule sheet. A message whose due time passes while Crow is down is delivered if
the next tick is still inside the grace window, and is `missed` otherwise — never sent late on its own,
and never quietly dropped. A missed send needs a fresh press with the current hash, which is a new tap
with a new seal and a new hold.

## Account removal

`guardAccountRemoval` (`boot/mail-boot.js`) is registered with `onAccountDeleting`, so it runs before
`deleteAccount` opens its transaction, while the account and its drafts are still whole. Removal is never
blocked (Q2 option 1):

- every `draft`, `failed`, `missed`, `holding` or `scheduled` draft of the account becomes `discarded`
  through `transition()` with the reason "Account removed". A `holding` or `scheduled` row loses its seal
  in the same UPDATE, so nothing a person tapped can still go out;
- a `sending` row cannot be confirmed either way, so it becomes `unknown` with the reason
  `account_removed`; so does every row that was already `unknown`. No reconcile can run without an
  adapter, so the sweep skips these rows and the card keeps its could-not-confirm line. A send still in
  flight can settle its own row by its `claim_token` afterwards;
- one bell, `source: "mail"`, whose text carries no address, subject or body; a settings filter that
  drops the type (a null from `createNotification`) is fine;
- the drafts this hook discarded are deleted with their revisions, voice notes and comments. The
  `unknown` rows stay: they are the only record that a message may have gone out.

A draft that moves under the loop (a delivery claiming it, a person discarding it) fails its own guarded
write and is left as it is.

## Retention

A sent or discarded draft is kept for `DRAFT_RETENTION_MS` (90 days, Q5) and then removed with its
revisions, voice notes and comments. `failed`, `unknown` and `missed` drafts are never pruned: an outcome
nobody could confirm is not history.

The prune runs inside `sweepMailSends` at most once a day, behind one compare-and-set on the
`dashboard_settings` key `mail_drafts_prune_at` (`UPDATE ... WHERE value < ? OR value > ?`, work only
when exactly one row changed), so two ticks or two Crows on one file cannot both prune for one day. The
guard, the candidate read and every guarded delete run in one transaction; a row that moved out of
`sent`/`discarded` between the read and its delete fails its own guarded delete and is left alone. A
prune that cannot run is a code in the log and the next tick's work, never a failed sweep.

## Settings

| Key | What it is |
|---|---|
| `mail.cloud_drafting` | the owner's switch for letting a cloud model draft email. Default off. It is written local-only (a `dashboard_settings_overrides` row for this instance, scope `local`), so a paired peer cannot turn it on, and it is absent from every sync allowlist. `allowDraftModel` reads it through `readSetting`, and an unreadable value is "off". |
| `mail.working_hours_start`, `mail.working_hours_end` | `HH:MM`, 24-hour, in the instance zone. Both are written together or cleared together; one of the two alone reads as "no working hours". They feed `schedulePresets`: the schedule sheet's shortcuts are 7:30 and 8:00 local when none are set, and the person's own start time when they are. |

A third setting is not a setting of this module but decides the same tap: the account's
`local_models_only`, which always wins over the cloud switch for that account's drafts.

## Developer notes

Decisions taken in the code that the plan left open or worded differently, recorded here so the next
reader does not re-derive them:

- **The drafting turn's session dir** is `<CROW_HOME>/mail-draft-turns/<botId>/<draftId>`
  (`prepareDraftTurnDir`, `mail/drafts/turn.js`), created mode 0700 with every symlink on the way
  refused. It is under the instance's home and outside every bot-writable world root, so no chat thread
  of the same bot can resume it, and it is deleted a day after the turn ends.
- **File delivery of a bot MCP config is refused.** A drafting turn's one server block carries the live
  `mdt_` token, so the turn is fd-only (`scripts/pi-bots/mcp-delivery.mjs`, `MCP_CONFIG_FD = 4`). A host
  that resolves to the file mode is refused with `delivery_unsupported` before a token is minted, and the
  bridge refuses it again before anything spawns, so the token never lands in a `.mcp.json`.
- **There are no `mdr-` revision ids.** A revision row is keyed by `(draft_id, rev)` and the table has no
  id column; draft ids are `md-` plus 16 hex, comment ids `mdc-` plus 16 hex.
- **`markCommentsApplied`'s `newRev` is unused.** The comments table has no column for the revision a
  comment was folded into, so `newRev` is validated against the draft's head and not stored. The revision
  loop marks comments applied in the same transaction as the revision instead
  (`addRevision({ appliedCommentIds })`).
- **A user edit of a scheduled draft needs `cancelSchedule: true`.** `POST /:id/revisions` always sends
  it, so the store returns the row to `draft` (seal cleared) and writes the revision in one transaction.
  The plan's 409 `{error:"scheduled", needsCancel:true}` branch exists only for `cancelSchedule: false`,
  which that route never sends, so it is not implemented.
- **`transition()` takes an optional `{expectHash}`.** Both taps always pass it (`expectHash: hash` in
  `requestSend` and `scheduleDraft`), so a tap loses its UPDATE if the head moved under the card.
  `addRevision` uses its own hash-guarded UPDATE inside its transaction. The other `transition()`
  callers — discard, cancel-schedule, the sweep, account removal — carry no hash, because none of them
  acts on what a person was reading.
- **The removal guard lives in `boot/mail-boot.js`, not in the schedule service.** It needs only
  `transition()` from the draft store, and the no-tap invariant test pins the importers of
  `schedule-service.js` to `send/hook.js` and `routes/mail-drafts-api.js`; a guard in that module would
  have made `mail-boot.js` a third importer of the module that owns the schedule tap.