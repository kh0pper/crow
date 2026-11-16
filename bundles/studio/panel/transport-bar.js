/**
 * Crow Studio — the transport bar, as one inline classic script.
 *
 * The bar is one fixed layer at the bottom of the page: it ends on top of the
 * player bar and the shell's tabs, carries the transport controls the header
 * used to hold, and shows the scene the grid is playing beside the scene a
 * launch has queued for the next bar. Like every panel script in this repo it
 * travels as a string (`TRANSPORT_SCRIPT`) and is written as an EXPRESSIONS
 * ONLY classic script: no backtick, no `${`, no double quote and no backslash
 * anywhere in the emitted text. It assigns one global — `window.StudioTransport`
 * — and the page mounts it once, before the client.
 *
 * ## What it owns
 *
 * `mount(page, hooks, options)` MOVES the page's existing controls into one
 * `.st-transport-bar`: play, stop, pause and record, the bpm field, the
 * position readout, the recording status, its latency reading, the click toggle
 * and the output picker. They stay the page's own nodes, so the client's
 * delegated click handler and every render that paints one of them keep
 * working untouched. The
 * bar measures its own height into `--st-transport-h` on the `.studio` element,
 * which is what the page reserves at its bottom, and `options.sizeClass` says
 * which size class the page is in: a phone keeps the transport controls alone,
 * with the output picker hidden. The bar watches the page's two width
 * breakpoints itself, so a rotate or a resize moves the picker even when the
 * page renders nothing.
 *
 * `hooks` is the page's own reading of the transport:
 * `{snapshot(), isPlaying(), isPaused(), isRecording(), position(),
 * queuedSceneId(), currentSceneId()}`. The returned controller is
 * `{refresh(), destroy()}`: `refresh` repaints the readout and the pressed
 * states (the client calls it after a render), and `destroy` puts every moved
 * node back where it was and removes `--st-transport-h` again.
 *
 * ## The queued scene
 *
 * The engine does not expose its launch queue, so the page keeps the scene it
 * last asked for and the bar reads it through `queuedSceneId`. `nextQueued` is
 * the one reducer that moves that value, so a launch, a Stop and an applied
 * launch report can never disagree about what sits next in line: a launch sets
 * it (a newer one replaces it), a Stop clears it, and any `launched` report
 * clears it too.
 *
 * ## The readout
 *
 * `sceneLabel(snap, sceneId)` names one line of the readout: `Now: Verse` for
 * the scene sounding, `Next: Chorus` when the caller names the next role, and a
 * plain `-` when there is no such scene in this song. A scene the song no
 * longer has therefore reads as a dash rather than a stale name.
 *
 * The CSS below is a string instead of a template literal so the file carries
 * no backtick at all; the styles land in the page's one style block after the
 * page's own rules, which is what lets them adjust the toast above the bar.
 *
 * @type {string}
 */
