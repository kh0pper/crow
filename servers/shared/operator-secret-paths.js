/**
 * The operator's credential locations that no bot and no add-on may reach —
 * ONE list, so the layers cannot drift.
 *
 * Every JS boundary reads this list instead of naming paths of its own:
 * *  - `scripts/pi-bots/hidden_files.mjs` — the default bwrap tier. A `dir` is
 *    hidden WHOLE (a tmpfs over it, created empty only for `~/.ssh`), a `file`
 *    is masked with an empty one (`--dev-bind /dev/null`). Each is resolved by
 *    `resolveHiddenSecretPath` before every spawn: every component below the
 *    home is `lstat`ed, so a symlink anywhere on the way refuses the spawn. A
 *    `dir`'s `(dev, ino)` is remembered in the instance's secrets dir, so one
 *    that disappears or is replaced refuses it too — folders only: an ordinary
 *    tool rewrite gives a credential FILE a new inode, so remembering one would
 *    refuse every bot after `npm config set` or `docker login`, and the mask
 *    needs no memory (it is remade from the path, and the file bind cannot be
 *    removed from inside the sandbox). Nothing here is ever created.
 *  - `scripts/pi-bots/pi_contain.mjs` `neverBound(home)` — the contain tier's
 *    refuse list. The add-on wall builds its own plan on the same function
 *    (`makeBindPolicy` in that module), which is what keeps an add-on's
 *    path binds and every fd bind off these paths
 *    (`scripts/addon-sandbox/plan.mjs`, `scripts/addon-sandbox/bind-fd.mjs`).
 *  - `servers/shared/isolation-check.js` `defaultSensitivePaths` — the boot
 *    isolation report (`[isolation] sensitive paths openable: …`), which
 *    `scripts/ops/isolation-audit.mjs` prints too.
 *  - `servers/shared/history/workspace-deny.js` — what a project's file history
 *    never records (`~/.aws` copied into a workspace, say).
 *  - `servers/gateway/services/connect-test.js` `guardedExtras` — a folder
 *    service's root may never be, or contain, one of these.
 *
 * The google-workspace add-on's own Python guard
 * (`bundles/google-workspace/google_workspace_mcp/local_paths.py`,
 * `_PRIVATE_PATTERNS`) keeps a copy: it runs in another language, ships inside
 * the bundle, and must refuse a path even if the wall were off. A test parses
 * that file and holds the two lists in step (`tests/pibot-hidden-files.test.js`,
 * "the Python guard mirrors this list").
 *
 * `rel` is always relative to the OPERATOR's home (HOME), never to a Crow
 * home: these are the operator's own files, not the instance's.
 *
 *  - `.ssh` — ssh keys and `authorized_keys` (the one folder created empty,
 *    because its mask must always apply).
 *  - `.gnupg` — gpg's keyrings, trust db and agent socket.
 *  - `.config/gcloud` — the Google Cloud CLI: application-default credentials,
 *    `credentials.db`, `access_tokens.db`, `legacy_credentials/`.
 *  - `.aws`, `.azure`, `.kube` — cloud CLI credential and cluster config.
 *  - `.config/gh` — the `gh` CLI's OAuth token (`hosts.yml`).
 *  - `.terraform.d` — Terraform's `credentials.tfrc.json` and installed
 *    provider credentials.
 *  - `.docker/config.json` — registry logins (the docker socket is refused
 *    separately; this file only carries registry auth, never daemon access).
 *  - `.netrc` — plaintext http/ftp credentials (git, curl, pip).
 *  - `.npmrc` — registry tokens. A bot's npm uses its own per-instance cache
 *    and never needs the operator's registry auth.
 *  - `.pgpass` — PostgreSQL passwords.
 *  - `.config/containers/auth.json` — podman/skopeo registry logins.
 */
import { join } from "node:path";

export const OPERATOR_SECRET_PATHS = Object.freeze([
  { rel: ".ssh", kind: "dir" },
  { rel: ".gnupg", kind: "dir" },
  { rel: ".config/gcloud", kind: "dir" },
  { rel: ".aws", kind: "dir" },
  { rel: ".azure", kind: "dir" },
  { rel: ".kube", kind: "dir" },
  { rel: ".config/gh", kind: "dir" },
  { rel: ".terraform.d", kind: "dir" },
  { rel: ".docker/config.json", kind: "file" },
  { rel: ".netrc", kind: "file" },
  { rel: ".npmrc", kind: "file" },
  { rel: ".pgpass", kind: "file" },
  { rel: ".config/containers/auth.json", kind: "file" },
]);

/** The `rel` of every folder in the list, in list order. */
export const OPERATOR_SECRET_DIRS = Object.freeze(OPERATOR_SECRET_PATHS.filter((p) => p.kind === "dir").map((p) => p.rel));
/** The `rel` of every file in the list, in list order. */
export const OPERATOR_SECRET_FILES = Object.freeze(OPERATOR_SECRET_PATHS.filter((p) => p.kind === "file").map((p) => p.rel));

/** One path below `home` (never resolved here: callers resolve their home first). */
export function operatorSecretPath(home, rel) {
  return join(String(home), rel);
}

/** Every path of the list below `home`, in list order. */
export function operatorSecretPaths(home) {
  return OPERATOR_SECRET_PATHS.map(({ rel }) => operatorSecretPath(home, rel));
}

/** "dir" or "file" for a `rel` of the list, or null for anything else. */
export function operatorSecretKind(rel) {
  const hit = OPERATOR_SECRET_PATHS.find((p) => p.rel === rel);
  return hit ? hit.kind : null;
}