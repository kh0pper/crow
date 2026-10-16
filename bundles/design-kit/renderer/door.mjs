// The door: a TCP relay from 127.0.0.1:8018 on the host to the renderer on the
// internal network. It carries bytes only; it has no engines and no fetch.
import { createServer, connect } from "node:net";

const MAX = 16;
let open = 0;
createServer((client) => {
  if (open >= MAX) { client.destroy(); return; }
  open++;
  let closed = false;
  const up = connect(8018, "render");
  const done = () => { if (closed) return; closed = true; open--; client.destroy(); up.destroy(); };
  client.setTimeout(30000, done);
  up.setTimeout(30000, done);
  client.on("error", done); up.on("error", done);
  client.on("close", done); up.on("close", done);
  client.pipe(up).pipe(client);
}).listen(8018, "0.0.0.0");
