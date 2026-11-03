/**
 * The standalone staged-draft page (spec §12.1; plan Task 4): `/dashboard/staged/:id`.
 *
 * A draft a bot made from the Gmail, Discord or job path has no Perch chat to draw a card in, so the
 * notification opens here. It renders the SAME card the Perch chat draws — the same fields, the same
 * words, the same classes — built server-side from one row (`getStagedItem`, the shape the chat's
 * list returns), and the buttons post to the SAME routes the chat uses
 * (`/dashboard/perch-api/staged/:id/{send,edit,discard}`), so there is one send path and one set of
 * refusals.
 *
 * Rails, copied from routes/voice-handoffs.js (the sibling small page):
 *   - OWNER ONLY. A session minted by a paired peer's sign-in, a session minted by a login on this
 *     machine, or a signed peer call gets a page that says "Only the owner can see this draft" and
 *     carries NO row data at all (the row is not read before the check).
 *   - `no-store`, never framed: the page carries a Send.
 *   - The row is never in a log line: failures log the class only.
 *
 * The markup never carries a credential reference, a token path or a raw provider payload — only
 * the five snapshot fields the operator was shown, which is the point of the page.
 */
import { Router } from "express";
import { createDbClient } from "../../db.js";
import { getStagedItem } from "../staged/send-service.js";
import { isLocalPasswordSessionOn } from "../dashboard/local-session.js";
import { escapeHtml } from "../dashboard/shared/components.js";
import { t, SUPPORTED_LANGS } from "../dashboard/shared/i18n.js";
import { parseCookies } from "../dashboard/auth.js";
import { readSetting } from "../dashboard/settings/registry.js";

export const STAGED_PAGE_PREFIX = "/dashboard/staged";
/** A staged row's id (store.createStaged: "ss-" + 16 hex). */
export const STAGED_ID_RE = /^ss-[0-9a-f]{16}$/;
/** A Gmail draft id may reach a URL only if it is exactly this (the client checks the same). */
export const DRAFT_ID_RE = /^[A-Za-z0-9_-]{1,200}$/;

/** Never framed, never cached. */
function guardHeaders(req, res, next) {
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
}

/** The page's language: the dashboard setting, else the login pages' cookie, else "en". */
async function pageLang(db, req) {
  let lang = null;
  try { lang = await readSetting(db, "language"); } catch { /* no settings table: the cookie decides */ }
  if (!SUPPORTED_LANGS.includes(lang)) lang = parseCookies(req).crow_lang;
  return SUPPORTED_LANGS.includes(lang) ? lang : "en";
}

const CSS = `
:root { --bg:#f7f6f3; --card:#fff; --sky:#eef1f3; --ink:#22303a; --dim:#5d6d78; --teal:#0e6b62; --line:#dde4e8; --warn:#8a5300; --warn-soft:#fbefd6; }
@media (prefers-color-scheme: dark) { :root { --bg:#161615; --card:#1b242b; --sky:#131a1f; --ink:#e4ebef; --dim:#8fa0ab; --teal:#4fbdb0; --line:#2a353d; --warn:#f0b955; --warn-soft:#3a2d12; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--ink); font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif; }
main { max-width: 34rem; margin: 0 auto; padding: 20px 14px 32px; }
.card { background:var(--sky); border:1px solid var(--line); border-radius:12px; padding:14px; display:grid; gap:8px; min-width:0; }
.title { font-weight:600; font-size:1.05rem; }
.label { font-size:11px; text-transform:uppercase; letter-spacing:.07em; font-weight:700; color:var(--teal); }
.rcpt { display:flex; flex-wrap:wrap; gap:6px; align-items:baseline; min-width:0; }
.addr, .subject, .note, .status { overflow-wrap:anywhere; min-width:0; }
.subject { font-weight:600; }
.new { font-size:11px; color:var(--dim); border:1px solid var(--line); border-radius:6px; padding:0 6px; }
.body { white-space:pre-wrap; overflow-wrap:anywhere; background:var(--card); border:1px solid var(--line); border-radius:8px; padding:10px; }
.yes, .status, .note { font-size:13px; color:var(--dim); }
.note { font-style:italic; }
.taint { font-size:13px; color:var(--warn); background:var(--warn-soft); border-radius:6px; padding:6px 8px; }
.actions { display:flex; flex-wrap:wrap; gap:8px; align-items:center; }
button, .gmail { min-height:44px; padding:10px 14px; font:inherit; border-radius:8px; border:1px solid var(--line); background:var(--card); color:var(--ink); display:inline-flex; align-items:center; justify-content:center; cursor:pointer; text-decoration:none; }
button.primary { background:var(--teal); border-color:var(--teal); color:#fff; }
button:disabled { opacity:.55; cursor:default; }
.form { display:grid; gap:8px; }
.field { display:grid; gap:4px; min-width:0; }
.field input, .field textarea { width:100%; min-width:0; min-height:44px; font-size:16px; padding:10px; border:1px solid var(--line); border-radius:8px; background:var(--card); color:var(--ink); }
.field textarea { min-height:140px; resize:vertical; white-space:pre-wrap; }
[hidden] { display:none !important; }
`;

