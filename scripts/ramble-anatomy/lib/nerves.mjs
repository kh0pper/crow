/**
 * Nerves: our own drawn paths, not meshes.
 *
 * The source models carry no nerve geometry, so a nerve is a polyline laid
 * along a limb and offset to one side of it. Only the eight vocabulary ids of
 * layer "nerve" are produced. Every strand runs down the NEAR limb, which is
 * drawn with the figure.cjs L joints (an anatomical right side seen from the
 * side view).
 *
 * Frame: pose joints are millimetres, x forward, z up, the floor at z = 0. The
 * output is the pipeline's SVG frame: 100 units for the whole body height, y
 * DOWN, the ground at y = 0 (svg_x = x * 100 / heightMm, svg_y = -z * 100 /
 * heightMm), so every point a figure.cjs drawing would make sits at y <= 0.
 *
 * The offsets below are drawn by hand and are tunable, unverified: they place a
 * strand inside the limb rather than on an anatomical course.
 */

/** SVG units for the full body height, as svg-writer and figure.cjs use. */
const HEIGHT_UNITS = 100;

/** The vocabulary's nerve ids, in vocabulary order. */
const NERVE_IDS = [
  "sciatic-nerve",
  "femoral-nerve",
  "tibial-nerve",
  "common-fibular-nerve",
  "median-nerve",
  "ulnar-nerve",
  "radial-nerve",
  "axillary-nerve",
];

/** How far the shoulder point of the axillary strand sits above the joint. */
const AXILLARY_RISE_MM = 28;

const isPoint = (value) =>
  !!value && typeof value === "object" &&
  typeof value.x === "number" && Number.isFinite(value.x) &&
  typeof value.z === "number" && Number.isFinite(value.z);

/** One pose joint as { x, z } in millimetres, or a clear Error naming it. */
function jointOf(joints, name) {
  const joint = joints && typeof joints === "object" ? joints[name] : undefined;
  if (!isPoint(joint)) {
    throw new Error("buildNerves: the pose has no joint \"" + name + "\" (a finite { x, z } in millimetres is needed)");
  }
  return { x: joint.x, z: joint.z };
}

/** The point a fraction t of the way from a to b. */
export function along(a, b, t) {
  return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
}

/**
 * `point` moved `mm` perpendicular to the segment a -> b, where a positive mm
 * is the ANTERIOR side: the segment direction (ux, uz) turned +90 degrees is
 * (-uz, ux), which for a limb hanging straight down is +x, i.e. forward. A
 * negative mm is posterior.
 */
export function side(point, a, b, mm) {
  const ux = b.x - a.x;
  const uz = b.z - a.z;
  const length = Math.hypot(ux, uz);
  /* A limb of zero length has no perpendicular; forward keeps the points finite. */
  const ax = length > 0 ? -uz / length : 1;
  const az = length > 0 ? ux / length : 0;
  return { x: point.x + ax * mm, z: point.z + az * mm };
}

/**
 * The waypoints of one strand along the segment a -> b: a list of
 * [fraction along the segment, millimetres anterior (negative = posterior)].
 */
function strand(a, b, waypoints) {
  return waypoints.map(([t, mm]) => side(along(a, b, t), a, b, mm));
}

/**
 * The eight nerve strands for one pose, in SVG units.
 *
 * `joints` is pose.json's joints object (millimetres, x forward, z up) with the
 * figure.cjs L joints for the near side; `heightMm` is the same body height the
 * pose was solved at. A joint a strand needs and the pose does not carry throws
 * an Error naming that joint.
 */
export function buildNerves(joints, heightMm) {
  if (typeof heightMm !== "number" || !Number.isFinite(heightMm) || heightMm <= 0) {
    throw new Error("buildNerves: heightMm must be a positive number, got " + String(heightMm));
  }

  const hip = jointOf(joints, "hip");
  const knee = jointOf(joints, "kneeL");
  const ankle = jointOf(joints, "ankleL");
  const shoulder = jointOf(joints, "shoulder");
  const elbow = jointOf(joints, "elbowL");
  const wrist = jointOf(joints, "wristL");
  const hand = jointOf(joints, "handL");

  const thigh = [hip, knee];
  const shank = [knee, ankle];
  const upperArm = [shoulder, elbow];
  const forearm = [elbow, wrist];
  const handBone = [wrist, hand];

  /* The common fibular nerve leaves the thigh at the back of the knee and
   * crosses to the front of the shank from there. */
  const fibularKnee = side(along(thigh[0], thigh[1], 0.92), thigh[0], thigh[1], -20);

  const points = {
    "sciatic-nerve": strand(thigh[0], thigh[1], [[0.02, -35], [0.5, -30], [0.92, -20]]),
    "femoral-nerve": strand(thigh[0], thigh[1], [[0.05, 30], [0.5, 25], [0.85, 15]]),
    "tibial-nerve": strand(shank[0], shank[1], [[0, -20], [0.5, -22], [0.97, -28]]),
    "common-fibular-nerve": [
      fibularKnee,
      ...strand(shank[0], shank[1], [[0.1, 15], [0.5, 25], [0.9, 28]]),
    ],
    "median-nerve": [
      ...strand(upperArm[0], upperArm[1], [[0.1, 20], [1, 15]]),
      ...strand(forearm[0], forearm[1], [[0.5, 10], [1, 8]]),
      ...strand(handBone[0], handBone[1], [[0.3, 6]]),
    ],
    "ulnar-nerve": [
      ...strand(upperArm[0], upperArm[1], [[0.1, -22], [1, -25]]),
      ...strand(forearm[0], forearm[1], [[0.5, -14], [1, -10]]),
      ...strand(handBone[0], handBone[1], [[0.3, -6]]),
    ],
    "radial-nerve": [
      ...strand(upperArm[0], upperArm[1], [[0.15, -28], [0.7, -30]]),
      ...strand(forearm[0], forearm[1], [[0.05, 22], [0.6, 18], [1, 12]]),
    ],
    "axillary-nerve": [
      side(along(upperArm[0], upperArm[1], 0.05), upperArm[0], upperArm[1], -32),
      { x: shoulder.x, z: shoulder.z + AXILLARY_RISE_MM },
      side(along(upperArm[0], upperArm[1], 0.05), upperArm[0], upperArm[1], 32),
    ],
  };

  const scale = HEIGHT_UNITS / heightMm;
  return NERVE_IDS.map((id) => ({
    id,
    points: points[id].map((point) => [point.x * scale, -point.z * scale]),
  }));
}