/**
 * The project Services UI flag (project services, decision 5). Bots use connections, so the
 * Services pages, their JSON API and every entry point are ON by default; CROW_SERVICES_UI=0 is
 * the operator's kill switch that hides them all again.
 */
export function servicesUiEnabled(env = process.env) {
  return env.CROW_SERVICES_UI !== "0";
}