/** The bracket form of a row's unfilled placeholders: `[Client Name], [Date]`. */
function bracketsOf(item) {
  const placeholders = Array.isArray(item && item.placeholders) ? item.placeholders : [];
  return placeholders.map((p) => "[" + String(p) + "]").join(", ");
}

/** The fixed strings the page's script may need after a click. Server-rendered text carries the
 *  rest; nothing here is derived from the draft except the placeholder names, which are the
 *  operator's own brackets (the script writes them with textContent, never as markup). */
function scriptStrings(lang, item = null) {
  return {
    sending: t("perch.stagedSending", lang),
    sent: t("perch.stagedSent", lang),
    already: t("perch.stagedAlreadySent", lang),
    notOwner: t("perch.stagedNotOwner", lang),
    badAddress: t("perch.stagedBadAddress", lang),
    generic: t("perch.stagedFailedGeneric", lang),
    offline: t("perch.stagedOffline", lang),
    fillFirst: t("perch.stagedFillFirst", lang),
    // The names the "Fill in {list} first" sentence fills, so a refused send names the brackets
    // the server refused instead of showing the raw template.
    fillList: bracketsOf(item),
    changed: t("perch.stagedChanged", lang),
    notEditable: t("perch.stagedNotEditable", lang),
    discarded: t("perch.stagedDiscarded", lang),
    noRecipients: t("perch.stagedNoRecipients", lang),
  };
}

