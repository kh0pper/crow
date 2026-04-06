/**
 * Form Registry — Maps form IDs to their mapper functions.
 *
 * Also provides form metadata and unsupported form detection.
 */

import { mapForm1040, requiredForms } from "./f1040.js";
import { mapSchedule1 } from "./schedule1.js";
import { mapScheduleC } from "./scheduleC.js";
import { mapScheduleD } from "./scheduleD.js";
import { mapScheduleSE } from "./scheduleSE.js";
import { mapForm8889 } from "./f8889.js";
import { mapForm8812 } from "./f8812.js";
import { mapForm8863 } from "./f8863.js";

export const FORM_REGISTRY = {
  f1040: {
    name: "Form 1040",
    title: "U.S. Individual Income Tax Return",
    mapper: mapForm1040,
    pdfTemplate: "f1040.pdf",
  },
  schedule1: {
    name: "Schedule 1",
    title: "Additional Income and Adjustments to Income",
    mapper: mapSchedule1,
    pdfTemplate: "f1040s1.pdf",
  },
  scheduleC: {
    name: "Schedule C",
    title: "Profit or Loss From Business",
    mapper: mapScheduleC,
    pdfTemplate: "f1040sc.pdf",
  },
  scheduleD: {
    name: "Schedule D",
    title: "Capital Gains and Losses",
    mapper: mapScheduleD,
    pdfTemplate: "f1040sd.pdf",
  },
  scheduleSE: {
    name: "Schedule SE",
    title: "Self-Employment Tax",
    mapper: mapScheduleSE,
    pdfTemplate: "f1040sse.pdf",
  },
  f8889: {
    name: "Form 8889",
    title: "Health Savings Accounts (HSAs)",
    mapper: mapForm8889,
    pdfTemplate: "f8889.pdf",
  },
  f8812: {
    name: "Schedule 8812",
    title: "Credits for Qualifying Children and Other Dependents",
    mapper: mapForm8812,
    pdfTemplate: "f1040s8.pdf",
  },
  f8863: {
    name: "Form 8863",
    title: "Education Credits (AOTC / Lifetime Learning)",
    mapper: mapForm8863,
    pdfTemplate: "f8863.pdf",
  },
};

/**
 * Get line values for a specific form.
 */
export function getFormLines(formId, result, taxReturn) {
  const form = FORM_REGISTRY[formId];
  if (!form) {
    return { error: `Unknown form: ${formId}. Supported: ${Object.keys(FORM_REGISTRY).join(", ")}` };
  }
  if (form.unsupported) {
    return { error: `${form.name} (${form.title}) is not yet supported. Consider consulting a tax professional.` };
  }
  return form.mapper(result, taxReturn);
}

/**
 * Get all forms needed for this return with their line values.
 */
export function getAllFormLines(result, taxReturn) {
  const needed = requiredForms(result, taxReturn);
  const forms = {};
  for (const formId of needed) {
    const form = FORM_REGISTRY[formId];
    if (form && !form.unsupported) {
      forms[formId] = {
        name: form.name,
        title: form.title,
        lines: form.mapper(result, taxReturn),
      };
    }
  }
  return forms;
}

/**
 * Detect situations that require forms we don't support.
 */
export function detectUnsupportedSituations(taxReturn, tables) {
  const warnings = [];

  // State taxes
  const hasStateWages = taxReturn.w2s.some(w => w.stateWages > 0);
  if (hasStateWages) {
    warnings.push("State income tax returns are not supported. You may need to file separately with your state.");
  }

  // AMT
  // Simplified check — high income + large deductions may trigger AMT
  const totalIncome = taxReturn.w2s.reduce((s, w) => s + w.wages, 0);
  const saltThreshold = tables?.saltCap?.default ?? 10000;
  if (totalIncome > 300000 && taxReturn.deductions.saltTaxes > saltThreshold) {
    warnings.push("High income with large SALT deductions may require AMT calculation (Form 6251). Not supported — consult a tax professional.");
  }

  // Foreign income
  // No specific schema for this — just a general warning
  if (taxReturn.specialSituations.nonresidentSpouseElection) {
    warnings.push("Section 6013(h) election detected. Ensure spouse's worldwide income is reported. This requires attaching a statement to the return.");
  }

  return warnings;
}

export { requiredForms };
