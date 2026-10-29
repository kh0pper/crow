/**
 * The gateway's last error handler, for body-parser refusals only (credential card §10.3).
 *
 * Express's default handler logs `err.stack` and, outside production, sends it back in an HTML
 * page. For a body that does not parse, Node's JSON.parse message quotes a window of the body
 * text, and a body may hold a pasted password or key, so both would carry part of it. This
 * answers a fixed JSON `{ error: "bad_body" }` with the parser's status and logs one fixed line,
 * never the message. Every other error passes on to `next(err)` unchanged.
 *
 * Routers that parse their own body (services-api, perch-interactive-api, roles-api) keep their
 * own fixed handlers; this covers everything else, the global 1mb parser above all. Register it
 * after every router: `app.use(bodyErrorHandler)`.
 */

const BODY_ERROR_TYPES = new Set(["entity.parse.failed", "entity.too.large", "encoding.unsupported", "charset.unsupported"]);

/** True for an error raised by body-parser (express.json / urlencoded / text / raw). */
export function isBodyParserError(err) {
  if (!err || typeof err !== "object") return false;
  if (typeof err.type === "string" && BODY_ERROR_TYPES.has(err.type)) return true;
  const status = Number(err.status || err.statusCode);
  return (status === 400 || status === 413) && "body" in err;
}

export function bodyErrorHandler(err, req, res, next) {
  if (!isBodyParserError(err) || res.headersSent) return next(err);
  const status = Number(err.status || err.statusCode);
  console.warn("[gateway] bad body");
  res.status([400, 413, 415].includes(status) ? status : 400).json({ error: "bad_body" });
}
