#!/bin/bash
# Inject frontend enhancements into the Open-LLM-VTuber frontend:
# 1. SDXL background auto-refresh (only if SDXL extension is configured)
# 2. Nest toggle button (always, for kiosk mode)
# 3. Tool overlay and WebSocket patches (always)

FRONTEND_HTML="/app/frontend/index.html"
SDXL_PORT="${SDXL_PORT:-3005}"

# ─── SDXL background polling (optional — requires SDXL extension) ───
if [ -n "${SDXL_HOST}" ] && ! grep -q "sdxl-bg-refresh" "$FRONTEND_HTML" 2>/dev/null; then

cat >> "$FRONTEND_HTML" << 'ENDSCRIPT'
<script id="sdxl-bg-refresh">(function(){
  var proto=location.protocol;
  var host=location.hostname;
  var BASE=proto+"//"+host+":__SDXL_PORT__";
  var lastEtag="";
  var initialized=false;

  function findBgImg(){
    var imgs=document.querySelectorAll("img");
    for(var i=0;i<imgs.length;i++){
      if(imgs[i].src&&imgs[i].src.indexOf(":__SDXL_PORT__")>-1) return imgs[i];
    }
    for(var i=0;i<imgs.length;i++){
      if(imgs[i].width>400&&imgs[i].height>400) return imgs[i];
    }
    return null;
  }

  function setBgImage(url){
    var img=findBgImg();
    if(img){
      img.src=url;
    }else{
      var selectors=["[class*=background]","#root > div > div","#root > div"];
      for(var i=0;i<selectors.length;i++){
        var el=document.querySelector(selectors[i]);
        if(el){el.style.backgroundImage="url("+url+")";break;}
      }
    }
  }

  function check(){
    fetch(BASE+"/health").then(function(r){return r.json()}).then(function(d){
      if(!d||!d.current_image)return;
      fetch(BASE+"/",{method:"HEAD"}).then(function(r){
        var etag=r.headers.get("etag")||"";
        if(!initialized||etag!==lastEtag){
          initialized=true;
          lastEtag=etag;
          var url=BASE+"/?t="+Date.now();
          setBgImage(url);
          try{localStorage.setItem("backgroundUrl",JSON.stringify(url))}catch(e){}
        }
      }).catch(function(){});
    }).catch(function(){});
  }

  setTimeout(function(){
    fetch(BASE+"/health").then(function(r){return r.json()}).then(function(d){
      if(d&&d.current_image){
        var url=BASE+"/?t="+Date.now();
        try{localStorage.setItem("backgroundUrl",JSON.stringify(url))}catch(e){}
      }
    }).catch(function(){});
  },500);

  setInterval(check,5000);
  setTimeout(check,2000);
})();</script>
ENDSCRIPT

# Replace port placeholder
sed -i "s|__SDXL_PORT__|${SDXL_PORT}|g" "$FRONTEND_HTML"

echo "Injected background refresh into frontend (SDXL port ${SDXL_PORT}, image-only)"
else
    if [ -z "${SDXL_HOST}" ]; then
        echo "SDXL_HOST not set, skipping background refresh injection (install SDXL extension to enable)"
    else
        echo "Background refresh already injected."
    fi
fi

# ─── Inject Nest toggle button (for kiosk mode) ───
if grep -q "crow-nest-toggle" "$FRONTEND_HTML" 2>/dev/null; then
    echo "Nest toggle already injected."
    exit 0
fi

cat >> "$FRONTEND_HTML" << 'NESTSCRIPT'
<script id="crow-nest-toggle">(function(){
  // Only show if running inside an iframe (kiosk mode)
  if(window.self===window.top)return;

  var btn=document.createElement("button");
  btn.id="crow-nest-btn";
  btn.title="Crow's Nest";
  btn.style.cssText="position:fixed;top:12px;right:12px;z-index:99999;background:rgba(15,15,23,0.7);border:1px solid rgba(61,61,77,0.6);border-radius:8px;color:#fafaf9;padding:8px 12px;font-size:13px;font-family:'DM Sans',sans-serif;cursor:pointer;display:flex;align-items:center;gap:6px;backdrop-filter:blur(8px);transition:opacity 0.3s;opacity:0.3;";
  btn.onmouseenter=function(){btn.style.opacity="1"};
  btn.onmouseleave=function(){btn.style.opacity="0.3"};
  btn.onclick=function(){window.parent.postMessage("crow-exit-kiosk","*")};

  var svg='<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>';
  var span=document.createElement("span");
  span.textContent="Nest";
  var iconWrap=document.createElement("span");
  iconWrap.style.display="flex";
  iconWrap.insertAdjacentHTML("beforeend",svg);
  btn.appendChild(iconWrap);
  btn.appendChild(span);
  document.body.appendChild(btn);
})();</script>
NESTSCRIPT

