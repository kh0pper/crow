// Perch composer dictation, the client half (perch-hub/dictation.js,
// dictation-css.js and the html.js / client.js hooks): static shape, CSS
// rules and the pure helpers, extracted with new Function as
// perch-hub-client.test.js and perch-phone-card.test.js do. The real-browser
// behaviour is in perch-dictation-live.test.js; the server in
// perch-dictation-route.test.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import { perchHubJs } from "../servers/gateway/dashboard/perch-hub/client.js";
import { perchDictationJs } from "../servers/gateway/dashboard/perch-hub/dictation.js";
import { perchDictationCss } from "../servers/gateway/dashboard/perch-hub/dictation-css.js";
import { perchHubContent } from "../servers/gateway/dashboard/perch-hub/html.js";
import { translations } from "../servers/gateway/dashboard/shared/i18n.js";

function maskComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, " "));
}
function extract(src, name, extra = "") {
  const start = src.indexOf("function " + name + "(");
  assert.ok(start > -1, name + " is not in the snippet");
  const masked = maskComments(src);
  let depth = 0, end = -1;
  for (let i = masked.indexOf("{", start); i < masked.length; i++) {
    if (masked[i] === "{") depth++;
    else if (masked[i] === "}") { depth--; if (!depth) { end = i; break; } }
  }
  return new Function(extra + src.slice(start, end + 1) + "; return " + name + ";")();
}
const JS = perchDictationJs("en");
const fn = (name) => extract(JS, name);

const KEYS = ["perch.dictate", "perch.dictationCancel", "perch.dictationDone", "perch.dictationSend",
  "perch.dictationStarting", "perch.dictationRecording", "perch.dictationTranscribing", "perch.dictationRetry",
  "perch.dictationVia", "perch.dictationEmpty", "perch.dictationBlocked", "perch.dictationNoMic",
  "perch.dictationBusy", "perch.dictationProfileChanged", "perch.dictationTooMany", "perch.dictationTooLong",
  "perch.dictationTimeout", "perch.dictationFailed"];

// ---------------------------------------------------------------------------
// i18n
// ---------------------------------------------------------------------------

test("every dictation string exists in en and es, with the plan's wording", () => {
  for (const k of KEYS) {
    assert.ok(translations[k], k + " missing");
    assert.ok(translations[k].en && translations[k].es, k + " needs en and es");
  }
  assert.equal(translations["perch.dictate"].en, "Dictate");
  assert.equal(translations["perch.dictate"].es, "Dictar");
  assert.equal(translations["perch.dictationDone"].es, "Listo");
  assert.match(translations["perch.dictationVia"].en, /\{provider\}/);
  assert.match(translations["perch.dictationVia"].es, /\{provider\}/);
  assert.notEqual(translations["perch.dictationDone"].en, translations["perch.abort"].en,
    "the record control must not reuse \"Stop\", which already stops the bot");
});

// ---------------------------------------------------------------------------
// markup
// ---------------------------------------------------------------------------

function composer(lang) {
  const html = perchHubContent(lang);
  const s = html.indexOf('<div id="perch-composer"');
  const e = html.indexOf("</section>", s);
  return html.slice(s, e);
}

test("markup: the mic is a hidden type=button in the send row, before Send, with a visible 'Dictate'", () => {
  for (const [lang, word] of [["en", "Dictate"], ["es", "Dictar"]]) {
    const c = composer(lang);
    const m = c.match(/<button[^>]*id="perch-dictate"[^>]*>[\s\S]*?<\/button>/);
    assert.ok(m, "mic button");
    assert.match(m[0], /type="button"/);
    assert.match(m[0], /\shidden[\s>]/, "shipped hidden: the client shows it only once everything checks out");
    assert.ok(m[0].includes(">" + word + "<"), "visible word, not an icon-only control: " + m[0]);
    const row = c.slice(c.indexOf('class="send-row"'), c.indexOf("</div>", c.indexOf('class="send-row"')));
    assert.ok(row.indexOf('id="perch-dictate"') > -1 && row.indexOf('id="perch-dictate"') < row.indexOf('id="perch-send"'),
      "in .send-row, before Send");
  }
});

