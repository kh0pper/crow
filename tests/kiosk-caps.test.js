import { test } from "node:test";
import assert from "node:assert/strict";
import { effectiveCaps, guessProfile, PROFILES, PAGE_KINDS, DEFAULT_PROFILE } from "../bundles/kiosk/server/caps.js";

const V2 = { v: 2, screen: { w: 800, h: 480, touch: true }, audio: { out: true, in: true }, codecs: [], frames: 0, max_windows: 4, input: { wake: false, keyboard: false }, kinds: ["card", "timer"] };

test("profiles: the four of the design, pi3 audio-first", () => {
  assert.deepEqual(Object.keys(PROFILES), ["pi3", "phone", "tablet", "desktop"]);
  assert.deepEqual(PROFILES.pi3, { video: "none", youtube: "no", frames: 1, max_windows: 4 });
  assert.deepEqual(PROFILES.desktop, { video: "hd", youtube: "yes", frames: 3, max_windows: 6 });
});

test("a K1 page (caps v1, or none) keeps today's behaviour exactly", () => {
  for (const raw of [null, {}, { windows: ["timer", "recipe", "content"] }]) {
    const c = effectiveCaps(raw, undefined);
    assert.deepEqual([c.v, c.windows, c.max_windows, c.iframe, c.video, c.youtube, c.frames], [2, ["timer", "recipe", "content"], 4, false, "none", "no", 0]);
  }
  assert.deepEqual(effectiveCaps({ windows: ["timer"], max_windows: 2 }, "phone").windows, ["timer"]);
  assert.equal(effectiveCaps({ windows: ["timer"], max_windows: 2 }, "phone").max_windows, 2);
});

test("caps v2: effective caps are the lesser of the profile and what the page can draw", () => {
  const c = effectiveCaps(V2, "desktop");
  assert.deepEqual(c.kinds, ["card", "timer"]);
  assert.deepEqual(c.windows, ["timer", "recipe", "content"]);
  assert.equal(c.video, "none", "a page that cannot draw a media window has no video, whatever the profile says");
  assert.equal(c.youtube, "no");
  assert.equal(c.max_windows, 4, "the window store holds four (per-display limits come later)");
  assert.deepEqual(c.screen, { w: 800, h: 480, touch: true });
  const withMedia = effectiveCaps({ ...V2, kinds: ["card", "timer", "media", "app"], frames: 4 }, "pi3");
  assert.deepEqual([withMedia.video, withMedia.youtube, withMedia.frames], ["none", "no", 1], "the profile cannot be exceeded by the page");
  assert.deepEqual([effectiveCaps({ ...V2, kinds: ["card", "media", "app"], frames: 4 }, "tablet").video, effectiveCaps({ ...V2, kinds: ["card", "media", "app"], frames: 4 }, "tablet").frames], ["hd", 2]);
});

test("caps are data from a browser: junk is dropped, the wake-over-media result is never taken from the page", () => {
  const c = effectiveCaps({ v: 2, kinds: ["card", "bogus", 7, "timer", "timer"], screen: { w: "wide", h: -5, touch: "yes" }, max_windows: 99, input: { wake: "1", wake_over_media: "ok" }, frames: -3 }, "nonsense");
  assert.deepEqual(c.kinds, ["card", "timer"]);
  assert.deepEqual(c.screen, { w: 0, h: 0, touch: true });
  assert.equal(c.max_windows, 4);
  assert.deepEqual(c.input, { wake: false, keyboard: false, wake_over_media: "untested" });
  assert.ok(PAGE_KINDS.includes("nowplaying"));
  assert.deepEqual(effectiveCaps({ v: 2, kinds: [] }, "phone").windows, [], "a page that draws nothing is offered no card tool");
});

test("no profile set, or an unknown one: the audio-first profile — a display never gets video because nobody said what it is", () => {
  assert.equal(DEFAULT_PROFILE, "pi3");
  const page = { ...V2, kinds: ["card", "timer", "media", "app"], frames: 4 };
  for (const name of [undefined, null, "", "nonsense", "tv"]) assert.deepEqual([effectiveCaps(page, name).video, effectiveCaps(page, name).youtube], ["none", "no"], String(name));
  assert.equal(effectiveCaps(page, "phone").video, "hd", "a profile someone chose is honoured");
});

test("the pairing guess: a phone says it is mobile; a small ARM Linux screen is the Pi; a coarse pointer on a larger screen is a tablet; a K1 page gives no guess", () => {
  const v2 = (o) => ({ v: 2, screen: { w: 800, h: 480, touch: true }, kinds: ["card", "timer"], ...o });
  assert.equal(guessProfile(v2({ mobile: true, platform: "Linux aarch64", screen: { w: 412, h: 915, touch: true } })), "phone");
  assert.equal(guessProfile(v2({ mobile: false, pointer: "coarse", platform: "Linux aarch64" })), "pi3");
  assert.equal(guessProfile(v2({ mobile: false, pointer: "coarse", platform: "Linux armv7l" })), "pi3");
  assert.equal(guessProfile(v2({ mobile: false, pointer: "coarse", platform: "MacIntel", screen: { w: 1024, h: 1366, touch: true } })), "tablet");
  assert.equal(guessProfile(v2({ mobile: false, pointer: "fine", platform: "Win32", screen: { w: 1920, h: 1080, touch: false } })), "desktop");
  assert.equal(guessProfile({ windows: ["timer"] }), null);
  assert.equal(guessProfile(null), null);
});
