# Ramble Phase 5 — First-Walk Fixes: You-Are-Here Dot, Egg Art in AR, Collect Animation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Three things Kevin asked for after the first phone walk (2026-09-07): a dot on the map that follows the user; the AR view shows the actual egg art on a nest (and turns gold) once the user is within claim range instead of a box reading "A nest · 60 m"; and a visible animation the moment a tap starts a collect, so the user knows the click took, plus a fly-away when the egg is theirs.

**Architecture:** No server change. The renderer contract gains two optional per-anchor fields the map-side adapter fills in — `reach_m` (how close is "close enough": 75 m for nests and locked marks) and `art` (a ready-made SVG element the painter appends inside the label and puts first with CSS `order`) — so `ramble-ar.js` still knows nothing about nests or eggs and still has zero markup sinks (the art node is drawn by the client's existing `drawEgg` sink, refactored so it can take a nest's numeric seed). `renderAr` computes `near` per item and "right here" beats "ahead" in the bird's line; the painter toggles `data-near`, mounts the art once, flashes `rb-ar-tapped` synchronously on any label tap before calling `onTap`, and exposes `fx(id, name)` with `busy` (sticky), `clear` and `collect` (timed, the bird hops) that reaches both the AR label and the radar-list row for that id. The client adds ONE map-level `watchPosition` (the AR view reuses it) driving a "you are here" dot + accuracy ring on its own pane, with a follow mode on the "Around you" chip that pans only when the dot has moved 10 m and left the middle of the view (a pan fires `moveend`, which fetches). `claimNest` calls `collectFx(cell, phase)` at press, on success and on every other outcome; the map pin's pop animates the pin's inner SVG (never Leaflet's positioned icon), the AR sheet closes on success so the fly-away is visible, and the nest layer is rebuilt after the pop. Reduced motion disables every animation with the same full selectors.

**Tech Stack:** plain-script panel client (no modules, no backticks), Leaflet 1.x (`L.circleMarker`, `L.circle`, `map.panTo`, `map.getBounds().pad`, `map.on("dragstart")`, `marker.getElement()`), the `node:vm` renderer test with its fake document, the loopback panel test.

**Spec:** `docs/superpowers/specs/2026-09-07-ramble-flock-design.md` §3 (World: map centred on you; AR) and §6, amended in Task 3. Phase-4 rulings still bind: `docs/superpowers/plans/2026-09-07-ramble-flock-phase4-ar.md` "## Global Constraints" + "## Review"; handoff `docs/superpowers/handoffs/2026-09-07-ramble-flock-phase4-shipped-pr318.md`. Bug context: the rate-limiter exemption shipped as PR #320 (`/api/ramble/` and `/ramble/` are exempt, so follow-mode fetches are not rate-limited — they are still bounded here for battery and bandwidth).

## Global Constraints

Phase-4 constraints still bind (copied where they matter, with the phase-5 deltas marked **[P5]**):

