/**
 * Layered anatomy SVG writer.
 *
 * Input is the posed meshes (one OBJ per vocabulary id, in the pipeline's
 * millimetre side-view frame, Y toward the viewer) plus our own nerve paths in
 * SVG units. Output is one standalone SVG whose layers stack back to front —
 * skin, skeleton, muscles, nerves — with one path per part, sorted far to near
 * so the near side of the body covers the far side.
 *
 * The credit wording is never written here: the caller passes a string and it
 * lands in <metadata>, XML-escaped, or there is no <metadata> element at all.
 */
import { gzipSync } from "node:zlib";
import { morphClose, rasterizeTriangles } from "./raster.mjs";
import { pathData, traceLoops } from "./trace.mjs";

const SVG_NS = "http://www.w3.org/2000/svg";
/* Draw order, back to front. Only the requested layers are emitted. */
const LAYER_ORDER = ["skin", "skeleton", "muscles", "nerves"];
/* Colours and widths are first guesses: tunable, unverified. */
const GROUP_STYLE = {
  skin: 'fill="#e8c9a8" opacity="0.35" stroke="#b08968" stroke-width="0.3"',
  skeleton: 'fill="#f3efe6" stroke="#6b6558" stroke-width="0.25"',
  muscles: 'fill-opacity="0.62" stroke="#7a2a26" stroke-width="0.2"',
  nerves: 'fill="none" stroke="#e1b100" stroke-width="0.35" stroke-linecap="round" stroke-linejoin="round"',
};
const MUSCLE_FILL = { upper: "#c8423b", lower: "#d9822b", core: "#b5446e" };
/* A muscle the vocabulary gives no area still has to be drawn: tunable, unverified. */
const MUSCLE_FALLBACK_FILL = "#c8423b";
const BUDGET_BYTES = 25600;
const DECIMALS = 2;

const isRecord = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const isNumber = (v) => typeof v === "number" && Number.isFinite(v);

/** XML-escape text that goes between tags. */
function escapeXml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Numbers without trailing zeros. */
function num(value) {
  const rounded = Number(value.toFixed(DECIMALS));
  return rounded === 0 ? "0" : String(rounded);
}

/** Which layer a mesh id belongs to, or null when it is not drawn from the side. */
function layerOf(id, vocabById) {
  if (id === "skin") return "skin";
  const record = vocabById.get(id);
  if (!record || record.sideView !== true) return null;
  if (record.layer === "bone") return "skeleton";
  if (record.layer === "muscle") return "muscles";
  return null;
}

/** Every triangle of every object of a mesh, projected to SVG units, plus its mean Y. */
function projectMesh(mesh, scale) {
  const tris = [];
  let depthSum = 0;
  let depthCount = 0;
  for (const object of Array.isArray(mesh && mesh.objects) ? mesh.objects : []) {
    const positions = object.positions;
    const indices = object.indices;
    if (!positions || !indices) continue;
    for (let i = 0; i + 2 < indices.length; i += 3) {
      const corners = [];
      for (let corner = 0; corner < 3; corner++) {
        const at = indices[i + corner] * 3;
        corners.push(positions[at], positions[at + 1], positions[at + 2]);
      }
      if (!corners.every(isNumber)) continue;
      for (let corner = 0; corner < 3; corner++) {
        tris.push(corners[corner * 3] * scale, -corners[corner * 3 + 2] * scale);
      }
      depthSum += (corners[1] + corners[4] + corners[7]) / 3;
      depthCount += 1;
    }
  }
  return { tris: Float64Array.from(tris), depth: depthCount ? depthSum / depthCount : 0 };
}

/** An open polyline path for a nerve strand, from points already in SVG units. */
function polylinePath(points) {
  let d = "M " + num(points[0][0]) + " " + num(points[0][1]);
  for (let i = 1; i < points.length; i++) d += " L " + num(points[i][0]) + " " + num(points[i][1]);
  return d;
}

function extend(box, point) {
  if (!box) return { minX: point[0], minY: point[1], maxX: point[0], maxY: point[1] };
  if (point[0] < box.minX) box.minX = point[0];
  if (point[1] < box.minY) box.minY = point[1];
  if (point[0] > box.maxX) box.maxX = point[0];
  if (point[1] > box.maxY) box.maxY = point[1];
  return box;
}

/**
 * Build the layered SVG and a report on what went into it.
 *
 * layers decides which groups exist (and in which order they are written);
 * nerves are accepted only for vocabulary ids whose layer is "nerve".
 */
