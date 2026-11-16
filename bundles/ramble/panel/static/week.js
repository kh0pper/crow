/* Ramble -- the week view. Plain classic script (no modules, no bundler); it is
 * loaded AFTER moves.js and today.js and draws into the #rb-week-view host.
 *
 * NO TEMPLATE LITERALS anywhere in this file: panel client scripts are handled
 * by tooling that treats backticks as its own delimiter, so string
 * concatenation is the house style here too.
 *
 * What it draws is what GET /api/ramble/moves/week answers: this week's title
 * and balance, the body outline whose five areas fill by lightness and pattern
 * alone (hips and legs, the waist block, shoulders chest and arms, the heart on
 * the chest, and the ring around the figure for mobility), the five areas as a
 * list with their progress and two pips each, the seven-day strip and the plan
 * for the days still ahead. A full week says so, and a stage offer asks its one
 * question and answers it back to the server.
 *
 * Every word comes from the approved copy table through the hooks moves.js
 * exposes (RambleMoves.copy / RambleMoves.whenCopy). A key the table does not
 * carry renders nothing at all: no line, no label and no button.
 *
 * Everything is textContent or setAttribute. Nothing here is animated, and the
 * outline's colours live in ramble.css: the three states are told apart by
 * lightness and pattern, never by hue.
 */
