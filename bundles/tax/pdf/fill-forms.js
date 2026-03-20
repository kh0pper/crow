/**
 * Crow Tax — PDF Form Filler
 *
 * Uses pdf-lib to fill official IRS PDF forms with calculated values.
 * Templates must be downloaded from irs.gov and placed in pdf/templates/.
 */

import { PDFDocument } from "pdf-lib";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { getAllFormLines, FORM_REGISTRY, requiredForms } from "../engine/forms/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Load PDF field mappings for a given tax year.
 * Maps our line IDs to actual IRS PDF field names.
 */
function loadFieldMappings(year) {
  const path = resolve(__dirname, "../engine/fields", `${year}-fields.json`);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf-8"));
}

/**
 * Fill a single IRS PDF form with line values.
 *
 * @param {string} formId - Our form ID (e.g., "f1040")
 * @param {object} lineValues - { lineNumber: value }
 * @param {string} outputDir - Output directory
 * @param {number} year - Tax year (for field mappings)
 * @returns {string|null} Output file path, or null if template not found
 */
async function fillSingleForm(formId, lineValues, outputDir, year) {
  const formInfo = FORM_REGISTRY[formId];
  if (!formInfo) return null;

  const templatePath = resolve(__dirname, "templates", formInfo.pdfTemplate);
  if (!existsSync(templatePath)) {
    console.error(`Template not found: ${templatePath}`);
    return null;
  }

  const pdfBytes = readFileSync(templatePath);
  // IRS PDFs use XFA — pdf-lib strips it automatically, which is fine for filling AcroForm fields
  const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const form = pdfDoc.getForm();

  // Try loading field mappings
  const mappings = loadFieldMappings(year);
  const formMappings = mappings?.[formId] || {};

  let filled = 0;
  let skipped = 0;

  // Fill fields
  for (const [line, value] of Object.entries(lineValues)) {
    if (value === 0 || value === "" || value == null) continue;
    // Skip comment keys
    if (line.startsWith("_")) continue;

    // Use field mapping if available
    const fieldName = formMappings[line];
    if (!fieldName) {
      skipped++;
      continue;
    }

    try {
      const field = form.getTextField(fieldName);
      if (field) {
        const text = typeof value === "number"
          ? (Number.isInteger(value) ? String(value) : value.toFixed(2))
          : String(value);
        field.setText(text);
        filled++;
      }
    } catch {
      skipped++;
    }
  }

  console.error(`[${formId}] Filled ${filled} fields, skipped ${skipped}`);

  // Flatten to prevent further editing
  form.flatten();

  const filledBytes = await pdfDoc.save();
  const outputPath = resolve(outputDir, `${formId}-${year}-filled.pdf`);
  writeFileSync(outputPath, filledBytes);

  return outputPath;
}

/**
 * Guess IRS PDF field name from our line ID.
 * This is a fallback — proper mappings should be in fields/*.json
 */
function guessFieldName(formId, lineId) {
  // IRS forms often use patterns like "topmostSubform[0].Page1[0].f1_01[0]"
  // Without inspecting the actual PDF, we can't reliably guess
  // Return null to skip — use discover-fields.js to build the mapping
  return null;
}

/**
 * Fill all required IRS PDF forms for a calculated return.
 *
 * @param {object} result - TaxResult from calculator
 * @param {object} taxReturn - Original TaxReturn data
 * @param {string} outputDir - Output directory
 * @returns {string[]} Array of output file paths
 */
export async function fillForms(result, taxReturn, outputDir) {
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  const allForms = getAllFormLines(result, taxReturn);
  const files = [];

  for (const [formId, formData] of Object.entries(allForms)) {
    const path = await fillSingleForm(formId, formData.lines, outputDir, result.taxYear);
    if (path) files.push(path);
  }

  return files;
}
