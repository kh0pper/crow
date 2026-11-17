/* Ramble Moves figure engine — dependency-free, dual Node/browser. No ESM syntax.
 *
 * Sources for every number below:
 *  - Segment lengths (fraction of body height): Drillis & Contini (1966), as
 *    reproduced in Winter, "Biomechanics and Motor Control of Human Movement"
 *    (segment lengths as a fraction of height H, Fig. 4.1). Derived from its
 *    height landmarks: shoulder 0.818H, chin 0.870H, hip 0.530H, knee 0.285H,
 *    ankle 0.039H; foot length 0.152H; upper arm 0.186H, forearm 0.146H,
 *    hand 0.108H. NOT YET CHECKED against the printed figure (the landmark
 *    values are from memory): every SEGMENTS value carries "// VERIFY" until
 *    someone reads it off the book.
 *  - Joint ranges (sagittal plane, side view): AAOS normal range of motion
 *    ("Joint Motion: Method of Measuring and Recording"), checked 2026-10-30
 *    against the AAOS table in Hendriks et al., Plast Reconstr Surg Glob Open
 *    (2020), Supplementary Digital Content 1. Flexion positive, extension
 *    negative, one { min, max } per joint. The spine row is not in that table
 *    and stays "// VERIFY".
 *
 * Angle convention (side view, figure faces right, degrees):
 *  - Joint angles are RELATIVE to the parent segment; flexion is positive.
 *  - rootAngle is the pelvis/trunk angle from vertical, forward lean positive
 *    (negative leans back, e.g. lying on the back ≈ -90).
 *  - A limb's absolute angle = joint angle − parent trunk tilt, so holding a
 *    hip/shoulder angle keeps the limb fixed in space while the trunk rotates
 *    (a forward fold at hip 90 keeps the legs vertical).
 *  - spine bends the upper trunk relative to the pelvis; neck bends the head
 *    relative to the upper trunk. Knee flexion swings the shank BACKWARD
 *    (heel to butt), elbow flexion swings the forearm FORWARD, ankle
 *    dorsiflexion lifts the toes, wrist flexion curls the hand forward.
 *  - Left and right limbs lie in the same sagittal plane; the far side is
 *    drawn slightly lighter (poseSvg), never offset.
 *  - solve() returns joints in px with the ground at y=0 (up is negative y),
 *    x centered on the figure's bounding box.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (typeof window !== "undefined") window.RambleFigure = api;
})(this, function () {
  /* Segment lengths as a fraction of height — Drillis & Contini via Winter (see header). */
  var SEGMENTS = {
    neck: 0.0520,     // shoulder 0.818H to chin 0.870H // VERIFY
    head: 0.1300,     // chin 0.870H to crown 1.000H // VERIFY
    trunk: 0.2880,    // hip 0.530H to shoulder 0.818H // VERIFY
    upperArm: 0.1860, // VERIFY
    forearm: 0.1460,  // VERIFY
    hand: 0.1080,     // VERIFY
    thigh: 0.2450,    // hip 0.530H to knee 0.285H // VERIFY
    shank: 0.2460,    // knee 0.285H to ankle 0.039H // VERIFY
    foot: 0.1520,     // foot length // VERIFY
    footHeight: 0.0390 // ankle 0.039H above the sole // VERIFY
  };
  /* Sagittal-plane normal ROM — AAOS "Joint Motion". Flexion positive. */
  var JOINT_LIMITS = {
    neck:     { min: -45, max: 45 },   // flexion 45 / extension 45
    spine:    { min: -25, max: 60 },   // lumbar flexion 60 / extension 25 // VERIFY (extension 25 vs 30)
    shoulder: { min: -60, max: 180 },  // flexion 180 / extension 60
    elbow:    { min: 0, max: 150 },    // flexion 150, extension 0
    wrist:    { min: -70, max: 80 },   // flexion 80 / extension 70
    hip:      { min: -20, max: 120 },  // flexion 120 / extension 20
    knee:     { min: 0, max: 135 },    // flexion 135, extension 0 (no hyperextension)
    ankle:    { min: -50, max: 20 }    // dorsiflexion 20 / plantarflexion 50
  };
  /* rootAngle is the trunk's own tilt, not an AAOS joint range: these are
   * engine safety bounds (supine ≈ -90, a deep fold past horizontal ≈ +160). */
  var ROOT_LIMIT = { min: -120, max: 170 };
  var SUPPORTS = ["feet", "hands_feet", "seat", "back", "knees"];
  /* The NAMED contacts per support mode. solve() drops the figure until the
   * lowest of these sits at y=0; anything else lower than that would be
   * through the floor, which is the pose's fault (tests reject it), not
   * something the engine hides by grounding on a part the pose doesn't claim. */
  var SUPPORT_POINTS = {
    feet: ["heelL", "toeL", "heelR", "toeR"],
    hands_feet: ["handL", "handR", "heelL", "toeL", "heelR", "toeR"],
    seat: ["hip"],
    back: ["hip", "shoulder"],
    knees: ["kneeL", "kneeR"]
  };
  var ANGLE_KEYS = ["neck", "spine",
    "shoulderL", "elbowL", "wristL", "shoulderR", "elbowR", "wristR",
    "hipL", "kneeL", "ankleL", "hipR", "kneeR", "ankleR", "rootAngle"];
  /* The ankle sits ~35% along the foot from the heel (a drawing constant).
   * Wrist angles in this 2D side view are DRAWN angles: a flat hand on the
   * floor in downward dog is shown, not a claim about anatomical wrist motion. */
  var HEEL_FRAC = 0.35;
  /* Seated, the hip joint centre sits above the floor by the buttock (ischial
   * tuberosity and soft tissue), about 0.05H. A drawing approximation. // VERIFY */
  var SEAT_HEIGHT_FRAC = 0.05;

  function isNum(v) { return typeof v === "number" && isFinite(v); }
  function rad(d) { return d * Math.PI / 180; }
  function pt(x, y) { return { x: x, y: y }; }
  function add(a, b) { return pt(a.x + b.x, a.y + b.y); }
  /* Offset along a limb at absolute angle a from DOWN-vertical (+y is screen-down). */
  function down(a, len) { var r = rad(a); return pt(Math.sin(r) * len, Math.cos(r) * len); }
  /* Offset along the trunk/head at absolute angle a from UP-vertical. */
  function up(a, len) { var r = rad(a); return pt(Math.sin(r) * len, -Math.cos(r) * len); }
  function limitFor(k) { return k === "rootAngle" ? ROOT_LIMIT : JOINT_LIMITS[k.replace(/[LR]$/, "")]; }
  function clampAngle(v, lim) { var d = isNum(v) ? v : 0; return d < lim.min ? lim.min : d > lim.max ? lim.max : d; }
  /* Normalizes into a full pose: every angle key present and clamped, support
   * from the fixed vocabulary (default "feet"). A NEW object — iterating OUR
   * key list, never the input's, so junk and __proto__ keys are dropped. */
  function clampPose(pose) {
    pose = (pose && typeof pose === "object") ? pose : {};
    var out = {}, i, k;
    for (i = 0; i < ANGLE_KEYS.length; i++) { k = ANGLE_KEYS[i]; out[k] = clampAngle(pose[k], limitFor(k)); }
    out.support = SUPPORTS.indexOf(pose.support) >= 0 ? pose.support : "feet";
    return out;
  }
  function armChain(joints, side, shoulderPt, trunkU, shoulderAng, elbowAng, wristAng, seg) {
    var armA = shoulderAng - trunkU;              // absolute, from down-vertical
    var elbow = add(shoulderPt, down(armA, seg.upperArm));
    var foreA = armA + elbowAng;
    var wrist = add(elbow, down(foreA, seg.forearm));
    joints["elbow" + side] = elbow;
    joints["wrist" + side] = wrist;
    joints["hand" + side] = add(wrist, down(foreA + wristAng, seg.hand));
  }
  function legChain(joints, side, hipPt, rootAngle, hipAng, kneeAng, ankleAng, seg) {
    var thighA = hipAng - rootAngle;              // absolute, from down-vertical
    var knee = add(hipPt, down(thighA, seg.thigh));
    var shinA = thighA - kneeAng;                 // knee flexion swings the shank backward
    var ankle = add(knee, down(shinA, seg.shank));
    var footA = shinA + ankleAng;                 // from forward-horizontal, positive = toes up
    var fr = rad(footA), fx = Math.cos(fr), fy = -Math.sin(fr);
    /* The sole sits footHeight below the ankle, square to the foot. */
    var sole = pt(ankle.x + Math.sin(fr) * seg.footHeight, ankle.y + Math.cos(fr) * seg.footHeight);
    joints["knee" + side] = knee;
    joints["ankle" + side] = ankle;
    joints["toe" + side] = pt(sole.x + fx * seg.foot * (1 - HEEL_FRAC), sole.y + fy * seg.foot * (1 - HEEL_FRAC));
    joints["heel" + side] = pt(sole.x - fx * seg.foot * HEEL_FRAC, sole.y - fy * seg.foot * HEEL_FRAC);
  }
  /* Forward kinematics: joints in px, ground at y=0 (up negative), x centered.
   * Defensive: the pose is clamped first, so no angle can produce NaN. */
  function solve(pose, heightPx) {
    var p = clampPose(pose);
    var H = isNum(heightPx) && heightPx > 0 ? heightPx : 100;
    var seg = {}, k;
    for (k in SEGMENTS) if (Object.prototype.hasOwnProperty.call(SEGMENTS, k)) seg[k] = SEGMENTS[k] * H;
    var trunkU = p.rootAngle + p.spine;           // upper-trunk orientation
    var joints = {};
    joints.hip = pt(0, 0);
    joints.mid = add(joints.hip, up(p.rootAngle, seg.trunk / 2));
    joints.shoulder = add(joints.mid, up(trunkU, seg.trunk / 2));
    joints.chin = add(joints.shoulder, up(trunkU + p.neck, seg.neck));
    joints.head = add(joints.chin, up(trunkU + p.neck, seg.head * 0.5));
    armChain(joints, "L", joints.shoulder, trunkU, p.shoulderL, p.elbowL, p.wristL, seg);
    armChain(joints, "R", joints.shoulder, trunkU, p.shoulderR, p.elbowR, p.wristR, seg);
    legChain(joints, "L", joints.hip, p.rootAngle, p.hipL, p.kneeL, p.ankleL, seg);
    legChain(joints, "R", joints.hip, p.rootAngle, p.hipR, p.kneeR, p.ankleR, seg);
    /* Ground: drop the figure until the lowest support point touches y=0. */
    var names = SUPPORT_POINTS[p.support] || SUPPORT_POINTS.feet;
    var lowest = -Infinity, i;
    for (i = 0; i < names.length; i++) lowest = Math.max(lowest, joints[names[i]].y);
    if (p.support === "seat") lowest += SEAT_HEIGHT_FRAC * H;   // the hip rides above the floor
    var minX = Infinity, maxX = -Infinity;
    for (k in joints) {
      if (!Object.prototype.hasOwnProperty.call(joints, k)) continue;
      minX = Math.min(minX, joints[k].x);
      maxX = Math.max(maxX, joints[k].x);
    }
    var shiftX = -(minX + maxX) / 2;
    for (k in joints) {
      if (!Object.prototype.hasOwnProperty.call(joints, k)) continue;
      joints[k] = pt(joints[k].x + shiftX, joints[k].y - lowest);
    }
    return { joints: joints };
  }
  /* Per-angle eased blend (smoothstep). t<=0 and t>=1 return exact copies of
   * the clamped endpoints, so an animation lands precisely on its key poses. */
  function interpolate(a, b, t) {
    var ca = clampPose(a), cb = clampPose(b);
    if (!isNum(t) || t <= 0) return copyPose(ca);
    if (t >= 1) return copyPose(cb);
    var s = t * t * (3 - 2 * t), out = {}, i, k;
    for (i = 0; i < ANGLE_KEYS.length; i++) {
      k = ANGLE_KEYS[i];
      out[k] = clampAngle(ca[k] + (cb[k] - ca[k]) * s, limitFor(k));
    }
    out.support = t < 0.5 ? ca.support : cb.support;
    return out;
  }
  /* Per-angle LINEAR blend (no easing): one rep of an exercise is one steady
   * trip from its first key position to its second, so the pace belongs to the
   * entry's own tempo and not to a curve. t<=0 and t>=1 return exact copies of
   * the clamped endpoints, the same way interpolate does. */
  function tween(poseA, poseB, t) {
    var ca = clampPose(poseA), cb = clampPose(poseB);
    if (!isNum(t) || t <= 0) return copyPose(ca);
    if (t >= 1) return copyPose(cb);
    var out = {}, i, k;
    for (i = 0; i < ANGLE_KEYS.length; i++) {
      k = ANGLE_KEYS[i];
      out[k] = clampAngle(ca[k] + (cb[k] - ca[k]) * t, limitFor(k));
    }
    out.support = t < 0.5 ? ca.support : cb.support;
    return out;
  }
  function copyPose(p) {
    var out = {}, k;
    for (k in p) if (Object.prototype.hasOwnProperty.call(p, k)) out[k] = p[k];
    return out;
  }
  function n(v) { return ((Math.round(v * 10) / 10) + 0).toFixed(1); }
  function line(a, b) { return '<line x1="' + n(a.x) + '" y1="' + n(a.y) + '" x2="' + n(b.x) + '" y2="' + n(b.y) + '"/>'; }
  function has(obj, key) { return !!obj && Object.prototype.hasOwnProperty.call(obj, key); }

  /* ── Decoration layers: colour bands, arrows and labels ───────────────────
   * Segment names are the vocabulary's own (SEGMENT_JOINTS), plus "head" for
   * the head circle. All of it is optional: with no bands, arrows, labels or
   * layers, poseSvg emits exactly the markup it always has. Unknown segment
   * names, unknown directions and non-array opts are dropped silently, and
   * every value written into the markup is a number computed here or an
   * escaped string — so a junk opts object can never reach the markup. */
  var BAND_WORKING = "#2f6fdb";       /* working segment */
  var BAND_LENGTHENING = "#c8423b";   /* lengthening segment */
  var BAND_WIDTH = 7;                 /* thick enough to sit over the base 4.4 */
  var BAND_DASH = "5 4";              /* lengthening is dashed, so colour is never the only signal */
  var JOINT_DOT = 1.7;
  var SKELETON_FILL = "#2b2f3a";
  var NERVE_WIDTH = 1.2;
  var NERVE_DASH = "1 3";
  var ARROW_LEN = 9;                  /* shorter than headR + 4: an arrow stays inside the frame */
  var ARROW_HEAD = 3.2;
  var ARROW_WIDTH = 2;
  var LABEL_FONT = 9;
  var LABEL_LINE = 12;                /* vertical step between stacked labels */
  var LABEL_GAP = 6;                  /* gap between the figure box and the label column */
  var LABEL_CHAR = 0.58;              /* approximate advance per character, in font sizes */
  var LABEL_MAX = 40;                 /* characters of label text, before escaping */
  var LABEL_STROKE = "#8a8f9c";
  var LABEL_STROKE_WIDTH = 1;
  /* Segment name -> the solved joints it joins. Limbs list the near side first,
   * which is the one a label's leader line starts from. */
  var SEGMENT_JOINTS = {
    torso: [["mid", "shoulder"]],
    pelvis: [["hip", "mid"]],
    neck: [["shoulder", "chin"]],
    upperArm: [["shoulder", "elbowL"], ["shoulder", "elbowR"]],
    forearm: [["elbowL", "wristL"], ["elbowR", "wristR"]],
    hand: [["wristL", "handL"], ["wristR", "handR"]],
    thigh: [["hip", "kneeL"], ["hip", "kneeR"]],
    shin: [["kneeL", "ankleL"], ["kneeR", "ankleR"]],
    foot: [["heelL", "toeL"], ["heelR", "toeR"]]
  };
  /* Arrow anchor -> solved joint. Near side, as drawn. */
  var ARROW_FROM = {
    hands: "wristL", feet: "ankleL", knees: "kneeL", hips: "hip", elbows: "elbowL",
    shoulders: "shoulder", head: "head", back: "mid", chest: "shoulder", heels: "heelL"
  };
  /* The figure faces right: forward and out are +x, back is -x, up is -y. */
  var ARROW_DIR = {
    up: [0, -1], down: [0, 1], forward: [1, 0], back: [-1, 0], out: [1, 0]
  };
  function isSegmentName(name) {
    return typeof name === "string" && (name === "head" || has(SEGMENT_JOINTS, name));
  }
  function jointAt(j, name) { return has(j, name) ? j[name] : null; }
  function finitePt(p) { return !!p && isNum(p.x) && isNum(p.y); }
  /* One solved segment as bare elements (no stroke attributes of its own). */
  function segmentParts(j, name, headR) {
    var out = [], spans, i, a, b;
    if (name === "head") {
      if (!finitePt(j.head)) return out;
      return ['<circle cx="' + n(j.head.x) + '" cy="' + n(j.head.y) + '" r="' + n(headR) + '"/>'];
    }
    spans = SEGMENT_JOINTS[name] || [];
    for (i = 0; i < spans.length; i++) {
      a = jointAt(j, spans[i][0]); b = jointAt(j, spans[i][1]);
      if (finitePt(a) && finitePt(b)) out.push(line(a, b));
    }
    return out;
  }
  function segmentMid(j, name) {
    var spans, s, a, b;
    if (name === "head") return finitePt(j.head) ? pt(j.head.x, j.head.y) : null;
    spans = SEGMENT_JOINTS[name] || [];
    s = spans[0];
    if (!s) return null;
    a = jointAt(j, s[0]); b = jointAt(j, s[1]);
    if (!finitePt(a) || !finitePt(b)) return null;
    return pt((a.x + b.x) / 2, (a.y + b.y) / 2);
  }
  function bandParts(j, names, headR) {
    var out = [], i;
    if (!Array.isArray(names)) return out;
    for (i = 0; i < names.length; i++) {
      if (!isSegmentName(names[i])) continue;
      out = out.concat(segmentParts(j, names[i], headR));
    }
    return out;
  }
  function bandGroup(j, names, headR, colour, dash) {
    var parts = bandParts(j, names, headR);
    if (!parts.length) return "";
    return '<g data-layer="muscles" stroke="' + colour + '" stroke-width="' + n(BAND_WIDTH) + '"' +
      (dash ? ' stroke-dasharray="' + dash + '"' : "") + '>' + parts.join("") + '</g>';
  }
  function skeletonGroup(j) {
    var dots = [], k;
    for (k in j) {
      if (!has(j, k) || !finitePt(j[k])) continue;
      dots.push('<circle cx="' + n(j[k].x) + '" cy="' + n(j[k].y) + '" r="' + n(JOINT_DOT) + '"/>');
    }
    if (!dots.length) return "";
    return '<g data-layer="skeleton" fill="' + SKELETON_FILL + '" stroke="none">' + dots.join("") + '</g>';
  }
  function nerveGroup(j) {
    if (!finitePt(j.mid) || !finitePt(j.shoulder) || !finitePt(j.chin)) return "";
    return '<g data-layer="nerves" stroke="' + SKELETON_FILL + '" stroke-width="' + n(NERVE_WIDTH) +
      '" stroke-dasharray="' + NERVE_DASH + '">' + line(j.mid, j.shoulder) + line(j.shoulder, j.chin) + '</g>';
  }
  /* Label text: strings and finite numbers only, capped, then escaped. */
  function escapeText(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function labelText(v) {
    if (typeof v === "string") { /* as given */ }
    else if (isNum(v)) v = String(v);
    else return "";
    return v.length > LABEL_MAX ? v.slice(0, LABEL_MAX) : v;
  }
  function textWidth(text) { return text.length * LABEL_FONT * LABEL_CHAR; }
  function extendBox(box, x1, y1, x2, y2) {
    if (!box) return { left: x1, top: y1, right: x2, bottom: y2 };
    if (x1 < box.left) box.left = x1;
    if (y1 < box.top) box.top = y1;
    if (x2 > box.right) box.right = x2;
    if (y2 > box.bottom) box.bottom = y2;
    return box;
  }
  /* One arrow: a short shaft from the anchor joint, a two-line head, and an
   * optional escaped label just past the tip. Returns { markup, box } where
   * box is the space the label needs, or null. */
  function arrowDecoration(j, spec) {
    if (!spec || typeof spec !== "object") return null;
    if (typeof spec.from !== "string" || !has(ARROW_FROM, spec.from)) return null;
    if (typeof spec.direction !== "string" || !has(ARROW_DIR, spec.direction)) return null;
    var p = jointAt(j, ARROW_FROM[spec.from]);
    if (!finitePt(p)) return null;
    var d = ARROW_DIR[spec.direction];
    var tip = pt(p.x + d[0] * ARROW_LEN, p.y + d[1] * ARROW_LEN);
    var back = pt(tip.x - d[0] * ARROW_HEAD, tip.y - d[1] * ARROW_HEAD);
    var perp = pt(-d[1], d[0]), wing = ARROW_HEAD * 0.62;
    var markup = '<g data-layer="arrow" stroke="' + SKELETON_FILL + '" stroke-width="' + n(ARROW_WIDTH) + '">' +
      line(p, tip) +
      line(tip, pt(back.x + perp.x * wing, back.y + perp.y * wing)) +
      line(tip, pt(back.x - perp.x * wing, back.y - perp.y * wing));
    var text = labelText(spec.label), box = null;
    if (text) {
      var tx = tip.x + 2.5, ty = tip.y - 3;
      markup += '<text x="' + n(tx) + '" y="' + n(ty) + '" font-size="' + n(LABEL_FONT) +
        '" fill="' + SKELETON_FILL + '" stroke="none">' + escapeText(text) + '</text>';
      box = { left: tx - 1, top: ty - LABEL_FONT, right: tx + textWidth(text), bottom: ty + 2 };
    }
    return { markup: markup + '</g>', box: box };
  }
  /* Every decoration layer, in draw order. fig is the frame the bare figure
   * already needs; the returned box is the extra room the labels want (null
   * when nothing extends past that frame). */
  function decorationMarkup(j, opts, headR, fig) {
    var layers = (opts.layers && typeof opts.layers === "object") ? opts.layers : {};
    var out = [], box = null, i, item, dec;
    if (opts.bands && typeof opts.bands === "object" && layers.muscles !== false) {
      out.push(bandGroup(j, opts.bands.working, headR, BAND_WORKING, null));
      out.push(bandGroup(j, opts.bands.lengthening, headR, BAND_LENGTHENING, BAND_DASH));
    }
    if (layers.skeleton === true) out.push(skeletonGroup(j));
    if (layers.nerves === true) out.push(nerveGroup(j));
    var arrows = Array.isArray(opts.arrows) ? opts.arrows : [];
    for (i = 0; i < arrows.length; i++) {
      dec = arrowDecoration(j, arrows[i]);
      if (!dec) continue;
      out.push(dec.markup);
      if (dec.box) box = extendBox(box, dec.box.left, dec.box.top, dec.box.right, dec.box.bottom);
    }
    /* Labels: a leader line from the segment's midpoint out to a column beside
     * the figure, and the text itself. The column is what widens the viewBox,
     * so the figure scales down to leave the labels room. */
    var labels = Array.isArray(opts.labels) ? opts.labels : [];
    var shown = [], textCount, column = 0;
    for (i = 0; i < labels.length; i++) {
      item = labels[i];
      if (!item || typeof item !== "object" || !isSegmentName(item.segment)) continue;
      var text = labelText(item.text), mid;
      if (!text) continue;
      mid = segmentMid(j, item.segment);
      if (!mid) continue;
      shown.push({ mid: mid, text: text });
      if (textWidth(text) > column) column = textWidth(text);
    }
    textCount = shown.length;
    if (textCount) {
      var textX = fig.right + LABEL_GAP, leaderX = textX - 3, parts = [];
      for (i = 0; i < textCount; i++) {
        item = shown[i];
        var ly = fig.top + LABEL_LINE * (i + 1);
        parts.push(line(item.mid, pt(leaderX, ly - 3)));
        parts.push('<text x="' + n(textX) + '" y="' + n(ly) + '" font-size="' + n(LABEL_FONT) +
          '" fill="' + SKELETON_FILL + '" stroke="none">' + escapeText(item.text) + '</text>');
      }
      out.push('<g data-layer="labels" stroke="' + LABEL_STROKE + '" stroke-width="' +
        n(LABEL_STROKE_WIDTH) + '">' + parts.join("") + '</g>');
      box = extendBox(box, textX - 4, fig.top, textX + column, fig.top + LABEL_LINE * textCount + 3);
    }
    return { markup: out.join(""), box: box };
  }
  /* Side-view stroke figure, viewBox framed to the pose, decorative. Every
   * attribute comes from a number we computed; nothing from the input pose is
   * ever written into the markup. opts may also carry bands / arrows / labels /
   * layers (see decorationMarkup); without them the output is unchanged, and
   * the legacy opts.muscles is still accepted and ignored. */
  function poseSvg(pose, opts) {
    opts = (opts && typeof opts === "object") ? opts : {};
    var size = isNum(opts.size) && opts.size > 0 ? opts.size : 240;
    var H = 100, j = solve(pose, H).joints;
    var headR = SEGMENTS.head * H / 2, pad = headR + 4;
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, k;
    for (k in j) {
      if (!Object.prototype.hasOwnProperty.call(j, k)) continue;
      minX = Math.min(minX, j[k].x); maxX = Math.max(maxX, j[k].x);
      minY = Math.min(minY, j[k].y); maxY = Math.max(maxY, j[k].y);
    }
    var right = maxX + pad, bottom = maxY + pad;
    var vbX = minX - pad, vbY = minY - pad;
    var vbW = maxX - minX + pad * 2, vbH = maxY - minY + pad * 2;
    var decor = decorationMarkup(j, opts, headR, { top: minY - pad, right: right, bottom: bottom });
    if (decor.box) {
      if (decor.box.left < vbX) vbX = decor.box.left;
      if (decor.box.top < vbY) vbY = decor.box.top;
      if (decor.box.right > right) { right = decor.box.right; vbW = right - vbX; }
      if (decor.box.bottom > bottom) { bottom = decor.box.bottom; vbH = bottom - vbY; }
    }
    var vb = n(vbX) + " " + n(vbY) + " " + n(vbW) + " " + n(vbH);
    var farSide = line(j.shoulder, j.elbowR) + line(j.elbowR, j.wristR) + line(j.wristR, j.handR) +
      line(j.hip, j.kneeR) + line(j.kneeR, j.ankleR) + line(j.heelR, j.toeR);
    var nearSide = line(j.hip, j.mid) + line(j.mid, j.shoulder) + line(j.shoulder, j.chin) +
      line(j.shoulder, j.elbowL) + line(j.elbowL, j.wristL) + line(j.wristL, j.handL) +
      line(j.hip, j.kneeL) + line(j.kneeL, j.ankleL) + line(j.heelL, j.toeL) +
      '<circle cx="' + n(j.head.x) + '" cy="' + n(j.head.y) + '" r="' + n(headR) + '"/>';
    /* No xmlns: the panel embeds this inline (like bird-svg's mounts), and the
     * namespace URI is the one URL-shaped string the engine must not carry. */
    return '<svg viewBox="' + vb + '" width="' + n(size) + '" height="' + n(size) +
      '" aria-hidden="true" focusable="false">' +
      '<g fill="none" stroke-linecap="round" stroke-linejoin="round">' +
      '<g stroke="#b6bac7" stroke-width="3.4">' + farSide + '</g>' +
      '<g stroke="#2b2f3a" stroke-width="4.4">' + nearSide + '</g>' +
      decor.markup +
      '</g></svg>';
  }

  return {
    SEGMENTS: SEGMENTS, JOINT_LIMITS: JOINT_LIMITS, ROOT_LIMIT: ROOT_LIMIT,
    SUPPORTS: SUPPORTS, SUPPORT_POINTS: SUPPORT_POINTS, SEAT_HEIGHT_FRAC: SEAT_HEIGHT_FRAC,
    clampPose: clampPose, solve: solve, interpolate: interpolate, tween: tween, poseSvg: poseSvg
  };
});
