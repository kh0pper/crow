/**
 * 1098-E PDF Field Extraction
 *
 * Extracts student loan interest from 1098-E forms.
 * Simple form — just Box 1 (student loan interest received by lender).
 */

function parseAmount(str) {
  if (!str) return 0;
  return parseFloat(String(str).replace(/[$,]/g, "")) || 0;
}

const TEXT_PATTERNS = {
  interest: /(?:box\s*1|student\s*loan\s*interest\s*received)[:\s]*\$?([\d,]+\.?\d*)/i,
  lender: /(?:recipient|lender|filer)['']?s?\s*(?:name|\/)[:\s]*([A-Za-z][A-Za-z0-9 &.,'-]+)/i,
};

/**
 * Extract 1098-E data.
 */
export async function extract1098E(source, method) {
  const data = {
    lender: "",
    interest: 0,
  };
  const warnings = [];
  const text = typeof source === "string" ? source : JSON.stringify(source);

  if (method === "positional") {
    // Positional: look for dollar amount near "Student loan interest"
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Find the interest amount — look for dollar pattern near "Student loan interest"
      if (line.includes("Student loan interest") || line.includes("student loan interest")) {
        // Check same line and nearby lines for dollar amount
        const amtMatch = line.match(/\$\s*([\d,]+\.?\d*)/);
        if (amtMatch) {
          data.interest = parseAmount(amtMatch[1]);
        } else {
          // Check previous/next lines
          for (let j = Math.max(0, i - 2); j <= Math.min(lines.length - 1, i + 2); j++) {
            const m = lines[j].match(/\$\s*([\d,]+\.?\d*)/);
            if (m && parseAmount(m[1]) > 0) {
              data.interest = parseAmount(m[1]);
              break;
            }
          }
        }
      }

      // Find lender name — look for recognizable organization names, skip OMB/form numbers
      if (!data.lender) {
        const parts = line.split("|").map(p => p.trim());
        for (const p of parts) {
          if (p.length > 10 && /[A-Z]/.test(p) &&
              !p.includes("OMB") && !p.includes("1545") && !p.includes("Form") &&
              !p.includes("name") && !p.includes("TIN") && !p.includes("CORRECTED") &&
              (p.includes("DEPARTMENT") || p.includes("BANK") || p.includes("CORP") ||
               p.includes("EDUCATION") || p.includes("Nelnet") || p.includes("Navient") ||
               p.includes("Sallie") || p.includes("FedLoan") || p.includes("MOHELA"))) {
            data.lender = p;
          }
        }
      }
    }
  }

  // Fallback: regex on full text
  if (data.interest === 0) {
    const m = text.match(TEXT_PATTERNS.interest);
    if (m) data.interest = parseAmount(m[1]);
  }
  if (!data.lender) {
    const m = text.match(TEXT_PATTERNS.lender);
    if (m) data.lender = m[1].trim();
  }

  // Also try: find any dollar amount that looks like student loan interest (typically $50-$2500)
  if (data.interest === 0) {
    const allAmounts = text.match(/\$\s*([\d,]+\.?\d*)/g);
    if (allAmounts) {
      for (const a of allAmounts) {
        const val = parseAmount(a.replace("$", ""));
        if (val > 10 && val <= 2500) {
          data.interest = val;
          break;
        }
      }
    }
  }

  if (data.interest === 0) warnings.push("Could not extract student loan interest — verify Box 1");
  if (!data.lender) warnings.push("Could not extract lender name");

  return { data, warnings };
}
