/**
 * 1098-T PDF Field Extraction
 *
 * Extracts education-related data from 1098-T forms.
 */

const TEXT_PATTERNS = {
  tuitionPaid: /(?:box\s*1|payments?\s*received|qualified\s*tuition)[:\s]*\$?([\d,]+\.?\d*)/i,
  scholarships: /(?:box\s*5|scholarships?\s*(?:or\s*)?grants?)[:\s]*\$?([\d,]+\.?\d*)/i,
  institution: /(?:filer|institution|school)['']?s?\s*name[:\s]+([A-Za-z][A-Za-z0-9 &.,'-]+)/i,
  studentName: /(?:student)['']?s?\s*name[:\s]+([A-Za-z][A-Za-z0-9 .,'-]+)/i,
  isGraduate: /(?:box\s*9|graduate\s*student)[:\s]*(yes|x|true|\u2713)/i,
  isHalfTime: /(?:box\s*8|(?:at\s*least\s*)?half[- ]?time)[:\s]*(yes|x|true|\u2713)/i,
};

function parseAmount(str) {
  if (!str) return 0;
  return parseFloat(String(str).replace(/[$,]/g, "")) || 0;
}

/**
 * Extract 1098-T data.
 *
 * @param {object|string} source - Form fields object or text content
 * @param {string} method - "form-fields", "text", or "ocr"
 * @returns {{ data: object, warnings: string[] }}
 */
export async function extract1098T(source, method) {
  const data = {
    studentName: "",
    institution: "",
    tuitionPaid: 0,
    scholarships: 0,
    isGraduate: false,
    isHalfTime: true,
    yearsClaimedAotc: 0, // Must be asked from user
    felonyDrugConviction: false,
  };
  const warnings = [];

  if (method === "form-fields" && typeof source === "object") {
    for (const [fieldName, value] of Object.entries(source)) {
      const norm = fieldName.toLowerCase().trim();
      if (norm.includes("box 1") || norm.includes("payment") || norm.includes("tuition")) {
        data.tuitionPaid = parseAmount(value);
      } else if (norm.includes("box 5") || norm.includes("scholarship")) {
        data.scholarships = parseAmount(value);
      } else if (norm.includes("institution") || norm.includes("filer") || norm.includes("school")) {
        data.institution = String(value).trim();
      } else if (norm.includes("student") && norm.includes("name")) {
        data.studentName = String(value).trim();
      } else if (norm.includes("box 9") || norm.includes("graduate")) {
        data.isGraduate = !!value;
      } else if (norm.includes("box 8") || norm.includes("half")) {
        data.isHalfTime = !!value;
      }
    }
  } else {
    const text = typeof source === "string" ? source : JSON.stringify(source);
    for (const [field, pattern] of Object.entries(TEXT_PATTERNS)) {
      const match = text.match(pattern);
      if (match) {
        if (field === "tuitionPaid" || field === "scholarships") {
          data[field] = parseAmount(match[1]);
        } else if (field === "isGraduate" || field === "isHalfTime") {
          data[field] = true;
        } else {
          data[field] = match[1].trim();
        }
      }
    }
  }

  // Fields that MUST be asked from the user (cannot be extracted from 1098-T)
  warnings.push("REQUIRED — ask user: How many prior years was AOTC claimed for this student? (yearsClaimedAotc)");
  if (!data.institution) warnings.push("Could not extract institution name");
  if (!data.studentName) warnings.push("Could not extract student name");
  if (data.tuitionPaid === 0) warnings.push("Tuition paid (Box 1) is $0 — verify this is correct");

  return { data, warnings };
}
