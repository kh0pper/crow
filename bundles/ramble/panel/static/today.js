/* Ramble -- Today's cards. Plain classic script (no modules, no bundler); it is
 * loaded AFTER moves.js and draws into the #rb-today-view host.
 *
 * NO TEMPLATE LITERALS anywhere in this file: panel client scripts are handled
 * by tooling that treats backticks as its own delimiter, so string
 * concatenation is the house style here too.
 *
 * What it draws is what GET /api/ramble/moves/day answers: the streak line,
 * one card per slot (the day's Now card expanded, the rest collapsed), and,
 * inside a card, Start -- plus Done on a walk -- and Swap. The day's own
 * elements (the steps meter, the status line) are written here with
 * textContent, because the server-rendered page keeps them and only the card
 * markup moved out.
 *
 * Every word comes from the approved copy table through the hooks moves.js
 * exposes (RambleMoves.copy / RambleMoves.whenCopy). A key the table does not
 * carry renders nothing at all: no line, no button, and no fallback text.
 *
 * Server strings (an entry's title, the day's why line) are written with
 * textContent, never as markup.
 */
(function () {
  "use strict";

  var doc = null;
  try { doc = typeof document === "undefined" ? null : document; } catch (e) { doc = null; }
  var host = null;
  try {
    host = doc && typeof doc.getElementById === "function" ? doc.getElementById("rb-today-view") : null;
  } catch (e) { host = null; }

  /* The day on screen, as the server answered it last. */
  var day = null;
  /* The card element of each slot, and whether it is open: a swap replaces one
   * card's element only, so the rest of the day keeps its own. */
  var cardBySlot = {};
  var expandedBy = {};

  /* The last line the moves client said (a running walk's time, a refused
   * start, the result), the entry that line belongs to, and the walk cards'
   * own elements that carry it. A line names one entry, so a day with more than
   * one walk says it under that card and nowhere else. */
  var statusText = "";
  var statusEntry = null;
  var statusEls = [];

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

  /** One of the moves client's own lines (its runtime strings), or "". */
  function textLine(key) {
    var moves = movesApi();
    if (!moves || typeof moves.text !== "function") return "";
    var line = null;
    try { line = moves.text(key); } catch (e) { return ""; }
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

  function el(id) {
    try { return doc && typeof doc.getElementById === "function" ? doc.getElementById(id) : null; }
    catch (e) { return null; }
  }

  function node(tag) { return doc.createElement(tag); }

  function setText(target, text) {
    if (target) target.textContent = text;
  }

  function setHidden(target, on) {
    if (!target) return;
    if (on) target.setAttribute("hidden", "");
    else target.removeAttribute("hidden");
  }

  function clear(target) {
    if (!target) return;
    while (target.firstChild) target.removeChild(target.firstChild);
  }

  function thousands(n) {
    var v = Math.floor(Number(n));
    if (!isFinite(v) || v < 0) v = 0;
    return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  }

  function addLine(parent, text, cls) {
    if (text === "") return null;
    var line = node("p");
    line.className = cls;
    line.textContent = text;
    parent.appendChild(line);
    return line;
  }

  function actionButton(cls, label, onPress) {
    var btn = node("button");
    btn.type = "button";
    btn.className = cls;
    btn.textContent = label;
    btn.addEventListener("click", function () { onPress(btn); });
    return btn;
  }

  /* ---------------------------------------------- a walk's own line */

  /* A walk's status lives under the card's own buttons, so a phone sees the
   * running time (or a refused start) without scrolling past every card to the
   * day's one line. Only the card whose entry the line belongs to says it; a
   * line with no entry says nothing anywhere. It says nothing while there is
   * nothing to say. */
  function paintStatus(target) {
    if (!target) return;
    var entryId = target.getAttribute("data-entry");
    var mine = statusText !== "" && typeof entryId === "string" && entryId !== "" &&
      entryId === statusEntry;
    setText(target, mine ? statusText : "");
    setHidden(target, !mine);
  }

  function paintStatuses() {
    for (var i = 0; i < statusEls.length; i += 1) paintStatus(statusEls[i]);
  }

  /** The moves client's status changed: keep it and show it on its own card. */
  function rememberStatus(text, entryId) {
    statusText = typeof text === "string" ? text : "";
    statusEntry = statusText !== "" && typeof entryId === "string" && entryId !== ""
      ? entryId
      : null;
    paintStatuses();
  }

  /* The cards carry no walk line of their own from here on; the day's own line
   * keeps whatever was said for as long as it says it. */
  function forgetStatus() {
    statusText = "";
    statusEntry = null;
  }

  /* --------------------------------------------------------- the day's meter */

  /* The steps meter stays in the page markup; this only fills it in. */
  function paintMeter(payload) {
    var steps = payload && payload.steps ? payload.steps : null;
    if (!steps) return;
    var goal = Number(steps.goal) > 0 ? Number(steps.goal) : 6000;
    var count = Math.max(0, Number(steps.steps) || 0);
    setText(el("rb-goal-num"), thousands(count));
    setText(el("rb-goal-max"), thousands(goal));
    var fill = el("rb-goal-fill");
    if (fill && fill.style) fill.style.width = Math.min(100, Math.round(count * 100 / goal)) + "%";
  }

  /* --------------------------------------------------------------- the streak */

  function streakBlock(payload) {
    var streak = payload && payload.streak ? payload.streak : null;
    if (!streak) return null;
    var need = Math.max(0, Number(streak.need) || 0);
    var done = Math.max(0, Number(streak.doneToday) || 0);
    var days = Math.max(0, Number(streak.days) || 0);

    var block = node("div");
    block.className = "rb-streak";
    var drew = 0;
    if (need > 0 && done >= need) {
      if (addLine(block, copy("today.streak.allDone"), "rb-streak-line")) drew += 1;
    } else {
      var line = copy("today.streak.line", { done: done, total: need });
      if (addLine(block, line, "rb-streak-line")) drew += 1;
    }
    if (days > 0) {
      if (addLine(block, copy("today.streak.days", { n: days }), "rb-muted rb-fine rb-streak-days")) drew += 1;
    }
    return drew > 0 ? block : null;
  }

  /* ---------------------------------------------------------------- the hooks */

  function startItem(item, payload) {
    var moves = movesApi();
    if (!moves || typeof moves.startSlot !== "function") return;
    var out = null;
    try { out = moves.startSlot(item, payload ? payload.day : null); } catch (e) { return; }
    /* Only a walk answers with a promise: its clock starts, so the card is
     * worth asking the day about again once that settles. */
    if (!item || !item.entry || item.entry.kind !== "walk") return;
    if (!out || typeof out.then !== "function") return;
    out.then(function () { refresh(); }, function () { refresh(); });
  }

  function finishItem() {
    var moves = movesApi();
    if (!moves || typeof moves.finishWalk !== "function") return;
    var out = null;
    try { out = moves.finishWalk(); } catch (e) { return; }
    if (!out || typeof out.then !== "function") return;
    out.then(function () {
      /* The result line has had its repaint under the card it was said for.
       * From the next one on the cards carry no walk line at all: the day's own
       * line goes on saying it. */
      var painted = refresh();
      if (painted && typeof painted.then === "function") painted.then(forgetStatus);
      else forgetStatus();
    }, function () {
      /* A finish that did not land leaves the walk running, and its line with
       * it: only a repaint is asked for. */
      refresh();
    });
  }

  function outdoorRunning() {
    var moves = movesApi();
    if (!moves || typeof moves.outdoorRunning !== "function") return false;
    try { return Boolean(moves.outdoorRunning()); } catch (e) { return false; }
  }

  /* --------------------------------------------------------------- the swap */

  function slotItem(payload, name) {
    var slots = payload && Array.isArray(payload.slots) ? payload.slots : [];
    for (var i = 0; i < slots.length; i += 1) {
      if (slots[i] && slots[i].slot === name) return slots[i];
    }
    return null;
  }

  function postSwap(name) {
    if (typeof fetch !== "function") return Promise.reject(new Error("no fetch"));
    return fetch("/api/ramble/moves/slot/swap", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slot: name })
    }).then(function (res) {
      return Promise.resolve(res.json ? res.json() : null).catch(function () { return null; })
        .then(function (body) {
          if (!res.ok) throw new Error("swap failed: " + res.status);
          return body;
        });
    });
  }

  function swapSlot(name, btn) {
    if (!name) return;
    if (btn) btn.disabled = true;
    postSwap(name).then(function (payload) {
      if (!payload || !Array.isArray(payload.slots)) {
        if (btn) btn.disabled = false;
        return;
      }
      /* The answer is the whole day: it becomes the one on screen, but only
       * the card that was swapped is drawn again. */
      day = payload;
      var item = slotItem(day, name);
      var current = cardBySlot[name];
      var open = expandedBy[name] === true;
      if (!item || !current || !current.parentNode) {
        if (btn) btn.disabled = false;
        return;
      }
      var next = cardNode(item, payload, open);
      current.parentNode.replaceChild(next, current);
      cardBySlot[name] = next;
    }).catch(function () {
      if (btn) btn.disabled = false;
    });
  }

  /* ---------------------------------------------------------------- one card */

  function entryTitle(item) {
    var entry = item && item.entry ? item.entry : null;
    if (!entry) return "";
    return typeof entry.title === "string" ? entry.title : "";
  }

  function cardBody(item, payload) {
    var body = node("div");
    body.className = "rb-slot-body";
    if (!item) return body;

    if (item.empty === true) {
      addLine(body, copy("today.card.emptySlot"), "rb-muted rb-fine rb-slot-empty");
      return body;
    }
    if (item.done === true || item.standIn === true) {
      addLine(body, copy("today.card.isDone"), "rb-slot-done");
      return body;
    }
    if (!item.entry) return body;

    var title = entryTitle(item);
    addLine(body, title, "rb-slot-title");
    var minutes = item.entry.minutes;
    addLine(body, copy("today.card.length", { minutes: minutes }), "rb-muted rb-fine rb-slot-length");
    if (typeof item.why === "string" && item.why !== "") {
      addLine(body, item.why, "rb-muted rb-fine rb-slot-why");
    }

    var row = node("div");
    row.className = "rb-row rb-actions";
    var drew = 0;
    var statusLine = null;

    var startLabel = copy("today.card.start");
    if (startLabel !== "") {
      var startBtn = actionButton("rb-btn", startLabel, function () { startItem(item, payload); });
      /* A walk already running cannot be started twice: the card's Start says
       * so by being unpressed, and re-enables once the walk is finished. */
      if (item.entry.kind === "walk") startBtn.disabled = outdoorRunning();
      row.appendChild(startBtn);
      drew += 1;
    }
    if (item.entry.kind === "walk") {
      var doneLabel = copy("today.card.done");
      if (doneLabel !== "") {
        var doneBtn = actionButton("rb-btn rb-btn-ghost", doneLabel, finishItem);
        doneBtn.disabled = !outdoorRunning();
        row.appendChild(doneBtn);
        drew += 1;
      }
      statusLine = node("p");
      statusLine.className = "rb-muted rb-fine rb-slot-status";
      /* The entry this card speaks for: a walk's line is drawn on the card it
       * was pressed on, and on no other. */
      statusLine.setAttribute("data-entry", typeof item.entry.id === "string" ? item.entry.id : "");
      statusLine.setAttribute("role", "status");
      statusLine.setAttribute("aria-live", "polite");
      paintStatus(statusLine);
      statusEls.push(statusLine);
    }
    var swapLabel = copy("today.card.swap");
    if (swapLabel !== "") {
      var swapBtn = actionButton("rb-btn rb-btn-ghost", swapLabel, function (btn) {
        swapSlot(typeof item.slot === "string" ? item.slot : "", btn);
      });
      /* The day allows three; a fourth press would be refused, so the button
       * says the same word and stops offering it. */
      swapBtn.disabled = Number(item.swap) >= 3;
      row.appendChild(swapBtn);
      drew += 1;
    }
    if (drew > 0) body.appendChild(row);
    if (statusLine) body.appendChild(statusLine);
    return body;
  }

  function cardNode(item, payload, expanded) {
    var name = item && typeof item.slot === "string" ? item.slot : "";
    var wrap = node("section");
    wrap.className = "rb-card rb-slot-card";
    wrap.setAttribute("data-slot", name);
    if (item && item.standIn === true) wrap.setAttribute("data-stand-in", "true");

    var head = node("button");
    head.type = "button";
    head.className = "rb-slot-head";
    head.setAttribute("aria-expanded", expanded ? "true" : "false");

    var label = copy("settings.slot." + name);
    if (label !== "") {
      var labelEl = node("strong");
      labelEl.className = "rb-slot-label";
      labelEl.textContent = label;
      head.appendChild(labelEl);
    }
    if (name !== "" && payload && name === payload.nowSlot) {
      var nowLabel = copy("today.card.now");
      if (nowLabel !== "") {
        var badge = node("span");
        badge.className = "rb-slot-now";
        badge.textContent = nowLabel;
        head.appendChild(badge);
      }
    }
    /* The title stands in for the body while the card is shut. */
    var headTitle = node("span");
    headTitle.className = "rb-slot-headtitle";
    headTitle.textContent = entryTitle(item);
    setHidden(headTitle, expanded);
    head.appendChild(headTitle);

    var body = cardBody(item, payload);
    setHidden(body, !expanded);

    head.addEventListener("click", function () {
      var open = expandedBy[name] !== true;
      expandedBy[name] = open;
      setHidden(body, !open);
      setHidden(headTitle, open);
      head.setAttribute("aria-expanded", open ? "true" : "false");
    });

    wrap.appendChild(head);
    wrap.appendChild(body);
    return wrap;
  }

  /* ------------------------------------------------------------- words in place */

  /* The two buttons beside the cards are server-rendered with their own labels;
   * once the table is here they say the approved line. A key the table does not
   * carry leaves the server's label exactly as it is. */
  function paintLabels() {
    var settingsLine = copy("today.settings");
    var customizeButton = el("rb-customize");
    if (customizeButton && settingsLine !== "") customizeButton.textContent = settingsLine;

    var elseLine = copy("today.somethingElse");
    var elseButton = el("rb-something-else");
    if (elseButton && elseLine !== "") elseButton.textContent = elseLine;
  }

  /* --------------------------------------------------------------- first run */

  /* The three questions' own vocabulary: the values are what /moves/setup stores,
   * the words are the table's. The wall is the one thing a plain room already
   * has, so it is the one box that starts ticked. */
  var FIRST_RUN_EQUIPMENT = ["mat", "band", "chair", "wall"];
  var FIRST_RUN_WALL = ["wall"];
  var FIRST_RUN_LIMITS = [
    "knee", "lower_back", "neck", "shoulder", "wrist",
    "hip", "ankle", "balance", "pregnancy", "high_blood_pressure"
  ];
  var FIRST_RUN_LEVELS = [1, 2, 3];
  var FIRST_RUN_STEPS = 3;
  var FIRST_RUN_FIELD = { 1: "equipment", 2: "limits", 3: "level" };

  /* Asked once per page: a payload that still says needed (a second device, a
   * refresh before the answer replicated) never reopens it. A refused answer is
   * asked again once, since it may have been the connection; a second refusal
   * leaves the sheet shut for the rest of the page load -- the server still says
   * needed, so the next page load asks again rather than every refresh here. */
  var firstRunShown = false;
  var firstRunAnswers = {};
  var firstRunFailures = 0;
  var FIRST_RUN_FAILURES_ALLOWED = 2;

  /** One labelled checkbox; a value the table has no line for is left out. */
  function checkLine(value, labelText, ticked) {
    var wrap = node("label");
    wrap.className = "rb-check";
    var box = node("input");
    box.type = "checkbox";
    box.value = value;
    box.checked = ticked === true;
    wrap.appendChild(box);
    var text = node("span");
    text.textContent = labelText;
    wrap.appendChild(text);
    return { wrap: wrap, input: box };
  }

  /** One labelled radio button. */
  function radioLine(name, value, labelText, ticked) {
    var wrap = node("label");
    wrap.className = "rb-check";
    var input = node("input");
    input.type = "radio";
    input.name = name;
    input.value = String(value);
    input.checked = ticked === true;
    wrap.appendChild(input);
    var text = node("span");
    text.textContent = labelText;
    wrap.appendChild(text);
    return { wrap: wrap, input: input };
  }

  /* A radio group keeps one choice; a browser does that by itself, and this
   * does the same for a page without one. */
  function exclusive(rows) {
    var inputs = rows.map(function (row) { return row.input; });
    inputs.forEach(function (input) {
      input.addEventListener("change", function () {
        if (!input.checked) return;
        inputs.forEach(function (other) {
          if (other !== input) other.checked = false;
        });
      });
    });
  }

  /* The sheet names its title element by id, so every screen carries one. */
  function screenTitle(text) {
    var title = node("h3");
    title.className = "rb-h";
    title.id = "rb-first-run-title";
    title.textContent = text;
    return title;
  }

  function choiceGroup(rows) {
    var group = node("div");
    group.className = "rb-checks rb-first-run-opts";
    rows.forEach(function (row) { group.appendChild(row.wrap); });
    return group;
  }

  /* Skip drops that screen's answer and moves on; Next keeps it. On the last
   * screen both finish, which is what leaves a skipped level out. */
  function firstRunGo(step) {
    if (step >= FIRST_RUN_STEPS) finishFirstRun();
    else paintFirstRun(step + 1);
  }

  function firstRunKeep(step, read) {
    var value = null;
    try { value = read(); } catch (e) { value = null; }
    firstRunAnswers[FIRST_RUN_FIELD[step]] = value;
    firstRunGo(step);
  }

  function firstRunLeave(step) {
    delete firstRunAnswers[FIRST_RUN_FIELD[step]];
    firstRunGo(step);
  }

  function firstRunButtons(step, read) {
    var row = node("div");
    row.className = "rb-row rb-actions rb-first-run-btns";
    var skipLabel = copy("firstRun.skip");
    if (skipLabel !== "") {
      row.appendChild(actionButton("rb-btn rb-btn-ghost", skipLabel, function () {
        firstRunLeave(step);
      }));
    }
    var nextLabel = copy(step >= FIRST_RUN_STEPS ? "firstRun.done" : "firstRun.next");
    if (nextLabel !== "") {
      row.appendChild(actionButton("rb-btn", nextLabel, function () {
        firstRunKeep(step, read);
      }));
    }
    return row;
  }

  function paintEquipmentScreen(body) {
    var title = copy("firstRun.equipment.title");
    if (title !== "") body.appendChild(screenTitle(title));
    addLine(body, copy("firstRun.equipment.hint"), "rb-muted rb-fine rb-first-run-hint");
    var rows = [];
    FIRST_RUN_EQUIPMENT.forEach(function (tag) {
      var label = copy("firstRun.equipment." + tag);
      if (label === "") return;
      rows.push(checkLine(tag, label, FIRST_RUN_WALL.indexOf(tag) !== -1));
    });
    body.appendChild(choiceGroup(rows));
    body.appendChild(firstRunButtons(1, function () {
      /* "none" first: it is what marks the entries that need nothing. */
      var picked = ["none"];
      rows.forEach(function (row) {
        if (row.input.checked) picked.push(row.input.value);
      });
      return picked;
    }));
  }

  function paintLimitsScreen(body) {
    var title = copy("firstRun.limits.title");
    if (title !== "") body.appendChild(screenTitle(title));
    addLine(body, copy("firstRun.limits.hint"), "rb-muted rb-fine rb-first-run-hint");
    var rows = [];
    FIRST_RUN_LIMITS.forEach(function (tag) {
      var label = copy("firstRun.limit." + tag);
      if (label === "") return;
      rows.push(checkLine(tag, label, false));
    });
    body.appendChild(choiceGroup(rows));
    body.appendChild(firstRunButtons(2, function () {
      var picked = [];
      rows.forEach(function (row) {
        if (row.input.checked) picked.push(row.input.value);
      });
      return picked;
    }));
  }

  function paintLevelScreen(body) {
    var title = copy("firstRun.level.title");
    if (title !== "") body.appendChild(screenTitle(title));
    var rows = [];
    FIRST_RUN_LEVELS.forEach(function (level) {
      var label = copy("firstRun.level." + level);
      if (label === "") return;
      rows.push(radioLine("rb-first-run-level", level, label, level === 2));
    });
    exclusive(rows);
    body.appendChild(choiceGroup(rows));
    body.appendChild(firstRunButtons(3, function () {
      var picked = 2;
      rows.forEach(function (row) {
        if (row.input.checked) picked = Number(row.input.value);
      });
      return picked;
    }));
  }

  function paintFirstRun(step) {
    var body = el("rb-first-run-body");
    if (!body) return;
    clear(body);
    if (step === 2) paintLimitsScreen(body);
    else if (step >= 3) paintLevelScreen(body);
    else paintEquipmentScreen(body);
  }

  /* A post that did not land answers null: a network error and a status the
   * server refused are the same thing to the caller, never an answer. */
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

  /* The answer is the whole setup, so one request covers every screen, and the
   * sheet closes either way. An answer the server never took is no answer: the
   * sheet is asked again after the first failure, and left shut after the
   * second, so a server that keeps refusing does not hold the screen. */
  function finishFirstRun() {
    var answer = firstRunAnswers;
    firstRunAnswers = {};
    var sheet = el("rb-first-run");
    var settle = function (res) {
      setHidden(sheet, true);
      if (!res) {
        firstRunFailures += 1;
        firstRunShown = firstRunFailures >= FIRST_RUN_FAILURES_ALLOWED;
      }
      refresh();
    };
    postJson("/api/ramble/moves/setup", answer).then(settle, settle);
  }

  function firstRunNeeded(payload) {
    var setup = payload && payload.setup ? payload.setup : null;
    return !!setup && typeof setup === "object" && setup.needed === true;
  }

  function maybeFirstRun(payload) {
    if (firstRunShown) return;
    if (!firstRunNeeded(payload)) return;
    /* Every screen of the sheet is drawn from the table's words, so a table
     * without them is nothing to ask: the sheet stays shut and stays unasked,
     * and a later read may try again. */
    if (copy("firstRun.next") === "" || copy("firstRun.skip") === "") return;
    var sheet = el("rb-first-run");
    var body = el("rb-first-run-body");
    if (!sheet || !body) return;
    firstRunShown = true;
    firstRunAnswers = {};
    paintFirstRun(1);
    setHidden(sheet, false);
  }

  /* -------------------------------------------------------- cards and windows */

  var SLOT_NAMES = ["morning", "midday", "evening"];
  /* The windows a count of cards means when the player has not picked any. */
  var DEFAULT_WINDOWS = {
    1: ["midday"],
    2: ["morning", "evening"],
    3: ["morning", "midday", "evening"]
  };

  var cardsOn = 3;
  var windowInputs = {};

  function cardsValue(prefs) {
    var n = Number(prefs && prefs.cards);
    return n === 1 || n === 2 || n === 3 ? n : 3;
  }

  /** The ticked windows, in slot order: an empty list is the default slots. */
  function windowsList(prefs, cards) {
    var raw = prefs && Array.isArray(prefs.windows) ? prefs.windows : [];
    var kept = [];
    SLOT_NAMES.forEach(function (slot) {
      if (raw.indexOf(slot) !== -1) kept.push(slot);
    });
    if (kept.length > 0) return kept;
    return (DEFAULT_WINDOWS[cards] || DEFAULT_WINDOWS[3]).slice();
  }

  function tickWindows(list) {
    SLOT_NAMES.forEach(function (slot) {
      var input = windowInputs[slot];
      if (input) input.checked = list.indexOf(slot) !== -1;
    });
  }

  function tickedWindows() {
    var out = [];
    SLOT_NAMES.forEach(function (slot) {
      var input = windowInputs[slot];
      if (input && input.checked) out.push(slot);
    });
    return out;
  }

  /* The count is a change for TOMORROW's plan, so its own windows are reset to
   * the defaults for that count rather than carried over. */
  function chooseCards(input) {
    var n = Number(input.value);
    if (n !== 1 && n !== 2 && n !== 3) return;
    cardsOn = n;
    tickWindows(DEFAULT_WINDOWS[n] || DEFAULT_WINDOWS[3]);
    postJson("/api/ramble/moves/prefs", { cards: n, windows: [] }).then(refresh, refresh);
  }

  /* The day holds exactly as many windows as cards, so the windows change by a
   * TICK only: when it makes one too many, the earliest other tick on the page
   * comes off (the box just ticked is the one the player asked for). An untick
   * would leave the day a window short, so the box is put straight back and
   * nothing is sent: the screen keeps saying what the server says. Only a count
   * of exactly cards is posted. */
  function chooseWindow(input) {
    if (!input || input.checked !== true) {
      if (input) input.checked = true;
      return;
    }
    var ticked = tickedWindows();
    if (ticked.length > cardsOn) {
      for (var i = 0; i < ticked.length; i += 1) {
        if (ticked[i] === input.value) continue;
        var other = windowInputs[ticked[i]];
        if (other) { other.checked = false; break; }
      }
      ticked = tickedWindows();
    }
    if (ticked.length !== cardsOn) return;
    postJson("/api/ramble/moves/prefs", { windows: ticked }).then(refresh, refresh);
  }

  function buildSlots(prefs) {
    var hostSlots = el("rb-pref-slots");
    if (!hostSlots) return;
    clear(hostSlots);
    windowInputs = {};

    var cards = cardsValue(prefs);
    cardsOn = cards;

    var block = node("div");
    block.className = "rb-pref-slots-block";

    addLine(block, copy("settings.cardsPerDay"), "rb-label rb-pref-slots-label");
    var cardRow = node("div");
    cardRow.className = "rb-row rb-actions rb-pref-cards";
    var cardRows = [];
    [1, 2, 3].forEach(function (n) {
      var input = node("input");
      input.type = "radio";
      input.name = "rb-pref-cards";
      input.value = String(n);
      input.checked = n === cards;
      var chip = node("label");
      chip.className = "rb-chip rb-pref-card-chip";
      chip.appendChild(input);
      var text = node("span");
      text.textContent = String(n);
      chip.appendChild(text);
      cardRow.appendChild(chip);
      cardRows.push({ wrap: chip, input: input });
    });
    exclusive(cardRows);
    cardRows.forEach(function (row) {
      row.input.addEventListener("change", function () { chooseCards(row.input); });
    });
    block.appendChild(cardRow);
    addLine(block, copy("settings.cardsPerDay.note"), "rb-muted rb-fine rb-pref-note");

    addLine(block, copy("settings.windows"), "rb-label rb-pref-slots-label");
    var chosen = windowsList(prefs, cards);
    var winRow = node("div");
    winRow.className = "rb-checks rb-pref-windows";
    SLOT_NAMES.forEach(function (slot) {
      var label = copy("settings.slot." + slot);
      if (label === "") return;
      var row = checkLine(slot, label, chosen.indexOf(slot) !== -1);
      windowInputs[slot] = row.input;
      row.input.addEventListener("change", function () { chooseWindow(row.input); });
      winRow.appendChild(row.wrap);
    });
    block.appendChild(winRow);

    hostSlots.appendChild(block);
  }

  function readPrefs() {
    if (typeof fetch !== "function") return Promise.resolve(null);
    var out = null;
    try {
      out = fetch("/api/ramble/moves/prefs", {
        credentials: "same-origin",
        headers: { Accept: "application/json" }
      });
    } catch (e) { return Promise.resolve(null); }
    return Promise.resolve(out).then(function (res) {
      if (!res || !res.ok) return null;
      return Promise.resolve(res.json ? res.json() : null).catch(function () { return null; });
    }).then(function (body) {
      if (!body || typeof body !== "object") return null;
      var prefs = body.prefs && typeof body.prefs === "object" ? body.prefs : body;
      return prefs && typeof prefs === "object" ? prefs : null;
    }).catch(function () { return null; });
  }

  /* The block is drawn from the table's words and skips a window it has no line
   * for, so it is built only once the table is here -- on a deep link into the
   * customize sheet that may be later than the click that opened it. */
  function loadSlots() {
    return whenCopy().then(readPrefs).then(function (prefs) {
      buildSlots(prefs || {});
      return prefs;
    });
  }

  /** Whether the customize sheet is on screen, with no hidden attribute on it. */
  function customizeSheetOpen() {
    var sheet = el("rb-customize-sheet");
    if (!sheet) return false;
    try {
      if (typeof sheet.hasAttribute === "function") return sheet.hasAttribute("hidden") !== true;
      return sheet.getAttribute("hidden") === null;
    } catch (e) { return false; }
  }

  /* moves.js opens the customize sheet and fills the rest of it; this block is
   * today.js's own, so neither file has to know the other's markup. */
  var customizeButton = el("rb-customize");
  if (customizeButton && typeof customizeButton.addEventListener === "function") {
    customizeButton.addEventListener("click", function () { loadSlots(); });
  }

  /* ------------------------------------------------------------------ paint */

  function paint(payload) {
    if (!host || !payload || typeof payload !== "object") return;
    day = payload;
    cardBySlot = {};
    /* Every element that carries the walk's line is drawn again from here. */
    statusEls = [];
    /* A repaint keeps what the reader opened and shut: a card still in the day
     * holds its own state, and a slot not seen before starts open only when it
     * is the Now card. */
    var seenBefore = expandedBy;
    clear(host);

    paintMeter(payload);
    maybeFirstRun(payload);
    /* A paused day has no cards: the two lines its own table carries say so,
     * and the steps meter above them still counts. */
    if (payload.off) {
      addLine(host, textLine("paused"), "rb-slot-title");
      addLine(host, textLine("pausedLine"), "rb-muted rb-fine");
      return;
    }

    expandedBy = {};
    var streak = streakBlock(payload);
    if (streak) host.appendChild(streak);

    var slots = Array.isArray(payload.slots) ? payload.slots : [];
    slots.forEach(function (item) {
      if (!item || typeof item !== "object") return;
      var name = typeof item.slot === "string" ? item.slot : "";
      var carried = Object.prototype.hasOwnProperty.call(seenBefore, name);
      var open = carried ? seenBefore[name] === true : (name !== "" && name === payload.nowSlot);
      expandedBy[name] = open;
      var card = cardNode(item, payload, open);
      cardBySlot[name] = card;
      host.appendChild(card);
    });
  }

  /* ---------------------------------------------------------------- refresh */

  /* Only the newest read may paint. A refresh() that was answered after a
   * later one asked is a day the reader has already moved past, so its answer
   * is dropped rather than drawn over the newer one. */
  var refreshToken = 0;

  function refresh() {
    if (!host || typeof fetch !== "function") return Promise.resolve(null);
    refreshToken += 1;
    var token = refreshToken;
    return whenCopy().then(function () {
      paintLabels();
      return fetch("/api/ramble/moves/day", {
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
      /* A day that could not be read leaves the cards the reader has alone. */
      return null;
    });
  }

  try { window.RambleToday = { refresh: refresh, paint: paint, loadSlots: loadSlots }; }
  catch (e) { /* no window: nothing to expose */ }

  /* The moves client keeps one status line for the whole day. A walk card
   * carries it under its own buttons, so register for it (and take whatever it
   * already says, since it may have spoken before this script ran). */
  var statusMoves = movesApi();
  if (statusMoves) {
    if (typeof statusMoves.status === "function") {
      var currentStatus = null;
      try { currentStatus = statusMoves.status(); } catch (e) { currentStatus = null; }
      if (typeof currentStatus === "string") statusText = currentStatus;
      var currentEntry = null;
      if (typeof statusMoves.statusEntry === "function") {
        try { currentEntry = statusMoves.statusEntry(); } catch (e) { currentEntry = null; }
      }
      if (statusText !== "" && typeof currentEntry === "string") statusEntry = currentEntry;
    }
    if (typeof statusMoves.onStatus === "function") {
      try { statusMoves.onStatus(rememberStatus); } catch (e) { /* no line, no harm */ }
    }
  }

  if (!host) return;
  /* moves.js handles ?moves=prefs at the end of its own script, and it is loaded
   * BEFORE this one, so its call to loadSlots() finds no api here yet. The sheet
   * it opened is on the page by the time this runs, so the sheet's own block is
   * filled from here instead. */
  if (customizeSheetOpen()) loadSlots();
  refresh();
})();
