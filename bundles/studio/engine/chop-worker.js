/**
 * Studio chop worker — `engine/chop.js` off the page's main thread.
 *
 * Chopping a loop means a Fourier transform per 256 samples of a whole sample,
 * which is far too much work to do on the thread that also draws the waveform
 * and runs the transport. The panel hands the job to this worker when a browser
 * has one, and falls back to calling `StudioChop` inline when it does not.
 *
 * Classic worker script: `importScripts` pulls in `chop.js` from the same asset
 * directory, so the detection a browser runs is the very same file the Node
 * tests and any Node-side caller use (the parity rule).
 *
 * Messages:
 *
 *   in   `{id, op: "hits", channels: Float32Array[], rate, options}` — the
 *        channels' buffers in the transfer list; `options` is `chop.js`'s,
 *        `{sensitivity, minGapMs}`;
 *        `{id, op: "grid", frames, divisions}` — cut into equal pieces;
 *   out  `{id, slices: [{start_frame, end_frame}]}`, or `{id, error}` when the
 *        chop failed (a refusal from `chop.js`, such as an unknown division,
 *        carries its own message).
 *
 * The id is the caller's own, so several chops can be in flight.
 */
importScripts("chop.js");

self.onmessage = function (event) {
  "use strict";
  var message = event && event.data ? event.data : {};
  var id = message.id;

  function fail(error) {
    var text = error && error.message ? String(error.message) : String(error);
    self.postMessage({ id: id, error: text });
  }

  try {
    var op = message.op;
    var slices;
    if (op === "hits") {
      var channels = Array.isArray(message.channels) ? message.channels : [];
      slices = StudioChop.byHits(channels, Number(message.rate), message.options || {});
    } else if (op === "grid") {
      slices = StudioChop.byGrid(Number(message.frames), Number(message.divisions));
    } else {
      throw new Error('a chop needs an op of "hits" or "grid"');
    }
    self.postMessage({ id: id, slices: slices });
  } catch (error) {
    fail(error);
  }
};