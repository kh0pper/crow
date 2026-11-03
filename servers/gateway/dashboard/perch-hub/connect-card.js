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
 * it is trusted: the marker is a fixed line, both ids must match ^[a-z0-9][a-z0-9-]{0,63}$ and a
 * result that fails either check renders NO card. The link is built here from the validated
 * values, never copied out of the text, and the label is written with textContent only.
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
     them ("[?]" is a literal "?" and "/" needs no escape in a RegExp source string). */
  var CONNECT_LINK=new RegExp('/dashboard/project/([a-z0-9][a-z0-9-]{0,63})/services[?]connect=([a-z0-9][a-z0-9-]{0,63})');
  /* {service,slug,href} from a tool result, or null: no marker, no link, or an id that fails
     CONNECT_ID means no card at all. */
  function connectFrom(result){
    var t=result==null?'':String(result);
    if(t.indexOf(CONNECT_MARKER)<0) return null;
    var m=CONNECT_LINK.exec(t);
    if(!m) return null;
    var slug=m[1],service=m[2];
    if(!CONNECT_ID.test(slug)||!CONNECT_ID.test(service)) return null;
    return {service:service,slug:slug,href:'/dashboard/project/'+slug+'/services?connect='+service};
  }
  /* Draws the card at the end of the transcript; returns it, or null when the result is not a
     connect refusal. */
  function renderConnectCard(result){
    var c=connectFrom(result);
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