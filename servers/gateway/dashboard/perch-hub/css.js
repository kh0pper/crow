/**
 * The Perch stylesheet, ported from the deleted perch-hub bundle
 * (42f39160^:bundles/perch-hub/payload/hub/server.mjs, PERCH_CSS).
 *
 * It keeps Perch OWN palette rather than crow --crow-* tokens. That
 * palette is the look this page exists to restore; mapping it onto the
 * dashboard tokens would change the thing being brought back.
 */
export function perchHubCss() {
  return `
:root{--sky:#eef1f3;--card:#fff;--ink:#22303a;--dim:#6b7c88;--teal:#0e6b62;--teal-soft:#dcecea;
--wire:#94a4ae;--alive:#2fa36b;--attn:#d1633e;--line:#dde4e8}
@media (prefers-color-scheme:dark){:root{--sky:#131a1f;--card:#1b242b;--ink:#e4ebef;--dim:#8fa0ab;
--teal:#4fbdb0;--teal-soft:#16322f;--wire:#46565f;--line:#2a353d}}
*{box-sizing:border-box;margin:0}
body{background:var(--sky);color:var(--ink);font:15px/1.5 Inter,"Public Sans",system-ui,sans-serif;max-width:640px;margin:0 auto;padding:0 16px 56px}
header{padding:30px 0 20px;display:flex;align-items:baseline;justify-content:space-between;gap:10px;flex-wrap:wrap}
.brand{font-size:26px;font-weight:600;letter-spacing:-.03em}
.brand small{color:var(--dim);font-weight:400;font-size:15px;margin-left:6px}
.machines{display:flex;gap:6px;font-size:13px}
.machines a{text-decoration:none;color:var(--dim);padding:5px 12px;border-radius:999px;border:1px solid var(--line)}
.machines a.here{background:var(--teal);border-color:var(--teal);color:#fff}
a:focus-visible,button:focus-visible,input:focus-visible,textarea:focus-visible{outline:2px solid var(--teal);outline-offset:2px}
h2{font-size:12px;text-transform:uppercase;letter-spacing:.09em;color:var(--dim);font-weight:600;margin:30px 0 12px}
.perch{position:relative;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px 16px 0;margin:22px 0 12px;box-shadow:0 1px 2px rgb(0 0 0/4%)}
.perch::before{content:"";position:absolute;left:-6px;right:-6px;top:0;border-top:2px solid var(--wire)}
.bird{position:absolute;top:-17px;left:22px;width:26px;height:18px;color:var(--alive)}
.bird svg{width:100%;height:100%;display:block}
.bird.attn{color:var(--attn)}.bird.idle{color:var(--wire)}
.perch-head{display:flex;justify-content:space-between;align-items:center;gap:10px}
.title{font-weight:600;font-size:17px}
.meta{color:var(--dim);font-size:13px;margin-top:2px;word-break:break-all}
.state{font-size:13px;color:var(--alive);font-weight:500;white-space:nowrap}
.state.attn{color:var(--attn)}.state.idle{color:var(--dim)}
.row-actions{display:flex;gap:8px;margin:12px 0 14px;flex-wrap:wrap}
button{font:500 14px/1 Inter,system-ui,sans-serif;cursor:pointer;border-radius:10px;padding:10px 16px;border:1px solid var(--line);background:var(--card);color:var(--ink)}
button.primary{background:var(--teal);border-color:var(--teal);color:#fff}
button.quiet{color:var(--dim)}
a.btn{display:inline-block;text-decoration:none;font:500 14px/1 Inter,system-ui,sans-serif;border-radius:10px;padding:10px 16px;background:var(--teal);color:#fff}
.databar{margin:0 -16px;background:var(--teal-soft);border-top:1px solid var(--line);border-radius:0 0 13px 13px;padding:7px 16px;font:12px "JetBrains Mono",ui-monospace,monospace;color:var(--teal);display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap}
.databar .mono-dim{color:var(--dim)}
.spawn{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px;display:grid;gap:10px}
input,textarea{font:14px Inter,system-ui,sans-serif;width:100%;padding:11px 12px;border:1px solid var(--line);border-radius:10px;background:var(--sky);color:var(--ink)}
input::placeholder,textarea::placeholder{color:var(--dim)}
.roost{background:var(--card);border:1px solid var(--line);border-radius:14px;overflow:hidden}
.roost-row{display:flex;align-items:center;gap:12px;padding:13px 16px;border-bottom:1px solid var(--line);flex-wrap:wrap}
.roost-row:last-child{border-bottom:none}
.roost-dot{width:8px;height:8px;border-radius:50% 50% 50% 2px;background:var(--wire);flex-shrink:0;transform:rotate(-8deg)}
.roost-main{flex:1;min-width:180px}
.roost-cwd{font-weight:500;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.roost-when{color:var(--dim);font-size:12.5px;font-family:"JetBrains Mono",ui-monospace,monospace}
.roost-row button{padding:8px 12px;font-size:13px}
#msg{margin:10px 0;font-size:13px;min-height:18px}.ok{color:var(--alive)}
.empty{color:var(--dim);padding:16px;font-size:14px}
/* --- hub layout ------------------------------------------------------- */
/* Two views, one at a time on a phone, side by side on a wide screen. */
#perch-list,#perch-chat{display:none}
body[data-view="list"] #perch-list{display:block}
body[data-view="chat"] #perch-chat{display:flex;flex-direction:column}
/* 100vh is the LARGE viewport on mobile: it excludes the URL bar and the
   bottom nav, so anything in the last strip sits behind the browser chrome
   where scrolling cannot reach it. dvh tracks what is actually visible. */
#perch-chat{height:100vh;height:100dvh}
#perch-transcript{flex:1;overflow:auto;min-height:0;display:grid;gap:9px;padding:12px 0}
/* Send must be reachable at ANY scroll position, not only at the bottom of a
   long transcript. That was the drawer's defining mobile failure. */
#perch-composer{position:sticky;bottom:0;background:var(--card);border-top:1px solid var(--line);padding:10px 0;display:grid;gap:8px}
#perch-composer .send-row{display:flex;gap:8px}
#perch-composer textarea{min-height:72px}
#perch-back{align-self:flex-start}
.field-row{display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;margin:10px 0}
.field{display:flex;flex-direction:column;gap:3px;flex:1 1 150px;min-width:0}
.field-label{font:11px/1 "JetBrains Mono",ui-monospace,monospace;text-transform:uppercase;letter-spacing:.06em;color:var(--dim)}
@media (min-width:900px){
  body{max-width:1100px}
  body[data-view="chat"] #perch-list{display:block}
  .hub-split{display:grid;grid-template-columns:320px 1fr;gap:20px;align-items:start}
  #perch-back{display:none}
}
`;
}
