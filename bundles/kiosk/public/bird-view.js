/** The bird: drawn by the Ramble engine with class hooks; every animation is CSS (no rAF). */
export function mountBird(container, bird, { animate = true } = {}) {
  const RB = window.RambleBird;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 200 200");
  svg.setAttribute("class", "k-bird-svg");
  svg.setAttribute("aria-hidden", "true");
  let mood = bird.mood;
  let genome = RB.rollGenome(bird.seed, bird.species);
  if (bird.outfit && typeof RB.applyOutfit === "function") genome = RB.applyOutfit(genome, bird.outfit);
  const draw = () => { svg.innerHTML = RB.drawBird(genome, mood, { hooks: true }); };
  draw();
  container.replaceChildren(svg);
  let blink = null, unblink = null, disposed = false;
  const scheduleBlink = () => {
    if (!animate || disposed) return;
    blink = setTimeout(() => {
      container.classList.add("blink");
      unblink = setTimeout(() => { unblink = null; container.classList.remove("blink"); }, 160);
      scheduleBlink();
    }, 4000 + Math.random() * 5000);
  };
  scheduleBlink();
  const host = container.closest(".k-bird") || container;
  return {
    setState(s) { for (const k of ["idle", "listening", "thinking", "speaking"]) host.classList.toggle("is-" + k, k === s); },
    setLevel(v) { host.style.setProperty("--beak", String(Math.round(v * 100) / 100)); },
    setMood(m) { if (m !== mood) { mood = m; draw(); } },
    pause(p) { if (p) { clearTimeout(blink); blink = null; } else if (!blink) scheduleBlink(); },
    /** Stop every timer (a remount on reconnect must not leave a second blink chain running). */
    dispose() { disposed = true; clearTimeout(blink); clearTimeout(unblink); blink = unblink = null; container.classList.remove("blink"); },
  };
}
