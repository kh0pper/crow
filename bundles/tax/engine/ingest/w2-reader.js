/**
 * W-2 PDF Field Extraction — Structural Parser
 *
 * Parses W-2 PDF text using the known structural layout:
 * - Labels and values appear in a predictable sequence
 * - Box 1+2 values often concatenate on one line
 * - Box 3/5 values on separate lines, followed by Box 4/6
 * - Box 12 codes concatenate with amounts (e.g., "DD4400.16")
 * - PDFs contain 4 copies (Copy 1, 2, B, C) — use first data block only
 */

function parseAmount(str) {
  if (!str) return 0;
  return parseFloat(String(str).replace(/[$,]/g, "")) || 0;
}

/**
 * Split concatenated Box 1 + Box 2 values.
 * Pattern: "60000.215161.44" → wages=60000.21, withheld=5161.44
 * Strategy: find the split point where both halves are valid dollar amounts.
 */
function splitConcatenatedAmounts(str) {
  const s = str.replace(/[$,]/g, "").trim();
  // Try splitting at each decimal point
  const decimals = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === ".") decimals.push(i);
  }

  if (decimals.length === 2) {
    // Two decimal points → split between them
    // Find where second number starts: after first decimal + 2 digits
    const firstDecPos = decimals[0];
    const splitPos = firstDecPos + 3; // .XX then next number starts
    if (splitPos < s.length) {
      const a = parseFloat(s.substring(0, splitPos));
      const b = parseFloat(s.substring(splitPos));
      if (!isNaN(a) && !isNaN(b) && a > 0 && b > 0) {
        return [a, b];
      }
    }
  }

  if (decimals.length === 1) {
    // Only one decimal — might be just one value, or concatenated without decimal on second
    return [parseFloat(s), 0];
  }

  if (decimals.length === 0) {
    // No decimals — whole number
    return [parseFloat(s), 0];
  }

  // Fallback
  return [parseFloat(s), 0];
}

