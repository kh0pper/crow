/**
 * Whose tab is it: the bot's, the operator's, or one nobody can prove? (2026-11-19;
 * the rule below SIMPLIFIED to a single fail-closed one, contract round 9)
 *
 * The browser this MCP drives is the operator's browser too: it is the same
 * Chromium whose screen the VNC viewer shows, so the tabs open in it are a mix of
 * tabs this MCP opened, tabs the operator opened themselves, and tabs another
 * client (a lane's own CDP tooling) created. The exit cleanup in
 * private-address.js (`blankPagesOnExit`) used to blank and close EVERY page,
 * which destroyed the operator's own work every time the MCP server restarted.
 * The operator's decision is that the cleanup cleans up only the pages this MCP
 * opened or drove, and never navigates, closes, or writes to a page it cannot
 * prove is the bot's.
 *
 * ONE RULE, and it is fail-closed by construction: a page is the OPERATOR's only on
 * POSITIVE PROOF. There are exactly three proofs, and every one of them is a fact
 * this process can still check at the moment it decides:
 *
 *   (i)   the page EXISTED when this context was attached (and no reconnect claim
 *         matched it), or
 *   (ii)  its `opener()` resolved to a page whose class is `operator`, or
 *   (iii) its `opener()` said nothing, and the CDP `openerId` equals the target id
 *         of a LIVE page classed `operator` — resolved ON DEMAND at that moment
 *         (bounded by `TARGET_LOOKUP_TIMEOUT_MS`), never at attach.
 *
 * A page that arrived with NO `openerId` at all (a successful lookup that answered
 * none) and was not made through `newPage` is an INDEPENDENT tab: `uncertain`, left
 * alone — unless it appeared within `botActionWindowMs` of the latest bot action, in
 * which case it is BOT (see the window below: a ctrl-clicked or middle-clicked tab is
 * exactly this shape). A popup of an `uncertain` page is `uncertain` too — nothing more
 * can be proven about a window than about the page that opened it.
 *
 * EVERYTHING ELSE that arrives while attached is BOT: an `openerId` nobody can
 * prove, a lookup that failed or timed out, the `openerId` of a closed operator
 * page, an `openerId` the id table does not hold, an opener whose own class nothing
 * knows. A bot mark never downgrades, a mark lands SYNCHRONOUSLY (so it wins its
 * race with the "page" event, which a real context emits DURING `newPage()`), and an
 * event classification never overwrites a class that already exists.
 *
 * WHY FAIL CLOSED BY CONSTRUCTION. The alternative — deciding an unprovable page is
 * the operator's — is a page of the bot's left running after this process exits,
 * with the private-address routes that refused the operator's LAN gone with it. So
 * "cannot tell" must be the bot's, and the operator's side is protected not by
 * guessing in their favour but by the three proofs above, which cover every page the
 * operator can actually be shown to have in hand.
 *
 * THE LIMITS THAT ARE ACCEPTED, recorded on purpose, because they are the price of
 * that construction:
 *
 *   - An OPERATOR popup whose operator opener tab closed FIRST is cleaned up at turn
 *     end: its `openerId` names a tab that is no longer live, so proof (iii) cannot
 *     be had and nothing else proves it either.
 *   - Any page created in the operator's VNC browser with an `openerId` this process
 *     cannot prove is cleaned up for the same reason.
 *   - An operator's FRESH VNC tab (Ctrl+T, a new window from the browser's own UI) has
 *     no `openerId` at all, so it answers "independent tab" and stays `uncertain`, left
 *     exactly as an operator page is — but a fresh tab that arrives while a bot TOOL CALL
 *     is running, or within `botActionWindowMs` after one ended, is cleaned up at turn
 *     end: no argument tells a ctrl-click from the bot's own click, and the clock (plus
 *     the call's own start and end) is all that is left. A tool call that runs a long time
 *     claims every fresh tab until it returns (see the next bullet).
 *   - THE WINDOW IS ANCHORED TO THE WHOLE TOOL CALL, not to one mark. An action begins
 *     when a tool handler starts (`beginBotAction`, installed around every handler) and
 *     ends when the handler is DONE — its promise settled, or, for a handler that answers
 *     synchronously, when it returned or threw (`endBotAction`) — and every arrival with no
 *     opener and no `openerId` inside that span — or just after it — is the bot's. A call that
 *     runs for a minute therefore claims an operator's fresh tab opened in its last
 *     second: that is the price of catching a tab the bot's own slow click produced.
 *   - AN ACTION IS ENDED BY ITS OWN END, AND ONLY BY IT. `beginBotAction` hands back a token
 *     and `endBotAction(token)` ends exactly that action (with no argument it ends the oldest
 *     open one); the tool-dispatch wrapper holds its own token and ends its action exactly
 *     once — when the handler's promise settles, or, for a handler that answers synchronously,
 *     when it returned or threw. NOTHING ON A CLOCK ENDS IT: a tool call that runs a long time
 *     claims every fresh tab until it returns. That is fail closed on purpose — a tab the
 *     call's own slow click produces must not arrive after the action that would claim it —
 *     and the tools' own schema bounds are what keep ordinary waits well under five minutes.
 *     The mirror image is accepted: a tab a genuinely slow click produces late in a very long
 *     call is claimed as the bot's even though the operator may have opened it.
 *   - A LANE's CDP tab (`Target.createTarget`: no opener, no `openerId`) that appears
 *     inside the window, or during a running bot tool call, is cleaned up at turn end for
 *     the same reason: it has the very shape the window claims.
 *   - TOUCHING A PAGE THE OPERATOR ALSO USES COSTS THE OPERATOR THEIR OPENER TAB. When
 *     the bot drives a popup the operator opened, the popup's opener chain follows (see
 *     "relatives" below) — so the operator's own tab that opened it is cleaned up at
 *     turn end, even though the operator was using it. A script in the bot-driven page
 *     can reach that opener through `window.opener`, and a script that outlives the turn
 *     is exactly what the cleanup exists to stop.
 *   - SIBLING POPUPS OF AN ANCESTOR GO TOO. The connected opener/popup component is the
 *     bot's once one of its pages is driven, and an ancestor that is marked also reaches
 *     the OTHER windows it opened — so a sibling of the bot-driven popup is cleaned up at
 *     turn end although the bot never touched it (a script in the driven page reaches it
 *     through `window.opener` just the same).
 *   - A WALK NO LONGER WAITS FOR THE WHOLE BROWSER, IT WALKS WITH WHAT IT HAS. A relatives
 *     walk waits only for the touched page's OWN arrival classification plus the ones a
 *     relation already ties to it — an unrelated tab whose `opener()` and `openerId` are each
 *     a slow round trip used to starve that wait, and the walk was then SKIPPED entirely, so
 *     the popup of the page the bot had just driven stayed the operator's. Now the walk runs
 *     anyway when the wait times out, counts itself INCOMPLETE, and the page is walked again
 *     at its next touch. A walk that COMPLETED is never repeated, and one touch is one walk of
 *     the component: the relations a walk learns are recorded without being acted on, so they
 *     cannot start a second walk over the same pages.
 *   - AN INCOMPLETE WALK AT SETTLE IS FAIL-CLOSED FOR THE WHOLE SCANNED CONTEXT. A walk that
 *     runs out of time, hits the depth cap, or cannot read a page proves nothing about the
 *     pages it never answered for, so `settle()` marks BOT every live page of the scanned
 *     context that the walk neither reached nor answered "unrelated" for. The cost: an
 *     operator tab whose `opener()` hangs is cleaned up at turn end, like every other page the
 *     fail-closed rule cannot prove.
 *   - ONE WALK DEADLINE PER BATCH (`WALK_DEADLINE_MS`, 1500 ms — deliberately under the exit
 *     budget of 2000 ms). A walk that starts while another is still running takes the SAME
 *     deadline, and no walk starts another (a relation landing is recorded, not acted on by
 *     the walk itself). `settle()` takes its RE-RUN deadline AFTER the classifications it waits
 *     for — a deadline taken before that wait is already spent when the re-run starts — and it
 *     re-walks only a page whose walk never got out of the page itself: a walk that already
 *     reached part of the component is failed closed instead of walked again, because asking
 *     the same slow pages a second time spends the exit budget twice over.
 *     `settle({ budgetMs })` (the exit cleanup hands in what is left of its own) caps the wait
 *     AND the re-run, and whatever it did not walk is failed closed when the budget is spent.
 *   - A RECONNECT after a bot mark whose target id never resolved cleans unmatched
 *     tabs: no id can be matched, so no tab can be proven NOT to be the bot's.
 *   - ONE UNANSWERED `opener()` AT EXIT COSTS EVERY OPERATOR POPUP IN THE SCANNED CONTEXT.
 *     The cleanup sweep is broad once any lookup is slow: a relatives walk that cannot
 *     finish (or a settle that runs out of budget) has proven nothing about the pages it
 *     never answered for, so every live page of the scanned context the walk did not reach
 *     and did not answer "unrelated" for is treated as the bot's. That is fail-closed on
 *     purpose: the alternative is a page of the bot's left running unguarded after this
 *     process is gone, and no evidence can tell the two apart.
 *   - RECORDING AN `openerId` RELATION CAN DELAY AN ALREADY-CLASSED PAGE BY UP TO A SECOND.
 *     `recordOpenerIdRelation` asks the browser for the opener's target info, bounded by its
 *     own lookup timeout, so a page whose class is already decided can still have that work
 *     in flight; a walk that waits for the relation therefore waits on it. The wait is
 *     bounded, and a lookup that does not answer leaves the relation unrecorded, which is a
 *     fail-closed outcome and not a wrong one.
 *   - EVERY WAIT PARAMETER IS BOUNDED BY ITS SCHEMA. The wrapper has no timer, so a call that
 *     runs a long time claims every fresh tab until it returns (fail closed on purpose); what
 *     keeps that from being the ordinary case is the schema. `timeout_ms`
 *     (`crow_browser_wait_for`, `crow_browser_download`), `wait_after` (`crow_browser_click`)
 *     and `scroll_pause_ms` (`crow_browser_scroll_extract`) are integral, non-negative and
 *     capped below the tool action limit (`DEFAULT_MAX_TOOL_ACTION_MS`, five minutes, minus a
 *     5000 ms margin; `scroll_pause_ms` at 10000 ms), so a genuinely longer wait is refused by
 *     the schema instead of being run with tabs that stop being claimed.
 *
 * Nothing here destroys a page on suspicion of anything weaker than the absence of
 * all three proofs — but it does act on that absence, and the cases above are what
 * that costs.
 *
 * Two marks, both permanent (a mark can only ever move a page TO the bot):
 *
 *   markOpened(page)   this MCP created the page (`ownership.newPage`).
 *   markTouched(page)  the bot drove the page — a tool call selected it and ran
 *                      on it, so whatever the page holds from then on is this
 *                      MCP's doing. The adopted page 0 counts as touched from the
 *                      first tool call: ensureConnected already installed blocked
 *                      URLs and a stealth init script on it.
 *
 * The mark LANDS synchronously and it RETURNS the promise of the CDP lookup that
 * remembers the page's target id (`null` when the id could not be had). A caller may
 * ignore it (a tool call must not wait on a round trip); `newPage` awaits it, so a
 * page this MCP created can be claimed by a reconnect that happens immediately
 * afterwards.
 *
 * TOUCHING A PAGE ALSO TOUCHES ITS RELATIVES. Through `window.opener` a bot-driven page
 * can script the tab that opened it — and that script outlives the turn, in an OPERATOR
 * tab. So `markTouched` marks the page's whole opener chain (transitively upward) and
 * every popup it opened (transitively downward) BOT, permanently, through the same
 * `markBotPage` every BOT decision takes. The relations are learned as arrivals are
 * classified (`opener()` resolving to a page object, the synchronous `popup` listener,
 * the CDP `openerId`), and a relative known ONLY by `openerId` is resolved against the
 * LIVE pages at that moment (each lookup bounded). A relation that lands LATE still acts:
 * when one end of it is already the bot's (touched, or already walked) the other end is
 * marked at that moment. `markOpened` and the arrival/popup marks do NOT reach relatives
 * by themselves: creating a page says nothing about the tab it came from.
 *
 * The walk follows the WHOLE CONNECTED COMPONENT, upward and downward at every node: the
 * recorded relations, the CDP `openerId`, and ONE live `opener()` call per page that has
 * nothing recorded — which is all a page that existed at attach has (B1: the popups it
 * had already opened; B2: the chain above it, to the root; B4: the sibling popups of an
 * ancestor). ONE live `opener()` is asked per page per walk (a page asked as a candidate keeps
 * its answer when it later becomes a node), a level's live candidates are resolved IN
 * PARALLEL with each answer acted on as it arrives, and the walk has ONE deadline — the same
 * one for every walk of a batch, and the one `settle()` passes down. It waits, bounded, for
 * the arrival classifications it can actually use (the touched page's own, and those of pages
 * a relation already ties to it), and when that wait runs out it walks with what it has and
 * counts itself INCOMPLETE instead of being skipped. The relations it learns are recorded
 * WITHOUT being acted on: the walk itself marks what it reaches, which is what keeps one touch
 * to one walk. It is tracked so `settle()` waits for it, skips closed pages, uses a visited
 * set so a chain cannot loop, never throws, and is remembered as DONE only when it COMPLETED: a
 * walk left unfinished by a failed or timed-out lookup is retried by `settle()` (once) and at
 * the page's next touch, while a complete one is never repeated (50 touches are one walk).
 *
 * THE BOT-ACTION WINDOW. A live probe in Chromium: a ctrl-clicked or middle-clicked tab
 * arrives with `opener()` null AND no `openerId` at all (and a lane's
 * `Target.createTarget` tab has the same shape), while target=_blank, rel=noopener,
 * window.open(noopener) and COOP popups all carry an `openerId` naming the opener. So the
 * one shape with no evidence at all is also the shape the bot's own clicking produces,
 * and nothing but TIME tells it apart from another client's tab. What is timed is the
 * ACTIONS: `beginBotAction`/`endBotAction` bracket every tool handler (a call's END is
 * the latest stamp), and `markTouched`, `markOpened` and `newPage` stamp as well. An
 * arrival with no `openerId` is BOT when, per a SNAPSHOT TAKEN WHEN THE PAGE ARRIVES, an
 * action was IN PROGRESS then (however long it had been running: a slow click's tab
 * arrives at the END, not at the start) or the arrival landed within `botActionWindowMs`
 * (default 5000; a non-finite or negative value means the default) after the latest stamp
 * the snapshot saw. The snapshot is read at the "page" event and NEVER re-read at
 * decision time, so a tool call that starts or ends while a slow lookup is in flight
 * cannot move the window over an arrival that was already there; and the proofs are
 * decided first, so an `openerId` that names a live operator page is still the
 * operator's, whatever the clock says. With no bot action ever, the window claims
 * nothing.
 *
 * A BOT PAGE THAT CLOSES WHILE ITS ID LOOKUP IS IN FLIGHT STILL HAS ITS ID RECORDED
 * if the lookup resolves: the mark is kept, the answer is taken, and the tab is
 * remembered by id. A popup of that page is then the bot's by proof (iii) — the
 * alternative, dropping the id because the page is gone, would leave its popups
 * provable by nothing at all. When the lookup never resolves, the popups of that page
 * fall to the fail-closed half of the rule above, which is the answer for every
 * unprovable arrival anyway.
 *
 * AN UNRESOLVED MARK STAYS COUNTED for the life of the process. There is no release
 * on close: a tab that comes back on a reconnect arrives as a NEW Page object, and a
 * mark whose id never resolved could be exactly that tab. While at least one such
 * mark stands, a reconnect cannot match any page by id, so it can prove none of them
 * is NOT the bot's and every page its remembered ids do not claim is BOT. (The old
 * rule tried to release a mark when the page closed while the browser was still
 * connected, reading `page.context().browser().isConnected()` — and a persistent
 * context reports `context.browser() === null`, which is the shape this MCP actually
 * connects to, so "was the browser still up?" had no answer at all. The machinery
 * was removed rather than patched: one rule, no exceptions to reason about.)
 *
 * PENDING CLASSIFICATION WORK IS NOT BOT WORK BY ITSELF. `pending()` says whether a
 * classification or lookup is still in flight; the exit cleanup's budget
 * (private-address.js) reads it together with `botPageCount()` and
 * `unresolvedMarks()`, and counts the pending work as the bot's ONLY while one of
 * those is above zero (or a bot page was seen in the cleanup's first look). With
 * no bot page marked and nothing unresolved, an in-flight `opener()` is an OPERATOR
 * arrival's — nothing of the bot's is known and nothing is armed, so a budget that
 * expires on it must not crash the operator's browser. When the ownership cannot
 * report those two counts at all, the budget keeps its old, fail-closed answer.
 *
 * TWO PENDING QUESTIONS, NOT ONE. `pending()` is that wide question (any tracked
 * classification or lookup). `classifying()` is the NARROW one: an arrival whose verdict
 * is being decided, a reconnect CLAIM, a relatives walk, or an `openerId` relation lookup
 * that marks its counterpart — the work that can still change a page's CLASS. The exit
 * cleanup reads `classifying()` to decide whether the page list it has is FINAL
 * (private-address.js `classificationsInFlight`): a batch of target-id lookups a
 * fail-closed walk started cannot change a class, and crashing the browser over them used
 * to destroy a page list that was already complete.
 *
 * THE NARROW COUNT IS KEPT BY `track()` ITSELF (`track(promise, kind)`), not by a hand-kept
 * counter next to each call. The hand-kept one counted arrivals and walks ONLY, so a
 * reconnect CLAIM (which `setClass`es its page) and an `openerId` relation lookup (which
 * marks the counterpart it resolves) both left it reading false while a page's class was
 * still being decided — a page list the cleanup would then treat as final. The DEFAULT kind
 * counts, so a new tracked path cannot be left out by forgetting a bump; the explicit
 * `"lookup"` kind is the opt-out for the bookkeeping that decides no class
 * (`rememberTarget`'s target-id lookup), and the count is given back in a `finally`
 * whichever way the promise settled. `classifying()` is ALSO true while a LIVE page with no
 * class yet has an entry in `arrivals`, as belt and braces.
 *
 * Those two counters are the ownership's REPORTING SEAMS, and they live on the
 * ownership's prototype rather than on the object itself: a shallow copy of an
 * ownership (a wrapper, a test double built by spreading it) carries the own
 * properties only, and a copy that cannot report its counters must not be read as
 * one that has accounted for nothing. `classifying()` is a plain method next to
 * `pending()`; a copy that lacks it is read through `pending()` instead (the wider,
 * fail-closed answer).
 *
 * A SYNCHRONOUS POPUP LISTENER, exactly one per bot page. Every path that decides BOT
 * goes through ONE function (`markBotPage`), which installs
 * `page.on("popup", (popup) => markBot(popup))` with no await in between: `opener()`
 * is a round trip, and a popup's opener TAB may already be gone by the time the
 * answer comes back, so a popup whose owner could only be resolved later would be
 * classified from nothing. The listener is guarded (`page.on` may be absent) and
 * never throws; a page that cannot carry one is decided by the rule above, weaker
 * but never wrong.
 *
 * CDP SESSIONS. Two paths here open a short-lived session and detach it again
 * immediately, reading ONLY `Target.getTargetInfo`: `attachContext` reads a page's
 * target id (a reconnect has to match the same tabs, which come back as new Page
 * objects), and an arrival with no `opener()` asks the browser two things — the
 * page's own `openerId`, and, for proof (iii), the target id of each LIVE page classed
 * `operator`. None of them navigates, closes, blocks or writes to the page, every one
 * of them is bounded by `TARGET_LOOKUP_TIMEOUT_MS`, and a session that cannot be
 * opened is simply no evidence at all.
 *
 * Three classes:
 *
 *   bot         marked above, or any arrival no proof covers (see the rule).
 *   operator    a page one of the three proofs covers. It changes hands only when the
 *               bot reaches it: directly (`markTouched`), or as a RELATIVE of a page the
 *               bot drove (the opener chain upward, the popups downward). Driving an
 *               UNRELATED tab leaves it the operator's.
 *   uncertain   an INDEPENDENT tab: it appeared after the context was attached, was
 *               not created through `newPage`, its `opener()` is null or throws, and
 *               its CDP target names NO `openerId`, and it appeared OUTSIDE the
 *               bot-action window. Another CDP client's tab (lane A's
 *               `Target.createTarget` makes a tab with no opener — this MCP never
 *               asked for it), or one the operator opened themselves (Ctrl+T) after
 *               the bot had stopped acting.
 *
 * An UNCERTAIN page is left exactly as an operator page is: no deny-all session,
 * no navigation, no close, and one `console.error` line at exit naming the count
 * (private-address.js owns that line, with the rest of the exit report). The reasons,
 * in the cleanup's terms:
 *
 *   - A deny-all Fetch session dies WITH this process, so leaving one attached
 *     protects nothing after the exit — it is not an option for a page we cannot
 *     prove is the bot's.
 *   - A block that would survive us (`Network.setBlockedURLs`) would leave an
 *     operator tab, or lane A's tab, permanently dead: every later request in
 *     that tab refused by the browser's own network stack, with nothing left to
 *     remove it.
 *   - Closing or blanking it would destroy a tab we cannot prove is the bot's,
 *     which is the whole failure this change exists to stop.
 *
 * RESIDUAL RISK, recorded on purpose and narrow BECAUSE the rule fails closed: the
 * only page left alone without a guard after the exit is an INDEPENDENT tab that arrived
 * OUTSIDE the bot-action window — no opener and no `openerId`, so no page in this browser
 * opened it, and nothing here can attribute it to the bot. Every other arrival is the
 * bot's unless a proof covers it.
 * Both directions are guesses in the cases listed under "limits" above; the asymmetry
 * is deliberate: a page of the operator's cleaned up at turn end costs an action, a
 * page of the bot's left armed costs the private-address guarantee.
 *
 * LANE A's CDP TAB: a lane (its own tooling, `cdp.mjs`) attaches raw to a tab it
 * created itself with `Target.createTarget`; this MCP never drives that tab, so it
 * is the operator class — it existed before the ownership attached, or it appeared
 * later with no opener and is `uncertain` (outside the bot-action window; inside it,
 * see the accepted limit above). Both are left alone. It becomes the bot's when the
 * bot actually touches it, which is the same rule as any other tab the operator
 * opened.
 *
 * A RECONNECT (Playwright reconnects to the same Chromium, or the browser is
 * restarted and re-attached) hands out NEW Page objects for the SAME tabs, so a
 * WeakMap keyed on the page alone would forget everything. Each bot mark therefore
 * also remembers the page's CDP TARGET ID — stable for the life of a tab — resolved
 * lazily (`Target.getTargetInfo` over a session from the page's own context,
 * detached immediately; a failure is swallowed and simply remembers nothing) and
 * tracked so `settle()` can wait for it. Bot target ids are NEVER evicted: an id
 * dropped to save memory is a proof this process can no longer produce, i.e. a popup
 * of the bot's that would be cleaned up as the operator's. `attachContext(newContext)`
 * re-marks the pages whose target id is one the bot already owns, and claims nothing
 * else — unless a mark's id never resolved, in which case no page of that context can
 * be proven not to be the bot's and they all fail closed.
 *
 * The target-id lookup is bounded (`TARGET_LOOKUP_TIMEOUT_MS`): a tool call awaits
 * a mark's promise (`getPage` in server.js), so a stuck CDP session must not be able
 * to hold it. A lookup that runs out counts as unresolved, which is only ever the
 * fail-closed direction.
 *
 * UNCLASSIFIED IS NOT THE SAME AS PROVEN. `classify` (and `classOf` behind it) answers
 * `operator` for a page object this ownership has never seen. That is a DEFAULT for
 * objects no classification has reached yet — the state of a page nobody has looked at,
 * not a proof — and it exists so a caller reading a class cannot get `undefined`. The
 * exit cleanup is what acts on a class, and it reads the pages only after `settle()`,
 * so an unclassified page is one whose classification never even started: a context whose
 * `on` threw (no "page" listener at all) leaves every later arrival that way, and those
 * arrivals are simply never marked — left alone, never closed. That is deliberate: the
 * listener is the only path that classifies a page while the turn runs, and a context
 * that cannot carry one is a weaker guarantee, never a wrong one — the pages that existed
 * at attach are still claimed by id, and a page the bot makes through `newPage` is still
 * marked synchronously.
 *
 * NOTHING HERE THROWS. A mark on something that is not a page, an `opener()` that
 * rejects, a CDP lookup that fails, a context that offers no `newCDPSession`: each
 * is swallowed (the lookup failures through `log`, which the server wires to
 * `console.error`), because a page-classification problem must never take the MCP
 * server down.
 */

