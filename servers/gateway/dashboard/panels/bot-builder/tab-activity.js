/**
 * Bot Builder — Activity tab: readiness checklist, Enable/Disable, waiting
 * skill proposals, recent sessions (send / stop / transcript).
 */
import { escapeHtml } from "../../shared/components.js";
import { csrfInput } from "../../shared/csrf.js";
import { t, tJs, fill } from "../../shared/i18n.js";
import { renderReadiness } from "./checklist.js";
import { listProposals } from "../../../../../scripts/pi-bots/skill_proposals.mjs";
import { card, scriptJson } from "./ui.js";

export async function renderActivity(ctx) {
  const { req, db, bot, def, botId, lang, q } = ctx;
  const createdCallout = q.created ? `<div class="callout callout-success">${t("botbuilder.checkCreatedCallout", lang)}</div>` : "";
  const checklist = await renderReadiness(db, bot, def, lang);
  let proposals = [];
  try { proposals = listProposals(def.session_dir); } catch { proposals = []; }
  const waiting = proposals.length
    ? `<p class="btb-notice-warn">${escapeHtml(fill(t("botbuilder.acProposalsWaiting", lang), { n: proposals.length }))} ` +
      `<a href="/dashboard/bot-builder?bot=${encodeURIComponent(botId)}&amp;tab=advanced#learning">${escapeHtml(t("botbuilder.acReview", lang))}</a></p>`
    : "";
  const toggleForm =
    `<form method="POST" class="btb-inline-form"><input type="hidden" name="action" value="toggle"><input type="hidden" name="bot_id" value="${escapeHtml(botId)}">${csrfInput(req)}` +
    `<button type="submit" class="btb-btn btb-btn-sec">${bot.enabled ? t("botbuilder.btnDisableBot", lang) : t("botbuilder.btnEnableBot", lang)}</button></form>`;
  const ready = card(t("botbuilder.acReadyTitle", lang), checklist + waiting + toggleForm);
  return createdCallout + ready + card(t("botbuilder.acSessionsTitle", lang), await renderSessions(db, botId, lang));
}

