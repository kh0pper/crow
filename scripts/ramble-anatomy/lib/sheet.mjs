/**
 * Comparison sheet: many small drawings in one standalone SVG.
 *
 * Two pieces live here. `stickFigureSvgBody` draws pose.json joints the way
 * figure.cjs poseSvg draws them (near limb dark, far limb light, head as a
 * circle), but at the pipeline's own scale — 100 units for the body height,
 * y down, the ground at y = 0 — so it can be placed in the same frame as a
 * layered anatomy drawing. `buildSheet` lays a grid of such cells out with a
 * title, column labels and row labels.
 *
 * Every cell is a nested <svg> with its own viewBox: the caller passes one
 * viewBox string to every cell of a sheet and they all share one scale.
 */

const SVG_NS = "http://www.w3.org/2000/svg";
/* The colours poseSvg uses for the near and the far limb. */
const NEAR_STROKE = "#2b2f3a";
const NEAR_WIDTH = 1.2;
const FAR_STROKE = "#b6bac7";
const FAR_WIDTH = 0.9;
/* A thin ground line, and the light grid of the sheet. Tunable, unverified. */
const GROUND_STROKE = "#b6bac7";
const GROUND_WIDTH = 0.3;
const GRID_STROKE = "#dfe1e7";
const GRID_WIDTH = 0.2;
const FONT_FAMILY = "sans-serif";
const TITLE_SIZE = 6.5;
const LABEL_SIZE = 3.4;
const MARGIN_LEFT = 18;
const MARGIN_RIGHT = 4;
const MARGIN_TOP = 16;
const MARGIN_BOTTOM = 4;
const DECIMALS = 2;

const isNumber = (value) => typeof value === "number" && Number.isFinite(value);

/** XML-escape text that goes between tags or into a quoted attribute. */
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
  const rounded = Number(Number(value).toFixed(DECIMALS));
  return rounded === 0 ? "0" : String(rounded);
}

/** One pose joint as an SVG point, or a clear Error naming it. */
function svgPoint(joints, name, scale, role) {
  const joint = joints[name];
  if (!joint || !isNumber(joint.x) || !isNumber(joint.z)) {
    throw new Error("stickFigureSvgBody: the pose has no " + role + " joint \"" + name + "\"");
  }
  return { x: joint.x * scale, y: -joint.z * scale };
}

const line = (a, b) =>
  '<line x1="' + num(a.x) + '" y1="' + num(a.y) + '" x2="' + num(b.x) + '" y2="' + num(b.y) + '"/>';

/**
 * The stick figure for one pose, as SVG markup without an outer <svg>.
 *
 * Segments are the ones poseSvg draws: hip-mid, mid-shoulder, shoulder-chin,
 * the near arm (shoulder-elbowL-wristL-handL), the near leg
 * (hip-kneeL-ankleL and heelL-toeL) and the head as a circle centred on
 * `head` with radius |crown-chin| / 2. With `far` the R limb is drawn lighter
 * underneath, exactly as poseSvg draws it.
 */