/**
 * How long ONE lookup a classification waits on may take: a bot mark's target id, a
 * page's CDP `openerId`, a run of on-demand operator target ids, or a page's
 * `opener()`. A tool call awaits a bot mark's promise (getPage), and `settle()` — and
 * so the exit cleanup behind it — awaits every classification, so a session that never
 * answers must not be able to hold either: a lookup past this counts as no answer at
 * all (which is only ever the fail-closed direction, and for a mark it counts as
 * unresolved).
 */
const TARGET_LOOKUP_TIMEOUT_MS = 1000;
/** How many settle rounds one `settle()` runs: a round can start another. */
const MAX_SETTLE_ROUNDS = 10;
/**
 * FIX3's default window, in ms: how long after a bot action an arrival with no
 * `opener()` and no `openerId` still counts as the bot's (a ctrl-clicked or
 * middle-clicked tab has exactly that shape in a real Chromium).
 */
const DEFAULT_BOT_ACTION_WINDOW_MS = 5000;
/**
 * The tool action limit, in ms: the ONE number every wait/timeout schema in server.js takes its
 * bound from.
 *
 * It does NOT end an action: the tool-dispatch wrapper has no timer, so an action stays open
 * until its handler settles (or returns), however long that takes — a call that runs long keeps
 * claiming every fresh tab until it returns, which is fail closed on purpose. What keeps that
 * off the ordinary path is the SCHEMA: every wait parameter is capped below this number (minus
 * a written-out margin), so nobody can ask a tool to wait longer than the action bracketing it
 * can hold. One number, so the schemas and this limit cannot drift apart.
 */
