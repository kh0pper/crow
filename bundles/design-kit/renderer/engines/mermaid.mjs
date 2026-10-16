// Mermaid engine: headless Chromium in this container, one page per render,
// every network request aborted, securityLevel strict, SVG (not HTML) labels so
// the output has no foreignObject (Artifacts refuses foreignObject). The config's
// `secure` list stops a spec's own front matter or directives from overriding
// any of it (the kit guard refuses those first; this is the second layer).
import puppeteer from "puppeteer-core";
import { fileURLToPath } from "node:url";
import { MERMAID_CONFIG } from "../mermaid-config.mjs";

const MERMAID_JS = fileURLToPath(new URL("../node_modules/mermaid/dist/mermaid.min.js", import.meta.url));
// --no-sandbox: the container is the sandbox (non-root, read-only rootfs, cap_drop
// ALL, no-new-privileges, no network). Never add SYS_ADMIN to enable Chromium's own.
const ARGS = ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--no-first-run", "--disable-extensions",
  "--disable-background-networking", "--disable-crash-reporter", "--disable-breakpad", "--disable-component-update",
  "--disable-sync", "--disable-default-apps", "--metrics-recording-only", "--mute-audio"];

export function mermaidEngine({ executablePath = process.env.CHROMIUM_PATH || "/usr/bin/chromium" } = {}) {
  let browser = null;   // a Promise<Browser> while one is starting or running
  const launch = () => {
    if (!browser) {
      const p = puppeteer.launch({ executablePath, headless: true, args: ARGS });
      browser = p;
      p.then((b) => b.on("disconnected", () => { if (browser === p) browser = null; }), () => { if (browser === p) browser = null; });
    }
    return browser;
  };
  return {
    async render(source) {
      const b = await launch();
      const page = await b.newPage();
      try {
        await page.setRequestInterception(true);
        page.on("request", (r) => { const u = r.url(); return u.startsWith("about:") || u.startsWith("data:") ? r.continue() : r.abort(); });
        await page.setContent("<!doctype html><html><body></body></html>");
        await page.addScriptTag({ path: MERMAID_JS });
        const svg = await page.evaluate(async (src, cfg) => {
          window.mermaid.initialize(cfg);
          const out = await window.mermaid.render("crow-m", src);
          return out.svg;
        }, source, MERMAID_CONFIG);
        // Review M7: a type that ignores htmlLabels:false emits HTML labels;
        // Artifacts refuses foreignObject, so say so with a fixed category.
        if (String(svg).toLowerCase().includes("<foreignobject")) throw new Error("unsupported diagram type (html labels)");
        return svg;
      } finally { await page.close().catch(() => {}); }
    },
    // The server calls this after a timeout: a hung render dies with the browser.
    async reset() {
      const p = browser; browser = null;
      if (!p) return;
      const b = await Promise.resolve(p).catch(() => null);
      if (b) { const proc = b.process(); await b.close().catch(() => {}); try { proc && proc.kill("SIGKILL"); } catch {} }
    },
  };
}