- **No server change, no table, no route, no tool.** **[P5]** Every file touched is under `bundles/ramble/panel/`, `docs/`, `tests/`, plus the two manifests and the generated registry. `panel/routes.js` and `bundles/ramble/server/*` are untouched.
- **AR contract (spec §6 + phase-4 amendment):** `renderAr({ anchors, pose, bird, camera })` → frame; the renderer knows nothing about maps, marks or nests. **[P5]** An anchor MAY carry `reach_m` (number, metres) and `art` (a DOM element, or null). `layoutAnchor` adds `near: reach_m is a finite number AND distance ≤ reach_m` and `art: !!anchor.art`; a near LOCKED anchor's `sub` reads `close enough · unlock` and a near NEST's `close enough · take it` (the text twin of the gold look); a near label's scale is multiplied by `NEAR_BOOST = 1.25` (a parked label still takes `PARK_SCALE` afterwards — parking wins, deliberately). `sayFor`: the nearest `near` item wins over everything but "no fix" and "nothing around": `"<title>, right here — <n> m."` (ruling Q1: "right here" is about reach, not sight, and must not flip with the compass). The painter, per label: `data-near="true"` when near (else the attribute is removed); the anchor's `art` element APPENDED once (last child; CSS `order: -1` puts it first visually; the painter's index-based title/sub updates keep addressing `children[0]`/`children[1]`) and left in place across frames; a tap adds class `rb-ar-tapped` SYNCHRONOUSLY before `onTap(id)` and removes it after `TAP_MS = 350`. `mountAr` returns `fx(id, name)`: `busy` adds `rb-ar-fx-busy` (sticky), `clear` removes it, `collect` removes busy, adds `rb-ar-fx-collect` for `FX_MS = 900` and hops the bird; `fx` targets BOTH the label node and the radar-list row for that id (ruling Q4: a compass-less phone gets the effect on the row) and returns `true` when at least one exists. The renderer's own sink count stays ZERO: mounting a caller-built element is `appendChild`, never markup.
- **Near styling is for nests (ruling Q2):** the gold near look and the art show only on `[data-kind="nest"][data-near="true"]`, and the art only when the label is not parked (`:not([data-side])`) — "within field of sight" (ruling S2). A near locked mark gets only its `sub` change.
- **Markup sinks:** `static/ramble.js` keeps EXACTLY two engine sinks. **[P5]** `drawEggArt(el, eggId)` becomes a wrapper over a new `drawEggSeed(el, seed)` which owns the single `el.innerHTML = Bird.drawEgg(` line; `nestEggHtml` (the `html:` divIcon sink) is unchanged. Zero backticks in both client scripts (comments included); no emoji; no capture API; `textContent` for any text; every new function in `static/ramble.js` is declared at the IIFE's top level (strict mode makes a function declared inside an `if` block block-scoped — round-1 C4).
- **You-are-here (spec §3 "Map centred on you"):** ONE map-level `navigator.geolocation.watchPosition` (`enableHighAccuracy: true, maximumAge: 5000, timeout: 20000`), started at startup whenever the map exists; it updates `lastFix`, paints an `L.circleMarker` (`className: "rb-here-dot"`, radius 8) and an `L.circle` accuracy ring (`className: "rb-here-ring"`, radius = `accuracy_m` clamped 5..200 m) on a dedicated pane `rb-here` (zIndex 650: above Leaflet's marker pane at 600, so standing on a nest never hides your own dot; below popups at 700), and — while the AR view is open — feeds `arPose` too (the AR view starts its own watch only when the map watch does not exist). Follow mode: the "Around you" chip toggles `following` (`is-on`, `aria-pressed`); while following, a fix pans the map ONLY when the dot has moved > 10 m since the last pan AND sits outside the middle 40 % of the view (`map.getBounds().pad(-0.3)`), because a pan fires `moveend` → `publishArea` + `refreshNests` (round-1 C9); a user `dragstart` turns following off (following keeps working under the AR overlay: a walk still pans the map behind it and fetches — bounded by the same gate). First fix at startup: `setView(15)` as today, then following on. The watch is cleared on `pagehide` and while the document is hidden, and restarted on `pageshow`/visible (ruling Q3: battery — GPS runs only while the page is on screen). Errors never throw; no fix means no dot; a permission error (`code === 1`) while the AR view is open resets `arPose` exactly as the AR view's own watch did (the AR view no longer starts a watch when the map's exists).
- **Collect animation (Kevin: "some kind of animation when the user touches the egg on the screen that lets the user know they have initiated the action"):** `claimNest(nest, lineEl, btn)` marks the sheet button `is-busy` and calls `collectFx(nest.cell, "start")` before `here()`; on `claimed && !already` it calls `collectFx(nest.cell, "done")`, closes the AR sheet (so the fly-away plays on the label, not behind the sheet — round-1 C10) and rebuilds the nest layer 900 ms later (so the pin's pop finishes — C10); on every other outcome it calls `collectFx(nest.cell, "clear")` and removes `is-busy`. `collectFx(cell, phase)`: `start` → `fx(id, "busy")` + `rb-nest-busy` on the pin; `done` → `fx(id, "collect")` + `rb-nest-collect` on the pin for 900 ms; `clear` → `fx(id, "clear")` + remove `rb-nest-busy`. CSS: `rb-ar-tapped` = a 350 ms press flash on `filter`/`box-shadow` (never on `transform`, which positions the label — round-1 S3); `rb-ar-fx-busy` / `rb-nest-busy` / `.rb-pop-btn.is-busy` = a repeating `box-shadow` pulse; `rb-ar-fx-collect` = the egg art scales up then flies down and fades (900 ms, on the art, whose transform is its own); `rb-nest-collect` animates the pin's inner `svg`, never the Leaflet icon (its inline transform is its map position — C6). The reduced-motion block repeats every full selector (a media query adds no specificity — C5).
- **Visual direction C tokens only.**
- **Bundle version bump is mandatory:** `bundles/ramble/manifest.json` AND `package.json` `0.5.0` → `0.6.0`; `npm run build-registry`. The docs en/es heading-parity test must stay green (no new headings — paragraph edits only, at named lines).
- **Tests:** `export PATH=/home/kh0pp/.nvm/versions/node/v22.23.1/bin:$PATH`; `node scripts/run-suite.mjs tests/<file>.test.js` in the foreground only; never bare `node --test`; never boot a gateway from the worktree without a scratch `CROW_DATA_DIR`.
- **Commits:** subject-only, positional paths, `git add` new files first, no attribution trailers of any kind. Worktree `/home/kh0pp/crow-wt-ramble5` (branch `feat/ramble-phase5-first-walk`, `node_modules` symlinked from `~/crow`); never `git checkout` in `~/crow`. PR + green `suite`/`static-checks`/`audit` check-runs on the head sha (public check-runs API via a small python script; no `gh` on crow — GitHub MCP tools for PR/merge). Read `/home/kh0pp/CROW-SCHEDULE.md` before the deploy (house rule; gateway restarts start no model). Restart all three gateways after merge; grackle is the instance with the panel installed — its journal must show `[bundles] refreshed ramble 0.5.0 -> 0.6.0`, `[ramble] transport started`, `[panel] ramble routes mounted`, `addon ramble: connected, 15 tools discovered`.
- **Base:** `main` @ad6c5233 (PR #320 merge).

---

## File structure

**Modify**
- `bundles/ramble/panel/static/ramble-ar.js` — `layoutAnchor` (`near`, `art`, near-locked sub, boost), `sayFor` (near line), `mountAr` (`data-near`, art mount, `rowNodes`, tap flash, `fx()`), constants `NEAR_BOOST`, `TAP_MS`, `FX_MS`.
- `bundles/ramble/panel/static/ramble.js` — `drawEggSeed`/`drawEggArt`; `nestArt`; `toArAnchors` fills `reach_m` + `art`; the here dot (`hereLayer` pane, `paintHere`, `setFollowing`, `startMapWatch`, `stopMapWatch`, the chip handler, startup); `startArGps` reuses the map watch; `nestMarkers` + `collectFx`; `claimNest` hooks.
- `bundles/ramble/panel/static/ramble.css` — here dot/ring, near label + art, the animations, reduced motion.
- `docs/guide/ramble.md`, `docs/es/guide/ramble.md`, `docs/superpowers/specs/2026-09-07-ramble-flock-design.md`, `bundles/ramble/manifest.json`, `bundles/ramble/package.json`, `registry/add-ons.json`.
- Tests: `tests/ramble-ar.test.js`, `tests/ramble-panel.test.js`.

**Fixture geometry** (from `30.46, −98.08`): 50 m north = `(30.460449, −98.08)` (49.93 m), 100 m north = `(30.460898, −98.08)` (99.85 m).

---

## Task 1: Renderer — `near`/`art` on labels, "right here", the tap flash, `fx()` for labels and rows

**Files:**
- Modify: `bundles/ramble/panel/static/ramble-ar.js`
- Test: `tests/ramble-ar.test.js` (append)

**Interfaces:**
- Produces: anchor fields `reach_m?: number`, `art?: Element|null`; frame label fields `near: boolean`, `art: boolean`; `mountAr(...)` return gains `fx(id, name) → boolean` (`name ∈ busy | clear | collect`); exports `NEAR_BOOST = 1.25`, `TAP_MS = 350`, `FX_MS = 900`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/ramble-ar.test.js`:

```js
test("phase 5: reach_m marks a label near (boosted), a near nest wins the say line even when a farther mark is ahead, a near locked mark says unlock", () => {
  const nest = anchor("n1", { lat: 30.460449, lon: -98.08 }, { kind: "nest", title: "A nest", reach_m: 75, art: {} });
  const far = anchor("n2", { lat: 30.460898, lon: -98.08 }, { kind: "nest", title: "A nest", reach_m: 75 });
  const noReach = anchor("m1", { lat: 30.460449, lon: -98.08 });
  const lockedNear = anchor("l1", { lat: 30.460449, lon: -98.08 }, { locked: true, title: "A locked mark", reach_m: 75 });
  const items = [nest, far, noReach, lockedNear].map((a) => Ar.layoutAnchor(a, pose(0)));
  assert.deepEqual(items.map((i) => [i.near, i.art]), [[true, true], [false, false], [false, false], [true, false]]);
  assert.ok(items[0].scale > items[2].scale, "a near label is boosted");
  assert.equal(items[3].sub, "close enough · unlock");
  assert.equal(items[0].sub, "close enough · take it", "a near nest says so in text too (screen readers see no gold)");
  assert.equal(items[1].sub, "100 m");
  // The nest is 50 m BEHIND (heading 180 puts north behind); a mark 100 m ahead is visible. "Right here" still wins.
  const ahead = anchor("m2", { lat: 30.459102, lon: -98.08 }, { title: "ahead mark" });
  const f = Ar.renderAr({ anchors: [nest, ahead], pose: pose(180), bird: null });
  assert.deepEqual(plain(f.visible), ["m2"]);
  assert.equal(f.say, "A nest, right here — 50 m.");
  const g = Ar.renderAr({ anchors: [nest, ahead], pose: pose(null), bird: null });
  assert.equal(g.say, "A nest, right here — 50 m.", "the same line in radar mode: reach, not sight");
  assert.deepEqual(plain(f.labels.map((l) => [l.id, l.near])).sort(), [["m2", false], ["n1", true]]);
  assert.deepEqual([Ar.NEAR_BOOST, Ar.TAP_MS, Ar.FX_MS], [1.25, 350, 900]);
});

test("phase 5: the painter mounts art once (last child), toggles data-near, flashes a tap before onTap, and fx() reaches the label and the radar row", () => {
  const document = fakeDocument();
  const { Ar: A } = load({ document });
  const els = { root: document.createElement("div"), labels: document.createElement("div"), radar: document.createElementNS("svg", "g"), list: document.createElement("div"), coarse: document.createElement("div"), bird: document.createElementNS("svg", "svg"), egg: document.createElementNS("svg", "svg"), say: document.createElement("div"), more: document.createElement("p"), mode: document.createElement("span") };
  const art = document.createElementNS("svg", "svg");
  const taps = [];
  let tapHook = null;
  const session = A.mountAr(els, { engine: null, onTap: (id) => { if (tapHook) tapHook(id); taps.push(id); } });
  const near = anchor("n1", { lat: 30.460449, lon: -98.08 }, { kind: "nest", title: "A nest", reach_m: 75, art });
  session.render({ anchors: [near], pose: pose(0), bird: null });
  const label = els.labels.children.find((c) => c.getAttribute("data-id") === "n1");
  assert.equal(label.getAttribute("data-near"), "true");
  assert.equal(label.children.length, 3);
  assert.equal(label.children[2], art, "the art is APPENDED (CSS order puts it first) so the painter's children[0]/[1] text updates never touch it");
  assert.equal(label.children[0].textContent, "A nest");
  assert.equal(label.children[1].textContent, "close enough · take it");
  session.render({ anchors: [near], pose: pose(0), bird: null });
  assert.equal(label.children.length, 3, "mounted once, not per frame");
  assert.equal(art.textContent, "", "the art is never written to");
  // Walk away: near clears, the art stays mounted.
  session.render({ anchors: [{ ...near, lat: 30.460898 }], pose: pose(0), bird: null });
  assert.equal(label.getAttribute("data-near"), null);
  assert.equal(label.children[2], art);
  // A tap flashes BEFORE onTap runs.
  let flashedWhenTapped = false;
  tapHook = () => { flashedWhenTapped = label.classes.has("rb-ar-tapped"); };
  label.click();
  assert.equal(flashedWhenTapped, true);
  assert.deepEqual(taps, ["n1"]);
  // busy is sticky until clear; collect is timed and clears busy.
  assert.equal(session.fx("n1", "busy"), true);
  assert.ok(label.classes.has("rb-ar-fx-busy"));
  assert.equal(session.fx("n1", "clear"), true);
  assert.ok(!label.classes.has("rb-ar-fx-busy"));
  session.fx("n1", "busy");
  assert.equal(session.fx("n1", "collect"), true);
  assert.ok(label.classes.has("rb-ar-fx-collect") && !label.classes.has("rb-ar-fx-busy"));
  assert.equal(session.fx("nope", "collect"), false);
  // Radar mode: no labels, but the list row for the id takes the effect.
  session.render({ anchors: [near], pose: pose(null), bird: null });
  assert.equal(els.labels.children.length, 0);
  const row = els.list.children.find((c) => c.getAttribute("data-id") === "n1");
  assert.ok(row, "the radar row exists");
  assert.equal(session.fx("n1", "collect"), true);
  assert.ok(row.classes.has("rb-ar-fx-collect"));
  session.destroy();
});
```

- [ ] **Step 2: Run to verify they fail** — `node scripts/run-suite.mjs tests/ramble-ar.test.js` → FAIL (`near` undefined; `session.fx` is not a function).

- [ ] **Step 3: Implement**

In `bundles/ramble/panel/static/ramble-ar.js`:

(a) Header comment: change "the only markup this file ever mounts is the bird" to "the only markup this file ever mounts is the bird; a caller-built art element is appended, never parsed" and extend the anchor shape line to `{ id, kind, lat, lon, accuracy_m, approx_m, locked, title, reach_m?, art? }`. Constants, after `var REACT_MS = 900;`:
```js
  var NEAR_BOOST = 1.25;       /* a label within its anchor's reach_m is drawn larger */
  var TAP_MS = 350;            /* the press flash on any label */
  var FX_MS = 900;             /* a timed effect (collect) */
```

(b) Replace the whole `layoutAnchor` function with:
```js
  /* One anchor against one pose: distance, bearing, and (with a heading) its
   * place on the screen, all as fractions 0..1 of the viewport. reach_m (an
   * optional per-anchor "close enough") makes it near; art says the caller
   * supplied an element the painter should show. */
  function layoutAnchor(anchor, pose) {
    var d = distanceM(pose, anchor);
    var b = bearingDeg(pose, anchor);
    var t = clamp01(d / RANGE_M);
    var near = isNum(anchor.reach_m) && d <= anchor.reach_m;
    var out = {
      id: anchor.id, kind: anchor.kind, title: anchor.title, locked: !!anchor.locked,
      distance_m: Math.round(d), bearing: Math.round(b), rel: null, visible: false, side: null,
      x: 0.5, y: NEAR_Y - (NEAR_Y - FAR_Y) * t, scale: NEAR_SCALE - (NEAR_SCALE - FAR_SCALE) * t,
      sub: near ? (anchor.locked ? "close enough · unlock" : (anchor.kind === "nest" ? "close enough · take it" : subFor(d, anchor.locked))) : subFor(d, anchor.locked),
      near: near,
      art: !!anchor.art,
    };
    if (near) out.scale = out.scale * NEAR_BOOST;
    if (isNum(pose.heading)) {
      var rel = relativeBearing(b, pose.heading);
      out.rel = Math.round(rel * 10) / 10;
      out.visible = Math.abs(rel) <= FOV_DEG / 2;
      if (out.visible) {
        out.x = 0.5 + rel / FOV_DEG;
      } else {
        out.side = rel < 0 ? "left" : "right";
        out.x = rel < 0 ? 0.06 : 0.94;
      }
    }
    return out;
  }
```

(c) In `sayFor`, after the line `if (items.length === 0) return "Nothing within " + RANGE_M + " m. Walk a bit.";` and BEFORE the `if (visibleItems.length > 0)` line insert:
```js
    /* Reach beats sight: "right here" must not flip with the compass. Items are nearest-first. */
    for (var i = 0; i < items.length; i++) {
      if (items[i].near) return items[i].title + ", right here — " + roundM(items[i].distance_m) + " m.";
    }
```

(d) In `mountAr`, after `var listKey = null;` add:
```js
    /* Art elements mounted per anchor id (once), the radar rows by id (for fx),
     * and per-element flash timers. */
    var arts = {};
    var rowNodes = {};
```
In `placeLabel(btn, item, order)`, after the `data-side` line add:
```js
      if (item.near) btn.setAttribute("data-near", "true"); else btn.removeAttribute("data-near");
```
Replace `labelEl`'s click line with:
```js
      btn.addEventListener("click", function () {
        flash(btn, "rb-ar-tapped", TAP_MS);
        if (typeof o.onTap === "function") o.onTap(id);
      });
```
Add, before `function rowEl(item)`:
```js
    /* Add a class for ms milliseconds, restarting the timer on a repeat. The timer lives
     * on the element so a label and a row with the same id never share one. */
    function flash(el, cls, ms) {
      el.classList.add(cls);
      var timers = el.rbFxTimers || (el.rbFxTimers = {});
      if (timers[cls]) clearTimeout(timers[cls]);
      timers[cls] = setTimeout(function () { el.classList.remove(cls); delete timers[cls]; }, ms);
    }

    /* The caller's art element goes in once, as the LAST child: placeLabel
     * addresses the title and sub by index (children[0]/[1]), and CSS order
     * puts the art first on screen. */
    function mountArt(btn, id) {
      var a = byId[id] && byId[id].art;
      if (!a || arts[id]) return;
      btn.appendChild(a);
      arts[id] = a;
    }
```
In `rowEl(item)`, after `btn.setAttribute("data-id", item.id);` add `rowNodes[item.id] = btn;`. In `paintRadar`, right after `listKey = key;` add `rowNodes = {};` (the rows are rebuilt below it). In `render`'s labels loop, after `if (!btn) { btn = labelEl(item.id); nodes[item.id] = btn; e.labels.appendChild(btn); }` add `mountArt(btn, item.id);` (one line; `byId` is filled before the loop). In the node-removal loop add `delete arts[id];` beside `delete nodes[id];`.

Add before `function destroy()`:
```js
    /* A named effect on everything showing this id: the AR label and the
     * radar-list row. busy is sticky (until clear); collect is timed and hops
     * the bird. Returns false when nothing shows the id. */
    function fx(id, name) {
      var targets = [];
      if (nodes[id]) targets.push(nodes[id]);
      if (rowNodes[id]) targets.push(rowNodes[id]);
      if (targets.length === 0) return false;
      targets.forEach(function (el) {
        if (name === "clear") { el.classList.remove("rb-ar-fx-busy"); return; }
        if (name === "busy") { el.classList.add("rb-ar-fx-busy"); return; }
        el.classList.remove("rb-ar-fx-busy");
        flash(el, "rb-ar-fx-" + name, FX_MS);
      });
      if (name === "collect") react();
      return true;
    }
```
In `destroy()`, as the very first statement (before anything else — after `nodes = {};` there would be nothing to cancel), cancel the flash timers on every label and row: `[nodes, rowNodes].forEach(function (m) { Object.keys(m).forEach(function (id) { var t = m[id].rbFxTimers || {}; Object.keys(t).forEach(function (k) { clearTimeout(t[k]); }); }); });` then add `arts = {}; rowNodes = {};` beside `nodes = {};`. Add a one-line comment above `rowNodes[item.id] = btn;` in `rowEl`: `/* the coarse strip reuses rowEl, so a coarse id would overwrite a row's entry — coarse anchors never have an fx today */`. The return object gains `fx: fx`. The export object gains `NEAR_BOOST: NEAR_BOOST, TAP_MS: TAP_MS, FX_MS: FX_MS`.

- [ ] **Step 4: Run to verify they pass** — `node scripts/run-suite.mjs tests/ramble-ar.test.js` → 11 pass. Then `grep -c '\`' bundles/ramble/panel/static/ramble-ar.js` = 0 and `grep -cE '\.innerHTML\s*=|\bhtml:\s' bundles/ramble/panel/static/ramble-ar.js` = 0.

- [ ] **Step 5: Commit**
```bash
git commit bundles/ramble/panel/static/ramble-ar.js tests/ramble-ar.test.js -m "ramble ar: near labels with mounted art, right-here line, tap flash, fx() on labels and rows"
```

---

## Task 2: Client — the you-are-here dot with follow mode, egg art + reach on AR anchors, the collect animation

**Files:**
- Modify: `bundles/ramble/panel/static/ramble.js`, `bundles/ramble/panel/static/ramble.css`
- Test: `tests/ramble-panel.test.js`

**Interfaces:**
- Consumes: Task 1's `reach_m`/`art`/`fx`; existing `haversineMeters`, `here`, `lastFix`, `arAnchors`, `CLAIM_M`, `UNLOCK_M`, `isLocked`, `seedFromEggId`, `Bird`, `closeArSheet`, `arOpen`/`arSession`/`arPose`, `maybeRefreshAround`, `scheduleArRender`, `refreshNests`, `refreshFlock`.
- Produces (all IIFE-level): `drawEggSeed(el, seed)`, `drawEggArt(el, eggId)`, `nestArt(nest)`, `paintHere(fix)`, `setFollowing(on)`, `startMapWatch()`, `stopMapWatch()`, `collectFx(cell, phase)`, state `hereLayer, hereDot, hereRing, following, mapWatch, lastPanAt, nestMarkers, nestArtCache`.

- [ ] **Step 1: Panel-test assertions (failing first)**

In `tests/ramble-panel.test.js`, inside the `GET /ramble/static/ramble.js` test, before `const code = body.replace(...)`:
```js
  // Phase 5: one map-level watch drives the you-are-here dot (own pane) with
  // follow mode; nests carry reach + egg art into AR; the collect effect runs
  // at press, success and clear; the nest layer waits for the pin's pop.
  assert.ok(body.includes('className: "rb-here-dot"') && body.includes('className: "rb-here-ring"'));
  assert.ok(body.includes('map.createPane("rb-here")') && body.includes('getPane("rb-here").style.zIndex = 650'));
  assert.ok(body.includes("function startMapWatch(") && body.includes("function paintHere(") && body.includes("function setFollowing("));
  assert.ok(body.includes('map.on("dragstart"'), "a user drag ends follow mode");
  assert.ok(body.includes("getBounds().pad(-0.3)"), "follow pans only when the dot leaves the middle of the view");
  assert.ok(body.includes("reach_m: CLAIM_M") && body.includes("UNLOCK_M : null"));
  assert.ok(body.includes("function drawEggSeed(") && body.includes("art: nestArt(nest)"));
  assert.ok(body.includes('collectFx(nest.cell, "start")') && body.includes('collectFx(nest.cell, "done")') && body.includes('collectFx(nest.cell, "clear")'));
  assert.ok(body.includes('arSession.fx("n:" + cell'));
  assert.ok(body.includes("setTimeout(refreshNests, 900)"), "the pin's pop finishes before the layer is rebuilt");
  assert.ok(body.includes("if (mapWatch != null)"), "the AR view reuses the map watch");
  assert.ok(body.includes('window.addEventListener("pageshow"'), "the watch restarts after a bfcache park");
  assert.ok(body.includes("err.code === 1 && arOpen"), "a revoked permission still resets the AR pose");
```
In the `ramble.css` test add:
```js
  assert.match(body, /\.rb-ar-label\[data-kind="nest"\]\[data-near="true"\]/);
  assert.match(body, /\.rb-ar-label:not\(\[data-side\]\)\.rb-ar-fx-collect \.rb-ar-egg-art/);
  assert.match(body, /\.rb-here-dot/);
  assert.match(body, /\.rb-nest-pin\.rb-nest-collect svg/);
  assert.match(body, /\.rb-ar-egg-art \{[^}]*order: -1/);
```
Run `node scripts/run-suite.mjs tests/ramble-panel.test.js` — these fail, nothing else.

- [ ] **Step 2: Client code (all in `bundles/ramble/panel/static/ramble.js`)**

(a) Replace `drawEggArt`:
```js
  /* The ONE egg sink: engine output from a NUMBER. drawEggArt derives that
   * number from an egg id; nests carry theirs. */
  function drawEggSeed(el, seed) {
    if (!el || !Bird) return;
    try { el.innerHTML = Bird.drawEgg(seed >>> 0); } catch (e) { /* cosmetic */ }
  }
  function drawEggArt(el, eggId) { drawEggSeed(el, seedFromEggId(eggId)); }
```

(b) Map state: change `var nestLayer = null;` to
```js
  var nestLayer = null;
  var hereLayer = null, hereDot = null, hereRing = null;
  var following = false, mapWatch = null, lastPanAt = null;
```
Inside the map block, after `nestLayer = L.layerGroup().addTo(map);` add:
```js
    /* Its own pane, above Leaflet's marker pane (600) and below popups (700):
     * the dot is the user's reference and must never hide under a pin. It ties
     * the tooltip pane (650), which Ramble never uses (pins carry a title). */
    map.createPane("rb-here");
    map.getPane("rb-here").style.zIndex = 650;
    hereLayer = L.layerGroup().addTo(map);
    map.on("dragstart", function () { setFollowing(false); });
```
At IIFE level, immediately after the map block's closing `}` (before `function here()`), add — top-level declarations, never inside the `if` (strict mode would block-scope them):
```js
  /* ------------------------------------------------------------ you are here */

  function paintHere(fix) {
    if (!map || !hereLayer || !fix || typeof fix.lat !== "number" || typeof fix.lon !== "number") return;
    var ll = [fix.lat, fix.lon];
    var r = Math.max(5, Math.min(200, Number(fix.accuracy_m) || 20));
    if (!hereDot) {
      hereRing = L.circle(ll, { pane: "rb-here", radius: r, className: "rb-here-ring", stroke: false, fillOpacity: 0.12, interactive: false }).addTo(hereLayer);
      hereDot = L.circleMarker(ll, { pane: "rb-here", radius: 8, className: "rb-here-dot", weight: 3, fillOpacity: 1, interactive: false }).addTo(hereLayer);
    } else {
      hereRing.setLatLng(ll);
      hereRing.setRadius(r);
      hereDot.setLatLng(ll);
    }
    if (!following) return;
    /* A pan fires moveend, which posts the area and refetches nests: pan only
     * when the dot has actually moved AND left the middle of the view. */
    var moved = !lastPanAt || haversineMeters(lastPanAt, fix) > 10;
    var inside = map.getBounds().pad(-0.3).contains(ll);
    if (moved && !inside) {
      lastPanAt = { lat: fix.lat, lon: fix.lon };
      map.panTo(ll, { animate: true });
    }
  }

  function setFollowing(on) {
    following = !!on;
    var chip = $("rb-chip-around");
    if (!chip) return;
    chip.classList.toggle("is-on", following);
    chip.setAttribute("aria-pressed", following ? "true" : "false");
  }

  /* One watch for the whole page: the dot, every walk hint (lastFix) and, when
   * the AR view is open, its pose. */
  function startMapWatch() {
    if (mapWatch != null || !map || !navigator.geolocation) return;
    mapWatch = navigator.geolocation.watchPosition(function (pos) {
      lastFix = { lat: pos.coords.latitude, lon: pos.coords.longitude, accuracy_m: pos.coords.accuracy };
      paintHere(lastFix);
      if (arOpen) {
        arPose.lat = lastFix.lat; arPose.lon = lastFix.lon; arPose.accuracy_m = lastFix.accuracy_m;
        maybeRefreshAround();
        scheduleArRender();
      }
    }, function (err) {
      /* No fix: no dot; the map still works by hand. Permission pulled
       * mid-session (code 1) while the AR view is open: its old fix is a lie
       * now — back to "Waiting for a fix…" (the AR view's own watch used to do this). */
      if (err && err.code === 1 && arOpen) { arPose.lat = null; arPose.lon = null; arAnchors = []; scheduleArRender(); }
    }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 });
  }

  function stopMapWatch() {
    if (mapWatch == null || !navigator.geolocation) { mapWatch = null; return; }
    try { navigator.geolocation.clearWatch(mapWatch); } catch (e) { /* gone */ }
    mapWatch = null;
  }
  /* The watch runs only while the page is shown: a hidden tab or a bfcache
   * park stops it (battery), coming back restarts it — startMapWatch is idempotent. */
  window.addEventListener("pagehide", stopMapWatch);
  window.addEventListener("pageshow", function () { startMapWatch(); });
  document.addEventListener("visibilitychange", function () { if (document.hidden) stopMapWatch(); else startMapWatch(); });
```
(`haversineMeters`, `maybeRefreshAround`, `scheduleArRender` are function declarations later in the file — hoisted; `arOpen`/`arPose`/`lastFix` are `var`s — hoisted, assigned before the first fix can arrive.)

(c) Replace the "Around you" chip handler:
```js
  var aroundChip = $("rb-chip-around");
  if (aroundChip) {
    aroundChip.addEventListener("click", function () {
      setFollowing(!following);
      if (!following) return;
      here().then(function (pos) {
        paintHere(pos);
        if (map) map.setView([pos.lat, pos.lon], Math.max(map.getZoom(), 15));
      }).catch(function () { /* stay put */ });
    });
  }
```
Startup block becomes:
```js
  if (map) {
    startMapWatch();
    /* The markup ships the chip lit; nothing follows until the first fix says so. */
    setFollowing(false);
    here().then(function (pos) {
      map.setView([pos.lat, pos.lon], 15);
      paintHere(pos);
      setFollowing(true);
    }).catch(function () {
      setText($("rb-perch-say"), "Pan the map to pick where you are listening.");
    }).then(function () { publishArea(); refreshNests(); });
    setInterval(refreshNests, 10 * 60e3);
  }
```

(d) `startArGps` reuses the map watch — replace its body's first lines:
```js
  function startArGps() {
    if (lastFix) {
      arPose.lat = lastFix.lat; arPose.lon = lastFix.lon; arPose.accuracy_m = lastFix.accuracy_m;
      refreshAround();
      scheduleArRender();
    }
    if (mapWatch != null) return; /* the map's watch feeds arPose while the view is open */
    if (!navigator.geolocation) return;
    arWatch = navigator.geolocation.watchPosition(function (pos) {
```
(the rest unchanged).

(e) Nest art + anchors. After `nestEggHtml` add:
```js
  var nestArtCache = {};
  /* The egg the AR label shows when a nest is within reach: drawn by the one
   * egg sink from the nest's own seed, cached per cell so the painter keeps a
   * stable element; the claimed look is refreshed on every call. */
  function nestArt(nest) {
    var svg = nestArtCache[nest.cell];
    if (!svg) {
      svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("viewBox", "0 0 120 152");
      svg.setAttribute("aria-hidden", "true");
      drawEggSeed(svg, nest.seed);
      nestArtCache[nest.cell] = svg;
    }
    svg.setAttribute("class", "rb-ar-egg-art" + (nest.claimed ? " is-claimed" : ""));
    return svg;
  }
```
In `toArAnchors`: the mark object gains `reach_m: isLocked(mark) ? UNLOCK_M : null,` after `locked:`; the nest object gains `reach_m: CLAIM_M, art: nestArt(nest),` after `locked: false,`. In `closeAr` add `nestArtCache = {};` after `if (arSession) arSession.destroy();`.

(f) Nest markers + the effect. Change `var lastNests = [];` to `var lastNests = [];\n  var nestMarkers = {};`. In `drawNests`, after `nestLayer.clearLayers();` add `nestMarkers = {};` and after `marker.addTo(nestLayer);` add `nestMarkers[nest.cell] = marker;`. Add before `function claimNest`:
```js
  /* Until when the nest layer must NOT be rebuilt: a claimed pin is mid-pop
   * (900 ms) and the claim's own SSE echo arrives at once. */
  var nestPopUntil = 0;

  /* Rebuild the nest layer now, or after a running pin pop ends. */
  function refreshNestsAfterPop() {
    var wait = nestPopUntil - Date.now();
    if (wait > 0) setTimeout(refreshNests, wait); else refreshNests();
  }

  /* The collect effect on everything showing this nest: the AR label/row
   * (busy is sticky until clear; collect is timed) and the map pin. The pin's
   * animation targets its inner svg — the icon's own transform is its map
   * position. */
  function collectFx(cell, phase) {
    var name = phase === "done" ? "collect" : (phase === "start" ? "busy" : "clear");
    if (arOpen && arSession) arSession.fx("n:" + cell, name);
    var m = nestMarkers[cell];
    var el = m && typeof m.getElement === "function" ? m.getElement() : null;
    if (!el) return;
    el.classList.remove("rb-nest-busy");
    if (name === "busy") el.classList.add("rb-nest-busy");
    if (name === "collect") {
      nestPopUntil = Date.now() + 900;
      el.classList.add("rb-nest-collect");
      setTimeout(function () { el.classList.remove("rb-nest-collect"); }, 900);
    }
  }
```
Replace `claimNest` with:
```js
  function claimNest(nest, lineEl, btn) {
    btn.disabled = true;
    btn.classList.add("is-busy");
    collectFx(nest.cell, "start");
    lineEl.textContent = "checking where you are…";
    here().then(function (pos) {
      return jsonFetch("/api/ramble/nests/claim", {
        method: "POST",
        body: { cell: nest.cell, week: nest.week, lat: pos.lat, lon: pos.lon }
      });
    }).then(function (out) {
      btn.classList.remove("is-busy");
      if (out && out.claimed) {
        lineEl.textContent = out.already ? "Already yours." : "You found an egg. It's on your shelf.";
        btn.remove();
        if (out.already) { collectFx(nest.cell, "clear"); refreshNests(); return refreshFlock(); }
        collectFx(nest.cell, "done");
        /* The fly-away plays on the AR label, not behind the sheet (the
         * "on your shelf" line is lost there — accepted: the bird's line and
         * the shelf say it); the layer is rebuilt only after the pin's pop
         * (refreshNestsAfterPop; the SSE echo waits too). */
        closeArSheet();
        refreshNestsAfterPop();
        return refreshFlock();
      }
      collectFx(nest.cell, "clear");
      lineEl.textContent = CLAIM_REASON[out && out.reason] || "Couldn't take it.";
      btn.disabled = false;
    }).catch(function (err) {
      btn.classList.remove("is-busy");
      collectFx(nest.cell, "clear");
      lineEl.textContent = err.message;
      btn.disabled = false;
    });
  }
```
(`closeArSheet` is a function declaration in the AR section — hoisted; it returns at once when the sheet is hidden, so the map path is unaffected.)

- [ ] **Step 3: CSS (append to `bundles/ramble/panel/static/ramble.css`)**
```css
/* ------------------------------------------------------- phase 5: here dot */

#ramble .rb-here-dot { fill: var(--rb-accent-2); stroke: var(--rb-surface); }
#ramble .rb-here-ring { fill: var(--rb-accent-2); }

/* ---------------------------------------------- phase 5: near labels + art */

/* The egg art is APPENDED last (the painter addresses title/sub by index) and
   shown first by order; only a NEAR NEST that is in view shows it. */
#ramble .rb-ar-label .rb-ar-egg-art { order: -1; width: 44px; height: 56px; margin: 0 0 4px; display: none; align-self: center; }
#ramble .rb-ar-label[data-kind="nest"][data-near="true"] {
  align-items: center;
  text-align: center;
  border-color: var(--rb-accent);
  background: color-mix(in oklab, var(--rb-surface) 70%, var(--rb-accent));
}
#ramble .rb-ar-label[data-kind="nest"][data-near="true"]:not([data-side]) .rb-ar-egg-art { display: block; }
#ramble .rb-ar-egg-art.is-claimed { opacity: .45; }

/* ------------------------------------------------ phase 5: tap + collect fx */

/* Never animate transform on a label or a Leaflet icon: transform is their position. */
@keyframes rb-press { 0%, 100% { filter: brightness(1); box-shadow: var(--rb-pop-sm); } 50% { filter: brightness(1.15); box-shadow: 0 0 0 4px color-mix(in oklab, var(--rb-accent-2) 45%, transparent); } }
@keyframes rb-busy { 0%, 100% { box-shadow: var(--rb-pop-sm); } 50% { box-shadow: 0 0 0 6px color-mix(in oklab, var(--rb-accent) 55%, transparent); } }
@keyframes rb-collect { 0% { transform: scale(1); opacity: 1; } 35% { transform: scale(1.35) rotate(-8deg); opacity: 1; } 100% { transform: translateY(60vh) scale(.3); opacity: 0; } }
@keyframes rb-nest-pop { 0% { transform: scale(1); opacity: 1; } 40% { transform: scale(1.4); opacity: 1; } 100% { transform: scale(0); opacity: 0; } }
#ramble .rb-ar-label.rb-ar-tapped { animation: rb-press .35s ease-out; }
#ramble .rb-ar-label.rb-ar-fx-busy,
#ramble .rb-ar-row.rb-ar-fx-busy,
#ramble .rb-pop-btn.is-busy { animation: rb-busy .9s ease-in-out infinite; }
#ramble .rb-ar-label:not([data-side]).rb-ar-fx-collect .rb-ar-egg-art { display: block; animation: rb-collect .9s ease-in forwards; transform-origin: 50% 50%; }
#ramble .rb-ar-row.rb-ar-fx-collect { animation: rb-press .9s ease-out; }
#ramble .rb-nest-pin.rb-nest-busy { animation: rb-busy .9s ease-in-out infinite; }
#ramble .rb-nest-pin.rb-nest-collect svg { animation: rb-nest-pop .9s ease-in forwards; transform-origin: 50% 100%; }

/* Reduced motion: the SAME full selectors (a media query adds no specificity). */
@media (prefers-reduced-motion: reduce) {
  #ramble .rb-ar-label.rb-ar-tapped,
  #ramble .rb-ar-label.rb-ar-fx-busy,
  #ramble .rb-ar-row.rb-ar-fx-busy,
  #ramble .rb-pop-btn.is-busy,
  #ramble .rb-ar-label:not([data-side]).rb-ar-fx-collect .rb-ar-egg-art,
  #ramble .rb-ar-row.rb-ar-fx-collect,
  #ramble .rb-nest-pin.rb-nest-busy,
  #ramble .rb-nest-pin.rb-nest-collect svg { animation: none; }
}
```

- [ ] **Step 4: Run** `node scripts/run-suite.mjs tests/ramble-panel.test.js tests/ramble-ar.test.js` → all pass; `grep -c '\`' bundles/ramble/panel/static/ramble.js` = 0; `grep -cE '\.innerHTML\s*=|\bhtml:\s' bundles/ramble/panel/static/ramble.js` = 2; `node --check bundles/ramble/panel/static/ramble.js`.

- [ ] **Step 5: Commit**
```bash
git commit bundles/ramble/panel/static/ramble.js bundles/ramble/panel/static/ramble.css tests/ramble-panel.test.js -m "ramble panel: you-are-here dot with follow mode, egg art on near AR nests, collect animation"
```

---

## Task 3: Docs en/es, spec amendment, 0.6.0, registry, suite, PR, deploy

- [ ] **Step 1: Docs (paragraph edits only; no new headings).** `docs/guide/ramble.md` line 7 (the intro paragraph beginning "Ramble is a proximity extension"): append the sentence ` A blue dot with an accuracy ring follows you on the map; **Around you** toggles follow mode (dragging the map turns it off).` `docs/es/guide/ramble.md` line 7 (the paragraph beginning "Ramble es una extensión de proximidad"): append ` Un punto azul con un anillo de precisión te sigue en el mapa; **Alrededor de ti** activa o desactiva el modo seguir (arrastrar el mapa lo desactiva).` In `## The AR view`, first paragraph, append: ` Within 75 m of a nest its label turns gold and shows the egg itself; tap it for the sheet, press **Take the egg**, and the label, the pin and the button pulse while your position is checked, then the egg flies down toward your bird when it is yours (the map pin pops the same way).` In `## La vista AR`, first paragraph, append: ` A menos de 75 m de un nido su etiqueta se vuelve dorada y muestra el huevo; tócala para abrir la hoja, pulsa **Tomar el huevo**, y la etiqueta, el pin y el botón laten mientras se comprueba tu posición; luego el huevo baja volando hacia tu pájaro cuando es tuyo (el pin del mapa hace lo mismo).` Run `node scripts/run-suite.mjs tests/ramble-panel.test.js` (parity).
- [ ] **Step 2: Spec.** §3 World bullet: append ` A you-are-here dot + accuracy ring follows the user; the Around-you chip is a follow toggle that pans only when the dot leaves the middle of the view (phase 5).` §6 amendments bullet: append the sentence below (keep the code spans on the two field names):

```
 Anchors may carry `reach_m` and `art`; a near nest label shows the art and turns gold, "right here" beats "ahead" in the bird's line, and the tap/collect effects run on the label, the radar row and the map pin (phase 5).
```
- [ ] **Step 3: Bump + registry.** `sed -i 's/"version": "0.5.0"/"version": "0.6.0"/' bundles/ramble/manifest.json bundles/ramble/package.json && npm run build-registry && git diff --stat registry/add-ons.json`.
- [ ] **Step 4: Integration gate.** `node scripts/run-suite.mjs 2>&1 | tail -12` (expect pass = total, fail 0), `node scripts/check-port-allocation.js`, `npm run build-registry -- --check`.
- [ ] **Step 5: Commit** `git commit docs/guide/ramble.md docs/es/guide/ramble.md docs/superpowers/specs/2026-09-07-ramble-flock-design.md bundles/ramble/manifest.json bundles/ramble/package.json registry/add-ons.json -m "ramble 0.6.0: you-are-here dot, egg art in AR, collect animation — docs en/es, spec, registry"`.
- [ ] **Step 6 (controller): push, PR, check-runs green on the head sha, merge; read CROW-SCHEDULE.md; restart the three gateways back-to-back; grackle journal shows `refreshed ramble 0.5.0 -> 0.6.0`; phone smoke (Kevin): the dot follows on the map and the chip toggles follow; a nest within 75 m shows the egg in AR and the label turns gold; tapping pulses; taking it flies the egg to the bird and pops the pin.

## Self-review notes
- Ask 1 (a pin that tracks the user) → Task 2(b)(c): one watch, dot + ring on their own pane, follow chip, drag-off, bounded pans.
- Ask 2 (egg image in AR within field of sight / close enough) → Task 1 `near`/`art` + Task 2(e) `nestArt` with `reach_m: CLAIM_M`; gold + art only for a near nest that is in view; the sheet's "Take the egg" is the action.
- Ask 3 (animation on touch confirming the action started) → Task 1 synchronous tap flash + Task 2(f) sticky busy pulse at press (label, row, pin, sheet button), collect fly-away + pin pop on success, clear on any other outcome.
- Sinks: `drawEggSeed` owns the single `el.innerHTML = Bird.drawEgg(`; `nestEggHtml` untouched; the renderer appends an element.
- Type consistency: `reach_m`/`art` ↔ `layoutAnchor` ↔ `mountArt(byId[id].art)`; `fx(id, "busy"|"clear"|"collect")` ↔ `collectFx` phases `start|done|clear`; CSS classes `rb-ar-fx-busy`/`rb-ar-fx-collect`/`rb-nest-busy`/`rb-nest-collect`/`rb-ar-tapped`/`is-busy` match the code.

## Review

### Round 1 (2026-09-07, adversarial staff-engineer subagent, code-traced against main @0abd344a; the arithmetic executed, the painter hand-simulated line by line) — REVISE → fixed inline
Ten criticals, all folded in: **C1** art inserted at `children[0]` was overwritten by the painter's index-based title/sub updates (the egg vanished on the next orientation event) → the art is APPENDED last and put first by CSS `order`; the test asserts `children[2] === art` and that the art's text is never written. **C2** the fake document lacked `insertBefore`/`style.setProperty` → neither is used now (append + a `filter`/`box-shadow` press flash, no `--rb-s`). **C3** the painter test mounted a second session on the same elements and clicked the first session's node → one session with a swappable `tapHook`. **C4** strict-mode block-scoped function declarations inside the map `if` made the whole you-are-here feature a swallowed `ReferenceError` → every function is IIFE-level with `if (!map) return`. **C5** reduced-motion overrides lost on specificity → the block repeats the full selectors. **C6** `rb-nest-pop` animated `transform` on the Leaflet icon (its map position) → the pin's inner `svg` animates instead. **C7** `"reach_m: UNLOCK_M"` could never match `isLocked(mark) ? UNLOCK_M : null` → the assertion pins `"UNLOCK_M : null"`. **C8** `collectFx(cell, "clear")` re-added busy and could not reach the sheet button → explicit `start|done|clear` mapping; `is-busy` handled in `claimNest`. **C9** follow mode panned on every fix (a 1 Hz `publishArea` + `refreshNests` loop) → pan only when moved > 10 m AND outside the middle 40 % of the view. **C10** the map pop was cut off by `refreshNests` and the AR fly-away played behind the sheet → the sheet closes on success and the layer rebuild waits 900 ms.
Suggestions applied: **S1** `nestArt` refreshes the claimed class every call; **S2** art only when not parked; **S3** no transform animation on labels; **S4** parking beats the boost (stated); **S5** a `rb-here` pane (450 then; superseded by round-2 N2/Q1: 650); **S6** one watch (the AR view reuses the map's); **S7** `aria-hidden` on the art; **S8** docs say "flies down toward your bird"; **S9** contradictions removed (`busy|clear|collect`; the chip markup is untouched); **S10** exact docs anchors (line 7 in both guides; the first paragraph of the AR section); **S11** CROW-SCHEDULE + GitHub-MCP notes re-copied; **S12** `nestMarkers = {}` placed after the layer clear.
Rulings: **Q1** reach beats sight — the nearest near item owns the say line in every mode. **Q2** the gold near look and the art are for nests; a near locked mark only changes its sub to "close enough · unlock". **Q3** busy is sticky until `clear`; collect is the timed effect. **Q4** in radar mode the effect runs on the list row (fx targets both). **Q5** PR #320 exempts `/api/ramble/` so C9 was traffic, not a 429; bounded anyway.

### Round 2 (2026-09-07, fresh adversarial subagent; the plan's Task 1 code + tests EXECUTED in a scratch mirror — 11/11, three mutations each failing the right test; Task 2 applied to a copy — node --check clean, 0 backticks, exactly 2 sinks, every anchor string the plan names found exactly once, a vm runtime smoke with stubbed Leaflet/geolocation) — REVISE → fixed inline
All ten round-1 fixes HOLD (C1 by mutation; C4 by a runtime smoke; C5 by a selector diff; C6 confirmed the divIcon holds an `<svg>`; C9 confirmed `LatLngBounds.pad`/`contains([lat, lon])` on Leaflet 1.9.4). New: **N1** the markup ships the "Around you" chip lit while `following` is false (reproduced: a failed first fix left a lit chip that did nothing on tap) → `setFollowing(false)` right after `startMapWatch()` at startup. **N4** the AR view's "permission revoked → Waiting for a fix…" handling lived in its own watch's error callback, which the shared map watch bypassed → the map watch's error callback resets `arPose` on `code === 1` while AR is open (pinned). **N5** the watch was cleared on `pagehide` and never restarted (a bfcache return froze the dot) → `pageshow` restarts it (pinned).
Suggestions applied: **N2** the pane comment was false (Leaflet markers sit at 600) — and ruling **Q1**: the pane is now 650 so the user's dot never hides under a pin; **N3** ruling **Q2**: losing the sheet's "on your shelf" line in AR is accepted (the fly-away, the bird's line and the shelf say it) — commented; **N6** ruling **Q3**: the watch runs only while the document is visible (`visibilitychange` + `pagehide`/`pageshow`); **N7** the renderer header names the art mount and the two new anchor fields; **N8** both guides say the pulse starts on "Take the egg" and it is the label/pin/button that pulse; **N9** the collect fly-away is gated on `:not([data-side])` like the art; `destroy()` cancels timers on rows too and BEFORE the maps are reset; the coarse-strip `rowNodes` overwrite is commented; a near nest's sub reads "close enough · take it" so the gold state has a text twin; the under-overlay follow traffic is stated.

### Scoped check (2026-09-07, narrow re-review of the round-2 edits; Task 1 executed 11/11 with a destroy() timer probe, Task 2 applied to a copy — node --check clean, 0 backticks, 2 sinks, 21/21 panel strings, 14/14 CSS regexes, reduced-motion selectors byte-equal ×2, a vm runtime smoke of startup/visibility/pagehide/follow gate) — APPROVE
Every round-2 edit HOLDS; two candidate defects probed and cleared (a degenerate pan gate off the world view — Leaflet caches `_size`, so bounds stay real; the `if (mapWatch != null)` pin — unique to `startArGps`). Cosmetics applied: the §6 spec sentence is now a fenced block (nested code spans); the round-1 S5 line notes it was superseded (650); the `destroy()` wording is "the very first statement"; Task 2 Consumes lists `arAnchors`; the round-2 header no longer claims a string count; the pane comment notes the tooltip-pane tie. Deferred: orphan flash timers on removed nodes are inert; the `ramble-nest-claimed` SSE handler's immediate `refreshNests()` can cut a pin pop short for the echo — pre-existing plumbing, noted for the follow-up.

**Status: plan complete, three review gates passed (round 1: 10 criticals; round 2: 3 new criticals; scoped check: 0 defects). Awaiting Kevin's approval before execution (superpowers:subagent-driven-development in `/home/kh0pp/crow-wt-ramble5`).**
