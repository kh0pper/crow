// Child for tests/sqlite-lock.test.js. Modes:
//   contend <lock> <marker> <iters>  — enter the lock iters times; inside, a
//                                      marker file must not exist (else VIOLATION)
//   hold <lock>                      — take the lock, print "held", wait to be killed
import { existsSync, writeFileSync, unlinkSync } from "node:fs";
import { withSqliteLock } from "../../servers/shared/sqlite-lock.js";
const [mode, lock, marker, iters] = process.argv.slice(2);
if (mode === "contend") {
  let bad = 0;
  for (let i = 0; i < Number(iters); i++) {
    await withSqliteLock(lock, async () => {
      if (existsSync(marker)) bad++;
      writeFileSync(marker, String(process.pid));
      await new Promise((r) => setTimeout(r, 3));
      unlinkSync(marker);
    });
  }
  process.stdout.write(bad ? "VIOLATION" : "ok");
} else if (mode === "hold") {
  // The pending promise is pinned on globalThis: an unreferenced one lets V8
  // collect the suspended frame, and with it the lock's DB connection.
  globalThis.__hold = new Promise((r) => { globalThis.__release = r; });
  setInterval(() => {}, 1000);
  await withSqliteLock(lock, async () => { process.stdout.write("held\n"); await globalThis.__hold; });
}