export const DEFAULT_MAX_TOOL_ACTION_MS = 300000;
/** How many links one relative chain may be followed for (a visited set stops loops). */
const MAX_RELATIVE_DEPTH = 100;
/**
 * How long a BATCH of relatives walks may take, overall: it awaits arrival classifications and
 * target-id lookups, so a browser that stops answering must not be able to keep it — or
 * `settle()`, or the exit cleanup behind it — waiting. ONE deadline is shared by every walk of
 * a batch (a walk that starts while another runs takes the same one, and a walk `settle()`
 * starts passes it down), so chained walks cannot add up: the whole of it stays under the exit
 * cleanup's 2000 ms budget. Whatever is unfinished when it passes leaves the walk INCOMPLETE,
 * which `settle()` retries once and then fails closed on.
 */
const WALK_DEADLINE_MS = 1500;

/** The three classes, spelled once. */
const BOT = "bot";
const OPERATOR = "operator";
const UNCERTAIN = "uncertain";

/** Detach a CDP session without letting its failure matter. */
async function detachQuietly(cdp) {
  if (!cdp || typeof cdp.detach !== "function") return;
  try {
    const detached = cdp.detach();
    if (detached && typeof detached.catch === "function") await detached.catch(() => {});
  } catch { /* already gone: nothing to release */ }
}

/** True for the objects a class map can be keyed on. */
function usable(value) {
  return Boolean(value) && (typeof value === "object" || typeof value === "function");
}

/**
 * `promise`'s value, or null once `TARGET_LOOKUP_TIMEOUT_MS` has passed. Never
 * rejects, and the timer never keeps the process alive: a session that stops
 * answering (a CDP send, a page's `opener()`) must not be able to hang a tool call,
 * `attachContext()` or `settle()`. `null` is "no answer": every caller treats it as
 * no evidence, never as an answer.
 */
function withLookupTimeout(promise) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), TARGET_LOOKUP_TIMEOUT_MS);
    if (typeof timer.unref === "function") timer.unref();
    Promise.resolve(promise).then(
      (value) => { clearTimeout(timer); resolve(value); },
      () => { clearTimeout(timer); resolve(null); },
    );
  });
}

/**
 * The same bound as `withLookupTimeout`, with the OUTCOME kept: `{ ok: true, value }` when
 * the promise answered, `{ ok: false, timedOut }` when it never did. The relatives walk
 * needs the difference — "the page says it has no opener" is an answer, "nothing
 * answered" leaves the walk incomplete — and `withLookupTimeout` answers `null` to both.
 * Never rejects, and never keeps the process alive.
 */
function lookupWithin(promise, ms = TARGET_LOOKUP_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, timedOut: true, value: null }), ms);
    if (typeof timer.unref === "function") timer.unref();
    Promise.resolve(promise).then(
      (value) => { clearTimeout(timer); resolve({ ok: true, timedOut: false, value }); },
      () => { clearTimeout(timer); resolve({ ok: false, timedOut: false, value: null }); },
    );
  });
}

/**
 * A walk's SINGLE deadline: `detailed` (a promise of a `{ ok, … }` answer) once it answers
 * before `deadline`, and `{ ok: false }` when the deadline passed first or the promise
 * rejected. Never throws and never keeps the process alive, so one unfinished lookup can
 * never outlive the walk it belongs to.
 */
function withinDeadline(detailed, deadline) {
  const remaining = Math.max(0, deadline - Date.now());
  return new Promise((resolve) => {
    let settled = false;
    const finish = (answer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(answer && typeof answer === "object" ? answer : { ok: false });
    };
    const timer = setTimeout(() => finish({ ok: false }), remaining);
    if (typeof timer.unref === "function") timer.unref();
    Promise.resolve(detailed).then(finish, () => finish({ ok: false }));
  });
}

/**
 * Create the page-ownership record for ONE MCP process.
 *
 * The object is stateful and single-instance per browser connection: create it
 * once (the browser server does, in its closure) and hand the same object to
 * `markTouched`/`markOpened`/`newPage`, to `attachContext` on every (re)connect,
 * and to `blankPagesOnExit({ ownership })`.
 *
 * @param {{log?: (line: string) => void, botActionWindowMs?: number}} [options] `log`
 *   receives diagnostics (nothing routine: a classification that failed unexpectedly).
 *   Never throws out of the ownership, so it must not throw either.
 *   `botActionWindowMs` is how long after a bot action a tab with no opener and no
 *   `openerId` still counts as the bot's (default 5000; a non-finite or negative value
 *   means the default). There is no cap on how long an ACTION may stay open: it ends with its
 *   own `endBotAction` — for the tool-dispatch wrapper, when the handler settles or returns —
 *   and nothing on a clock ends it.
 * @returns {{
 *   markOpened: (page: object) => Promise<string|null>|undefined,
 *   markTouched: (page: object) => Promise<string|null>|undefined,
 *   beginBotAction: () => * ,
 *   endBotAction: (token?: *) => void,
 *   classify: (page: object) => "bot"|"operator"|"uncertain",
 *   newPage: (context: object) => Promise<object>,
 *   attachContext: (context: object) => Promise<void>,
 *   settle: (options?: {{budgetMs?: number}}) => Promise<void>,
 *   pending: () => boolean,
 *   classifying: () => boolean,
 *   botPageCount: () => number,
 *   unresolvedMarks: () => number,
 * }}
 */
