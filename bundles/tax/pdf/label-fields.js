#!/usr/bin/env node

/**
 * PDF Field Label Script
 *
 * Fills each field with a short label showing its field name + sequential number.
 * Output: a labeled PDF you can visually inspect to build line→field mappings.
 *
 * Usage: node pdf/label-fields.js pdf/templates/f1040.pdf pdf/output/f1040-labeled.pdf
 */

import { PDFDocument } from "pdf-lib";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";

const [inputPath, outputPath] = process.argv.slice(2);
if (!inputPath || !outputPath) {
  console.error("Usage: node pdf/label-fields.js <input.pdf> <output.pdf>");
  process.exit(1);
}

const pdfBytes = readFileSync(inputPath);
const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
const form = pdfDoc.getForm();
const fields = form.getFields();

let textIdx = 0;
for (const field of fields) {
  const name = field.getName();
  const type = field.constructor.name;
  if (type === "PDFTextField") {
    try {
      const tf = form.getTextField(name);
      // Short label: sequential number + last part of field name
      const short = name.split(".").pop().replace("[0]", "");
      tf.setText(`#${textIdx}:${short}`);
      textIdx++;
    } catch {}
  }
}

const dir = outputPath.substring(0, outputPath.lastIndexOf("/"));
if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });

const filledBytes = await pdfDoc.save();
writeFileSync(outputPath, filledBytes);
console.log(`Labeled ${textIdx} text fields → ${outputPath}`);
