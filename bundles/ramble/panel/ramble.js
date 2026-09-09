/**
 * Crow's Nest Panel — Ramble.
 *
 * World-first: the map IS the home screen. Four views (world | egg | pet |
 * flock) live in one element and are switched by `data-view` on `#ramble`; the
 * privacy grid moved out of the page flow into `#rb-grid-sheet`, reached from
 * the "Visible" chip on the map. Visual direction C — chunky display type,
 * 2.5px outlines, hard offset shadows, amber/indigo/pink — all of it in
 * `static/ramble.css`, which is why this file no longer carries a <style>.
 *
 * Phase 3: the compose card gains a Group audience, the flock view a Swaps
 * card with Gift / Swap / Accept / Decline, and a picker sheet
 * (`#rb-pick-sheet`) for choosing a contact or an egg.
 *
 * Phase 4: the map bar gains "Look around", which opens #rb-ar — a full-screen
 * camera view painted by static/ramble-ar.js (labels by bearing and distance,
 * a radar strip when the camera or compass is missing).
 *
 * COPIED ALONE to `$CROW_HOME/panels/ramble.js` at install, so it carries no
 * relative `../server/*` import; anything it needs from the bundle is resolved
 * through BUNDLE_DIR at request time. Every HTTP surface it talks to lives in
 * the companion `panel/routes.js` (STRICT_PANEL_MOUNT contract).
 *
 * The page is rendered static: grid state, marks, the egg and the pet are all
 * fetched by `static/ramble.js` from `/api/ramble/*`, and every bird and egg
 * is DRAWN in the browser by `/ramble/static/bird-svg.js` (the same engine the
 * server renders portraits with), so the panel still renders when the bundle's
 * server modules or the db are unavailable.
 */

const OSM_ATTRIBUTION = "&copy; OpenStreetMap contributors";

const AUDIENCES = ["public", "contacts", "groups"];
const CHANNELS = ["ble", "lan", "geo"];

// Google Fonts is already on the dashboard CSP allow-list (style-src
// fonts.googleapis.com, font-src fonts.gstatic.com); the stylesheet gives
// every family a system fallback, so a blocked/offline load is a shrug.
const FONTS_HREF = "https://fonts.googleapis.com/css2?family=Baloo+2:wght@700;800&family=Nunito:wght@600;700;800&display=swap";

/** Inline SVG only — never emoji: emoji render as someone else's art direction. */
const ICONS = {
  target: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>',
  eye: '<path d="M3 12s3-6 9-6 9 6 9 6-3 6-9 6-9-6-9-6z"/><circle cx="12" cy="12" r="2.5"/>',
  pin: '<path d="M12 21s-7-6-7-11a7 7 0 0 1 14 0c0 5-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/>',
  caw: '<path d="M4 12a8 8 0 0 1 16 0c0 2-1 3-2 4l-2 2H8l-2-2c-1-1-2-2-2-4z"/><path d="M9 21h6"/>',
  close: '<path d="M18 6 6 18M6 6l12 12"/>',
  feed: '<path d="M4 14c4-1 7 1 8 5 1-4 4-6 8-5"/><path d="M12 19V9"/><path d="M8 8c1-3 3-4 4-6 1 2 3 3 4 6"/>',
  preen: '<path d="M6 20c2-6 6-10 12-14"/><path d="M8 14l-3-1M11 10 8 8M14 7l-2-3"/>',
  play: '<circle cx="12" cy="12" r="9"/><path d="M8 12h8M12 8v8"/>',
  back: '<path d="M19 12H5"/><path d="m12 19-7-7 7-7"/>',
  nest: '<path d="M4 14c0 3 4 6 8 6s8-3 8-6"/><path d="M3 14h18"/><path d="M8 14c0-4 2-7 4-8 2 1 4 4 4 8"/>',
  flock: '<circle cx="7" cy="9" r="3"/><circle cx="17" cy="9" r="3"/><path d="M4 19c1-3 3-4 3-4s2 1 3 4M14 19c1-3 3-4 3-4s2 1 3 4"/>',
  ar: '<path d="M4 9V5a1 1 0 0 1 1-1h4M15 4h4a1 1 0 0 1 1 1v4M20 15v4a1 1 0 0 1-1 1h-4M9 20H5a1 1 0 0 1-1-1v-4"/><circle cx="12" cy="12" r="3"/>',
};

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function icon(name) {
  return `<svg class="rb-i" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ""}</svg>`;
}

