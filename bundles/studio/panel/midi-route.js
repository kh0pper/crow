/**
 * The ONE MIDI routing rule, shared by the server and the page.
 *
 * Which live mapping answers an incoming message is a single rule, and a rule
 * written twice drifts: the hub would route one thing and the page another, and
 * the allow-list would mean two different things. So the rule lives here, in
 * dependency-free plain JavaScript, and both sides run the very same text:
 *
 *   - `MIDI_ROUTE_SCRIPT` is a classic script (an IIFE that assigns one global,
 *     `window.StudioMidiRoute`). It is emitted into the page before the client
 *     (see `panel/studio.js`), so the page routes through it.
 *   - the named exports below are produced by evaluating THAT SAME string in
 *     Node with `new Function`, so `server/commands/midi.js` routes through
 *     exactly the bytes the page runs.
 *
 * The text obeys the panel's inline-script rules — no backtick, no `${`, no
 * double quote, no backslash — because it is inlined verbatim in the page's one
 * `<script>`.
 *
 * ## The rule it holds
 *
 * A mapping answers a message only when it is LIVE: `proposed` is exactly
 * `false` AND its `action` still deep-equals its `accepted_action`, so a
 * proposal never routes and neither does a mapping whose action moved on after
 * the operator said yes. The router is the last gate before an action runs, so
 * whatever a document holds — an old one, a hand-synced one — the action must
 * also pass `validRoutedAction`: the allow-list and its per-kind arguments,
 * exactly the arguments `MIDI_ACTIONS` in `server/commands/midi.js` accepts —
 * and the pairing has to make sense too: `acceptsMessageType` says which kinds
 * of message an action can be driven by (a pedal that sends a program change
 * cannot hold a held effect), and it is the same table `midi.map` refuses on
 * and Learn waits for.
 *
 * Every mapping then matches its own message, except `keys.play`: a keys row
 * claims EVERY note on its channel (that is what lets one row drive a keyboard),
 * so it answers the notes no mapping names — and a `pad.play` mapping for that
 * note always wins, which is how a pad-based controller's pads still play the
 * pads their notes name while the keys play the rest. Only a `note` row is a
 * keys row, whatever the document holds.
 *
 * The answer names the mapping by the `id` the mapping itself carries (that is
 * the row the page lights), and the action comes back as a copy, so a caller can
 * never reach into the document through it.
 *
 * @type {string}
 */
