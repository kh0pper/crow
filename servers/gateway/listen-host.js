/**
 * The address this gateway process listens on. One expression, shared by the
 * listener (index.js) and the Nest Privacy signal, which reports whether the
 * dashboard is bound to every interface. Re-reading the env in two places is
 * how the card and the actual listener drift apart (audit N1c-16).
 */
export const GATEWAY_BIND_ENV = "CROW_GATEWAY_BIND";
export const DEFAULT_GATEWAY_BIND = "0.0.0.0";

export function gatewayListenHost(env = process.env) {
  return env[GATEWAY_BIND_ENV] || DEFAULT_GATEWAY_BIND;
}