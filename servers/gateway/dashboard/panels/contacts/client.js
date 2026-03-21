/**
 * Contacts Panel — Client-Side JavaScript
 *
 * Handles tab switching, client-side search filtering, file reading for import.
 * Security: all untrusted text escaped before DOM insertion.
 */

export function contactsClientJs() {
  return `<script>
  // === Client-side search filter (instant, no server roundtrip) ===
  function filterContactsClient(query) {
    var grid = document.getElementById('contactsGrid');
    if (!grid) return;
    var cards = grid.querySelectorAll('.contact-card');
    var q = (query || '').toLowerCase();
    cards.forEach(function(card) {
      var name = card.getAttribute('data-name') || '';
      if (!q || name.indexOf(q) >= 0) {
        card.style.display = '';
      } else {
        card.style.display = 'none';
      }
    });
  }

  // === Read imported file into textarea ===
  function readImportFile(input) {
    if (!input.files || !input.files[0]) return;
    var reader = new FileReader();
    reader.onload = function(e) {
      var ta = document.getElementById('importContent');
      if (ta) ta.value = e.target.result;

      // Auto-detect format from file extension
      var fname = input.files[0].name.toLowerCase();
      var formatSelect = document.querySelector('select[name="import_format"]');
      if (formatSelect) {
        if (fname.endsWith('.csv')) formatSelect.value = 'csv';
        else formatSelect.value = 'vcard';
      }
    };
    reader.readAsText(input.files[0]);
  }
  </script>`;
}
