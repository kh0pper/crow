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
    employeeName: "",
    employeeSsn: "",
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

  if (method === "positional" && typeof source === "string") {
    // Positional extraction — pipe-separated values grouped by row
    // Layout: values and labels are on separate rows, duplicated across copies
    const lines = source.split("\n").map(l => l.trim()).filter(l => l.length > 0);

    // Helper: get first unique numeric value from a pipe-separated line
    const getFirstNum = (line) => {
      const parts = line.split("|").map(p => p.trim());
      for (const p of parts) {
        const n = parseFloat(p.replace(/[$,]/g, ""));
        if (!isNaN(n) && /^[\d$,.]+$/.test(p.trim())) return n;
      }
      return null;
    };

    // Helper: get first/second unique numeric values from a line (for Box pairs)
    const getNumPair = (line) => {
      const parts = line.split("|").map(p => p.trim());
      const nums = [];
      const seen = new Set();
      for (const p of parts) {
        const n = parseFloat(p.replace(/[$,]/g, ""));
        if (!isNaN(n) && /^\s*[\d$,.]+\s*$/.test(p)) {
          const key = n.toFixed(2);
          if (!seen.has(key)) { seen.add(key); nums.push(n); }
          if (nums.length >= 2) break;
        }
      }
      return nums;
    };

    // Helper: get first text value from pipe-separated line
    const getFirstText = (line) => {
      const parts = line.split("|").map(p => p.trim());
      const seen = new Set();
      for (const p of parts) {
        if (p.length > 2 && !/^\d+$/.test(p) && !seen.has(p)) {
          seen.add(p);
          return p;
        }
      }
      return "";
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const nextLine = lines[i + 1] || "";

      // Wages + Federal withheld — numbers on a line before "Wages, tips" label
      if (nextLine.includes("Wages, tips") && nextLine.includes("Federal income tax")) {
        const nums = getNumPair(line);
        if (nums.length >= 2) {
          data.wages = nums[0];
          data.federalWithheld = nums[1];
        } else if (nums.length === 1) {
          data.wages = nums[0];
        }
        continue;
      }

      // Medicare wages + tax — numbers before "Medicare wages" label
      if (nextLine.includes("Medicare wages") && nextLine.includes("Medicare tax")) {
        const nums = getNumPair(line);
        if (nums.length >= 2) {
          data.medicareWages = nums[0];
          data.medicareTaxWithheld = nums[1];
        }
        // Check if SS wages are on a different row (they might be blank for TRS)
        continue;
      }

      // SS wages + tax — numbers before "Social security wages" label
      // Note: for TRS employees, these may be blank (no SS) — only match actual dollar amounts, not box numbers
      if (nextLine.includes("Social security wages") && nextLine.includes("Social security tax")) {
        const nums = getNumPair(line);
        // Filter out small integers that are likely box numbers (1-20), not dollar amounts
        const validNums = nums.filter(n => n > 100 || n === 0);
        if (validNums.length >= 2) {
          data.ssWages = validNums[0];
          data.ssTaxWithheld = validNums[1];
        }
        // If no valid numbers, SS is blank (TRS employee) — leave as 0
        continue;
      }

      // Employer name — line after "Employer's name"
      if (line.includes("Employer's name") && !data.employer) {
        // Next line has the employer, deduplicated from pipe-separated copies
        const emp = getFirstText(lines[i + 1] || "");
        if (emp && !emp.includes("Employee") && emp.length > 3) data.employer = emp;
        continue;
      }

      // Also try: employer name line that contains a recognizable business name
      // (fallback for layouts where label and name are on the same line)
      if (!data.employer && line.includes("Employer") && line.includes("name") && i + 1 < lines.length) {
        const nextParts = (lines[i + 1] || "").split("|").map(p => p.trim());
        for (const p of nextParts) {
          if (p.length > 5 && /[A-Z]/.test(p) && !/^\d/.test(p) && !p.includes("Employee")) {
            data.employer = p;
            break;
          }
        }
      }

      // EIN — line after "Employer ID number"
      if (line.includes("Employer ID number") || line.includes("EIN")) {
        const einLine = lines[i + 1] || "";
        const einMatch = einLine.match(/(\d{2}-\d{7})/);
        if (einMatch) data.ein = einMatch[1];
        continue;
      }

      // Employee SSN — line with XXX-XX-XXXX pattern near "social security"
      if (!data.employeeSsn && (line.includes("social security no") || line.includes("Employee's social"))) {
        for (let j = i - 1; j <= Math.min(i + 2, lines.length - 1); j++) {
          const m = lines[j].match(/(\d{3}-\d{2}-\d{4})/);
          if (m) { data.employeeSsn = m[1]; break; }
        }
      }

      // Employee name — look near "Employee's name" label (before OR after)
      if (!data.employeeName && line.includes("Employee") && line.includes("name") && !line.includes("Employer")) {
        const labelWords = new Set(["EMPLOYEE", "EMPLOYER", "STATE", "LOCAL", "COPY", "WAGE", "FORM", "TAX", "FILED", "FEDERAL", "INTERNAL", "REVENUE", "DEPARTMENT", "TREASURY", "STATEMENT", "ZIP"]);
        for (let j = Math.max(0, i - 5); j <= Math.min(i + 3, lines.length - 1); j++) {
          if (j === i) continue;
          const parts = lines[j].split("|").map(p => p.trim());
          for (const p of parts) {
            // Name: 2-5 all-caps words, not a known label
            const words = p.split(/\s+/);
            if (words.length >= 2 && words.length <= 5 && p.length > 5 &&
                words.every(w => /^[A-Z]/.test(w)) &&
                !words.some(w => labelWords.has(w.toUpperCase())) &&
                !/\d/.test(p) && !p.includes("'") && !p.includes(".")) {
              data.employeeName = p;
              break;
            }
          }
          if (data.employeeName) break;
        }
      }

      // Box 12 — look for code + amount patterns like "DD | 1112.00" or "DD4400.16"
      if (line.includes("12a") || line.includes("12b") || line.includes("12c") || line.includes("12d")) {
        const parts = line.split("|").map(p => p.trim());
        const seenCodes = new Set(data.code12.map(c => c.code));
        for (let j = 0; j < parts.length; j++) {
          // Pattern 1: separate code and amount: "DD" | "1112.00"
          if (/^[A-Z]{1,2}$/.test(parts[j]) && j + 1 < parts.length) {
            const amt = parseFloat(parts[j + 1].replace(/[$,]/g, ""));
            if (!isNaN(amt) && amt > 0 && !seenCodes.has(parts[j])) {
              seenCodes.add(parts[j]);
              data.code12.push({ code: parts[j], amount: amt });
            }
          }
          // Pattern 2: concatenated: "DD4400.16"
          const concat = parts[j].match(/^([A-Z]{1,2})([\d,.]+)$/);
          if (concat && !seenCodes.has(concat[1])) {
            seenCodes.add(concat[1]);
            data.code12.push({ code: concat[1], amount: parseAmount(concat[2]) });
          }
        }
      }
    }

    // Sanity checks
    if (data.wages === 0 && data.federalWithheld === 0) {
      warnings.push("Could not extract wages or withholding — verify Box 1 and Box 2 manually");
    }
    if (data.ssWages === 0 && data.medicareWages === 0) {
      warnings.push("Social security and Medicare wages are $0 — may be correct (TRS) or extraction failed");
    }
    if (!data.employer) warnings.push("Could not extract employer name");

    return { data, warnings };
  }

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
  if (ssnLine) data.employeeSsn = ssnLine;

  // Find employee name — after "Employee's name"
  const empNameIdx = dataLines.findIndex(l => l.includes("Employee") && l.includes("name") && !l.includes("Employer"));
  if (empNameIdx >= 0) {
    for (let i = empNameIdx + 1; i < Math.min(empNameIdx + 3, dataLines.length); i++) {
      if (dataLines[i].length > 3 && /^[A-Z]/.test(dataLines[i]) && !/^\d/.test(dataLines[i]) && !dataLines[i].includes("address")) {
        data.employeeName = dataLines[i];
        break;
      }
    }
  }

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
