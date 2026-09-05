export function gatewayPort(env = process.env) {
  const raw = Number.parseInt(env.PORT || env.CROW_GATEWAY_PORT || "3001", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 3001;
}
export function doorBaseUrl({ tailnetIp, port }) { return `http://${tailnetIp || "127.0.0.1"}:${port}/llm/v1`; }
export function nativeLoopbackUrl(port) { return `http://127.0.0.1:${port}/v1`; }
