/** PHONE_RUNNER_SECRET is a required install-time env var (manifest env_vars):
 *  the installer writes it to the bundle .env (compose) and the gateway env. */
export function readRunnerSecret(env = process.env) {
  const v = env.PHONE_RUNNER_SECRET;
  return typeof v === "string" && v.length >= 32 ? v : null;
}