/** The card, server-rendered from the row. Same classes and words as the Perch chat's card. */
function renderCard(item, lang) {
  const snap = item.snapshot && typeof item.snapshot === "object" ? item.snapshot : {};
  const lists = [["to", t("perch.stagedTo", lang)], ["cc", t("perch.stagedCc", lang)], ["bcc", t("perch.stagedBcc", lang)]];
  const fresh = new Set((Array.isArray(item.newRecipients) ? item.newRecipients : []).map((a) => String(a).toLowerCase()));
  const addrs = [];
  let recipients = "";
  const rows = lists.map(([key, label]) => {
    const list = Array.isArray(snap[key]) ? snap[key] : [];
    return list.map((addr) => {
      addrs.push(String(addr));
      return `<div class="rcpt"><span class="label">${escapeHtml(label)}</span><span class="addr">${escapeHtml(String(addr))}</span>` +
        (fresh.has(String(addr).toLowerCase()) ? `<span class="new">${escapeHtml(t("perch.stagedNew", lang))}</span>` : "") + "</div>";
    }).join("");
  }).join("");
  recipients = addrs.length ? addrs.join(", ") : t("perch.stagedNoRecipients", lang);

  const state = String(item.state || "staged");
  const listOf = (key) => (Array.isArray(snap[key]) ? snap[key] : []);
  const placeholders = Array.isArray(item.placeholders) ? item.placeholders : [];
  const blocked = placeholders.length > 0;
  const brackets = bracketsOf(item);
  const fillLine = t("perch.stagedFillFirst", lang).split("{list}").join(brackets);

  let status = "";
  let actions = "";
  if (state === "sent") status = t("perch.stagedAlreadySent", lang);
  else if (state === "replaced") status = t("perch.stagedReplaced", lang);
  else if (state === "discarded") status = t("perch.stagedDiscarded", lang);
  else if (state === "sending") status = t("perch.stagedSending", lang);
  else if (state === "failed") status = escapeHtml(String(item.failReason || t("perch.stagedFailedGeneric", lang)));

  if (state === "staged" || state === "failed") {
    if (blocked) status = (status ? status + " " : "") + escapeHtml(fillLine);
    const buttons = [];
    if (item.sendable) {
      const label = state === "failed" ? t("perch.stagedRetry", lang) : t("perch.stagedSend", lang);
      buttons.push(`<button type="button" class="primary" data-act="send"${blocked ? " disabled" : ""}>${escapeHtml(label)}</button>`);
      buttons.push(`<button type="button" data-act="edit">${escapeHtml(t("perch.stagedEdit", lang))}</button>`);
    } else {
      const draftId = item.providerDraftId;
      if (typeof draftId === "string" && DRAFT_ID_RE.test(draftId)) {
        buttons.push(`<a class="gmail" rel="noopener nofollow" target="_blank" href="https://mail.google.com/mail/#drafts?compose=${draftId}">${escapeHtml(t("perch.stagedOpenGmail", lang))}</a>`);
      } else {
        buttons.push(`<span class="note">${escapeHtml(t("perch.stagedNoGmailLink", lang))}</span>`);
      }
    }
    buttons.push(`<button type="button" data-act="discard">${escapeHtml(t("perch.stagedNotNow", lang))}</button>`);
    actions = `<div class="actions">${buttons.join("")}</div>`;
  }

  const form = (state === "staged" || state === "failed") && item.sendable
    ? `<div class="form" id="staged-form" hidden>
  <div class="field"><label class="label" for="f-to">${escapeHtml(t("perch.stagedTo", lang))}</label><input type="text" id="f-to" spellcheck="false" value="${escapeHtml(listOf("to").join(", "))}"></div>
  <div class="field"><label class="label" for="f-cc">${escapeHtml(t("perch.stagedCc", lang))}</label><input type="text" id="f-cc" spellcheck="false" value="${escapeHtml(listOf("cc").join(", "))}"></div>
  <div class="field"><label class="label" for="f-bcc">${escapeHtml(t("perch.stagedBcc", lang))}</label><input type="text" id="f-bcc" spellcheck="false" value="${escapeHtml(listOf("bcc").join(", "))}"></div>
  <div class="field"><label class="label" for="f-subject">${escapeHtml(t("perch.stagedSubject", lang))}</label><input type="text" id="f-subject" value="${escapeHtml(String(snap.subject == null ? "" : snap.subject))}"></div>
  <div class="field"><label class="label" for="f-body">${escapeHtml(t("perch.stagedBody", lang))}</label><textarea id="f-body">${escapeHtml(String(snap.body == null ? "" : snap.body))}</textarea></div>
  <div class="actions"><button type="button" class="primary" data-act="save">${escapeHtml(t("perch.stagedSave", lang))}</button><button type="button" data-act="cancel">${escapeHtml(t("perch.stagedCancel", lang))}</button></div>
</div>`
    : "";

  return `<div class="card" id="staged-page" data-id="${escapeHtml(String(item.id))}" data-hash="${escapeHtml(String(item.contentHash || ""))}" data-recipients="${escapeHtml(recipients)}">
<div class="title">${escapeHtml(t("perch.stagedTitle", lang))}</div>
${rows || `<div class="rcpt"><span class="label">${escapeHtml(t("perch.stagedTo", lang))}</span><span class="addr">${escapeHtml(t("perch.stagedNoRecipients", lang))}</span></div>`}
<div class="label">${escapeHtml(t("perch.stagedSubject", lang))}</div>
<div class="subject">${escapeHtml(snap.subject ? String(snap.subject) : t("perch.stagedNoSubject", lang))}</div>
<div class="label">${escapeHtml(t("perch.stagedBody", lang))}</div>
<div class="body">${escapeHtml(String(snap.body == null ? "" : snap.body))}</div>
<div class="yes">${escapeHtml(t("perch.stagedYes", lang))}</div>
${item.tainted ? `<div class="taint">${escapeHtml(t("perch.stagedTainted", lang))}</div>` : ""}
<div class="status" id="staged-status" role="status">${status}</div>
${actions}
${form}
</div>`;
}

