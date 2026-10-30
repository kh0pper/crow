/**
 * The For You flag (For You v1). Until it is "1", every For You entry point (the drawer and
 * mascot-sheet links, the phone drag reveal) is absent and /dashboard/for-you answers 404. Read per use.
 */
export function forYouEnabled(env = process.env) {
  return env.CROW_FOR_YOU === "1";
}