async function renderSessions(db, botId, lang) {
  let sessions = [];
  try {
    sessions = (await db.execute({
      sql: `SELECT id, pi_session_id, pi_session_dir, gateway_thread_id, status, control,
              model, escalated, card_id, datetime(updated_at) AS updated_at
            FROM bot_sessions WHERE bot_id=? ORDER BY id DESC LIMIT 30`,
      args: [botId],
    })).rows || [];
  } catch {}
  const statusClass = (s) => {
    if (s === "active" || s === "done") return "btb-ok";
    if (s === "waiting-user") return "btb-status-warn";
    if (s === "error") return "btb-err";
    return "btb-muted";
  };
  const sessHtml = sessions.length
    ? `<div class="table-scroll"><table class="btb-table"><thead><tr>` +
      `<th>${t("botbuilder.thId", lang)}</th><th>${t("botbuilder.thStatus", lang)}</th><th>${t("botbuilder.thModel", lang)}</th>` +
      `<th>${t("botbuilder.thThread", lang)}</th><th>${t("botbuilder.thUpdated", lang)}</th><th>${t("botbuilder.thActions", lang)}</th>` +
      `</tr></thead><tbody>` +
      sessions.map((s) => {
        const live = s.status === "active" || s.status === "waiting-user";
        const actions = [];
        if (live) actions.push(`<button type="button" class="bb-sess-send btb-sess-btn" data-thread="${escapeHtml(s.gateway_thread_id || "")}">${t("botbuilder.sessBtnSend", lang)}</button>`);
        if (live) actions.push(`<button type="button" class="bb-sess-stop btb-sess-btn" data-thread="${escapeHtml(s.gateway_thread_id || "")}">${t("botbuilder.sessBtnStop", lang)}</button>`);
        if (s.pi_session_id && s.pi_session_dir) actions.push(`<a href="/dashboard/bot-board-api/session/${s.id}/transcript" target="_blank" class="btb-sess-link">${t("botbuilder.sessBtnTranscript", lang)}</a>`);
        return `<tr><td>${s.id}</td><td class="${statusClass(s.status)}">${escapeHtml(s.status || "")}</td>` +
          `<td class="btb-mono">${escapeHtml(s.model || "—")}</td>` +
          `<td class="btb-mono" title="${escapeHtml(s.gateway_thread_id || "")}">${escapeHtml((s.gateway_thread_id || "").slice(0, 20))}</td>` +
          `<td class="btb-muted">${escapeHtml(s.updated_at || "")}</td><td>${actions.join(" ")}</td></tr>`;
      }).join("") + `</tbody></table></div>`
    : `<p class="btb-muted">${t("botbuilder.noticeNoSessions", lang)}</p>`;
  const sendForm =
    `<div id="bb-sess-send-panel" class="btb-send-panel">` +
    `<label for="bb-sess-msg">${t("botbuilder.sessionSendLabelPrefix", lang)}<code id="bb-sess-thread"></code>)</label><br>` +
    `<textarea id="bb-sess-msg" rows="3" class="btb-textarea btb-textarea-wide"></textarea>` +
    `<button type="button" id="bb-sess-send-btn" class="btb-btn">${t("botbuilder.btnSendToBot", lang)}</button>` +
    `<span id="bb-sess-send-status" class="btb-send-status" aria-live="polite"></span></div>`;
  const script = `<script>(function(){
    var panel=document.getElementById('bb-sess-send-panel');
    var threadEl=document.getElementById('bb-sess-thread');
    var msgEl=document.getElementById('bb-sess-msg');
    var statusEl=document.getElementById('bb-sess-send-status');
    var curThread=null;
    var BOT=${scriptJson(botId)};
    document.querySelectorAll('.bb-sess-send').forEach(function(btn){
      btn.onclick=function(){ curThread=this.getAttribute('data-thread');
        threadEl.textContent=curThread; panel.style.display=''; msgEl.focus(); };
    });
    document.querySelectorAll('.bb-sess-stop').forEach(function(btn){
      btn.onclick=function(){
        if(!confirm('${tJs("botbuilder.confirmStopSession", lang)}')) return;
        var th=this.getAttribute('data-thread');
        fetch('/dashboard/bot-board-api/session/stop',{method:'POST',headers:{'Content-Type':'application/json'},
          body:JSON.stringify({bot_id:BOT,gateway_thread_id:th}),credentials:'same-origin'})
        .then(function(r){return r.json();})
        .then(function(j){ if(j.ok) location.reload(); else crowToast('${tJs("botbuilder.stopSessionFailed", lang)}', {type:'error', details: j.reason||j.error||''}); });
      };
    });
    var sendBtn=document.getElementById('bb-sess-send-btn');
    if(sendBtn) sendBtn.onclick=function(){
      var msg=msgEl.value.trim();
      if(!msg||!curThread){ statusEl.textContent='${tJs("botbuilder.sessMsgRequired", lang)}'; return; }
      statusEl.textContent='${tJs("botbuilder.sessSending", lang)}';
      fetch('/dashboard/bot-board-api/session/send',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({bot_id:BOT,gateway_thread_id:curThread,message:msg}),credentials:'same-origin'})
      .then(function(r){return r.json();})
      .then(function(j){ if(j.ok){ statusEl.textContent='${tJs("botbuilder.sessDispatched", lang)}'; msgEl.value=''; }
        else statusEl.textContent=j.error||'${tJs("botbuilder.sessFailed", lang)}'; })
      .catch(function(e){ statusEl.textContent='${tJs("botbuilder.sessFailed", lang)}'+' '+e.message; });
    };
  })();</script>`;
  return sessHtml + sendForm + script;
}
