#!/usr/bin/env node

/**
 * PDF Field Discovery Script
 *
 * Dumps all form field names from an IRS PDF.
 * Usage: node pdf/discover-fields.js pdf/templates/f1040.pdf
 */

import { PDFDocument } from "pdf-lib";
import { readFileSync } from "node:fs";

const pdfPath = process.argv[2];
if (!pdfPath) {
  console.error("Usage: node pdf/discover-fields.js <path-to-pdf>");
  process.exit(1);
}

const pdfBytes = readFileSync(pdfPath);
const pdfDoc = await PDFDocument.load(pdfBytes);
const form = pdfDoc.getForm();
const fields = form.getFields();

console.log(`Found ${fields.length} fields in ${pdfPath}:\n`);

for (const field of fields) {
  const type = field.constructor.name;
  const name = field.getName();
  console.log(`  [${type}] ${name}`);
}
