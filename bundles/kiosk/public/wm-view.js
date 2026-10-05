/**
 * Window stack for small screens (spec §8.5): one visible window, a tab rail, swipe to dismiss. Text only.
 * A finished timer stays in its pane (never a full-screen layer over the bird and the talk button), tints
 * the page (html.k-ringing) and is dismissed by one tap anywhere on it, like its close button.
 */
export function classifySwipe({ dx, dy, dt }) {
  if (Math.abs(dy) > Math.abs(dx)) return null;
  if (Math.abs(dx) >= 80 || (dt > 0 && Math.abs(dx) / dt > 0.5)) return dx < 0 ? "left" : "right";
  return null;
}
export function formatRemaining(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** The now-playing window's buttons: [glyph, label key, verb] (the pause/play and mute pairs pick by state). */
const NP_BUTTONS = [["⏮", "media_previous", "previous"], ["⏯", null, null], ["⏭", "media_next", "next"], ["−", "media_quieter", "volume_down"], ["+", "media_louder", "volume_up"], ["🔇", null, null]];

export function createWindowView(root, { t = (k) => k, onDismiss = () => {}, onTap = () => {}, onCloseAll = () => {}, now = () => Date.now(), nowPlaying = () => null, onMedia = () => {} } = {}) {
  const doc = root.ownerDocument;
  let wins = [];
  let tick = null;
  const el = (tag, cls, text) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = String(text); return e; };
  const toTop = (id) => { const w = wins.find((x) => x.id === id); if (w) wins = [...wins.filter((x) => x !== w), w]; };

  /** Idempotent: a swipe, the close button and a tap on a finished timer can all land on one gesture. */
  function dismiss(id) { if (!wins.some((w) => w.id === id)) return; wins = wins.filter((w) => w.id !== id); onDismiss(id); render(); }
  function swipe(node, id) {
    let x0 = null, y0 = 0, t0 = 0, hold = null;
    const cancelHold = () => { clearTimeout(hold); hold = null; };
    node.addEventListener("pointerdown", (e) => {
      x0 = e.clientX; y0 = e.clientY; t0 = e.timeStamp;
      hold = setTimeout(() => { hold = null; x0 = null; wins = []; onCloseAll(); render(); }, 700);   // long-press = close all (spec §8.5)
    });
    node.addEventListener("pointermove", (e) => { if (hold && Math.abs(e.clientX - x0) + Math.abs(e.clientY - y0) > 12) cancelHold(); });
    node.addEventListener("pointercancel", cancelHold);
    node.addEventListener("pointerup", (e) => {
      cancelHold();
      if (x0 == null) return;
      const s = classifySwipe({ dx: e.clientX - x0, dy: e.clientY - y0, dt: e.timeStamp - t0 });
      x0 = null;
      if (s) dismiss(id);
    });
  }
  function body(w) {
    const card = el("article", `k-win k-win-${w.kind}${w.done ? " is-done" : ""}`);
    card.dataset.id = w.id;
    card.append(el("h2", "k-win-title", w.title));
    if (w.kind === "timer") {
      card.append(el("p", "k-timer", w.done ? t("timer_done") : formatRemaining(w.ends_at - now())));
      if (w.done) {
        card.append(el("p", "k-tap-dismiss", t("timer_tap_dismiss")));
        card.setAttribute("role", "button");
        card.setAttribute("aria-label", `${t("timer_done")}. ${t("timer_tap_dismiss")}`);
        card.addEventListener("click", () => dismiss(w.id));
      }
    } else if (w.kind === "nowplaying") {
      // What plays comes from the page's own media state (the server's window carries only its title).
      const np = nowPlaying();
      card.append(el("p", "k-np-title", np ? np.title : t("say_nothing_playing")));
      if (np && (np.subtitle || np.source)) card.append(el("p", "k-np-sub", [np.subtitle, np.source].filter(Boolean).join(" · ")));
      if (np) {
        const row = el("div", "k-np-controls");
        for (const [glyph, key, verb] of NP_BUTTONS) {
          const v = verb || (glyph === "⏯" ? (np.paused ? "resume" : "pause") : np.muted ? "unmute" : "mute");
          const b = el("button", null, glyph);
          b.type = "button";
          b.setAttribute("aria-label", t(key || (v === "resume" ? "media_play" : v === "pause" ? "media_pause" : v === "mute" ? "media_mute" : "media_unmute")));
          b.addEventListener("click", (e) => { e.stopPropagation(); onMedia(v); });
          row.append(b);
        }
        card.append(row);
      }
    } else if (w.kind === "recipe") {
      if (w.ingredients?.length) {
        card.append(el("h3", "k-sub", t("ingredients")));
        const ul = el("ul", "k-ingredients");
        for (const i of w.ingredients) ul.append(el("li", null, i));
        card.append(ul);
      }
      card.append(el("p", "k-step-of", t("step_of").replace("{n}", String(w.step + 1)).replace("{total}", String(w.steps.length))));
      const ol = el("ol", "k-steps");
      w.steps.forEach((s, i) => ol.append(el("li", i === w.step ? "is-current" : null, s)));
      card.append(ol);
    } else {
      for (const b of w.blocks || []) {
        if (b.type === "text") card.append(el("p", null, b.text));
        else if (b.type === "list") { const ul = el("ul"); for (const i of b.items || []) ul.append(el("li", null, i)); card.append(ul); }
        else if (b.type === "card") card.append(el("div", "k-card", b.text || b.title || ""));
        else if (b.type === "divider") card.append(el("hr"));
      }
    }
    const close = el("button", "k-win-close", "×");
    close.type = "button";
    close.setAttribute("aria-label", t("windows_close"));
    close.addEventListener("click", (e) => { e.stopPropagation(); dismiss(w.id); });
    card.append(close);
    swipe(card, w.id);
    return card;
  }
  function render() {
    clearInterval(tick);
    tick = null;
    root.replaceChildren();
    doc.documentElement?.classList.toggle("k-ringing", wins.some((w) => w.done));
    const top = wins[wins.length - 1];
    if (!top) { root.hidden = true; return; }
    root.hidden = false;
    if (wins.length > 1) {
      const rail = el("nav", "k-tabs");
      for (const w of wins) {
        const b = el("button", w === top ? "is-active" : null, w.title);
        b.type = "button";
        b.addEventListener("click", () => { toTop(w.id); onTap(w.id); render(); });
        rail.append(b);
      }
      root.append(rail);
    }
    root.append(body(top));
    if (top.kind === "timer" && !top.done) {
      tick = setInterval(() => { const p = root.querySelector(".k-timer"); if (p) p.textContent = formatRemaining(top.ends_at - now()); }, 1000);
    }
  }
  return {
    apply(m) {
      switch (m.action) {
        case "snapshot": wins = (m.windows || []).slice(); break;
        case "open": wins = [...wins.filter((w) => w.id !== m.window.id), m.window]; break;
        case "update": wins = wins.some((w) => w.id === m.window.id) ? wins.map((w) => (w.id === m.window.id ? m.window : w)) : [...wins, m.window]; break;
        case "close": wins = wins.filter((w) => w.id !== m.id); break;
        case "close_all": wins = []; break;
        case "focus": toTop(m.id); break;
        case "timer_done": wins = wins.map((w) => (w.id === m.id ? { ...w, done: true } : w)); toTop(m.id); break;
        default: return;
      }
      render();
      if (m.action === "timer_done") root.querySelector("article")?.scrollIntoView?.({ block: "nearest" });   // a phone may be scrolled past the pane
    },
    list: () => wins.slice(),
    /** The media state changed: redraw when the window in front is the now-playing one. */
    refresh() { if (wins[wins.length - 1]?.kind === "nowplaying") render(); },
    pause(p) { if (p) { clearInterval(tick); tick = null; } else render(); },
  };
}
