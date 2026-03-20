/**
 * Document Ingestion Coordinator
 *
 * Reads tax documents (W-2, 1099, 1098-T) from PDF files.
 * Pipeline: pdf-lib form fields → pdf-parse text → tesseract OCR fallback
 * Returns extracted data with confidence scores.
 */

import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { extractW2 } from "./w2-reader.js";
import { extract1099 } from "./1099-reader.js";
import { extract1098T } from "./1098t-reader.js";
import { scoreConfidence } from "./confidence.js";

/**
 * Supported document types and their extractors.
 */
const EXTRACTORS = {
  "w2": extractW2,
  "1099-sa": extract1099,
  "1099-int": extract1099,
  "1099-div": extract1099,
  "1099-nec": extract1099,
  "1099-g": extract1099,
  "1099-misc": extract1099,
  "1098-t": extract1098T,
};

/**
 * Ingest a tax document from a PDF file.
 *
 * @param {string} filePath - Path to the PDF file
 * @param {string} documentType - Type of document (w2, 1099-sa, 1098-t, etc.)
 * @returns {Promise<{ data: object, confidence: object, warnings: string[], raw_text: string }>}
 */
export async function ingestDocument(filePath, documentType) {
  const type = documentType.toLowerCase();
  const extractor = EXTRACTORS[type];
  if (!extractor) {
    throw new Error(`Unsupported document type: ${documentType}. Supported: ${Object.keys(EXTRACTORS).join(", ")}`);
  }

  const ext = extname(filePath).toLowerCase();
  if (ext !== ".pdf") {
    throw new Error(`Only PDF files are supported. Got: ${ext}`);
  }

  const pdfBuffer = readFileSync(filePath);

  // Pipeline: try form fields first, then text extraction, then OCR
  let result;
  let method;

  // Step 1: Try pdf-lib AcroForm field extraction (best for fillable PDFs)
  try {
    const { extractFormFields } = await import("./ocr.js");
    const formFields = await extractFormFields(pdfBuffer);
    if (formFields && Object.keys(formFields).length > 3) {
      result = await extractor(formFields, "form-fields");
      method = "form-fields";
    }
  } catch {
    // Form fields not available, try text
  }

  // Step 2: Try pdf-parse text extraction
  if (!result) {
    try {
      const { extractText } = await import("./ocr.js");
      const text = await extractText(pdfBuffer);
      if (text && text.trim().length > 50) {
        result = await extractor(text, "text");
        method = "text";
      }
    } catch {
      // Text extraction failed
    }
  }

  // Step 3: OCR fallback (tesseract.js)
  if (!result) {
    try {
      const { ocrExtract } = await import("./ocr.js");
      const text = await ocrExtract(pdfBuffer);
      result = await extractor(text, "ocr");
      method = "ocr";
    } catch (err) {
      throw new Error(`All extraction methods failed for ${filePath}: ${err.message}`);
    }
  }

  // Score confidence for each extracted field
  const confidence = scoreConfidence(result.data, method, type);

  return {
    data: result.data,
    confidence,
    method,
    warnings: result.warnings || [],
    low_confidence_fields: Object.entries(confidence)
      .filter(([_, score]) => score < 0.9)
      .map(([field, score]) => ({ field, score: Math.round(score * 100) })),
  };
}
