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

  /* ------------------------------------------------------------------ paint */

  function paint(payload) {
    if (!host || !payload || typeof payload !== "object") return;
    day = payload;
    cardBySlot = {};
    expandedBy = {};
    clear(host);

    paintMeter(payload);
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
