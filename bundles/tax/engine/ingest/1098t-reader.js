/**
 * 1098-T PDF Field Extraction
 *
 * Extracts education-related data from 1098-T forms.
 * Handles both plain text and positional extraction.
 */

function parseAmount(str) {
  if (!str) return 0;
  return parseFloat(String(str).replace(/[$,]/g, "")) || 0;
}

/**
 * Extract 1098-T data.
 */
export async function extract1098T(source, method) {
  const data = {
    studentName: "",
    institution: "",
    tuitionPaid: 0,
    scholarships: 0,
    isGraduate: false,
    isHalfTime: true,
    yearsClaimedAotc: 0,
    felonyDrugConviction: false,
  };
  const warnings = [];
  const text = typeof source === "string" ? source : JSON.stringify(source);

  if (method === "positional") {
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Institution — line after "FILER'S name" or standalone university name
      if (!data.institution && (line.includes("FILER") || line.includes("filer"))) {
        // Look at next few lines for institution name
        for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
          const parts = lines[j].split("|").map(p => p.trim());
          for (const p of parts) {
            if (p.length > 5 && /University|College|School|Institute/i.test(p)) {
              data.institution = p;
              break;
            }
          }
          if (data.institution) break;
        }
      }

      // Tuition — dollar amount near "tuition" or "Payments received"
      if (line.includes("tuition") || line.includes("Payments received")) {
        // Look for dollar amounts in nearby lines
        for (let j = Math.max(0, i - 2); j <= Math.min(i + 3, lines.length - 1); j++) {
          const parts = lines[j].split("|").map(p => p.trim());
          for (const p of parts) {
            const amt = parseAmount(p);
            if (amt > 100 && data.tuitionPaid === 0) {
              data.tuitionPaid = amt;
            }
          }
        }
      }

      // Scholarships — dollar amount near "Scholarships or grants" (Box 5)
      // Look AFTER the label (not before — avoids picking up EINs)
      // Amount will have decimal point or $ sign
      if (line.includes("Scholarships or grants") || (line.includes("5") && line.includes("Scholarships"))) {
        for (let j = i; j <= Math.min(i + 5, lines.length - 1); j++) {
          const parts = lines[j].split("|").map(p => p.trim());
          for (const p of parts) {
            // Must look like a dollar amount (has decimal or $ sign), not an EIN or box number
            if ((/\.\d{2}$/.test(p) || /^\$/.test(p)) && data.scholarships === 0) {
              const amt = parseAmount(p);
              if (amt > 0 && amt < 1000000) {
                data.scholarships = amt;
              }
            }
          }
        }
      }

      // Student name — look for name near "STUDENT'S name"
      if (line.includes("STUDENT") && line.includes("name") && !data.studentName) {
        for (let j = i; j <= Math.min(i + 3, lines.length - 1); j++) {
          const parts = lines[j].split("|").map(p => p.trim());
          // Look for name-like parts (capitalized words, not labels)
          const nameParts = parts.filter(p =>
            p.length >= 2 && p.length <= 30 && /^[A-Z][a-z]+$/.test(p)
          );
          if (nameParts.length >= 2) {
            data.studentName = nameParts.join(" ");
            break;
          }
        }
      }

      // Half-time student (Box 8)
      if (line.includes("half") && line.includes("time") && line.includes("8")) {
        data.isHalfTime = true;
      }

      // Graduate student (Box 9) — only set if we see an actual checkmark indicator
      // The label text says "Checked if a graduate student" which is just the label, not an indicator
      // Look for actual mark indicators like "X", "✓", "Yes" separate from the label
      if (line.includes("9") && line.includes("graduate")) {
        const parts = line.split("|").map(p => p.trim());
        for (const p of parts) {
          if (/^[X✓✔]$/i.test(p) || p === "Yes" || p === "Y") {
            data.isGraduate = true;
            break;
          }
        }
      }
    }
  }

  // Fallback: regex on full text
  if (data.tuitionPaid === 0) {
    const m = text.match(/(?:box\s*1|payments?\s*received|qualified\s*tuition)[:\s]*\$?([\d,]+\.?\d*)/i);
    if (m) data.tuitionPaid = parseAmount(m[1]);
  }
  if (data.scholarships === 0) {
    const m = text.match(/(?:box\s*5|scholarships?\s*(?:or\s*)?grants?)[:\s]*\$?([\d,]+\.?\d*)/i);
    if (m) data.scholarships = parseAmount(m[1]);
  }
  if (!data.institution) {
    const m = text.match(/(?:University|College|School|Institute)\s+(?:of\s+)?[A-Za-z\s]+/i);
    if (m) data.institution = m[0].trim();
  }
  if (!data.studentName) {
    const m = text.match(/(?:student)['']?s?\s*name[:\s|]+([A-Za-z][A-Za-z\s.,'-]+)/i);
    if (m) data.studentName = m[1].trim();
  }

  // Warnings
  warnings.push("REQUIRED — ask user: How many prior years was AOTC claimed? (yearsClaimedAotc)");
  if (!data.institution) warnings.push("Could not extract institution name");
  if (!data.studentName) warnings.push("Could not extract student name");
  if (data.tuitionPaid === 0) warnings.push("Tuition paid (Box 1) is $0 — verify this is correct");

  return { data, warnings };
}