echo "Injected Nest toggle into frontend"

# ─── Inject MCP tool results overlay ───
if ! grep -q "crow-tool-overlay" "$FRONTEND_HTML" 2>/dev/null; then
cat >> "$FRONTEND_HTML" << 'TOOLSCRIPT'
<script id="crow-tool-overlay">(function(){
  var panel=document.createElement("div");
  panel.id="crow-tool-panel";
  panel.style.cssText="position:fixed;top:0;right:0;width:340px;max-width:40vw;height:100vh;background:rgba(15,15,23,0.92);border-left:1px solid rgba(61,61,77,0.5);backdrop-filter:blur(12px);z-index:9998;transform:translateX(100%);transition:transform 0.25s ease;display:flex;flex-direction:column;font-family:'DM Sans',system-ui,sans-serif;color:#fafaf9;overflow:hidden;";

  var header=document.createElement("div");
  header.style.cssText="padding:12px 16px;border-bottom:1px solid rgba(61,61,77,0.5);display:flex;align-items:center;justify-content:space-between;flex-shrink:0;";
  var title=document.createElement("span");
  title.style.cssText="font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;color:#a8a29e;";
  title.textContent="Tool Activity";
  var closeBtn=document.createElement("button");
  closeBtn.style.cssText="background:none;border:none;color:#78716c;cursor:pointer;font-size:16px;padding:2px 6px;";
  closeBtn.textContent="\u00d7";
  closeBtn.onclick=function(){panel.style.transform="translateX(100%)";toggleBtn.style.opacity="0.3"};
  header.appendChild(title);
  header.appendChild(closeBtn);
  panel.appendChild(header);

  var list=document.createElement("div");
  list.id="crow-tool-list";
  list.style.cssText="flex:1;overflow-y:auto;padding:8px;font-size:13px;";
  panel.appendChild(list);
  document.body.appendChild(panel);

  var toggleBtn=document.createElement("button");
  toggleBtn.id="crow-tool-toggle";
  toggleBtn.title="Tool Activity";
  toggleBtn.style.cssText="position:fixed;bottom:16px;right:16px;z-index:9999;background:rgba(15,15,23,0.7);border:1px solid rgba(99,102,241,0.4);border-radius:10px;color:#6366f1;padding:8px;cursor:pointer;backdrop-filter:blur(8px);transition:opacity 0.3s,border-color 0.15s;opacity:0;pointer-events:none;display:flex;align-items:center;gap:4px;font-size:12px;font-family:'DM Sans',sans-serif;";
  var badge=document.createElement("span");
  badge.id="crow-tool-badge";
  badge.style.cssText="display:none;background:#6366f1;color:#fff;font-size:10px;font-weight:700;min-width:16px;height:16px;border-radius:8px;text-align:center;line-height:16px;padding:0 4px;";
  badge.textContent="0";
  // Build SVG icon via DOM
  var svgNS="http://www.w3.org/2000/svg";
  var svg=document.createElementNS(svgNS,"svg");
  svg.setAttribute("width","16");svg.setAttribute("height","16");svg.setAttribute("viewBox","0 0 24 24");
  svg.setAttribute("fill","none");svg.setAttribute("stroke","currentColor");svg.setAttribute("stroke-width","2");
  var path=document.createElementNS(svgNS,"path");
  path.setAttribute("d","M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z");
  svg.appendChild(path);
  toggleBtn.appendChild(svg);
  toggleBtn.appendChild(badge);
  toggleBtn.onclick=function(){
    var open=panel.style.transform!=="translateX(0px)";
    panel.style.transform=open?"translateX(0px)":"translateX(100%)";
    toggleBtn.style.opacity=open?"1":"0.3";
    if(open){badge.style.display="none";badge.textContent="0";}
  };
  document.body.appendChild(toggleBtn);

  var toolCards={};

  function addOrUpdateTool(data){
    var id=data.tool_id||"unknown";
    var card=toolCards[id];
    if(!card){
      card=document.createElement("div");
      card.style.cssText="margin-bottom:8px;padding:10px 12px;border:1px solid rgba(61,61,77,0.5);border-radius:8px;background:rgba(26,26,46,0.6);animation:fadeIn 0.2s ease;";
      var nameRow=document.createElement("div");
      nameRow.style.cssText="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;";
      var nameEl=document.createElement("span");
      nameEl.style.cssText="font-weight:600;font-size:12px;color:#818cf8;";
      nameEl.textContent=data.tool_name||id;
      var statusEl=document.createElement("span");
      statusEl.className="crow-tool-status";
      statusEl.style.cssText="font-size:10px;padding:2px 6px;border-radius:4px;font-weight:600;";
      nameRow.appendChild(nameEl);
      nameRow.appendChild(statusEl);
      card.appendChild(nameRow);
      var contentEl=document.createElement("pre");
      contentEl.className="crow-tool-content";
      contentEl.style.cssText="font-size:11px;color:#a8a29e;white-space:pre-wrap;word-break:break-word;margin:0;max-height:200px;overflow-y:auto;font-family:'JetBrains Mono',monospace;line-height:1.4;";
      card.appendChild(contentEl);
      list.insertBefore(card,list.firstChild);
      toolCards[id]=card;
      toggleBtn.style.pointerEvents="auto";
      if(toggleBtn.style.opacity==="0")toggleBtn.style.opacity="0.3";
    }
    var st=card.querySelector(".crow-tool-status");
    var ct=card.querySelector(".crow-tool-content");
    var status=data.status||"unknown";
    st.textContent=status;
    if(status==="running"){st.style.background="rgba(99,102,241,0.2)";st.style.color="#818cf8";}
    else if(status==="completed"){st.style.background="rgba(34,197,94,0.2)";st.style.color="#22c55e";}
    else if(status==="error"){st.style.background="rgba(239,68,68,0.2)";st.style.color="#ef4444";}
    if(data.content)ct.textContent=data.content.substring(0,2000);
    if(panel.style.transform!=="translateX(0px)"&&status==="completed"){
      var b=document.getElementById("crow-tool-badge");
      var n=parseInt(b.textContent||"0")+1;
      b.textContent=String(n);
      b.style.display="inline-block";
    }
  }

  // Shared WS message bridge — all injections register here (single patch point)
  window.CrowWS=window.CrowWS||{handlers:[]};
  if(!window.CrowWS._patched){
    window.CrowWS._patched=true;
    var _sockets=new WeakSet();
    var _origSend=WebSocket.prototype.send;
    WebSocket.prototype.send=function(){
      if(!_sockets.has(this)){
        _sockets.add(this);
        window.CrowWS._activeSocket=this;
        this.addEventListener("message",function(e){
          try{
            var d=JSON.parse(e.data);
            for(var i=0;i<window.CrowWS.handlers.length;i++){
              window.CrowWS.handlers[i](d);
            }
          }catch(ex){}
        });
      }
      return _origSend.apply(this,arguments);
    };
  }
  // Register tool overlay as a CrowWS consumer
  window.CrowWS.handlers.push(function(d){
    if(d.type==="tool_call_status")addOrUpdateTool(d);
  });

  var style=document.createElement("style");
  style.textContent="@keyframes fadeIn{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:translateY(0)}}";
  document.head.appendChild(style);
})();</script>
TOOLSCRIPT
echo "Injected MCP tool results overlay"
fi

