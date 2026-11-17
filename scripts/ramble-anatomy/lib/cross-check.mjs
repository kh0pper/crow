/**
 * Cross-check of the figure engine's segment fractions against the ratios
 * measured on the source body.
 *
 * The two are not supposed to agree: BodyParts3D is one reference body, and the
 * figure engine's numbers come from a population-average set of segment
 * fractions. The table exists so a surprise (a segment off by a fifth) is
 * visible in the build output instead of hiding inside a drawing.
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Figure = require("../../../bundles/ramble/server/moves/figure.cjs");

const HEADER = "BodyParts3D is one reference body: this table is a cross-check only, not a target.";

/**
 * One row per figure.cjs SEGMENTS key, comparing the engine's fraction of
 * height with the landmark measurement. A row is flagged when the model
 * differs from the figure by more than thresholdPct per cent.
 */
export function crossCheck(landmarks, thresholdPct = 5) {
  if (typeof thresholdPct !== "number" || !Number.isFinite(thresholdPct) || thresholdPct < 0) {
    throw new Error("crossCheck: thresholdPct must be a number from 0 up");
  }
  const ratios = landmarks && typeof landmarks === "object" ? landmarks.ratios : null;
  const rows = [];
  for (const segment of Object.keys(Figure.SEGMENTS)) {
    const figure = Figure.SEGMENTS[segment];
    const model = ratios && typeof ratios === "object" ? ratios[segment] : undefined;
    const diffPct = 100 * (model - figure) / figure;
    rows.push({
      segment,
      figure,
      model,
      diffPct,
      flagged: Math.abs(diffPct) > thresholdPct,
    });
  }
  return { rows, flaggedCount: rows.filter((row) => row.flagged).length };
}

const pad = (text, width) => String(text).padStart(width);
const padEnd = (text, width) => String(text).padEnd(width);
const fixed = (value, digits) => (Number.isFinite(value) ? value.toFixed(digits) : "n/a");

/** The cross-check as a plain-text table: segment, figure, model, difference, flag. */
export function formatCrossCheck(result) {
  if (!result || !Array.isArray(result.rows)) throw new Error("formatCrossCheck: expected a crossCheck() result");
  const lines = [
    HEADER,
    padEnd("segment", 12) + pad("figure", 8) + pad("model", 8) + pad("diff %", 9) + "  flag",
  ];
  for (const row of result.rows) {
    lines.push(
      padEnd(row.segment, 12)
      + pad(fixed(row.figure, 4), 8)
      + pad(fixed(row.model, 4), 8)
      + pad(fixed(row.diffPct, 2), 9)
      + "  " + (row.flagged ? "FLAGGED" : ""),
    );
  }
  lines.push(result.flaggedCount + " row(s) beyond the threshold");
  return lines.join("\n");
}