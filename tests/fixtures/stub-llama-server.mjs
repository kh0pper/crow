/**
 * Minimal stand-in for llama-server's OpenAI-compatible "list models"
 * endpoint (Item G Task 8, `tests/models-runtime.test.js`). This is what
 * `identityProbe()` is tested against — never a real llama-server binary,
 * never real (non-loopback) network.
 *
 * `identityProbe(baseUrl, alias, fetchImpl)` fetches `${baseUrl}/models`
 * (brief-literal path). A real llama-server exposes this at `/v1/models`,
 * so a production caller passes a `baseUrl` that already ends in `/v1`
 * (matching the provider `base_url` shape `manager.js` writes,
 * `http://127.0.0.1:<port>/v1`) — this fixture itself only ever needs to
 * answer whatever path its caller requests, so it serves plain `/models`
 * and tests build `baseUrl` without a `/v1` suffix.
 *
 * Usable two ways:
 *   - Imported in-process (the pattern `tests/models-manager.test.js`
 *     already uses for its HF download fixture): `startStubLlamaServer({
 *     modelId }) -> Promise<{ server, port, baseUrl, close() }>`.
 *   - Run standalone (`node tests/fixtures/stub-llama-server.mjs <modelId>
 *     [port]`) for manual poking; prints `PORT <n>` on its first stdout
 *     line once listening.
 */
import http from "node:http";

/**
 * Start the stub server. `modelId` is the id it reports at `data[0].id`
 * (the "what does this server think it's serving" the conflict-detection
 * test flips). `port` defaults to 0 (OS-assigned, avoids collisions
 * between parallel test files).
 */
export function startStubLlamaServer({ modelId, port = 0, host = "127.0.0.1" } = {}) {
  return new Promise((resolvePromise, reject) => {
    const server = http.createServer((req, res) => {
      if (req.method === "GET" && req.url === "/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ object: "list", data: [{ id: modelId, object: "model" }] }));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });
    server.once("error", reject);
    server.listen(port, host, () => {
      const actualPort = server.address().port;
      resolvePromise({
        server,
        port: actualPort,
        baseUrl: `http://${host}:${actualPort}`,
        close: () => new Promise((res) => server.close(res)),
      });
    });
  });
}

// Standalone entry point — not exercised by the test suite, kept for
// manual/ops use (e.g. poking identityProbe by hand against a real port).
if (import.meta.url === `file://${process.argv[1]}`) {
  const modelId = process.argv[2] || "stub-model";
  const port = Number(process.argv[3] || 0);
  startStubLlamaServer({ modelId, port }).then(({ port: p }) => {
    process.stdout.write(`PORT ${p}\n`);
  });
  process.on("SIGTERM", () => process.exit(0));
}
