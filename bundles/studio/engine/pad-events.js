/**
 * Studio pad events — the ring the audio thread fills and the page drains.
 *
 * A pad's light has to land on the frame the operator HEARS, so the engine tells
 * the page what it started instead of the page asking: every pad trigger the
 * processor accepts — a pattern step, a live press from the panel, a controller
 * press — pushes one record here from the voice's own start (`startPad`), and
 * `studio-processor.js` posts the block's whole ring once, at the end of the
 * block, as `{type:"pad_events", events:[…]}`.
 *
 * A note rides the same ring: a step's note and one the page's keyboard sends
 * (`pushNote`) are recorded with the frame the note stands on, so a page can
 * paint a key on the frame the note is heard rather than on the block that
 * carried the event.
 *
 * ## Why a ring and not an array
 *
 * The push happens inside `process()`, where an allocation is a dropout waiting
 * to happen, so the records are allocated ONCE, in `create()`, and reused: a
 * push overwrites one record in place and creates no object at all. Records
 * older than the last `RING_SIZE` triggers are dropped when more than that many
 * start in one block (the oldest go first), which keeps the newest hits — the
 * ones a light could still reach — and bounds what one post carries.
 *
 * The one array a post needs is built by `drain()`: it copies the standing
 * records into plain objects and empties the ring, so a structured clone has
 * exactly the shape the page reads. Draining is the CLIENT's side of the
 * boundary (it runs after the block rendered), never the render loop's.
 *
 * ## What a record says
 *
 * `{frame, track_id, bank_id, index, kind, v?, state?}` or, for a note,
 * `{frame, track_id, kind: "note", p, on}`.
 *
 * - `frame` is the CONTEXT frame the voice starts on, in the very clock
 *   `launched`, `next_bar` and a `position` report use, so a light is timed
 *   against the audible hit (output latency included) and not against the block
 *   the message happened to arrive in. A note's frame is its own frame in that
 *   same clock: a step's own frame, and the block's first frame for a live
 *   press.
 * - `kind` is `"hit"` (a voice started; `v` is its EFFECTIVE velocity, 1..127 —
 *   the one the voice's own gain was worked out from) or `"state"` (the pad's
 *   stored state changed; `state` is that code, one of `STATE_OFF`,
 *   `STATE_ON`, `STATE_LOOP` or `STATE_HELD`) or `"note"` (a note started or
 *   ended on a track; `p` is its MIDI pitch and `on` says which, so a page can
 *   paint a key for the frame the note stands on).
 *
 * It is a classic script (no `import`/`export`): it assigns
 * `globalThis.StudioPadEvents` for the worklet scope and `module.exports` when a
 * CommonJS `module` exists. `engine/package.json` marks that directory
 * `"commonjs"`, so a Node `require()` of this file works inside the bundle's
 * ESM tree; `engine-client.js` also concatenates it into the worklet module (a
 * worklet cannot import), which is why it must not depend on anything.
 */
