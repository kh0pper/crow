/**
 * Studio resampling worker — `engine/resample.js` off the page's main thread.
 *
 * A take recorded at 44.1 kHz played into a 48 kHz context has to be converted
 * before the engine can play it, and a long take is a lot of samples: doing
 * that on the main thread freezes the panel (no transport updates, no history).
 * So `engine-client.js` hands the conversion to this worker when a browser has
 * one, and falls back to converting inline when it does not.
 *
 * Classic worker script: `importScripts` pulls in `resample.js` from the same
 * asset directory, so the arithmetic is the very same file the worklet and a
 * Node render use (the parity rule).
 *
 * Messages:
 *
 *   in   `{id, channels: Float32Array[], from: number, to: number}`, with the
 *        channels' buffers in the transfer list;
 *   out  `{id, channels: Float32Array[]}` with the converted buffers
 *        transferred, or `{id, error}` when the conversion failed.
 *
 * The id is the caller's own, so several conversions can be in flight.
 */
importScripts("resample.js");

self.onmessage = function (event) {
  "use strict";
  var message = event && event.data ? event.data : {};
  var id = message.id;

  function fail(error) {
    var text = error && error.message ? String(error.message) : String(error);
    self.postMessage({ id: id, error: text });
  }

  try {
    var channels = Array.isArray(message.channels) ? message.channels : [];
    var from = Number(message.from);
    var to = Number(message.to);
    if (!(from > 0) || !(to > 0)) throw new Error("a resampling needs both rates");
    var converted = StudioResample.toRate(channels, from, to);
    var transfer = [];
    for (var index = 0; index < converted.length; index += 1) {
      var channel = converted[index];
      if (channel && channel.buffer instanceof ArrayBuffer && transfer.indexOf(channel.buffer) === -1) {
        transfer.push(channel.buffer);
      }
    }
    self.postMessage({ id: id, channels: converted }, transfer);
  } catch (error) {
    fail(error);
  }
};