/**
 * Crow Design Tokens — Single source of truth for CSS custom properties.
 * Used by both the Crow's Nest dashboard (layout.js) and public blog (blog-public.js).
 */

/** Google Fonts import URL */
export const FONT_IMPORT = `@import url('https://fonts.googleapis.com/css2?family=DM+Sans:ital,wght@0,400;0,500;0,700;1,400&family=Fraunces:ital,opsz,wght@0,9..144,400;0,9..144,600;0,9..144,700;1,9..144,400&family=JetBrains+Mono:wght@400;500&display=swap');`;

/** CSS custom property definitions for all themes */
export function designTokensCss() {
  return `
  :root {
    --crow-bg-deep: #0f0f17;
    --crow-bg-surface: #1a1a2e;
    --crow-bg-elevated: #2d2d3d;
    --crow-border: #3d3d4d;
    --crow-text-primary: #fafaf9;
    --crow-text-secondary: #a8a29e;
    --crow-text-muted: #78716c;
    --crow-accent: #6366f1;
    --crow-accent-hover: #818cf8;
    --crow-accent-muted: #2d2854;
    --crow-brand-gold: #fbbf24;
    --crow-success: #22c55e;
    --crow-error: #ef4444;
    --crow-info: #38bdf8;
  }

  .theme-light {
    --crow-bg-deep: #fafaf9;
    --crow-bg-surface: #ffffff;
    --crow-bg-elevated: #f5f5f4;
    --crow-border: #e7e5e4;
    --crow-text-primary: #1c1917;
    --crow-text-secondary: #57534e;
    --crow-text-muted: #a8a29e;
    --crow-accent: #4f46e5;
    --crow-accent-hover: #6366f1;
    --crow-accent-muted: #e0e7ff;
  }

  .theme-serif {
    --crow-body-font: 'Fraunces', serif;
  }

  /* Base radius tokens */
  :root {
    --crow-radius-card: 12px;
    --crow-radius-pill: 8px;
  }

  /* Glass aesthetic — iOS-inspired blur/transparency */
  .theme-glass {
    --crow-bg-deep: #000000;
    --crow-bg-surface: rgba(255,255,255,0.03);
    --crow-bg-elevated: rgba(255,255,255,0.06);
    --crow-border: rgba(255,255,255,0.06);
    --crow-text-primary: #f5f5f7;
    --crow-text-secondary: rgba(255,255,255,0.55);
    --crow-text-muted: rgba(255,255,255,0.35);
    --crow-accent: #2997ff;
    --crow-accent-hover: #64b5f6;
    --crow-accent-muted: rgba(41,151,255,0.1);
    --crow-success: #30d158;
    --crow-error: #ff453a;
    --crow-info: #64d2ff;
    --crow-glass-blur: blur(12px);
    --crow-glass-blur-heavy: saturate(180%) blur(20px);
    --crow-radius-card: 16px;
    --crow-radius-pill: 100px;
    --crow-bg-popup: rgba(30,30,30,0.85);
    --crow-border-popup: rgba(255,255,255,0.12);
  }

  .theme-glass.theme-light {
    --crow-bg-deep: #f5f5f7;
    --crow-bg-surface: rgba(0,0,0,0.03);
    --crow-bg-elevated: rgba(0,0,0,0.06);
    --crow-border: rgba(0,0,0,0.08);
    --crow-text-primary: #1c1917;
    --crow-text-secondary: rgba(0,0,0,0.55);
    --crow-text-muted: rgba(0,0,0,0.35);
    --crow-accent: #0071e3;
    --crow-accent-hover: #0077ed;
    --crow-accent-muted: rgba(0,113,227,0.1);
    --crow-bg-popup: rgba(245,245,247,0.85);
    --crow-border-popup: rgba(0,0,0,0.12);
  }`;
}
