/**
 * Confidence Scoring
 *
 * Scores how confident we are in each extracted field.
 * Below 90% → AI must prompt the user to verify.
 */

// Method confidence multipliers
const METHOD_CONFIDENCE = {
  "form-fields": 0.95,  // Fillable PDF fields are highly reliable
  "positional": 0.90,   // Positional text preserves layout — good for W-2s
  "text": 0.80,         // Plain text extraction depends on PDF layout
  "ocr": 0.60,          // OCR is least reliable
};

// Field importance weights (higher = more important to get right)
const FIELD_IMPORTANCE = {
  // W-2
  wages: 1.0,
  federalWithheld: 1.0,
  ssWages: 0.9,
  ssTaxWithheld: 0.9,
  medicareWages: 0.9,
  medicareTaxWithheld: 0.9,
  stateWages: 0.7,
  stateWithheld: 0.7,
  employer: 0.8,
  ein: 0.6,
  code12: 0.85,

  // 1099
  interest: 1.0,
  grossDistribution: 1.0,
  ordinaryDividends: 1.0,
  qualifiedDividends: 0.9,
  nonemployeeCompensation: 1.0,
  distributionCode: 0.95,
  payer: 0.8,

  // 1098-T
  tuitionPaid: 1.0,
  scholarships: 0.9,
  institution: 0.8,
  studentName: 0.8,
  isGraduate: 0.7,
  isHalfTime: 0.7,
};

/**
 * Score confidence for each field in the extracted data.
 *
 * @param {object} data - Extracted field values
 * @param {string} method - Extraction method used
 * @param {string} documentType - Document type
 * @returns {object} Map of field → confidence score (0-1)
 */
export function scoreConfidence(data, method, documentType) {
  const baseConfidence = METHOD_CONFIDENCE[method] || 0.5;
  const scores = {};

  for (const [field, value] of Object.entries(data)) {
    if (field === "isStatutoryEmployee" || field === "felonyDrugConviction") continue;

    let score = baseConfidence;

    // Adjust based on whether we got a value
    if (value === 0 || value === "" || value === null || value === undefined) {
      // Missing/zero value reduces confidence (might have failed to extract)
      score *= 0.5;
    }

    // Adjust for field importance
    const importance = FIELD_IMPORTANCE[field] || 0.7;
    // More important fields need higher confidence to pass threshold
    // Less important fields get a small boost
    score = score * (1 + (1 - importance) * 0.2);

    // Cap at 1.0
    scores[field] = Math.min(1.0, score);
  }

  return scores;
}
