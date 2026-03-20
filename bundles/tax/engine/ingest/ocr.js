/**
 * PDF Text Extraction and OCR
 *
 * Pipeline: pdf-lib form fields → pdf-parse text → tesseract.js OCR
 */

/**
 * Extract AcroForm field values from a fillable PDF using pdf-lib.
 *
 * @param {Buffer} pdfBuffer
 * @returns {Promise<object|null>} Map of field name → value, or null if no form fields
 */
export async function extractFormFields(pdfBuffer) {
  const { PDFDocument } = await import("pdf-lib");
  const pdfDoc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
  const form = pdfDoc.getForm();
  const fields = form.getFields();

  if (fields.length === 0) return null;

  const result = {};
  for (const field of fields) {
    const name = field.getName();
    try {
      // Try getText for text fields
      if (typeof field.getText === "function") {
        result[name] = field.getText() || "";
      } else if (typeof field.isChecked === "function") {
        result[name] = field.isChecked();
      } else if (typeof field.getSelected === "function") {
        result[name] = field.getSelected();
      }
    } catch {
      result[name] = "";
    }
  }

  return result;
}

/**
 * Extract text content from a PDF using pdf-parse.
 *
 * @param {Buffer} pdfBuffer
 * @returns {Promise<string>}
 */
export async function extractText(pdfBuffer) {
  const pdfParse = (await import("pdf-parse")).default;
  const result = await pdfParse(pdfBuffer);
  return result.text;
}

/**
 * OCR fallback using tesseract.js (for scanned/image PDFs).
 *
 * @param {Buffer} pdfBuffer
 * @returns {Promise<string>}
 */
export async function ocrExtract(pdfBuffer) {
  // tesseract.js works with images, not PDFs directly.
  // For OCR, we first need to convert PDF pages to images.
  // This requires a heavier dependency chain (pdf2pic or similar).
  // For now, try pdf-parse first — most tax documents are text-based PDFs.
  const text = await extractText(pdfBuffer);
  if (text && text.trim().length > 50) {
    return text;
  }
  throw new Error(
    "OCR extraction not available. The PDF appears to be image-based. " +
    "Install tesseract.js and pdf2pic for OCR support, or manually enter the values."
  );
}