(function () {
  "use strict";

  /** How many triggers one block's post can carry: the ring holds this many. */
  const RING_SIZE = 256;

  /** The kinds a record can hold, as the numbers `push` is given. */
  const KIND_HIT = 0;
  const KIND_STATE = 1;
  const KIND_NOTE = 2;

  /**
   * A pad's state, as the processor scans it out of its voices: off, sounding,
   * looping or held. The order is the priority a pad with more than one voice
   * resolves by — the highest one wins — so a held pad never reads as merely
   * sounding while its held voice is there.
   */
  const STATE_OFF = 0;
  const STATE_ON = 1;
  const STATE_LOOP = 2;
  const STATE_HELD = 3;

  /**
   * The kind a code stands for: a state or a note is kept, and anything else is
   * a hit, so a caller that passes nothing still says something the page can
   * draw.
   * @param {number} code
   * @returns {number}
   */
  function kindOf(code) {
    if (code === KIND_STATE) return KIND_STATE;
    if (code === KIND_NOTE) return KIND_NOTE;
    return KIND_HIT;
  }

  /** @returns {number} a value as a whole number, 0 when it is not one. */
  function whole(value) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.trunc(number) : 0;
  }

  /**
   * One ring: `RING_SIZE` fixed records, a read cursor and a count.
   *
   * The records are the ring's own and are never replaced, so a steady pattern
   * of triggers allocates nothing on the audio thread. `records` is exposed so a
   * test can see that (its identities never move); nothing else reads it.
   * @returns {{records: object[], push: function(...): void,
   *            drain: function(): object[], size: function(): number,
   *            clear: function(): void}}
   */
  function create() {
    const records = new Array(RING_SIZE);
    for (let at = 0; at < RING_SIZE; at += 1) {
      records[at] = {
        frame: 0,
        trackId: "",
        bankId: "",
        index: 0,
        kind: KIND_HIT,
        v: 0,
        state: 0,
        p: 0,
        on: false,
      };
    }
    /** The oldest standing record's slot. */
    let start = 0;
    /** How many records stand, from that slot on. */
    let count = 0;

    /**
     * The slot the next record takes, dropping the OLDEST one when the ring is
     * full, so a block that records more events than the ring holds keeps the
     * newest ones. No object is made: the slot's own record is refilled.
     * @returns {object} the record to fill
     */
    function nextRecord() {
      if (count === RING_SIZE) start = (start + 1) % RING_SIZE;
      else count += 1;
      // The write slot: the end of the standing records, which on a full ring is
      // the slot just released by dropping the oldest one.
      return records[(start + count - 1) % RING_SIZE];
    }

    /**
     * Record one pad event, in place.
     * @param {number} frame the context frame the voice starts on
     * @param {string} trackId
     * @param {string} bankId
     * @param {number} index the pad (the voice's `light_index`, once chromatic
     *   pads move it off the pad's own index)
     * @param {number} kindCode `KIND_HIT` or `KIND_STATE`
     * @param {number} v the effective velocity, 1..127 (0 for a state)
     * @param {number} stateCode the pad's state, one of the `STATE_*` codes (0
     *   for a hit)
     * @returns {void}
     */
    function push(frame, trackId, bankId, index, kindCode, v, stateCode) {
      const record = nextRecord();
      record.frame = whole(frame);
      record.trackId = typeof trackId === "string" ? trackId : "";
      record.bankId = typeof bankId === "string" ? bankId : "";
      record.index = whole(index);
      record.kind = kindOf(kindCode);
      record.v = whole(v);
      record.state = whole(stateCode);
      record.p = 0;
      record.on = false;
    }

    /**
     * Record one note event: a note a sequencer step or a live press started or
     * ended on a track. Its record carries the pitch and whether the note started
     * or ended, and the frame the note stands on, so a page can paint the key on
     * the frame the note is heard and darken it on the frame it is released.
     * @param {number} frame the context frame the note starts (or ends) on
     * @param {string} trackId
     * @param {number} p the MIDI pitch, 0..127
     * @param {boolean} on whether the note started (true) or ended (false)
     * @returns {void}
     */
    function pushNote(frame, trackId, p, on) {
      const record = nextRecord();
      record.frame = whole(frame);
      record.trackId = typeof trackId === "string" ? trackId : "";
      record.bankId = "";
      record.index = 0;
      record.kind = KIND_NOTE;
      record.v = 0;
      record.state = 0;
      record.p = whole(p);
      record.on = on === true;
    }

    /**
     * The standing records as the objects the page reads, oldest first, and an
     * empty ring afterwards. This is the one place a post allocates.
     * @returns {object[]}
     */
    function drain() {
      const events = [];
      for (let at = 0; at < count; at += 1) {
        const record = records[(start + at) % RING_SIZE];
        if (record.kind === KIND_NOTE) {
          events.push({
            frame: record.frame,
            track_id: record.trackId,
            kind: "note",
            p: record.p,
            on: record.on,
          });
          continue;
        }
        const event = {
          frame: record.frame,
          track_id: record.trackId,
          bank_id: record.bankId,
          index: record.index,
          kind: record.kind === KIND_STATE ? "state" : "hit",
        };
        if (record.kind === KIND_STATE) event.state = record.state;
        else event.v = record.v;
        events.push(event);
      }
      start = 0;
      count = 0;
      return events;
    }

    /** @returns {number} how many records stand (0 when there is nothing to post). */
    function size() {
      return count;
    }

    /**
     * Drop every standing record without building anything, for a page that
     * stopped listening: what waited was never drawn, and a page that comes back
     * must not see hits it never heard.
     * @returns {void}
     */
    function clear() {
      start = 0;
      count = 0;
    }

    return {
      records: records,
      push: push,
      pushNote: pushNote,
      drain: drain,
      size: size,
      clear: clear,
    };
  }

  const api = {
    create: create,
    RING_SIZE: RING_SIZE,
    KIND_HIT: KIND_HIT,
    KIND_STATE: KIND_STATE,
    KIND_NOTE: KIND_NOTE,
    STATE_OFF: STATE_OFF,
    STATE_ON: STATE_ON,
    STATE_LOOP: STATE_LOOP,
    STATE_HELD: STATE_HELD,
  };

  if (typeof globalThis !== "undefined") globalThis.StudioPadEvents = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();