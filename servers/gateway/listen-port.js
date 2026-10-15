/**
 * The port this gateway process listens on. One expression, shared by the
 * listener (index.js) and the Nest exposure check, which uses it to tell this
 * gateway's Funnel paths from another service's on the same host.
 */
export function gatewayListenPort(env = process.env) {
  return parseInt(env.PORT || env.CROW_GATEWAY_PORT || "3001", 10);
}
