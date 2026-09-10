# Perch Hub: the default chat surface for crow bots

**Status:** design, approved 2026-09-09
**Scope:** sub-project A of three (see [Scope boundaries](#scope-boundaries))

## Why

Perch Hub was deleted on 2026-08-16 (`42f39160`, `e36f26d8`) and replaced by the
bot board's roost strip plus a session drawer. The drawer is a 480px desktop
slide-over squeezed to 92vw, and on a phone it has been failing in ways that took
four separate fixes in one evening (#346, #347, #348) without becoming good:
unlabelled controls, a plan-mode label losing a specificity fight, models listed
as `provider/id`, a stringified object printed into every transcript, and a Send
button that could not be reached at all.

The operator's judgement, verbatim: *"perch hub worked a lot better and looked a
lot better. it was more mobile friendly too."* That is correct, and it is
structural rather than cosmetic. Perch Hub was a full page in normal document
flow with a viewport meta, a transcript capped at 340px scrolling inside itself,
and a composer directly beneath it. The drawer is a fixed-height container whose
last element is the thing you need most.

## The product model

Three surfaces, each with one job:

- **Perch Hub** shows every active session and is where you talk to a bot.
- **Bot Board** is the project-management board. You can optionally launch a bot
  from a card; the conversation happens in the hub.
- **Bot Builder** defines bots. Unchanged by this work.

## Decisions

| Question | Decision |
|---|---|
| Whose sessions does the hub list? | Bot sessions only, from the interactive engine. Not the old hub's on-disk pi sessions or its tmux spawner. |
| How does it ship? | Core, gateway-served. Not an installable bundle, no daemon, no second auth path. |
| What happens to the board's drawer? | Deleted. One chat surface. |
| Where does it live? | `/perch`, its own top-level page, deep-linkable as `/perch#<sessionId>`. |
| Layout | List and chat as two views. |

### Why not restore the bundle

The old hub was its own daemon on port 4210 with a `perch-token` auth file, a
gateway-supervised child process, and a reverse proxy to per-session web servers.
It was the only bundle with a supervised child, and deleting it let crow remove
that mechanism entirely. Restoring it would re-introduce port allocation, a token
file, an install step, and a second auth path that has to keep working on a phone
behind Tailscale Serve and the public front door. A gateway-served page inherits
the dashboard session, 2FA, CSRF, Serve and the front door at no cost.

### Why not keep the drawer as well

Two complete chat surfaces means every future change lands twice. The four
defects fixed on 2026-09-09 were all in one surface; duplicating it doubles that
rate permanently.

## Architecture

`/perch` is a route on the gateway, mounted behind `dashboardAuth` like every
other dashboard route. It renders its **own document** rather than the dashboard
shell. That is the point: the shell's chrome is a large part of what makes the
current surface cramped on a phone.

**The hub adds no API.** Every route it needs exists and is already covered by
`tests/perch-interactive-routes.test.js` (77 cases):

| Need | Existing route |
|---|---|
| List every live session across every bot | `GET /dashboard/perch-api/roost` |
| Start a card-less session | `POST /dashboard/perch-api/bots/<id>/interactive` |
| Drive a turn | `POST /interactive/<sid>/message` |
| Nudge a running turn | `POST /interactive/<sid>/steer` |
| Live events | `GET /interactive/<sid>/events` (SSE) |
| Answer an ask_user card | `POST /interactive/<sid>/answer` |
| Model / thinking menus | `GET /interactive/<sid>/options` |
| Abort, stop, cycle, control | `POST /interactive/<sid>/{abort,stop,cycle,control}` |
| Attach to a card | `POST /interactive/<sid>/attach-card` |
| Upload an image | `POST /interactive/<sid>/files` |
| Past transcript | `GET /bots/<id>/sessions/<threadId>/transcript` |

`GET /roost` already does the cross-bot aggregation in one pass: one query for
every bot def, one `engine.list()`, one `bot_sessions` query for `card_id` and
`control`. It was built for the roost strip and is exactly the hub's list feed.

### Components

Under `servers/gateway/dashboard/perch-hub/`, mirroring the `bot-board/` split so
it reads like its neighbours:

- **`html.js`** — the page document, the list view, the chat view. Static shell
  only; hydrated client-side, the same split `birdDrawerMarkup()` uses.
- **`css.js`** — Perch Hub's visual language, ported from the deleted
  `PERCH_CSS` + `BOTS_CSS`: mono uppercase labels, pill badges, teal accents, the
  bird glyph, `max-height:340px` transcripts. Scoped to the page, sharing crow's
  `--crow-*` tokens so themes keep working.
- **`client.js`** — hash router, list rendering, chat rendering, SSE handling.
- **`routes/perch-hub.js`** — mounts `/perch`.

## Data flow

**List view.** Fetch `/roost`, render one row per live session grouped by bot,
plus every perch-attached bot with no session (so you can start one). Poll every
10s while the list view is showing, and refresh immediately on window focus.
Stop polling while the chat view is up, where the SSE stream is already the live
signal.

**Selecting a session** sets `location.hash = <sessionId>`. The hash router is
the only view state, so deep links, back and forward all work for free.

**Chat view.** On entry:

1. `GET /bots/<id>/sessions/<threadId>/transcript` for history.
2. Attach the SSE stream.
3. Only then accept input.

Step 2 before any post is not optional: **the stream is live-only and carries no
backlog**, so a message posted before the subscription is live loses its reply.
The engine replays the session's current state onto every new subscriber, and
that replay is the only available proof the subscription is live.

**Event handling.** `state`, `text`, `tool`, `log`, `reply`, `ask_user`, `error`,
`plan_state`, `attention`. Two carry known traps: `plan_state.state` is an
**object** and must be formatted, never appended raw (the `[object Object]` bug),
and `state.turnInFlight` is false in the pre-post replay as well as at the end of
a turn, so it only counts as an ending once it has been seen true.

## Mobile

The list is the home screen. Tapping a session pushes a full-screen chat with a
back button and the composer pinned to the bottom. Above 900px the two views sit
side by side.

Rules learned the hard way on 2026-09-09 and non-negotiable here:

- `100dvh`, never bare `100vh` — `100vh` is the large viewport and hides whatever
  sits in the last strip behind the browser chrome.
- Send's reachability comes from the flex chain, not from the composer.
  `#perch-chat{flex:1;min-height:0}` and `#perch-transcript{flex:1;overflow:auto;
  min-height:0}` make the transcript the only scroller, so the page itself never
  scrolls and the composer is always on screen. `position:sticky; bottom:0` on the
  composer is a backstop that does nothing until that chain breaks — measured,
  removing it from the shipped layout moves Send by zero pixels.
  **Corrected 2026-09-10.** This bullet previously said sticky was the reason,
  which is the inverse. It was written when Perch owned the viewport at `100dvh`;
  once Perch moved inside the dashboard shell, `.content-body` took over the
  scroll and the flex chain became the mechanism. The old wording survived the
  move and would have led a maintainer to delete the load-bearing rule.
- No control is unlabelled. A row of bare dropdowns reads fine wide and becomes
  meaningless the moment it wraps.
- Full-bleed width on a phone. `min(480px, 92vw)` leaves a dead gutter.

## Error handling

| Condition | Behaviour |
|---|---|
| SSE drops | Reconnect with bounded backoff, capped at 5 attempts; the subscribe replay restores state, so nothing is rebuilt by hand. Port the drawer's logic, which is already correct. |
| `409 engine_required` | The page renders "the bot engine is not installed" with a link to Extensions, not a dead screen. |
| `403 perch_not_attached` | The bot is listed but not startable, with a link to Bot Builder. |
| Session 404s | Return to the list with a note. Never a blank chat. |
| `409 turn_in_progress` | The composer relabels to Steer, matching the drawer's existing behaviour. |
| Transcript fetch fails | Chat still opens; the pane says history could not be loaded. |

## Testing

- **Route tests** — none new; the API is unchanged and already covered.
- **Client-script parse test** — crow convention; the emitted script is a
  template literal, and an unescaped backtick in a comment breaks the module.
- **i18n EN/ES parity** plus the SSR/client key lists, both enforced by existing
  tests that fail loudly when a key is added to one and not the other.
- **Render checks over CDP** at 412px and at desktop width, asserting that the
  composer is reachable with the transcript scrolled to the **top**. That exact
  measurement is what caught the unreachable Send button; a screenshot alone did
  not.
- **`plan_state` formatting** — the live payload
  `{enabled:false,executing:false,todosDone:0,todosTotal:0,todos:[]}` must render
  as nothing at all.

## Phasing

Two PRs, each leaving a working surface.

**Phase 1 — the hub exists.** `/perch` ships and works. The board is untouched:
Talk still opens the drawer. Both surfaces are live, which is a deliberate,
temporary duplication so the hub can be used before anything is removed.

**Phase 2 — the drawer goes.** Talk and dispatch navigate to `/perch#<sid>`.
`birdDrawerMarkup`, `birdDrawerCss`, `birdDrawerJs` and their tests are deleted;
the roost strip keeps its states and its Talk control. `nav-registry.js` gains a
`perch-hub` entry in the `agents` group, beside `bot-board` and `bot-builder`.

## Scope boundaries

This spec covers the hub only. Two sibling projects were identified in the same
conversation and are deliberately **not** in it:

- **B. `bundles/bot-engine` becomes core**, so pi ships in the base install
  rather than being installed from Extensions. It changes install size, the
  vendoring and licensing story, and what every crow user downloads. The hub does
  not depend on it: it renders the `engine_required` state instead.
- **C. Onboarding provisions models by default** — local download from Hugging
  Face and cloud provider setup as part of first run. The machinery is already
  core; this is flow and defaults.

Also out of scope: the old hub's on-disk pi session list and its tmux
`/api/hub/spawn`. Those are a second session system and were not asked for.
