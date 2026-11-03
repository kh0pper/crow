import { tJs } from "../shared/i18n.js";

/**
 * The Connect card in a Perch chat (project services §6.7, credential card plan Task 4).
 *
 * Spliced INSIDE perchHubJs()'s IIFE (client.js), the secret-card.js pattern, so it shares that
 * scope's el / line / document and the transcript helpers.
 *
 * When a tool result carries servers/shared/service-connections.js's NOT_CONNECTED_MARKER, the
 * chat shows "Connect <service>" with a link to that project's Services page and its connect
 * sheet already open (/dashboard/project/<slug>/services?connect=<serviceId>). The value is typed
 * there, never in chat.
 *
 * A tool result is text a model (and therefore, indirectly, a service) can shape, so nothing in
 * it is trusted: the marker must START the result (after trimming), the link must be anchored, both
 * ids must match ^[a-z0-9][a-z0-9-]{0,63}$, the result must come from a services tool of THIS
 * session's project, and a result that fails any check renders NO card. The link is built here
 * from the validated values, never copied out of the text, and the label is written with
 * textContent only.
 *
 * The tool-result frame carries no family field: its identity is `name`, the pi tool id
 * (`mcp__<block>__<tool>`). A service block is named `<serviceId>-<labelSlug>`
 * (service-connections.js / service-blocks.mjs), so the block segment must be the service the
 * marker names, or start with it plus "-" — any other tool's result renders no card.
 *
 * GAP (plan Task 4): no tool emits the marker yet — the services tool family has not landed. The
 * renderer is keyed on the fixed marker, so it lights up the day one does.
 */
export function perchConnectCardJs(lang = "en") {
  return `
  /* ---- the Connect card (project services §6.7) -------------------------- */
  var CONNECT_MARKER='[not connected in this project]';
  var CONNECT_TITLE='${tJs("perch.connectTitle", lang)}';
  var CONNECT_HELP='${tJs("perch.connectHelp", lang)}';
  var CONNECT_OPEN='${tJs("perch.connectOpen", lang)}';
  var CONNECT_ID=/^[a-z0-9][a-z0-9-]{0,63}$/;
  /* No backslash escapes here: this file is emitted inside a template literal, which would eat
     them. Anchored: the link only counts at a token boundary and only when the whole one
     (protocol-relative host, trailing id characters) is what the producer writes. */
  var CONNECT_LINK=new RegExp('(?:^|[^a-z0-9-])/dashboard/project/([a-z0-9][a-z0-9-]{0,63})/services[?]connect=([a-z0-9][a-z0-9-]{0,63})(?:$|[^a-z0-9-])');
  /* A pi MCP tool id: mcp__<block>__<tool>. The block of a service tool is <serviceId>-<label>. */
  var CONNECT_TOOL=/^mcp__([a-z0-9][a-z0-9-]{0,63})__[A-Za-z0-9][A-Za-z0-9_.-]*$/;
  /* {service,slug,href} from a services tool's result for THIS project, or null. */
  function connectFrom(result,toolName){
    var t=String(result==null?'':result);
    if(t.trimStart) t=t.trimStart();
    if(t.slice(0,CONNECT_MARKER.length)!==CONNECT_MARKER) return null;
    var tm=CONNECT_TOOL.exec(String(toolName==null?'':toolName));
    if(!tm) return null;
    var m=CONNECT_LINK.exec(t);
    if(!m) return null;
    var slug=m[1],service=m[2];
    if(!CONNECT_ID.test(slug)||!CONNECT_ID.test(service)) return null;
    /* Only a service tool's result: its block names the service the marker names. */
    if(tm[1]!==service&&tm[1].indexOf(service+'-')!==0) return null;
    /* Only this chat's own project: the client knows it from its row and the page's list. */
    var here=(typeof projectOfRow==='function')?projectOfRow(rowIndex[current.sid],PROJECTS):null;
    if(!here||here.slug!==slug) return null;
    return {service:service,slug:slug,href:'/dashboard/project/'+slug+'/services?connect='+service};
  }
  /* Draws the card at the end of the transcript; returns it, or null when the result is not a
     connect refusal from a service tool of this session's project. */
  function renderConnectCard(result,toolName){
    var c=connectFrom(result,toolName);
    if(!c) return null;
    var tr=el('perch-transcript'); if(!tr) return null;
    var card=document.createElement('div'); card.className='entry connect-card';
    card.setAttribute('data-service',c.service);
    card.appendChild(line('connect-title',secWarnFill(CONNECT_TITLE,{service:c.service})));
    card.appendChild(line('connect-help',CONNECT_HELP));
    var a=document.createElement('a'); a.className='connect-open';
    a.href=c.href;
    a.textContent=CONNECT_OPEN;
    card.appendChild(a);
    tr.appendChild(card);
    tr.scrollTop=tr.scrollHeight;
    return card;
  }
`;
}