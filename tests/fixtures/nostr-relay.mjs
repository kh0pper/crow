/**
 * A minimal NIP-01 Nostr relay on 127.0.0.1 (an ephemeral port), for
 * multi-process tests that must never touch a public relay.
 *
 * startNostrRelay() → { url, close(), events }:
 * - ["EVENT", ev]        → verifyEvent; stored once per id; ["OK", id, ok, msg];
 *                          then fanned out to every matching live subscription.
 * - ["REQ", sub, ...f]   → stored matches (ids / kinds / authors / #<tag> /
 *                          since / until / limit, newest first per filter),
 *                          ["EOSE", sub], then live events.
 * - ["CLOSE", sub]       → the subscription ends.
 */
import { WebSocketServer } from "ws";
import { verifyEvent } from "nostr-tools/pure";

function matches(f, ev) {
  if (!f || typeof f !== "object") return false;
  if (Array.isArray(f.ids) && !f.ids.includes(ev.id)) return false;
  if (Array.isArray(f.kinds) && !f.kinds.includes(ev.kind)) return false;
  if (Array.isArray(f.authors) && !f.authors.includes(ev.pubkey)) return false;
  if (Number.isFinite(f.since) && ev.created_at < f.since) return false;
  if (Number.isFinite(f.until) && ev.created_at > f.until) return false;
  for (const [k, vals] of Object.entries(f)) {
    if (k[0] !== "#" || !Array.isArray(vals)) continue;
    const name = k.slice(1);
    if (!ev.tags.some((t) => t[0] === name && vals.includes(t[1]))) return false;
  }
  return true;
}

export async function startNostrRelay() {
  const events = [];      // stored, in arrival order
  const ids = new Set();
  const subs = new Set(); // { ws, id, filters }
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((resolve, reject) => { wss.once("listening", resolve); wss.once("error", reject); });
  const send = (ws, msg) => { try { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); } catch {} };

  wss.on("connection", (ws) => {
    ws.on("error", () => {});
    ws.on("close", () => { for (const s of subs) if (s.ws === ws) subs.delete(s); });
    ws.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      if (!Array.isArray(msg)) return;
      const [type, ...rest] = msg;
      if (type === "EVENT") {
        const ev = rest[0];
        let ok = false;
        try { ok = !!ev && verifyEvent(ev); } catch { ok = false; }
        if (!ok) { send(ws, ["OK", ev?.id ?? "", false, "invalid: bad event"]); return; }
        if (ids.has(ev.id)) { send(ws, ["OK", ev.id, true, "duplicate:"]); return; }
        ids.add(ev.id);
        events.push(ev);
        send(ws, ["OK", ev.id, true, ""]);
        for (const s of subs) if (s.filters.some((f) => matches(f, ev))) send(s.ws, ["EVENT", s.id, ev]);
      } else if (type === "REQ") {
        const [subId, ...filters] = rest;
        if (typeof subId !== "string") return;
        for (const s of subs) if (s.ws === ws && s.id === subId) subs.delete(s);
        const seen = new Set();
        const out = [];
        for (const f of filters) {
          let hits = events.filter((ev) => matches(f, ev)).sort((a, b) => b.created_at - a.created_at);
          if (Number.isFinite(f?.limit)) hits = hits.slice(0, Math.max(0, f.limit));
          for (const ev of hits) if (!seen.has(ev.id)) { seen.add(ev.id); out.push(ev); }
        }
        for (const ev of out) send(ws, ["EVENT", subId, ev]);
        send(ws, ["EOSE", subId]);
        subs.add({ ws, id: subId, filters });
      } else if (type === "CLOSE") {
        for (const s of subs) if (s.ws === ws && s.id === rest[0]) subs.delete(s);
      }
    });
  });

  const { port } = wss.address();
  return {
    url: `ws://127.0.0.1:${port}`,
    events,
    async close() {
      for (const c of wss.clients) { try { c.terminate(); } catch {} }
      await new Promise((r) => wss.close(() => r()));
    },
  };
}
