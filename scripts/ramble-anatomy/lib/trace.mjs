/**
 * Boundary tracing for a 1-bit raster.
 *
 * The outline of a part is the crack between a covered pixel and an uncovered
 * one: every such pixel edge becomes a directed crack (covered pixel always on
 * the same side), the cracks are chained into closed loops, and each loop is
 * simplified with Douglas-Peucker. Outer boundaries and holes come out the same
 * way — a hole simply runs the other way round — and the caller decides what to
 * do with the sign by looking at the area.
 *
 * Coordinates come back in the raster's own units (originX + pixel/pxPerUnit),
 * which for the anatomy pipeline is millimetres.
 */

/* Cracks leave a covered pixel so that the walk keeps the covered area on one
 * fixed side: above -> rightwards, right -> down, below -> leftwards,
 * left -> upwards. An outer boundary therefore has positive area and a hole
 * negative, in the raster's y-down pixel space. */
const CRACKS = [
  { dx: 0, dy: -1, from: [0, 0], to: [1, 0], dir: 0 },   // neighbour above: (x, y) -> (x+1, y)
  { dx: 1, dy: 0, from: [1, 0], to: [1, 1], dir: 1 },    // neighbour right: (x+1, y) -> (x+1, y+1)
  { dx: 0, dy: 1, from: [1, 1], to: [0, 1], dir: 2 },    // neighbour below: (x+1, y+1) -> (x, y+1)
  { dx: -1, dy: 0, from: [0, 1], to: [0, 0], dir: 3 },   // neighbour left: (x, y+1) -> (x, y)
];

const covered = (raster, x, y) => x >= 0 && y >= 0 && x < raster.width && y < raster.height
  && raster.data[y * raster.width + x] === 1;

/** [startKey, endKey, direction] for every covered/uncovered pixel edge. */
function collectCracks(raster) {
  const { width, height } = raster;
  const stride = width + 1;                        // a corner grid has one extra row and column
  const cracks = [];
  const outgoing = new Map();                      // corner key -> crack indices leaving it
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (raster.data[y * width + x] !== 1) continue;
      for (const crack of CRACKS) {
        if (covered(raster, x + crack.dx, y + crack.dy)) continue;
        const startX = x + crack.from[0];
        const startY = y + crack.from[1];
        const endX = x + crack.to[0];
        const endY = y + crack.to[1];
        const index = cracks.length;
        cracks.push({
          fromKey: startY * stride + startX,
          toKey: endY * stride + endX,
          dir: crack.dir,
        });
        const bucket = outgoing.get(startY * stride + startX);
        if (bucket) bucket.push(index);
        else outgoing.set(startY * stride + startX, [index]);
      }
    }
  }
  return { cracks, outgoing, stride };
}

/* Douglas-Peucker on an open chain, both endpoints kept. */
function simplifyChain(points, epsilon) {
  if (points.length < 3) return points.slice();
  const first = points[0];
  const last = points[points.length - 1];
  const dx = last[0] - first[0];
  const dy = last[1] - first[1];
  const length = Math.hypot(dx, dy);
  let worst = -1;
  let worstIndex = -1;
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i];
    const distance = length === 0
      ? Math.hypot(p[0] - first[0], p[1] - first[1])
      : Math.abs(dy * (p[0] - first[0]) - dx * (p[1] - first[1])) / length;
    if (distance > worst) {
      worst = distance;
      worstIndex = i;
    }
  }
  if (worstIndex < 0 || worst <= epsilon) return [first, last];
  const left = simplifyChain(points.slice(0, worstIndex + 1), epsilon);
  const right = simplifyChain(points.slice(worstIndex), epsilon);
  return left.slice(0, -1).concat(right);
}

/* A closed loop has no natural endpoints, so it is split at the corner
 * farthest from the first point and each half is simplified as an open chain. */
function simplifyLoop(points, epsilon) {
  if (points.length <= 3) return points.slice();
  const first = points[0];
  let far = 0;
  let farDistance = -1;
  for (let i = 1; i < points.length; i++) {
    const d = Math.hypot(points[i][0] - first[0], points[i][1] - first[1]);
    if (d > farDistance) {
      farDistance = d;
      far = i;
    }
  }
  if (far <= 0) return points.slice();
  const head = simplifyChain(points.slice(0, far + 1), epsilon);
  const tail = simplifyChain(points.slice(far).concat([first]), epsilon);
  /* tail runs from the far corner back to the first point: drop both ends,
   * which the head and the loop closure already carry. */
  const merged = head.concat(tail.slice(1, -1));
  return merged.length >= 3 ? merged : points.slice();
}