export const TRANSPORT_SCRIPT = [
  "(function () {",
  "  'use strict';",
  "",
  "  // The scene readout: what the grid is playing now, and what a launch has",
  "  // queued for the next bar. The engine does not publish its launch queue, so",
  "  // the page remembers the scene it last asked for and this reducer is the only",
  "  // thing that moves it. A launch replaces it, including a newer launch; a Stop",
  "  // clears it, and so does any launch report the sequencer applied.",
  "  function nextQueued(queued, event) {",
  "    if (!event || typeof event !== 'object') return queued || null;",
  "    var type = event.type;",
  "    if (type === 'stop' || type === 'launched') return null;",
  "    if (type !== 'launch') return queued || null;",
  "    var id = event.scene_id;",
  "    if (id === null || id === undefined || id === '') return queued || null;",
  "    return String(id);",
  "  }",
  "",
  "  // One line of the readout: the scene by name, with its role in front, or a",
  "  // dash when the hook named no scene or a scene this song does not have.",
  "  function sceneLabel(snap, sceneId, role) {",
  "    if (sceneId === null || sceneId === undefined || sceneId === '') return '-';",
  "    var scenes = snap && typeof snap === 'object' && Array.isArray(snap.scenes) ? snap.scenes : [];",
  "    var wanted = String(sceneId);",
  "    var name = '';",
  "    for (var i = 0; i < scenes.length; i += 1) {",
  "      var scene = scenes[i];",
  "      if (!scene || typeof scene !== 'object') continue;",
  "      if (String(scene.id) !== wanted) continue;",
  "      if (scene.name !== null && scene.name !== undefined && String(scene.name) !== '') {",
  "        name = String(scene.name);",
  "      } else {",
  "        name = wanted;",
  "      }",
  "    }",
  "    if (name === '') return '-';",
  "    return (role === 'next' ? 'Next: ' : 'Now: ') + name;",
  "  }",
  "",
  "  function el(tag, className, text) {",
  "    var node = document.createElement(tag);",
  "    if (className) node.className = className;",
  "    if (text !== undefined) node.textContent = text;",
  "    return node;",
  "  }",
  "",
  "  // The controls the bar takes over, in the order it shows them. Each one is a",
  "  // node the page already has, so moving it keeps the page's delegated click",
  "  // handler and every render that paints it.",
  "  function controlNodes(page) {",
  "    var nodes = [];",
  "    var acts = ['play', 'stop', 'pause', 'record'];",
  "    for (var i = 0; i < acts.length; i += 1) {",
  "      nodes.push(page.querySelector('[data-act=' + acts[i] + ']'));",
  "    }",
  "    nodes.push(page.querySelector('label.st-bpm') || page.querySelector('[data-role=bpm]'));",
  "    nodes.push(page.querySelector('[data-role=position]'));",
  "    nodes.push(page.querySelector('[data-role=rec-status]'));",
  "    // The context's own latency reading belongs beside the recording status:",
  "    // it is a fact about this device's audio, not about the song.",
  "    nodes.push(page.querySelector('[data-role=output-latency]'));",
  "    nodes.push(page.querySelector('[data-act=metronome]'));",
  "    nodes.push(page.querySelector('[data-role=output-bar]'));",
  "    return nodes;",
  "  }",
  "",
  "  function mount(page, hooks, options) {",
  "    var control = { refresh: function () {}, destroy: function () {} };",
  "    if (!page || typeof page.querySelector !== 'function') return control;",
  "    hooks = hooks || {};",
  "    options = options || {};",
  "    var studio = page.classList && page.classList.contains('studio')",
  "      ? page : page.querySelector('.studio');",
  "    var host = studio || page;",
  "    var bar = page.querySelector('[data-role=transport-bar]');",
  "    var created = false;",
  "    if (!bar) {",
  "      bar = el('div', 'st-transport-bar');",
  "      bar.setAttribute('data-role', 'transport-bar');",
  "      bar.setAttribute('role', 'toolbar');",
  "      bar.setAttribute('aria-label', 'Transport');",
  "      host.appendChild(bar);",
  "      created = true;",
  "    }",
  "    var now = bar.querySelector('[data-role=scene-now]');",
  "    if (!now) {",
  "      now = el('span', 'st-scene st-scene-now');",
  "      bar.appendChild(now);",
  "    }",
  "    var next = bar.querySelector('[data-role=scene-next]');",
  "    if (!next) {",
  "      next = el('span', 'st-scene st-scene-next');",
  "      bar.appendChild(next);",
  "    }",
  "    var moved = [];",
  "    var nodes = controlNodes(page);",
  "    for (var i = 0; i < nodes.length; i += 1) {",
  "      var node = nodes[i];",
  "      if (!node || node.parentNode === bar) continue;",
  "      moved.push({ node: node, parent: node.parentNode, next: node.nextSibling });",
  "      bar.appendChild(node);",
  "    }",
  "    var play = page.querySelector('[data-act=play]');",
  "    var pause = page.querySelector('[data-act=pause]');",
  "    var record = page.querySelector('[data-act=record]');",
  "    var outputBar = page.querySelector('[data-role=output-bar]');",
  "    // A picker hidden by this bar (a phone) and a pause this bar disabled (a",
  "    // take running) are undone only by the same owner: a state the client set",
  "    // for its own reason is never overwritten from here.",
  "    var outputHidden = false;",
  "    var pauseDisabled = false;",
  "    // The width-class queries this bar watches, so the output picker follows a",
  "    // rotate or a resize even when the page renders nothing.",
  "    var media = [];",
  "",
  "    function sizeClass() {",
  "      var value = options.sizeClass;",
  "      if (typeof value === 'function') {",
  "        try { value = value(); } catch (err) { value = ''; }",
  "      }",
  "      return typeof value === 'string' ? value : '';",
  "    }",
  "",
  "    function hook(name) {",
  "      if (typeof hooks[name] !== 'function') return null;",
  "      try { return hooks[name](); } catch (err) { return null; }",
  "    }",
  "",
  "    function applySize() {",
  "      if (!outputBar) return;",
  "      if (sizeClass() === 'phone') {",
  "        outputBar.hidden = true;",
  "        outputHidden = true;",
  "      } else if (outputHidden) {",
  "        outputBar.hidden = false;",
  "        outputHidden = false;",
  "      }",
  "    }",
  "",
  "    // The two breakpoints the page lays out for. A phone rotated into a tablet",
  "    // moves the picker without anything being rendered, so the bar listens to",
  "    // them itself and re-applies; a page without matchMedia keeps the class the",
  "    // last refresh reported.",
  "    function watchMedia() {",
  "      if (typeof window.matchMedia !== 'function') return;",
  "      var queries = [];",
  "      try {",
  "        queries.push(window.matchMedia('(min-width: 640px)'));",
  "        queries.push(window.matchMedia('(min-width: 1024px)'));",
  "      } catch (err) {",
  "        return;",
  "      }",
  "      for (var i = 0; i < queries.length; i += 1) {",
  "        var query = queries[i];",
  "        if (!query) continue;",
  "        var handler = function () { applySize(); };",
  "        if (typeof query.addEventListener === 'function') {",
  "          query.addEventListener('change', handler);",
  "        } else if (typeof query.addListener === 'function') {",
  "          query.addListener(handler);",
  "        } else {",
  "          continue;",
  "        }",
  "        media.push({ query: query, handler: handler });",
  "      }",
  "    }",
  "",
  "    function measure() {",
  "      var height = 0;",
  "      if (typeof bar.getBoundingClientRect === 'function') {",
  "        height = bar.getBoundingClientRect().height || 0;",
  "      }",
  "      if (!height) height = bar.offsetHeight || 0;",
  "      if (host.style && typeof host.style.setProperty === 'function') {",
  "        host.style.setProperty('--st-transport-h', String(Math.round(height)) + 'px');",
  "      }",
  "    }",
  "",
  "    function refresh() {",
  "      applySize();",
  "      var snap = hook('snapshot');",
  "      now.textContent = sceneLabel(snap, hook('currentSceneId'));",
  "      next.textContent = sceneLabel(snap, hook('queuedSceneId'), 'next');",
  "      var paused = hook('isPaused') === true;",
  "      var recording = hook('isRecording') === true;",
  "      if (play) play.setAttribute('aria-pressed', hook('isPlaying') === true ? 'true' : 'false');",
  "      if (pause) {",
  "        pause.setAttribute('aria-pressed', paused ? 'true' : 'false');",
  "        if (recording) {",
  "          pause.disabled = true;",
  "          pauseDisabled = true;",
  "        } else if (pauseDisabled) {",
  "          pause.disabled = false;",
  "          pauseDisabled = false;",
  "        }",
  "      }",
  "      if (record) record.setAttribute('aria-pressed', recording ? 'true' : 'false');",
  "      measure();",
  "    }",
  "",
  "    var observer = null;",
  "    if (typeof ResizeObserver === 'function') {",
  "      observer = new ResizeObserver(function () { measure(); });",
  "      observer.observe(bar);",
  "    }",
  "    refresh();",
  "",
  "    watchMedia();",
  "",
  "    function destroy() {",
  "      if (observer) { try { observer.disconnect(); } catch (err) { /* gone */ } }",
  "      for (var m = 0; m < media.length; m += 1) {",
  "        var watched = media[m];",
  "        try {",
  "          if (typeof watched.query.removeEventListener === 'function') watched.query.removeEventListener('change', watched.handler);",
  "          else if (typeof watched.query.removeListener === 'function') watched.query.removeListener(watched.handler);",
  "        } catch (err) { /* gone */ }",
  "      }",
  "      media = [];",
  "      for (var i = moved.length - 1; i >= 0; i -= 1) {",
  "        var entry = moved[i];",
  "        if (!entry.parent) continue;",
  "        try {",
  "          var before = entry.next && entry.next.parentNode === entry.parent ? entry.next : null;",
  "          entry.parent.insertBefore(entry.node, before);",
  "        } catch (err) { /* the page is going away */ }",
  "      }",
  "      if (created && bar.parentNode) bar.parentNode.removeChild(bar);",
  "      if (host.style && typeof host.style.removeProperty === 'function') {",
  "        try { host.style.removeProperty('--st-transport-h'); } catch (err) { /* nothing to undo */ }",
  "      }",
  "    }",
  "",
  "    control.refresh = refresh;",
  "    control.destroy = destroy;",
  "    return control;",
  "  }",
  "",
  "  window.StudioTransport = {",
  "    mount: mount,",
  "    sceneLabel: sceneLabel,",
  "    nextQueued: nextQueued",
  "  };",
  "})();",
].join("\n");

