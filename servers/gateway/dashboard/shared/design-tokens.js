/**
 * Crow Design Tokens — Single source of truth for CSS custom properties.
 * Used by both the Crow's Nest dashboard (layout.js) and public blog (blog-public.js).
 */

/** CSS custom property definitions for all themes */
export function designTokensCss() {
  return `
  :root {
    --crow-bg-deep: #eef1f3;
    --crow-bg-surface: #ffffff;
    --crow-bg-elevated: #f5f7f8;
    --crow-border: #dde4e8;
    --crow-border-strong: #94a4ae;
    --crow-text-primary: #22303a;
    --crow-text-secondary: #5c6d79;
    --crow-text-tertiary: #6b7c88;
    --crow-text-muted: #8395a1;
    --crow-accent: #0e6b62;
    --crow-accent-hover: #0b574f;
    --crow-accent-muted: #dcecea;
    --crow-accent-contrast: #ffffff;
    --crow-success: #1d7048;
    --crow-error: #b04a2b;
    --crow-warning: #8f5606;
    --crow-info: #33688c;
    --crow-brand-gold: #8f5606;
  }

  @media (prefers-color-scheme: dark) {
    :root {
      --crow-bg-deep: #131a1f;
      --crow-bg-surface: #1b242b;
      --crow-bg-elevated: #232e36;
      --crow-border: #2a353d;
      --crow-border-strong: #46565f;
      --crow-text-primary: #e4ebef;
      --crow-text-secondary: #8fa0ab;
      --crow-text-tertiary: #7d8f9a;
      --crow-text-muted: #5f707b;
      --crow-accent: #4fbdb0;
      --crow-accent-hover: #6fd0c4;
      --crow-accent-muted: #16322f;
      --crow-accent-contrast: #131a1f;
      --crow-success: #2fa36b;
      --crow-error: #d1633e;
      --crow-warning: #d9a521;
      --crow-info: #6aa9cc;
      --crow-brand-gold: #d9a521;
    }
  }

  /* Base radius tokens. --crow-radius-pill stays 8px in this task — Task 7
     re-values it to 999px after the pill-consumer triage. */
  :root {
    --crow-radius-card: 14px;
    --crow-radius-control: 10px;
    --crow-radius-pill: 8px;
  }

  /* Sizing scales (theme-independent) */
  :root {
    --crow-space-1: 4px;  --crow-space-2: 8px;  --crow-space-3: 12px;
    --crow-space-4: 16px; --crow-space-5: 24px; --crow-space-6: 32px;
    --crow-space-8: 48px; --crow-space-10: 64px;

    --crow-text-xs: 0.75rem;  --crow-text-sm: 0.8125rem; --crow-text-base: 0.875rem;
    --crow-text-md: 1rem;     --crow-text-lg: 1.125rem;  --crow-text-xl: 1.25rem;
    --crow-text-2xl: 1.5rem;  --crow-text-3xl: 2rem;

    --crow-leading-tight: 1.2; --crow-leading-normal: 1.5; --crow-leading-relaxed: 1.7;

    --crow-body-font: 'Inter', system-ui, sans-serif;
    --crow-mono-font: 'JetBrains Mono', monospace;

    /* Compatibility aliases — legacy names used across panels. Prefer the
       canonical token (right side) in NEW code. These reference the canonical
       custom properties, so they track theme overrides automatically. */
    --crow-bg: var(--crow-bg-deep);
    --crow-background: var(--crow-bg-deep);
    --crow-surface: var(--crow-bg-surface);
    --crow-bg-card: var(--crow-bg-surface);
    --crow-text: var(--crow-text-primary);
    --crow-border-subtle: var(--crow-border);
    --crow-accent-bg: var(--crow-accent-muted);
  }`;
}

// Decision 15 (Track 2): Crow is the authority for the Perch palette. The vendored
// perch-hub payload must match these values exactly — tests/perch-token-drift.test.js
// fails CI on any drift, in either direction. Changing a value here REQUIRES the
// pi-lab edit + scripts/vendor-perch.mjs re-pin dance to land in the same PR.
export const PERCH_TOKENS = {
  light: { sky: "#eef1f3", card: "#fff", ink: "#22303a", dim: "#6b7c88",
           teal: "#0e6b62", tealSoft: "#dcecea", wire: "#94a4ae",
           alive: "#2fa36b", attn: "#d1633e", line: "#dde4e8" },
  dark:  { sky: "#131a1f", card: "#1b242b", ink: "#e4ebef", dim: "#8fa0ab",
           teal: "#4fbdb0", tealSoft: "#16322f", wire: "#46565f", line: "#2a353d" },
};
