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
  /* Segment lengths as a fraction of height — Winter 4th ed., Table 1.1. */
  var SEGMENTS = {
    head: 0.1300,     // chin 0.870H to crown 1.000H // VERIFY
    trunk: 0.2880,    // hip 0.530H to shoulder 0.818H // VERIFY
    upperArm: 0.1860, // VERIFY
    forearm: 0.1460,  // VERIFY
    hand: 0.1080,     // VERIFY
    thigh: 0.2450,    // hip 0.530H to knee 0.285H // VERIFY
    shank: 0.2460,    // knee 0.285H to ankle 0.039H // VERIFY
    foot: 0.1520      // foot length; foot height 0.039H is unused in 2D // VERIFY
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
  /* Which joints can touch the ground per support mode. solve() drops the
   * figure until the LOWEST of these sits at y=0. */
  var SUPPORT_POINTS = {
    feet: ["heelL", "toeL", "heelR", "toeR"],
    hands_feet: ["handL", "handR", "heelL", "toeL", "heelR", "toeR"],
    seat: ["hip", "heelL", "toeL", "heelR", "toeR"],
    back: ["head", "shoulder", "hip", "heelL", "heelR"],
    knees: ["kneeL", "kneeR", "toeL", "toeR"]
  };
  var ANGLE_KEYS = ["neck", "spine",
    "shoulderL", "elbowL", "wristL", "shoulderR", "elbowR", "wristR",
    "hipL", "kneeL", "ankleL", "hipR", "kneeR", "ankleR", "rootAngle"];
  /* Drawing constants: the ankle sits ~35% along the foot from the heel, and
   * the head circle leaves a visible neck stub (0.32 + 2×0.34 = 1.00 of the
   * head segment from shoulder to crown). */
  var HEEL_FRAC = 0.35, HEAD_R_FRAC = 0.34, NECK_FRAC = 0.32;

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
    var fr = rad(footA), dx = Math.cos(fr) * seg.foot, dy = -Math.sin(fr) * seg.foot;
    joints["knee" + side] = knee;
    joints["ankle" + side] = ankle;
    joints["toe" + side] = pt(ankle.x + dx * (1 - HEEL_FRAC), ankle.y + dy * (1 - HEEL_FRAC));
    joints["heel" + side] = pt(ankle.x - dx * HEEL_FRAC, ankle.y - dy * HEEL_FRAC);
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
    joints.head = add(joints.shoulder, up(trunkU + p.neck, seg.head * 0.5));
    armChain(joints, "L", joints.shoulder, trunkU, p.shoulderL, p.elbowL, p.wristL, seg);
    armChain(joints, "R", joints.shoulder, trunkU, p.shoulderR, p.elbowR, p.wristR, seg);
    legChain(joints, "L", joints.hip, p.rootAngle, p.hipL, p.kneeL, p.ankleL, seg);
    legChain(joints, "R", joints.hip, p.rootAngle, p.hipR, p.kneeR, p.ankleR, seg);
    /* Ground: drop the figure until the lowest support point touches y=0. */
    var names = SUPPORT_POINTS[p.support] || SUPPORT_POINTS.feet;
    var lowest = -Infinity, i;
    for (i = 0; i < names.length; i++) lowest = Math.max(lowest, joints[names[i]].y);
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
  function copyPose(p) {
    var out = {}, k;
    for (k in p) if (Object.prototype.hasOwnProperty.call(p, k)) out[k] = p[k];
    return out;
  }
  function n(v) { return ((Math.round(v * 10) / 10) + 0).toFixed(1); }
  function line(a, b) { return '<line x1="' + n(a.x) + '" y1="' + n(a.y) + '" x2="' + n(b.x) + '" y2="' + n(b.y) + '"/>'; }
  /* Side-view stroke figure, viewBox framed to the pose, decorative. Every
   * attribute comes from a number we computed; nothing from the input pose is
   * ever written into the markup. opts.muscles is accepted and ignored — the
   * muscle highlights are post-v1 (spec §12.2) and callers must not change. */
  function poseSvg(pose, opts) {
    opts = (opts && typeof opts === "object") ? opts : {};
    var size = isNum(opts.size) && opts.size > 0 ? opts.size : 240;
    var H = 100, j = solve(pose, H).joints;
    var headR = SEGMENTS.head * H * HEAD_R_FRAC, pad = headR + 4;
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, k;
    for (k in j) {
      if (!Object.prototype.hasOwnProperty.call(j, k)) continue;
      minX = Math.min(minX, j[k].x); maxX = Math.max(maxX, j[k].x);
      minY = Math.min(minY, j[k].y); maxY = Math.max(maxY, j[k].y);
    }
    var vb = n(minX - pad) + " " + n(minY - pad) + " " + n(maxX - minX + pad * 2) + " " + n(maxY - minY + pad * 2);
    /* Neck stub: stop the line at the head circle's edge. */
    var dx = j.head.x - j.shoulder.x, dy = j.head.y - j.shoulder.y;
    var dl = Math.sqrt(dx * dx + dy * dy) || 1;
    var neckEnd = pt(j.head.x - dx / dl * headR, j.head.y - dy / dl * headR);
    var farSide = line(j.shoulder, j.elbowR) + line(j.elbowR, j.wristR) + line(j.wristR, j.handR) +
      line(j.hip, j.kneeR) + line(j.kneeR, j.ankleR) + line(j.heelR, j.toeR);
    var nearSide = line(j.hip, j.mid) + line(j.mid, j.shoulder) + line(j.shoulder, neckEnd) +
      line(j.shoulder, j.elbowL) + line(j.elbowL, j.wristL) + line(j.wristL, j.handL) +
      line(j.hip, j.kneeL) + line(j.kneeL, j.ankleL) + line(j.heelL, j.toeL) +
      '<circle cx="' + n(j.head.x) + '" cy="' + n(j.head.y) + '" r="' + n(headR) + '"/>';
    /* No xmlns: the panel embeds this inline (like bird-svg's mounts), and the
     * namespace URI is the one URL-shaped string the engine must not carry. */
    return '<svg viewBox="' + vb + '" width="' + size + '" height="' + size +
      '" aria-hidden="true" focusable="false">' +
      '<g fill="none" stroke-linecap="round" stroke-linejoin="round">' +
      '<g stroke="#b6bac7" stroke-width="3.4">' + farSide + '</g>' +
      '<g stroke="#2b2f3a" stroke-width="4.4">' + nearSide + '</g>' +
      '</g></svg>';
  }

  return {
    SEGMENTS: SEGMENTS, JOINT_LIMITS: JOINT_LIMITS, ROOT_LIMIT: ROOT_LIMIT,
    SUPPORTS: SUPPORTS, SUPPORT_POINTS: SUPPORT_POINTS,
    clampPose: clampPose, solve: solve, interpolate: interpolate, poseSvg: poseSvg
  };
});
