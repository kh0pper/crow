/**
 * The Crow Mail flag. Until it is "1", nothing mail-related is reachable: every /dashboard/mail/api
 * route answers 404, the sync supervisor does not start, and no nav entry appears. Read per use.
 */
export function mailEnabled(env = process.env) {
  return env.CROW_MAIL === "1";
}