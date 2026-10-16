// One Vega-Lite → SVG render in a worker thread (no browser). vega-lite
// compiles, vega parses to an AST and the CSP-safe interpreter evaluates it;
// vega-embed is never used. Data loading is refused in-process too (the guard
// already refused url/href/usermeta before the render).
import { parentPort, workerData } from "node:worker_threads";
import * as vega from "vega";
import { compile } from "vega-lite";
import { expressionInterpreter } from "vega-interpreter";

// Review M2: never Vega's Function-based expression codegen on a spec that may
// come from outside the owner's Crow — parse to an AST and interpret it.
const deny = async () => { throw new Error("external data is not allowed"); };
try {
  const loader = vega.loader();
  loader.load = deny; loader.sanitize = deny; loader.http = deny; loader.file = deny;
  // JSON.parse (never eval). The source is always Vega-Lite: "$schema" is
  // dropped so it can never switch the engine to raw Vega or another mode.
  const spec = JSON.parse(workerData.source);
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) throw new Error("invalid spec: must be a JSON object");
  delete spec.$schema;
  const runtime = vega.parse(compile(spec).spec, null, { ast: true });
  const view = new vega.View(runtime, { renderer: "none", loader, expr: expressionInterpreter, logLevel: vega.None });
  const svg = await view.toSVG();
  view.finalize();
  parentPort.postMessage({ svg });
} catch (e) {
  parentPort.postMessage({ error: String((e && e.message) || e).slice(0, 500) });
}