export function stickFigureSvgBody(joints, heightMm, { far = true } = {}) {
  if (!joints || typeof joints !== "object" || Array.isArray(joints)) {
    throw new Error("stickFigureSvgBody: joints must be a pose.json joints object");
  }
  if (!isNumber(heightMm) || heightMm <= 0) {
    throw new Error("stickFigureSvgBody: heightMm must be a positive number, got " + String(heightMm));
  }
  const scale = 100 / heightMm;
  const near = (name) => svgPoint(joints, name, scale, "near-side");
  const farSide = (name) => svgPoint(joints, name, scale, "far-side");

  const hip = near("hip");
  const mid = near("mid");
  const shoulder = near("shoulder");
  const chin = near("chin");
  const head = near("head");
  const crown = near("crown");
  const elbowL = near("elbowL");
  const wristL = near("wristL");
  const handL = near("handL");
  const kneeL = near("kneeL");
  const ankleL = near("ankleL");
  const heelL = near("heelL");
  const toeL = near("toeL");

  const headR = Math.hypot(crown.x - chin.x, crown.y - chin.y) / 2;
  const nearParts = [
    line(hip, mid),
    line(mid, shoulder),
    line(shoulder, chin),
    line(shoulder, elbowL),
    line(elbowL, wristL),
    line(wristL, handL),
    line(hip, kneeL),
    line(kneeL, ankleL),
    line(heelL, toeL),
    '<circle cx="' + num(head.x) + '" cy="' + num(head.y) + '" r="' + num(headR) + '"/>',
  ];
  const farParts = [
    line(shoulder, farSide("elbowR")),
    line(farSide("elbowR"), farSide("wristR")),
    line(farSide("wristR"), farSide("handR")),
    line(hip, farSide("kneeR")),
    line(farSide("kneeR"), farSide("ankleR")),
    line(farSide("heelR"), farSide("toeR")),
  ];

  /* The ground line spans the drawing, so a figure that leans reads as leaning. */
  let minX = Infinity;
  let maxX = -Infinity;
  for (const point of [hip, mid, shoulder, chin, crown, head, elbowL, wristL, handL,
    kneeL, ankleL, heelL, toeL]) {
    minX = Math.min(minX, point.x);
    maxX = Math.max(maxX, point.x);
  }
  const ground = '<line x1="' + num(minX - 2) + '" y1="0" x2="' + num(maxX + 2) + '" y2="0"/>';

  const markup = [
    '<g fill="none" stroke="' + GROUND_STROKE + '" stroke-width="' + num(GROUND_WIDTH) + '">',
    ground,
    "</g>",
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round">',
  ];
  if (far) {
    markup.push('<g stroke="' + FAR_STROKE + '" stroke-width="' + num(FAR_WIDTH) + '">');
    markup.push(farParts.join(""));
    markup.push("</g>");
  }
  markup.push('<g stroke="' + NEAR_STROKE + '" stroke-width="' + num(NEAR_WIDTH) + '">');
  markup.push(nearParts.join(""));
  markup.push("</g>");
  markup.push("</g>");
  return markup.join("");
}

/** The children of the root <svg> of an SVG string. */
export function innerSvg(fullSvg) {
  if (typeof fullSvg !== "string" || fullSvg.trim() === "") {
    throw new Error("innerSvg: expected SVG text, got " + typeof fullSvg);
  }
  const openAt = fullSvg.indexOf("<svg");
  if (openAt < 0) throw new Error("innerSvg: the text holds no root <svg>");
  const openEnd = fullSvg.indexOf(">", openAt);
  if (openEnd < 0) throw new Error("innerSvg: the root <svg> start tag is never closed");
  if (fullSvg[openEnd - 1] === "/") return "";
  const closeAt = fullSvg.lastIndexOf("</svg>");
  if (closeAt < openEnd) throw new Error("innerSvg: the root <svg> is never closed");
  return fullSvg.slice(openEnd + 1, closeAt).trim();
}

/** The root <svg>'s viewBox attribute, as written. */
export function viewBoxOf(fullSvg) {
  if (typeof fullSvg !== "string" || fullSvg.trim() === "") {
    throw new Error("viewBoxOf: expected SVG text, got " + typeof fullSvg);
  }
  const openAt = fullSvg.indexOf("<svg");
  if (openAt < 0) throw new Error("viewBoxOf: the text holds no root <svg>");
  const openEnd = fullSvg.indexOf(">", openAt);
  if (openEnd < 0) throw new Error("viewBoxOf: the root <svg> start tag is never closed");
  const startTag = fullSvg.slice(openAt, openEnd);
  const match = /\sviewBox\s*=\s*"([^"]*)"/.exec(startTag);
  if (!match) throw new Error("viewBoxOf: the root <svg> carries no viewBox");
  return match[1];
}

