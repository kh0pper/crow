/**
 * The crow mark — the header bird's static geometry, as a reusable SVG.
 *
 * The header tamagotchi (notifications.js tamagotchiHtml) draws its body from
 * CROW_BODY_GROUP and wraps it with its ids, bubble and mood classes. The
 * onboarding Welcome step draws the same bird through crowMarkSvg(), so the
 * page a new user lands on shows the bird they will see in the header.
 *
 * No ids here, ever: the header bird owns #crow-tama and its scripts find it
 * by id; a second copy carrying ids would collide. The mood animations in
 * tamagotchiCss() are scoped under .crow-happy / .crow-tired / .crow-alarmed,
 * which the mark never carries, so it stays still.
 *
 * Not CROW_HERO_SVG (crow-hero.js): that is the login / setup art, a
 * different drawing. This is the header bird.
 */

export const CROW_BODY_GROUP = '<g class="crow-body-group">' +
  '<g class="crow-feet">' +
  '<line x1="19" y1="42" x2="17" y2="48" stroke="#0e6b62" stroke-width="1.5" stroke-linecap="round"/>' +
  '<line x1="19" y1="42" x2="21" y2="48" stroke="#0e6b62" stroke-width="1.5" stroke-linecap="round"/>' +
  '<line x1="29" y1="42" x2="27" y2="48" stroke="#0e6b62" stroke-width="1.5" stroke-linecap="round"/>' +
  '<line x1="29" y1="42" x2="31" y2="48" stroke="#0e6b62" stroke-width="1.5" stroke-linecap="round"/>' +
  '</g>' +
  '<ellipse class="crow-body" cx="24" cy="34" rx="12" ry="10" fill="#0e6b62"/>' +
  '<ellipse class="crow-wing" cx="14" cy="33" rx="6" ry="8" fill="#4fbdb0" opacity="0.5" transform-origin="14 33"/>' +
  '<circle class="crow-head" cx="24" cy="18" r="9" fill="#0e6b62"/>' +
  '<circle class="crow-eye" cx="28" cy="16" r="3" fill="#d9a521"/>' +
  '<circle class="crow-pupil" cx="29" cy="16" r="1.5" fill="#22303a"/>' +
  '<polygon class="crow-beak" points="33,18 40,20 33,22" fill="#d9a521"/>' +
  '</g>';

/**
 * The bird alone, cropped to its own square (head top y=9 to feet y=48,
 * centred on x=24), decorative.
 * @param {{size?: number}} [opts] - pixel width and height (default 48)
 */
export function crowMarkSvg({ size } = {}) {
  const px = Number.isInteger(size) && size > 0 ? size : 48;
  return `<svg class="crow-mark" viewBox="4.5 9 39 39" width="${px}" height="${px}" aria-hidden="true" focusable="false">${CROW_BODY_GROUP}</svg>`;
}
