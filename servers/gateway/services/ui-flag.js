/**
 * The project Services UI flag (project services, decision 5: each PR is safe to deploy alone).
 * Until the PR that makes bots use connections, every Services entry point, the Services pages
 * and their JSON API stay hidden unless CROW_SERVICES_UI is exactly "1".
 */
export function servicesUiEnabled(env = process.env) {
  return env.CROW_SERVICES_UI === "1";
}
