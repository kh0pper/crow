/**
 * FFFF Popup Handler
 *
 * Handles confirmation dialogs that FFFF shows during form operations.
 * These popups appear in the OUTER frame even when the form is in an inner iframe,
 * and they can cause the session to hang or log out if not handled.
 */

/**
 * Set up dialog auto-handling on the page.
 * FFFF uses native confirm() and alert() dialogs.
 *
 * @param {import('playwright').Page} page - Playwright Page
 * @param {object} [options]
 * @param {boolean} [options.autoAccept=false] - Auto-accept all dialogs
 * @param {Function} [options.onDialog] - Custom handler (receives dialog object)
 */
export function setupDialogHandler(page, options = {}) {
  page.on("dialog", async (dialog) => {
    const message = dialog.message();
    const type = dialog.type();

    console.log(`[popup-handler] ${type}: ${message}`);

    if (options.onDialog) {
      await options.onDialog(dialog);
      return;
    }

    if (options.autoAccept) {
      await dialog.accept();
      return;
    }

    // Default: accept confirmations about adding/removing forms
    // These are safe operations that the user already requested
    const safePatterns = [
      /add.*form/i,
      /remove.*form/i,
      /are you sure/i,
      /do you want to/i,
    ];

    if (safePatterns.some((p) => p.test(message))) {
      console.log(`[popup-handler] Auto-accepting safe dialog: "${message}"`);
      await dialog.accept();
    } else {
      // Unknown dialog — dismiss to be safe, log for debugging
      console.log(`[popup-handler] Dismissing unknown dialog: "${message}"`);
      await dialog.dismiss();
    }
  });
}

/**
 * Check for and handle any modal overlay elements in the page.
 * Some FFFF popups are DOM overlays, not native dialogs.
 *
 * @param {import('playwright').Page} page - Playwright Page
 * @returns {Promise<boolean>} True if a popup was found and handled
 */
export async function handleOverlayPopups(page) {
  // Check for common overlay patterns
  const overlay = await page.evaluate(() => {
    // Look for modal overlays
    const modals = document.querySelectorAll(
      ".modal, .overlay, .popup, [role='dialog'], [role='alertdialog']"
    );

    for (const modal of modals) {
      const style = window.getComputedStyle(modal);
      if (style.display !== "none" && style.visibility !== "hidden") {
        // Find the primary action button
        const buttons = modal.querySelectorAll("button, input[type='button'], input[type='submit']");
        for (const btn of buttons) {
          const text = btn.textContent?.toLowerCase() || btn.value?.toLowerCase() || "";
          if (text.includes("ok") || text.includes("yes") || text.includes("continue")) {
            btn.click();
            return { found: true, action: "clicked", text };
          }
        }
        return { found: true, action: "no_button_found" };
      }
    }
    return { found: false };
  });

  if (overlay.found) {
    console.log(`[popup-handler] Overlay popup handled: ${JSON.stringify(overlay)}`);
  }

  return overlay.found;
}
