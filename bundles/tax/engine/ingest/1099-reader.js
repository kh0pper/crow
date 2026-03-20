/**
 * 1099 PDF Field Extraction
 *
 * Handles 1099-SA, 1099-INT, 1099-DIV, 1099-NEC, 1099-G, 1099-MISC.
 */

const PATTERNS = {
  sa: {
    grossDistribution: /(?:box\s*1|gross\s*distribution)[:\s]*\$?([\d,]+\.?\d*)/i,
    distributionCode: /(?:box\s*3|distribution\s*code)[:\s]*(\d)/i,
    payer: /(?:payer|trustee|issuer)['']?s?\s*name[:\s]+([A-Za-z][A-Za-z0-9 &.,'-]+)/i,
  },
  int: {
    interest: /(?:box\s*1|interest\s*income)[:\s]*\$?([\d,]+\.?\d*)/i,
    federalWithheld: /(?:box\s*4|federal\s*(?:income\s*)?tax\s*withheld)[:\s]*\$?([\d,]+\.?\d*)/i,
    payer: /(?:payer|issuer)['']?s?\s*name[:\s]+([A-Za-z][A-Za-z0-9 &.,'-]+)/i,
  },
  div: {
    ordinaryDividends: /(?:box\s*1a|(?:total\s*)?ordinary\s*dividends)[:\s]*\$?([\d,]+\.?\d*)/i,
    qualifiedDividends: /(?:box\s*1b|qualified\s*dividends)[:\s]*\$?([\d,]+\.?\d*)/i,
    capitalGainDistributions: /(?:box\s*2a|capital\s*gain\s*distributions?)[:\s]*\$?([\d,]+\.?\d*)/i,
    federalWithheld: /(?:box\s*4|federal\s*(?:income\s*)?tax\s*withheld)[:\s]*\$?([\d,]+\.?\d*)/i,
    payer: /(?:payer|issuer)['']?s?\s*name[:\s]+([A-Za-z][A-Za-z0-9 &.,'-]+)/i,
  },
  nec: {
    nonemployeeCompensation: /(?:box\s*1|nonemployee\s*compensation)[:\s]*\$?([\d,]+\.?\d*)/i,
    federalWithheld: /(?:box\s*4|federal\s*(?:income\s*)?tax\s*withheld)[:\s]*\$?([\d,]+\.?\d*)/i,
    payer: /(?:payer|issuer)['']?s?\s*name[:\s]+([A-Za-z][A-Za-z0-9 &.,'-]+)/i,
  },
  g: {
    unemploymentCompensation: /(?:box\s*1|unemployment\s*compensation)[:\s]*\$?([\d,]+\.?\d*)/i,
    stateRefund: /(?:box\s*2|state\s*(?:or\s*local\s*)?(?:income\s*)?tax\s*refund)[:\s]*\$?([\d,]+\.?\d*)/i,
    federalWithheld: /(?:box\s*4|federal\s*(?:income\s*)?tax\s*withheld)[:\s]*\$?([\d,]+\.?\d*)/i,
    payer: /(?:payer|agency)['']?s?\s*name[:\s]+([A-Za-z][A-Za-z0-9 &.,'-]+)/i,
  },
  misc: {
    rents: /(?:box\s*1|rents)[:\s]*\$?([\d,]+\.?\d*)/i,
    royalties: /(?:box\s*2|royalties)[:\s]*\$?([\d,]+\.?\d*)/i,
    otherIncome: /(?:box\s*3|other\s*income)[:\s]*\$?([\d,]+\.?\d*)/i,
    federalWithheld: /(?:box\s*4|federal\s*(?:income\s*)?tax\s*withheld)[:\s]*\$?([\d,]+\.?\d*)/i,
    payer: /(?:payer|issuer)['']?s?\s*name[:\s]+([A-Za-z][A-Za-z0-9 &.,'-]+)/i,
  },
};

function parseAmount(str) {
  if (!str) return 0;
  return parseFloat(String(str).replace(/[$,]/g, "")) || 0;
}

/**
 * Detect 1099 subtype from text content.
 */
function detect1099Type(text) {
  const t = text.toLowerCase();
  if (t.includes("1099-sa") || t.includes("distributions from")) return "sa";
  if (t.includes("1099-int") || t.includes("interest income")) return "int";
  if (t.includes("1099-div") || t.includes("dividends and distributions")) return "div";
  if (t.includes("1099-nec") || t.includes("nonemployee compensation")) return "nec";
  if (t.includes("1099-g") || t.includes("government payments")) return "g";
  if (t.includes("1099-misc") || t.includes("miscellaneous")) return "misc";
  return null;
}

/**
 * Extract 1099 data.
 *
 * @param {object|string} source - Form fields object or text content
 * @param {string} method - "form-fields", "text", or "ocr"
 * @returns {{ data: object, warnings: string[] }}
 */
export async function extract1099(source, method) {
  const text = typeof source === "string" ? source : JSON.stringify(source);
  const subtype = detect1099Type(text) || "misc";
  const patterns = PATTERNS[subtype] || PATTERNS.misc;

  const data = { payer: "" };
  const warnings = [];

  if (method === "form-fields" && typeof source === "object") {
    // Try direct field name matching
    for (const [fieldName, value] of Object.entries(source)) {
      const norm = fieldName.toLowerCase().trim();
      for (const [dataField, pattern] of Object.entries(patterns)) {
        if (norm.includes(dataField.toLowerCase()) || pattern.test(`${norm}: ${value}`)) {
          if (dataField === "payer") {
            data[dataField] = String(value).trim();
          } else if (dataField === "distributionCode") {
            data[dataField] = parseInt(String(value)) || 1;
          } else {
            data[dataField] = parseAmount(value);
          }
        }
      }
    }
  } else {
    // Text-based extraction
    for (const [field, pattern] of Object.entries(patterns)) {
      const match = text.match(pattern);
      if (match) {
        if (field === "payer") {
          data[field] = match[1].trim();
        } else if (field === "distributionCode") {
          data[field] = parseInt(match[1]) || 1;
        } else {
          data[field] = parseAmount(match[1]);
        }
      }
    }
  }

  // Set defaults for SA type
  if (subtype === "sa") {
    data.hsaOrMsa = data.hsaOrMsa || "hsa";
    data.distributionCode = data.distributionCode || 1;
  }

  if (!data.payer) warnings.push("Could not extract payer name");

  return { data, warnings, subtype };
}
