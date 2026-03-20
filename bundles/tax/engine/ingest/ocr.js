/**
 * PDF Text Extraction and OCR
 *
 * Pipeline: pdf-lib form fields → positional text → plain text → OCR fallback
 *
 * Key insight: many W-2 PDFs have values in separate text layers that plain
 * extraction misses. Positional extraction preserves the layout by sorting
 * text items by (y, x) position and grouping into rows.
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
 * Extract text with positional information — preserves layout by grouping
 * text items into rows based on Y coordinate.
 *
 * This is the preferred extraction method for W-2s and similar forms where
 * labels and values are in separate text layers.
 *
 * @param {Buffer} pdfBuffer
 * @returns {Promise<string>} Text with positional layout preserved
 */
export async function extractTextPositional(pdfBuffer) {
  const pdfParse = (await import("pdf-parse")).default;

  const result = await pdfParse(pdfBuffer, {
    pagerender: function (pageData) {
      return pageData.getTextContent().then(function (content) {
        const items = content.items.map((item) => ({
          text: item.str,
          x: Math.round(item.transform[4]),
          y: Math.round(item.transform[5]),
        }));

        // Sort by Y (top to bottom), then X (left to right)
        items.sort((a, b) => b.y - a.y || a.x - b.x);

        // Group by Y position (within 3px tolerance)
        const rows = [];
        let currentRow = [];
        let lastY = null;
        for (const item of items) {
          if (lastY !== null && Math.abs(item.y - lastY) > 3) {
            if (currentRow.length) rows.push(currentRow);
            currentRow = [];
          }
          if (item.text.trim()) currentRow.push(item);
          lastY = item.y;
        }
        if (currentRow.length) rows.push(currentRow);

        // Join each row's items with separator
        return rows.map((row) => row.map((item) => item.text.trim()).join(" | ")).join("\n");
      });
    },
  });

  return result.text;
}

/**
 * Extract plain text content from a PDF using pdf-parse (default mode).
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
  const text = await extractText(pdfBuffer);
  if (text && text.trim().length > 50) {
    return text;
  }
  throw new Error(
    "OCR extraction not available. The PDF appears to be image-based. " +
    "Install tesseract.js and pdf2pic for OCR support, or manually enter the values."
  );
}