export function buildLayeredSvg({
  vocab,
  heightMm,
  meshes,
  nerves = [],
  credit,
  title,
  layers = ["skin", "skeleton", "muscles", "nerves"],
  pxPerUnit = 10,
  epsilon = 0.15,
  pad = 4,
} = {}) {
  if (!isNumber(heightMm) || heightMm <= 0) throw new Error("buildLayeredSvg: heightMm must be a positive number");
  if (!isRecord(meshes)) throw new Error("buildLayeredSvg: meshes must be the object loadPosedDir returns");
  if (!isNumber(pxPerUnit) || pxPerUnit <= 0) throw new Error("buildLayeredSvg: pxPerUnit must be positive");
  if (!isNumber(pad) || pad < 0) throw new Error("buildLayeredSvg: pad must be a number from 0 up");
  const keep = new Set(Array.isArray(layers) ? layers : LAYER_ORDER);
  const writable = LAYER_ORDER.filter((layer) => keep.has(layer));

  const vocabById = new Map();
  for (const record of Array.isArray(vocab) ? vocab : []) {
    if (isRecord(record) && typeof record.id === "string") vocabById.set(record.id, record);
  }

  /* Project every mesh that is drawn from the side, and take the union bounds
   * of the ones that will be drawn, so every raster shares one scale. */
  const scale = 100 / heightMm;
  const drawn = [];
  let projected = null;
  for (const id of Object.keys(meshes)) {
    const layer = layerOf(id, vocabById);
    if (!layer) continue;
    const { tris, depth } = projectMesh(meshes[id], scale);
    if (tris.length === 0) continue;
    const record = vocabById.get(id);
    drawn.push({ id, layer, area: record ? record.area : null, tris, depth });
    for (let i = 0; i < tris.length; i += 2) projected = extend(projected, [tris[i], tris[i + 1]]);
  }

  const box = projected
    ? { minX: projected.minX - pad, minY: projected.minY - pad, maxX: projected.maxX + pad, maxY: projected.maxY + pad, pxPerUnit }
    : null;

  /* Outline every drawn mesh, then group the results by layer, far to near.
   * The frame grows with everything that actually lands in the drawing. */
  const paths = { skin: [], skeleton: [], muscles: [], nerves: [] };
  let frame = box ? { minX: box.minX, minY: box.minY, maxX: box.maxX, maxY: box.maxY } : null;
  for (const item of drawn) {
    if (!box) break;
    const raster = rasterizeTriangles(item.tris, box);
    const loops = traceLoops(morphClose(raster, 1), { epsilon });
    if (loops.length === 0) continue;
    for (const loop of loops) for (const point of loop) frame = extend(frame, point);
    const d = pathData(loops);
    const fill = item.layer === "muscles" ? (MUSCLE_FILL[item.area] || MUSCLE_FALLBACK_FILL) : null;
    const markup = fill
      ? '<path id="' + escapeXml(item.id) + '" fill="' + fill + '" d="' + d + '"/>'
      : '<path id="' + escapeXml(item.id) + '" d="' + d + '"/>';
    paths[item.layer].push({
      id: item.id,
      depth: item.depth,
      markup,
      loops: loops.length,
      points: loops.reduce((total, loop) => total + loop.length, 0),
    });
  }

  for (const nerve of Array.isArray(nerves) ? nerves : []) {
    if (!isRecord(nerve) || typeof nerve.id !== "string") continue;
    const record = vocabById.get(nerve.id);
    if (!record || record.layer !== "nerve") continue;
    const points = (Array.isArray(nerve.points) ? nerve.points : [])
      .filter((point) => Array.isArray(point) && point.length >= 2 && isNumber(point[0]) && isNumber(point[1]))
      .map((point) => [point[0], point[1]]);
    if (points.length < 2) continue;
    for (const point of points) frame = extend(frame, point);
    paths.nerves.push({
      id: nerve.id,
      depth: 0,
      markup: '<path id="' + escapeXml(nerve.id) + '" d="' + polylinePath(points) + '"/>',
      loops: 1,
      points: points.length,
    });
  }

  /* Far to near within a layer (depth is mean Y: a larger Y is nearer). */
  for (const layer of LAYER_ORDER) paths[layer].sort((a, b) => a.depth - b.depth);

  /* The frame is everything that is drawn, plus the same pad. An empty drawing
   * still needs a frame, so there is a plain fallback. */
  if (!frame) frame = { minX: 0, minY: 0, maxX: 100, maxY: 100 };
  const viewBox = [
    num(frame.minX), num(frame.minY),
    num(frame.maxX - frame.minX), num(frame.maxY - frame.minY),
  ].join(" ");

  const markup = [];
  markup.push('<svg xmlns="' + SVG_NS + '" viewBox="' + viewBox + '">');
  if (typeof title === "string" && title !== "") markup.push("<title>" + escapeXml(title) + "</title>");
  if (typeof credit === "string" && credit !== "") markup.push("<metadata>" + escapeXml(credit) + "</metadata>");
  const reportIds = [];
  for (const layer of writable) {
    const entries = paths[layer];
    if (entries.length === 0) continue;
    markup.push('<g id="' + layer + '" ' + GROUP_STYLE[layer] + ">");
    for (const entry of entries) {
      markup.push(entry.markup);
      reportIds.push({
        id: entry.id,
        layer,
        loops: entry.loops,
        points: entry.points,
        bytes: Buffer.byteLength(entry.markup, "utf8"),
      });
    }
    markup.push("</g>");
  }
  markup.push("</svg>");
  const svg = markup.join("\n") + "\n";

  const bytes = Buffer.byteLength(svg, "utf8");
  const gzipBytes = gzipSync(Buffer.from(svg, "utf8"), { level: 9 }).length;
  return {
    svg,
    report: {
      viewBox,
      ids: reportIds,
      bytes,
      gzipBytes,
      budgetBytes: BUDGET_BYTES,
      /* The budget is about what a client downloads, so it is checked on the
       * gzipped size. */
      withinBudget: gzipBytes <= BUDGET_BYTES,
    },
  };
}