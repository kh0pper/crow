/**
 * Sound-alike keys for station names (smoke 2026-10-06 F1). Speech-to-text writes a call sign the way
 * it heard it: a made-up "KTPF" comes back as "KDBF", "KDPV", "Cadypef", "Cady PF", "kay tee pee eff",
 * "K-T-P-V-H-D-2". Each of those keeps the CONSONANT SOUNDS of the name. A sound key is that
 * skeleton: every word read two ways (as a word, and as spelled letters by their English names),
 * consonants folded into classes that speech-to-text confuses (p/b, t/d, k/g/c/q, f/v/ph, s/z,
 * j/ch/sh/soft g and the letters g/h/j, m/n), vowels dropped, repeats collapsed. Digits stay digits and
 * must match exactly ("HD2" is never "HD3").
 *
 * Input is already a station key (stations.js stationKey: words, number words as digits, fillers gone).
 * Pure; no pattern is built from data.
 */
const VOWELS = new Set(["a", "e", "i", "o", "u", "y"]);
/** Plain consonant → class. */
const CLASS = Object.freeze({ b: "P", p: "P", d: "T", t: "T", k: "K", q: "K", f: "F", v: "F", s: "S", z: "S", j: "J", m: "M", n: "M", l: "L", r: "R" });
/** A letter spoken by its English name → the consonant class of that name ("aitch" → J, "double u" → T P L). */
// A letter whose name is a vowel sound (a, e, i, o, u, y) is still a spoken syllable: it is kept as "A", so
// "w x" never sounds like "w x y z" once the repeats are collapsed.
const LETTER_NAME = Object.freeze({ a: "A", b: "P", c: "S", d: "T", e: "A", f: "F", g: "J", h: "J", i: "A", j: "J", k: "K", l: "L", m: "M", n: "M", o: "A",
  p: "P", q: "K", r: "R", s: "S", t: "T", u: "A", v: "F", w: "TPL", x: "KS", y: "A", z: "S" });
const isDigit = (c) => c >= "0" && c <= "9";
const isLetters = (w) => { for (const c of w) if (c < "a" || c > "z") return false; return w.length > 0; };

/** "cadypef" → "KTPF" (the word read as a word). */
export function wordSound(w) {
  let out = "";
  for (let i = 0; i < w.length; i += 1) {
    const c = w[i], n = w[i + 1] || "";
    if (isDigit(c)) { out += c; continue; }
    if (VOWELS.has(c)) continue;
    const two = c + n;
    if (two === "ph") { out += "F"; i += 1; continue; }
    if (two === "ch" || two === "sh") { out += "J"; i += 1; continue; }
    if (two === "th") { out += "T"; i += 1; continue; }
    if (two === "ck" || two === "qu") { out += "K"; i += 1; continue; }
    if (two === "gh") { i += 1; continue; }
    if (c === "c") { out += n === "e" || n === "i" || n === "y" ? "S" : "K"; continue; }
    if (c === "g") { out += n === "e" || n === "i" || n === "y" ? "J" : "K"; continue; }
    if (c === "x") { out += "KS"; continue; }
    if (c === "h" || c === "w") continue;
    out += CLASS[c] || "";
  }
  return out;
}
/** "kdbf" → "KTPF" (the word read as spelled letters). Only all-letter words of up to 6 letters are call signs. */
export function letterSound(w) {
  if (!isLetters(w) || w.length > 6) return null;
  let out = "";
  for (const c of w) out += LETTER_NAME[c];
  return out;
}
const collapse = (s) => { let o = ""; for (const c of s) if (c !== o.at(-1) || isDigit(c)) o += c; return o; };
export const MAX_VARIANTS = 64;

/** A station key ("ktpf hd 2") → its distinct sound keys ("KTPFJT2", "KTPFT2", …), at most MAX_VARIANTS. */
export function soundKeys(key) {
  const words = String(key || "").split(" ").filter(Boolean).slice(0, 8);
  let acc = [""];
  for (const w of words) {
    const reads = new Set([wordSound(w)]);
    const l = letterSound(w);
    if (l !== null) reads.add(l);
    const next = [];
    for (const a of acc) for (const r of reads) next.push(a + r);
    acc = [...new Set(next)].slice(0, MAX_VARIANTS);
  }
  return [...new Set(acc.map(collapse))].filter(Boolean);
}
/** Consonant sounds in a key (digits and spoken vowel letters do not count): fewer than three says too little to be matched by sound. */
export const consonants = (k) => { let n = 0; for (const c of k) if (!isDigit(c) && c !== "A") n += 1; return n; };

/** Edit distance with a digit never substituted for anything else (a digit mismatch is a different station). */
export function soundDistance(a, b, cap = 3) {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j += 1) {
      const same = a[i - 1] === b[j - 1];
      const sub = same ? 0 : isDigit(a[i - 1]) || isDigit(b[j - 1]) ? cap + 1 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + sub);
      best = Math.min(best, cur[j]);
    }
    if (best > cap) return cap + 1;
    prev = cur;
  }
  return Math.min(prev[b.length], cap + 1);
}
/** The smallest distance between any sound key of one and of the other. */
export function bestDistance(qs, ks, cap = 3) {
  let d = cap + 1;
  for (const q of qs) for (const k of ks) { d = Math.min(d, q === k ? 0 : soundDistance(q, k, cap)); if (d === 0) return 0; }
  return d;
}
