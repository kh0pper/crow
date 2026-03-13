/**
 * Crow Hero SVG — Inline stylized crow silhouette for login/setup pages.
 * Kept under 2KB. Renders as a simple bird profile in indigo (#6366f1).
 * Swap this out later for the final detailed illustration.
 */

export const CROW_HERO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" fill="none">
  <circle cx="100" cy="100" r="96" fill="#1a1a2e" stroke="#3d3d4d" stroke-width="1.5"/>
  <g transform="translate(40, 30)">
    <!-- Body -->
    <path d="M60 140 C20 140, 5 110, 10 80 C15 55, 35 35, 60 30 C75 27, 90 30, 100 40 C110 50, 115 65, 110 85 C108 95, 100 120, 95 130 C90 138, 75 142, 60 140Z" fill="#6366f1"/>
    <!-- Wing detail -->
    <path d="M55 70 C65 55, 85 50, 100 55 C105 57, 108 62, 105 70 C100 80, 80 90, 65 95 C50 98, 45 85, 55 70Z" fill="#818cf8" opacity="0.5"/>
    <!-- Head -->
    <circle cx="80" cy="42" r="22" fill="#6366f1"/>
    <!-- Eye -->
    <circle cx="88" cy="38" r="4" fill="#fbbf24"/>
    <circle cx="89" cy="37" r="1.5" fill="#0f0f17"/>
    <!-- Beak -->
    <path d="M100 42 L120 38 L100 46Z" fill="#fbbf24"/>
    <!-- Tail feathers -->
    <path d="M15 120 C5 130, -5 140, -10 155 C0 150, 10 140, 20 130Z" fill="#6366f1"/>
    <path d="M20 125 C12 138, 5 150, 0 165 C10 157, 18 145, 25 132Z" fill="#818cf8" opacity="0.6"/>
    <!-- Feet -->
    <path d="M55 140 L50 155 L42 150 M50 155 L50 162 M50 155 L58 152" stroke="#6366f1" stroke-width="2.5" stroke-linecap="round" fill="none"/>
    <path d="M75 138 L72 153 L64 148 M72 153 L72 160 M72 153 L80 150" stroke="#6366f1" stroke-width="2.5" stroke-linecap="round" fill="none"/>
  </g>
</svg>`;
