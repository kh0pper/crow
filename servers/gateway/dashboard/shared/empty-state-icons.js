/**
 * Inline SVG icons for empty states — no external URLs required.
 * All icons are 48x48 and safe for offline/air-gapped environments.
 */

/** Two nodes connected by a line — P2P / sharing concept. Indigo #6366f1 */
export const ICON_SHARING = `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48" fill="none" aria-hidden="true">
  <circle cx="10" cy="24" r="7" fill="#6366f1" opacity="0.2" stroke="#6366f1" stroke-width="2"/>
  <circle cx="38" cy="24" r="7" fill="#6366f1" opacity="0.2" stroke="#6366f1" stroke-width="2"/>
  <line x1="17" y1="24" x2="31" y2="24" stroke="#6366f1" stroke-width="2" stroke-dasharray="3 2"/>
  <circle cx="10" cy="24" r="3" fill="#6366f1"/>
  <circle cx="38" cy="24" r="3" fill="#6366f1"/>
</svg>`;

/** Brain / sparkle shape — memory concept. Indigo #6366f1 with gold #fbbf24 sparkle */
export const ICON_MEMORY = `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48" fill="none" aria-hidden="true">
  <ellipse cx="22" cy="26" rx="13" ry="11" fill="#6366f1" opacity="0.15" stroke="#6366f1" stroke-width="2"/>
  <path d="M16 26 C16 20 20 16 24 16 C28 16 32 20 32 26" stroke="#6366f1" stroke-width="2" fill="none" stroke-linecap="round"/>
  <path d="M20 26 C20 22 22 20 24 20 C26 20 28 22 28 26" stroke="#6366f1" stroke-width="1.5" fill="none" stroke-linecap="round"/>
  <line x1="24" y1="16" x2="24" y2="13" stroke="#6366f1" stroke-width="1.5" stroke-linecap="round"/>
  <polygon points="35,10 36.2,13.8 40,13.8 37,16.2 38.2,20 35,17.8 31.8,20 33,16.2 30,13.8 33.8,13.8" fill="#fbbf24"/>
</svg>`;

/** Upward arrow — deploy / publish concept. Green #10b981 */
export const ICON_DEPLOY = `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48" fill="none" aria-hidden="true">
  <circle cx="24" cy="24" r="18" fill="#10b981" opacity="0.1" stroke="#10b981" stroke-width="2"/>
  <path d="M24 34 L24 16" stroke="#10b981" stroke-width="2.5" stroke-linecap="round"/>
  <path d="M16 23 L24 15 L32 23" stroke="#10b981" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
  <line x1="18" y1="34" x2="30" y2="34" stroke="#10b981" stroke-width="2" stroke-linecap="round"/>
</svg>`;

/** 2x2 grid / puzzle concept — integrations / add-ons. Cyan #06b6d4 */
export const ICON_INTEGRATIONS = `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48" fill="none" aria-hidden="true">
  <rect x="10" y="10" width="12" height="12" rx="3" fill="#06b6d4" opacity="0.25" stroke="#06b6d4" stroke-width="1.5"/>
  <rect x="26" y="10" width="12" height="12" rx="3" fill="#06b6d4" opacity="0.5" stroke="#06b6d4" stroke-width="1.5"/>
  <rect x="10" y="26" width="12" height="12" rx="3" fill="#06b6d4" opacity="0.5" stroke="#06b6d4" stroke-width="1.5"/>
  <rect x="26" y="26" width="12" height="12" rx="3" fill="#06b6d4" opacity="0.25" stroke="#06b6d4" stroke-width="1.5"/>
  <line x1="22" y1="16" x2="26" y2="16" stroke="#06b6d4" stroke-width="1.5"/>
  <line x1="16" y1="22" x2="16" y2="26" stroke="#06b6d4" stroke-width="1.5"/>
  <line x1="32" y1="22" x2="32" y2="26" stroke="#06b6d4" stroke-width="1.5"/>
  <line x1="22" y1="32" x2="26" y2="32" stroke="#06b6d4" stroke-width="1.5"/>
</svg>`;
