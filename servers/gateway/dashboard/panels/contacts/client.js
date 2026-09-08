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

  // === My profile: shrink a chosen picture to a 128 px square data: URI (spec 2026-09-08 §4.1) ===
  // The server caps the stored string (data-max = AVATAR_MAX_BYTES) and re-validates;
  // this is the friendly half. Cover-fit; JPEG 0.82 for an opaque image; PNG when the
  // source has transparency, flattened JPEG fallbacks when that is still too big; a
  // message and an empty field when nothing fits.
  function readProfilePicture(input) {
    var msg = document.getElementById('profilePictureMsg');
    var hidden = document.getElementById('profileAvatarData');
    if (!input.files || !input.files[0] || !hidden) return;
    var max = parseInt(input.getAttribute('data-max'), 10) || 32768;
    var file = input.files[0];
    var url = URL.createObjectURL(file);
    var img = new Image();
    img.onload = function () {
      URL.revokeObjectURL(url);
      var size = 128;
      var canvas = document.createElement('canvas');
      canvas.width = size; canvas.height = size;
      var ctx = canvas.getContext('2d');
      var s = Math.min(img.naturalWidth, img.naturalHeight);
      var sx = (img.naturalWidth - s) / 2, sy = (img.naturalHeight - s) / 2;
      ctx.drawImage(img, sx, sy, s, s, 0, 0, size, size);
      var data = ctx.getImageData(0, 0, size, size).data;
      var transparent = false;
      for (var i = 3; i < data.length; i += 4) { if (data[i] < 255) { transparent = true; break; } }
      var out = transparent ? canvas.toDataURL('image/png') : canvas.toDataURL('image/jpeg', 0.82);
      if (out.length > max) out = flattenedJpeg(canvas, size, 0.82);
      if (out.length > max) out = flattenedJpeg(canvas, size, 0.6);
      if (out.length > max) {
        hidden.value = '';
        if (msg) msg.textContent = input.getAttribute('data-too-big') || 'Picture too large';
        return;
      }
      hidden.value = out;
      showProfilePreview(out);
      var pick = document.querySelector('input[name="avatar_source"][value="picture"]');
      if (pick) pick.checked = true;
      var clear = document.querySelector('input[name="avatar_clear"]');
      if (clear) clear.checked = false;
      if (msg) msg.textContent = '';
    };
    img.onerror = function () {
      URL.revokeObjectURL(url);
      hidden.value = '';
      if (msg) msg.textContent = input.getAttribute('data-bad-image') || 'Could not read that image';
    };
    img.src = url;
  }

  // A transparent source flattened onto white before JPEG (a bare toDataURL paints black).
  function flattenedJpeg(canvas, size, quality) {
    var flat = document.createElement('canvas');
    flat.width = size; flat.height = size;
    var ctx = flat.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, size, size);
    ctx.drawImage(canvas, 0, 0);
    return flat.toDataURL('image/jpeg', quality);
  }

  // The preview box gets a fresh <img> (a src assignment is not a markup sink).
  function showProfilePreview(dataUri) {
    var box = document.getElementById('profileAvatarPreview');
    if (!box) return;
    while (box.firstChild) box.removeChild(box.firstChild);
    var img = document.createElement('img');
    img.alt = '';
    img.src = dataUri;
    box.appendChild(img);
  }
  </script>`;
}