/** The page's own script: the same three actions the chat's card posts, against the same routes. */
function renderScript(lang, item = null) {
  // Inside an inline <script>: "<" never appears raw, so no text can close the tag.
  const s = JSON.stringify(scriptStrings(lang, item)).replace(/</g, "\\u003c");
  return `<script>
(function(){
  var S=${s};
  var root=document.getElementById('staged-page');
  if(!root) return;
  var id=root.getAttribute('data-id'), hash=root.getAttribute('data-hash');
  var csrf='';
  var m=document.cookie.match(/(?:^|; )crow_csrf=([^;]*)/);
  if(m) csrf=decodeURIComponent(m[1]);
  function api(method,path,body){
    var opts={method:method,headers:{'X-Crow-Csrf':csrf}};
    if(body!==undefined){ opts.headers['Content-Type']='application/json'; opts.body=JSON.stringify(body); }
    return fetch('/dashboard/perch-api'+path,opts).then(function(r){
      return r.json().catch(function(){return null;}).then(function(j){ return {ok:r.ok,status:r.status,j:j}; });
    },function(){ return {ok:false,status:0,j:null}; });
  }
  function say(text){ var el=document.getElementById('staged-status'); if(el) el.textContent=text; }
  function fill(tpl,vals){ var out=String(tpl); for(var k in vals) out=out.split('{'+k+'}').join(String(vals[k])); return out; }
  function busy(on){ var b=root.querySelectorAll('button'); for(var i=0;i<b.length;i++) b[i].disabled=on; }
  /* A discarded row has nothing left to press: the actions go, rather than lighting back up as if
     there were still something to do on a draft that is no longer waiting. */
  function dropActions(){
    var a=root.querySelectorAll('.actions');
    for(var i=0;i<a.length;i++){ if(a[i].parentNode) a[i].parentNode.removeChild(a[i]); }
    var f=document.getElementById('staged-form'); if(f) f.hidden=true;
  }
  function splitList(v){ var parts=String(v==null?'':v).split(','), out=[]; for(var i=0;i<parts.length;i++){ var p=parts[i].trim(); if(p) out.push(p); } return out; }
  function go(newId){ if(newId) location.replace('/dashboard/staged/'+encodeURIComponent(newId)); }
  function send(){
    busy(true); say(S.sending);
    api('POST','/staged/'+encodeURIComponent(id)+'/send',{content_hash:hash}).then(function(r){
      var j=r&&r.j;
      if(r&&r.ok&&j&&j.state==='sent'){
        var time=''; try{ time=new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}); }catch(e){}
        say(fill(S.sent,{time:time,recipients:root.getAttribute('data-recipients')||S.noRecipients}));
        dropActions();
        return;
      }
      if(r&&r.ok&&j&&j.state==='failed'){ busy(false); say(j.failReason||S.generic); return; }
      if(r&&r.status===409&&j&&j.error==='changed'){
        if(j.id){ go(j.id); return; }
        /* Changed, but there is no new row to show: say so and put the buttons back for a review. */
        busy(false); say(S.changed); return;
      }
      if(r&&r.status===409&&j&&j.error==='already_sent'){ busy(false); say(S.already); return; }
      if(r&&r.status===403){ busy(false); say(S.notOwner); return; }
      if(r&&r.status===409&&j&&j.error==='placeholders'){ busy(false); say(fill(S.fillFirst,{list:S.fillList})); return; }
      busy(false); say((!r||r.status===0)?S.offline:S.generic);
    });
  }
  function save(){
    function val(fid){ var n=document.getElementById(fid); return n?n.value:''; }
    busy(true);
    api('POST','/staged/'+encodeURIComponent(id)+'/edit',{
      to:splitList(val('f-to')), cc:splitList(val('f-cc')), bcc:splitList(val('f-bcc')),
      subject:String(val('f-subject')), body:String(val('f-body'))
    }).then(function(r){
      var j=r&&r.j;
      if(r&&r.ok&&j&&String(j.code)==='edited'){ if(j.id){ go(j.id); return; } busy(false); say(S.changed); return; }
      busy(false);
      if(r&&r.status===400&&j&&j.error==='bad_address'){ say(S.badAddress); return; }
      if(r&&r.status===409&&j&&j.error==='changed'){ if(j.id){ go(j.id); return; } say(S.changed); return; }
      if(r&&r.status===409&&j&&(j.error==='not_editable'||j.error==='open_in_gmail')){ say(S.notEditable); return; }
      if(r&&r.status===403){ say(S.notOwner); return; }
      say((!r||r.status===0)?S.offline:S.generic);
    });
  }
  function discard(){
    busy(true);
    api('POST','/staged/'+encodeURIComponent(id)+'/discard',{}).then(function(r){
      if(r&&r.ok){ dropActions(); say(S.discarded); return; }
      if(r&&r.status===403){ busy(false); say(S.notOwner); return; }
      if(r&&r.status===409){ dropActions(); say(S.changed); return; }
      busy(false); say((!r||r.status===0)?S.offline:S.generic);
    });
  }
  root.addEventListener('click',function(ev){
    var t=ev.target;
    while(t&&t!==root&&!t.getAttribute('data-act')) t=t.parentNode;
    if(!t||t===root) return;
    var act=t.getAttribute('data-act');
    if(act==='send') send();
    else if(act==='discard') discard();
    else if(act==='save') save();
    else if(act==='edit'||act==='cancel'){
      var f=document.getElementById('staged-form');
      if(f) f.hidden=(act==='edit')?!f.hidden:true;
    }
  });
})();
</script>`;
}

