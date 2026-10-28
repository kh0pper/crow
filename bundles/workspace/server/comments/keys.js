// Comment fingerprints, thread keys, snapshots, diff and re-key.
// Pure: no DB, no network, no core imports. parseMentions is injected.
import { createHash } from "node:crypto";

const sha = (s) => createHash("sha256").update(s).digest("hex");
const nfc = (s) => String(s ?? "").normalize("NFC");

/** ms epoch (number or numeric string) or ISO string -> "YYYY-MM-DDTHH:MM:SSZ" (second precision), else null. */
export function isoSecond(v) {
  if (v === null || v === undefined || v === "") return null;
  let ms;
  if (typeof v === "number") ms = v;
  else if (/^\d+$/.test(String(v).trim())) ms = Number(String(v).trim());
  else ms = Date.parse(String(v));
  if (!Number.isFinite(ms)) return null;
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function normText(s) {
  return nfc(s).replace(/\r\n?/g, "\n");
}

export function normQuote(s) {
  return nfc(s).replace(/\s+/g, " ").trim();
}

/** Flat comment list in document order: each root, then its replies. */
export function flatten(threads) {
  const seen = new Map();
  const out = [];
  const push = (t, isRoot, c, quoted) => {
    const author = nfc(c.author);
    const date = isoSecond(c.date);
    const q = normQuote(quoted);
    const k = `${author}|${date}|${q}`;
    // A plugin-supplied occ (computed over ALL comments in document order) wins.
    const occ = Number.isInteger(c.occ) ? c.occ : seen.get(k) || 0;
    seen.set(k, Math.max(seen.get(k) || 0, occ + 1));
    out.push({ t, isRoot, author, date, text: normText(c.text), quoted: q, occ });
  };
  (threads || []).forEach((th, t) => {
    push(t, true, th, th.quoted_text);
    for (const r of th.replies || []) push(t, false, r, th.quoted_text);
  });
  return out;
}

export function fingerprint(c) {
  return sha([nfc(c.author), isoSecond(c.date), normText(c.text), normQuote(c.quoted), c.occ ?? 0].join("|"));
}

/**
 * Quote- and occurrence-free identity: author, second and text. A comment whose anchored text was edited, or whose
 * occ shifted when an earlier same-second duplicate was deleted, keeps it (its slot and fingerprint do not).
 */
export function contentKeyOf(c) {
  return sha([nfc(c.author), isoSecond(c.date), normText(c.text)].join("|"));
}

/** Edit-stable identity: everything but the text. */
export function slotOf(c) {
  return sha([nfc(c.author), isoSecond(c.date), normQuote(c.quoted), c.occ ?? 0].join("|"));
}

export function pairKey(fileId, author, date) {
  return sha([fileId, nfc(author), isoSecond(date)].join("|")).slice(0, 16);
}

export function threadKey(thread, rootFp) {
  return thread && thread.durableId ? "d:" + thread.durableId : "fp:" + rootFp;
}

const toTokens = (r) => (Array.isArray(r) ? r : []).map((x) => (typeof x === "string" ? x : x?.name ?? x?.token ?? String(x)));

export function snapshot(threads, parseMentions) {
  const flat = flatten(threads);
  const parse = typeof parseMentions === "function" ? parseMentions : () => [];
  return (threads || []).map((th, t) => {
    const mine = flat.filter((c) => c.t === t);
    const comments = mine.map((c) => ({ slot: slotOf(c), fp: fingerprint(c), ck: contentKeyOf(c), tokens: toTokens(parse(c.text)) }));
    const rootFp = comments[0].fp;
    const r = mine[0];
    return {
      group: sha([r.author, r.date, r.quoted].join("|")),
      key: threadKey(th, rootFp),
      durableId: th.durableId ?? null,
      rootFp,
      resolved: !!th.resolved,
      comments,
    };
  });
}

/** prev/next are snapshot() outputs (prev may be null). */
export function diff(prev, next) {
  const prevSlots = new Map();
  for (const th of prev || []) for (const c of th.comments) prevSlots.set(c.slot, c);
  const added = [];
  const edited = [];
  for (const th of next || []) {
    for (const c of th.comments) {
      const old = prevSlots.get(c.slot);
      if (!old) added.push({ slot: c.slot, fp: c.fp, tokens: c.tokens, c });
      else if (old.fp !== c.fp) {
        const had = new Set(old.tokens);
        edited.push({ slot: c.slot, fp: c.fp, tokens: c.tokens, newTokens: c.tokens.filter((x) => !had.has(x)), c });
      }
    }
  }
  const nextKeys = new Set((next || []).map((t) => t.key));
  const prevKeys = new Set((prev || []).map((t) => t.key));
  const gone = (prev || []).filter((t) => !nextKeys.has(t.key));
  const fresh = (next || []).filter((t) => !prevKeys.has(t.key));
  const rekeys = [];
  for (const g of gone) {
    const cands = fresh.filter((n) => n.rootFp === g.rootFp);
    if (!cands.length) continue;
    // Several vanished threads sharing (author, date, quote) means a deletion may have shifted
    // occurrences, so fingerprints cannot be trusted to pair them. The same shift can mislabel an
    // edit for near-duplicates (accepted).
    const rivals = gone.filter((o) => o.rootFp === g.rootFp || (g.group && o.group === g.group)).length;
    rekeys.push({ from: g.key, to: cands[0].key, ambiguous: cands.length > 1 || rivals > 1 });
  }
  return { added, edited, rekeys };
}

/**
 * Live ONLYOFFICE comment(s) -> readCommentThreads()-shaped threads.
 * Live Time is epoch ms; floor(Time/1000) equals the saved w:date second.
 * `occs`: plugin-computed occurrences for this thread, root first then replies,
 * computed over all comments in document order. Absent means flatten() recomputes.
 */
export function fromLive(thread, occs) {
  const list = Array.isArray(thread) ? thread : [thread];
  return list.map((l) => ({
    occ: occs?.[0],
    durableId: l.durableId ?? null,
    author: l.UserName,
    date: isoSecond(l.Time),
    text: l.Text,
    quoted_text: l.QuoteText ?? "",
    resolved: !!(l.Solved ?? l.resolved),
    replies: (l.Replies || []).map((r, i) => ({ occ: occs?.[i + 1], author: r.UserName, date: isoSecond(r.Time), text: r.Text })),
  }));
}
