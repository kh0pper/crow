/**
 * Where rendered blog figures live, read per call (not at import time: the
 * gateway loads .env after its static imports, so a module-level constant
 * could miss a value set there).
 *
 *   figuresBucket()     CROW_BLOG_FIGURES_BUCKET → "blog-figures"
 *   figureGatewayUrl()  BLOG_FIGURE_GATEWAY_URL → this gateway on 127.0.0.1
 */
import { gatewayListenPort } from "../gateway/listen-port.js";

export function figuresBucket(env = process.env) {
  return env.CROW_BLOG_FIGURES_BUCKET || "blog-figures";
}

export function figureGatewayUrl(env = process.env) {
  return env.BLOG_FIGURE_GATEWAY_URL || `http://127.0.0.1:${gatewayListenPort(env)}`;
}
