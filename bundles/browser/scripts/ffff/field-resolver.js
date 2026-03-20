/**
 * FFFF Field Resolver
 *
 * Resolves crow-tax line IDs to FFFF DOM elements using aria-label attributes.
 * FFFF randomizes DOM `id` attributes, so we must search by aria-label or
 * visible text content instead.
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Load a field map for a given form and tax year.
 * Field maps are in ../field-maps/{year}-{form}.json
 *
 * @param {string} formId - e.g. "f1040", "schedule1", "f8889", "f8863"
 * @param {number} year - Tax year (e.g. 2025)
 * @returns {object} Map of line ID → { aria_label, description, type }
 */
export function loadFieldMap(formId, year) {
  const filePath = join(__dirname, "..", "field-maps", `${year}-${formId}.json`);
  try {
    return JSON.parse(readFileSync(filePath, "utf-8"));
  } catch {
    throw new Error(`Field map not found: ${filePath}. Run selector discovery on FFFF to generate it.`);
  }
}

/**
 * Resolve a crow-tax line ID to a CSS selector that works in FFFF.
 *
 * Strategy:
 *   1. Look up aria-label from field map
 *   2. Build a CSS attribute selector: [aria-label="..."]
 *   3. If no aria-label, fall back to name attribute
 *
 * @param {string} lineId - crow-tax line ID (e.g. "1", "7", "8a")
 * @param {object} fieldMap - Loaded field map
 * @returns {string} CSS selector
 */
export function resolveSelector(lineId, fieldMap) {
  const entry = fieldMap[lineId];
  if (!entry) {
    throw new Error(`No field map entry for line ${lineId}`);
  }

  if (entry.aria_label) {
    return `[aria-label="${entry.aria_label}"]`;
  }
  if (entry.name) {
    return `[name="${entry.name}"]`;
  }
  throw new Error(`No resolvable selector for line ${lineId}. Run discovery to update field map.`);
}

/**
 * Discover all input fields in a FFFF form frame and generate a field map template.
 * This is meant to be run interactively to build/update field maps.
 *
 * @param {object} page - Playwright Page (or Frame) object
 * @returns {Promise<object>} Discovered elements with their attributes
 */
export async function discoverFields(page) {
  return page.evaluate(() => {
    const inputs = document.querySelectorAll("input, select, textarea");
    const fields = {};
    let index = 0;

    for (const el of inputs) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;

      fields[`field_${index}`] = {
        tag: el.tagName.toLowerCase(),
        type: el.type || null,
        id: el.id || null,
        name: el.name || null,
        aria_label: el.getAttribute("aria-label") || null,
        placeholder: el.placeholder || null,
        value: el.value || null,
        readonly: el.readOnly || false,
        position: { x: Math.round(rect.x), y: Math.round(rect.y) },
      };
      index++;
    }

    return fields;
  });
}

/**
 * Build a selector→value map from crow-tax form lines and a field map.
 *
 * @param {object} formLines - From crow_tax_get_form (line ID → value)
 * @param {object} fieldMap - Loaded field map
 * @returns {{ fields: Record<string,string>, unmapped: string[] }}
 */
export function buildFillMap(formLines, fieldMap) {
  const fields = {};
  const unmapped = [];

  for (const [lineId, value] of Object.entries(formLines)) {
    if (value === 0 || value === "" || value === null || value === undefined) continue;

    try {
      const selector = resolveSelector(lineId, fieldMap);
      fields[selector] = String(typeof value === "number" ? value.toFixed(2) : value);
    } catch {
      unmapped.push(lineId);
    }
  }

  return { fields, unmapped };
}