test("markup: the bar ships hidden, holds four type=button controls with accessible names, and a live region without the timer", () => {
  for (const lang of ["en", "es"]) {
    const c = composer(lang);
    const bs = c.indexOf('<div id="perch-dictation-bar"');
    assert.ok(bs > -1, "the bar is inside #perch-composer");
    const bar = c.slice(bs, c.indexOf('<div id="perch-dictation-hint"'));
    assert.match(bar.slice(0, 80), /\shidden[\s>]/, "shipped hidden");
    const buttons = bar.match(/<button[^>]*>/g) || [];
    assert.equal(buttons.length, 4);
    for (const b of buttons) assert.match(b, /type="button"/);
    for (const [id, key] of [["perch-dict-cancel", "perch.dictationCancel"], ["perch-dict-done", "perch.dictationDone"],
      ["perch-dict-send", "perch.dictationSend"]]) {
      const tag = buttons.find((b) => b.includes(`id="${id}"`));
      assert.ok(tag, id);
      const word = translations[key][lang];
      assert.ok(tag.includes(`aria-label="${word}"`) && tag.includes(`title="${word}"`), id + " needs aria-label + title = the word");
    }
    assert.ok(buttons.some((b) => b.includes('id="perch-dict-retry"')));
    const live = bar.match(/<span[^>]*aria-live="polite"[^>]*>[\s\S]*?<\/span>/);
    assert.ok(live, "a polite live region for the status");
    assert.equal(live[0].includes("perch-dict-time"), false, "the m:ss timer must sit outside the live region");
    assert.ok(bar.includes('id="perch-dict-time"'));
  }
});

test("markup: the cloud hint line exists, ships hidden, and is not a live region", () => {
  const c = composer("en");
  const m = c.match(/<div id="perch-dictation-hint"[^>]*>/);
  assert.ok(m);
  assert.match(m[0], /\shidden[\s>]/);
  assert.equal(/aria-live/.test(m[0]), false);
});

test("markup: the dictation stylesheet is in the page and passed through scaleFontSizes", () => {
  const html = perchHubContent("en");
  assert.ok(html.includes(perchDictationCss()), "appended to the <style>");
  assert.match(perchDictationCss(), /calc\(\d+(\.\d+)?px \* var\(--pts,1\)\)/);
  assert.equal(/font-size:\s*\d+px/.test(perchDictationCss()), false, "no raw px font size escaped scaling");
});

// ---------------------------------------------------------------------------
// CSS
// ---------------------------------------------------------------------------