function signedArea(points) {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    sum += a[0] * b[1] - b[0] * a[1];
  }
  return sum / 2;
}

/** Drop points that repeat the previous one (a raster can emit them at a pinch). */
function dedupe(points) {
  const out = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && last[0] === p[0] && last[1] === p[1]) continue;
    out.push(p);
  }
  while (out.length > 1) {
    const first = out[0];
    const last = out[out.length - 1];
    if (last[0] !== first[0] || last[1] !== first[1]) break;
    out.pop();
  }
  return out;
}

/**
 * Closed boundary loops of a raster, in the raster's units, simplified and
 * filtered by area. Outer boundaries and holes are both returned.
 */
export function traceLoops(raster, { epsilon = 0.15, minArea = 0.01 } = {}) {
  if (!raster || !(raster.data instanceof Uint8Array)) {
    throw new Error("traceLoops: expected a raster from rasterizeTriangles");
  }
  if (typeof epsilon !== "number" || !(epsilon >= 0)) throw new Error("traceLoops: epsilon must be a number from 0 up");
  if (typeof minArea !== "number" || !(minArea >= 0)) throw new Error("traceLoops: minArea must be a number from 0 up");
  const { stride, cracks, outgoing } = collectCracks(raster);
  const used = new Uint8Array(cracks.length);
  const loops = [];

  const nextCrack = (crack) => {
    const bucket = outgoing.get(crack.toKey);
    if (!bucket) return -1;
    /* Prefer turning the same way round the covered area at every corner: that
     * keeps two loops that only touch at a corner (a diagonal step) apart. */
    for (const dir of [(crack.dir + 1) & 3, crack.dir, (crack.dir + 3) & 3, (crack.dir + 2) & 3]) {
      for (const index of bucket) {
        if (!used[index] && cracks[index].dir === dir) return index;
      }
    }
    return -1;
  };

  for (let start = 0; start < cracks.length; start++) {
    if (used[start]) continue;
    const cornerKeys = [];
    let current = start;
    while (current !== -1 && !used[current]) {
      used[current] = 1;
      cornerKeys.push(cracks[current].fromKey);
      current = nextCrack(cracks[current]);
    }
    if (cornerKeys.length < 4) continue;           // the smallest real loop is one pixel
    const points = cornerKeys.map((key) => [
      raster.originX + (key % stride) / raster.pxPerUnit,
      raster.originY + Math.floor(key / stride) / raster.pxPerUnit,
    ]);
    const loop = dedupe(simplifyLoop(dedupe(points), epsilon));
    if (loop.length < 3) continue;
    if (Math.abs(signedArea(loop)) < minArea) continue;
    loops.push(loop);
  }
  return loops;
}

/** Numbers without trailing zeros, rounded so that adding them up cannot drift. */
function format(value, decimals) {
  const rounded = Number(value.toFixed(decimals));
  return rounded === 0 ? "0" : String(rounded);
}

/**
 * One SVG path for a list of closed loops: `M x y` for the first point, then
 * relative `l dx dy` steps computed from the ROUNDED absolute points, then `z`.
 * Deterministic for the same loops.
 */
export function pathData(loops, decimals = 2) {
  if (!Array.isArray(loops)) throw new Error("pathData: loops must be an array of point lists");
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 10) {
    throw new Error("pathData: decimals must be a whole number from 0 to 10");
  }
  const parts = [];
  for (const loop of loops) {
    if (!Array.isArray(loop) || loop.length === 0) continue;
    const rounded = loop.map((p) => [Number(p[0].toFixed(decimals)), Number(p[1].toFixed(decimals))]);
    let d = "M " + format(rounded[0][0], decimals) + " " + format(rounded[0][1], decimals);
    if (rounded.length > 1) {
      const steps = [];
      for (let i = 1; i < rounded.length; i++) {
        steps.push(Number((rounded[i][0] - rounded[i - 1][0]).toFixed(decimals)));
        steps.push(Number((rounded[i][1] - rounded[i - 1][1]).toFixed(decimals)));
      }
      d += " l " + steps.map((v) => format(v, decimals)).join(" ");
    }
    parts.push(d + " z");
  }
  return parts.join(" ");
}