// Inline SVG logos for official Crow add-ons
// All SVGs use currentColor so they adapt to theme
// viewBox: 0 0 24 24, stroke-width: 2, no fill

export const ADDON_LOGOS = {
  ollama: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="100%" height="100%"><path d="M12 3C9 3 6.5 5 6.5 8c0 1.2.4 2.3 1 3.1L6 14h12l-1.5-2.9c.6-.8 1-1.9 1-3.1C17.5 5 15 3 12 3z"/><path d="M9 11.5c0 .8.4 1.5 1 1.5"/><path d="M15 11.5c0 .8-.4 1.5-1 1.5"/><ellipse cx="9.5" cy="9.5" rx="1" ry="1.2"/><ellipse cx="14.5" cy="9.5" rx="1" ry="1.2"/><path d="M9 14c0 2 1.3 3.5 3 3.5s3-1.5 3-3.5"/><path d="M8 20c0-1 .9-2 2-2h4c1.1 0 2 1 2 2"/></svg>`,

  nextcloud: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="100%" height="100%"><path d="M17.5 9.5A5 5 0 0 0 8.1 8H8a4 4 0 0 0 0 8h9.5a3.5 3.5 0 0 0 0-7z"/><circle cx="8.5" cy="16" r=".5" fill="currentColor"/><circle cx="12" cy="16" r=".5" fill="currentColor"/><circle cx="15.5" cy="16" r=".5" fill="currentColor"/></svg>`,

  minio: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="100%" height="100%"><ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v4c0 1.66 3.58 3 8 3s8-1.34 8-3V6"/><path d="M4 10v4c0 1.66 3.58 3 8 3s8-1.34 8-3v-4"/><path d="M4 14v4c0 1.66 3.58 3 8 3s8-1.34 8-3v-4"/></svg>`,

  immich: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="100%" height="100%"><rect x="3" y="6" width="18" height="14" rx="2"/><path d="M3 10h18"/><circle cx="8.5" cy="4" r="1.5"/><circle cx="15.5" cy="4" r="1.5"/><circle cx="12" cy="15" r="3"/><circle cx="12" cy="15" r="1" fill="currentColor"/></svg>`,

  obsidian: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="100%" height="100%"><polygon points="12 2 19 8 19 16 12 22 5 16 5 8"/><polygon points="12 6 16 9.5 16 14.5 12 18 8 14.5 8 9.5"/></svg>`,

  'home-assistant': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="100%" height="100%"><path d="M3 12L12 4l9 8"/><path d="M5 10v9a1 1 0 0 0 1 1h4v-5h4v5h4a1 1 0 0 0 1-1v-9"/></svg>`,

  podcast: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="100%" height="100%"><rect x="9" y="2" width="6" height="11" rx="3"/><path d="M5 10a7 7 0 0 0 14 0"/><line x1="12" y1="17" x2="12" y2="21"/><line x1="9" y1="21" x2="15" y2="21"/></svg>`,
};

/**
 * Returns an SVG logo wrapped in a sized div for the given add-on ID.
 * @param {string} id - Add-on ID (e.g. "ollama", "home-assistant")
 * @param {number} size - Size in pixels for width/height
 * @returns {string|null} HTML string or null if ID is unknown
 */
export function getAddonLogo(id, size) {
  const svg = ADDON_LOGOS[id];
  if (!svg) return null;
  return `<div style="width:${size}px;height:${size}px;color:var(--crow-accent);display:flex;align-items:center;justify-content:center">${svg}</div>`;
}