/**
 * Extract W-2 data using structural parsing.
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
    // Form field extraction (fillable PDFs) — use field name matching
    const fieldMap = {
      "box1": "wages", "box 1": "wages", "wages": "wages",
      "box2": "federalWithheld", "box 2": "federalWithheld",
      "federal income tax withheld": "federalWithheld",
      "box3": "ssWages", "box 3": "ssWages", "social security wages": "ssWages",
      "box4": "ssTaxWithheld", "box 4": "ssTaxWithheld",
      "box5": "medicareWages", "box 5": "medicareWages", "medicare wages": "medicareWages",
      "box6": "medicareTaxWithheld", "box 6": "medicareTaxWithheld",
      "box16": "stateWages", "box 16": "stateWages",
      "box17": "stateWithheld", "box 17": "stateWithheld",
      "employer name": "employer", "employer": "employer",
      "ein": "ein", "employer identification number": "ein",
    };
    for (const [fieldName, value] of Object.entries(source)) {
      const norm = fieldName.toLowerCase().trim();
      const target = fieldMap[norm];
      if (target) {
        if (target === "employer" || target === "ein") {
          data[target] = String(value).trim();
        } else {
          data[target] = parseAmount(value);
        }
      }
    }
    return { data, warnings };
  }

  // --- Structural text parsing ---
  const text = typeof source === "string" ? source : JSON.stringify(source);
  const lines = text.split("\n").map(l => l.trim()).filter(l => l.length > 0);

  // Extract from first copy only (stop at second "OMB No." or "Copy B")
  let dataLines = lines;
  const secondOmb = lines.findIndex((l, i) => i > 10 && l.includes("OMB No. 1545-0008"));
  if (secondOmb > 0) {
    dataLines = lines.slice(0, secondOmb);
  }

  // Find SSN
  const ssnLine = dataLines.find(l => /^\d{3}-\d{2}-\d{4}$/.test(l));

  // Find EIN (format: XX-XXXXXXX, appears after "Employer ID")
  const einIdx = dataLines.findIndex(l => l.includes("Employer ID") || l.includes("EIN"));
  if (einIdx >= 0) {
    for (let i = einIdx; i < Math.min(einIdx + 3, dataLines.length); i++) {
      const m = dataLines[i].match(/^(\d{2}-\d{7})$/);
      if (m) { data.ein = m[1]; break; }
    }
  }

  // Find wages line — "Wages, tips" label followed by concatenated amounts
  const wagesLabelIdx = dataLines.findIndex(l =>
    l.includes("Wages, tips") || l.includes("wages, tips")
  );
  if (wagesLabelIdx >= 0) {
    // Next line with numbers is Box 1 + Box 2
    for (let i = wagesLabelIdx + 1; i < Math.min(wagesLabelIdx + 3, dataLines.length); i++) {
      if (/^\d/.test(dataLines[i])) {
        const [box1, box2] = splitConcatenatedAmounts(dataLines[i]);
        data.wages = box1;
        data.federalWithheld = box2;
        break;
      }
    }
  }

  // Find SS wages and Medicare wages — they appear as separate values after their labels
  const ssWagesIdx = dataLines.findIndex(l => l === "Social security wages" || l.includes("Social security wages"));
  const medWagesIdx = dataLines.findIndex(l => l.includes("Medicare wages and tips"));

  if (ssWagesIdx >= 0 && medWagesIdx >= 0) {
    // Values appear after both labels, on consecutive lines
    const afterLabels = Math.max(ssWagesIdx, medWagesIdx) + 1;
    const numberLines = [];
    for (let i = afterLabels; i < Math.min(afterLabels + 5, dataLines.length); i++) {
      if (/^\d[\d,.]*$/.test(dataLines[i])) {
        numberLines.push(parseAmount(dataLines[i]));
      }
    }
    // First pair = Box 3, Box 5; Second pair = Box 4, Box 6
    if (numberLines.length >= 2) {
      data.ssWages = numberLines[0];
      data.medicareWages = numberLines[1];
    }
  }

  // Find SS tax and Medicare tax — after "Social security tax withheld" / "Medicare tax withheld"
  const ssTaxIdx = dataLines.findIndex(l => l.includes("Social security tax withheld"));
  const medTaxIdx = dataLines.findIndex(l => l.includes("Medicare tax withheld"));

  if (ssTaxIdx >= 0 || medTaxIdx >= 0) {
    const afterTaxLabels = Math.max(ssTaxIdx, medTaxIdx) + 1;
    const taxNumbers = [];
    for (let i = afterTaxLabels; i < Math.min(afterTaxLabels + 5, dataLines.length); i++) {
      if (/^\d[\d,.]*$/.test(dataLines[i])) {
        taxNumbers.push(parseAmount(dataLines[i]));
      }
    }
    if (taxNumbers.length >= 2) {
      data.ssTaxWithheld = taxNumbers[0];
      data.medicareTaxWithheld = taxNumbers[1];
    } else if (taxNumbers.length === 1) {
      // Only one — could be either
      if (ssTaxIdx >= 0 && medTaxIdx < 0) data.ssTaxWithheld = taxNumbers[0];
      else if (medTaxIdx >= 0 && ssTaxIdx < 0) data.medicareTaxWithheld = taxNumbers[0];
      else data.ssTaxWithheld = taxNumbers[0];
    }
  }

  // Find employer name — after "Employer's name" label
  const empIdx = dataLines.findIndex(l => l.includes("Employer") && l.includes("name"));
  if (empIdx >= 0) {
    for (let i = empIdx + 1; i < Math.min(empIdx + 3, dataLines.length); i++) {
      if (dataLines[i].length > 3 && !/^\d/.test(dataLines[i]) && !dataLines[i].includes("Employee")) {
        data.employer = dataLines[i];
        break;
      }
    }
  }

  // Find Box 12 entries — pattern: "DD4400.16" or "W1600.08"
  const code12Pattern = /^([A-Z]{1,2})([\d,.]+)$/;
  const seenCodes = new Set();
  for (const line of dataLines) {
    const m = line.match(code12Pattern);
    if (m && !seenCodes.has(m[1])) {
      seenCodes.add(m[1]);
      data.code12.push({ code: m[1], amount: parseAmount(m[2]) });
    }
  }

  // Sanity checks
  if (data.wages === 0 && data.federalWithheld === 0) {
    warnings.push("Could not extract wages or withholding — verify Box 1 and Box 2 manually");
  }
  if (data.ssWages === 0 && data.medicareWages === 0) {
    warnings.push("Social security and Medicare wages are $0 — this may be correct (TRS employees) or extraction failed");
  }
  if (!data.employer) {
    warnings.push("Could not extract employer name");
  }
  if (data.wages > 0 && data.federalWithheld === 0) {
    warnings.push("Federal withholding is $0 — verify Box 2");
  }

  return { data, warnings };
}