export function createPageOwnership(options = {}) {
  const asked = usable(options) ? options : {};
  const logLine = typeof asked.log === "function" ? asked.log : () => {};
  const windowAsked = Number(asked.botActionWindowMs);
  /** FIX3's window: a non-finite or negative value is no window and means the default. */
  const botActionWindowMs = Number.isFinite(windowAsked) && windowAsked >= 0 ? windowAsked : DEFAULT_BOT_ACTION_WINDOW_MS;
  const log = (message) => {
    try {
      logLine(message);
    } catch { /* a logger that throws must not break a classification */ }
  };

  /** page -> "bot" | "operator" | "uncertain" (the single source of truth). */
  const classes = new WeakMap();
  /** page -> the promise of its CDP target id (started by a bot mark: resolved once). */
  const targetLookups = new WeakMap();
  /**
   * page -> its CDP target id, once ANYTHING has resolved it: the cache proof (iii), the
   * relatives walk and a mark's own lookup all read. A tab's target id is stable for its
   * life, so re-reading it would be a round trip for a fact that cannot change.
   */
  const targetIds = new WeakMap();
  /** Pages that already carry the synchronous `popup` listener (once each). */
  const popupListeners = new WeakSet();
  /** CDP target ids of the bot's pages — NEVER evicted (proof (iii) depends on them). */
  const botTargets = new Set();
  /**
   * page -> the page that OPENED it, learned while arrivals are classified (`opener()`
   * resolved to a page object, or the synchronous `popup` listener). The upward half of
   * the relative relation a touch follows.
   */
  const openerPages = new WeakMap();
  /** page -> the Set of pages it opened: the same relations, downward. */
  const popupPages = new WeakMap();
  /**
   * page -> the CDP `openerId` its target info answered: the relation for a popup whose
   * opener TAB is gone (or whose `opener()` a COOP boundary severed). A relative known
   * only this way is resolved against the LIVE pages at touch time.
   */
  const openerIds = new WeakMap();
  /** Pages whose relatives have already been walked: a touch reaches them ONCE. */
  const relativesWalked = new WeakSet();
  /**
   * Pages the bot DROVE (`markTouched`). A relation that lands after the touch has to act
   * at that moment: the page's counterpart (its opener, its popup) is reachable through
   * `window.opener` from a page this process drove, so it is the bot's too.
   */
  const touchedPages = new WeakSet();
  /**
   * The same touched pages, in a list `settle()` can iterate: its ONE re-run walks exactly the
   * pages the bot drove that are not walked yet. A `WeakSet` cannot be iterated, and the list
   * is pruned of closed pages whenever `settle()` reads it (a closed page has nothing left to
   * walk, and its relations are already recorded).
   */
  const touchedForSettle = new Set();
  /**
   * THE ONE WALK DEADLINE (M1): the `Date.now()` deadline shared by every walk of the current
   * batch, 0 when no walk is running. A walk that starts while another runs takes it as it is,
   * so chained walks cost one deadline between them instead of one each.
   */
  let walkBatchDeadline = 0;
  /** How many walks of the current batch are in flight (the deadline is released at zero). */
  let walksRunning = 0;
  /**
   * How many `settle()` calls are driving walks right now. While one is, a relation that lands
   * does not START a walk (`actOnRelation`): a walk spawned from inside settle would take its
   * own deadline and stretch settle past the exit budget (M1). It still MARKS what it proves.
   */
  let settlesDrivingWalks = 0;
  /**
   * page -> the relatives walk RUNNING for it right now. One walk per page at a time, and
   * `relativesWalked` is set only when one COMPLETES: a walk left unfinished (a failed or
   * timed-out lookup) is retried at the page's next touch.
   */
  const walksInFlight = new WeakMap();
  /** Pages this MCP created (`markOpened`, `ownership.newPage`) — never "independent". */
  const openedByUs = new WeakSet();
  /**
   * `Date.now()` of the last bot action — the END of a tool call (`endBotAction`), or a
   * `markTouched`/`markOpened`/`newPage`. FIX3's window reads it THROUGH THE SNAPSHOT a
   * page's event takes, never at decision time.
   */
  let lastBotActionAt = null;
  /**
   * The OPEN bot actions, one entry per action, keyed by the token `beginBotAction` handed
   * back: a tool call ends ITS OWN action with its token (F3, round 12), so ending one action
   * can no longer end another. Insertion order is the order the actions began, which is what
   * an `endBotAction()` with no token removes (the oldest open one). An action stays open for
   * as long as it is open: there is no cap on the arrival side any more, because a cap there
   * dropped the tab of a call that was still RUNNING (a fail-open).
   */
  const openActions = new Map();
  /** The next action token: an opaque number, unique for the life of this ownership. */
  let actionSequence = 0;
  /**
   * page -> the state of the LAST walk of it that did not complete: what that walk reached
   * (`seen`), what it answered "unrelated" for, and whether it ever got out of the page it
   * started on (`reached`). `settle()` reads it to decide whether a page is worth walking
   * again (a walk that never left the touched page) or has to be failed closed instead.
   */
  const walkScans = new WeakMap();
  /**
   * How many bot marks have a target-id lookup still on its way. A reconnect reads it
   * together with `unresolvedBotMarks`: a mark that is merely PENDING is not resolved, so
   * it can be any tab, and the reconnect has to fail closed on every page its remembered
   * ids do not claim.
   */
  let pendingMarkLookups = 0;
  /**
   * How many pages in this process's memory are the bot's. The `openerId` lookup runs
   * only when there is at least one: with nothing of the bot's owned, an arrival can
   * be nobody's popup, so nothing is attributed and no CDP session is opened.
   * Reported by `botPageCount()`, which the exit cleanup's budget reads.
   */
  let botPagesCounted = 0;
  /**
   * Bot marks whose target id could NOT be resolved, for the life of the process.
   * While this is above zero a reconnect cannot match any page by id, so it can prove
   * none of them is not the bot's: every page a remembered id does not claim is BOT.
   * Reported by `unresolvedMarks()`, which the budget reads.
   */
  let unresolvedBotMarks = 0;
  /**
   * The pages currently counted in `unresolvedBotMarks`, so a RETRY that succeeds
   * takes its page back out of that count (the count is per unresolved MARK, not per
   * failed attempt: one page retried twice must not count twice).
   */
  const unresolvedPages = new WeakSet();
  /** page -> its in-flight arrival classification, so an opener chain can wait for it. */
  const arrivals = new WeakMap();
  /** Contexts already attached: attaching one twice must not add a second listener. */
  const attached = new WeakSet();
  /** The context most recently attached (the one a page of ours belongs to). */
  let currentContext = null;
  /** Every classification/lookup promise in flight, for `settle()`. */
  const inFlight = new Set();
  /**
   * How many TRACKED CLASSIFICATIONS are running right now (`track(promise)`, the default
   * kind): an arrival whose verdict is still being decided, a reconnect CLAIM, a relatives
   * walk, or an `openerId` relation lookup that marks its counterpart. This is the narrow
   * question `classifying()` answers — the work that can still change a page's CLASS.
   * `pending()` stays the wider one: it also counts the promises tracked as `"lookup"`,
   * which record an id and decide nothing about any page.
   *
   * COUNTED BY `track()` ITSELF, never by hand next to a call: the hand-kept counter counted
   * only arrivals and walks, and the paths it missed (a reconnect claim, a relation lookup)
   * each decide a class — an under-reported `classifying()` is a page list the exit cleanup
   * treats as FINAL while one of its pages is still being decided.
   */
  let classifyingTracked = 0;

  /**
   * Keep a promise on the settle list until it settles (it never rejects), and count it as
   * CLASSIFICATION work unless it was tracked with the `"lookup"` kind.
   *
   * THE DEFAULT COUNTS, on purpose: every tracked path that can still change a page's class
   * is counted without a second line next to the call, so it cannot be left out by forgetfulness
   * (which is exactly how the hand-kept counter drifted). `kind === "lookup"` is the explicit
   * opt-out, for the bookkeeping that records an id and decides no page's class
   * (`rememberTarget`'s target-id lookup).
   *
   * The count comes back in a `finally`, whichever way the promise settled — a lookup that
   * rejected or threw must not leave `classifying()` true for the rest of the process.
   *
   * @param {Promise<*>} promise
   * @param {"lookup"|undefined} [kind] `"lookup"` when the work can decide no page's class
   */
  const track = (promise, kind) => {
    const counts = kind !== "lookup";
    if (counts) classifyingTracked += 1;
    const tracked = Promise.resolve(promise)
      .catch((err) => {
        log(`[browser] page ownership: ${(err && err.message) || String(err)}`);
      })
      .finally(() => {
        // Given back whichever way it went: a classification that rejected is decided too.
        if (counts) classifyingTracked = Math.max(0, classifyingTracked - 1);
        inFlight.delete(tracked);
      });
    inFlight.add(tracked);
    return tracked;
  };

  /**
   * Wait for every tracked classification and lookup (the body of `settle()`, and what
   * `attachContext` awaits before it switches contexts). One round can start another, so
   * it loops; each lookup is bounded on its own, so the wait is bounded too.
   */
  async function settleWork() {
    for (let round = 0; round < MAX_SETTLE_ROUNDS && inFlight.size; round++) {
      await Promise.all(Array.from(inFlight));
    }
  }

  /**
   * Everything `settle()` does, in this order (round 12, B1/m1):
   *
   *   1. wait for the classifications and lookups in flight (walks included — they are
   *      tracked), bounded by the settle's own budget when it was given one;
   *   2. give a page the bot DROVE that is still not walked ONE more walk — but only when that
   *      page's own walk never got out of the page itself. A walk that already reached part of
   *      the component is NOT walked again: asking the same slow pages a second time spends the
   *      exit budget twice over, and failing closed on the rest is the stricter answer;
   *   3. fail closed on whatever no walk proved: every live page of the scanned context the
   *      walks neither reached nor answered "unrelated" for is the BOT's. That covers a walk
   *      that is still incomplete after its re-run, AND a re-run the settle budget did not
   *      leave time (or room: its first walk is still running) for.
   *
   * THE RE-RUN DEADLINE IS TAKEN AFTER THE WAIT IN STEP 1 (B1(a)). It used to be taken before
   * it, so the wait — a slow classification, a hanging `opener()` — was spent out of the
   * re-run's own budget: `settle()` started straight after a touch then re-ran on an ALREADY
   * EXPIRED deadline, `walkComponent()` returned at its first check, and nothing it never
   * looked at was marked. The popup of the page the bot had just driven stayed the operator's
   * over the exit.
   *
   * THE BUDGET (m1). `settle({ budgetMs })` caps the wait AND the re-run to what is left of it,
   * and returns when it is spent — the exit cleanup passes its own remainder, so a settle can
   * no longer outlive the cleanup that started it. Whatever the budget did not leave time to
   * walk is failed closed, never left at the operator default.
   *
   * WHY one deadline: chained walks used to take a fresh `WALK_DEADLINE_MS` each (a relation
   * landing while the previous walk was still climbing started another), so the total grew past
   * the budget settle() has to fit inside. No walk starts another, and `actOnRelation` starts
   * none at all while settle is driving.
   */
  async function settleWalks(options = {}) {
    const asked = usable(options) ? options : {};
    const budgetAsked = Number(asked.budgetMs);
    const settleDeadline = Number.isFinite(budgetAsked) && budgetAsked > 0 ? Date.now() + budgetAsked : 0;
    settlesDrivingWalks += 1;
    try {
      if (settleDeadline) {
        await withinDeadline(settleWork().then(() => ({ ok: true })), settleDeadline);
      } else {
        await settleWork();
      }

      const now = Date.now();
      const left = settleDeadline ? Math.max(0, settleDeadline - now) : WALK_DEADLINE_MS;
      const reDeadline = now + left;
      const reRuns = [];
      for (const page of Array.from(touchedForSettle)) {
        // A closed page has nothing left to walk (its relations are already recorded), so the
        // list is pruned as it is read: it is the one place a touched page is enumerated.
        if (!usable(page) || closedNow(page)) {
          touchedForSettle.delete(page);
          continue;
        }
        if (relativesWalked.has(page)) continue;
        const previous = walkScans.get(page) || null;
        if (previous && previous.reached) {
          // This page's walk already reached part of its component and ran out of time or of
          // answers: the rest of the scanned context is failed closed rather than asked again.
          failClosedOnWalk(page, previous);
          continue;
        }
        const walk = walkRelatives(page, { deadline: reDeadline, failClosed: true });
        if (!walk) {
          // Its walk is still in flight (a settle that ran out of budget): nothing more can be
          // proven about the context, so it is failed closed.
          failClosedOnWalk(page, previous);
          continue;
        }
        reRuns.push(walk);
      }
      if (reRuns.length) {
        await Promise.all(reRuns);
        // A walk that marks a page starts its target-id lookup: still `settle()`'s work.
        if (settleDeadline) {
          await withinDeadline(settleWork().then(() => ({ ok: true })), settleDeadline);
        } else {
          await settleWork();
        }
      }
    } finally {
      settlesDrivingWalks = Math.max(0, settlesDrivingWalks - 1);
    }
  }

  /** Set a page's class, keeping the count of the bot's pages right. */
  function setClass(page, decided) {
    const before = classes.get(page);
    classes.set(page, decided);
    if (decided === BOT && before !== BOT) botPagesCounted += 1;
  }

  /** Remember a CDP target id as one of the bot's. Never evicted. */
  function recordTargetId(id) {
    if (!id) return;
    botTargets.add(id);
  }

  /**
   * A field of a page's CDP target info (`Target.getTargetInfo` → `targetInfo`).
   *
   * Asked through the page's own context first (the documented way), then through
   * the context this ownership holds — a Page object that came from a reconnect
   * may report a context that will not open a session for it, while the attached
   * one will. The session is detached immediately in every path: nothing here is
   * meant to keep a target alive.
   *
   * The answer keeps three states apart, because the rule needs them:
   *
   *   { ok: true, value }   some target answered and HAS the field
   *   { ok: true, value: null }  a target answered, and it does not have the field
   *                         (for `openerId`: an independent tab, nobody's popup)
   *   { ok: false }         no target would answer (`newCDPSession` or the send
   *                         threw, or nothing came back): nothing is proven
   *
   * @param {object} page
   * @param {"targetId"|"openerId"} field
   * @returns {Promise<{ok: true, value: string|null}|{ok: false}>}
   */
  async function askTargetInfo(page, field) {
    const sources = [];
    try {
      if (typeof page.context === "function") {
        const own = page.context();
        if (own) sources.push(own);
      }
    } catch { /* a page that is already gone */ }
    if (currentContext && !sources.includes(currentContext)) sources.push(currentContext);

    let answered = false;
    for (const source of sources) {
      if (!source || typeof source.newCDPSession !== "function") continue;
      let session = null;
      try {
        session = await source.newCDPSession(page);
        if (!session || typeof session.send !== "function") continue;
        const reply = await session.send("Target.getTargetInfo");
        const info = reply && reply.targetInfo;
        if (!info || typeof info !== "object") continue;
        answered = true;
        const value = info[field];
        if (value) return { ok: true, value: String(value) };
      } catch {
        // Swallowed on purpose: this runs next to a mark on the hot path, and a
        // field a page's target will not answer for is only a page a reconnect
        // forgets — or one the fail-closed rule decides instead.
      } finally {
        await detachQuietly(session);
      }
    }
    return answered ? { ok: true, value: null } : { ok: false };
  }

  /** A page's CDP target id, or null when it cannot be had. */
  async function targetIdOf(page) {
    const asked = await askTargetInfo(page, "targetId");
    return asked.ok ? asked.value : null;
  }

  /**
   * The target id of a page classed OPERATOR, resolved ON DEMAND and remembered once
   * it has been answered (a tab's target id is stable for its life, and re-reading it
   * on every arrival would be a round trip for a fact that cannot change).
   *
   * Resolution happens HERE, when an `openerId` needs proof against it — never at
   * attach, where it would be a CDP session per operator tab for a proof most arrivals
   * never ask for. Null when it cannot be had (no proof, not "no id matched").
   */
  function operatorTargetId(page) {
    const known = targetIds.get(page);
    if (known) return Promise.resolve(known);
    return withLookupTimeout((async () => {
      const id = await targetIdOf(page);
      if (!id) return null;
      targetIds.set(page, id);
      return id;
    })());
  }

  /**
   * A page's target id from the caches first (a mark asked already, or proof (iii) did),
   * otherwise from ONE bounded lookup — with the lookup's OUTCOME kept apart from its
   * value: `{ ok: true, id }` (the id, or `null` when the target answered that it has
   * none) and `{ ok: false, id: null }` when nothing answered at all. The relatives walk
   * needs that difference: a failed lookup leaves the walk incomplete (and so retryable),
   * while "this target has no id" is an answer.
   *
   * A pending mark lookup is AWAITED rather than repeated: the answer is on its way, and
   * a second session for the same fact would be a round trip the relative walk does not
   * need. A lookup that already failed is not retried here (that is `rememberTarget`'s
   * business, on the next mark): this path only needs an id it can compare.
   */
  async function knownTargetIdInfo(page) {
    if (!usable(page)) return { ok: true, id: null };
    const cached = targetIds.get(page);
    if (cached) return { ok: true, id: cached };
    const pending = targetLookups.get(page);
    if (pending) {
      let answered = null;
      try { answered = await pending; } catch { answered = null; }
      if (!answered) return { ok: false, id: null };
      if (!targetIds.has(page)) targetIds.set(page, answered);
      return { ok: true, id: targetIds.get(page) || null };
    }
    try {
      const asked = await withLookupTimeout(askTargetInfo(page, "targetId"));
      if (!asked || asked.ok !== true) return { ok: false, id: null };
      if (!asked.value) return { ok: true, id: null };
      targetIds.set(page, asked.value);
      return { ok: true, id: asked.value };
    } catch { return { ok: false, id: null }; }
  }

  /** The contexts whose LIVE page lists can be consulted for proof (iii). */
  function liveContexts(arrival) {
    const list = [];
    const add = (candidate) => {
      if (!usable(candidate)) return;
      if (typeof candidate.pages !== "function") return;
      if (list.includes(candidate)) return;
      list.push(candidate);
    };
    add(currentContext);
    try {
      if (usable(arrival) && typeof arrival.context === "function") add(arrival.context());
    } catch { /* a page that is already gone */ }
    return list;
  }

  /** The LIVE pages of every context this ownership can consult (never throws). */
  function livePages(from) {
    const pages = [];
    for (const context of liveContexts(from)) {
      let listed = [];
      try {
        listed = typeof context.pages === "function" ? Array.from(context.pages() || []) : [];
      } catch { listed = []; }
      for (const page of listed) {
        if (usable(page) && !pages.includes(page)) pages.push(page);
      }
    }
    return pages;
  }

  /**
   * The LIVE page whose CDP target id is `id`, plus whether the scan could ANSWER at all:
   * `{ ok: true, page }` (the page, or `null` when no live page carries the id) and
   * `{ ok: false, page: null }` when some candidate's id could not be had — then "no page
   * carries it" is not proven, and a walk that needed the answer is incomplete.
   *
   * Every candidate is resolved IN PARALLEL: one round trip per candidate, not one after
   * the other, so a browser with many tabs cannot stretch the scan without bound.
   */
  async function livePageWithTargetIdInfo(id, from) {
    if (!id) return { ok: true, page: null };
    const candidates = livePages(from).filter((candidate) => candidate !== from);
    const answers = await Promise.all(candidates.map((candidate) => knownTargetIdInfo(candidate)));
    let complete = true;
    for (let at = 0; at < candidates.length; at++) {
      const answer = answers[at];
      if (!answer || answer.ok !== true) { complete = false; continue; }
      if (answer.id && answer.id === id) return { ok: true, page: candidates[at] };
    }
    return { ok: complete, page: null };
  }

  /**
   * PROOF (iii): does `openerId` name the target id of a LIVE page classed OPERATOR?
   *
   * Only pages the browser still lists count — `context.pages()` drops a closed tab,
   * which is exactly why an `openerId` that named it proves nothing. Only pages classed
   * `operator` count: an id belonging to the bot's own page is not the operator's proof
   * (it is the bot's popup), and an unclassified one is no proof of anything.
   *
   * The class is read TWICE, before and AFTER the id lookup: that lookup is a real round
   * trip, so the candidate can change hands while it is on its way (a `markTouched` landing
   * meanwhile makes it the bot's), and a page that is the bot's now proves nothing for
   * anything — accepting the stale read would hand an arrival to the operator on evidence
   * that no longer stands.
   *
   * The whole run is bounded: a scan that cannot finish in time is no answer at all,
   * which the caller treats as no proof (fail closed).
   */
  function openerIdNamesLiveOperator(openerId, arrival) {
    const scan = (async () => {
      for (const candidate of livePages(arrival)) {
        if (candidate === arrival) continue;
        if (classes.get(candidate) !== OPERATOR) continue;
        const id = await operatorTargetId(candidate);
        if (classes.get(candidate) !== OPERATOR) continue;
        if (id && id === openerId) return true;
      }
      return false;
    })();
    return withLookupTimeout(scan).then((proved) => proved === true);
  }

  /**
   * Remember the target id the bot's page lives under, once per page, and hand back
   * the promise of that lookup (`null` when it could not be resolved).
   *
   * The mark itself does not wait for it: a target-id round trip must not delay a
   * tool call. The lookup is on the settle list, so the exit cleanup waits for it
   * before it reads the pages, and it is bounded so a stuck CDP session cannot hold
   * a caller that DOES await it (`newPage`, `getPage`).
   *
   * A CLOSE DURING THE LOOKUP TAKES NOTHING AWAY: if the answer comes back it is
   * recorded, because a popup of that page has to remain provable. A lookup that fails
   * or runs out counts as unresolved, which a later `attachContext` fails closed on.
   *
   * TRACKED AS `"lookup"`, explicitly: a target id is bookkeeping that records an id and
   * decides NO page's class, so `classifying()` (the page list is final) must not read it
   * while `pending()` (the budget) still does.
   */
  function rememberTarget(page) {
    const already = targetLookups.get(page);
    if (already) return already;
    const cached = targetIds.get(page);
    if (cached) {
      // Something already resolved this page's id (proof (iii), or a relative walk). The id
      // is the bot's all the same, and no second round trip is needed for it.
      recordTargetId(cached);
      const answered = track(Promise.resolve(cached), "lookup");
      targetLookups.set(page, answered);
      return answered;
    }
    const lookup = track((async () => {
      pendingMarkLookups += 1;
      let id = null;
      try {
        id = await withLookupTimeout(targetIdOf(page));
      } finally {
        pendingMarkLookups = Math.max(0, pendingMarkLookups - 1);
      }
      if (!id) {
        // NO ANSWER IS NOT AN ANSWER: the entry goes, so the next mark on this page
        // looks again. A failed lookup (a CDP session that would not open, a session
        // that timed out) is a transient condition, and remembering it as "resolved to
        // nothing" would cost the page its id for the rest of the process — which a
        // later reconnect can only read as "nothing can be proven", failing closed on
        // every tab. Until a retry does resolve it, the mark counts as unresolved (and
        // NOTHING releases it: see the header).
        if (!unresolvedPages.has(page)) {
          unresolvedPages.add(page);
          unresolvedBotMarks += 1;
        }
        targetLookups.delete(page);
        return null;
      }
      if (unresolvedPages.has(page)) {
        // A retry answered: this page is remembered by id again, so it no longer has
        // to make a reconnect fail closed on everything.
        unresolvedPages.delete(page);
        unresolvedBotMarks = Math.max(0, unresolvedBotMarks - 1);
      }
      targetIds.set(page, id);
      recordTargetId(id);
      return id;
    })(), "lookup");
    targetLookups.set(page, lookup);
    return lookup;
  }

  /**
   * The synchronous `popup` listener, once per page.
   *
   * A real Playwright page emits "popup" the moment the popup target appears, while
   * the opener tab still exists; `opener()` is a round trip that may answer after the
   * opener is gone. So the popup is marked BOT inside the emit, with no await in
   * between. Guarded and swallowed: a page without `on`, or a listener that cannot be
   * added, only means those popups are classified by the rule above like any other
   * arrival — weaker, never wrong.
   */
  function listenForPopups(page) {
    if (popupListeners.has(page)) return;
    popupListeners.add(page);
    try {
      if (typeof page.on !== "function") return;
      page.on("popup", (popup) => {
        try {
          // The relation first, then the mark: a later `markTouched` on either end of it
          // follows the other end (FIX2), and the emit is the only place the pair is
          // still together.
          noteRelation(popup, page);
          markBot(popup);
        } catch { /* a classification must never throw into the browser's emitter */ }
      });
    } catch { /* no listener: the rule decides this popup instead */ }
  }

  /**
   * Everything a page of the bot's carries, in ONE place: the class, the single
   * synchronous `popup` listener, and its target id — remembered by lookup, or recorded
   * straight away when the caller already has it (a reconnect claim just read it; a
   * second lookup for the same id would be a wasted round trip).
   *
   * Every path that decides BOT calls this, so no path can produce a bot page without
   * the listener its own popups need, and `listenForPopups` makes a second call on the
   * same page a no-op (one listener, never two).
   *
   * @returns {Promise<string|null>|undefined} the target-id lookup, when one is started
   */
  function markBotPage(page, knownTargetId) {
    setClass(page, BOT);
    listenForPopups(page);
    if (knownTargetId) {
      recordTargetId(knownTargetId);
      return undefined;
    }
    return rememberTarget(page);
  }

  /**
   * Make a page the bot's, permanently. Never downgrades anything.
   *
   * Synchronous in effect, but it returns the promise of the page's target-id lookup
   * so a caller CAN wait for it (`null` when the id could not be resolved).
   *
   * @returns {Promise<string|null>|undefined} undefined for something that is not a page
   */
  function markBot(page) {
    if (!usable(page)) return undefined;
    return markBotPage(page);
  }

  /**
   * Remember that `child` was opened by `opener`, in BOTH directions: the upward relation
   * is what a touch follows to the tab that opened a page, the downward one is what it
   * follows to the windows that page opened.
   *
   * Recorded wherever the pair is still known together — an `opener()` that resolved to a
   * page object, the synchronous `popup` listener, which fires while both exist, and an
   * arrival's CDP `openerId` once its counterpart is resolved. Never throws: a page object
   * that cannot be keyed simply leaves the relation unrecorded (the CDP `openerId` path may
   * still have it).
   *
   * A relation that is NEWLY recorded also ACTS (`actOnRelation`): it is often learned long
   * after one end of it became the bot's — a page marked before its "page" event fired, a
   * lookup that answered after the touch — and the other end has to follow at that moment,
   * because a script in the bot-driven page reaches it through `window.opener`.
   *
   * `options.act: false` records the relation WITHOUT acting on it, which is what the relatives
   * walk uses (M3): the walk marks every page it reaches itself, so acting here would start a
   * second walk over the same component (and, from inside `settle()`, a walk with its own
   * deadline).
   */
  function noteRelation(child, opener, options = {}) {
    if (!usable(child) || !usable(opener) || child === opener) return;
    let isNew = false;
    try {
      if (openerPages.get(child) !== opener) isNew = true;
      openerPages.set(child, opener);
      let popups = popupPages.get(opener);
      if (!popups) {
        popups = new Set();
        popupPages.set(opener, popups);
      }
      popups.add(child);
    } catch { /* a page object that cannot be keyed: nothing is lost that was proven */ }
    if (isNew && usable(options) && options.act !== false) actOnRelation(child, opener);
  }

  /**
   * Act on a relation one end of which is already the bot's: the opener the bot DROVE makes
   * ITS popup the bot's, and a popup the bot drove makes its opener the bot's — and the
   * opener's own chain (its other popups, its own opener) follows the walk that starts
   * there. A closed counterpart is skipped without a mark (a mark on a gone tab could only
   * be an unresolved one).
   */
  function actOnRelation(child, opener) {
    try {
      if (touchedPages.has(opener) || relativesWalked.has(opener)) {
        if (!closedNow(child)) markBotPage(child);
      }
      if (touchedPages.has(child) || relativesWalked.has(child)) {
        if (!closedNow(opener)) markBotPage(opener);
        // A walk never starts a walk while `settle()` is driving them (M1): the walk settle
        // is already waiting on owns the batch's deadline, and a second one would give the
        // component another 1500 ms of its own, past the exit budget.
        if (settlesDrivingWalks === 0) walkRelatives(opener);
      }
    } catch { /* a relation that cannot be acted on proves nothing either way */ }
  }

  /**
   * Is this page gone? Never throws, and a page that cannot answer counts as gone — the
   * relative walk only ever marks what it can still see, and every relation it follows was
   * learned while the page was there.
   */
  function closedNow(page) {
    try {
      if (usable(page) && typeof page.isClosed === "function") return page.isClosed() === true;
    } catch { /* a page that cannot answer */ }
    return false;
  }

  /**
   * The live `opener()` of one page, bounded, with whether it ANSWERED: `{ ok: true, opener }`
   * (the opener page, or `null` when the page says it has none) and `{ ok: false }` when the
   * lookup ran out of time. A rejection is taken as the page saying it has no opener —
   * Playwright rejects for a page that is already gone — so a walk cannot stay incomplete
   * because a relative no longer exists.
   */
  async function liveOpenerInfo(page) {
    if (!usable(page) || typeof page.opener !== "function") return { ok: true, opener: null };
    let asked;
    try {
      asked = page.opener();
    } catch {
      return { ok: true, opener: null };
    }
    const answer = await lookupWithin(Promise.resolve(asked));
    if (!answer.ok) {
      if (answer.timedOut) return { ok: false, opener: null };
      return { ok: true, opener: null };
    }
    return { ok: true, opener: usable(answer.value) ? answer.value : null };
  }

  /**
   * The pages a RECORDED relation already ties to `page`, as far as this process knows: the
   * connected opener/popup component, read from memory only (no CDP call, no `opener()`).
   *
   * The walk's wait reads this (N1(a), round 11): the arrival of a page a relation ties to the
   * touched one is a relation the walk depends on, while an unrelated tab's slow arrival is
   * not. A relation that is still PENDING (an arrival whose `opener()` has not answered) cannot
   * be seen here, which is why the touched page's own arrival is always waited for and every
   * other candidate is asked live by the walk itself.
   */
  function recordedComponent(page) {
    const component = new Set();
    if (!usable(page)) return component;
    const live = livePages(page);
    const liveOpeners = new Map();
    for (const candidate of live) {
      const opener = openerPages.get(candidate);
      if (usable(opener)) liveOpeners.set(candidate, opener);
    }
    component.add(page);
    const queue = [page];
    for (let at = 0; at < queue.length && at < MAX_RELATIVE_DEPTH; at++) {
      const node = queue[at];
      const relatives = [];
      const up = openerPages.get(node);
      if (usable(up)) relatives.push(up);
      const down = popupPages.get(node);
      if (down) relatives.push(...Array.from(down));
      for (const candidate of live) {
        if (liveOpeners.get(candidate) === node) relatives.push(candidate);
      }
      for (const relative of relatives) {
        if (!usable(relative) || component.has(relative)) continue;
        component.add(relative);
        queue.push(relative);
      }
    }
    return component;
  }

  /**
   * Wait for the arrival classifications ONE walk of `page` actually depends on: the touched
   * page's OWN, and those of the pages a recorded relation already ties to it. Bounded by the
   * walk's deadline. False when one was still in flight when the deadline passed — which leaves
   * the walk INCOMPLETE, never skipped.
   *
   * WHY NOT EVERY LIVE PAGE (N1(a), round 11): `opener()` and the CDP `openerId` are round
   * trips. One slow UNRELATED arrival (an operator tab whose `opener()` and `openerId` are each
   * about a second) used to hold the whole wait, and when it ran out the walk was skipped
   * ENTIRELY — so the popup of the page the bot had just driven stayed the operator's and the
   * exit closed the browser over it unguarded. A walk now waits only for what it can use and
   * asks the rest itself (one live `opener()` per candidate, in parallel), and a wait that runs
   * out leaves the walk to run anyway and count itself incomplete, so a later touch retries it.
   *
   * The touched page's own arrival IS still waited for: its relation (the opener chain above the
   * page the bot drove) is exactly what the walk cannot get any other way in time.
   */
  async function waitForArrivals(page, deadline) {
    const pending = [];
    const add = (candidate) => {
      const arriving = usable(candidate) ? arrivals.get(candidate) : null;
      if (arriving && !pending.includes(arriving)) pending.push(arriving);
    };
    add(page);
    for (const candidate of recordedComponent(page)) add(candidate);
    if (!pending.length) return true;
    const waited = await withinDeadline(
      Promise.all(pending.map((arriving) => Promise.resolve(arriving).then(() => true, () => true))).then(() => ({ ok: true })),
      deadline,
    );
    return waited.ok === true;
  }

  /**
   * FIX2 + T22-B: everything a page the bot DROVE reaches — the WHOLE connected opener/popup
   * component. A bot-driven page can script its opener through `window.opener`, and that
   * script outlives the turn in an operator tab, so a touch marks the opener chain
   * (transitively upward), every popup the page opened (transitively downward), and the
   * SIBLING popups of every ancestor it reaches (a script in the driven page reaches those
   * through the same `window.opener`).
   *
   * The evidence, in the order it is cheap: the relations a classification recorded, the CDP
   * `openerId` a page's target info answered (resolved against the LIVE pages, in parallel
   * and bounded), and ONE live `opener()` call per page that has nothing recorded — at EVERY
   * depth, because a page that existed at attach has no recorded relation at all. Downward,
   * a live page with nothing recorded is resolved the same way, which is what finds a popup
   * that was open before the attach and the siblings of a driven popup.
   *
   * ONCE, and only when it COMPLETED: a complete walk is never repeated (50 touches are one
   * walk), while one left unfinished by a failed lookup or by the deadline is retried by
   * `settle()` (once) and at the page's next touch. One walk per page at a time. Tracked, so
   * `settle()` — and the exit cleanup behind it — waits for it; every lookup is bounded, a
   * closed page is skipped without a mark, a visited set stops a chain that comes back on
   * itself, and it never throws out of the ownership.
   *
   * THE DEADLINE (M1): a walk takes the batch's deadline when one is open (and holds it open
   * until it and its siblings are done), or a fresh `WALK_DEADLINE_MS` otherwise; `settle()`
   * passes its own down. So every walk of one settle shares ONE deadline instead of adding
   * 1500 ms each.
   *
   * THE FAIL-CLOSED HALF (B1, round 12): only a walk `settle()` runs (`options.failClosed`)
   * sweeps what it could not settle — every live page of the scanned context it neither reached
   * nor answered "unrelated" for is marked BOT (see `failClosedOnWalk`). A walk that runs on a
   * touch just leaves itself incomplete, and records what it reached (`walkScans`) so `settle()`
   * can decide whether a re-run is worth its budget.
   *
   * @returns {Promise<void>|null} the tracked walk, or null when there is nothing to walk
   */
  function walkRelatives(page, options = {}) {
    if (!usable(page) || relativesWalked.has(page) || walksInFlight.has(page)) return null;
    const asked = usable(options) ? options : {};
    const given = Number.isFinite(asked.deadline) ? asked.deadline : null;
    const deadline = given === null ? claimWalkDeadline() : given;
    // What THIS walk reached and what it answered "unrelated" for, kept so a walk that does
    // not complete can be failed closed on exactly the pages it did not settle.
    const scan = { seen: new WeakSet(), unrelated: new WeakSet(), reached: false };
    // A WALK IS CLASSIFICATION WORK (`classifying()`): it marks every page it reaches BOT, so
    // the page list is not final while one runs — and `track` counts it by default.
    const walk = track((async () => {
      let complete = false;
      try {
        const waited = await waitForArrivals(page, deadline);
        const walked = await walkComponent(page, deadline, scan);
        complete = walked === true && waited === true;
      } catch (err) {
        log(`[browser] page ownership: relatives walk: ${(err && err.message) || String(err)}`);
      } finally {
        walksInFlight.delete(page);
        if (given === null) releaseWalkDeadline();
      }
      if (complete) {
        relativesWalked.add(page);
        walkScans.delete(page);
        return;
      }
      walkScans.set(page, scan);
      if (asked.failClosed === true) failClosedOnWalk(page, scan);
    })());
    walksInFlight.set(page, walk);
    return walk;
  }

  /**
   * The batch's walk deadline (M1). A walk that starts while another is still running takes the
   * deadline already in force, so chained walks cost ONE `WALK_DEADLINE_MS` between them — which
   * is what keeps `settle()`, and the exit cleanup that awaits it under a 2000 ms budget, inside
   * the budget instead of one deadline per chained walk.
   */
  function claimWalkDeadline() {
    if (!walkBatchDeadline) walkBatchDeadline = Date.now() + WALK_DEADLINE_MS;
    walksRunning += 1;
    return walkBatchDeadline;
  }

  /** Release one walk's hold on the batch deadline (the last one clears it). */
  function releaseWalkDeadline() {
    walksRunning = Math.max(0, walksRunning - 1);
    if (walksRunning === 0) walkBatchDeadline = 0;
  }

  /**
   * FAIL CLOSED on everything one walk did not prove (round 12, B1(b)): every LIVE page of the
   * scanned context the walk neither reached nor answered "unrelated" for is marked BOT.
   *
   * A walk that runs out of time, hits the depth cap, or cannot read a page proves nothing about
   * the pages it never settled — and the alternative is the shape this module exists to stop:
   * the exit closes the browser over a tab that may be the bot's, unguarded and armed. So the
   * rule is the simple, strict one (any doubt -> BOT) rather than a per-lookup state machine:
   * `seen` is what the walk reached (already the bot's), `unrelated` is what a live `opener()`
   * ANSWERED "no opener" for, and everything else in the context is the bot's. Called by a walk
   * that `settle()` re-ran in fail-closed mode, and by `settleWalks` itself when the budget did
   * not leave room for a re-run (`scan` null: nothing was proven, so nothing is excluded).
   *
   * The cost is an operator tab whose `opener()` hangs, cleaned up at turn end — the trade every
   * other fail-closed branch here makes, and the reason this only happens at the END of a
   * settle, never on an ordinary touch.
   */
  function failClosedOnWalk(start, scan) {
    const seen = scan && scan.seen;
    const unrelated = scan && scan.unrelated;
    for (const candidate of livePages(start)) {
      try {
        if (!usable(candidate)) continue;
        if (seen && seen.has(candidate)) continue;
        if (unrelated && unrelated.has(candidate)) continue;
        if (closedNow(candidate)) continue;
        markBotPage(candidate);
      } catch { /* a candidate that cannot be marked proves nothing; its retry decides it */ }
    }
  }

  /**
   * The body of one relatives walk: a breadth-first pass over the component `start` belongs
   * to, BOTH directions at every node, so a sibling popup of an ancestor is reached as
   * surely as the ancestor itself. Returns whether the walk COMPLETED — every lookup it
   * needed answered before the deadline, and the depth cap not reached — because only a
   * complete walk is remembered as done.
   *
   * `scan` is the walk's reported state (B1(b), round 12): `seen` is every page the walk reached
   * (they are marked BOT as they are reached), `unrelated` is every live page whose `opener()`
   * ANSWERED "no opener" — i.e. one this walk proved is nobody's popup — and `reached` says
   * whether the walk ever got out of the page it started on. Everything in the context that is
   * neither `seen` nor `unrelated` is what a fail-closed settle has to mark: the walk proved
   * nothing about it.
   *
   * ONE `opener()` per page per walk: a page asked as a candidate keeps its answer, so when it
   * later becomes a node (its opener turned out to be a component member) its upward relation
   * costs no second round trip (M3). Every relation the walk learns is recorded with
   * `act: false` (M3): the walk marks what it reaches itself, and a relation that ACTED would
   * start a second walk over the same component.
   */
  async function walkComponent(start, deadline, scan) {
    let complete = true;
    const seen = scan.seen;
    const unrelated = scan.unrelated;
    const asked = new Map(); // page -> the promise of its live opener() answer, this walk only
    const askOpener = (candidate) => {
      const already = asked.get(candidate);
      if (already) return already;
      const answer = liveOpenerInfo(candidate);
      asked.set(candidate, answer);
      return answer;
    };
    /** The walk reached this page: it is part of the component, so it is the bot's. */
    const reach = (candidate) => {
      if (candidate !== start) scan.reached = true;
      seen.add(candidate);
    };
    /** A live `opener()` answered "no opener": this walk proved the page nobody's popup. */
    const answerUnrelated = (candidate) => {
      if (usable(candidate)) unrelated.add(candidate);
    };
    seen.add(start);
    const queue = [start];
    for (let at = 0; at < queue.length; at++) {
      if (at >= MAX_RELATIVE_DEPTH) return false; // deeper than this walk follows
      if (Date.now() >= deadline) return false;
      const node = queue[at];

      // UPWARD: the page that opened this one. Recorded relations first, then the CDP
      // `openerId` a previous classification recorded, then one live `opener()` — at EVERY
      // depth, not only at the touched page — and, when that live answer never comes, the
      // node's OWN CDP `openerId` (a separate ask: `Target.getTargetInfo`) before giving up
      // (m2, round 12).
      let ancestor = openerPages.get(node) || null;
      let upwardAnswered = usable(ancestor);
      let askedOpenerId = false;
      if (!upwardAnswered) {
        const openerId = openerIds.get(node);
        if (openerId) {
          askedOpenerId = true;
          const found = await withinDeadline(livePageWithTargetIdInfo(openerId, node), deadline);
          if (found.ok !== true) complete = false;
          ancestor = usable(found.page) ? found.page : null;
          if (ancestor) noteRelation(node, ancestor, { act: false });
          upwardAnswered = usable(ancestor);
        }
      }
      if (!upwardAnswered) {
        const live = await withinDeadline(askOpener(node), deadline);
        if (live.ok === true) {
          ancestor = usable(live.opener) ? live.opener : null;
          if (ancestor) noteRelation(node, ancestor, { act: false });
          else answerUnrelated(node);
          upwardAnswered = true;
        } else {
          complete = false;
        }
      }
      if (!upwardAnswered && !askedOpenerId) {
        // The live `opener()` answered nothing: the browser's own `openerId` is a SEPARATE
        // channel and is asked before the walk gives up on this node.
        const cdped = await withinDeadline(askTargetInfo(node, "openerId"), deadline);
        if (cdped.ok !== true) {
          complete = false;
        } else if (cdped.value) {
          const found = await withinDeadline(livePageWithTargetIdInfo(String(cdped.value), node), deadline);
          if (found.ok !== true) complete = false;
          ancestor = usable(found.page) ? found.page : null;
          if (ancestor) noteRelation(node, ancestor, { act: false });
        }
      }
      if (usable(ancestor) && !seen.has(ancestor)) {
        reach(ancestor);
        if (!closedNow(ancestor)) markBotPage(ancestor);
        queue.push(ancestor);
      }

      // DOWNWARD: the pages this one opened.
      const recorded = popupPages.get(node);
      if (recorded) {
        for (const popup of Array.from(recorded)) {
          if (!usable(popup) || seen.has(popup)) continue;
          reach(popup);
          if (!closedNow(popup)) markBotPage(popup);
          queue.push(popup);
        }
      }
      const candidates = livePages(node).filter(
        (candidate) => candidate !== node
          && !seen.has(candidate)
          && !usable(openerPages.get(candidate))
          && !asked.has(candidate),
      );
      if (!candidates.length) continue;
      // A candidate whose CDP `openerId` is on record is judged by that id alone (no round
      // trip): it names THIS node's target id exactly when this node is the page that
      // opened it. Everything else is asked once, live.
      const named = [];
      const unknown = [];
      for (const candidate of candidates) {
        if (openerIds.get(candidate)) named.push(candidate);
        else unknown.push(candidate);
      }
      let id = null;
      if (named.length) {
        const own = await withinDeadline(knownTargetIdInfo(node), deadline);
        if (own.ok !== true) complete = false;
        id = own.id || null;
      }
      const children = [];
      if (id) {
        for (const candidate of named) {
          if (openerIds.get(candidate) === id) children.push(candidate);
        }
      }
      if (unknown.length) {
        // IN PARALLEL, and every answer is ACTED ON the moment it arrives (N1(b), round 11):
        // one `opener()` per candidate, together, so a wide component costs one round trip
        // rather than one per tab — and the popup of the page the bot drove is marked as soon
        // as its OWN answer is in, not after the slowest unrelated tab answered.
        const answered = unknown.map(() => false);
        const lookups = unknown.map((candidate, index) => askOpener(candidate).then((answer) => {
          if (!answer || answer.ok !== true) return; // no answer: counted below
          answered[index] = true;
          const opener = usable(answer.opener) ? answer.opener : null;
          if (!opener) {
            answerUnrelated(candidate);
            return;
          }
          // The relation is a fact whether or not this node is its other end: record it (and
          // let a later walk, or a later touch, read it) without acting on it.
          noteRelation(candidate, opener, { act: false });
          if (!seen.has(opener) || seen.has(candidate)) return;
          reach(candidate);
          if (!closedNow(candidate)) markBotPage(candidate);
          queue.push(candidate);
        }).catch(() => {}));
        const all = await withinDeadline(Promise.all(lookups).then(() => ({ ok: true })), deadline);
        if (all.ok !== true) complete = false;
        for (let index = 0; index < unknown.length; index++) {
          if (answered[index]) continue;
          complete = false;
        }
      }
      for (const child of children) {
        if (seen.has(child)) continue;
        reach(child);
        noteRelation(child, node, { act: false });
        if (!closedNow(child)) markBotPage(child);
        queue.push(child);
      }
    }
    return complete;
  }

  /**
   * FIX3 + T22-D + M2: the bot-action state AS IT IS NOW, taken when a page ARRIVES. The
   * verdict reads only this snapshot — never the live stamps — so a tool call that starts
   * or ends while the arrival's lookup is still in flight cannot move the window over an
   * arrival that was already there.
   *
   * The snapshot is just what is OPEN now and when the last action ended: an action that is
   * open is in progress, however long it has been running (round 12 removed the
   * `maxBotActionMs` cap — it was fail-OPEN, because it dropped the tab a still-running call's
   * own slow click produced). An action that is never ended stays open for the life of the
   * process; the tools' schema bounds keep ordinary waits far below that.
   */
  function actionSnapshot() {
    return { actionsInProgress: openActions.size, lastActionAt: lastBotActionAt };
  }

  /**
   * Does the snapshot claim this arrival? Either a bot action was IN PROGRESS when the page
   * event fired (however long it had been running: a slow click's tab arrives at the END of
   * the action), or the arrival landed within `botActionWindowMs` after the latest end/touch/
   * open stamp the snapshot saw. A page that appeared BEFORE any stamp (a negative gap) is
   * not the bot's, and with no bot action ever the snapshot claims nothing at all.
   */
  function snapshotClaims(snapshot, arrivedAt) {
    if (!snapshot) return false;
    if (snapshot.actionsInProgress > 0) return true;
    if (snapshot.lastActionAt === null) return false;
    const gap = arrivedAt - snapshot.lastActionAt;
    return gap >= 0 && gap <= botActionWindowMs;
  }

  /**
   * A relation learned from the CDP `openerId` — for a page that may ALREADY be the bot's
   * (T22-A3). The counterpart is resolved against the LIVE pages, bounded, and
   * `noteRelation` decides what follows it. Resolution only happens when it can matter:
   * the page itself was driven (or walked), or the counterpart's id is already in the cache
   * and that counterpart is the bot's.
   *
   * THE LOOKUP IS CLASSIFICATION WORK (the DEFAULT `track` kind): what it resolves is
   * `noteRelation`'d, and `actOnRelation` marks the counterpart BOT at that moment — a class
   * decision, so `classifying()` has to be true while it runs.
   */
  function actOnOpenerIdRelation(page, openerId) {
    if (!openerId) return;
    if (!touchedPages.has(page) && !relativesWalked.has(page)) {
      for (const candidate of livePages(page)) {
        if (candidate === page || targetIds.get(candidate) !== openerId) continue;
        if (touchedPages.has(candidate) || relativesWalked.has(candidate)) noteRelation(page, candidate);
        return;
      }
      return;
    }
    track((async () => {
      const found = await withLookupTimeout(livePageWithTargetIdInfo(openerId, page));
      if (!found || found.ok !== true || !usable(found.page)) return;
      noteRelation(page, found.page);
    })());
  }

  /**
   * Record the CDP `openerId` of a page whose class is ALREADY decided, as a RELATION only:
   * no verdict, no class changed (T22-A2, and B1-c's NAMED candidate at settle).
   *
   * A page can appear (or be classified) before its "page" event reaches this path, and the
   * relation the event could still learn is exactly what a later touch or relatives walk needs
   * to judge it by its opener's target id. Asked only while the ownership owns a bot page: with
   * nothing of the bot's, nothing is attributed and no CDP session is opened. Bounded like every
   * other lookup, and a failure simply records nothing.
   */
  async function recordOpenerIdRelation(page) {
    if (!usable(page) || openerIds.get(page) || botPagesCounted === 0) return;
    const asked = await withLookupTimeout(askTargetInfo(page, "openerId"));
    const openerId = asked && asked.ok === true && asked.value ? String(asked.value) : null;
    if (!openerId || !usable(page)) return;
    openerIds.set(page, openerId);
    actOnOpenerIdRelation(page, openerId);
  }

  /**
   * The owner of a page in memory: an unmarked page answers `operator` — the DEFAULT for
   * an object no classification has reached (see "UNCLASSIFIED IS NOT THE SAME AS PROVEN"
   * in the header), never a proof. The exit cleanup reads pages only after `settle()`.
   */
  function classOf(page) {
    if (!usable(page)) return OPERATOR;
    return classes.get(page) || OPERATOR;
  }

  /**
   * The class of an opener, following a chain of popups that are themselves still
   * being classified (a popup opened by a popup, both still in flight). Null when
   * the chain ends at a page nothing is known about.
   */
  async function openerOwner(opener) {
    if (!usable(opener)) return null;
    const known = classes.get(opener);
    if (known) return known;
    const pending = arrivals.get(opener);
    if (!pending) return null;
    // This waits only for the opener's OWN classification, which in turn waits for
    // its opener: the chain is a page's ancestry, and an opener always predates the
    // page it opened, so it cannot loop.
    try {
      await pending;
    } catch { /* the track() wrapper swallows; this is belt and braces */ }
    return classes.get(opener) || null;
  }

  /**
   * Classify a page that appeared after its context was attached — the ONE rule, in
   * the order the proofs are cheap: the opener it reports, then the browser's
   * `openerId`, then the live operator ids that `openerId` may name.
   *
   * The event path never overwrites an entry: a mark that landed while `opener()` was
   * in flight wins, and a page that was already classified keeps its class (which is also
   * what keeps the hands of a popup whose opener the bot never drove).
   *
   * Both lookups here are BOUNDED (`withLookupTimeout`): `settle()` — and the exit
   * cleanup behind it — waits for this classification, so a session that stops
   * answering must not be able to hold either for good. A timed-out `opener()` is no
   * opener at all, and a timed-out `openerId` is `ok: false` (no evidence), which is
   * the fail-closed direction.
   *
   * The browser is asked only while the ownership owns a bot page: with nothing of the
   * bot's, an arrival can be nobody's popup, so nothing is attributed to it.
   *
   * An arrival with NO `openerId` at all is the one shape that carries no evidence: it is
   * an independent tab (`uncertain`) — unless it appeared within `botActionWindowMs` of the
   * last bot action, because a ctrl-clicked or middle-clicked tab from a bot page has
   * exactly that shape and only the clock can tell it from another client's tab. The
   * window is read from the ARRIVAL time (`arrivedAt`, taken when the "page" event fired),
   * and only on this branch: the proofs are decided first, so an `openerId` that names a
   * live operator page is still the operator's inside the window.
   *
   * The RELATIONS this path learns are recorded before the verdict (`noteRelation`, and the
   * `openerId` itself): a later touch of either end of them follows the other end (FIX2),
   * whatever this arrival turned out to be. They are recorded even for a page a mark has
   * ALREADY classed — including a page classed before its "page" event fired (T22-A2) —
   * because the chain above a bot page is only reachable through them, and a relation
   * skipped here is lost for good.
   */
  function considerArrival(page) {
    if (!usable(page)) return;
    // FIX3's clock starts here, on the event itself — never after a lookup answered. The
    // bot-action state is SNAPSHOT here too (T22-D3): what the verdict may read is what was
    // true when the page arrived.
    const arrivedAt = Date.now();
    const snapshot = actionSnapshot();
    // AN ARRIVAL BEING DECIDED IS CLASSIFICATION WORK (`classifying()`): its verdict IS the
    // page's class, so the page list is not final until it answers. `track` counts it (the
    // default kind) from the event itself, so a caller reading the ownership straight after
    // the emit sees it.
    const work = (async () => {
      let opener = null;
      try {
        if (typeof page.opener === "function") {
          opener = await withLookupTimeout(Promise.resolve().then(() => page.opener()));
        }
      } catch {
        // A target that is already gone: not a crash, and not evidence of an owner.
        opener = null;
      }
      // The relation is recorded whatever the verdict: whoever opened this page, it is the
      // page a later touch of either end has to reach. It can also mean the counterpart is
      // already the bot's, which `noteRelation` acts on.
      if (usable(opener)) noteRelation(page, opener);
      // A mark may have landed before the event (or during the round trip) — or the page was
      // classed before its event fired at all (proof (i) at attach): bot marks win the race, and
      // the class is never decided twice. The RELATION is still owed, though (see the doc above):
      // a page that appeared already classed can be a bot page's popup, and the CDP `openerId` is
      // the only way a later touch of either end reaches its counterpart.
      if (classes.has(page)) {
        await recordOpenerIdRelation(page);
        return;
      }

      if (usable(opener)) {
        // PROOF (ii), read from THIS process's memory: the opener tab may already be
        // closed, but whose page OBJECT it is does not change. An opener classed
        // `uncertain` hands its own uncertainty down (nothing more can be proven about
        // the window than about the page that opened it); an opener nothing proves —
        // unknown, or the bot's — is fail closed.
        const owner = await openerOwner(opener);
        if (classes.has(page)) return;
        if (owner === OPERATOR) {
          setClass(page, OPERATOR);
          return;
        }
        if (owner === UNCERTAIN) {
          setClass(page, UNCERTAIN);
          return;
        }
        markBotPage(page);
        return;
      }

      // `opener()` said nothing: another CDP client's tab, the operator's own Ctrl+T,
      // or a popup whose opener TAB went away before `opener()` answered. Ask the
      // browser which of those it is, when there is a bot page this could belong to.
      if (botPagesCounted === 0) {
        setClass(page, UNCERTAIN);
        return;
      }
      const asked = await withLookupTimeout(askTargetInfo(page, "openerId"));
      const namedOpenerId = asked && asked.ok === true && asked.value ? String(asked.value) : null;
      if (namedOpenerId) {
        // The relation itself, whatever happened to the class meanwhile (T22-A3): the page
        // the bot drove may have been waiting for exactly this answer.
        openerIds.set(page, namedOpenerId);
        actOnOpenerIdRelation(page, namedOpenerId);
      }
      if (classes.has(page)) return; // a mark landed during the lookup: it wins
      if (!asked || asked.ok !== true) {
        // No target would answer in time: nothing here is proven (fail closed). A
        // TIMED-OUT lookup lands here too.
        markBotPage(page);
        return;
      }
      if (!namedOpenerId) {
        // Answered, and it names no opener at all. An INDEPENDENT tab (lane A's
        // createTarget, the operator's Ctrl+T) — left alone — UNLESS one of the bot's own
        // actions was, per the ARRIVAL-TIME SNAPSHOT, running when it arrived or had just
        // ended: a ctrl-clicked or middle-clicked tab of a bot page has exactly this shape
        // (no opener, no openerId), and the clock plus the tool call is all that is left. A
        // page this MCP created is never "independent" (it is already the bot's), so
        // `newPage` is not claimed twice.
        if (!openedByUs.has(page) && snapshotClaims(snapshot, arrivedAt)) {
          markBotPage(page);
          return;
        }
        setClass(page, UNCERTAIN);
        return;
      }
      // The browser named an opener: that relation is recorded above, so judge what it names.
      if (botTargets.has(namedOpenerId)) {
        // It names a tab a bot mark owns: the bot's popup.
        markBotPage(page);
        return;
      }
      // PROOF (iii): the `openerId` names the target id of a LIVE page classed
      // operator — the operator's popup, proved rather than guessed. Every other
      // `openerId` (nobody's, a closed tab's, a lookup that could not finish) is BOT.
      if (await openerIdNamesLiveOperator(namedOpenerId, page)) {
        if (classes.has(page)) return;
        setClass(page, OPERATOR);
        return;
      }
      markBotPage(page);
    })();
    // The count falls with the verdict, whichever way it went (and if deciding it threw):
    // `track` releases it in its own `finally`. The entry is published so an opener chain can
    // wait for this arrival (`openerOwner`) — and so `classifying()` can still see a page left
    // unclassified after its work ended (its belt and braces).
    const tracked = track(work);
    arrivals.set(page, tracked);
  }

  /**
   * The two REPORTING SEAMS live on the ownership's prototype, not on the object
   * itself: they are pure reads of this closure's counters, and the exit cleanup's
   * budget is the only reader. A shallow copy of an ownership (a wrapper, a test double
   * built by spreading it) carries own properties only, so a copy cannot silently
   * present a stale "nothing of the bot's" — one that cannot report its counters is
   * treated as not knowing, and the budget keeps its fail-closed answer. A crash costs
   * the operator's open tabs, a page of the bot's left armed costs the very rule this
   * module exists for, so "cannot tell" must not be read as "nothing to clean up".
   */
  const reporting = {
    /**
     * How many pages this ownership has classed BOT (fail-closed claims included).
     *
     * A reporting seam for the exit cleanup's budget: with a bot page marked, pending
     * work may be deciding more of the bot's, so the budget fails closed.
     */
    botPageCount() {
      return botPagesCounted;
    },

    /**
     * How many bot marks still have no CDP target id.
     *
     * A reporting seam for the exit cleanup's budget, and the condition a reconnect's
     * fail-closed claim reads: such a mark can be ANY tab, so a reconnect classes every
     * unclaimed page BOT while it stands.
     */
    unresolvedMarks() {
      return unresolvedBotMarks;
    },
  };

  return Object.assign(Object.create(reporting), {
    /**
     * This MCP created the page: permanently the bot's.
     *
     * It counts as a bot ACTION for FIX3's window (a tab a click of the bot's produces
     * arrives right after one), but it does NOT reach relatives: creating a page says
     * nothing about the tab it came from, nor about the windows it opens later.
     */
    markOpened(page) {
      if (!usable(page)) return undefined;
      lastBotActionAt = Date.now();
      openedByUs.add(page);
      return markBot(page);
    },

    /**
     * The bot drove the page: permanently the bot's — and so are its RELATIVES (FIX2):
     * the opener chain above it and every popup it opened below it, because a script in
     * this page reaches them through `window.opener` and can outlive the turn.
     *
     * The mirror of `markOpened` for the clock: driving a page is the bot action FIX3's
     * window is measured from.
     *
     * @returns {Promise<string|null>|undefined} the page's target-id lookup, as before
     */
    markTouched(page) {
      if (!usable(page)) return undefined;
      lastBotActionAt = Date.now();
      touchedPages.add(page);
      touchedForSettle.add(page);
      const lookup = markBot(page);
      walkRelatives(page);
      return lookup;
    },

    /**
     * A bot ACTION starts: a tool handler is about to run.
     *
     * The window is anchored to the ACTION, not to a single mark (T22-D): a slow call's own
     * click produces its tab at the END of the call, long after the mark that started it.
     * Nestable — a handler that calls another tool's handler is two opens and two ends — and it
     * never throws.
     *
     * @returns {*} a TOKEN for this action (F3, round 12): hand it to `endBotAction` to end
     *   THIS action, whatever else is open. Actions are independent: ending one never ends
     *   another, which a bare stack pop could not promise.
     */
    beginBotAction() {
      actionSequence += 1;
      openActions.set(actionSequence, Date.now());
      return actionSequence;
    },

    /**
     * A bot ACTION ends: the handler returned, threw, or (for a handler that returned a
     * promise) its promise settled.
     *
     * `endBotAction(token)` removes exactly the action that token opened — no other one (F3).
     * With NO argument it removes the OLDEST open action, which is what a caller that kept no
     * token can ask for (and what the pre-token call meant while actions were nested). An
     * unknown or already-ended token is a no-op: nothing is ended twice and the count never
     * goes below zero.
     *
     * The END is stamped as the latest bot action, so a tab the call's own click produced just
     * after it returned is still inside the window.
     *
     * @param {*} [token] the token `beginBotAction()` handed back
     */
    endBotAction(token) {
      let ended = false;
      if (token === undefined || token === null) {
        // Map keeps insertion order, so its first key is the oldest open action.
        const oldest = openActions.keys().next();
        if (!oldest.done) {
          openActions.delete(oldest.value);
          ended = true;
        }
      } else if (openActions.has(token)) {
        openActions.delete(token);
        ended = true;
      }
      if (ended) lastBotActionAt = Date.now();
    },

    /** Whose page this is, from memory alone (no CDP call, never throws). */
    classify(page) {
      return classOf(page);
    },

    /**
     * `context.newPage()`, marked as the bot's.
     *
     * The mark happens right after the call resolves, because a real context emits
     * "page" DURING `newPage()`: the event arrives first, finds no opener and would
     * otherwise leave the page unproven (and unproven is BOT, but the mark is also what
     * installs the popup listener without waiting for a lookup). The mark overwrites
     * whatever the event decided, so both orders end with the page the bot's.
     *
     * The mark's target-id lookup is AWAITED before this returns: a reconnect that
     * happens immediately afterwards (a crashed-and-restarted MCP process) can only
     * claim the tab this MCP created if its id is already remembered. The lookup is
     * bounded, so a stuck CDP session cannot hold this call.
     *
     * A page made here is never an "independent tab", and it counts as a bot action for
     * FIX3's window: the tab a bot's own click produces arrives moments after one.
     */
    async newPage(context) {
      if (!context || typeof context.newPage !== "function") {
        throw new TypeError("page ownership: newPage needs a BrowserContext with newPage()");
      }
      const page = await context.newPage();
      if (usable(page)) {
        openedByUs.add(page);
        lastBotActionAt = Date.now();
      }
      await markBot(page);
      return page;
    },

    /**
     * Attach to a (new or re-connected) BrowserContext.
     *
     * Pages that exist NOW are the operator's — PROOF (i) — unless a bot mark's
     * remembered target id says otherwise (the same tabs, new Page objects, after a
     * reconnect). Unless a bot mark's id could never be resolved: then no page of this
     * context can be proven not to be the bot's, and every unclaimed one is BOT (fail
     * closed). Pages that appear LATER are classified at event time. A context that is
     * already attached is ignored: this must never add a second "page" listener, and it
     * must never claim a tab twice.
     *
     * The "page" listener goes on BEFORE the snapshot and the id lookups below. Those
     * lookups are real round trips, and a page that appears while one is pending would
     * otherwise be classified by nobody at all — and an unclassified page is treated as
     * the operator's by `classify`, so a popup of the bot's own (freshly re-marked) tab
     * would escape the exit cleanup. An arrival is also what decides a page the snapshot
     * meets while its arrival classification is already in flight.
     *
     * WHAT IS AWAITED, and why: every lookup this ownership already started (a bot
     * mark's target id, a popup mark's, an arrival's `openerId`) is awaited BEFORE
     * `currentContext` switches, so a lookup that fails or times out counts as unresolved
     * here — the fail-closed claim below reads that count — and every one of them runs
     * against the OLD context, which is the one it was started for. It is bounded (each
     * lookup has its own `TARGET_LOOKUP_TIMEOUT_MS`), and it costs nothing when nothing is
     * in flight. The listener is already on while that wait runs, so a page that appears
     * during it is classified by the arrival path; the snapshot is taken after both.
     */
    async attachContext(context) {
      if (!usable(context)) return;
      if (attached.has(context)) {
        currentContext = context;
        return;
      }
      attached.add(context);

      // Pages that appear from now on are classified at the moment they appear —
      // through their opener while it is still there, and through the CDP `openerId`
      // when it is not (the opener may be closed a moment later). Registered before
      // the awaits below, so the reconnect gap is not a hole.
      try {
        if (typeof context.on === "function") context.on("page", considerArrival);
      } catch {
        // A context that cannot be listened to: pages that appear later are simply
        // unmarked, and an unmarked page is left alone.
      }

      // FIX1: the lookups already in flight decide this reconnect (a mark whose target id
      // is still on its way is not "resolved", and a lookup that then fails makes its mark
      // unresolved — which the fail-closed claim below reads). Awaited BEFORE
      // `currentContext` switches, so all of them run against the OLD context.
      await settleWork();
      currentContext = context;

      let pages = [];
      try {
        pages = typeof context.pages === "function" ? Array.from(context.pages() || []) : [];
      } catch {
        pages = [];
      }

      // A mark whose id was never resolved makes an id-matched claim impossible, so
      // nothing in this context can be proven NOT to be the bot's: fail closed for
      // every page no remembered id claims (which is all of them), without a lookup.
      // A mark whose lookup is merely STILL PENDING counts the same way — the settle above
      // bounds it, and one that has not answered is not resolved — so the counter of
      // in-flight mark lookups is read here too.
      const failClosed = unresolvedBotMarks > 0 || pendingMarkLookups > 0;
      const claiming = [];
      for (const page of pages) {
        if (!usable(page) || classes.has(page)) continue;
        const arriving = arrivals.get(page);
        if (arriving) {
          // The page was emitted while this attach was still starting, so the arrival
          // path (which never overwrites a class either) owns its decision. Wait for
          // it rather than claiming it by an id that may not be resolved yet.
          claiming.push(arriving);
          continue;
        }
        if (failClosed) {
          // Same one path every BOT decision takes: the class, the popup listener
          // and a lookup for the id this page lives under.
          markBotPage(page);
          continue;
        }
        // Nothing of the bot's to look for: no CDP call at all in that case (the
        // ownership asks the browser nothing when it owns nothing).
        if (!botTargets.size) {
          setClass(page, OPERATOR);
          continue;
        }
        const claim = track((async () => {
          // CLASSIFICATION WORK (the default `track` kind): this claim decides its page's class
          // at the END of the lookup below (`setClass(page, OPERATOR)`, or a BOT mark when
          // nothing answered), so `classifying()` is true while it runs.
          // BOUNDED, and its three answers are kept apart: `ok: false` (or a
          // timeout) is NOT "no id matched" — a tab nothing is proven about is BOT
          // while the ownership owns bot targets (fail closed). Only a target that
          // ANSWERED an id no bot mark remembers is the operator's.
          const asked = await withLookupTimeout(askTargetInfo(page, "targetId"));
          if (classes.has(page)) return; // a mark (or an arrival) landed meanwhile: it wins
          if (!asked || asked.ok !== true) {
            markBotPage(page);
            return;
          }
          if (asked.value && botTargets.has(asked.value)) {
            // The id is in hand: record it without asking the browser a second time.
            markBotPage(page, asked.value);
            return;
          }
          setClass(page, OPERATOR);
        })());
        // Published as this page's in-flight decision, so an arrival that names it as
        // its OPENER waits for it (`openerOwner`) instead of reading "nothing known"
        // and failing closed on a page it could have proven.
        if (!arrivals.has(page)) arrivals.set(page, claim);
        claiming.push(claim);
      }
      // Awaited: once attachContext returns, every page that was already open has a
      // class, so a caller may classify (or read the pages) straight away.
      if (claiming.length) await Promise.all(claiming);
    },

    /**
     * Wait for the classifications and target-id lookups in flight, then give every page the
     * bot drove and left unwalked its ONE re-run, and fail closed on whatever no walk proved
     * (see `settleWalks`).
     *
     * The exit cleanup calls this BEFORE it reads the pages (and before every re-read): a page
     * whose owner is still being decided must not be read out of the middle of that decision —
     * and neither must a component the turn's relatives walk never finished.
     *
     * `options.budgetMs` caps the whole of it (the wait AND the re-run), because the cleanup has
     * a budget of its own to fit inside; whatever it did not walk is failed closed.
     *
     * @param {{budgetMs?: number}} [options]
     */
    async settle(options = {}) {
      await settleWalks(options);
    },

    /**
     * Is any classification or target-id lookup still in flight?
     *
     * The exit cleanup's budget reads this TOGETHER WITH `botPageCount()` and
     * `unresolvedMarks()`: work in flight is bot work only while the bot owns a page
     * or a mark of its has no id yet (see `ownsBotWork` in private-address.js). Pending
     * work on its own — an operator arrival's `opener()` still in flight, with nothing
     * marked — is not bot work, so the budget must not crash the operator's browser for
     * it. Never throws.
     */
    pending() {
      return inFlight.size > 0;
    },

    /**
     * Is a CLASSIFICATION still in flight — an arrival whose verdict is being decided, a
     * reconnect claim, a relatives walk, or an `openerId` relation lookup that marks its
     * counterpart?
     *
     * This is the narrower question, and it is the one the exit cleanup asks when it decides
     * whether the page list it read is FINAL: only work that can still change a page's class
     * counts here. A target-id lookup records an id and decides nothing, so it is NOT counted —
     * the cleanup used to read `pending()` for this and crashed the browser over a batch of
     * those lookups although every page was already classified. `pending()` itself is
     * unchanged: it stays the wider question the cleanup's budget asks (`ownsBotWork`).
     *
     * KEPT BY `track()` ITSELF: every tracked promise counts unless it was tracked with the
     * explicit `"lookup"` kind, so a new classification path cannot be left out by forgetting
     * a bump. BELT AND BRACES: a LIVE page with no class yet that has an entry in `arrivals`
     * is a page whose classification is on record (an arrival still deciding it, or a claim
     * published for it), so the list is not final whatever the tracked count says. Never
     * throws.
     */
    classifying() {
      if (classifyingTracked > 0) return true;
      for (const page of livePages()) {
        if (!usable(page) || classes.has(page)) continue;
        if (arrivals.has(page)) return true;
      }
      return false;
    },
  });
}