export const MIDI_ROUTE_SCRIPT = [
  "(function () {",
  "  'use strict';",
  "",
  "  // The id shape of everything inside a song: 1-40 letters, digits, dashes or",
  "  // underscores (the same pattern the document's commands hold ids to).",
  "  var SONG_ID = /^[A-Za-z0-9_-]{1,40}$/;",
  "",
  "  // The pad fields a pad.param control may sweep, in the plan's order: the pad",
  "  // settings that hold a number. A note, a filter type or a switch is not a",
  "  // value a control sweeps between a minimum and a maximum.",
  "  var PAD_PARAM_FIELDS = [",
  "    'pitch', 'gain_db', 'cutoff_hz', 'resonance', 'attack_ms',",
  "    'decay_ms', 'sustain', 'release_ms', 'pan'",
  "  ];",
  "",
  "  // The performance effects a pedal or a knob may hold.",
  "  var FX_HOLD_NAMES = ['filter_sweep', 'lofi', 'stutter', 'tape_stop', 'reverb_throw'];",
  "",
  "  // What each action can be driven by: the message types a mapping of that",
  "  // kind may hold, and the sentence a mismatch is refused with. This is the",
  "  // ONE table Learn, midi.map and the router all read: a program change has no",
  "  // release, so it cannot hold an effect or play a pad, and only a control",
  "  // change carries a value.",
  "  var MESSAGE_RULES = {",
  "    'scene.launch': {",
  "      types: ['note', 'cc', 'pc'],",
  "      needs: 'Launching a scene takes a note, a CC or a program change.'",
  "    },",
  "    'clip.launch': {",
  "      types: ['note', 'cc', 'pc'],",
  "      needs: 'Launching a clip takes a note, a CC or a program change.'",
  "    },",
  "    'transport.play': {",
  "      types: ['note', 'cc', 'pc'],",
  "      needs: 'Play takes a note, a CC or a program change.'",
  "    },",
  "    'transport.stop': {",
  "      types: ['note', 'cc', 'pc'],",
  "      needs: 'Stop takes a note, a CC or a program change.'",
  "    },",
  "    'record.toggle': {",
  "      types: ['note', 'cc', 'pc'],",
  "      needs: 'Record takes a note, a CC or a program change.'",
  "    },",
  "    'stop_all': {",
  "      types: ['note', 'cc', 'pc'],",
  "      needs: 'Stop everything takes a note, a CC or a program change.'",
  "    },",
  "    'looper.cycle': {",
  "      types: ['note', 'cc', 'pc'],",
  "      needs: 'The looper takes a note, a CC or a program change.'",
  "    },",
  "    'looper.to_pad': {",
  "      types: ['note', 'cc', 'pc'],",
  "      needs: 'Loop to pad takes a note, a CC or a program change.'",
  "    },",
  "    'pad.play': {",
  "      types: ['note', 'cc'],",
  "      needs: 'Playing a pad needs a note or a CC; a program change has no release.'",
  "    },",
  "    'fx.hold': {",
  "      types: ['note', 'cc'],",
  "      needs: 'A held effect needs a pedal or pad that sends a note or a CC; a program change has no release.'",
  "    },",
  "    'pad.param': {",
  "      types: ['cc'],",
  "      needs: 'Sweeping a pad field needs a control change (CC); a note or a program change carries no value.'",
  "    },",
  "    'mix.gain': {",
  "      types: ['cc'],",
  "      needs: 'Riding a level needs a control change (CC); a note or a program change carries no value.'",
  "    },",
  "    'macro.set': {",
  "      types: ['cc'],",
  "      needs: 'Turning a macro knob needs a control change (CC); a note or a program change carries no value.'",
  "    },",
  "    'track.macro': {",
  "      types: ['cc'],",
  "      needs: 'Turning a macro knob needs a control change (CC); a note or a program change carries no value.'",
  "    },",
  "    'keys.play': {",
  "      types: ['note'],",
  "      needs: 'The keys send notes, so a keys mapping needs a note; a CC or a program change is not a key.'",
  "    }",
  "  };",
  "",
  "  // The rule for one action kind, or null for a kind that is not allow-listed.",
  "  function messageRule(kind) {",
  "    return hasOwn(MESSAGE_RULES, kind) ? MESSAGE_RULES[kind] : null;",
  "  }",
  "",
  "  // Whether a mapping of this kind may hold this message type.",
  "  function acceptsMessageType(kind, type) {",
  "    var rule = messageRule(kind);",
  "    if (!rule) return false;",
  "    return rule.types.indexOf(String(type)) >= 0;",
  "  }",
  "",
  "  // What one kind needs, in the sentence a refusal and a toast both use.",
  "  function messageNeedsText(kind) {",
  "    var rule = messageRule(kind);",
  "    return rule ? rule.needs : 'That is not an action a message can run.';",
  "  }",
  "",
  "  function hasOwn(object, key) {",
  "    return Object.prototype.hasOwnProperty.call(object, key);",
  "  }",
  "",
  "  function isOneOf(list, value) {",
  "    if (typeof value !== 'string') return false;",
  "    return list.indexOf(value) >= 0;",
  "  }",
  "",
  "  function isSongId(value) {",
  "    return typeof value === 'string' && SONG_ID.test(value);",
  "  }",
  "",
  "  // A number inside a field's own range, whole (a pad, a knob, a channel).",
  "  function isWholeInRange(value, high) {",
  "    if (typeof value !== 'number') return false;",
  "    if (!isFinite(value) || Math.floor(value) !== value) return false;",
  "    return value >= 0 && value <= high;",
  "  }",
  "",
  "  function isFiniteNumber(value) {",
  "    return typeof value === 'number' && isFinite(value);",
  "  }",
  "",
  "  // Exactly these keys and no others: an action is held to its own schema's",
  "  // arguments, so a field the document added on its own is not part of it.",
  "  function exactKeys(action, names) {",
  "    var keys = Object.keys(action);",
  "    if (keys.length !== names.length) return false;",
  "    for (var i = 0; i < names.length; i += 1) {",
  "      if (!hasOwn(action, names[i])) return false;",
  "    }",
  "    return true;",
  "  }",
  "",
  "  // The allow-list, one branch per kind, each holding exactly what the kind's",
  "  // own schema accepts (see MIDI_ACTIONS in server/commands/midi.js). A kind",
  "  // that is not named here — a command that edits the song, a people-only or",
  "  // Studio-only command, an inherited object name like toString — is not a",
  "  // live action and can never be routed.",
  "  function validRoutedAction(action) {",
  "    if (!action || typeof action !== 'object' || Array.isArray(action)) return false;",
  "    var kind = action.kind;",
  "    if (typeof kind !== 'string' || kind === '') return false;",
  "    switch (kind) {",
  "      case 'scene.launch':",
  "        return exactKeys(action, ['kind', 'scene_id']) && isSongId(action.scene_id);",
  "      case 'clip.launch':",
  "        return exactKeys(action, ['kind', 'clip_id']) && isSongId(action.clip_id);",
  "      case 'transport.play':",
  "      case 'transport.stop':",
  "      case 'record.toggle':",
  "      case 'stop_all':",
  "      case 'looper.cycle':",
  "      case 'keys.play':",
  "        return exactKeys(action, ['kind']);",
  "      case 'pad.play':",
  "      case 'looper.to_pad':",
  "        return exactKeys(action, ['kind', 'track_id', 'bank_id', 'index'])",
  "          && isSongId(action.track_id)",
  "          && isSongId(action.bank_id)",
  "          && isWholeInRange(action.index, 15);",
  "      case 'pad.param':",
  "        if (!exactKeys(action, ['kind', 'track_id', 'param', 'min', 'max'])) return false;",
  "        if (!isSongId(action.track_id)) return false;",
  "        if (!isOneOf(PAD_PARAM_FIELDS, action.param)) return false;",
  "        if (!isFiniteNumber(action.min) || !isFiniteNumber(action.max)) return false;",
  "        return action.min <= action.max;",
  "      case 'track.macro':",
  "        return exactKeys(action, ['kind', 'track_id', 'index'])",
  "          && isSongId(action.track_id)",
  "          && isWholeInRange(action.index, 7);",
  "      case 'macro.set':",
  "        return exactKeys(action, ['kind', 'index']) && isWholeInRange(action.index, 7);",
  "      case 'fx.hold':",
  "        return exactKeys(action, ['kind', 'name']) && isOneOf(FX_HOLD_NAMES, action.name);",
  "      case 'mix.gain':",
  "        return exactKeys(action, ['kind', 'track_id']) && isSongId(action.track_id);",
  "      default:",
  "        return false;",
  "    }",
  "  }",
  "",
  "  // Two JSON values, deep: the comparison the operator's yes is bound to.",
  "  function sameValue(left, right) {",
  "    if (left === right) return true;",
  "    if (left === null || right === null) return false;",
  "    if (typeof left !== 'object' || typeof right !== 'object') return false;",
  "    if (Array.isArray(left) !== Array.isArray(right)) return false;",
  "    var leftKeys = Object.keys(left);",
  "    var rightKeys = Object.keys(right);",
  "    if (leftKeys.length !== rightKeys.length) return false;",
  "    for (var i = 0; i < leftKeys.length; i += 1) {",
  "      var key = leftKeys[i];",
  "      if (!hasOwn(right, key)) return false;",
  "      if (!sameValue(left[key], right[key])) return false;",
  "    }",
  "    return true;",
  "  }",
  "",
  "  // An incoming message as this rule compares them, or null for what no",
  "  // mapping can name (a device with no name, a channel outside 1-16, a number",
  "  // outside 0-127, a type Studio has no action for).",
  "  function normalizeIncoming(message) {",
  "    if (!message || typeof message !== 'object') return null;",
  "    var deviceName = message.device_name;",
  "    var type = message.type;",
  "    var channel = Number(message.channel);",
  "    var number = Number(message.number);",
  "    if (typeof deviceName !== 'string' || deviceName === '') return null;",
  "    if (type !== 'note' && type !== 'cc' && type !== 'pc') return null;",
  "    if (!Number.isInteger(channel) || channel < 1 || channel > 16) return null;",
  "    if (!Number.isInteger(number) || number < 0 || number > 127) return null;",
  "    return { device_name: deviceName, type: type, channel: channel, number: number };",
  "  }",
  "",
  "  function copyAction(action) {",
  "    return JSON.parse(JSON.stringify(action));",
  "  }",
  "",
  "  // Which live mapping answers one message, and a copy of what it runs.",
  "  function routeFor(snap, message) {",
  "    var wanted = normalizeIncoming(message);",
  "    if (!wanted) return null;",
  "    var maps = snap && typeof snap === 'object' && snap.midi_maps",
  "      && typeof snap.midi_maps === 'object' ? snap.midi_maps : {};",
  "    var other = null;",
  "    var keys = null;",
  "    for (var key in maps) {",
  "      if (!hasOwn(maps, key)) continue;",
  "      var mapping = maps[key];",
  "      if (!mapping || typeof mapping !== 'object') continue;",
  "      if (mapping.proposed !== false) continue;",
  "      if (!sameValue(mapping.action, mapping.accepted_action)) continue;",
  "      if (!validRoutedAction(mapping.action)) continue;",
  "      if (!acceptsMessageType(mapping.action.kind, wanted.type)) continue;",
  "      if (mapping.device_name !== wanted.device_name) continue;",
  "      var stored = mapping.message;",
  "      if (!stored || typeof stored !== 'object') continue;",
  "      if (stored.type !== wanted.type) continue;",
  "      if (Number(stored.channel) !== wanted.channel) continue;",
  "      var answer = { id: mapping.id, action: copyAction(mapping.action) };",
  "      if (mapping.action.kind === 'keys.play') {",
  "        if (stored.type === 'note' && keys === null) keys = answer;",
  "        continue;",
  "      }",
  "      if (Number(stored.number) !== wanted.number) continue;",
  "      if (mapping.action.kind === 'pad.play') return answer;",
  "      if (other === null) other = answer;",
  "    }",
  "    return other || keys;",
  "  }",
  "",
  "  window.StudioMidiRoute = {",
  "    routeFor: routeFor,",
  "    validRoutedAction: validRoutedAction,",
  "    acceptsMessageType: acceptsMessageType,",
  "    messageNeedsText: messageNeedsText",
  "  };",
  "})();",
].join("\n");

