/**
 * A caller-chosen file name, confined to one folder (queue item 26f).
 *
 * The export and session tools join a name the model supplies into a folder under
 * this instance's home. Without a check, `../../x` writes (or reads) outside it.
 */
import { lstatSync, openSync, writeFileSync, readFileSync, closeSync, fchmodSync, constants } from "node:fs";
import { join, resolve, dirname, basename } from "node:path";

export const MAX_FILE_NAME = 128;

/**
 * The full path of `<name>.<ext>` inside `dir`, or throws. `name` must be a plain
 * file name: 1-128 characters, no `/` or `\`, no control characters, not starting
 * with a dot (no `.`, `..` or hidden file). A trailing `.<ext>` is not doubled.
 * An existing symlink at the target is refused (writing through it could land anywhere).
 */
export function fileInDir(dir, name, ext) {
  const raw = typeof name === "string" ? name : "";
  if (!raw || raw.length > MAX_FILE_NAME || /[/\\]/.test(raw) || /[\u0000-\u001f\u007f]/.test(raw) || raw.startsWith(".")) {
    throw new Error(`invalid file name ${JSON.stringify(raw.slice(0, 60))}: use a plain name of 1-${MAX_FILE_NAME} characters, with no "/" or "\\", not starting with "."`);
  }
  const stem = raw.toLowerCase().endsWith(`.${ext}`) ? raw.slice(0, -(ext.length + 1)) : raw;
  if (!stem || stem.startsWith(".")) throw new Error(`invalid file name ${JSON.stringify(raw)}`);
  // NAME_MAX is 255 bytes, not characters.
  if (Buffer.byteLength(`${stem}.${ext}`) > 255) throw new Error(`invalid file name ${JSON.stringify(raw.slice(0, 60))}: too long once encoded (255 bytes at most)`);
  const root = resolve(dir);
  const full = join(root, `${stem}.${ext}`);
  if (dirname(full) !== root || basename(full) !== `${stem}.${ext}`) {
    throw new Error(`invalid file name ${JSON.stringify(raw)}: it must stay inside ${root}`);
  }
  let st = null;
  try { st = lstatSync(full); } catch { /* absent: fine */ }
  if (st?.isSymbolicLink()) throw new Error(`refusing to use ${full}: it is a symlink`);
  return full;
}

/**
 * Write `data` to `full` without following a symlink planted there between the check in
 * fileInDir and this write (O_NOFOLLOW). `mode` applies to a new file and is re-set on an
 * existing one (session files hold cookies: 0600).
 */
export function writeFileNoFollow(full, data, mode = 0o644) {
  const fd = openSync(full, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, mode);
  try {
    fchmodSync(fd, mode);
    writeFileSync(fd, typeof data === "string" ? data : String(data));
  } finally { closeSync(fd); }
}

/** Read `full` as UTF-8 without following a symlink (O_NOFOLLOW). */
export function readFileNoFollow(full) {
  const fd = openSync(full, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { return readFileSync(fd, "utf8"); } finally { closeSync(fd); }
}
