/**
 * The three URL shapes a native model has, in one place.
 *
 * A native model is a plain `llama-server` process bound to loopback on a port
 * out of the 18100-18199 pool. That port is meaningless to anyone off the box
 * and does not survive replication, so a native provider row advertises the
 * DOOR instead — the OWNING gateway's own `/llm/v1` on its tailnet address
 * (`doorBaseUrl`). Peers, pi-lab and replicated rows dial the door; the owning
 * gateway dials `nativeLoopbackUrl` directly, because posting to its own door
 * would recurse back into its router. `servers/shared/native-locality.js`
 * decides which of the two a given read path should hand out.
 *
 * `gatewayPort` reads the same env the gateway itself binds, so a co-hosted
 * second instance (r4 on :3008) builds a door pointing at ITS gateway, not the
 * primary's.
 */
export function gatewayPort(env = process.env) {
  const raw = Number.parseInt(env.PORT || env.CROW_GATEWAY_PORT || "3001", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 3001;
}
export function doorBaseUrl({ tailnetIp, port }) { return `http://${tailnetIp || "127.0.0.1"}:${port}/llm/v1`; }
export function nativeLoopbackUrl(port) { return `http://127.0.0.1:${port}/v1`; }