(function () {
  "use strict";

  var doc = null;
  try { doc = typeof document === "undefined" ? null : document; } catch (e) { doc = null; }
  var host = null;
  try {
    host = doc && typeof doc.getElementById === "function" ? doc.getElementById("rb-week-view") : null;
  } catch (e) { host = null; }

  /* The five areas, in the order the outline's list reads them. */
  var LIST_AREAS = ["lower", "mobility", "upper", "heart", "core"];
  /* The day's three slots, in the order a coming-up row reads them. */
  var SLOT_NAMES = ["morning", "midday", "evening"];
  /* Two days an area, five areas: the whole week. */
  var WEEK_TOTAL = 10;
  /* How long a change in the day's cards waits before the week is read again. */
  var DEBOUNCE_MS = 400;
  var SVG_NS = "http://www.w3.org/2000/svg";

  /* The approved body outline, front view. The head and its neck are the figure
   * the areas sit on, so neither of them is an area. */
  var PATH_LOWER = "M54 172 h72 v10 l-3 122 q-1 12 -13 12 h-4 q-11 0 -12 -12 l-4 -92 l-4 92 q-1 12 -12 12 h-4 q-12 0 -13 -12 l-3 -122 z";
  var PATH_CORE = "M56 124 h68 l2 44 h-72 z";
  var PATH_UPPER = "M26 92 q0 -26 28 -26 h72 q28 0 28 26 l6 84 q1 11 -9 11 q-9 0 -10 -10 l-9 -70 l-6 13 h-72 l-6 -13 l-9 70 q-1 10 -10 10 q-10 0 -9 -11 z";
  var PATH_HEART = "M90 110 c-14 -11 -21 -19 -13 -27 c5 -5 11 -2 13 3 c2 -5 8 -8 13 -3 c8 8 1 16 -13 27 z";

  /* ------------------------------------------------------------ words */

  function movesApi() {
    try {
      var api = typeof window === "undefined" ? null : window.RambleMoves;
      return api && typeof api === "object" ? api : null;
    } catch (e) { return null; }
  }

  /** One approved line with its {placeholders} filled; "" when it is absent. */
  function copy(key, values) {
    var moves = movesApi();
    if (!moves || typeof moves.copy !== "function") return "";
    var line = null;
    try { line = moves.copy(key, values || {}); } catch (e) { return ""; }
    return typeof line === "string" ? line : "";
  }

  /** The copy table, once per page; a load that fails is no table at all. */
  function whenCopy() {
    var moves = movesApi();
    if (!moves || typeof moves.whenCopy !== "function") return Promise.resolve(null);
    var ready;
    try { ready = moves.whenCopy(); } catch (e) { return Promise.resolve(null); }
    return Promise.resolve(ready).catch(function () { return null; });
  }

  /* -------------------------------------------------------------- DOM bits */

  function node(tag) { return doc.createElement(tag); }

  function svgNode(tag) {
    if (!doc || typeof doc.createElementNS !== "function") return null;
    var out = null;
    try { out = doc.createElementNS(SVG_NS, tag); } catch (e) { return null; }
    return out || null;
  }

  function attr(target, name, value) {
    if (!target || typeof target.setAttribute !== "function") return;
    try { target.setAttribute(name, value === undefined ? "" : String(value)); } catch (e) { /* nothing to set */ }
  }

  function clear(target) {
    if (!target) return;
    while (target.firstChild) target.removeChild(target.firstChild);
  }

  function addLine(parent, text, cls) {
    if (!parent || text === "") return null;
    var line = node("p");
    line.className = cls;
    line.textContent = text;
    parent.appendChild(line);
    return line;
  }

  function span(parent, cls, text) {
    var item = node("span");
    item.className = cls;
    if (text !== undefined) item.textContent = text;
    parent.appendChild(item);
    return item;
  }

  /* ------------------------------------------------------------- the days */

  /** One moment as a local "YYYY-MM-DD" day. */
  function dayKey(date) {
    var month = date.getMonth() + 1;
    var day = date.getDate();
    return String(date.getFullYear()) +
      "-" + (month < 10 ? "0" : "") + month +
      "-" + (day < 10 ? "0" : "") + day;
  }

  /** The reader's own today, the cell the strip marks as this date. */
  function todayKey() {
    try { return dayKey(new Date()); } catch (e) { return ""; }
  }

  /** A "YYYY-MM-DD" day as local noon, or null when it is not a day. */
  function dayDate(day) {
    var text = typeof day === "string" ? day : "";
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
    if (!m) return null;
    var date = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0, 0);
    return isNaN(date.getTime()) ? null : date;
  }

  var shortDayFormat = null;
  var shortDayTried = false;

  /** A short weekday: a date format, not a word of the copy table. */
  function weekdayShort(day) {
    var date = dayDate(day);
    if (!date) return "";
    if (!shortDayTried) {
      shortDayTried = true;
      try {
        var api = typeof Intl === "object" && Intl ? Intl : null;
        if (api && typeof api.DateTimeFormat === "function") {
          shortDayFormat = new api.DateTimeFormat(undefined, { weekday: "short" });
        }
      } catch (e) { shortDayFormat = null; }
    }
    if (!shortDayFormat) return "";
    var out = null;
    try { out = shortDayFormat.format(date); } catch (e) { return ""; }
    return typeof out === "string" ? out : "";
  }

  /* ------------------------------------------------------- the five areas */

  /** How many of an area's two days this week has marked. */
  function areaDays(payload, area) {
    var marks = payload && payload.marks && typeof payload.marks === "object" ? payload.marks : null;
    var days = marks && Array.isArray(marks[area]) ? marks[area] : [];
    return Math.min(2, Math.max(0, days.length));
  }

  /** The one class a shape's state is drawn from: none, one day, two days. */
  function stateClass(days) { return "rb-wk-a" + days; }

  /* ------------------------------------------------------- the body outline */

  /** The diagonal stripes the one-day state is filled with. */
  function stripePattern() {
    var defs = svgNode("defs");
    var pattern = svgNode("pattern");
    if (!defs || !pattern) return null;
    attr(pattern, "id", "rb-wk-stripes");
    attr(pattern, "width", 7);
    attr(pattern, "height", 7);
    attr(pattern, "patternUnits", "userSpaceOnUse");
    attr(pattern, "patternTransform", "rotate(45)");

    var ground = svgNode("rect");
    if (ground) {
      attr(ground, "width", 7);
      attr(ground, "height", 7);
      attr(ground, "class", "rb-wk-stripe-bg");
      pattern.appendChild(ground);
    }
    var stripe = svgNode("rect");
    if (stripe) {
      attr(stripe, "width", 3);
      attr(stripe, "height", 7);
      attr(stripe, "class", "rb-wk-stripe-ink");
      pattern.appendChild(stripe);
    }
    defs.appendChild(pattern);
    return defs;
  }

  /** One area of the figure, its state in its class list. */
  function areaShape(tag, path, area, days, extra) {
    var shape = svgNode(tag);
    if (!shape) return null;
    attr(shape, "d", path);
    attr(shape, "data-area", area);
    attr(shape, "class", "rb-wk-shape rb-wk-line " + stateClass(days) + (extra ? " " + extra : ""));
    return shape;
  }

  /** Mobility is the ring around the figure: dotted, dashed, then solid. */
  function mobilityRing(days) {
    var ring = svgNode("ellipse");
    if (!ring) return null;
    attr(ring, "cx", 90);
    attr(ring, "cy", 170);
    attr(ring, "rx", 84);
    attr(ring, "ry", 164);
    attr(ring, "data-area", "mobility");
    attr(ring, "class", "rb-wk-ring " + stateClass(days));
    return ring;
  }

  /** The outline's accessible name: every area, then how far it has come. */
  function outlineLabel(payload) {
    var parts = [];
    LIST_AREAS.forEach(function (area) {
      var label = copy("week.area." + area);
      var progress = copy("week.area.progress", { done: areaDays(payload, area) });
      if (label === "" && progress === "") return;
      if (label === "") parts.push(progress);
      else if (progress === "") parts.push(label);
      else parts.push(label + " " + progress);
    });
    return parts.join(", ");
  }

  function outline(payload) {
    var svg = svgNode("svg");
    if (!svg) return null;
    attr(svg, "class", "rb-wk-outline");
    attr(svg, "viewBox", "0 0 180 340");
    attr(svg, "role", "img");
    attr(svg, "focusable", "false");
    var label = outlineLabel(payload);
    if (label !== "") attr(svg, "aria-label", label);

    var defs = stripePattern();
    if (defs) svg.appendChild(defs);

    /* The ring sits behind the figure: reach around the whole body. */
    var ring = mobilityRing(areaDays(payload, "mobility"));
    if (ring) svg.appendChild(ring);

    var head = svgNode("circle");
    if (head) {
      attr(head, "cx", 90);
      attr(head, "cy", 36);
      attr(head, "r", 21);
      attr(head, "class", "rb-wk-plain");
      svg.appendChild(head);
    }
    var neck = svgNode("rect");
    if (neck) {
      attr(neck, "x", 82);
      attr(neck, "y", 55);
      attr(neck, "width", 16);
      attr(neck, "height", 12);
      attr(neck, "class", "rb-wk-plain");
      svg.appendChild(neck);
    }

    var shapes = [
      areaShape("path", PATH_LOWER, "lower", areaDays(payload, "lower"), ""),
      areaShape("path", PATH_CORE, "core", areaDays(payload, "core"), ""),
      areaShape("path", PATH_UPPER, "upper", areaDays(payload, "upper"), ""),
      areaShape("path", PATH_HEART, "heart", areaDays(payload, "heart"), "rb-wk-heart")
    ];
    shapes.forEach(function (shape) {
      if (shape) svg.appendChild(shape);
    });
    return svg;
  }

  /* --------------------------------------------------------- the area list */

  /** One row: the area's name, its progress and two pips. */
  function areaRow(payload, area) {
    var days = areaDays(payload, area);
    var label = copy("week.area." + area);
    var progress = copy("week.area.progress", { done: days });

    var row = node("li");
    row.className = "rb-wk-row";
    attr(row, "data-area", area);

    var drew = 0;
    if (label !== "") { span(row, "rb-wk-name", label); drew += 1; }
    if (progress !== "") { span(row, "rb-wk-prog", progress); drew += 1; }
    /* The pips repeat the progress line as marks, so a reader who cannot count
     * them loses nothing: they are never the only way the fact is told. */
    var pips = node("span");
    pips.className = "rb-wk-pips";
    attr(pips, "aria-hidden", "true");
    for (var i = 0; i < 2; i += 1) {
      span(pips, i < days ? "rb-wk-pip rb-wk-pip-on" : "rb-wk-pip", "");
    }
    row.appendChild(pips);
    return drew > 0 ? row : null;
  }

  /* ------------------------------------------------------------- the strip */

  /** One day of the week: its short weekday, its minutes and its marks. */
  function stripCell(entry, today) {
    var cell = node("div");
    cell.className = "rb-wk-day";
    var day = entry && typeof entry.day === "string" ? entry.day : "";
    if (day !== "") attr(cell, "data-day", day);
    /* The day the week is being read from, marked the way a date is marked. */
    if (day !== "" && today !== "" && day === today) attr(cell, "aria-current", "date");

    var name = weekdayShort(day);
    if (name !== "") span(cell, "rb-wk-dayname", name);

    var minutes = Number(entry && entry.minutes);
    if (isFinite(minutes) && minutes > 0) {
      var line = copy("week.dayMinutes", { minutes: Math.floor(minutes) });
      if (line !== "") span(cell, "rb-wk-daymin", line);
    }

    var areas = entry && Array.isArray(entry.areas) ? entry.areas : [];
    var marks = node("span");
    marks.className = "rb-wk-marks";
    areas.forEach(function (area) {
      if (typeof area !== "string" || area === "") return;
      var label = copy("week.area." + area);
      if (label === "") return;
      var mark = span(marks, "rb-wk-mark", "");
      attr(mark, "title", label);
    });
    if (marks.children.length > 0) cell.appendChild(marks);
    return cell;
  }

  /* --------------------------------------------------------- the week ahead */

  /** The plan for the days after today; nothing at all when there are none. */
  function comingUpBlock(payload) {
    var entries = payload && Array.isArray(payload.comingUp) ? payload.comingUp : [];
    if (entries.length === 0) return null;

    var block = node("div");
    block.className = "rb-wk-up";
    var drew = 0;
    if (addLine(block, copy("week.comingUp"), "rb-wk-up-title")) drew += 1;

    entries.forEach(function (entry) {
      var row = node("div");
      row.className = "rb-wk-up-row";
      var name = weekdayShort(entry && entry.day);
      if (name !== "") {
        span(row, "rb-wk-up-day", name);
        drew += 1;
      }
      var slots = entry && entry.slots && typeof entry.slots === "object" ? entry.slots : {};
      SLOT_NAMES.forEach(function (slot) {
        var area = slots[slot];
        /* A window with nothing planned names no area, and gets no words. */
        if (typeof area !== "string" || area === "" || area === "free") return;
        var label = copy("week.area." + area);
        if (label === "") return;
        span(row, "rb-wk-up-area", label);
        drew += 1;
      });
      if (row.children.length > 0) block.appendChild(row);
    });
    return drew > 0 ? block : null;
  }

  /* --------------------------------------------------------- the stage offer */

  function postJson(url, body) {
    if (typeof fetch !== "function") return Promise.resolve(null);
    var out = null;
    try {
      out = fetch(url, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
    } catch (e) { return Promise.resolve(null); }
    return Promise.resolve(out).then(function (res) {
      if (!res || res.ok === false) return null;
      return res;
    }).catch(function () { return null; });
  }

  /** The answer goes to the server and the week is read again either way. */
  function answerStage(offer, answer, btn) {
    if (!offer || typeof offer.routineId !== "string" || offer.routineId === "") return;
    if (btn) btn.disabled = true;
    var settle = function () { refresh(); };
    postJson("/api/ramble/moves/stage", { routineId: offer.routineId, answer: answer })
      .then(settle, settle);
  }

  function stageButton(cls, key, answer, offer) {
    var label = copy(key);
    if (label === "") return null;
    var btn = node("button");
    btn.type = "button";
    btn.className = cls;
    btn.textContent = label;
    btn.addEventListener("click", function () { answerStage(offer, answer, btn); });
    return btn;
  }

  /** The offer's routine, its one question and the two answers. */
  function stageBlock(offer) {
    if (!offer || typeof offer !== "object") return null;
    var routineId = typeof offer.routineId === "string" ? offer.routineId : "";

    var block = node("div");
    block.className = "rb-wk-offer";
    var drew = 0;
    if (typeof offer.title === "string" && offer.title !== "") {
      addLine(block, offer.title, "rb-wk-offer-title");
      drew += 1;
    }
    if (addLine(block, copy("week.stage.ask"), "rb-wk-offer-ask")) drew += 1;

    /* A button that cannot name the routine it answers has nothing to send. */
    if (routineId !== "") {
      var row = node("div");
      row.className = "rb-row rb-actions rb-wk-offer-btns";
      var yesBtn = stageButton("rb-btn", "week.stage.yes", "yes", offer);
      if (yesBtn) { row.appendChild(yesBtn); drew += 1; }
      var noBtn = stageButton("rb-btn rb-btn-ghost", "week.stage.no", "no", offer);
      if (noBtn) { row.appendChild(noBtn); drew += 1; }
      if (row.children.length > 0) block.appendChild(row);
    }
    return drew > 0 ? block : null;
  }

  /* ------------------------------------------------------------------ paint */

  function paint(payload) {
    if (!host || !payload || typeof payload !== "object") return;
    clear(host);

    var title = copy("week.title");
    if (title !== "") {
      var heading = node("h3");
      heading.className = "rb-h rb-wk-title";
      heading.textContent = title;
      host.appendChild(heading);
    }

    /* The balance as digits only: 6 / 10. No word of this line is anyone's. */
    var total = Number(payload.total);
    if (isFinite(total)) {
      addLine(host, String(Math.max(0, Math.floor(total))) + " / " + WEEK_TOTAL, "rb-wk-total");
    }

    var figure = outline(payload);
    if (figure) host.appendChild(figure);

    var list = node("ul");
    list.className = "rb-wk-list";
    LIST_AREAS.forEach(function (area) {
      var row = areaRow(payload, area);
      if (row) list.appendChild(row);
    });
    if (list.children.length > 0) host.appendChild(list);

    var strip = payload && Array.isArray(payload.strip) ? payload.strip : [];
    if (strip.length > 0) {
      var band = node("div");
      band.className = "rb-wk-strip";
      var today = todayKey();
      strip.forEach(function (entry) {
        if (!entry || typeof entry !== "object") return;
        band.appendChild(stripCell(entry, today));
      });
      host.appendChild(band);
    }

    var coming = comingUpBlock(payload);
    if (coming) host.appendChild(coming);

    if (payload.full === true) addLine(host, copy("week.whole"), "rb-wk-whole");

    var offer = stageBlock(payload.stageOffer);
    if (offer) host.appendChild(offer);
  }

  /* ---------------------------------------------------------------- refresh */

  /* Only the newest read may paint: an answer that arrives after a later one
   * asked is a week the reader has already moved past. */
  var refreshToken = 0;

  function refresh() {
    if (!host || typeof fetch !== "function") return Promise.resolve(null);
    refreshToken += 1;
    var token = refreshToken;
    return whenCopy().then(function () {
      return fetch("/api/ramble/moves/week", {
        credentials: "same-origin",
        headers: { Accept: "application/json" }
      });
    }).then(function (res) {
      if (!res || token !== refreshToken) return null;
      return Promise.resolve(res.json ? res.json() : null).catch(function () { return null; })
        .then(function (payload) {
          if (token !== refreshToken) return null;
          if (!res.ok || !payload || typeof payload !== "object") return null;
          paint(payload);
          return payload;
        });
    }).catch(function () {
      /* A week that could not be read leaves what the reader has alone. */
      return null;
    });
  }

  /* --------------------------------------------------------------- watchers */

  /* A page that comes back to the front may have been away long enough for the
   * day to have turned over, so the week is read again on the way back. */
  function watchFocus() {
    var win = null;
    try { win = typeof window === "undefined" ? null : window; } catch (e) { win = null; }
    if (win && typeof win.addEventListener === "function") {
      win.addEventListener("focus", function () { refresh(); });
    }
    if (!doc || typeof doc.addEventListener !== "function") return;
    doc.addEventListener("visibilitychange", function () {
      var state = "visible";
      try { state = doc.visibilityState; } catch (e) { state = "visible"; }
      if (state === "visible") refresh();
    });
  }

  /* The day's own cards redraw themselves; a card that was finished or swapped
   * moves the week's balance, so a burst of those changes reads the week once,
   * shortly after it settles. */
  function watchToday() {
    var todayHost = null;
    try {
      todayHost = doc && typeof doc.getElementById === "function" ? doc.getElementById("rb-today-view") : null;
    } catch (e) { todayHost = null; }
    if (!todayHost) return;

    var Observer = null;
    try { Observer = typeof MutationObserver === "function" ? MutationObserver : null; }
    catch (e) { Observer = null; }
    if (!Observer) return;

    var wait = typeof setTimeout === "function" ? setTimeout : null;
    var cancel = typeof clearTimeout === "function" ? clearTimeout : null;
    var timer = null;

    var observer = new Observer(function () {
      if (!wait) { refresh(); return; }
      if (timer !== null && cancel) cancel(timer);
      timer = wait(function () {
        timer = null;
        refresh();
      }, DEBOUNCE_MS);
    });
    try { observer.observe(todayHost, { childList: true }); } catch (e) { /* nothing to watch */ }
  }

  try { window.RambleWeek = { refresh: refresh, paint: paint }; }
  catch (e) { /* no window: nothing to expose */ }

  if (!host) return;
  watchFocus();
  watchToday();
  refresh();
})();
