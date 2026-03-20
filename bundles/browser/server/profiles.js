/**
 * Browser profiles — User-Agent rotation, fingerprint configurations.
 *
 * Consolidated from canvas-companion stealth.py and crow-tax stealth.js.
 */

const USER_AGENTS = [
  // Chrome on Windows
  {
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    platform: "Win32",
    brands: [
      { brand: "Google Chrome", version: "131" },
      { brand: "Chromium", version: "131" },
      { brand: "Not_A Brand", version: "24" },
    ],
  },
  // Chrome on macOS
  {
    ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    platform: "MacIntel",
    brands: [
      { brand: "Google Chrome", version: "131" },
      { brand: "Chromium", version: "131" },
      { brand: "Not_A Brand", version: "24" },
    ],
  },
  // Chrome on Linux
  {
    ua: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    platform: "Linux x86_64",
    brands: [
      { brand: "Google Chrome", version: "131" },
      { brand: "Chromium", version: "131" },
      { brand: "Not_A Brand", version: "24" },
    ],
  },
];

/**
 * Pick a random profile from the pool.
 * @returns {{ ua: string, platform: string, brands: Array }}
 */
export function getRandomProfile() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

/**
 * Get all available profiles (for testing/display).
 */
export function getAllProfiles() {
  return USER_AGENTS;
}

/**
 * Default fingerprint values shared across all profiles.
 */
export const DEFAULT_FINGERPRINT = {
  deviceMemory: 8,
  hardwareConcurrency: 8,
  languages: ["en-US", "en"],
  colorDepth: 24,
  pixelDepth: 24,
  screen: { width: 1920, height: 1080 },
  availScreen: { width: 1920, height: 1040 },
  maxTouchPoints: 0,
};