/**
 * The routing rule, evaluated from the very string the page inlines.
 *
 * `new Function` with a `window` parameter means the script's one global lands
 * on the object this module keeps, and never on Node's `globalThis`.
 */
const routeApi = new Function(
  "window",
  `${MIDI_ROUTE_SCRIPT}\nreturn window.StudioMidiRoute;`,
)({});

/**
 * Which live mapping answers one message: the server's half of the one rule.
 * @param {object} snap - a song snapshot
 * @param {{device_name: string, type: string, channel: number, number: number}} message
 * @returns {{id: string, action: object}|null} the mapping and a copy of its
 *   action, or null when nothing live answers
 */
export function routeFor(snap, message) {
  return routeApi.routeFor(snap, message);
}

/**
 * Whether an action is on the allow-list and carries exactly its kind's
 * arguments: the gate a mapping's action has to pass before it can be routed.
 * @param {any} action - the `{kind, ...args}` a document holds
 * @returns {boolean}
 */
export function validRoutedAction(action) {
  return routeApi.validRoutedAction(action);
}

/**
 * Whether a mapping of one action kind may hold one message type: the ONE rule
 * `midi.map` refuses on, Learn waits for, and the router gates on.
 * @param {string} kind - an action kind
 * @param {string} type - "note", "cc" or "pc"
 * @returns {boolean}
 */
export function acceptsMessageType(kind, type) {
  return routeApi.acceptsMessageType(kind, type);
}

/**
 * What an action kind's message needs, in the one sentence a refusal and a
 * Learn toast both use.
 * @param {string} kind - an action kind
 * @returns {string}
 */
export function messageNeedsText(kind) {
  return routeApi.messageNeedsText(kind);
}