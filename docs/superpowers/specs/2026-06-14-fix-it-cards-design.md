# Fix-it Cards — a reusable "Crow noticed something → one-click fix" framework

**Status:** Design (approved in brainstorming 2026-06-14). First build = framework + the funkwhale remote-sharing seed only.

## Problem

A non-technical user (Crow's beachhead: a public-education admin) hits silent
failures they cannot diagnose. The motivating case, root-caused this session:
the user asked their Meta-glasses bot to "shuffle play my music," and it failed
because the instance that owns Funkwhale (`remote_exposed_tools`) defaults to
*deny-all* for peer instances — so grackle's glasses bot was refused, with **no
explanation anywhere**. The fix existed (Settings → Multi-Instance → Remote Tool
Exposure) but was buried, jargon-laden ("expose the `funkwhale` capability"), and
required the user to *proactively* know it was the problem.

This is not unique to Funkwhale. Across Crow there are ~15 "something silently
broke and there's a safe one-click fix" moments (see *Future detectors*). Today
each is handled bespoke or not at all.

## Goal

A single, reusable framework so that **any service** can turn a silent failure
into a plain-language, one-click-fixable **Fix-it card** with identical UX. Ship
the framework plus exactly one adopter (remote-sharing / Funkwhale) to prove the
hardest path end-to-end: an *event-triggered* detector with an *instant* remedy
that self-heals.

Non-goals for v1 are listed under *Out of scope*.

## Concepts

- **Fix-it item** — one actionable problem instance: `{ source, dedupKey, title,
  why, severity, remedies[], status, context }`. Status ∈ `pending | dismissed |
  resolved`.
- **Detector** — a small module a service registers. Produces/updates Fix-it
  items. Two trigger styles:
  - **event** — called at a failure chokepoint (e.g. a peer-exposure denial).
  - **poll** — called on the existing nest health cadence (designed for; not
    built in v1).
- **Remedy** — a labelled, safe action attached to an item:
  `{ label, kind: instant|confirm|guided, run(ctx) }`. `run()` performs the fix
  and returns whether the item is now resolved.

## The contract (interfaces)

```
// servers/shared/fix-it/registry.js  (pure, no I/O beyond the store it's handed)
registerDetector({
  source,                      // stable id, e.g. "remote-exposure"
  // exactly one trigger:
  events?,                     // string[] of event names this detector handles
  onEvent?,                    // (eventName, payload, store) => void   (event style)
  poll?,                       // (store, ctx) => void                  (poll style)
})
// emit(eventName, payload) dispatches to every detector whose `events`
// includes eventName, calling its onEvent. (poll detectors are invoked on the
// nest health cadence instead — not used in v1.)

registerRemedy(actionId, async (args, ctx) => ({ resolved: boolean, message? }))

// A detector emits items by calling the store:
store.upsertItem({ source, dedupKey, title, why, severity, remedies, context })
store.resolveByKey(source, dedupKey)     // called when the condition clears
```

A Fix-it item's `remedies[]` entries are `{ label, actionId, args, kind }`. The
renderer turns each into a button; clicking POSTs `{actionId, args}` to the
Fix-it action route, which looks up the registered remedy and runs it.

**Why a registry, not inline calls:** a service author writes a detector + a
remedy and gets the whole surface (card, push, dedup, suppression, audit, the
Fix button) for free. The funkwhale adopter is ~30 lines; everything else is the
shared framework.

## Data model

New table (`scripts/init-db.js`), local-only (Fix-it items are per-instance
operational state, never synced):

```
fix_it_items(
  id            INTEGER PK,
  source        TEXT NOT NULL,        -- detector id
  dedup_key     TEXT NOT NULL,        -- collapses retries; UNIQUE(source,dedup_key)
  title         TEXT NOT NULL,        -- plain language
  why           TEXT,                 -- one sentence: why it matters
  severity      TEXT NOT NULL,        -- info | warn | urgent
  remedies      TEXT NOT NULL,        -- JSON [{label,actionId,args,kind}]
  context       TEXT,                 -- JSON (requesting_instance, capability, ...)
  status        TEXT NOT NULL DEFAULT 'pending',  -- pending|dismissed|resolved
  count         INTEGER NOT NULL DEFAULT 1,        -- times re-detected while pending
  suppressed_until TEXT,              -- set on "Not now"
  created_at    TEXT DEFAULT (datetime('now')),
  updated_at    TEXT DEFAULT (datetime('now'))
);
-- UNIQUE(source, dedup_key) so upsert collapses repeats.
```

`upsertItem` does `INSERT … ON CONFLICT(source,dedup_key) DO UPDATE SET
count=count+1, updated_at=now, status=CASE WHEN status='resolved' THEN 'pending'
ELSE status END` — a re-detected, previously-resolved problem reopens; a
*dismissed* one stays suppressed until `suppressed_until` passes.

## Trigger: the event chokepoint (v1)

The funkwhale detector hooks the single place every peer tool-call denial flows
through: `enforcePeerExposure` in `servers/gateway/peer-exposure.js`. It already
audits each denial (`error="not_exposed"`). On a `not_exposed` deny it will also
emit the Fix-it event `peer-exposure:denied` with `{ capability, requesting
instance, toolName }`. The framework's dispatcher routes that to the
`remote-exposure` detector, which `upsertItem`s.

`enforcePeerExposure` stays synchronous on the request path; the emit is
fire-and-forget (never blocks or breaks the gate — same discipline as the
existing audit call).

`capability` here is the resolved canonical id (`resolveProxyTool` →
e.g. `funkwhale`); `null`-canonical denials (a malformed direct call) are not
surfaced — only real, resolvable capabilities become Fix-it cards.

## Surface

- **Crow's Nest Fix-it cards.** A new section on the nest (rendered by the nest
  panel, alongside the existing health strip) lists `pending` items as cards:
  **title** in plain language, a one-line *why*, the remedy button(s), a "Not
  now", and a "details" disclosure that reveals the technical specifics
  (capability id, requesting instance) — layered disclosure, jargon hidden by
  default.
