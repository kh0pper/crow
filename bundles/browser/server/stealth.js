/**
 * Stealth browser module — consolidated from crow-tax and canvas-companion.
 *
 * Masks automation signals, spoofs fingerprints, simulates human behavior.
 * All values are configurable; defaults target a generic Chrome desktop profile.
 */

import { getRandomProfile, DEFAULT_FINGERPRINT } from "./profiles.js";

/**
 * Build the JavaScript init script injected before page load.
 * Masks webdriver flag, spoofs navigator/screen/chrome objects.
 *
 * @param {object} opts
 * @param {string} [opts.platform]        - navigator.platform override
 * @param {number} [opts.timezoneOffset]   - getTimezoneOffset() return value (minutes, e.g. 360 = CST)
 * @param {string[]} [opts.languages]      - navigator.languages
 * @param {number} [opts.deviceMemory]     - navigator.deviceMemory
 * @param {object} [opts.screen]           - { width, height }
 * @param {object} [opts.availScreen]      - { width, height }
 * @returns {string} JavaScript source to inject via Page.addScriptToEvaluateOnNewDocument
 */
export function buildStealthScript(opts = {}) {
  const profile = getRandomProfile();
  const fp = { ...DEFAULT_FINGERPRINT, ...opts };
  const platform = opts.platform || profile.platform;

  return `
// === Crow Browser Stealth Init ===

// Mask navigator.webdriver (primary detection signal)
Object.defineProperty(navigator, 'webdriver', { get: () => undefined });

// Spoof navigator properties
Object.defineProperty(navigator, 'deviceMemory', { get: () => ${fp.deviceMemory} });
Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => ${fp.hardwareConcurrency || 8} });
Object.defineProperty(navigator, 'platform', { get: () => ${JSON.stringify(platform)} });
Object.defineProperty(navigator, 'maxTouchPoints', { get: () => ${fp.maxTouchPoints || 0} });

// Spoof plugins array (automation has empty array)
Object.defineProperty(navigator, 'plugins', {
  get: () => {
    const plugins = [
      {name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer'},
      {name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai'},
      {name: 'Native Client', filename: 'internal-nacl-plugin'}
    ];
    plugins.item = (i) => plugins[i];
    plugins.namedItem = (name) => plugins.find(p => p.name === name);
    plugins.refresh = () => {};
    return plugins;
  }
});

// Spoof languages
Object.defineProperty(navigator, 'languages', { get: () => ${JSON.stringify(fp.languages || DEFAULT_FINGERPRINT.languages)} });

// Fix screen dimensions
Object.defineProperty(screen, 'width', { get: () => ${fp.screen?.width || 1920} });
Object.defineProperty(screen, 'height', { get: () => ${fp.screen?.height || 1080} });
Object.defineProperty(screen, 'availWidth', { get: () => ${fp.availScreen?.width || 1920} });
Object.defineProperty(screen, 'availHeight', { get: () => ${fp.availScreen?.height || 1040} });
Object.defineProperty(screen, 'colorDepth', { get: () => ${fp.colorDepth} });
Object.defineProperty(screen, 'pixelDepth', { get: () => ${fp.pixelDepth} });

// Fix outer window dimensions
Object.defineProperty(window, 'outerWidth', { get: () => ${fp.screen?.width || 1920} });
Object.defineProperty(window, 'outerHeight', { get: () => ${fp.screen?.height || 1080} });

// Mock window.chrome object (present in real Chrome)
window.chrome = {
  runtime: { connect: () => {}, sendMessage: () => {} },
  loadTimes: () => ({}),
  csi: () => ({})
};

// Fix permissions.query for notifications
const origQuery = navigator.permissions.query.bind(navigator.permissions);
navigator.permissions.query = (p) => p.name === 'notifications'
  ? Promise.resolve({state: Notification.permission}) : origQuery(p);

${typeof opts.timezoneOffset === "number" ? `// Override timezone\nDate.prototype.getTimezoneOffset = function() { return ${opts.timezoneOffset}; };` : "// Timezone: using system default"}

// === End Crow Browser Stealth Init ===
`;
}

/**
 * Get Playwright-compatible browser context options with stealth settings.
 *
 * @param {object} opts
 * @param {string} [opts.timezoneId]  - IANA timezone (e.g. "America/Chicago")
 * @param {string} [opts.locale]      - Browser locale (e.g. "en-US")
 * @param {string} [opts.colorScheme] - "light" | "dark"
 * @returns {object} Playwright context options
 */
export function getContextOptions(opts = {}) {
  const profile = getRandomProfile();
  return {
    viewport: { width: 1920, height: 1080 },
    locale: opts.locale || "en-US",
    timezoneId: opts.timezoneId || "America/Chicago",
    userAgent: profile.ua,
    colorScheme: opts.colorScheme || "light",
  };
}

// --- Human behavior simulation ---

/**
 * Random delay between min and max milliseconds.
 */
export function delay(min = 300, max = 800) {
  const ms = Math.floor(Math.random() * (max - min)) + min;
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Type text with human-like per-character delays via CDP.
 *
 * @param {import('playwright').CDPSession} cdp
 * @param {string} text
 * @param {number} [baseDelay=60] - ms per character (randomized ±50%)
 */
export async function humanType(cdp, text, baseDelay = 60) {
  for (const char of text) {
    await cdp.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      text: char,
      key: char,
      code: `Key${char.toUpperCase()}`,
      unmodifiedText: char,
    });
    await cdp.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: char,
      code: `Key${char.toUpperCase()}`,
    });
    await delay(baseDelay * 0.5, baseDelay * 1.5);
  }
}

/**
 * Click at a randomized position within an element's bounding box.
 *
 * @param {import('playwright').CDPSession} cdp
 * @param {{ x: number, y: number, width: number, height: number }} box - Element bounding box
 */
export async function humanClick(cdp, box) {
  const x = box.x + box.width * (0.2 + Math.random() * 0.6);
  const y = box.y + box.height * (0.2 + Math.random() * 0.6);
  await delay(100, 300);
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "left",
    clickCount: 1,
  });
  await delay(50, 120);
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button: "left",
    clickCount: 1,
  });
  await delay(200, 500);
}

/**
 * Random mouse movements to simulate a real user.
 *
 * @param {import('playwright').CDPSession} cdp
 * @param {number} [movements=3]
 */
export async function randomMouseMovement(cdp, movements = 3) {
  for (let i = 0; i < movements; i++) {
    const x = 100 + Math.floor(Math.random() * 1700);
    const y = 100 + Math.floor(Math.random() * 800);
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x,
      y,
    });
    await delay(50, 150);
  }
}