/**
 * Run every tool HANDLER of an MCP server inside a bot action.
 *
 * `server.tool(name, …rest)` is replaced by a function that passes the name and the
 * non-function arguments through untouched and wraps the LAST argument — the handler — so
 * the handler runs between `ownership.beginBotAction()` and `ownership.endBotAction()`,
 * with ITS `this`, its arguments and its return value (or its throw) preserved.
 *
 * WHY: the bot-action window is anchored to the whole call (T22-D). A tool call is one
 * action: a mark inside it (a page it drove, a page it made) is only the START, and the tab
 * a slow click of the bot's produces arrives at the END — after the last mark, and long
 * after the window that mark opened. A tab with no opener and no `openerId` that arrives
 * while an action is in progress is the bot's, and one that arrives just after the action
 * ended is too (the end stamps the window).
 *
 * The action ends when the handler is DONE, not when it hands a promise back: a handler that
 * returns a promise/thenable is still running, and its tab arrives at the settle (T22-E2), so
 * `endBotAction(token)` runs exactly once AFTER that promise settles — resolved or rejected — and
 * the caller gets the original value or reason, never a swallowed or re-wrapped one. A handler
 * that returns a non-thenable, or throws synchronously, has nothing left running: the action ends
 * right then, in a `finally`, before the call returns or the throw leaves.
 *
 * A HANDLER WHOSE PROMISE NEVER SETTLES KEEPS ITS ACTION OPEN, and there is nothing on a
 * clock that ends it (T29, round 14): the timer that used to end it after `maxToolActionMs`
 * was a FAIL-OPEN, because it closed the action under a call that was still RUNNING and the
 * tab that call's own slow click produced then arrived after it, unclaimed. So the bracket
 * ends EXACTLY ONCE and only at the handler's own end: in the `finally` for a synchronous
 * return or throw, and on the promise's settle (resolved or rejected) for a handler that is
 * still running. A call that is abandoned therefore keeps claiming fresh tabs for the life of
 * the process; what keeps that off the ordinary path is the SCHEMA — every wait/timeout
 * parameter is capped below the tool action limit (`DEFAULT_MAX_TOOL_ACTION_MS`). `options` is
 * accepted and ignored, for callers that still pass the removed `maxToolActionMs`.
 *
 * The installation order matters and is pinned by the server: this wraps `server.tool`
 * AFTER the lease guard does, so the lease is taken before the action starts and released
 * after it ends. A registration whose last argument is not a function is left exactly as it
 * was. Returns the server, and never throws on a server that cannot be wrapped.
 *
 * @param {{tool: Function}} server the MCP server whose `tool` registrations to wrap
 * @param {{beginBotAction: Function, endBotAction: Function}} ownership the page ownership
 * @param {object} [_options] ignored (the removed `maxToolActionMs` timer's old option)
 * @returns {object} `server`
 */