# ─── Fix WebSocket URL for remote access ───
# The compiled frontend has hardcoded ws://127.0.0.1:12393/client-ws and
# http://127.0.0.1:12393 as DEFAULT_WS_URL and DEFAULT_BASE_URL.
# Replace them with dynamic URLs derived from the browser's location so
# mobile browsers and remote Tailscale clients can connect.

FRONTEND_JS=$(ls /app/frontend/assets/main-*.js 2>/dev/null | head -1)
if [ -n "$FRONTEND_JS" ]; then
    if grep -q 'ws://127.0.0.1:12393/client-ws' "$FRONTEND_JS" 2>/dev/null; then
        # Replace hardcoded WS URL with a dynamic expression
        # Uses wss:// when on HTTPS, ws:// when on HTTP, and the browser's hostname
        sed -i 's|"ws://127.0.0.1:12393/client-ws"|((location.protocol==="https:"?"wss://":"ws://")+location.hostname+":"+location.port+"/client-ws")|g' "$FRONTEND_JS"
        # Replace hardcoded base URL
        sed -i 's|"http://127.0.0.1:12393"|(location.protocol+"//"+location.hostname+":"+location.port)|g' "$FRONTEND_JS"
        # Cache-bust: rename the JS file and update index.html reference
        NEW_JS="${FRONTEND_JS%.js}.patched.js"
        mv "$FRONTEND_JS" "$NEW_JS"
        OLD_NAME=$(basename "$FRONTEND_JS")
        NEW_NAME=$(basename "$NEW_JS")
        sed -i "s|${OLD_NAME}|${NEW_NAME}|g" "$FRONTEND_HTML"
        echo "Patched frontend JS with dynamic WebSocket/base URLs (cache-busted)"
    else
        echo "Frontend JS already patched or pattern not found"
    fi
else
    echo "Warning: No frontend JS bundle found to patch"
fi