function page(lang, body, title) {
  return `<!doctype html>
<html lang="${escapeHtml(lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)}</title>
<style>${CSS}</style>
</head>
<body><main>${body}</main></body>
</html>`;
}

function refusal(res, code, lang, key) {
  const title = t("perch.stagedTitle", lang);
  res.status(code).type("html").send(page(lang, `<div class="card"><div class="title">${escapeHtml(title)}</div><div class="status">${escapeHtml(t(key, lang))}</div></div>`, title));
}

/**
 * The router. `openDb` mints the request's crow.db client (tests inject one); `ownerCheck` is the
 * owner rule (tests replace it).
 */
export function stagedPageRouter(dashboardAuth, { openDb = () => createDbClient(), ownerCheck = isLocalPasswordSessionOn } = {}) {
  const router = Router();
  router.use(STAGED_PAGE_PREFIX, dashboardAuth);
  router.use(STAGED_PAGE_PREFIX, guardHeaders);

  router.get(`${STAGED_PAGE_PREFIX}/:id`, async (req, res) => {
    const id = String(req.params.id);
    const db = openDb();
    let lang = "en";
    try {
      lang = await pageLang(db, req);
      // The owner rule first, before a single row field is read: a non-owner's page carries no
      // draft at all, only the sentence that says why.
      let owner = false;
      try { owner = (await ownerCheck(db, req)) === true; } catch { owner = false; }
      if (!owner) return refusal(res, 403, lang, "perch.stagedNotOwnerSee");
      if (!STAGED_ID_RE.test(id)) return refusal(res, 404, lang, "perch.stagedNotFound");
      const item = await getStagedItem(db, id);
      if (!item) return refusal(res, 404, lang, "perch.stagedNotFound");
      const title = t("perch.stagedTitle", lang);
      res.type("html").send(page(lang, renderCard(item, lang) + renderScript(lang, item), title));
    } catch (err) {
      console.warn(`[staged-page] ${STAGED_ID_RE.test(id) ? "row" : "id"}: ${(err && err.name) || "Error"}`);
      if (!res.headersSent) refusal(res, 500, lang, "perch.stagedFailedGeneric");
    } finally {
      try { db.close(); } catch { /* already closed */ }
    }
  });

  return router;
}

export default stagedPageRouter;