/* Ramble bird genome engine — dependency-free, dual Node/browser. No ESM syntax. */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (typeof window !== "undefined") window.RambleBird = api;
})(this, function () {
  var ROSTER = ["crow","raven","grackle","magpie","mockingbird","hummingbird","penguin","blackswan"];
  var SPECIES = {
    crow:        { name: "Crow",        base: ["#2b2f3a","#1f2230","#343a4a"], crest: 0.15, tail: 1.0,  beak: "#d9a521", size: 1.0 },
    raven:       { name: "Raven",       base: ["#1c1f2b","#262a3a","#2d3347"], crest: 0.35, tail: 1.15, beak: "#3b3b3b", size: 1.1 },
    grackle:     { name: "Grackle",     base: ["#1b3a4b","#2a4f6e","#173d3a"], crest: 0.1,  tail: 1.3,  beak: "#2d2d2d", size: 0.95, sheen: true },
    magpie:      { name: "Magpie",      base: ["#1e2230","#232a3e"], belly: "#f5f1ea", crest: 0.05, tail: 1.4, beak: "#2d2d2d", size: 1.0 },
    mockingbird: { name: "Mockingbird", base: ["#9a9ea8","#8b93a3","#a8adb5"], belly: "#f2efe9", crest: 0.2, tail: 1.2, beak: "#4a4a4a", size: 0.9 },
    hummingbird: { name: "Hummingbird", base: ["#1f9e7a","#2bb38a","#1a7f8f"], belly: "#dff5ea", crest: 0.0, tail: 0.6, beak: "#333333", size: 0.7, longbeak: true },
    penguin:     { name: "Penguin",     base: ["#1f2430","#2a3040"], belly: "#fbfbfb", crest: 0.0, tail: 0.4, beak: "#f2a33a", size: 1.05, feet: "#f2a33a" },
    blackswan:   { name: "Black swan",  base: ["#20222c","#2b2d3a"], crest: 0.0, tail: 0.8, beak: "#d94a4a", size: 1.1, longneck: true }
  };
  var EYES = ["round","sparkle","sleepy","wink"], MARKS = ["none","cheeks","starburst","collar","freckles"], HATS = ["none","none","none","bow","leaf","beanie"];
  var ACCENTS = ["#f7c948","#5b7cff","#ff7a9c","#7bd389","#c77dff","#ff8a5b"];
  var PARTS = { /* name -> path data; body/head are ellipses computed from genome, the rest are here */
    beak: "M0 0 l20 5 l-20 6 z", longbeak: "M0 0 l34 -3 l-33 9 z", foot: "M0 0 v16 m-8 0 h16",
    tail: "M0 0 l-26 -14 l4 22 z", crest: "M0 0 q6 -18 14 -6 q-6 4 -8 10 z",
    bow: "M0 0 l-12 -7 v14 z M0 0 l12 -7 v14 z", leaf: "M0 0 q14 -16 26 -8 q-12 4 -20 14 z", beanie: "M-26 0 q26 -34 52 0 z"
  };
  function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; var t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  function pick(r, arr) { return arr[Math.floor(r() * arr.length)]; }
  function hueShift(hex, deg, sat) {
    var c = parseInt(hex.slice(1), 16), R = c >> 16 & 255, G = c >> 8 & 255, B = c & 255;
    var r = R / 255, g = G / 255, b = B / 255, mx = Math.max(r, g, b), mn = Math.min(r, g, b), h = 0, sl = 0, l = (mx + mn) / 2;
    if (mx !== mn) { var d = mx - mn; sl = l > .5 ? d / (2 - mx - mn) : d / (mx + mn); h = mx === r ? ((g - b) / d + (g < b ? 6 : 0)) : mx === g ? ((b - r) / d + 2) : ((r - g) / d + 4); h /= 6; }
    h = (h + deg / 360 + 1) % 1; sl = Math.max(0, Math.min(1, sl + sat));
    function f(p, q, t) { if (t < 0) t += 1; if (t > 1) t -= 1; if (t < 1 / 6) return p + (q - p) * 6 * t; if (t < 1 / 2) return q; if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6; return p; }
    var q = l < .5 ? l * (1 + sl) : l + sl - l * sl, pp = 2 * l - q;
    var rr = Math.round(f(pp, q, h + 1 / 3) * 255), gg = Math.round(f(pp, q, h) * 255), bb = Math.round(f(pp, q, h - 1 / 3) * 255);
    return "#" + ((1 << 24) + (rr << 16) + (gg << 8) + bb).toString(16).slice(1);
  }
  function isUint32(n) { return Number.isInteger(n) && n >= 0 && n <= 0xffffffff; }
  function rollGenome(seed, species) {
    if (!isUint32(seed)) throw new Error("seed must be a uint32");
    var sp = SPECIES[species]; if (!sp) throw new Error("unknown species: " + species);
    var r = mulberry32(seed ^ (ROSTER.indexOf(species) * 0x9E3779B1));
    var body = pick(r, sp.base);
    return { species: species, seed: seed, body: hueShift(body, Math.round((r() - .5) * 24), (r() - .5) * .1),
      belly: sp.belly || hueShift(body, 0, -.05), accent: pick(r, ACCENTS), eye: pick(r, EYES), mark: pick(r, MARKS), hat: pick(r, HATS),
      size: +(sp.size * (0.9 + r() * 0.2)).toFixed(3), plump: +(0.85 + r() * 0.3).toFixed(3), tilt: +((r() - .5) * 10).toFixed(2) };
  }
  function n(v) { return (+v).toFixed(2); }
  function at(x, y) { return "translate(" + n(x) + " " + n(y) + ")"; }
  function drawBird(g, mood) {
    mood = mood === "tired" || mood === "alarmed" ? mood : "happy";
    var sp = SPECIES[g.species]; if (!sp) throw new Error("unknown species: " + g.species);
    var cx = 100, cy = 118, bw = 46 * g.plump, bh = 42, hr = 30, ex = cx + 10, ey = cy - 50, feet = sp.feet || "#c98a3a";
    var eye;
    if (mood === "tired" || g.eye === "sleepy") eye = '<path d="M' + n(ex - 7) + ' ' + n(ey) + ' q 7 5 14 0" stroke="#1a1a1a" stroke-width="3" fill="none" stroke-linecap="round"/>';
    else if (g.eye === "wink") eye = '<circle cx="' + n(ex) + '" cy="' + n(ey) + '" r="6" fill="#1a1a1a"/><circle cx="' + n(ex + 2) + '" cy="' + n(ey - 2) + '" r="2" fill="#fff"/>';
    else eye = '<circle cx="' + n(ex) + '" cy="' + n(ey) + '" r="7" fill="#1a1a1a"/><circle cx="' + n(ex + 2.5) + '" cy="' + n(ey - 2.5) + '" r="2.6" fill="#fff"/>' + (g.eye === "sparkle" ? '<circle cx="' + n(ex - 3) + '" cy="' + n(ey + 3) + '" r="1.3" fill="#fff"/>' : "");
    var cheeks = (g.mark === "cheeks" || mood === "happy") ? '<ellipse cx="' + n(cx - 6) + '" cy="' + n(cy - 40) + '" rx="7" ry="4" fill="#ff8fa3" opacity=".55"/>' : "";
    var marks = "";
    if (g.mark === "starburst") marks = '<path transform="' + at(cx - 30, cy - 60) + '" d="M0 0 l3 6 6 1 -4 4 1 6 -6 -3 -6 3 1 -6 -4 -4 6 -1z" fill="' + g.accent + '"/>';
    if (g.mark === "collar") marks = '<path d="M' + n(cx - 26) + ' ' + n(cy - 22) + ' q 26 14 52 0" stroke="' + g.accent + '" stroke-width="6" fill="none" stroke-linecap="round"/>';
    if (g.mark === "freckles") marks = '<g fill="' + g.accent + '" opacity=".8"><circle cx="' + n(cx - 4) + '" cy="' + n(cy - 36) + '" r="1.8"/><circle cx="' + n(cx + 2) + '" cy="' + n(cy - 33) + '" r="1.8"/><circle cx="' + n(cx - 9) + '" cy="' + n(cy - 31) + '" r="1.8"/></g>';
    var hat = "";
    if (g.hat === "bow") hat = '<g transform="' + at(cx - 18, cy - 78) + '"><path d="' + PARTS.bow + '" fill="' + g.accent + '"/><circle r="3.5" fill="#fff"/></g>';
    if (g.hat === "leaf") hat = '<path transform="' + at(cx, cy - 78) + '" d="' + PARTS.leaf + '" fill="#7bd389"/>';
    if (g.hat === "beanie") hat = '<path transform="' + at(cx, cy - 66) + '" d="' + PARTS.beanie + '" fill="' + g.accent + '"/><circle cx="' + n(cx) + '" cy="' + n(cy - 84) + '" r="5" fill="#fff"/>';
    var crest = sp.crest > 0 ? '<path transform="' + at(cx - 4, cy - 76) + ' scale(1 ' + n(sp.crest * 4) + ')" d="' + PARTS.crest + '" fill="' + g.body + '"/>' : "";
    var neck = sp.longneck ? '<rect x="' + n(cx - 8) + '" y="' + n(cy - 60) + '" width="16" height="30" rx="8" fill="' + g.body + '"/>' : "";
    var tail = '<path transform="' + at(cx - bw + 6, cy - 6) + ' scale(' + n(sp.tail) + ' 1)" d="' + PARTS.tail + '" fill="' + g.body + '"/>';
    var beakD = sp.longbeak ? PARTS.longbeak : PARTS.beak;
    var beak = '<path transform="' + at(cx + 22, cy - 46) + '" d="' + beakD + '" fill="' + sp.beak + '"/>';
    var wingDrop = mood === "alarmed" ? -6 : 0;
    var feetSvg = '<g stroke="' + feet + '" stroke-width="4" stroke-linecap="round" fill="none"><path transform="' + at(cx - 12, cy + 34) + '" d="' + PARTS.foot + '"/><path transform="' + at(cx + 12, cy + 34) + '" d="' + PARTS.foot + '"/></g>';
    var alarm = mood === "alarmed" ? '<text x="' + n(cx + 34) + '" y="' + n(cy - 70) + '" font-size="26" font-weight="800" fill="#ef4444" font-family="Baloo 2, sans-serif">!</text>' : "";
    return '<g transform="' + at(cx, cy) + ' rotate(' + n(g.tilt) + ') scale(' + n(g.size) + ') ' + at(-cx, -cy) + '">' +
      feetSvg + tail +
      '<ellipse cx="' + n(cx) + '" cy="' + n(cy) + '" rx="' + n(bw) + '" ry="' + n(bh) + '" fill="' + g.body + '"/>' +
      '<ellipse cx="' + n(cx + 4) + '" cy="' + n(cy + 8) + '" rx="' + n(bw * .62) + '" ry="' + n(bh * .62) + '" fill="' + g.belly + '" opacity=".95"/>' +
      '<ellipse cx="' + n(cx - 22) + '" cy="' + n(cy + 2 + wingDrop) + '" rx="18" ry="24" fill="' + hueShift(g.body, 0, .08) + '" opacity=".9" transform="rotate(-12 ' + n(cx - 22) + ' ' + n(cy + 2) + ')"/>' +
      (sp.sheen ? '<ellipse cx="' + n(cx - 10) + '" cy="' + n(cy - 18) + '" rx="16" ry="8" fill="#7ad3ff" opacity=".25"/>' : "") +
      neck + '<circle cx="' + n(cx) + '" cy="' + n(cy - 50) + '" r="' + n(hr) + '" fill="' + g.body + '"/>' +
      crest + hat + marks + cheeks + eye + beak + alarm + '</g>';
  }
  function drawEgg(seed) {
    if (!isUint32(seed)) throw new Error("seed must be a uint32");
    var r = mulberry32(seed), shell = pick(r, ["#fff4d6","#e8f6f2","#f7e6ff","#ffe9e0","#eef3ff"]), spots = pick(r, ACCENTS), dots = "";
    for (var i = 0; i < 7; i++) dots += '<circle cx="' + n(30 + r() * 60) + '" cy="' + n(40 + r() * 90) + '" r="' + n(3 + r() * 5) + '" fill="' + spots + '" opacity=".7"/>';
    return '<path d="M60 8 C 92 8 108 60 108 92 C 108 126 86 144 60 144 C 34 144 12 126 12 92 C 12 60 28 8 60 8 z" fill="' + shell + '" stroke="#e6d9c8" stroke-width="3"/>' + dots + '<ellipse cx="44" cy="40" rx="10" ry="16" fill="#fff" opacity=".55"/>';
  }
  function mountBird(el, g, mood) { el.setAttribute("viewBox", "0 0 200 200"); el.innerHTML = drawBird(g, mood); }
  /* The egg is not carried, it IS the walker: legs beneath the same shell,
   * reusing the bird's own foot shape and its wrapping group (foot is a
   * stroke path and draws nothing without it). drawEgg's path bottoms at
   * y=144 and a foot is 16 tall, so this needs the taller viewBox. */
  function drawWalkingEgg(seed) {
    var eggFeet = '<g stroke="#c98a3a" stroke-width="4" stroke-linecap="round" fill="none"><path transform="' + at(38, 144) + '" d="' + PARTS.foot + '"/><path transform="' + at(82, 144) + '" d="' + PARTS.foot + '"/></g>';
    return drawEgg(seed) + eggFeet;
  }
  function mountWalkingEgg(el, seed) { el.setAttribute("viewBox", "0 0 120 168"); el.innerHTML = drawWalkingEgg(seed); }
  /* A grain of birdseed. It has to read as FOOD at about 14 px, which a plain
   * dot never did — so: an almond husk with a seam and a highlight, warm
   * against a blue-grey map, which is also what makes it findable at a glance.
   * Same palette family as the egg's feet, so it belongs to this world. */
  function drawSeed() {
    return '<g transform="rotate(-20 12 12)">'
      + '<ellipse cx="12" cy="12" rx="5.4" ry="8" fill="#e8b256" stroke="#8a5a1e" stroke-width="1.7"/>'
      + '<path d="M12 5 L12 19" stroke="#8a5a1e" stroke-width="1.1" opacity="0.5"/>'
      + '<ellipse cx="9.7" cy="8.7" rx="1.4" ry="2.3" fill="#fff8e6" opacity="0.5"/>'
      + '</g>';
  }
  function mountSeed(el) { el.setAttribute("viewBox", "0 0 24 24"); el.innerHTML = drawSeed(); }
  /* The rare counterpart to the seed. Same warm family and the same highlight
   * placement so the two read as one set, but deeper and richer, because this
   * is the thing you go out of your way for. Flat fills only: it renders at
   * 18px on a map and inline in a sentence on the pet page. */
  function drawHeart() {
    return '<path d="M12 20.5 C5.4 15.9 2.8 12.6 2.8 9.2 C2.8 6.4 4.9 4.3 7.5 4.3'
      + ' C9.4 4.3 11 5.3 12 6.9 C13 5.3 14.6 4.3 16.5 4.3 C19.1 4.3 21.2 6.4 21.2 9.2'
      + ' C21.2 12.6 18.6 15.9 12 20.5 Z" fill="#d8556a" stroke="#8f2438" stroke-width="1.6"'
      + ' stroke-linejoin="round"/>'
      + '<ellipse cx="8.4" cy="8.6" rx="1.5" ry="2.2" fill="#fff2f4" opacity="0.55"'
      + ' transform="rotate(-25 8.4 8.6)"/>';
  }
  function mountHeart(el) { el.setAttribute("viewBox", "0 0 24 24"); el.innerHTML = drawHeart(); }
  function isValidBird(x) { return !!x && typeof x === "object" && ROSTER.indexOf(x.species) >= 0 && isUint32(x.seed); }
  return { ROSTER: ROSTER, SPECIES: SPECIES, PARTS: PARTS, rollGenome: rollGenome, drawBird: drawBird, drawEgg: drawEgg, drawWalkingEgg: drawWalkingEgg, drawSeed: drawSeed, drawHeart: drawHeart, mountBird: mountBird, mountWalkingEgg: mountWalkingEgg, mountSeed: mountSeed, mountHeart: mountHeart, isValidBird: isValidBird };
});
