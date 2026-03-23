/**
 * WCAG 2.1 Level AA Accessibility Helpers
 *
 * Utility functions for building accessible HTML in the knowledge base
 * public pages. All public-facing KB pages must meet WCAG 2.1 AA.
 */

/**
 * Render a skip navigation link (hidden until focused).
 */
export function renderSkipLink(targetId = "main-content") {
  return `<a href="#${targetId}" class="skip-link">Skip to main content</a>`;
}

/**
 * Render the skip-link CSS.
 */
export function skipLinkCss() {
  return `
  .skip-link {
    position: absolute;
    top: -100%;
    left: 1rem;
    z-index: 10000;
    padding: 0.75rem 1.5rem;
    background: var(--crow-accent);
    color: #fff;
    font-weight: 700;
    border-radius: 0 0 8px 8px;
    text-decoration: none;
    font-size: 0.9rem;
    transition: top 0.15s;
  }
  .skip-link:focus {
    top: 0;
    outline: 3px solid var(--crow-brand-gold);
    outline-offset: 2px;
  }`;
}

/**
 * Accessible focus styles CSS — visible focus indicators that meet
 * WCAG 2.4.7 (Focus Visible) with 3:1 contrast ratio.
 */
export function focusCss() {
  return `
  /* Focus indicators — 2px outline, high contrast */
  :focus-visible {
    outline: 2px solid var(--crow-accent);
    outline-offset: 2px;
  }
  a:focus-visible, button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible {
    outline: 2px solid var(--crow-accent);
    outline-offset: 2px;
    border-radius: 2px;
  }
  /* Remove default outline for non-keyboard focus */
  :focus:not(:focus-visible) {
    outline: none;
  }`;
}

/**
 * Process rendered HTML to improve table accessibility.
 * Adds scope attributes to table headers and wraps tables
 * in thead/tbody if not already present.
 */
export function ensureTableHeaders(html) {
  // Add scope="col" to <th> in <thead> rows
  html = html.replace(/<thead>\s*<tr>([\s\S]*?)<\/tr>\s*<\/thead>/g, (match, cells) => {
    const updated = cells.replace(/<th(?![^>]*scope)/g, '<th scope="col"');
    return `<thead><tr>${updated}</tr></thead>`;
  });

  // For simple tables without thead: if first row has <th>, wrap in <thead>
  html = html.replace(/<table>([\s\S]*?)<\/table>/g, (match, inner) => {
    if (inner.includes("<thead>")) return match;
    // First row all <th>? Wrap it
    const firstRowMatch = inner.match(/^\s*<tr>([\s\S]*?)<\/tr>/);
    if (firstRowMatch && firstRowMatch[1].includes("<th") && !firstRowMatch[1].includes("<td")) {
      const firstRow = firstRowMatch[0].replace(/<th(?![^>]*scope)/g, '<th scope="col"');
      const rest = inner.slice(firstRowMatch[0].length);
      return `<table><thead>${firstRow}</thead><tbody>${rest}</tbody></table>`;
    }
    return match;
  });

  return html;
}

/**
 * Wrap phone numbers in tel: links for mobile accessibility.
 * Matches common US phone formats: (512) 555-1234, 512-555-1234, 512.555.1234
 */
export function linkPhoneNumbers(html) {
  // Match phone numbers not already inside href attributes or <a> tags
  return html.replace(
    /(?<!["'=\w])(\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4})(?![^<]*<\/a>)/g,
    (match, phone) => {
      const digits = phone.replace(/\D/g, "");
      if (digits.length !== 10) return match;
      return `<a href="tel:+1${digits}">${phone}</a>`;
    }
  );
}

/**
 * Generate a language toggle link with proper hreflang and aria-label.
 */
export function languageToggle(currentLang, targetLang, targetUrl, langNames) {
  const names = langNames || { en: "English", es: "Espa\u00f1ol" };
  const targetName = names[targetLang] || targetLang.toUpperCase();
  const label = currentLang === "en"
    ? `Cambiar a ${targetName}`
    : `Switch to ${targetName}`;

  return `<a href="${targetUrl}" hreflang="${targetLang}" aria-label="${label}" class="lang-toggle">${targetName}</a>`;
}