- **Push.** `severity:"urgent"` items also fire through the existing
  `servers/shared/notifications.js` (nest notification + ntfy/web-push if
  configured), so the user is reached off-dashboard. The funkwhale case is
  `warn` (visible on the nest, no push) by default — tunable per detector.

The renderer is shared: every detector's items look and behave identically.

## Remedy safety

Each remedy declares `kind`:

- **instant** — a pure config toggle. Runs on click. (Funkwhale "Allow" =
  add the capability to `remote_exposed_tools` via the same `writeSetting(db,
  "remote_exposed_tools", …, {scope:"local"})` the exposure panel uses.)
- **confirm** — needs a confirmation step (e.g. a future "Restart Funkwhale").
- **guided** — opens a flow rather than acting directly (e.g. a future
  "Reconnect Google" OAuth round-trip).

The framework enforces the `confirm`/`guided` gate in the renderer + action
route, so a destructive remedy can never be a careless one-tap. v1 ships only an
`instant` remedy.

The action route lives behind the dashboard auth + CSRF (a state-changing POST,
like every other settings write) and is **never** funnel-exposed (it's under
`/dashboard`, covered by the existing funnel invariant).

## Dedup / suppression / auto-resolve

- **Dedup:** `UNIQUE(source,dedup_key)`. The funkwhale dedupKey is
  `expose:<capability>:<requesting_instance>` — a glasses bot retrying every few
  seconds produces exactly one card (with a `count`).
- **Suppression:** "Not now" sets `suppressed_until = now + N days` (N config,
  default 7) and hides the card; a re-detect won't resurface it until then.
- **Auto-resolve:** when the funkwhale remedy runs (capability now exposed), the
  item is marked `resolved` and the card clears. The peer's next retry (≤60s)
  succeeds — self-healing, no restart. (Poll detectors auto-resolve when their
  check next passes; not built in v1.)
- **Audit:** the `fix_it_items` row itself is the trail — its
  `status` transitions (`pending → resolved | dismissed`) plus `created_at` /
  `updated_at` / `count` record what was flagged, when, and what the user chose.
  Remedy runs are also logged to the gateway log.

## The funkwhale seed (the only v1 detector + remedy)

- **Detector** `servers/gateway/fix-it/detectors/remote-exposure.js` registers
  `{ source:"remote-exposure", events:["peer-exposure:denied"], onEvent }` where
  `onEvent("peer-exposure:denied", {capability, requestingInstance, toolName},
  store)` → `store.upsertItem({ source:"remote-exposure",
  dedupKey:"expose:"+capability+":"+requestingInstance, title:`Your <peer> bot
  tried to use <FriendlyName>, but it isn't shared with this device yet`,
  why:"Share it so your other Crow devices can use it.", severity:"warn",
  remedies:[{label:"Allow", actionId:"expose-capability",
  args:{capability}, kind:"instant"}], context:{capability, requestingInstance,
  toolName} })`.
- **Remedy** `expose-capability`: reads current `remote_exposed_tools`, adds
  `capability` (idempotent), `writeSetting(..., {scope:"local"})`, returns
  `{resolved:true}`.
- **Peer name:** `<peer>` resolved from `crow_instances.name` for the requesting
  instance (falls back to "another device").

## Friendly-name map

`servers/gateway/fix-it/friendly-names.js`: a capability-id → plain-language
label map used by both the cards and (bonus) the existing exposure panel — this
is the "simplify what we already have" piece. Seed entries:

```
funkwhale     → "Music"
media         → "News & Podcasts"
crow-memory   → "Memory"
crow-blog     → "Blog"
crow-projects → "Projects"
crow-sharing  → "Sharing & Messages"
crow-storage  → "Files"
```

Unknown ids fall back to `getLocalCatalog`'s human `name` (e.g. an addon's
manifest `name`), then to the raw id. The existing
`settings/sections/remote-exposure.js` render is updated to show the friendly
label (raw id behind the details disclosure) — a small, contained change.

## Architecture / units

```
servers/shared/fix-it/
  registry.js        # registerDetector / registerRemedy / event dispatch (pure)
  store.js           # fix_it_items CRUD: upsertItem, resolveByKey, listPending,
                     #   dismiss, runRemedy (one focused DB unit)