/**
 * One standalone SVG holding a grid of drawings.
 *
 * `rows` are the row labels, `columns` are `{ label, cells }` where `cells[i]`
 * is `{ body, viewBox }` for row i (`body` is SVG markup, `viewBox` that
 * cell's own frame, and a missing cell is drawn empty). Every label is XML
 * escaped; `body` is markup and is written as it comes.
 */
export function buildSheet({ rows, columns, title, cellW = 60, cellH = 110 } = {}) {
  if (!Array.isArray(rows) || rows.length === 0) throw new Error("buildSheet: rows must be a non-empty list of labels");
  if (!Array.isArray(columns) || columns.length === 0) {
    throw new Error("buildSheet: columns must be a non-empty list of { label, cells }");
  }
  if (!isNumber(cellW) || cellW <= 0) throw new Error("buildSheet: cellW must be a positive number");
  if (!isNumber(cellH) || cellH <= 0) throw new Error("buildSheet: cellH must be a positive number");

  const width = MARGIN_LEFT + MARGIN_RIGHT + columns.length * cellW;
  const height = MARGIN_TOP + MARGIN_BOTTOM + rows.length * cellH;
  const markup = [
    '<svg xmlns="' + SVG_NS + '" viewBox="0 0 ' + num(width) + " " + num(height) +
      '" width="' + num(width) + '" height="' + num(height) + '">',
    '<rect x="0" y="0" width="' + num(width) + '" height="' + num(height) + '" fill="#ffffff"/>',
    '<g font-family="' + escapeXml(FONT_FAMILY) + '" fill="#2b2f3a">',
  ];

  if (typeof title === "string" && title !== "") {
    markup.push('<text x="' + num(MARGIN_LEFT) + '" y="' + num(MARGIN_TOP - 8) +
      '" font-size="' + num(TITLE_SIZE) + '" font-weight="600">' + escapeXml(title) + "</text>");
  }

  columns.forEach((column, index) => {
    if (!column || typeof column !== "object") return;
    const centre = MARGIN_LEFT + cellW * (index + 0.5);
    markup.push('<text x="' + num(centre) + '" y="' + num(MARGIN_TOP - 3) +
      '" font-size="' + num(LABEL_SIZE) + '" text-anchor="middle">' +
      escapeXml(column.label === undefined ? "" : column.label) + "</text>");
  });

  rows.forEach((rowLabel, rowIndex) => {
    const top = MARGIN_TOP + cellH * rowIndex;
    markup.push('<text x="' + num(MARGIN_LEFT - 2) + '" y="' + num(top + cellH / 2) +
      '" font-size="' + num(LABEL_SIZE) + '" text-anchor="end" dominant-baseline="middle">' +
      escapeXml(rowLabel === undefined || rowLabel === null ? "" : rowLabel) + "</text>");
    columns.forEach((column, columnIndex) => {
      const left = MARGIN_LEFT + cellW * columnIndex;
      const cell = column && Array.isArray(column.cells) ? column.cells[rowIndex] : null;
      const viewBox = cell && typeof cell.viewBox === "string" && cell.viewBox !== ""
        ? cell.viewBox
        : "0 0 " + num(cellW) + " " + num(cellH);
      markup.push('<rect x="' + num(left) + '" y="' + num(top) + '" width="' + num(cellW) +
        '" height="' + num(cellH) + '" fill="none" stroke="' + GRID_STROKE +
        '" stroke-width="' + num(GRID_WIDTH) + '"/>');
      markup.push('<svg x="' + num(left) + '" y="' + num(top) + '" width="' + num(cellW) +
        '" height="' + num(cellH) + '" viewBox="' + escapeXml(viewBox) + '">');
      if (cell && typeof cell.body === "string") markup.push(cell.body);
      markup.push("</svg>");
    });
  });

  markup.push("</g>");
  markup.push("</svg>");
  return markup.join("\n") + "\n";
}