export default {
  id: "ramble",
  name: "Ramble",
  icon: "map-pin",
  route: "/dashboard/ramble",
  navOrder: 120,
  category: "social",

  async handler(req, res, { db, layout }) {
    // Spec §11: OpenStreetMap public tiles are the phase-1 default, with the
    // tile URL configurable in settings. The URL itself is NOT rendered here:
    // the dashboard CSP is img-src 'self', so the client always draws from the
    // same-origin proxy (/ramble/tiles) and the proxy is what reads
    // `ramble_settings.tile_url`. Only the attribution is a page concern.
    let tileAttribution = OSM_ATTRIBUTION;
    if (db) {
      try {
        const { rows } = await db.execute({
          sql: "SELECT value FROM ramble_settings WHERE key = 'tile_attribution'",
          args: [],
        });
        if (rows[0]?.value) tileAttribution = String(rows[0].value);
      } catch { /* default */ }
    }

    // The checkbox `name` is the wire contract with POST /api/ramble/grid and
    // is asserted by tests/ramble-panel.test.js — the label wrapper around it
    // is only there to make the whole 44px cell tappable.
    const gridRows = AUDIENCES.map((audience) => {
      const cells = CHANNELS.map((channel) => `
                <td><label><input type="checkbox" class="rb-grid-cell" name="grid-${esc(audience)}-${esc(channel)}"
                      data-audience="${esc(audience)}" data-channel="${esc(channel)}"
                      aria-label="${esc(audience)} over ${esc(channel)}"></label></td>`).join("");
      return `
              <tr><th scope="row">${esc(audience)}</th>${cells}</tr>`;
    }).join("");

    const content = `
      <link rel="stylesheet" href="/ramble/static/leaflet/leaflet.css">
      <link rel="stylesheet" href="/ramble/static/ramble.css">
      <link rel="preconnect" href="https://fonts.googleapis.com">
      <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
      <link rel="stylesheet" href="${esc(FONTS_HREF)}">

      <div id="ramble" data-view="world">

        <!-- ─────────────────────────────────────────────── world (the home) -->
        <section class="rb-view" data-for="world">

          <div class="rb-map">
            <div id="rb-map" data-tile-attribution="${esc(tileAttribution)}"></div>

            <div class="rb-mapbar">
              <button class="rb-chip is-on" id="rb-chip-around" type="button" aria-pressed="true">${icon("target")}<span>Around you</span></button>
              <button class="rb-chip" id="rb-chip-visible" type="button" aria-haspopup="dialog">${icon("eye")}<span id="rb-chip-visible-label">Visible: off</span></button>
              <button class="rb-chip" id="rb-chip-ar" type="button" aria-haspopup="dialog">${icon("ar")}<span>Look around</span></button>
              <span class="rb-seed" title="Bird seed"><strong id="rb-seed-count">0</strong><span>seed</span></span>
              <span class="rb-hearts" title="Heart containers"><strong id="rb-heart-count">0</strong><span>hearts</span></span>
            </div>

            <div class="rb-perch">
              <div class="rb-say" id="rb-perch-say" hidden></div>
              <button class="rb-btn rb-btn-ghost rb-perch-go" id="rb-perch-open" type="button">Your egg</button>
            </div>
          </div>

          <section class="rb-card rb-compose">
            <div>
              <p class="rb-eyebrow">Right here</p>
              <h3 class="rb-h">Leave something for whoever comes next</h3>
              <p class="rb-muted rb-fine">A <strong>mark</strong> stays on this spot for a day. A <strong>caw</strong> is a one-hour hello to anyone nearby.</p>
            </div>

            <textarea id="rb-text" maxlength="2000" placeholder="Say it in a sentence&hellip;"></textarea>

            <div class="rb-row">
              <span class="rb-label">Who</span>
              <div class="rb-seg" id="rb-seg-who" role="group" aria-label="Who can see this">
                <button type="button" class="is-on" data-visibility="public" aria-pressed="true">Everyone</button>
                <button type="button" data-visibility="contacts" aria-pressed="false">Contacts</button>
                <button type="button" data-visibility="group" aria-pressed="false" id="rb-who-group" hidden>Group</button>
                <button type="button" data-visibility="private" aria-pressed="false">Just me</button>
              </div>
            </div>
            <div class="rb-row" id="rb-group-row" hidden>
              <label class="rb-label" for="rb-group">Group</label>
              <select id="rb-group" aria-label="Which group"></select>
            </div>

            <div class="rb-row">
              <span class="rb-label">Reveal</span>
              <div class="rb-seg" id="rb-seg-reveal" role="group" aria-label="How it reveals">
                <button type="button" class="is-on" data-reveal="open" aria-pressed="true">Open</button>
                <button type="button" data-reveal="locked" aria-pressed="false">Locked</button>
              </div>
            </div>

            <div class="rb-row rb-actions">
              <button class="rb-btn rb-grow" id="rb-leave" type="button">${icon("pin")}Leave a mark</button>
              <button class="rb-btn rb-btn-ghost" id="rb-caw" type="button">${icon("caw")}Caw</button>
            </div>

            <p class="rb-muted rb-fine" id="rb-compose-status">You&rsquo;re invisible until you flip <strong>Visible</strong> on. Nothing leaves your phone before that.</p>
          </section>

          <section class="rb-card">
            <p class="rb-eyebrow" id="rb-nearby-count">Nearby</p>
            <div class="rb-steps" id="rb-nearby"></div>
          </section>
        </section>

        <!-- ───────────────────────────────────────────────────────── the egg -->
        <section class="rb-view" data-for="egg">
          <section class="rb-card rb-center">
            <p class="rb-eyebrow">Your egg</p>
            <h3 class="rb-h">Something&rsquo;s stirring in there</h3>
            <p class="rb-muted rb-fine">It hatches as you get around. Nobody knows what&rsquo;s inside yet, not even us.</p>

            <div class="rb-ring" id="rb-egg-stage">
              <svg class="rb-ring-track" viewBox="0 0 240 240" aria-hidden="true">
                <circle class="rb-ring-trk" cx="120" cy="120" r="108" stroke-width="15" fill="none"/>
                <circle id="rb-egg-ring" class="rb-ring-prg" cx="120" cy="120" r="108" stroke-width="15" fill="none"
                        stroke-linecap="round" stroke-dasharray="678.6" stroke-dashoffset="678.6"/>
              </svg>
              <svg id="rb-egg-art" class="rb-eggart" viewBox="0 0 120 152" role="img" aria-label="Your egg"></svg>
              <svg id="rb-hatch-bird" class="rb-hatch-bird" viewBox="0 0 200 200" role="img" aria-label="Your new bird" hidden></svg>
            </div>

            <p class="rb-big" id="rb-egg-percent">&mdash;</p>
            <p class="rb-muted rb-fine" id="rb-egg-line">Reading the warmth&hellip;</p>
            <p class="rb-muted rb-fine" id="rb-egg-empty" hidden>Nests hold them. So do friends.</p>
          </section>

          <section class="rb-card rb-hatch-reveal" id="rb-hatch-reveal" hidden>
            <p class="rb-eyebrow">It hatched</p>
            <h3 class="rb-h" id="rb-hatch-name">It&rsquo;s a bird!</h3>
            <button class="rb-btn" id="rb-meet-bird" type="button">Meet your bird</button>
          </section>

          <section class="rb-card">
            <p class="rb-eyebrow">What warms it up</p>
            <div class="rb-steps">
              <div class="rb-step" id="rb-step-places">
                <span class="rb-step-n" id="rb-step-places-n">0/3</span>
                <div class="rb-step-txt"><strong>Visit new places</strong><span class="rb-muted rb-fine">a new area you haven&rsquo;t been this week</span></div>
              </div>
              <div class="rb-step" id="rb-step-mark">
                <span class="rb-step-n" id="rb-step-mark-n">&middot;</span>
                <div class="rb-step-txt"><strong>Leave your first mark</strong><span class="rb-muted rb-fine" id="rb-step-mark-line">nothing left yet</span></div>
              </div>
              <div class="rb-step" id="rb-step-checkin">
                <span class="rb-step-n" id="rb-step-checkin-n">&middot;</span>
                <div class="rb-step-txt"><strong>Check in today</strong><span class="rb-muted rb-fine" id="rb-step-checkin-line">a tap a day keeps it warm</span></div>
              </div>
            </div>
            <p class="rb-muted rb-fine">Getting around does most of the work. Check-ins help a little, so a slow week still gets there.</p>
          </section>

          <div class="rb-row rb-actions">
            <button class="rb-btn rb-grow" id="rb-go-outside" type="button">${icon("pin")}Go outside</button>
            <button class="rb-btn rb-btn-ghost" id="rb-checkin" type="button">Check in</button>
            <button class="rb-btn rb-btn-ghost" id="rb-egg-flock" type="button">${icon("flock")}Flock</button>
            <!-- Only once something has hatched: before that there is no bird
                 to go and see, and this is the only way back to the pet. -->
            <button class="rb-btn rb-btn-ghost" id="rb-my-bird" type="button" hidden>My bird</button>
          </div>
          <p class="rb-muted rb-fine" id="rb-egg-status"></p>
        </section>

        <!-- ───────────────────────────────────────────────────────── the pet -->
        <section class="rb-view" data-for="pet">
          <section class="rb-stage">
            <div class="rb-stage-name">
              <p class="rb-eyebrow">My bird</p>
              <h3 class="rb-h" id="rb-pet-name">Still an egg</h3>
              <p class="rb-muted rb-fine" id="rb-pet-traits"></p>
            </div>
            <svg id="rb-pet-bird" class="rb-bird rb-bob" viewBox="0 0 200 200" role="img" aria-label="Your bird, up close"></svg>
          </section>

          <section class="rb-card">
            <div class="rb-meter">
              <strong class="rb-meter-label">Energy</strong>
              <span class="rb-meter-bar"><i id="rb-energy-fill"></i></span>
              <strong id="rb-energy-num">&mdash;</strong><span class="rb-meter-of">/ <span id="rb-energy-max">100</span></span>
            </div>
            <p class="rb-hearts-line"><span id="rb-heart-row" class="rb-heart-row"></span><span class="rb-muted rb-fine" id="rb-heart-line"></span></p>
            <p class="rb-muted rb-fine" id="rb-mood-line">Checking on it&hellip;</p>
          </section>

          <section class="rb-card">
            <p class="rb-eyebrow">Today</p>
            <div class="rb-chores">
              <button class="rb-chore" data-kind="feed" type="button">${icon("feed")}Feed</button>
              <button class="rb-chore" data-kind="preen" type="button">${icon("preen")}Preen</button>
              <button class="rb-chore" data-kind="play" type="button">${icon("play")}Play</button>
            </div>
            <p class="rb-muted rb-fine">Three taps a day. Miss a few and it gets droopy, never worse than that.</p>
            <p class="rb-muted rb-fine" id="rb-pet-status"></p>
          </section>

          <details class="rb-card rb-fold" id="rb-runs-on" open>
            <summary class="rb-eyebrow rb-fold-sum">What your bird runs on</summary>
            <div class="rb-steps">
              <div class="rb-step">
                <span class="rb-step-n">+20</span>
                <div class="rb-step-txt"><strong>Meet another crow</strong><span class="rb-muted rb-fine">run into someone else out rambling</span></div>
              </div>
              <div class="rb-step">
                <span class="rb-step-n">+15</span>
                <div class="rb-step-txt"><strong>Somewhere new</strong><span class="rb-muted rb-fine">an area you haven&rsquo;t been this week</span></div>
              </div>
              <div class="rb-step">
                <span class="rb-step-n">+10</span>
                <div class="rb-step-txt"><strong>Unlock a mark</strong><span class="rb-muted rb-fine">open something someone left behind</span></div>
              </div>
              <div class="rb-step">
                <span class="rb-step-n">+8</span>
                <div class="rb-step-txt"><strong>A daily chore</strong><span class="rb-muted rb-fine">feed, preen or play, once a day each</span></div>
              </div>
              <div class="rb-step">
                <span class="rb-step-n">+5</span>
                <div class="rb-step-txt"><strong>Check in</strong><span class="rb-muted rb-fine">a daily tap on the egg screen</span></div>
              </div>
              <div class="rb-step">
                <span class="rb-step-n">&minus;10</span>
                <div class="rb-step-txt"><strong>A quiet stretch</strong><span class="rb-muted rb-fine">nothing at all for a while and it droops</span></div>
              </div>
            </div>
            <p class="rb-muted rb-fine">Getting out is worth more than tapping.</p>
          </details>

          <section class="rb-card">
            <p class="rb-eyebrow">This week</p>
            <div class="rb-stats">
              <div><strong id="rb-stat-places">0</strong><span class="rb-muted">places</span></div>
              <div><strong id="rb-stat-unlocks">0</strong><span class="rb-muted">unlocked</span></div>
              <div><strong id="rb-stat-crows">0</strong><span class="rb-muted">crows met</span></div>
            </div>
          </section>

          <!-- The successor egg is minted the moment one hatches, and the perch
               swaps to the bird for good — so without this the egg view (and
               its daily check-in) would be unreachable after the first hatch. -->
          <section class="rb-card" id="rb-pet-nextegg">
            <p class="rb-eyebrow">Next egg</p>
            <div class="rb-row">
              <span class="rb-ring rb-ring-mini">
                <svg class="rb-ring-track" viewBox="0 0 240 240" aria-hidden="true">
                  <circle class="rb-ring-trk" cx="120" cy="120" r="108" stroke-width="30" fill="none"/>
                  <circle id="rb-nextegg-ring" class="rb-ring-prg" cx="120" cy="120" r="108" stroke-width="30" fill="none"
                          stroke-linecap="round" stroke-dasharray="678.6" stroke-dashoffset="678.6"/>
                </svg>
                <svg id="rb-nextegg-art" class="rb-eggart" viewBox="0 0 120 152" role="img" aria-label="Your next egg"></svg>
              </span>
              <strong class="rb-big rb-grow" id="rb-nextegg-percent">&mdash;</strong>
              <button class="rb-btn rb-btn-ghost" id="rb-see-egg" type="button">See egg</button>
            </div>
            <p class="rb-muted rb-fine" id="rb-nextegg-empty" hidden>Nothing warming just now.</p>
            <p class="rb-muted rb-fine" id="rb-nextegg-lay" hidden></p>
            <p class="rb-muted rb-fine" id="rb-nextegg-waiting" hidden>One&rsquo;s waiting on your shelf.</p>
            <button class="rb-btn rb-btn-ghost" id="rb-nextegg-warm" type="button" hidden>Warm it</button>
          </section>

          <button class="rb-btn" id="rb-my-flock" type="button">${icon("flock")}My flock</button>
          <button class="rb-btn rb-btn-ghost" id="rb-back-world" type="button">${icon("back")}Back to the world</button>
        </section>

        <!-- ─────────────────────────────────────────────────────── the flock -->
        <section class="rb-view" data-for="flock">
          <section class="rb-card">
            <p class="rb-eyebrow">Your flock</p>
            <h3 class="rb-h" id="rb-flock-kinds">8 kinds, 0 found</h3>
            <p class="rb-muted rb-fine">Tap a bird to take it out with you. The one with the tag is on your map, your header and your caws.</p>
            <div class="rb-flock-grid" id="rb-flock-birds"></div>
            <p class="rb-muted rb-fine" id="rb-flock-empty">Nothing has hatched yet. Your first bird is warming up on the egg screen.</p>
          </section>

          <section class="rb-card">
            <p class="rb-eyebrow">Egg shelf</p>
            <p class="rb-muted rb-fine" id="rb-shelf-count">Nests appear on the map as eggs. Walk up to one to take it.</p>
            <div class="rb-steps" id="rb-shelf"></div>
            <p class="rb-muted rb-fine" id="rb-flock-status"></p>
          </section>

          <section class="rb-card">
            <p class="rb-eyebrow">Swaps</p>
            <p class="rb-muted rb-fine">Offer a shelf egg to a contact; they answer with one of theirs. Nobody knows what is inside until it hatches. Offers lapse after a week.</p>
            <div class="rb-steps" id="rb-trades"></div>
            <p class="rb-muted rb-fine" id="rb-trade-status"></p>
          </section>

          <div class="rb-row rb-actions">
            <button class="rb-btn rb-btn-ghost rb-grow" id="rb-flock-bird-btn" type="button">My bird</button>
            <button class="rb-btn rb-btn-ghost" id="rb-flock-back" type="button">${icon("back")}Back to the world</button>
          </div>
        </section>

        <!-- ─────────────────────────────────────── the privacy grid, on demand -->
        <div class="rb-sheet" id="rb-grid-sheet" hidden>
          <div class="rb-sheet-panel" role="dialog" aria-modal="true" aria-labelledby="rb-sheet-title">
            <div class="rb-sheet-head">
              <h3 class="rb-h" id="rb-sheet-title">Who can see me</h3>
              <button class="rb-icon-btn" id="rb-grid-close" type="button" aria-label="Close">${icon("close")}</button>
            </div>
            <p class="rb-muted rb-fine">Nothing broadcasts unless the master switch <em>and</em> the specific cell are on.</p>

            <label class="rb-switch"><input type="checkbox" id="rb-master"><span>I&rsquo;m visible (master switch)</span></label>

            <table class="rb-grid">
              <thead><tr><th></th>${CHANNELS.map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead>
              <tbody>${gridRows}</tbody>
            </table>

            <div class="rb-row">
              <label class="rb-label" for="rb-identity">Name</label>
              <select id="rb-identity">
                <option value="rotating">rotating</option>
                <option value="pseudonym">pseudonym</option>
                <option value="real">real</option>
              </select>
            </div>
            <div class="rb-row">
              <label class="rb-label" for="rb-world-name">World name</label>
              <input id="rb-world-name" type="text" maxlength="24" autocomplete="nickname" placeholder="how strangers see you">
            </div>
            <p class="rb-muted rb-fine">Strangers see your world name on your marks when Name is pseudonym or real, next to a short key so two people with one name stay apart. Contacts see the name they saved for you, or your Crow name.</p>
            <p class="rb-muted rb-fine" id="rb-grid-status"></p>
          </div>
        </div>

        <!-- ─────────────────────────────────── pick a contact or an egg, on demand -->
        <div class="rb-sheet" id="rb-pick-sheet" hidden>
          <div class="rb-sheet-panel" role="dialog" aria-modal="true" aria-labelledby="rb-pick-title">
            <div class="rb-sheet-head">
              <h3 class="rb-h" id="rb-pick-title">Pick one</h3>
              <button class="rb-icon-btn" id="rb-pick-cancel" type="button" aria-label="Close">${icon("close")}</button>
            </div>
            <div class="rb-steps" id="rb-pick-list"></div>
          </div>
        </div>

        <!-- ───────────────────────────────────────── the AR view (phase 4, spec §6) -->
        <!-- Full-screen over the rear camera. The renderer (ramble-ar.js) paints
             labels into #rb-ar-labels and dots into #rb-ar-ring; data-mode flips
             between "ar" and "radar" (never blank: no camera or no compass shows
             the ring + list). The camera picture is a background only. -->
        <div class="rb-ar" id="rb-ar" data-mode="radar" data-reason="no-fix" data-camera="on" hidden>
          <video id="rb-ar-video" class="rb-ar-video" autoplay muted playsinline aria-hidden="true"></video>

          <div class="rb-ar-top">
            <span class="rb-chip is-on rb-ar-modechip"><span id="rb-ar-mode-label">Radar</span></span>
            <button class="rb-icon-btn" id="rb-ar-close" type="button" aria-label="Close the AR view">${icon("close")}</button>
          </div>

          <div class="rb-ar-labels" id="rb-ar-labels" aria-live="polite"></div>
          <p class="rb-ar-more rb-fine" id="rb-ar-more"></p>
          <div class="rb-steps rb-ar-coarse" id="rb-ar-coarse"></div>

          <section class="rb-ar-radar" id="rb-ar-radar" aria-label="Radar strip">
            <svg class="rb-ar-ringsvg" viewBox="0 0 100 100" role="img" aria-label="Bearing ring">
              <circle class="rb-ar-ring-track" cx="50" cy="50" r="42"/>
              <circle class="rb-ar-ring-track" cx="50" cy="50" r="21"/>
              <path class="rb-ar-ring-north" d="M50 3l3.5 7h-7z"/>
              <circle class="rb-ar-ring-me" cx="50" cy="50" r="2.4"/>
              <g id="rb-ar-ring"></g>
            </svg>
            <div class="rb-steps rb-ar-list" id="rb-ar-list"></div>
          </section>

          <div class="rb-ar-perch">
            <div class="rb-say" id="rb-ar-say">Getting your bearings&hellip;</div>
            <svg id="rb-ar-bird" class="rb-bird rb-ar-bird" viewBox="0 0 200 200" role="img" aria-label="Your bird" hidden></svg>
            <svg id="rb-ar-egg" class="rb-eggart rb-ar-egg" viewBox="0 0 120 152" role="img" aria-label="Your egg"></svg>
          </div>

          <section class="rb-card rb-ar-notice" id="rb-ar-notice" hidden>
            <p class="rb-eyebrow">Before you look around</p>
            <h3 class="rb-h">What this can and can&rsquo;t do</h3>
            <ul class="rb-fine rb-ar-limits">
              <li>Labels float by <strong>direction and distance</strong> only. Nothing sticks to walls or the ground.</li>
              <li>Direction comes from the phone&rsquo;s compass, which can be off by tens of degrees. Hold the phone upright; if labels drift, wave it in a figure eight.</li>
              <li>On an iPhone, Safari asks once for <strong>motion access</strong>. Say no and you get the radar strip instead.</li>
              <li>No camera or no compass means the <strong>radar strip</strong>: a bearing ring and a distance list. Never a blank screen.</li>
              <li>The camera picture <strong>stays on this phone</strong>. Nothing from it is sent anywhere.</li>
            </ul>
            <button class="rb-btn" id="rb-ar-gotit" type="button">Got it</button>
          </section>
        </div>

        <!-- A tapped AR label opens the SAME popup its map pin would, in a sheet. -->
        <div class="rb-sheet rb-ar-sheet" id="rb-ar-sheet" hidden>
          <div class="rb-sheet-panel" role="dialog" aria-modal="true" aria-labelledby="rb-ar-sheet-title">
            <div class="rb-sheet-head">
              <h3 class="rb-h" id="rb-ar-sheet-title">Right there</h3>
              <button class="rb-icon-btn" id="rb-ar-sheet-close" type="button" aria-label="Close">${icon("close")}</button>
            </div>
            <div id="rb-ar-sheet-body"></div>
          </div>
        </div>
      </div>

      <script src="/ramble/static/leaflet/leaflet.js"></script>
      <script src="/ramble/static/bird-svg.js"></script>
      <script src="/ramble/static/ramble-ar.js"></script>
      <script src="/ramble/static/ramble.js"></script>
    `;

    res.send(layout({ title: "Ramble", content }));
  },
};
