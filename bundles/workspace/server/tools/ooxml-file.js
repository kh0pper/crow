/** Shared load / write wrappers for OOXML tool families (Sheets, and Slides next): type check, capped download, one save → one version. */
import { WsError } from "../result.js";
import { refOf, writeOptsOf } from "./common.js";
import { stat, getFile, resolveRef } from "../nc/dav.js";
import { withFileWrite, MAX_EDIT_BYTES } from "../write-protocol.js";

/** kind = { ext: "xlsx", noun: "an .xlsx spreadsheet", open: (bytes) => model }. */
const checkType = (kind, name) => { if (!new RegExp(`\\.${kind.ext}$`, "i").test(name)) throw new WsError("wrong_type", `"${name}" is not ${kind.noun}`); };

export async function loadOoxml(cfg, ref, kind) {
  const segs = await resolveRef(cfg, ref);
  const entry = await stat(cfg, segs);
  checkType(kind, entry.name);
  const { bytes, etag } = await getFile(cfg, segs, { maxBytes: MAX_EDIT_BYTES });
  return { entry: { ...entry, etag }, model: kind.open(bytes) };
}

/** Run fn(model) on the live file inside the write protocol. fn returns {changed, summary, data}; changed 0 → no version. */
export function ooxmlWrite(ctx, args, kind, fn, label = "Crow") {
  return withFileWrite(ctx.getConfig(), refOf(args), async (bytes, entry) => {
    checkType(kind, entry.name);
    const model = kind.open(bytes);
    const r = fn(model);
    if (!r.changed) return { changed: 0, data: r.data };
    return { bytes: model.pkg.save(), changed: r.changed, summary: r.summary, data: r.data };
  }, { clock: ctx.clock, label, ...writeOptsOf(args) }); // a close-time apply's __label wins over the tool's default
}
