/**
 * FFFF Fill Return — Main Orchestrator
 *
 * Coordinates the full FFFF filing flow:
 *   1. Pre-flight checks
 *   2. Login (user handles CAPTCHA/2FA)
 *   3. Add required forms
 *   4. Fill forms bottom-up
 *   5. Do the Math with snapshot/diff/refill
 *   6. W-2 entry (Step 2)
 *   7. Review pause
 *
 * This script is designed to be called step-by-step by the AI,
 * NOT run as a single automated flow. Each function is independent.
 */

import { loadFieldMap, buildFillMap } from "./field-resolver.js";
import { setupDialogHandler, handleOverlayPopups } from "./popup-handler.js";
import { snapshotFields, doTheMathWithRefill, compareTotals } from "./post-math-refill.js";
import { getFormFrame, withFormFrame, startHeartbeat } from "./frame-manager.js";

// FFFF URLs
const FFFF_BASE = "https://www.freefilefillableforms.com";

// Forms in fill order (bottom-up dependency order)
const FORM_FILL_ORDER = [
  "f8889",       // HSA
  "schedule1",   // Additional income & adjustments
  "f8863",       // Education credits (page 2 then page 1)
  "f1040",       // Main form (LAST)
];

/**
 * Pre-flight: verify all prerequisites are met.
 *
 * @param {object} ctx - { crowTaxReturn, browserConnected }
 * @returns {{ ready: boolean, issues: string[] }}
 */
export function preflight(ctx) {
  const issues = [];

  if (!ctx.crowTaxReturn) {
    issues.push("No crow-tax return loaded. Run crow_tax_calculate first.");
  } else if (!ctx.crowTaxReturn.result) {
    issues.push("Return not yet calculated. Run crow_tax_calculate.");
  }

  if (!ctx.browserConnected) {
    issues.push("crow-browser not connected. Run crow_browser_launch.");
  }

  return { ready: issues.length === 0, issues };
}

/**
 * Set up the browser page for FFFF interaction.
 * Call this after login is complete.
 *
 * @param {import('playwright').Page} page
 * @returns {{ heartbeatTimer: NodeJS.Timeout }}
 */
export function setupPage(page) {
  // Handle confirmation dialogs automatically
  setupDialogHandler(page, { autoAccept: false });

  // Start heartbeat to prevent session timeout
  const heartbeatTimer = startHeartbeat(page, 300000); // 5 min

  return { heartbeatTimer };
}

/**
 * Fill a single form in FFFF.
 *
 * @param {import('playwright').Page} page
 * @param {string} formId - e.g. "f8889", "schedule1", "f1040"
 * @param {object} formLines - Line values from crow_tax_get_form
 * @param {number} taxYear
 * @returns {Promise<{ filled: number, unmapped: string[], errors: string[] }>}
 */
export async function fillForm(page, formId, formLines, taxYear) {
  const errors = [];

  // Load field map for this form
  let fieldMap;
  try {
    fieldMap = loadFieldMap(formId, taxYear);
  } catch (err) {
    return { filled: 0, unmapped: Object.keys(formLines), errors: [err.message] };
  }

  // Build selector → value map
  const { fields, unmapped } = buildFillMap(formLines, fieldMap);

  if (unmapped.length > 0) {
    errors.push(`Unmapped lines (no field map entry): ${unmapped.join(", ")}`);
  }

  // Fill within the form frame
  let filled = 0;
  await withFormFrame(page, async (frame) => {
    // Handle any overlay popups first
    await handleOverlayPopups(page);

    for (const [selector, value] of Object.entries(fields)) {
      try {
        const el = await frame.$(selector);
        if (!el) {
          errors.push(`Element not found: ${selector}`);
          continue;
        }

        await el.scrollIntoViewIfNeeded();
        await el.click();
        await new Promise((r) => setTimeout(r, 100 + Math.random() * 200));
        await el.fill("");
        await new Promise((r) => setTimeout(r, 50 + Math.random() * 100));

        // Type character by character for stealth
        for (const char of value) {
          await el.type(char, { delay: 40 + Math.random() * 40 });
        }

        // Tab to next field (triggers FFFF validation)
        await frame.keyboard.press("Tab");
        await new Promise((r) => setTimeout(r, 200 + Math.random() * 300));

        filled++;
      } catch (err) {
        errors.push(`Error filling ${selector}: ${err.message}`);
      }
    }
  });

  return { filled, unmapped, errors };
}

/**
 * Execute Do the Math for the current form.
 *
 * @param {import('playwright').Page} page
 * @param {object} crowTaxResult - Expected values from crow-tax
 * @returns {Promise<{ success: boolean, diff: object, warnings: string[], refilled: string[] }>}
 */
export async function executeDoTheMath(page, crowTaxResult) {
  const formFrame = await getFormFrame(page);

  // Common selectors for the Do the Math button
  const doMathSelectors = [
    'button:has-text("Do the Math")',
    'input[value="Do the Math"]',
    '[aria-label="Do the Math"]',
    '#doTheMath',
  ];

  let doMathSelector = null;
  for (const sel of doMathSelectors) {
    const el = await page.$(sel) || await formFrame.$(sel);
    if (el) {
      doMathSelector = sel;
      break;
    }
  }

  if (!doMathSelector) {
    return { success: false, diff: {}, warnings: ["Do the Math button not found"], refilled: [] };
  }

  const result = await doTheMathWithRefill(page, formFrame, doMathSelector, crowTaxResult);

  return {
    success: true,
    ...result,
  };
}

/**
 * Get the recommended fill order for a set of required forms.
 *
 * @param {string[]} requiredForms - Form IDs from crow-tax
 * @returns {string[]} Ordered form IDs (supporting forms first, 1040 last)
 */
export function getFillOrder(requiredForms) {
  // Filter to only forms we know about, maintain dependency order
  const ordered = FORM_FILL_ORDER.filter((f) => requiredForms.includes(f));

  // Add any unknown forms before f1040
  for (const f of requiredForms) {
    if (!ordered.includes(f) && f !== "f1040") {
      ordered.splice(ordered.length - 1, 0, f); // Insert before last (f1040)
    }
  }

  // Ensure f1040 is always last
  if (!ordered.includes("f1040") && requiredForms.includes("f1040")) {
    ordered.push("f1040");
  }

  return ordered;
}
