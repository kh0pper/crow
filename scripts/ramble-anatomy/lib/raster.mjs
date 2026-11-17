/**
 * Triangle coverage raster for the anatomy outlines.
 *
 * The pencil outline of a part is derived, not drawn: its triangles are
 * projected to the drawing plane, the union is scanned into a 1-bit raster,
 * pin-holes between triangles are closed, and the boundary of that raster
 * becomes the SVG path. Everything here is deterministic — no anti-aliasing,
 * no coverage values, no tie-breaking that depends on iteration order.
 */

const MAX_PIXELS = 50_000_000;
/* A closing radius beyond this is a mistake, not a choice. */
const MAX_RADIUS = 64;

function checkBounds({ minX, minY, maxX, maxY, pxPerUnit }) {
  for (const [name, value] of Object.entries({ minX, minY, maxX, maxY, pxPerUnit })) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error("rasterizeTriangles: " + name + " must be a finite number");
    }
  }
  if (pxPerUnit <= 0) throw new Error("rasterizeTriangles: pxPerUnit must be positive");
  if (maxX <= minX || maxY <= minY) throw new Error("rasterizeTriangles: the bounds are empty");
}

/* Is a pixel centre inside the triangle, with the top-left rule applied to
 * centres that land exactly on an edge? Both triangles of a shared edge run
 * that edge in opposite directions, so exactly one of them claims the
 * pixels on it. The caller has already ordered the corners so that
 * (v0, v1, v2) has a positive area. */
function coversPixel(corners, px, py) {
  for (let e = 0; e < 3; e++) {
    const a = e * 2;
    const b = ((e + 1) % 3) * 2;
    const ax = corners[a];
    const ay = corners[a + 1];
    const bx = corners[b];
    const by = corners[b + 1];
    const dx = bx - ax;
    const dy = by - ay;
    const side = dx * (py - ay) - dy * (px - ax);
    if (side > 0) continue;
    if (side < 0) return false;
    const topLeft = dy > 0 || (dy === 0 && dx < 0);
    if (!topLeft) return false;
  }
  return true;
}

/**
 * Rasterise a flat list of x,y pairs (3 pairs per triangle) over the given
 * bounds. Returns a fresh 1-bit raster; 1 means covered.
 */
export function rasterizeTriangles(tris, { minX, minY, maxX, maxY, pxPerUnit }) {
  checkBounds({ minX, minY, maxX, maxY, pxPerUnit });
  if (!tris || typeof tris.length !== "number") throw new Error("rasterizeTriangles: tris must be an array of x,y pairs");
  const width = Math.max(1, Math.ceil((maxX - minX) * pxPerUnit));
  const height = Math.max(1, Math.ceil((maxY - minY) * pxPerUnit));
  if (width * height > MAX_PIXELS) {
    throw new Error("rasterizeTriangles: " + width + "x" + height + " pixels is past the " +
      MAX_PIXELS + " pixel limit — lower pxPerUnit or tighten the bounds");
  }
  const data = new Uint8Array(width * height);
  const corners = new Float64Array(6);

  for (let t = 0; t + 5 < tris.length; t += 6) {
    /* Pixel space: the raster's own origin is (minX, minY). */
    corners[0] = (tris[t] - minX) * pxPerUnit;
    corners[1] = (tris[t + 1] - minY) * pxPerUnit;
    corners[2] = (tris[t + 2] - minX) * pxPerUnit;
    corners[3] = (tris[t + 3] - minY) * pxPerUnit;
    corners[4] = (tris[t + 4] - minX) * pxPerUnit;
    corners[5] = (tris[t + 5] - minY) * pxPerUnit;

    const area2 = (corners[2] - corners[0]) * (corners[5] - corners[1]) -
      (corners[3] - corners[1]) * (corners[4] - corners[0]);
    if (area2 === 0) continue;        // a degenerate triangle covers nothing
    if (area2 < 0) {                  // keep the corner order positive
      const tx = corners[2], ty = corners[3];
      corners[2] = corners[4]; corners[3] = corners[5];
      corners[4] = tx; corners[5] = ty;
    }

    const fromX = Math.max(0, Math.floor(Math.min(corners[0], corners[2], corners[4])));
    const toX = Math.min(width - 1, Math.ceil(Math.max(corners[0], corners[2], corners[4])));
    const fromY = Math.max(0, Math.floor(Math.min(corners[1], corners[3], corners[5])));
    const toY = Math.min(height - 1, Math.ceil(Math.max(corners[1], corners[3], corners[5])));

    for (let y = fromY; y <= toY; y++) {
      const py = y + 0.5;
      const row = y * width;
      for (let x = fromX; x <= toX; x++) {
        if (data[row + x]) continue;
        if (coversPixel(corners, x + 0.5, py)) data[row + x] = 1;
      }
    }
  }

  return { width, height, pxPerUnit, originX: minX, originY: minY, data };
}

/* One separable pass over a square element. `keep` is 1 for a dilation
 * (any covered pixel in the window) and 0 for an erosion (every pixel in the
 * window covered). Window indices are clamped, so the border counts as a copy
 * of the nearest edge pixel: a part that reaches the edge of the raster is not
 * eaten away by the erosion, and a pin-hole inside it still closes. */
function spread(src, width, height, radius, keep, horizontal) {
  const out = new Uint8Array(src.length);
  const along = horizontal ? width : height;
  const across = horizontal ? height : width;
  const at = horizontal
    ? (outer, inner) => outer * width + inner
    : (outer, inner) => inner * width + outer;
  for (let outer = 0; outer < across; outer++) {
    for (let inner = 0; inner < along; inner++) {
      const from = Math.max(0, inner - radius);
      const to = Math.min(along - 1, inner + radius);
      let hit = keep === 1 ? 0 : 1;
      for (let k = from; k <= to; k++) {
        const hitHere = keep === 1 ? src[at(outer, k)] === 1 : src[at(outer, k)] === 0;
        if (hitHere) {
          hit = keep === 1 ? 1 : 0;
          break;
        }
      }
      out[at(outer, inner)] = hit;
    }
  }
  return out;
}

/**
 * Morphological closing: dilate then erode with a square element, which fills
 * pin-holes and pinhole-sized gaps between adjacent triangles without moving
 * the outer boundary.
 */
export function morphClose(raster, radius = 1) {
  if (!raster || !(raster.data instanceof Uint8Array)) {
    throw new Error("morphClose: expected a raster from rasterizeTriangles");
  }
  const r = Math.min(MAX_RADIUS, Math.max(0, Math.floor(radius)));
  const { width, height, pxPerUnit, originX, originY, data } = raster;
  if (r === 0) return { width, height, pxPerUnit, originX, originY, data: Uint8Array.from(data) };
  const grown = spread(spread(data, width, height, r, 1, true), width, height, r, 1, false);
  const closed = spread(spread(grown, width, height, r, 0, true), width, height, r, 0, false);
  return { width, height, pxPerUnit, originX, originY, data: closed };
}