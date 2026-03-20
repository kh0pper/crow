#!/usr/bin/env node

/**
 * Quick PDF generation test — fills forms from the 2025 sample fixture.
 * Run: node tests/pdf.test.js
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { processReturn } from "../engine/index.js";
import { fillForms } from "../pdf/fill-forms.js";
import { generateSummary } from "../pdf/generate-summary.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const fixture = JSON.parse(
  readFileSync(resolve(__dirname, "fixtures/2025-sample.json"), "utf-8")
);

const { result, forms } = processReturn(fixture);

if (!result) {
  console.error("Calculation failed");
  process.exit(1);
}

console.log("Generating PDFs...");
const outputDir = resolve(__dirname, "../pdf/output");

const filledPaths = await fillForms(result, fixture, outputDir);
console.log(`\nFilled forms: ${filledPaths.length}`);
for (const p of filledPaths) {
  console.log(`  - ${p}`);
}

const summaryPath = await generateSummary(result, fixture, outputDir);
console.log(`\nSummary: ${summaryPath}`);

// Verify files exist
const allPaths = [...filledPaths, summaryPath];
let allOk = true;
for (const p of allPaths) {
  if (!existsSync(p)) {
    console.error(`MISSING: ${p}`);
    allOk = false;
  }
}

if (allOk) {
  console.log(`\nAll ${allPaths.length} PDFs generated successfully.`);
} else {
  console.error("\nSome PDFs failed to generate.");
  process.exit(1);
}
