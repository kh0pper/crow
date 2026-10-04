/** Every file-tool def by name: what the close-time applier runs (queued changes and the internal inverse ops). */
import { driveReadDefs, driveWriteDefs } from "./drive.js";
import { docsReadDefs, docsWriteDefs } from "./docs.js";
import { commentDefs } from "./docs-comments.js";
import { sheetsDefs } from "./sheets.js";
import { slidesDefs } from "./slides.js";
import { undoDef } from "./undo.js";
import { inverseDefs } from "./inverse.js";

export const ALL_DEFS = new Map([...driveReadDefs, ...driveWriteDefs, ...docsReadDefs, ...docsWriteDefs, ...commentDefs, ...sheetsDefs, ...slidesDefs, undoDef, ...inverseDefs].map((d) => [d.name, d]));
