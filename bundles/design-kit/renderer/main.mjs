// The renderer container's entrypoint. Listens on the INTERNAL Docker network
// only; the door service is what publishes 127.0.0.1:8018.
//
// RENDER_ALLOWED_HOSTS (comma-separated host:port) only ADDS Host values to the
// loopback defaults, e.g. the smoke instance's 127.0.0.1:18018. Entries that are
// not a loopback name with a port are ignored, so it can never open the
// DNS-rebinding check to an arbitrary name.
import { createRenderServer, DEFAULT_ALLOWED_HOSTS } from "./server.mjs";
import { vegaEngine } from "./engines/vega.mjs";
import { mermaidEngine } from "./engines/mermaid.mjs";
import { d2Engine } from "./engines/d2.mjs";
import { cleanSvg } from "./svg.mjs";

const LOOPBACK_HOST = /^(?:127\.0\.0\.1|localhost|\[::1\]):\d{1,5}$/;
const extraHosts = String(process.env.RENDER_ALLOWED_HOSTS || "").split(",").map((h) => h.trim().toLowerCase()).filter((h) => LOOPBACK_HOST.test(h));
const server = createRenderServer({
  engines: { "vega-lite": vegaEngine(), mermaid: mermaidEngine(), d2: d2Engine() },
  clean: cleanSvg,
  log: (m) => console.log(m),
  allowedHosts: new Set([...DEFAULT_ALLOWED_HOSTS, ...extraHosts]),
});
server.listen(8018, "0.0.0.0", () => console.log("[render] listening on :8018 (internal network only)"));