/**
 * The transport bar's styles.
 *
 * The bar is one fixed layer that ENDS on the player bar and the shell's tabs,
 * so it never covers either: its bottom is their two heights added up. The
 * `.studio` element reserves the bar's own measured height, so nothing at the
 * end of the page hides behind it, and the toast clears the player bar, the
 * shell's tabs and the bar itself. Every control the bar carries is at least
 * 44 px, and a press on one is a press, never a text selection.
 *
 * The rules belong after the page's own style block: they adjust the toast and
 * the page's bottom padding, and the last rule for a selector is the one that
 * counts.
 *
 * @type {string}
 */
export const TRANSPORT_CSS = [
  '/* The page ends above the transport bar, whatever the bar measures. */',
  '.studio { padding-bottom: var(--st-transport-h, 0px); }',
  '/* The bar ends on the player bar and the shell tabs, never over them. */',
  '.studio .st-transport-bar {',
  '  position: fixed; left: 0; right: 0;',
  '  bottom: calc(var(--crow-player-h, 0px) + var(--shell-tabs-h, 0px));',
  '  z-index: 1050;',
  '  display: flex; flex-wrap: wrap; align-items: center; gap: 8px;',
  '  padding: 6px 12px; background: var(--st-head, #1B1E22);',
  '  border-top: 1px solid var(--st-line, #2C3036);',
  '  font-family: Inter, system-ui, sans-serif;',
  '  user-select: none; -webkit-user-select: none; -webkit-touch-callout: none;',
  '}',
  '/* Every control the bar carries is a 44 px target. */',
  '.studio .st-transport-bar button,',
  '.studio .st-transport-bar [role=button] { min-width: 44px; min-height: 44px; }',
  '.studio .st-transport-bar .st-bpm input { min-height: 44px; }',
  '/* A control the bar itself hid stays hidden, whatever the page set before. */',
  '.studio .st-transport-bar [hidden] { display: none; }',
  '/* The scene readout: what plays now, and what waits for the next bar. */',
  '.studio .st-transport-bar .st-scene {',
  '  font-size: 12px; line-height: 1.4; color: var(--st-muted, #A9A59C);',
  '  white-space: nowrap;',
  '}',
  '.studio .st-transport-bar .st-scene-next { color: var(--st-text, #E9E6DF); }',
  '/* The toast is the highest layer of the page and it sits above the bar, and',
  '   above the player bar and the shell tabs the bar itself ends on. */',
  '.studio .st-toast { bottom: calc(var(--crow-player-h, 0px) + var(--shell-tabs-h, 0px) + var(--st-transport-h, 0px) + 24px); }',
].join("\n");

/**
 * The transport bar's helpers, evaluated from the very string the page inlines.
 *
 * `new Function` with a `window` parameter means the script's one global lands
 * on the object this module keeps, and never on Node's `globalThis`.
 */
const transportApi = new Function(
  "window",
  `${TRANSPORT_SCRIPT}\nreturn window.StudioTransport;`,
)({});

/**
 * One line of the bar's scene readout.
 * @param {object|null} snap - a song snapshot with its `scenes`
 * @param {string|null|undefined} sceneId - the scene the hook named
 * @param {string} [role] - "next" for the queued line; anything else is "now"
 * @returns {string} "Now: Verse", "Next: Chorus", or "-"
 */
export function sceneLabel(snap, sceneId, role) {
  return transportApi.sceneLabel(snap, sceneId, role);
}

/**
 * The scene a launch has queued for the next bar, moved by one event.
 * @param {string|null|undefined} queued - the scene waiting, if any
 * @param {{type: string, scene_id?: string}|null} event - a launch, a stop or a
 *   launch report
 * @returns {string|null} the scene now waiting
 */
export function nextQueued(queued, event) {
  return transportApi.nextQueued(queued, event);
}