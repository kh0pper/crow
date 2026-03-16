/**
 * Nest Panel — Client-Side JavaScript
 *
 * Handles pin/unpin interactions. Minimal JS — most rendering is server-side.
 */

import { tJs } from "../../shared/i18n.js";

export function nestClientJS(lang) {
  return `<script>
  // Confirm before unpinning
  document.querySelectorAll('.nest-unpin-btn').forEach(function(form) {
    form.addEventListener('submit', function(e) {
      // No confirmation needed — the x button is clear enough
    });
  });
  </script>`;
}