export function wrapToolWithBotAction(server, ownership, _options = {}) {
  if (!usable(server) || typeof server.tool !== "function") return server;
  if (!usable(ownership) || typeof ownership.beginBotAction !== "function" || typeof ownership.endBotAction !== "function") {
    return server;
  }
  const register = server.tool.bind(server);
  server.tool = (name, ...rest) => {
    const handler = rest[rest.length - 1];
    if (typeof handler === "function") {
      rest[rest.length - 1] = function botActionWrappedHandler(...args) {
        const token = ownership.beginBotAction();
        let result;
        let stillRunning = false;
        try {
          result = handler.apply(this, args);
          // A promise (or any thenable) means the call is STILL RUNNING after the handler
          // returns: a slow click's tab arrives at the settle, not at the return.
          stillRunning = result !== null
            && (typeof result === "object" || typeof result === "function")
            && typeof result.then === "function";
        } finally {
          // A synchronous return or throw has nothing left running: the action ends HERE,
          // before the value or the throw leaves the call, and exactly once — the branch
          // below is the only other end, and it is taken only when this one was not.
          if (!stillRunning) ownership.endBotAction(token);
        }
        if (!stillRunning) return result;
        // The whole call is one action: end it when the promise settles — resolved or
        // rejected, however long that takes — and hand the caller's value (or reason)
        // through unchanged either way. No timer ends it.
        return Promise.resolve(result).finally(() => ownership.endBotAction(token));
      };
    }
    return register(name, ...rest);
  };
  return server;
}