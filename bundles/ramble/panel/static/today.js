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
    if (out && typeof out.then === "function") {
      out.then(function () { refresh(); }, function () { refresh(); });
    }
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

    var startLabel = copy("today.card.start");
    if (startLabel !== "") {
      row.appendChild(actionButton("rb-btn", startLabel, function () { startItem(item, payload); }));
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
    }
    var swapLabel = copy("today.card.swap");
    if (swapLabel !== "") {
      row.appendChild(actionButton("rb-btn rb-btn-ghost", swapLabel, function (btn) {
        swapSlot(typeof item.slot === "string" ? item.slot : "", btn);
      }));
      drew += 1;
    }
    if (drew > 0) body.appendChild(row);
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
   * refresh before the answer replicated) never reopens it. */
  var firstRunShown = false;
  var firstRunAnswers = {};

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
    return Promise.resolve(out).catch(function () { return null; });
  }

  /* The answer is the whole setup, so one request covers every screen, and the
   * sheet closes whatever it answered: the server has already made what it can
   * of it, and the day is worth reading again either way. */
  function finishFirstRun() {
    var answer = firstRunAnswers;
    firstRunAnswers = {};
    var sheet = el("rb-first-run");
    var settle = function () {
      setHidden(sheet, true);
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

  /* A window the plan cannot use is not a window: a tick that would leave a
   * different number of them than cards is put back, and nothing is sent. */
  function chooseWindow(input) {
    var ticked = tickedWindows();
    if (ticked.length !== cardsOn) {
      input.checked = !input.checked;
      return;
    }
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

  function loadSlots() {
    return readPrefs().then(function (prefs) {
      buildSlots(prefs || {});
      return prefs;
    });
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
    expandedBy = {};
    clear(host);

    paintMeter(payload);
    maybeFirstRun(payload);
    /* A paused day has no cards and no streak: the status line above says so. */
    if (payload.off) return;

    var streak = streakBlock(payload);
    if (streak) host.appendChild(streak);

    var slots = Array.isArray(payload.slots) ? payload.slots : [];
    slots.forEach(function (item) {
      if (!item || typeof item !== "object") return;
      var name = typeof item.slot === "string" ? item.slot : "";
      var open = name !== "" && name === payload.nowSlot;
      expandedBy[name] = open;
      var card = cardNode(item, payload, open);
      cardBySlot[name] = card;
      host.appendChild(card);
    });
  }

  /* ---------------------------------------------------------------- refresh */

  function refresh() {
    if (!host || typeof fetch !== "function") return Promise.resolve(null);
    return whenCopy().then(function () {
      paintLabels();
      return fetch("/api/ramble/moves/day", {
        credentials: "same-origin",
        headers: { Accept: "application/json" }
      });
    }).then(function (res) {
      if (!res) return null;
      return Promise.resolve(res.json ? res.json() : null).catch(function () { return null; })
        .then(function (payload) {
          if (!res.ok || !payload || typeof payload !== "object") return null;
          paint(payload);
          return payload;
        });
    }).catch(function () {
      /* A day that could not be read leaves the cards the reader has alone. */
      return null;
    });
  }

  try { window.RambleToday = { refresh: refresh, paint: paint }; } catch (e) { /* no window: nothing to expose */ }

  if (!host) return;
  refresh();
})();
