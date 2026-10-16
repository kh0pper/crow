/**
 * The page's link to the Pi's crow-kiosk-agent (ws://127.0.0.1:8770, kiosk spec §4.2).
 *
 * Only a Pi launched by scripts/kiosk/kiosk-launch.sh opens it (the launch URL carries ?agent=1):
 * on a phone, a loopback socket would raise Chrome's Local Network Access prompt for nothing.
 * Agent → page: agent (status, carries bt), wake, touch_while_dark, bt_state {configured, connected, name, reconnecting, reason?, result?, req?}
 * (reason is passed through as sent; an older agent leaves it out).
 * Page → agent: display, speaking, media, bt_reconnect {req?} (the agent reconnects its configured speaker; no MAC crosses this socket).
 * The last display/speaking/media state is replayed after every reconnect, so an agent restart never
 * leaves it believing the bird is still speaking.
 * The agent is on the same box, so a lost socket is retried within 5 s at most; close code 4000 (a newer page
 * replaced this one) is final, so two pages never take the agent from each other in a loop.
 */
export const AGENT_URL = "ws://127.0.0.1:8770";

export function agentWanted(search) {
  return new URLSearchParams(search || "").get("agent") === "1";
}

export function createAgentLink({ url = AGENT_URL, WebSocketImpl = globalThis.WebSocket, setTimer = setTimeout, clearTimer = clearTimeout,
  onWake = () => {}, onTouchWhileDark = () => {}, onStatus = () => {}, onBtState = () => {} } = {}) {
  let ws = null, timer = null, delay = 1000, stopped = true, status = null, bt = null, reqSeq = 0;
  const pending = new Map();   // req → resolve, for btReconnect()
  const last = {};   // type → message, replayed on reconnect
  const sendNow = (msg) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); };
  const remember = (msg) => { last[msg.type] = msg; sendNow(msg); };

  function onMessage(ev) {
    let m;
    try { m = JSON.parse(typeof ev.data === "string" ? ev.data : ""); } catch { return; }
    if (!m || typeof m !== "object") return;
    if (m.type === "agent") { status = m; onStatus(m); if (m.bt && typeof m.bt === "object") { bt = m.bt; onBtState(bt); } }
    else if (m.type === "wake") onWake(m);
    else if (m.type === "touch_while_dark") onTouchWhileDark();
    else if (m.type === "bt_state") {
      bt = m; onBtState(m);
      if (typeof m.req === "string" && pending.has(m.req)) { pending.get(m.req)(m); pending.delete(m.req); }
    }
  }

  function connect() {
    if (stopped || !WebSocketImpl) return;
    try { ws = new WebSocketImpl(url); } catch { schedule(); return; }
    ws.onopen = () => { delay = 1000; for (const k of ["display", "speaking", "media"]) if (last[k]) sendNow(last[k]); };
    ws.onmessage = onMessage;
    ws.onclose = (ev) => {
      ws = null; if (status) { status = null; onStatus(null); }
      for (const resolve of pending.values()) resolve({ type: "bt_state", result: "agent_unavailable" });
      pending.clear();
      if (ev && ev.code === 4000) stopped = true; else schedule();
    };
    ws.onerror = () => {};
  }
  function schedule() {
    if (stopped || timer) return;
    timer = setTimer(() => { timer = null; connect(); }, delay);
    delay = Math.min(5000, delay * 2);
  }

  return {
    start() { if (!stopped) return; stopped = false; connect(); },
    stop() { stopped = true; if (timer) { clearTimer(timer); timer = null; } if (ws) { const w = ws; ws = null; w.onclose = null; w.close(); } },
    display(on) { remember({ type: "display", on: !!on }); },
    speaking(on) { remember({ type: "speaking", on: !!on }); },
    media(on, level = 0) { remember({ type: "media", on: !!on, level: Math.max(0, Math.min(100, Number(level) || 0)) }); },
    /** Ask the agent to reconnect its speaker. Resolves with the agent's bt_state (result: ok|failed|busy|rate_limited|not_paired|not_configured|agent_unavailable|timeout). */
    btReconnect({ timeoutMs = 30000 } = {}) {
      if (!ws || ws.readyState !== 1) return Promise.resolve({ type: "bt_state", result: "agent_unavailable" });
      const req = `r${++reqSeq}`;
      return new Promise((resolve) => {
        const t = setTimer(() => { if (pending.delete(req)) resolve({ type: "bt_state", result: "timeout" }); }, timeoutMs);
        pending.set(req, (m) => { clearTimer(t); resolve(m); });
        sendNow({ type: "bt_reconnect", req });
      });
    },
    get bt() { return bt; },
    get connected() { return !!(ws && ws.readyState === 1 && status); },
    get status() { return status; },
  };
}