servers/gateway/fix-it/
  index.js           # wires detectors+remedies into the gateway; exposes the
                     #   emit() the chokepoints call, and the nest render + route
  friendly-names.js  # capability id → plain label
  detectors/
    remote-exposure.js   # the v1 detector
  remedies/
    expose-capability.js # the v1 remedy
```

Touch points in existing code (small, surgical):
- `servers/gateway/peer-exposure.js` — emit `peer-exposure:denied` on a
  resolvable `not_exposed` deny (fire-and-forget).
- nest panel (`dashboard/panels/nest/…`) — render the Fix-it cards section.
- a dashboard route — POST Fix-it remedy / dismiss (auth + CSRF).
- `scripts/init-db.js` — the `fix_it_items` table.
- `settings/sections/remote-exposure.js` — use friendly labels.

Each unit has one job and a narrow interface: the registry knows nothing about
Funkwhale; the detector knows nothing about the DB shape; the renderer knows
nothing about any specific source.

## Security considerations

- Remedies run under dashboard auth + CSRF; the funkwhale remedy only ever
  *adds* to this instance's own local exposure list (no cross-instance write, no
  sync). Exposure remains opt-in — the framework makes the *decision*
  discoverable, it never auto-shares.
- The Fix-it surface and action route are under `/dashboard` and therefore
  inside the existing Tailscale-Funnel deny invariant (no new public surface).
- `enforcePeerExposure`'s deny path must remain fail-closed and unbroken; the
  emit is best-effort and wrapped so a Fix-it failure can never allow a call or
  500 the gate.

## Testing

- `registry` unit: detector registration, event dispatch to the right detector,
  remedy lookup/run.
- `store` unit: upsert dedup (same key → one row, count bumps), reopen-on-
  redetect, dismiss/suppress window, resolve clears.
- `remote-exposure` detector: a `peer-exposure:denied` event with a resolvable
  capability produces one card with the right title/remedy; a `null`-capability
  event produces none.
- `expose-capability` remedy: adds the capability to `remote_exposed_tools`
  (idempotent), marks resolved; integration-style assertion that
  `getExposedCapabilities` then contains it.
- chokepoint: `enforcePeerExposure` still denies + audits exactly as before, and
  emits once, and never throws if the Fix-it store errors.
- A focused end-to-end (gated, like existing peer tests): denied call → card
  exists → run remedy → next call for that capability is allowed.

## Out of scope (v1)

- Poll-style detectors and any detector other than remote-exposure (disk-full,
  service-down, token-expired, model-cold, backup-stale, …). The framework is
  *designed* for them; they are independent follow-ups.
- Per-peer exposure (today's model is global "any trusted peer"; the remedy
  matches that). Per-peer is a separate multi-instance (Theme 12) change.
- Cross-instance Fix-it routing — a card surfaces on the instance that owns the
  tool (here MPA), with that instance's push channel. Consolidating all of a
  user's instances' cards into one home nest is a Theme 12 follow-up.
- Auto-expose / any automatic remediation. Every fix is a human one-click.

## Future detectors (validates the abstraction; each a later follow-up)

Event: integration token expired → Reconnect; bot gateway token rejected →
Reconnect; bot/cron erroring repeatedly → Inspect/pause; model resolve/warm
failed → Turn it on; device stopped checking in → Re-pair.
Poll: backing service down → Restart; disk almost full → Clean up; backup
stale/unverified → Run a backup; "up but unreachable"/firewall → Open the port;
TLS cert expiring → Renew; update available/failed → Update; storage quota hit →
Free up; unintended public exposure → Lock down.

All fit the `{title, why, severity, remedies[]}` contract unchanged.
