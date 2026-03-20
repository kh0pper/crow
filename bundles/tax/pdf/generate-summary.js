/**
 * Crow Tax — Summary PDF Generator
 *
 * Creates a clean summary document with all calculated values,
 * organized by form, with explanations from workPapers.
 */

import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { getAllFormLines, FORM_REGISTRY } from "../engine/forms/index.js";

/**
 * Generate a summary PDF for the tax return.
 */
export async function generateSummary(result, taxReturn, outputDir) {
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Courier);
  const boldFont = await pdfDoc.embedFont(StandardFonts.CourierBold);

  const fontSize = 9;
  const titleSize = 14;
  const headingSize = 11;
  const margin = 50;
  const lineHeight = 12;

  let page = pdfDoc.addPage([612, 792]); // Letter size
  let y = 792 - margin;

  function addText(text, size = fontSize, useBold = false) {
    if (y < margin + lineHeight) {
      page = pdfDoc.addPage([612, 792]);
      y = 792 - margin;
    }
    page.drawText(text, {
      x: margin,
      y,
      size,
      font: useBold ? boldFont : font,
      color: rgb(0, 0, 0),
    });
    y -= lineHeight;
  }

  function addBlankLine() {
    y -= lineHeight / 2;
  }

  // Title
  addText(`Tax Return Summary — ${result.taxYear}`, titleSize, true);
  addText(`Filing Status: ${result.filingStatus.toUpperCase()}`, fontSize);
  addText(`Taxpayer: ${taxReturn.taxpayer.name}`, fontSize);
  if (taxReturn.spouse) addText(`Spouse: ${taxReturn.spouse.name}`, fontSize);
  addText(`Generated: ${new Date().toISOString().split("T")[0]}`, fontSize);
  addBlankLine();

  // Summary section
  addText("SUMMARY", headingSize, true);
  addText(`  Total Income:       $${result.income.totalIncome.toFixed(2)}`);
  addText(`  Adjustments:        $${result.adjustments.totalAdjustments.toFixed(2)}`);
  addText(`  AGI:                $${result.agi.toFixed(2)}`);
  addText(`  Deduction:          $${result.deduction.chosen.toFixed(2)} (${result.deduction.usesItemized ? "itemized" : "standard"})`);
  addText(`  Taxable Income:     $${result.taxableIncome.toFixed(2)}`);
  addText(`  Total Tax:          $${result.result.totalTax.toFixed(2)}`);
  addText(`  Total Payments:     $${result.payments.totalPayments.toFixed(2)}`);
  if (result.result.refundOrOwed >= 0) {
    addText(`  REFUND:             $${result.result.refundOrOwed.toFixed(2)}`);
  } else {
    addText(`  AMOUNT OWED:        $${Math.abs(result.result.refundOrOwed).toFixed(2)}`);
  }
  addBlankLine();

  // Form-by-form detail
  const allForms = getAllFormLines(result, taxReturn);
  for (const [formId, formData] of Object.entries(allForms)) {
    addText(`${formData.name} — ${formData.title}`, headingSize, true);
    const entries = Object.entries(formData.lines)
      .filter(([_, v]) => v !== 0 && v !== "" && v != null);
    for (const [line, value] of entries) {
      const formatted = typeof value === "number" ? `$${value.toFixed(2)}` : String(value);
      addText(`  Line ${line.padEnd(12)} ${formatted}`);
    }
    addBlankLine();
  }

  // Work papers
  addText("WORK PAPERS (Audit Trail)", headingSize, true);
  for (const wp of result.workPapers) {
    const val = typeof wp.value === "number" ? `$${wp.value.toFixed(2)}` : wp.value;
    addText(`  ${wp.line.padEnd(14)} ${val}`);
    // Wrap long explanations
    const expLines = wrapText(wp.explanation, 70);
    for (const el of expLines) {
      addText(`    ${el}`);
    }
  }

  // Save
  const pdfBytes = await pdfDoc.save();
  const outputPath = resolve(outputDir, `tax-summary-${result.taxYear}.pdf`);
  writeFileSync(outputPath, pdfBytes);

  return outputPath;
}

function wrapText(text, maxWidth) {
  const words = text.split(" ");
  const lines = [];
  let current = "";
  for (const word of words) {
    if ((current + " " + word).length > maxWidth) {
      if (current) lines.push(current);
      current = word;
    } else {
      current = current ? current + " " + word : word;
    }
  }
  if (current) lines.push(current);
  return lines;
}