test("css: [hidden] re-asserted for the bar, the mic, the hint and the retry button", () => {
  const css = perchDictationCss();
  assert.match(css, /#perch-dictation-bar\[hidden\]\{display:none\}/);
  assert.match(css, /#perch-hub-root #perch-dictate\[hidden\]\{display:none\}/);
  assert.match(css, /#perch-dictation-hint\[hidden\]\{display:none\}/);
  assert.match(css, /#perch-hub-root #perch-dict-retry\[hidden\][^{]*\{display:none\}/);
});

test("css: touch targets are at least 44px", () => {
  const css = perchDictationCss();
  const rule = css.match(/#perch-hub-root \.dict-btn\{[^}]*\}/);
  assert.ok(rule);
  assert.match(rule[0], /min-width:44px/);
  assert.match(rule[0], /min-height:44px/);
  assert.match(css.match(/#perch-hub-root #perch-dictate\{[^}]*\}/)[0], /min-height:44px/);
});

test("css: under 600px the bar's words hide (icons + accessible names), the mic keeps its word", () => {
  const css = perchDictationCss();
  const block = css.slice(css.indexOf("@media (max-width:599px)"));
  assert.ok(block.length > 20);
  assert.match(block, /#perch-dictation-bar \.dict-word\{display:none\}/);
  assert.equal(/perch-dictate[^{]*\{[^}]*display:none/.test(block), false, "the mic's word stays at every width");
});

test("css: the timer warns in --err (text-safe), never --attn", () => {
  const css = perchDictationCss();
  assert.match(css, /\.dict-time\.late\{[^}]*color:var\(--err\)/);
  assert.equal(css.includes("--attn"), false);
});

test("css: the send row wraps (Send/Steer on the trailing edge) only once the mic is there", () => {
  const css = perchDictationCss();
  assert.match(css, /#perch-composer\.has-dictate \.send-row\{[^}]*flex-wrap:wrap/);
  assert.match(css, /#perch-composer\.has-dictate #perch-send\{[^}]*margin-inline-start:auto/);
});

test("css: while dictating, the bar replaces the textarea and the send row", () => {
  const css = perchDictationCss();
  for (const s of ["starting", "recording", "transcribing", "error"]) {
    assert.ok(css.includes(`#perch-composer[data-dictation="${s}"]>#perch-input`), s + " hides the textarea");
    assert.ok(css.includes(`#perch-composer[data-dictation="${s}"]>.send-row`), s + " hides the send row");
  }
});

// ---------------------------------------------------------------------------
// the emitted script
// ---------------------------------------------------------------------------

test("the snippet is spliced into the hub script and never breaks the template literal", () => {
  for (const lang of ["en", "es"]) {
    const js = perchDictationJs(lang);
    assert.equal(js.includes("`"), false, "no backtick");
    assert.equal(js.includes("${"), false, "no dollar-brace");
    assert.ok(perchHubJs(lang).includes(js), "spliced verbatim");
    assert.doesNotThrow(() => new Function(perchHubJs(lang)), lang + " parses");
    assert.ok(!/\.innerHTML\s*\+?=|insertAdjacentHTML\s*\(/.test(js), "createElement/textContent only");
  }
});

test("hooks: resetControls and HUB.retire cancel dictation; the visibility listener is bound once", () => {
  const js = perchHubJs("en");
  const reset = js.slice(js.indexOf("function resetControls(){"), js.indexOf("function controlBody("));
  assert.match(reset, /dictationCancel\(\);/);
  assert.match(reset, /dictationProbe\(\);/, "each session open re-probes");
  const retire = js.slice(js.indexOf("HUB.retire=function(){"), js.indexOf("HUB.handlers=HUB.handlers"));
  assert.match(retire, /dictationCancel\(\);/);
  assert.match(JS, /bindOnce\(document,'visibilitychange','dictationHide',/);
  assert.equal((JS.match(/addEventListener\(/g) || []).length, 0, "no raw document/window listener: bindOnce only");
});

test("the late-transcript identity guard is the file's own idiom", () => {
  assert.match(JS, /if\(current\.sid!==mySid\)\{ dictationCancel\(\); return; \}/);
});

test("the upload carries the CSRF header and the profile tag, and goes to the dictation route", () => {
  assert.match(JS, /'X-Crow-Csrf':csrf\(\)/);
  assert.match(JS, /'X-Crow-Dictation-Profile':/);
  assert.match(JS, /API\+'\/dictation'/);
});

test("getUserMedia asks for AEC off, noise suppression + AGC on, mono", () => {
  assert.match(JS, /echoCancellation:false/);
  assert.match(JS, /noiseSuppression:true/);
  assert.match(JS, /autoGainControl:true/);
  assert.match(JS, /channelCount:1/);
});

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

test("pickMimeType walks webm → ogg → mp4 → '' (browser default)", () => {
  const pick = fn("pickMimeType");
  assert.equal(pick(() => true), "audio/webm;codecs=opus");
  assert.equal(pick((t) => t !== "audio/webm;codecs=opus"), "audio/ogg;codecs=opus");
  assert.equal(pick((t) => t === "audio/mp4"), "audio/mp4");
  assert.equal(pick(() => false), "");
  assert.equal(pick(null), "");
});

test("uploadType: blob.type, else the recorder's mimeType (the default-mime rung)", () => {
  const u = fn("uploadType");
  assert.equal(u({ type: "audio/webm;codecs=opus" }, { mimeType: "audio/ogg" }), "audio/webm;codecs=opus");
  assert.equal(u({ type: "" }, { mimeType: "audio/mp4" }), "audio/mp4");
  assert.equal(u(null, null), "");
});

test("capSeconds: the probe's max, but at most 90 s on the mp4 rung", () => {
  const c = fn("capSeconds");
  assert.equal(c(120, "audio/webm;codecs=opus"), 120);
  assert.equal(c(60, "audio/webm"), 60);
  assert.equal(c(120, "audio/mp4"), 90);
  assert.equal(c(60, "audio/mp4;codecs=mp4a"), 60);
  assert.equal(c(undefined, "audio/webm"), 60);
});

test("mergeTranscript appends after existing text with one space", () => {
  const m = fn("mergeTranscript");
  assert.equal(m("", "hello"), "hello");
  assert.equal(m("Please", "  check the queue "), "Please check the queue");
  assert.equal(m("Please   ", "check"), "Please check");
  assert.equal(m("line one\n", "two"), "line one\ntwo");
  assert.equal(m("keep", ""), "keep");
});

test("formatElapsed renders m:ss", () => {
  const f = fn("formatElapsed");
  assert.equal(f(0), "0:00");
  assert.equal(f(1999), "0:01");
  assert.equal(f(61_000), "1:01");
  assert.equal(f(120_000), "2:00");
  assert.equal(f(-5), "0:00");
});

test("dictationSupported: secure context, mediaDevices, MediaRecorder, and a permissions policy that allows the mic", () => {
  const ok = fn("dictationSupported");
  const win = (o = {}) => ({ isSecureContext: true, MediaRecorder: function () {},
    navigator: { mediaDevices: { getUserMedia() {} } }, ...o });
  const doc = (allows) => ({ permissionsPolicy: { allowsFeature: (f) => (f === "microphone" ? allows : true) } });
  assert.equal(ok(win(), {}), true);
  assert.equal(ok(win(), doc(true)), true);
  assert.equal(ok(win({ isSecureContext: false }), {}), false, "plain-http LAN access");
  assert.equal(ok(win({ MediaRecorder: undefined }), {}), false);
  assert.equal(ok(win({ navigator: {} }), {}), false);
  assert.equal(ok(win({ navigator: undefined }), {}), false);
  assert.equal(ok(win(), doc(false)), false, "a frame without allow=microphone");
  assert.equal(ok(win(), { featurePolicy: { allowsFeature: () => false } }), false);
  assert.equal(ok(null, null), false);
});

test("errorKeyFor covers every row of the errors table", () => {
  const e = fn("errorKeyFor");
  assert.equal(e(0, "NotAllowedError"), "blocked");
  assert.equal(e(0, "SecurityError"), "blocked");
  assert.equal(e(0, "NotFoundError"), "noMic");
  assert.equal(e(409, "dictation_busy"), "busy");
  assert.equal(e(409, "profile_changed"), "profileChanged");
  assert.equal(e(429, "too_many"), "tooMany");
  assert.equal(e(413, "too_large"), "tooLong");
  assert.equal(e(504, "stt_timeout"), "timeout");
  assert.equal(e(503, "unreachable"), "failed");
  assert.equal(e(502, "stt_failed"), "failed");
  assert.equal(e(0, null), "failed");
  assert.equal(e(200, "empty"), "empty");
});

test("every error key has its translated message", () => {
  for (const k of ["blocked", "noMic", "busy", "profileChanged", "tooMany", "tooLong", "timeout", "failed", "empty"]) {
    assert.match(JS, new RegExp(k + ":DICT_"), k);
  }
});

test("nextState: the recorder's state machine", () => {
  const n = fn("nextState");
  assert.equal(n("idle", "start"), "starting");
  assert.equal(n("starting", "granted"), "recording");
  assert.equal(n("recording", "stop"), "transcribing");
  assert.equal(n("recording", "cap"), "transcribing", "auto-stop at the cap behaves like Done");
  assert.equal(n("transcribing", "done"), "idle");
  assert.equal(n("transcribing", "fail"), "error");
  assert.equal(n("starting", "fail"), "error");
  assert.equal(n("error", "retry"), "transcribing");
  for (const s of ["idle", "starting", "recording", "transcribing", "error"]) assert.equal(n(s, "cancel"), "idle", "✕ from " + s);
  assert.equal(n("starting", "hide"), "idle", "hide while starting cancels quietly (the app's permission prompt)");
  assert.equal(n("recording", "hide"), "transcribing", "hide while recording stops and transcribes");
  assert.equal(n("idle", "hide"), "idle");
  assert.equal(n("transcribing", "hide"), "transcribing");
  assert.equal(n("starting", "start"), "starting", "double tap ignored");
  assert.equal(n("recording", "start"), "recording");
  assert.equal(n("transcribing", "start"), "transcribing");
  assert.equal(n("idle", "stop"), "idle");
});
