/* Ramble moves client. Plain classic script (no modules, no bundler); served
 * from /ramble/static/moves.js behind dashboardAuth.
 *
 * NO TEMPLATE LITERALS anywhere in this file -- panel scripts are handled by
 * tooling that treats backticks as its own delimiter, so string concatenation
 * is the house style here too.
 *
 * What lives here (moves design, spec 2026-10-30 §6): the Today card's
 * challenge (Start / Done / Swap), the step goal and streak lines, the
 * "I did something else" sheet (parse, then manual pickers when there is no
 * model), Customize, the Learn list and its entry pages, and the flow player.
 * The server-rendered strings come from panel/ramble.js via lang; this
 * file's RUNTIME strings live in STR below, keyed off the data-lang attribute.
 *
 * Remote content (library titles and steps) is written with textContent only.
 * The one innerHTML write is figureInto: the markup is RambleFigure.poseSvg's
 * own output, computed from numbers, never anybody's text.
 *
 * Works without a model: Done, Swap, the library and the manual pickers never
 * ask one; the parse route answers no_model and we fall back.
 */
(function () {
  "use strict";

  var root = document.getElementById("ramble");
  var lang = "en";
  try { if (root && root.getAttribute("data-lang") === "es") lang = "es"; } catch (e) { lang = "en"; }

  var STR = {
    en: {
      doneToday: "Done today",
      yes: "Yes",
      notYet: "Not yet",
      smooth: "Smooth",
      neededHelp: "Needed help",
      levelFull: "Fully guided",
      levelNames: "Pose names only",
      levelFirst: "First pose only",
      levelMemory: "From memory",
      saving: "Saving\u2026",
      reading: "Reading it\u2026",
      logged: "Saved.",
      loggedHealth: " Health",
      loggedNone: " The day's budget is used up, but it is logged.",
      alreadyDone: "Already done today.",
      doneThanks: "Done. That is today's Health.",
      done: "Done",
      swap: "Swap",
      pauseLabel: "Pause",
      keepGoing: "Keep going",
      normalSpeed: "Normal speed",
      halfSpeed: "\u00bd speed",
      noChallenge: "Nothing to pick from just now.",
      paused: "Challenges are paused.",
      pausedLine: "Turn the daily challenge back on under Customize.",
      noSwaps: "No swaps left today",
      goalMet: "Step goal reached. That counts for the streak.",
      toGo: "steps to go today.",
      stepsStart: "Steps count on their own when the app can read them.",
      day: "day",
      days: "days",
      daysToHeart: "days in a row earns a heart.",
      toHeart: "more to a heart.",
      todayCounts: " Today counts.",
      writeFirst: "Write a line first, or use the pickers below.",
      readIt: "Crow reads it as",
      noModel: "No model here to read it. Pick the three things instead.",
      unclear: "That was not clear enough. Pick the three things instead.",
      minShort: "min",
      activity: "Activity",
      minutes: "Minutes",
      effort: "Effort",
      sources: "Sources",
      skipIf: "Skip if",
      works: "Works",
      stretches: "Stretches",
      mistakes: "Common mistakes",
      stepsTitle: "Steps",
      easier: "Easier",
      harder: "Harder",
      calm: "Calm",
      gentle: "Gentle",
      steady: "Steady",
      brisk: "Brisk",
      doneFromMemory: "Done from memory?",
      howWasIt: "How did it go?",
      flowCounted: "Noted. That is one run toward less guidance.",
      flowMemory: "Noted. You know this one.",
      flowNoted: "Noted.",
      poseOf: " of ",
      seconds: "s",
      backToBird: "Back to my bird",
      offline: "Could not reach the moves just now.",
      kindPose: "Pose",
      kindExercise: "Exercise",
      kindFlow: "Flow",
      kindWalk: "Walk",
      groupPose: "Poses",
      groupExercise: "Exercises",
      groupFlow: "Flows",
      groupWalk: "Walks",
      effortEasy: "easy",
      effortModerate: "moderate",
      effortHard: "hard",
      limitKnee: "knee",
      limitLowerBack: "lower back",
      limitNeck: "neck",
      limitShoulder: "shoulder",
      limitWrist: "wrist",
      limitHip: "hip",
      limitAnkle: "ankle",
      limitBalance: "balance",
      limitPregnancy: "pregnancy",
      limitHighBloodPressure: "high blood pressure"
    },
    es: {
      doneToday: "Hecho hoy",
      yes: "S\u00ed",
      notYet: "Todav\u00eda no",
      smooth: "Bien",
      neededHelp: "Necesit\u00e9 ayuda",
      levelFull: "Con gu\u00eda completa",
      levelNames: "Solo nombres de posturas",
      levelFirst: "Solo la primera postura",
      levelMemory: "De memoria",
      saving: "Guardando\u2026",
      reading: "Ley\u00e9ndolo\u2026",
      logged: "Guardado.",
      loggedHealth: " Salud",
      loggedNone: " El presupuesto del d\u00eda se acab\u00f3, pero queda registrado.",
      alreadyDone: "Ya est\u00e1 hecho hoy.",
      doneThanks: "Hecho. Esa es la Salud de hoy.",
      done: "Hecho",
      swap: "Cambiar",
      pauseLabel: "Pausa",
      keepGoing: "Seguir",
      normalSpeed: "Velocidad normal",
      halfSpeed: "\u00bd velocidad",
      noChallenge: "No hay nada que elegir ahora mismo.",
      paused: "Los retos est\u00e1n en pausa.",
      pausedLine: "Vuelve a activar el reto diario en Personalizar.",
      noSwaps: "No quedan cambios hoy",
      goalMet: "Meta de pasos alcanzada. Cuenta para la racha.",
      toGo: "pasos para hoy.",
      stepsStart: "Los pasos cuentan solos cuando la app puede leerlos.",
      day: "d\u00eda",
      days: "d\u00edas",
      daysToHeart: "d\u00edas seguidos dan un coraz\u00f3n.",
      toHeart: "para un coraz\u00f3n.",
      todayCounts: " Hoy cuenta.",
      writeFirst: "Escribe una l\u00ednea primero, o usa los selectores de abajo.",
      readIt: "Crow lo lee como",
      noModel: "Aqu\u00ed no hay un modelo que lo lea. Elige las tres cosas.",
      unclear: "No qued\u00f3 claro. Elige las tres cosas.",
      minShort: "min",
      activity: "Actividad",
      minutes: "Minutos",
      effort: "Esfuerzo",
      sources: "Fuentes",
      skipIf: "Saltar si",
      works: "Trabaja",
      stretches: "Estira",
      mistakes: "Errores comunes",
      stepsTitle: "Pasos",
      easier: "M\u00e1s f\u00e1cil",
      harder: "M\u00e1s dif\u00edcil",
      calm: "Suave",
      gentle: "Gentil",
      steady: "Constante",
      brisk: "Vivo",
      doneFromMemory: "\u00bfLo hiciste de memoria?",
      howWasIt: "\u00bfC\u00f3mo te fue?",
      flowCounted: "Anotado. Es una repetici\u00f3n hacia menos gu\u00eda.",
      flowMemory: "Anotado. Ya te lo sabes.",
      flowNoted: "Anotado.",
      poseOf: " de ",
      seconds: " s",
      backToBird: "Volver a mi p\u00e1jaro",
      offline: "No se pudo llegar a los movimientos ahora.",
      kindPose: "Postura",
      kindExercise: "Ejercicio",
      kindFlow: "Flujo",
      kindWalk: "Paseo",
      groupPose: "Posturas",
      groupExercise: "Ejercicios",
      groupFlow: "Flujos",
      groupWalk: "Paseos",
      effortEasy: "f\u00e1cil",
      effortModerate: "moderado",
      effortHard: "intenso",
      limitKnee: "rodilla",
      limitLowerBack: "espalda baja",
      limitNeck: "cuello",
      limitShoulder: "hombro",
      limitWrist: "mu\u00f1eca",
      limitHip: "cadera",
      limitAnkle: "tobillo",
      limitBalance: "equilibrio",
      limitPregnancy: "embarazo",
      limitHighBloodPressure: "presi\u00f3n alta"
    }
  };
  var TEXT = STR[lang] || STR.en;

  function t(key) {
    if (Object.prototype.hasOwnProperty.call(TEXT, key)) return TEXT[key];
    return Object.prototype.hasOwnProperty.call(STR.en, key) ? STR.en[key] : "";
  }

  var ACTIVITY_NAME = {
    en: { yoga: "yoga", walk: "walking", jog: "jogging", run: "running", cycle: "cycling", band: "band", bodyweight: "bodyweight", swim: "swimming", sport: "sport", other: "something else" },
    es: { yoga: "yoga", walk: "caminar", jog: "trote", run: "correr", cycle: "bicicleta", band: "banda", bodyweight: "peso corporal", swim: "nadar", sport: "deporte", other: "otra cosa" }
  };

  var KIND_NAME = { pose: "kindPose", exercise: "kindExercise", flow: "kindFlow", walk: "kindWalk" };
  var GROUP_NAME = { pose: "groupPose", exercise: "groupExercise", flow: "groupFlow", walk: "groupWalk" };
  var EFFORT_NAME = { easy: "effortEasy", moderate: "effortModerate", hard: "effortHard" };
  var LIMIT_NAME = {
    knee: "limitKnee", lower_back: "limitLowerBack", neck: "limitNeck", shoulder: "limitShoulder",
    wrist: "limitWrist", hip: "limitHip", ankle: "limitAnkle", balance: "limitBalance",
    pregnancy: "limitPregnancy", high_blood_pressure: "limitHighBloodPressure"
  };
  var LEVEL_NAME = { 1: "gentle", 2: "steady", 3: "brisk" };
  var SAFETY_KEY = "ramble.moves.safetySeen";
  var TRANSITION_MS = 1200;

  /* ------------------------------------------------------------ pure bits */

  /**
   * The poses a guidance level actually plays. "first" shows ONLY the first
   * pose, then asks whether the reader managed the rest from memory; "full",
   * "names" and "memory" play the whole flow (what is DRAWN changes instead).
   */
  function flowFrames(level, steps) {
    if (!Array.isArray(steps) || steps.length === 0) return [];
    if (level === "first") return [steps[0]];
    return steps.slice();
  }

  /** What one guidance level shows. */
  function guidance(level) {
    return {
      name: level !== "memory",
      cues: level === "full",
      memoryPrompt: level === "first"
    };
  }

  /** A parse result with no usable triple falls back to the manual pickers. */
  function parseFallback(reason) {
    return reason === "no_model" || reason === "unclear";
  }

  /* The public surface tests can exercise without a DOM interaction. */
  var api = { flowFrames: flowFrames, guidance: guidance, parseFallback: parseFallback, transitionMs: TRANSITION_MS };
  try { window.RambleMoves = api; } catch (e) { /* no window: nothing to expose */ }

  if (!root) return;

  /* -------------------------------------------------------------- helpers */

  function $(id) { return document.getElementById(id); }
  function setText(el, text) { if (el) el.textContent = text; }
  function setHidden(el, on) {
    if (!el) return;
    if (on) el.setAttribute("hidden", "");
    else el.removeAttribute("hidden");
  }
  function jsonFetch(url, options) {
    var opts = options || {};
    opts.credentials = "same-origin";
    if (opts.body !== undefined && typeof opts.body !== "string") {
      opts.headers = Object.assign({ "Content-Type": "application/json" }, opts.headers || {});
      opts.body = JSON.stringify(opts.body);
    }
    return fetch(url, opts).then(function (res) {
      if (res.status === 204) return null;
      return res.json().catch(function () { return null; }).then(function (body) {
        if (!res.ok) throw new Error((body && body.error) || ("request failed: " + res.status));
        return body;
      });
    });
  }
  function stepsLabel(n) {
    var v = Math.floor(Number(n));
    if (!isFinite(v) || v < 0) v = 0;
    return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  }
  function valueOf(id) {
    var el = $(id);
    return el && typeof el.value === "string" ? el.value : "";
  }
  function setSelect(id, value) {
    var el = $(id);
    if (!el) return;
    var v = String(value);
    var options = el.options || [];
    var found = false;
    for (var i = 0; i < options.length; i += 1) {
      if (options[i].value === v) { found = true; break; }
    }
    if (!found) {
      try {
        var opt = document.createElement("option");
        opt.value = v;
        opt.textContent = v;
        el.appendChild(opt);
      } catch (e) { /* the select still takes the value below */ }
    }
    el.value = v;
  }
  function setChecked(id, on) {
    var el = $(id);
    if (el) el.checked = !!on;
  }
  function checkMany(selector, values) {
    var list = Array.prototype.slice.call(document.querySelectorAll(selector));
    list.forEach(function (el) {
      var v = el.getAttribute("data-value");
      el.checked = values.indexOf(v) !== -1;
    });
  }
  function checkedValues(selector) {
    var out = [];
    Array.prototype.slice.call(document.querySelectorAll(selector)).forEach(function (el) {
      if (el.checked) out.push(el.getAttribute("data-value"));
    });
    return out;
  }
  function openSheet(id) { setHidden($(id), false); }
  function closeSheet(id) { setHidden($(id), true); }
  function showLearnView() {
    root.setAttribute("data-view", "learn");
    try { window.scrollTo(0, 0); } catch (e) { /* not fatal */ }
  }

  /* --------------------------------------------------------------- health */

  /* The Today card paints the same Health number the pet card does, from the
   * moves snapshot it already has — so a Done updates the bar without waiting
   * for a second pet read. */
  function paintHealth(health) {
    if (!health || typeof health.energy !== "number") return;
    var max = typeof health.max === "number" && health.max > 0 ? health.max : 100;
    var fill = $("rb-energy-fill");
    if (fill) fill.style.width = Math.max(0, Math.min(100, (health.energy / max) * 100)) + "%";
    setText($("rb-energy-num"), String(health.energy));
    setText($("rb-energy-max"), String(max));
  }

  /* ---------------------------------------------------------------- today */

  var today = null;

  function challengeMeta(entry) {
    if (!entry) return "";
    var bits = [];
    if (Number.isFinite(Number(entry.minutes))) bits.push(Number(entry.minutes) + " " + t("minShort"));
    if (entry.kind && KIND_NAME[entry.kind]) bits.push(t(KIND_NAME[entry.kind]));
    if (LEVEL_NAME[entry.level]) bits.push(t(LEVEL_NAME[entry.level]));
    return bits.join(" \u00b7 ");
  }

  function paintSteps(st) {
    if (!st) return;
    var goal = Number(st.goal) > 0 ? Number(st.goal) : 6000;
    var steps = Math.max(0, Number(st.steps) || 0);
    setText($("rb-goal-num"), stepsLabel(steps));
    setText($("rb-goal-max"), stepsLabel(goal));
    var fill = $("rb-goal-fill");
    if (fill) fill.style.width = Math.min(100, Math.round(steps * 100 / goal)) + "%";
    var line;
    if (st.goal_met) line = t("goalMet");
    else if (steps > 0) line = stepsLabel(goal - steps) + " " + t("toGo");
    else line = t("stepsStart");
    setText($("rb-goal-line"), line);
  }

  function paintStreak(st) {
    if (!st) return;
    var days = Math.max(0, Number(st.days) || 0);
    var every = Number(st.nextHeartAt) > 0 ? Number(st.nextHeartAt) : 7;
    var line;
    if (days > 0) {
      var remaining = every - (days % every);
      line = days + " " + (days === 1 ? t("day") : t("days")) + " \u00b7 " + remaining + " " + t("toHeart");
    } else {
      line = every + " " + t("daysToHeart");
    }
    if (st.todayGood) line += t("todayCounts");
    setText($("rb-streak-line"), line);
  }

  function paintToday(snap) {
    if (!snap) return;
    today = snap;
    paintHealth(snap.health);
    paintSteps(snap.steps);
    paintStreak(snap.streak);

    var c = snap.challenge;
    var title = $("rb-challenge-title");
    var meta = $("rb-challenge-meta");
    var why = $("rb-challenge-why");
    var start = $("rb-challenge-start");
    var done = $("rb-challenge-done");
    var swap = $("rb-challenge-swap");

    if (!c) {
      setText(title, t("noChallenge"));
      setText(meta, "");
      setHidden(why, true);
      if (start) start.disabled = true;
      if (done) done.disabled = true;
      if (swap) swap.disabled = true;
      return;
    }

    var off = !!c.off;
    if (off) {
      setText(title, t("paused"));
      setText(meta, t("pausedLine"));
      setHidden(why, true);
    } else {
      setText(title, c.entry && c.entry.title ? c.entry.title : t("noChallenge"));
      setText(meta, challengeMeta(c.entry));
      setText(why, c.why || "");
      setHidden(why, !c.why);
    }

    if (start) {
      start.disabled = off || !c.entry;
      setHidden(start, off);
    }
    if (done) {
      setHidden(done, off);
      done.disabled = off || !!c.done;
      done.textContent = c.done ? t("doneToday") : t("done");
    }
    if (swap) {
      var usedUp = Number(c.swap) >= 3;
      setHidden(swap, off);
      swap.disabled = off || usedUp;
      swap.textContent = usedUp ? t("noSwaps") : t("swap");
    }
  }

  function refreshToday() {
    return jsonFetch("/api/ramble/moves/today")
      .then(paintToday)
      .catch(function () { setText($("rb-today-status"), t("offline")); });
  }

  /* --------------------------------------------------------------- safety */

  var pendingSafety = null;

  function safetySeen() {
    try { return window.localStorage.getItem(SAFETY_KEY) === "1"; } catch (e) { return false; }
  }
  function markSafetySeen() {
    try { window.localStorage.setItem(SAFETY_KEY, "1"); } catch (e) { /* forget it, then */ }
  }
  function aroundSafety(fn) {
    if (safetySeen()) { fn(); return; }
    pendingSafety = fn;
    openSheet("rb-safety-sheet");
  }

  var safetyBtn = $("rb-safety-gotit");
  if (safetyBtn) safetyBtn.addEventListener("click", function () {
    markSafetySeen();
    closeSheet("rb-safety-sheet");
    var fn = pendingSafety;
    pendingSafety = null;
    if (fn) fn();
  });

  /* --------------------------------------------------------- done / swap */

  function startChallenge() {
    var c = today && today.challenge;
    if (!c || c.off || !c.entry) return;
    var id = c.entry.id;
    aroundSafety(function () {
      showLearnView();
      openLearnEntry(id, true);
    });
  }

  function postDone() {
    var c = today && today.challenge;
    if (!c || c.off) return;
    var day = c.day;
    aroundSafety(function () {
      var btn = $("rb-challenge-done");
      if (btn) btn.disabled = true;
      setText($("rb-today-status"), t("saving"));
      jsonFetch("/api/ramble/moves/done", { method: "POST", body: { day: day } })
        .then(function (snap) {
          if (snap && snap.done && snap.done.already) setText($("rb-today-status"), t("alreadyDone"));
          else setText($("rb-today-status"), t("doneThanks"));
          paintToday(snap);
        })
        .catch(function (err) {
          setText($("rb-today-status"), err.message);
          if (btn) btn.disabled = false;
        });
    });
  }

  function postSwap() {
    var c = today && today.challenge;
    if (!c || c.off) return;
    var btn = $("rb-challenge-swap");
    if (btn) btn.disabled = true;
    setText($("rb-today-status"), t("saving"));
    jsonFetch("/api/ramble/moves/swap", { method: "POST", body: {} })
      .then(function (snap) {
        setText($("rb-today-status"), "");
        paintToday(snap);
      })
      .catch(function (err) {
        setText($("rb-today-status"), err.message);
        if (btn) btn.disabled = false;
      });
  }

  var startBtn = $("rb-challenge-start");
  if (startBtn) startBtn.addEventListener("click", startChallenge);
  var doneBtn = $("rb-challenge-done");
  if (doneBtn) doneBtn.addEventListener("click", postDone);
  var swapBtn = $("rb-challenge-swap");
  if (swapBtn) swapBtn.addEventListener("click", postSwap);

  /* --------------------------------------------------- something else */

  /* The dashboard's own dictation hook, if this page has one. We never speak
   * for it and build no speech code of our own: no hook means no button. */
  function dictation() {
    var h = window.crowDictation || window.CrowDictation;
    if (typeof h === "function") return h;
    if (h && typeof h.start === "function") return function (el) { return h.start(el); };
    return null;
  }

  var sayBtn = $("rb-else-say");
  var speak = dictation();
  if (sayBtn) {
    if (speak) {
      setHidden(sayBtn, false);
      sayBtn.addEventListener("click", function () {
        try { speak($("rb-else-text")); } catch (e) { /* the hook declined */ }
      });
    } else {
      setHidden(sayBtn, true);
    }
  }

  function showPickers(reason) {
    setHidden($("rb-else-pickers"), false);
    setHidden($("rb-else-reading"), true);
    setText($("rb-else-status"), reason === "no_model" ? t("noModel") : t("unclear"));
  }

  function showReading(parsed) {
    setHidden($("rb-else-pickers"), false);
    setSelect("rb-else-activity", parsed.activity);
    setSelect("rb-else-minutes", parsed.minutes);
    setSelect("rb-else-effort", parsed.effort);
    var name = (ACTIVITY_NAME[lang] && ACTIVITY_NAME[lang][parsed.activity]) || parsed.activity;
    var effort = t(EFFORT_NAME[parsed.effort] || "");
    var pts = Number(parsed.points) > 0 ? " \u00b7 +" + Number(parsed.points) + t("loggedHealth") : "";
    setText($("rb-else-reading"), t("readIt") + ": " + name + " \u00b7 " + parsed.minutes + " " + t("minShort") + " \u00b7 " + effort + pts);
    setHidden($("rb-else-reading"), false);
    setText($("rb-else-status"), "");
  }

  function readElse() {
    var box = $("rb-else-text");
    var text = box && typeof box.value === "string" ? box.value : "";
    if (text.trim() === "") {
      setText($("rb-else-status"), t("writeFirst"));
      showPickers("unclear");
      return;
    }
    setText($("rb-else-status"), t("reading"));
    jsonFetch("/api/ramble/moves/parse", { method: "POST", body: { text: text } })
      .then(function (out) {
        if (out && out.ok) { showReading(out); return; }
        showPickers(out && out.reason);
      })
      .catch(function () { showPickers("unclear"); });
  }

  function logElse() {
    var activity = valueOf("rb-else-activity");
    var minutes = Number(valueOf("rb-else-minutes"));
    var effort = valueOf("rb-else-effort");
    if (!activity || !isFinite(minutes) || minutes < 1 || !effort) {
      setText($("rb-else-status"), t("writeFirst"));
      return;
    }
    setText($("rb-else-status"), t("saving"));
    jsonFetch("/api/ramble/moves/log", { method: "POST", body: { activity: activity, minutes: minutes, effort: effort } })
      .then(function (out) {
        var paid = out && out.log ? Number(out.log.paid) : 0;
        setText($("rb-else-status"), t("logged") + (paid > 0 ? " +" + paid + t("loggedHealth") : t("loggedNone")));
        var box = $("rb-else-text");
        if (box) box.value = "";
        paintToday(out);
      })
      .catch(function (err) { setText($("rb-else-status"), err.message); });
  }

  var elseOpen = $("rb-something-else");
  if (elseOpen) elseOpen.addEventListener("click", function () {
    setText($("rb-else-status"), "");
    setHidden($("rb-else-reading"), true);
    setHidden($("rb-else-pickers"), true);
    openSheet("rb-else-sheet");
  });
  var elseClose = $("rb-else-close");
  if (elseClose) elseClose.addEventListener("click", function () { closeSheet("rb-else-sheet"); });
  var elseRead = $("rb-else-read");
  if (elseRead) elseRead.addEventListener("click", readElse);
  var elseLog = $("rb-else-log");
  if (elseLog) elseLog.addEventListener("click", logElse);

  /* ------------------------------------------------------------ customize */

  var prefs = null;

  function paintPrefs(out) {
    var p = out && out.prefs ? out.prefs : out;
    if (!p) return;
    prefs = p;
    setChecked("rb-pref-on", !!p.on);
    setChecked("rb-pref-weather", p.weather !== false);
    var level = [1, 2, 3].indexOf(Number(p.level)) !== -1 ? Number(p.level) : 2;
    var slider = $("rb-pref-level");
    if (slider) slider.value = String(level);
    setText($("rb-pref-level-val"), t(LEVEL_NAME[level]));
    checkMany(".rb-pref-kind", Array.isArray(p.kinds) ? p.kinds : []);
    checkMany(".rb-pref-equipment", Array.isArray(p.equipment) ? p.equipment : []);
    checkMany(".rb-pref-limit", Array.isArray(p.limits) ? p.limits : []);
  }

  function loadPrefs() {
    return jsonFetch("/api/ramble/moves/prefs").then(paintPrefs).catch(function (err) {
      setText($("rb-customize-status"), err.message);
    });
  }

  function savePrefs(patch) {
    setText($("rb-customize-status"), t("saving"));
    jsonFetch("/api/ramble/moves/prefs", { method: "POST", body: patch })
      .then(function (out) {
        paintPrefs(out);
        setText($("rb-customize-status"), t("logged"));
        return refreshToday();
      })
      .catch(function (err) { setText($("rb-customize-status"), err.message); });
  }

  var customizeOpen = $("rb-customize");
  if (customizeOpen) customizeOpen.addEventListener("click", function () {
    openSheet("rb-customize-sheet");
    loadPrefs();
  });
  var customizeClose = $("rb-customize-close");
  if (customizeClose) customizeClose.addEventListener("click", function () { closeSheet("rb-customize-sheet"); });

  var prefOn = $("rb-pref-on");
  if (prefOn) prefOn.addEventListener("change", function () { savePrefs({ on: !!prefOn.checked }); });
  var prefWeather = $("rb-pref-weather");
  if (prefWeather) prefWeather.addEventListener("change", function () { savePrefs({ weather: !!prefWeather.checked }); });

  var prefLevel = $("rb-pref-level");
  if (prefLevel) {
    prefLevel.addEventListener("input", function () {
      var n = Number(prefLevel.value);
      setText($("rb-pref-level-val"), t(LEVEL_NAME[n] || LEVEL_NAME[2]));
    });
    prefLevel.addEventListener("change", function () { savePrefs({ level: Number(prefLevel.value) }); });
  }

  Array.prototype.slice.call(document.querySelectorAll(".rb-pref-kind")).forEach(function (el) {
    el.addEventListener("change", function () { savePrefs({ kinds: checkedValues(".rb-pref-kind") }); });
  });
  Array.prototype.slice.call(document.querySelectorAll(".rb-pref-equipment")).forEach(function (el) {
    el.addEventListener("change", function () { savePrefs({ equipment: checkedValues(".rb-pref-equipment") }); });
  });
  Array.prototype.slice.call(document.querySelectorAll(".rb-pref-limit")).forEach(function (el) {
    el.addEventListener("change", function () { savePrefs({ limits: checkedValues(".rb-pref-limit") }); });
  });

  /* ---------------------------------------------------------------- learn */

  var library = null;
  var entryCache = {};

  function entryRow(entry) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "rb-step rb-pick";
    var txt = document.createElement("div");
    txt.className = "rb-step-txt";
    var title = document.createElement("strong");
    title.textContent = entry.title || entry.id;
    var sub = document.createElement("span");
    sub.className = "rb-muted rb-fine";
    sub.textContent = challengeMeta(entry);
    txt.appendChild(title);
    txt.appendChild(sub);
    btn.appendChild(txt);
    btn.addEventListener("click", function () { openLearnEntry(entry.id, false); });
    return btn;
  }

  function paintLibrary(out) {
    var entries = out && Array.isArray(out.entries) ? out.entries : [];
    library = entries;
    var list = $("rb-learn-list");
    if (!list) return;
    list.textContent = "";
    setHidden($("rb-learn-empty"), entries.length > 0);
    if (entries.length === 0) return;
    ["pose", "exercise", "flow", "walk"].forEach(function (kind) {
      var group = entries.filter(function (e) { return e && e.kind === kind; });
      if (group.length === 0) return;
      var head = document.createElement("p");
      head.className = "rb-eyebrow";
      head.textContent = t(GROUP_NAME[kind] || "kindPose");
      list.appendChild(head);
      group.forEach(function (e) { list.appendChild(entryRow(e)); });
    });
  }

  function refreshLibrary() {
    return jsonFetch("/api/ramble/moves/library")
      .then(paintLibrary)
      .catch(function () { /* the list can be empty for now */ });
  }

  function addList(host, title, items) {
    if (!host || !Array.isArray(items) || items.length === 0) return;
    var row = document.createElement("div");
    row.className = "rb-step";
    var txt = document.createElement("div");
    txt.className = "rb-step-txt";
    var strong = document.createElement("strong");
    strong.textContent = title;
    txt.appendChild(strong);
    items.forEach(function (item) {
      var line = document.createElement("span");
      line.className = "rb-muted rb-fine";
      line.textContent = String(item);
      txt.appendChild(line);
    });
    row.appendChild(txt);
    host.appendChild(row);
  }

  function addSources(host, sources) {
    if (!host || !Array.isArray(sources) || sources.length === 0) return;
    var row = document.createElement("div");
    row.className = "rb-step";
    var txt = document.createElement("div");
    txt.className = "rb-step-txt";
    var strong = document.createElement("strong");
    strong.textContent = t("sources");
    txt.appendChild(strong);
    sources.forEach(function (s) {
      if (!s) return;
      var line = document.createElement("span");
      line.className = "rb-muted rb-fine";
      line.textContent = String(s.title || "") + " \u00b7 " + String(s.license || "") +
        (typeof s.url === "string" && s.url !== "" ? " \u00b7 " + s.url : "");
      txt.appendChild(line);
    });
    row.appendChild(txt);
    host.appendChild(row);
  }

  function addLink(host, id, label) {
    if (!host || typeof id !== "string" || id === "") return;
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "rb-btn rb-btn-ghost";
    btn.textContent = label;
    btn.addEventListener("click", function () { openLearnEntry(id, false); });
    host.appendChild(btn);
  }

  function figureInto(el, pose) {
    if (!el) return;
    var Fig = window.RambleFigure;
    if (!Fig || typeof Fig.poseSvg !== "function" || !pose) { el.textContent = ""; return; }
    try { el.innerHTML = Fig.poseSvg(pose); }
    catch (e) { el.textContent = ""; }
  }

  function paintEntry(entry, level, autoplay) {
    setText($("rb-entry-title"), entry.title || entry.id);
    var levelKey = { full: "levelFull", names: "levelNames", first: "levelFirst", memory: "levelMemory" }[level];
    setText($("rb-entry-meta"), challengeMeta(entry) + (entry.kind === "flow" && levelKey ? " \u00b7 " + t(levelKey) : ""));

    var fig = $("rb-entry-figure");
    var body = $("rb-entry-body");
    var links = $("rb-entry-links");
    if (body) body.textContent = "";
    if (links) links.textContent = "";

    var isFlow = entry.kind === "flow";
    var hasFigure = !isFlow && entry.kind === "pose";
    if (fig) {
      setHidden(fig, !hasFigure);
      if (hasFigure) figureInto(fig, entry.pose);
      else fig.textContent = "";
    }

    addList(body, t("stepsTitle"), entry.steps);
    addList(body, t("works"), entry.works);
    addList(body, t("stretches"), entry.stretches);
    addList(body, t("mistakes"), entry.mistakes);
    if (Array.isArray(entry.skipIf) && entry.skipIf.length > 0) {
      addList(body, t("skipIf"), entry.skipIf.map(function (tag) { return t(LIMIT_NAME[tag] || "") || tag; }));
    }
    addSources(body, entry.sources);
    addLink(links, entry.easier, t("easier"));
    addLink(links, entry.harder, t("harder"));

    var flowBox = $("rb-flow");
    if (isFlow) {
      setHidden(flowBox, false);
      loadFlowPoses(entry, level, autoplay);
    } else {
      stopPlayer();
      setHidden(flowBox, true);
    }
  }

  function entryById(id) {
    if (Object.prototype.hasOwnProperty.call(entryCache, id)) return Promise.resolve(entryCache[id]);
    return jsonFetch("/api/ramble/moves/library/" + encodeURIComponent(id))
      .then(function (out) {
        var entry = out && out.entry ? out.entry : null;
        if (entry) entryCache[id] = entry;
        return entry;
      })
      .catch(function () { return null; });
  }

  function openLearnEntry(id, autoplay) {
    stopPlayer();
    showLearnView();
    setHidden($("rb-learn-list-card"), true);
    setHidden($("rb-learn-entry-card"), false);
    setText($("rb-learn-status"), "");
    return jsonFetch("/api/ramble/moves/library/" + encodeURIComponent(id))
      .then(function (out) {
        if (!out || !out.entry) return;
        paintEntry(out.entry, out.level || "full", autoplay === true);
      })
      .catch(function (err) { setText($("rb-learn-status"), err.message); });
  }

  function showLearnList() {
    setHidden($("rb-learn-list-card"), false);
    setHidden($("rb-learn-entry-card"), true);
  }

  function showLearn() {
    stopPlayer();
    showLearnView();
    showLearnList();
    refreshLibrary();
  }

  var learnBtn = $("rb-learn-btn");
  if (learnBtn) learnBtn.addEventListener("click", showLearn);
  var learnBack = $("rb-learn-back");
  if (learnBack) learnBack.addEventListener("click", function () { stopPlayer(); showLearnList(); });
  var learnBackPet = $("rb-learn-back-pet");
  if (learnBackPet) learnBackPet.addEventListener("click", function () { stopPlayer(); root.setAttribute("data-view", "pet"); refreshToday(); });

  /* ----------------------------------------------------------- flow player */

  var player = null;
  var currentFlow = null;

  function flowPose(pose, frame, index, total, flags) {
    figureInto($("rb-flow-figure"), pose);
    setText($("rb-flow-name"), flags.name ? (frame.name || "") : "");
    setText($("rb-flow-cues"), flags.cues && Array.isArray(frame.cues) ? frame.cues.join(" ") : "");
    setText($("rb-flow-progress"), (index + 1) + t("poseOf") + total + (frame.holdSeconds ? " \u00b7 " + frame.holdSeconds + t("seconds") : ""));
  }

  function shownAsk(flags) {
    setHidden($("rb-flow-ask"), false);
    setText($("rb-flow-ask-title"), flags.memoryPrompt ? t("doneFromMemory") : t("howWasIt"));
    // At the first-pose level the question is yes/no, not smooth/needed help.
    setText($("rb-flow-smooth"), t(flags.memoryPrompt ? "yes" : "smooth"));
    setText($("rb-flow-help"), t(flags.memoryPrompt ? "notYet" : "neededHelp"));
  }

  /**
   * The player: holds each pose for its holdSeconds and tweens between
   * consecutive poses over TRANSITION_MS (x2 at half speed). Reduced motion
   * skips the tween and swaps poses. All timing goes through injected
   * raf/now so the pure behaviour is testable; in the page they are
   * requestAnimationFrame and Date.now.
   */
  function createPlayer(opts) {
    var steps = Array.isArray(opts.steps) ? opts.steps : [];
    var frames = flowFrames(opts.level, steps);
    var flags = guidance(opts.level);
    var reduced = opts.reduced === true;
    var speed = 1;
    var index = 0;
    var phase = "hold";
    var elapsed = 0;
    var paused = false;
    var stopped = false;
    var last = 0;
    var raf = opts.raf;

    function inMs() { return reduced ? 0 : TRANSITION_MS / speed; }
    function holdMs() { return Math.max(0, Number(frames[index] && frames[index].holdSeconds) || 0) * 1000 / speed; }

    function draw(t) {
      var frame = frames[index];
      if (!frame) return;
      var pose = frame.pose;
      if (phase === "in" && index > 0 && !reduced) {
        var Fig = window.RambleFigure;
        var prev = frames[index - 1];
        if (Fig && typeof Fig.interpolate === "function" && prev && prev.pose) {
          try { pose = Fig.interpolate(prev.pose, frame.pose, t); } catch (e) { pose = frame.pose; }
        }
      }
      if (typeof opts.onPose === "function") opts.onPose(pose, frame, index, frames.length, flags);
    }

    function finish() {
      stopped = true;
      if (typeof opts.onDone === "function") opts.onDone(flags);
    }

    function tick(ts) {
      if (stopped) return;
      if (paused) { last = ts; raf(tick); return; }
      var dt = last === 0 ? 0 : Math.max(0, ts - last);
      last = ts;
      elapsed += dt;
      var limit = phase === "in" ? inMs() : holdMs();
      while (!stopped && elapsed >= limit && limit >= 0) {
        elapsed -= limit;
        if (phase === "in") { phase = "hold"; limit = holdMs(); continue; }
        if (index >= frames.length - 1) { finish(); return; }
        index += 1;
        phase = inMs() > 0 ? "in" : "hold";
        limit = phase === "in" ? inMs() : holdMs();
      }
      draw(phase === "in" && limit > 0 ? elapsed / limit : 1);
      raf(tick);
    }

    function start() {
      if (frames.length === 0) return;
      stopped = false;
      last = 0;
      phase = "hold";
      elapsed = 0;
      draw(1);
      raf(tick);
    }

    return {
      start: start,
      frames: frames,
      flags: flags,
      pause: function () { paused = !paused; return paused; },
      half: function () { speed = speed === 1 ? 0.5 : 1; return speed; },
      step: function () {
        if (index >= frames.length - 1) { finish(); return; }
        index += 1;
        phase = "hold";
        elapsed = 0;
        draw(1);
      },
      stop: function () { stopped = true; },
      isPaused: function () { return paused; },
      speed: function () { return speed; }
    };
  }

  function stopPlayer() {
    if (player) { try { player.stop(); } catch (e) { /* gone */ } player = null; }
    setHidden($("rb-flow-ask"), true);
  }

  function startFlow(entry, level, steps, autoplay) {
    stopPlayer();
    currentFlow = { id: entry.id, level: level };
    setText($("rb-flow-status"), "");
    setHidden($("rb-flow-ask"), true);
    var raf = window.requestAnimationFrame || function (fn) { return setTimeout(function () { fn(Date.now()); }, 16); };
    player = createPlayer({
      level: level,
      steps: steps,
      reduced: !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches),
      raf: raf,
      onPose: flowPose,
      onDone: shownAsk
    });
    player.start();
  }

  function loadFlowPoses(entry, level, autoplay) {
    var steps = Array.isArray(entry.flow) ? entry.flow : [];
    if (steps.length === 0) { setText($("rb-flow-status"), t("offline")); return; }
    Promise.all(steps.map(function (step) {
      return entryById(step.id).then(function (poseEntry) {
        return {
          id: step.id,
          holdSeconds: step.holdSeconds,
          name: poseEntry ? poseEntry.title : step.id,
          pose: poseEntry ? poseEntry.pose : null,
          cues: poseEntry && Array.isArray(poseEntry.steps) ? poseEntry.steps : []
        };
      });
    })).then(function (poses) {
      startFlow(entry, level, poses, true);
    }).catch(function (err) { setText($("rb-flow-status"), err.message); });
  }

  var flowPause = $("rb-flow-pause");
  if (flowPause) flowPause.addEventListener("click", function () {
    if (!player) return;
    var paused = player.pause();
    flowPause.textContent = paused ? t("keepGoing") : t("pauseLabel");
  });
  var flowHalf = $("rb-flow-half");
  if (flowHalf) flowHalf.addEventListener("click", function () {
    if (!player) return;
    var speed = player.half();
    flowHalf.textContent = speed === 0.5 ? t("normalSpeed") : t("halfSpeed");
  });
  var flowStep = $("rb-flow-step");
  if (flowStep) flowStep.addEventListener("click", function () {
    if (!player) return;
    setHidden($("rb-flow-ask"), true);
    player.step();
  });

  function reportFlow(outcome) {
    if (!currentFlow) return;
    var body = { flowId: currentFlow.id, outcome: outcome };
    if (currentFlow.level === "first") body.fromMemory = true;
    setText($("rb-flow-status"), t("saving"));
    jsonFetch("/api/ramble/moves/flow-run", { method: "POST", body: body })
      .then(function (out) {
        setHidden($("rb-flow-ask"), true);
        if (out && out.memory) setText($("rb-flow-status"), t("flowMemory"));
        else if (out && out.counted) setText($("rb-flow-status"), t("flowCounted"));
        else setText($("rb-flow-status"), t("flowNoted"));
      })
      .catch(function (err) { setText($("rb-flow-status"), err.message); });
  }

  var flowSmooth = $("rb-flow-smooth");
  if (flowSmooth) flowSmooth.addEventListener("click", function () { reportFlow("smooth"); });
  var flowHelp = $("rb-flow-help");
  if (flowHelp) flowHelp.addEventListener("click", function () { reportFlow("needed_help"); });

  /* ------------------------------------------------------- sheets and keys */

  ["rb-else-sheet", "rb-customize-sheet", "rb-safety-sheet"].forEach(function (id) {
    var sheet = $(id);
    if (!sheet) return;
    sheet.addEventListener("click", function (ev) { if (ev.target === sheet) setHidden(sheet, true); });
  });
  document.addEventListener("keydown", function (ev) {
    if (ev.key !== "Escape") return;
    ["rb-else-sheet", "rb-customize-sheet", "rb-safety-sheet"].forEach(function (id) {
      var sheet = $(id);
      if (sheet && !sheet.hasAttribute("hidden")) setHidden(sheet, true);
    });
  });

  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) refreshToday();
  });

  /* --------------------------------------------------------------- startup */

  refreshToday();
  loadPrefs();
  refreshLibrary();
})();