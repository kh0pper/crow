/**
 * FFFF Frame Manager
 *
 * Handles iframe detection, navigation, and recovery when frames detach.
 * FFFF renders tax forms inside iframes that can detach after navigation
 * between forms or after "Do the Math".
 */

/**
 * Find the form iframe in the FFFF page.
 * FFFF typically has one main iframe for the form content.
 *
 * @param {import('playwright').Page} page
 * @param {object} [options]
 * @param {number} [options.maxRetries=3]
 * @param {number} [options.retryDelay=2000]
 * @returns {Promise<import('playwright').Frame>}
 */
export async function getFormFrame(page, options = {}) {
  const maxRetries = options.maxRetries || 3;
  const retryDelay = options.retryDelay || 2000;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // Look for the form iframe
      const frames = page.frames();
      const formFrame = frames.find((f) => {
        const url = f.url();
        // FFFF form frames typically have specific URL patterns
        return url.includes("form") || url.includes("fillable") || (frames.length > 1 && f !== page.mainFrame());
      });

      if (formFrame) {
        // Verify the frame is still attached
        try {
          await formFrame.evaluate(() => true);
          return formFrame;
        } catch {
          // Frame detached, retry
        }
      }

      // Try finding by iframe element
      const iframeEl = await page.$("iframe");
      if (iframeEl) {
        const frame = await iframeEl.contentFrame();
        if (frame) {
          await frame.evaluate(() => true); // Verify attached
          return frame;
        }
      }

      if (attempt < maxRetries) {
        console.log(`[frame-manager] Frame not found (attempt ${attempt}/${maxRetries}), retrying...`);
        await new Promise((r) => setTimeout(r, retryDelay * attempt)); // Exponential backoff
      }
    } catch (err) {
      if (attempt < maxRetries) {
        console.log(`[frame-manager] Error finding frame: ${err.message}, retrying...`);
        await new Promise((r) => setTimeout(r, retryDelay * attempt));
      } else {
        throw new Error(`Frame not found after ${maxRetries} attempts: ${err.message}`);
      }
    }
  }

  throw new Error("Could not find form iframe. Is a form selected in FFFF?");
}

/**
 * Execute a function in the form frame with automatic retry on frame detachment.
 *
 * @param {import('playwright').Page} page
 * @param {Function} fn - Async function that receives the frame as argument
 * @param {object} [options]
 * @param {number} [options.maxRetries=2]
 * @returns {Promise<any>}
 */
export async function withFormFrame(page, fn, options = {}) {
  const maxRetries = options.maxRetries || 2;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      const frame = await getFormFrame(page);
      return await fn(frame);
    } catch (err) {
      const isDetached = err.message.includes("detached") ||
                          err.message.includes("disposed") ||
                          err.message.includes("Target closed") ||
                          err.message.includes("Execution context");

      if (isDetached && attempt <= maxRetries) {
        console.log(`[frame-manager] Frame detached, reacquiring (attempt ${attempt})...`);
        await new Promise((r) => setTimeout(r, 1000 * attempt));
        continue;
      }
      throw err;
    }
  }
}

/**
 * Send a heartbeat to keep the FFFF session alive.
 * Run this periodically (~every 5 minutes) to prevent session timeout.
 *
 * @param {import('playwright').Page} page
 */
export async function heartbeat(page) {
  try {
    // Execute a no-op in the main frame to keep the session alive
    await page.evaluate(() => {
      // Touch a benign element or just read something
      return document.title;
    });
  } catch (err) {
    console.log(`[frame-manager] Heartbeat failed: ${err.message}`);
  }
}

/**
 * Start periodic heartbeat.
 *
 * @param {import('playwright').Page} page
 * @param {number} [intervalMs=300000] - Interval in ms (default: 5 min)
 * @returns {NodeJS.Timeout} Timer ID (pass to clearInterval to stop)
 */
export function startHeartbeat(page, intervalMs = 300000) {
  return setInterval(() => heartbeat(page), intervalMs);
}
