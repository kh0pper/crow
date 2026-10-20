/**
 * Bot Builder — what Crow can do by voice (PR 1: Crow's voice card and editor).
 *
 * Every voice surface answers as the reserved voice bot (crow.voice), so the
 * old per-bot "Answers voice on: …" line and the "Use for voice…" dialog are
 * gone. What stays is one line on Crow's card and in its editor, "By voice
 * on displays: …", filled from ONE read of the Kiosk listing
 * (GET /api/kiosk/admin/displays → voice.abilities) per render, never polled.
 * That listing is the Kiosk panel's own, decided by the voice turn's own
 * classifier (servers/gateway/voice/voice-abilities.js); reading it starts no
 * model (tests/voice-assess-no-acquire.test.js). Nothing here writes.
 *
 * The server decides whether the Kiosk is there at all (kioskAvailable); the
 * client still treats a non-JSON, redirected or failed listing, or one with
 * no voice object, as "nothing to say" and keeps the line hidden.
 *
 * Strings reach the script as a JSON block, never interpolated into it.
 * The script is a template literal: never put a backtick or a dollar-brace inside.
 */
import { escapeHtml } from "../../shared/components.js";
import { t } from "../../shared/i18n.js";

const STRING_KEYS = {
  abilBy: "botbuilder.abilBy",
  abilNone: "botbuilder.abilNone",
  abilBySlowOnly: "botbuilder.abilBySlowOnly",
  abilSlowGroup: "botbuilder.abilSlowGroup",
  abilMore: "botbuilder.abilMore",
  abilcalendar: "botbuilder.abilCalendar",
  abilreminders: "botbuilder.abilReminders",
  abilmessages: "botbuilder.abilMessages",
  abilcrow_messages: "botbuilder.abilCrowMessages",
  abillists: "botbuilder.abilLists",
  abilmemory: "botbuilder.abilMemory",
  abilprojects: "botbuilder.abilProjects",
  abilblog: "botbuilder.abilBlog",
  abilnews: "botbuilder.abilNews",
  abilfiles: "botbuilder.abilFiles",
};

/**
 * "By voice on displays: …" for the voice bot, hidden until the listing fills
 * it (the listing's voice.bot_id must match); an older Kiosk without the field
 * leaves it hidden.
 */
export function abilityLineHtml(botId) {
  return `<p class="btb-abil" data-abil-bot="${escapeHtml(String(botId))}" hidden></p>`;
}

export function voiceAbilityScript(lang) {
  const S = {};
  for (const [k, key] of Object.entries(STRING_KEYS)) S[k] = t(key, lang);
  const json = JSON.stringify(S).replace(/</g, "\\u003c");
  return `<script type="application/json" id="btb-abil-s">${json}</script>` + `<script>${CLIENT}</script>`;
}

const CLIENT = `(function(){
  var S = {};
  try { S = JSON.parse(document.getElementById('btb-abil-s').textContent) || {}; } catch (e) { S = {}; }
  window.__btbVoiceAbil = true;
  load();

  function fill(s, o){ return String(s).replace(/\\{(\\w+)\\}/g, function(m, k){ return Object.prototype.hasOwnProperty.call(o, k) ? String(o[k]) : m; }); }
  function each(list, fn){ for (var i = 0; i < list.length; i++) fn(list[i], i); }

  /** Read the Kiosk listing once for this render. Never throws. */
  function load(){
    var p;
    try { p = fetch('/api/kiosk/admin/displays', { credentials: 'same-origin', headers: { Accept: 'application/json' } }); }
    catch (e) { p = Promise.reject(e); }
    return Promise.resolve(p).then(function(res){
      var ct = res && res.headers && res.headers.get ? String(res.headers.get('content-type') || '') : '';
      if (!res || !res.ok || res.redirected || ct.indexOf('application/json') < 0) return null;
      return res.json();
    }).then(function(j){ paint(j && j.voice && typeof j.voice === 'object' ? j.voice : null); })
      .catch(function(){ paint(null); });
  }

  function paint(v){
    each(document.querySelectorAll('.btb-abil[data-abil-bot]'), function(line){
      paintAbil(line, v && v.bot_id === line.getAttribute('data-abil-bot') ? v : null);
    });
  }

  /** One ability's words: a known id from the strings, an add-on by its manifest name (text, never markup); else none. */
  function abilWord(x){
    if (!x || typeof x.id !== 'string') return null;
    if (x.id.indexOf('addon:') === 0) return typeof x.label === 'string' && x.label ? x.label.slice(0, 60) : null;
    return /^[a-z_]{1,32}$/.test(x.id) && Object.prototype.hasOwnProperty.call(S, 'abil' + x.id) ? S['abil' + x.id] : null;
  }
  /** "By voice on displays: …" (memories off: a card is not one display). No field → hidden. */
  function paintAbil(line, v){
    var a = v ? v.abilities : null;
    line.removeAttribute('title');
    if (!a || !Array.isArray(a.items)) { line.textContent = ''; line.hidden = true; return; }
    var quick = [], slow = [];
    each(a.items, function(x){ var w = abilWord(x); if (w) (x.quick === false ? slow : quick).push(w); });
    if (!quick.length && !slow.length) line.textContent = S.abilNone;
    else {
      line.textContent = abilLineText(quick, slow, 4);
      if (quick.length + slow.length > 4) line.setAttribute('title', abilLineText(quick, slow, Infinity));
    }
    line.hidden = false;
  }
  /** The quick words, then the slower ones as one group at the tail; at most cap words in all, then "+N more". */
  function abilLineText(quick, slow, cap){
    var q = quick.slice(0, cap), w = slow.slice(0, Math.max(0, cap - q.length));
    var more = quick.length + slow.length - q.length - w.length;
    var tail = more > 0 ? ', ' + fill(S.abilMore, { n: more }) : '';
    if (!q.length) return fill(S.abilBySlowOnly, { list: w.join(', ') + tail });
    return fill(S.abilBy, { list: q.join(', ') + (w.length ? ' · ' + fill(S.abilSlowGroup, { list: w.join(', ') }) : '') + tail });
  }
})();`;
