/**
 * Maker Lab — lesson JSON validator.
 *
 * Shared by the `maker_validate_lesson` MCP tool and the panel's
 * "Import lesson" flow. Returns { valid, errors } — errors are
 * specific strings a teacher/parent can read without reading code.
 */

const VALID_AGE_BANDS = ["5-9", "10-13", "14+"];
const VALID_SURFACES = ["blockly", "scratch", "kolibri"];
const ID_RE = /^[a-zA-Z0-9][\w-]{0,99}$/;

export function validateLesson(lesson) {
  const errors = [];
  if (!lesson || typeof lesson !== "object" || Array.isArray(lesson)) {
    return { valid: false, errors: ["top-level value must be a JSON object"] };
  }

  // Required fields
  const required = ["id", "title", "surface", "age_band", "steps", "canned_hints"];
  for (const k of required) {
    if (!(k in lesson)) errors.push(`missing: ${k}`);
  }

  if (lesson.id != null && !ID_RE.test(String(lesson.id))) {
    errors.push(`id must match ${ID_RE.source} (alphanumeric start, letters/digits/underscore/dash, max 100)`);
  }
  if (lesson.title != null && typeof lesson.title !== "string") {
    errors.push("title must be a string");
  }
  if (lesson.surface != null && !VALID_SURFACES.includes(lesson.surface)) {
    errors.push(`surface must be one of: ${VALID_SURFACES.join(", ")}`);
  }
  if (lesson.age_band != null && !VALID_AGE_BANDS.includes(lesson.age_band)) {
    errors.push(`age_band must be one of: ${VALID_AGE_BANDS.join(", ")}`);
  }

  // canned_hints
  if (lesson.canned_hints != null) {
    if (!Array.isArray(lesson.canned_hints)) {
      errors.push("canned_hints must be an array of strings");
    } else {
      if (lesson.canned_hints.length === 0) {
        errors.push("canned_hints must have at least one entry");
      }
      for (let i = 0; i < lesson.canned_hints.length; i++) {
        if (typeof lesson.canned_hints[i] !== "string") {
          errors.push(`canned_hints[${i}] must be a string`);
        } else if (lesson.canned_hints[i].length > 500) {
          errors.push(`canned_hints[${i}] too long (>500 chars)`);
        }
      }
    }
  }

  // reading_level: for 5-9 must be <= 3
  if (lesson.reading_level != null) {
    if (typeof lesson.reading_level !== "number") {
      errors.push("reading_level must be a number");
    } else if (lesson.age_band === "5-9" && lesson.reading_level > 3) {
      errors.push(`reading_level must be <= 3 for age_band '5-9' (got ${lesson.reading_level})`);
    }
  }

  // steps
  if (lesson.steps != null) {
    if (!Array.isArray(lesson.steps)) {
      errors.push("steps must be an array");
    } else {
      if (lesson.steps.length === 0) {
        errors.push("steps must have at least one entry");
      }
      for (let i = 0; i < lesson.steps.length; i++) {
        const s = lesson.steps[i];
        if (!s || typeof s !== "object") {
          errors.push(`steps[${i}] must be an object`);
          continue;
        }
        if (!s.prompt || typeof s.prompt !== "string") {
          errors.push(`steps[${i}].prompt missing or not a string`);
        } else if (s.prompt.length > 1000) {
          errors.push(`steps[${i}].prompt too long (>1000 chars)`);
        }
      }
    }
  }

  // Optional fields sanity-check
  if (lesson.goal != null && typeof lesson.goal !== "string") {
    errors.push("goal must be a string");
  }
  if (lesson.starter_workspace != null && typeof lesson.starter_workspace !== "string") {
    errors.push("starter_workspace must be a string (Blockly XML)");
  }
  if (lesson.tags != null) {
    if (!Array.isArray(lesson.tags) || lesson.tags.some((t) => typeof t !== "string")) {
      errors.push("tags must be an array of strings");
    }
  }

  return { valid: errors.length === 0, errors };
}
