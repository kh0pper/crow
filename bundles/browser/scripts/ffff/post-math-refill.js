/**
 * Post-Math Refill Strategy
 *
 * FFFF's "Do the Math" button recalculates the form and can CLEAR user-entered fields.
 * This module implements the snapshot → click → diff → refill strategy.
 *
 * Algorithm:
 * 1. Before clicking: snapshot ALL field name→value pairs
 * 2. After clicking: re-read all fields, diff against snapshot
 * 3. Classify each changed field:
 *    - Auto-calculated (readonly): accept FFFF's value, compare vs crow-tax
 *    - User-entered but cleared: refill from snapshot
 *    - User-entered and changed: FFFF reformatted (commas) — accept
 * 4. If FFFF totals disagree with crow-tax by >$5: STOP and alert
 */

/**
 * Take a snapshot of all field values in a frame.
 *
 * @param {import('playwright').Frame|import('playwright').Page} frame
 * @returns {Promise<Record<string, { value: string, readonly: boolean, ariaLabel: string|null }>>}
 */
export async function snapshotFields(frame) {
  return frame.evaluate(() => {
    const snapshot = {};
    const inputs = document.querySelectorAll("input, select, textarea");

    for (const el of inputs) {
      const key = el.getAttribute("aria-label") || el.name || el.id;
      if (!key) continue;

      snapshot[key] = {
        value: el.value || "",
        readonly: el.readOnly || el.disabled || false,
        ariaLabel: el.getAttribute("aria-label"),
      };
    }

    return snapshot;
  });
}

/**
 * Diff two snapshots to find changed fields.
 *
 * @param {Record<string, object>} before - Snapshot before Do the Math
 * @param {Record<string, object>} after - Snapshot after Do the Math
 * @returns {{ cleared: string[], calculated: string[], reformatted: string[], unchanged: string[] }}
 */
export function diffSnapshots(before, after) {
  const cleared = [];
  const calculated = [];
  const reformatted = [];
  const unchanged = [];

  for (const [key, beforeEntry] of Object.entries(before)) {
    const afterEntry = after[key];
    if (!afterEntry) continue;

    const bVal = beforeEntry.value;
    const aVal = afterEntry.value;

    if (bVal === aVal) {
      unchanged.push(key);
      continue;
    }

    // Field was cleared (had value, now empty)
    if (bVal && !aVal) {
      cleared.push(key);
      continue;
    }

    // Readonly field changed — FFFF calculated it
    if (afterEntry.readonly) {
      calculated.push(key);
      continue;
    }

    // Value changed but not cleared — likely reformatted (commas, decimals)
    const bNum = parseFloat(bVal.replace(/[,$]/g, ""));
    const aNum = parseFloat(aVal.replace(/[,$]/g, ""));
    if (!isNaN(bNum) && !isNaN(aNum) && Math.abs(bNum - aNum) < 0.01) {
      reformatted.push(key);
    } else {
      // Value actually changed — treat as cleared (safer to refill)
      cleared.push(key);
    }
  }

  return { cleared, calculated, reformatted, unchanged };
}

/**
 * Execute the full Do the Math workflow.
 *
 * @param {import('playwright').Page} page - Playwright Page
 * @param {import('playwright').Frame} formFrame - The iframe containing the form
 * @param {string} doTheMathSelector - CSS selector for the Do the Math button
 * @param {object} crowTaxResult - Expected result from crow-tax for comparison
 * @returns {Promise<{ diff: object, warnings: string[], refilled: string[] }>}
 */
export async function doTheMathWithRefill(page, formFrame, doTheMathSelector, crowTaxResult) {
  const warnings = [];
  const refilled = [];

  // Step 1: Snapshot before
  const before = await snapshotFields(formFrame);

  // Step 2: Click Do the Math (button is usually in the outer frame)
  const doMathBtn = await page.$(doTheMathSelector) || await formFrame.$(doTheMathSelector);
  if (!doMathBtn) {
    throw new Error(`Do the Math button not found: ${doTheMathSelector}`);
  }
  await doMathBtn.click();

  // Wait for recalculation
  await new Promise((r) => setTimeout(r, 3000));

  // Step 3: Snapshot after
  const after = await snapshotFields(formFrame);

  // Step 4: Diff
  const diff = diffSnapshots(before, after);

  // Step 5: Refill cleared user-entered fields
  for (const key of diff.cleared) {
    const entry = before[key];
    if (entry.readonly) continue; // Don't refill calculated fields

    try {
      const selector = entry.ariaLabel
        ? `[aria-label="${entry.ariaLabel}"]`
        : `[name="${key}"], [id="${key}"]`;

      const el = await formFrame.$(selector);
      if (el) {
        await el.fill(entry.value);
        refilled.push(key);
      } else {
        warnings.push(`Could not refill ${key} — element not found`);
      }
    } catch (err) {
      warnings.push(`Error refilling ${key}: ${err.message}`);
    }
  }

  // Step 6: Compare calculated fields against crow-tax
  if (crowTaxResult) {
    for (const key of diff.calculated) {
      const fffVal = parseFloat((after[key]?.value || "0").replace(/[,$]/g, ""));
      // Check if crow-tax has a matching line
      // The comparison logic depends on how lines are mapped
      // For now, just warn about calculated changes
      warnings.push(`Calculated field changed: ${key} = ${after[key]?.value} (was ${before[key]?.value})`);
    }
  }

  return { diff, warnings, refilled };
}

/**
 * Compare FFFF totals against crow-tax expected values.
 * Returns true if they match within tolerance.
 *
 * @param {number} fffTotal - FFFF's calculated total
 * @param {number} crowTaxTotal - crow-tax's expected total
 * @param {number} [tolerance=5] - Maximum acceptable difference in dollars
 * @returns {{ matches: boolean, difference: number }}
 */
export function compareTotals(fffTotal, crowTaxTotal, tolerance = 5) {
  const difference = Math.abs(fffTotal - crowTaxTotal);
  return {
    matches: difference <= tolerance,
    difference,
  };
}
