/**
 * The speaker chip in the kiosk's top bar (kiosk spec DV13, page side). Loaded only on a Pi whose launch URL
 * carries ?agent=1; kiosk.js imports it on demand, so phones never download it.
 *
 * States: hidden until start(); "Connecting…" while the agent socket is not up (for 20 s after start or
 * after the agent goes away), then "Speaker control unavailable"; hidden when the agent says no speaker
 * is configured; connected (glyph + name); not connected (a 56 px "Reconnect speaker" button with the
 * reason under it). A tap asks the agent to reconnect and the line under the chip shows its answer until
 * the speaker's state changes.
 *
 * The name comes from the speaker itself (its Bluetooth alias), so it is untrusted: controls and bidi
 * overrides are stripped, it is cut to 64 code points, and it is only ever set with textContent (review D3).
 */
export const UNAVAILABLE_AFTER_MS = 20000;

const STRIP = /[\u0000-\u001F\u007F-\u009F‪-‮⁦-⁩]/g;
export function sanitizeName(name) {
  if (typeof name !== "string") return null;
  const clean = Array.from(name.replace(STRIP, "").trim()).slice(0, 64).join("");
  return clean || null;
}

const REASONS = {
  not_paired: "not_paired", adapter_blocked: "adapter_off", adapter_off: "adapter_off", no_adapter: "no_adapter",
  hw_fault: "hw_fault", no_sink: "no_sink", no_answer: "no_answer", off_or_out_of_range: "out_of_range",
};
/** The reason line for a disconnected speaker. An agent without a `reason` field gets no guessed cause. */
function reasonKey(bt) {
  if (bt.hw_fault) return "speaker_reason_hw_fault";
  if (bt.link) return "speaker_reason_no_sink";
  if (!("reason" in bt)) return "speaker_reason_generic";
  return `speaker_reason_${REASONS[bt.reason] || "out_of_range"}`;
}
const resultKey = (r) => (r === "not_paired" ? "speaker_reason_not_paired" : `speaker_result_${r}`);
const signature = (bt) => [bt.connected, bt.link, bt.hw_fault, bt.reason].map(String).join("|");

export function createSpeakerView(root, { doc = root.ownerDocument, t, link, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const btn = doc.createElement("button");
  btn.type = "button";
  btn.className = "k-spk-btn";
  const glyph = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
  glyph.setAttribute("class", "k-spk-glyph");
  glyph.setAttribute("viewBox", "0 0 24 24");
  glyph.setAttribute("aria-hidden", "true");
  const path = doc.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M3 9v6h4l5 5V4L7 9H3zm13-1a5 5 0 0 1 0 8");
  glyph.append(path);
  const label = doc.createElement("span");
  label.className = "k-spk-label";
  btn.append(glyph, label);
  const line = doc.createElement("span");
  line.className = "k-spk-line";
  line.setAttribute("role", "status");
  root.replaceChildren(btn, line);

  let started = false, agentUp = false, unavailable = false, timer = null, bt = null, waiting = false;
  let result = null;   // { key, sig }: the last tap's answer, shown until the speaker's state changes

  function arm() {
    if (timer) clearTimer(timer);
    unavailable = false;
    timer = setTimer(() => { timer = null; unavailable = true; render(); }, UNAVAILABLE_AFTER_MS);
  }
  function render() {
    if (!started || (agentUp && bt && !bt.configured)) { root.hidden = true; return; }
    root.hidden = false;
    const connected = agentUp && bt && bt.connected;
    root.classList.toggle("is-connected", !!connected);
    glyph.toggleAttribute("hidden", !connected);
    if (!agentUp || !bt) {
      label.textContent = t(unavailable ? "speaker_unavailable" : "speaker_connecting");
      line.textContent = result && !agentUp ? t(result.key) : "";
      return;
    }
    label.textContent = connected ? sanitizeName(bt.name) || t("speaker_default") : t("speaker_reconnect");
    if (waiting) line.textContent = t("speaker_reconnecting");
    else if (result && result.sig === signature(bt)) line.textContent = t(result.key);
    else line.textContent = connected ? "" : t(reasonKey(bt));
  }

  btn.addEventListener("click", () => {
    if (!started || waiting) return;
    if (!agentUp) { result = { key: resultKey("agent_unavailable"), sig: null }; render(); return; }
    waiting = true; render();
    Promise.resolve(link.btReconnect()).then((m) => {
      waiting = false;
      result = { key: resultKey(m && m.result), sig: bt ? signature(bt) : null };
      render();
    });
  });

  return {
    start() { if (started) return; started = true; arm(); render(); },
    /** The agent's status frame, or null when the socket closed. */
    status(s) {
      const up = !!s;
      if (up === agentUp) return;
      agentUp = up;
      if (up) { if (timer) clearTimer(timer); timer = null; unavailable = false; result = null; }
      else { bt = null; if (started) arm(); }
      render();
    },
    bt(state) {
      if (!state || typeof state !== "object") return;
      bt = state;
      if (result && result.sig !== null && result.sig !== signature(state)) result = null;
      render();
    },
  };
}
