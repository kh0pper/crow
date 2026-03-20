/**
 * W-2 PDF Field Extraction
 *
 * Extracts W-2 data from form fields or text content.
 * Handles both fillable PDFs (form-fields) and scanned copies (text/ocr).
 */

// Common W-2 field name patterns (from IRS and payroll providers)
const W2_FIELD_MAP = {
  "box1": "wages",
  "box 1": "wages",
  "wages": "wages",
  "wages, tips": "wages",
  "wages_tips_other_comp": "wages",
  "box2": "federalWithheld",
  "box 2": "federalWithheld",
  "federal income tax withheld": "federalWithheld",
  "fed_income_tax_withheld": "federalWithheld",
  "box3": "ssWages",
  "box 3": "ssWages",
  "social security wages": "ssWages",
  "ss_wages": "ssWages",
  "box4": "ssTaxWithheld",
  "box 4": "ssTaxWithheld",
  "social security tax withheld": "ssTaxWithheld",
  "ss_tax_withheld": "ssTaxWithheld",
  "box5": "medicareWages",
  "box 5": "medicareWages",
  "medicare wages": "medicareWages",
  "medicare_wages_tips": "medicareWages",
  "box6": "medicareTaxWithheld",
  "box 6": "medicareTaxWithheld",
  "medicare tax withheld": "medicareTaxWithheld",
  "medicare_tax_withheld": "medicareTaxWithheld",
  "box16": "stateWages",
  "box 16": "stateWages",
  "state wages": "stateWages",
  "box17": "stateWithheld",
  "box 17": "stateWithheld",
  "state income tax": "stateWithheld",
  "employer name": "employer",
  "employer": "employer",
  "employer_name": "employer",
  "ein": "ein",
  "employer identification number": "ein",
};

// Regex patterns for text extraction
const W2_TEXT_PATTERNS = {
  wages: /(?:box\s*1|wages,?\s*tips|compensation)[:\s]*\$?([\d,]+\.?\d*)/i,
  federalWithheld: /(?:box\s*2|federal\s*(?:income\s*)?tax\s*withheld)[:\s]*\$?([\d,]+\.?\d*)/i,
  ssWages: /(?:box\s*3|social\s*security\s*wages)[:\s]*\$?([\d,]+\.?\d*)/i,
  ssTaxWithheld: /(?:box\s*4|social\s*security\s*tax\s*withheld)[:\s]*\$?([\d,]+\.?\d*)/i,
  medicareWages: /(?:box\s*5|medicare\s*wages)[:\s]*\$?([\d,]+\.?\d*)/i,
  medicareTaxWithheld: /(?:box\s*6|medicare\s*tax\s*withheld)[:\s]*\$?([\d,]+\.?\d*)/i,
  stateWages: /(?:box\s*16|state\s*wages)[:\s]*\$?([\d,]+\.?\d*)/i,
  stateWithheld: /(?:box\s*17|state\s*(?:income\s*)?tax)[:\s]*\$?([\d,]+\.?\d*)/i,
  employer: /(?:employer['']?s?\s*name|employer)[:\s]+([A-Za-z][A-Za-z0-9 &.,'-]+)/i,
  ein: /(?:ein|employer\s*identification)[:\s]*([\d-]+)/i,
};

// Box 12 code patterns
const BOX12_PATTERN = /(?:box\s*12|12[a-d])\s*(?:code\s*)?([A-Z]{1,2})\s*\$?([\d,]+\.?\d*)/gi;

function parseAmount(str) {
  if (!str) return 0;
  return parseFloat(String(str).replace(/[$,]/g, "")) || 0;
}

/**
 * Extract W-2 data.
 *
 * @param {object|string} source - Form fields object or text content
 * @param {string} method - "form-fields", "text", or "ocr"
 * @returns {{ data: object, warnings: string[] }}
 */
export async function extractW2(source, method) {
  const data = {
    employer: "",
    ein: "",
    wages: 0,
    federalWithheld: 0,
    ssWages: 0,
    ssTaxWithheld: 0,
    medicareWages: 0,
    medicareTaxWithheld: 0,
    stateWages: 0,
    stateWithheld: 0,
    code12: [],
    isStatutoryEmployee: false,
  };
  const warnings = [];

  if (method === "form-fields" && typeof source === "object") {
    // Extract from form field names
    for (const [fieldName, value] of Object.entries(source)) {
      const normalizedName = fieldName.toLowerCase().trim();
      const canonicalField = W2_FIELD_MAP[normalizedName];
      if (canonicalField) {
        if (canonicalField === "employer" || canonicalField === "ein") {
          data[canonicalField] = String(value).trim();
        } else {
          data[canonicalField] = parseAmount(value);
        }
      }
    }

    // Check for Box 12 entries in form fields
    for (const [fieldName, value] of Object.entries(source)) {
      const match = fieldName.match(/12[a-d]?\s*(?:code)?/i);
      if (match && value) {
        const codeMatch = String(value).match(/^([A-Z]{1,2})\s*([\d,.]+)?$/);
        if (codeMatch) {
          data.code12.push({ code: codeMatch[1], amount: parseAmount(codeMatch[2]) });
        }
      }
    }
  } else {
    // Extract from text content
    const text = typeof source === "string" ? source : JSON.stringify(source);

    for (const [field, pattern] of Object.entries(W2_TEXT_PATTERNS)) {
      const match = text.match(pattern);
      if (match) {
        if (field === "employer" || field === "ein") {
          data[field] = match[1].trim();
        } else {
          data[field] = parseAmount(match[1]);
        }
      } else if (field !== "employer" && field !== "ein" && field !== "stateWages" && field !== "stateWithheld") {
        warnings.push(`Could not find ${field} in document text`);
      }
    }

    // Extract Box 12 entries from text
    let box12Match;
    while ((box12Match = BOX12_PATTERN.exec(text)) !== null) {
      data.code12.push({ code: box12Match[1], amount: parseAmount(box12Match[2]) });
    }
  }

  // Sanity checks
  if (data.wages === 0) warnings.push("Wages (Box 1) is $0 — verify this is correct");
  if (data.ssWages > 0 && data.ssWages < data.wages * 0.5) warnings.push("SS wages seem low relative to total wages");
  if (data.medicareWages > 0 && Math.abs(data.medicareWages - data.wages) > 1000) warnings.push("Medicare wages differ significantly from wages");
  if (!data.employer) warnings.push("Could not extract employer name");

  return { data, warnings };
}
