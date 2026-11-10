/**
 * Golden fixtures for the bot sandbox path (review item 8).
 *
 * These functions rebuild the INPUTS the two existing bot-sandbox test files
 * use and return what the sandbox code produces for them, so a later refactor
 * of scripts/pi-bots/pi_contain.mjs or scripts/pi-bots/pi_egress.mjs can be
 * shown byte-identical against tests/fixtures/bot-golden/*.json. Nothing here
 * changes the sandbox code; this module only drives it.
 *
 * buildContainCases() replays EVERY buildContainPlan(...) call in
 * tests/pi-contain-plan.test.js and tests/pi-contain-agent.test.js, in the
 * order those files make them (their fixtures grow as those files run, and
 * some calls see files an earlier test wrote). Each case is named after the
 * test title it comes from plus its index inside that test. A call whose test
 * expects a ContainRefused is recorded as `{ name, refused: <message> }`.
 *
 * HOST-DEPENDENT ARGS REMOVED from every plan, each as its whole triple or
 * pair (they describe the machine, not the code):
 *   --symlink <target> /bin | /sbin | /lib | /lib64 | /lib32   (a usr-merge host)
 *   --ro-bind  <p>     <p>   for those same five paths       (a host without it)
 *   --ro-bind  /run/systemd/resolve /run/systemd/resolve      (systemd-resolved present)
 *   --tmpfs    /etc/crow                                      (/etc/crow present)
 *   --ro-bind  /opt    /opt                                   (the default system dirs)
 * Everything else stays exactly as buildContainPlan produced it.
 *
 * buildEgressTranscripts() records the bytes in and out of every relay
 * connection made by tests/pi-egress.test.js (see the skipped-test list next
 * to that function for the ones a machine's clock or kernel decides).
 *
 * Normalisation, applied to every string, recursively: the scratch root
 * becomes <T>, os.tmpdir() as a whole path prefix becomes <TMP>, every
 * upstream/gateway port the recorder itself opened becomes <UP1>, <UP2>...
 * in creation order, and the value of an HTTP `date` header becomes <DATE>
 * (a clock reading is not part of the protocol bytes being pinned).
 */
import { createHmac } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { connect, createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { buildContainPlan, ContainRefused } from "../../../scripts/pi-bots/pi_contain.mjs";
import { buildContainedAgentDir } from "../../../scripts/pi-bots/pi_contain_agent.mjs";
import { startEgressRelay } from "../../../scripts/pi-bots/pi_egress.mjs";
import { normalizeBaseUrl } from "../../../servers/shared/provider-presets.js";

// ---- normalisation -------------------------------------------------------

const USR_MERGE_LINKS = new Set(["/bin", "/sbin", "/lib", "/lib64", "/lib32"]);
/** Read-only binds whose presence depends on the machine, not on the code. */
const HOST_RO_BINDS = new Set(["/run/systemd/resolve", "/opt", ...USR_MERGE_LINKS]);
/** tmpfs mounts that mask a directory only when it exists on the machine. */
const HOST_TMPFS = new Set(["/etc/crow"]);

/** Drop the host-dependent mount entries (see the file header), whole entries only. */
function dropHostEntries(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--symlink") {
      const [, dst] = [args[i + 1], args[i + 2]];
      if (USR_MERGE_LINKS.has(dst)) { i += 2; continue; }
      out.push(a, args[i + 1], args[i + 2]); i += 2; continue;
    }
    if (a === "--ro-bind") {
      const [src, dst] = [args[i + 1], args[i + 2]];
      if (src === dst && HOST_RO_BINDS.has(src)) { i += 2; continue; }
      out.push(a, src, dst); i += 2; continue;
    }
    if (a === "--tmpfs") {
      if (HOST_TMPFS.has(args[i + 1])) { i += 1; continue; }
      out.push(a, args[i + 1]); i += 1; continue;
    }
    out.push(a);
  }
  return out;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function normaliseString(s, { root = null, ports = null } = {}) {
  let out = s;
  if (root) out = out.split(root).join("<T>");
  // os.tmpdir() only as the PREFIX of a longer path: the bare directory is a
  // fixed mount point and an env value the sandbox code itself writes, not a
  // host path, so it stays literal.
  const tmp = tmpdir();
  if (tmp && tmp !== root) {
    const lead = "(^|[^A-Za-z0-9._/\\\\-])";
    out = out.replace(new RegExp(lead + escapeRe(tmp) + "(?=[/\\\\])", "g"), "$1<TMP>");
  }
  if (ports && ports.size) {
    // Longest number first, whole numbers only, so one port's digits are never
    // rewritten inside another number or inside an address.
    const ordered = [...ports.entries()].sort((a, b) => String(b[0]).length - String(a[0]).length);
    for (const [port, token] of ordered) out = out.replace(new RegExp("(?<!\\d)" + port + "(?!\\d)", "g"), token);
  }
  // An HTTP response's Date header is the machine's clock, not its bytes.
  out = out.replace(/(^|\r\n)date:[^\r\n]*/gi, "$1date: <DATE>");
  return out;
}

function normalise(value, opts) {
  if (typeof value === "string") return normaliseString(value, opts);
  if (Array.isArray(value)) return value.map((v) => normalise(v, opts));
  if (value && typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value)) out[k] = normalise(value[k], opts);
    return out;
  }
  return value;
}

// ---- contain plans -------------------------------------------------------

/**
 * One `{ name, plan }` per buildContainPlan(...) call in the two contain test
 * files, with the host-dependent args dropped and the scratch paths
 * normalised.
 * @returns {Array<{name: string, plan?: object, refused?: string}>}
 */
export function buildContainCases() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "crow-bot-golden-contain-")));
  const cases = [];
  const perTitle = new Map();

  const mk = (...p) => { const d = join(...p); mkdirSync(d, { recursive: true }); return d; };

  /** Record one call. A ContainRefused the test expects is recorded, not thrown. */
  const record = (title, build) => {
    const n = (perTitle.get(title) || 0) + 1;
    perTitle.set(title, n);
    const name = `${title} #${n}`;
    try {
      const plan = build();
      cases.push({ name, plan: { args: dropHostEntries(plan.args), env: plan.env, refused: plan.refused, net: plan.net } });
    } catch (e) {
      if (!(e instanceof ContainRefused)) throw e;
      cases.push({ name, refused: e.message });
    }
  };

  try {
    // ===== tests/pi-contain-plan.test.js =====
    // The module-level fake host layout of that file, one directory tree.
    const P = join(root, "plans");
    const H = join(P, "home", "alice");
    const node = mk(H, ".nvm", "versions", "node", "v24.0.0");
    mk(node, "bin"); writeFileSync(join(node, "bin", "node"), "");
    const cliRoot = mk(node, "lib", "node_modules", "@earendil-works", "pi-coding-agent");
    mk(cliRoot, "dist"); writeFileSync(join(cliRoot, "dist", "cli.js"), "");
    const app = mk(H, "crow");
    const piLab = mk(H, "pi-lab");
    const agent = mk(H, ".pi", "agent");
    for (const d of ["pkg", "agents", "prompts", "bin", "sessions"]) mk(agent, d);
    const shadow = mk(P, "shadow");
    const crowHome = mk(H, ".crow");
    const data = mk(crowHome, "data");
    writeFileSync(join(data, "crow.db"), "");
    writeFileSync(join(data, "identity.json"), "{}");
    mk(crowHome, "secrets");
    const otherInst = mk(H, ".crow-other", "data");
    mk(H, ".ssh"); mk(H, ".claude"); mk(H, ".gnupg");
    const session = mk(P, "sess", "bot-a");
    const work = mk(crowHome, "data", "projects", "p1", "workspace");
    const notes = mk(H, "notes");
    const out = mk(H, "out");
    const cache = mk(crowHome, "bot-cache");
    const addon = mk(crowHome, "bundles", "tasks");

    const base = (over = {}) => ({
      home: H, uid: 1000, nodeBin: join(node, "bin", "node"), cliPath: join(cliRoot, "dist", "cli.js"),
      appRoot: app, piLabDir: piLab, piAgentDir: agent, shadowAgentDir: shadow,
      crowHome, dataDir: data, botCacheDir: cache,
      sessionDir: session, cwd: session, workspaceDir: null,
      writePaths: [], readPaths: [], mcpServers: [],
      exists: undefined, systemDirs: ["/usr", "/etc"], ...over,
    });

    // "containSelected: ..." calls no plan builder (a predicate only).

    record("an empty root: tmpfs /, system dirs read-only, private /tmp and /run, a fresh home", () => buildContainPlan(base()));
    record("engine paths read-only: node install, pi package, checkout, pi-lab", () => buildContainPlan(base()));
    record("pi agent dir: a writable SHADOW at the real path, real subdirs read-only on top, sessions not exposed", () => buildContainPlan(base()));
    record("instance data dir read-write with its secrets masked; the rest of CROW_HOME is not bound", () => buildContainPlan(base()));
    record("instance data dir read-write with its secrets masked; the rest of CROW_HOME is not bound", () => buildContainPlan(base({ unmaskIdentity: true })));

    // The bot-paths test creates its symlink inside the test body.
    const linkToNotes = join(P, "link-to-notes");
    symlinkSync(notes, linkToNotes);
    record("bot paths: session and cwd rw, workspace rw, write_paths rw, read_paths ro, all realpath'd", () => buildContainPlan(base({ workspaceDir: work, writePaths: [out], readPaths: [linkToNotes] })));

    record("never bound, whatever the policy says: key dirs, assistant config, other instances, the whole home", () => buildContainPlan(base({
      writePaths: [join(H, ".ssh"), otherInst], readPaths: [join(H, ".claude"), join(H, ".gnupg", "x")],
    })));
    record("never bound, whatever the policy says: key dirs, assistant config, other instances, the whole home", () => buildContainPlan(base({ writePaths: [H] })));

    record("a write path covering the checkout or the engine is refused (code stays read-only)", () => buildContainPlan(base({ writePaths: [app, join(app, "servers"), node] })));

    record("bypass mode (\"/\" in a path list) cannot be contained: ContainRefused", () => buildContainPlan(base({ writePaths: ["/"] })));
    record("bypass mode (\"/\" in a path list) cannot be contained: ContainRefused", () => buildContainPlan(base({ readPaths: ["/"] })));

    record("missing paths are skipped and reported, not bound", () => buildContainPlan(base({ readPaths: [join(H, "nope")] })));

    // The MCP test writes its fixture inside the test body.
    const venvBin = mk(H, "proj", ".venv", "bin");
    writeFileSync(join(venvBin, "srv"), "");
    const tokenFile = join(H, "proj", "token.json");
    writeFileSync(tokenFile, "{}");
    record("MCP servers: cwd and an absolute command's install root read-only; files named in env read-only", () => buildContainPlan(base({ mcpServers: [
      { command: join(venvBin, "srv"), cwd: join(H, "proj"), env: { TOKEN_FILE: tokenFile, NAME: "x" } },
      { command: "node", args: ["server/index.js"], cwd: addon },
      { command: "npx", args: ["-y", "pkg"], cwd: H },
    ] })));

    record("bot cache: one per instance, read-write, and the cache env points at it", () => buildContainPlan(base()));
    record("mount order: parents before children, masks after the dirs they sit in", () => buildContainPlan(base({ workspaceDir: work })));

    const c9 = mk(P, "c9", "data");
    for (const f of ["crow.db", "crow.db-wal", "tasks.db", "crow.db.CORRUPT-1", "identity.json", "notes.txt"]) writeFileSync(join(c9, f), "");
    for (const x of ["backups", "peers", "instance-sync", "artifacts", join("projects", "mine", "workspace"), join("projects", "theirs")]) mk(c9, x);
    const c9ws = join(c9, "projects", "mine", "workspace");
    record("C9: the data dir keeps only the DBs, the bot's own project and the keep-list; everything else present is masked", () => buildContainPlan(base({ dataDir: c9, workspaceDir: c9ws, dataKeep: ["artifacts"] })));

    const appX = mk(P, "c3", "app");
    writeFileSync(join(appX, ".env"), "SECRET=1");
    writeFileSync(join(appX, ".env.local"), "S=1");
    mk(appX, "bundles", "minio"); writeFileSync(join(appX, "bundles", "minio", ".env"), "P=1");
    const addonX = mk(P, "c3", "addon"); const sharedEnv = mk(P, "c3", "envdir");
    writeFileSync(join(sharedEnv, "rocm.env"), "R=1");
    symlinkSync(join(sharedEnv, "rocm.env"), join(addonX, ".env"));
    record("C3: .env files in bound dirs and in the checkout's bundles are masked; a symlinked .env masks its bound target", () => buildContainPlan(base({ appRoot: appX, mcpServers: [{ command: "node", cwd: addonX }], readPaths: [sharedEnv] })));

    writeFileSync(join(H, ".bashrc"), "");
    mk(H, ".local", "bin"); mk(H, ".config", "autostart");
    record("C9b: a policy write path into a hidden home entry is refused (rc files, PATH dirs, config)", () => buildContainPlan(base({ writePaths: [join(H, ".bashrc"), join(H, ".local", "bin"), join(H, ".config", "autostart"), out] })));

    writeFileSync(join(crowHome, "board-token"), "");
    record("instance secrets: read_paths covering CROW_HOME (tokens, secrets/, env/) are refused", () => buildContainPlan(base({ readPaths: [crowHome, join(crowHome, "secrets"), join(crowHome, "board-token")] })));

    const sh1 = mk(P, "c2", "shadow");
    writeFileSync(join(sh1, "settings.json"), JSON.stringify({ packages: ["pkg/superpowers", "../../pi-lab", "npm-name"] }));
    record("C2: pi packages outside the agent dir are bound read-only; one that cannot be bound refuses the spawn", () => buildContainPlan(base({ shadowAgentDir: sh1 })));
    const sh2 = mk(P, "c2", "shadow2");
    writeFileSync(join(sh2, "settings.json"), JSON.stringify({ packages: [join(H, ".ssh")] }));
    record("C2: pi packages outside the agent dir are bound read-only; one that cannot be bound refuses the spawn", () => buildContainPlan(base({ shadowAgentDir: sh2 })));
    const sh3 = mk(P, "c2", "shadow3");
    writeFileSync(join(sh3, "settings.json"), JSON.stringify({ packages: [join(H, "gone-pkg")] }));
    record("C2: pi packages outside the agent dir are bound read-only; one that cannot be bound refuses the spawn", () => buildContainPlan(base({ shadowAgentDir: sh3 })));

    record("C5: DNS stub dir bound when present", () => buildContainPlan(base()));

    const appY = mk(P, "deep", "app");
    mk(appY, "bundles", "x", "sub");
    writeFileSync(join(appY, "bundles", "x", "sub", ".env"), "S=1");
    mk(appY, "a", "b", "c", "d");
    writeFileSync(join(appY, "a", "b", "c", "d", ".env.production"), "S=1");
    mk(appY, "node_modules", "pkg"); writeFileSync(join(appY, "node_modules", "pkg", ".env"), "pkg-fixture");
    record(".env files are masked at any depth: nested project folders and bundles/x/sub/.env", () => buildContainPlan(base({ appRoot: appY })));

    const broot = mk(P, "broot", "bundles");
    for (const b of ["minio", "workspace"]) { mk(broot, b); writeFileSync(join(broot, b, ".env"), "P=1"); }
    mk(broot, "browser", "server"); writeFileSync(join(broot, "browser", "server", ".env.local"), "P=1");
    record("a bound path that is itself a bundles root has every bundle's .env masked", () => buildContainPlan(base({ readPaths: [broot] })));

    const big = mk(P, "big", "tree");
    for (let i = 0; i < 30; i++) writeFileSync(join(big, "f" + i), "");
    record("scan cap: a policy path too large to scan is not bound; an engine dir too large refuses the spawn", () => buildContainPlan(base({ readPaths: [big], envScanMaxEntries: 25 })));
    mk(P, "deep2", "a", "b", "c", "d");
    record("scan cap: a policy path too large to scan is not bound; an engine dir too large refuses the spawn", () => buildContainPlan(base({ readPaths: [join(P, "deep2")], envScanMaxDepth: 2 })));
    record("scan cap: a policy path too large to scan is not bound; an engine dir too large refuses the spawn", () => buildContainPlan(base({ envScanMaxEntries: 3 })));

    const CH = mk(P, "chome");
    const chData = mk(CH, "data");
    writeFileSync(join(chData, "crow.db"), "");
    mk(CH, "secrets");
    const withHome = base({ crowHome: CH, dataDir: chData, botCacheDir: mk(CH, "bot-cache") });
    const CROW_HOME_TITLE = "the Crow home is never a read-write bind, and a data folder that is the Crow home is refused";
    record(CROW_HOME_TITLE, () => buildContainPlan(withHome));
    for (const entry of [CH, dirname(CH), join(CH, "secrets")]) {
      record(CROW_HOME_TITLE, () => buildContainPlan({ ...withHome, writePaths: [entry] }));
    }
    record(CROW_HOME_TITLE, () => buildContainPlan({ ...withHome, writePaths: ["/"] }));
    for (const dataDir of [CH, P]) record(CROW_HOME_TITLE, () => buildContainPlan({ ...withHome, dataDir }));

    const realCo = mk(P, "co-house");
    mk(realCo, "secrets");
    const linkCo = join(H, ".crow-r4");
    symlinkSync(realCo, linkCo);
    const declared = mk(P, "srv", "crow-r5");
    mk(declared, "secrets");
    const CO_HOST_TITLE = "a co-hosted home is never bound: a symlinked one inside $HOME or a declared one outside it";
    const coCases = [
      [linkCo, {}],                        // the link path
      [realCo, {}],                        // its real path
      [declared, { otherHomes: [declared] }],
      [dirname(declared), { otherHomes: [declared] }], // an ancestor of it
    ];
    for (const [p, over] of coCases) {
      for (const list of ["readPaths", "writePaths"]) {
        record(CO_HOST_TITLE, () => buildContainPlan(base({ [list]: [p], ...over })));
      }
    }

    // ===== tests/pi-contain-agent.test.js =====
    // Its own scratch root, laid out as that file's module-level fixture.
    const A = join(root, "agent");
    const PORT = 3199;
    const SALT = "a".repeat(64);
    const CLOUD_KEY = "consent-checked-cloud-key";
    const crowHomeA = mk(A, "crowhome");
    const cloudTokenA = join(crowHomeA, "llm-cloud-token");
    writeFileSync(cloudTokenA, "cloud-door-token-value", { mode: 0o600 });
    const dataDirA = mk(crowHomeA, "data");
    writeFileSync(join(dataDirA, "crow.db"), "");
    const rolesFile = join(crowHomeA, "model-roles.json");
    writeFileSync(rolesFile, JSON.stringify({ roles: { everyday: "local-chat/m1" } }));

    const piAgentDirA = mk(A, "agent");
    writeFileSync(join(piAgentDirA, "settings.json"), JSON.stringify({ packages: ["pkg/pi-lab"], theme: "night" }));
    writeFileSync(join(piAgentDirA, "keybindings.json"), JSON.stringify({ "ctrl+k": "search" }));
    writeFileSync(join(piAgentDirA, "auth.json"), JSON.stringify({ openai: { key: "operator-login" } }));
    writeFileSync(join(piAgentDirA, "models-store.json"), JSON.stringify({ providers: {} }));
    writeFileSync(join(piAgentDirA, "models.json"), JSON.stringify({
      providers: { hand: { baseUrl: "http://192.168.200.9:1/v1", apiKey: "hand-written-literal", models: [{ id: "m" }] } },
    }));
    writeFileSync(join(piAgentDirA, "mcp.json"), JSON.stringify({
      mcpServers: { board: { url: "http://127.0.0.1:3001/board/mcp", headers: { Authorization: "Bearer board-literal" } } },
    }));
    mk(piAgentDirA, "pkg", "pi-lab");
    mk(piAgentDirA, "skills", "lab-maintenance");
    const outsideA = mk(A, "outside");
    writeFileSync(join(outsideA, "secret.txt"), "x");
    symlinkSync(join(outsideA, "secret.txt"), join(piAgentDirA, "linked.json"));

    const rows = [
      { id: "local-chat", baseUrl: "http://192.168.1.9:8011/v1", apiKey: "provider-literal-key", bundleId: "vllm-x",
        provider_type: "openai-compat", models: [{ id: "m1", contextWindow: 8192 }], gpuPolicy: null, disabled: false },
      { id: "native-owned", baseUrl: "http://127.0.0.1:18100/v1", apiKey: null, bundleId: null,
        provider_type: "openai-compat", models: [{ id: "m2" }], gpuPolicy: { runtime: "native" }, disabled: false },
      { id: "external-engine", baseUrl: "http://192.168.1.10:8022/v1", apiKey: "none", bundleId: null,
        provider_type: "openai-compat", models: [{ id: "m3" }], gpuPolicy: { engine: { managed: "external", host: "lab" } }, disabled: false },
      { id: "Cloud Max", baseUrl: "https://cloud.example.com/v1", apiKey: CLOUD_KEY, bundleId: null,
        provider_type: "openai-compat", models: [{ id: "c1" }], gpuPolicy: null, disabled: false },
      { id: "lan-plain", baseUrl: "http://192.168.1.11:8033/v1", apiKey: "none", bundleId: null,
        provider_type: "openai-compat", models: [{ id: "l1" }], gpuPolicy: null, disabled: false },
    ];
    const cloudRow = rows.find((r) => r.id === "Cloud Max");
    const consent = {
      [cloudRow.id]: {
        target: normalizeBaseUrl(cloudRow.baseUrl),
        keyFp: createHmac("sha256", Buffer.from(SALT, "hex")).update(CLOUD_KEY.trim()).digest("hex").slice(0, 16),
        at: "2026-11-02T00:00:00Z",
        by: "operator",
      },
    };
    const NEEDED = ["local-chat", "native-owned", "external-engine", "Cloud Max", "crow-c-Cloud Max"];

    // The agent test builds its generated dir (buildContainedAgentDir) first and
    // passes the cloud-door token path it returns into the plan.
    let shadowSeq = 0;
    const agentBuild = (over = {}) => {
      const dir = mk(A, "shadow-" + (++shadowSeq));
      const res = buildContainedAgentDir({
        piAgentDir: piAgentDirA, dir, providerIds: NEEDED, rows, consent, consentSalt: SALT,
        gatewayPort: PORT, cloudTokenPath: cloudTokenA, modelRolesFile: rolesFile, ...over,
      });
      return { dir, res };
    };

    const TOKEN_TITLE = "the contain plan binds the cloud-door token file alone, read-only";
    record(TOKEN_TITLE, () => {
      mk(A, "session");
      return buildContainPlan({ home: A, crowHome: crowHomeA, dataDir: dataDirA, cloudTokenPath: cloudTokenA,
        sessionDir: join(A, "session"), cwd: join(A, "session") });
    });

    const TOKEN_ONLY_TITLE = "the cloud-door token is bound only when a consented /llm/c entry was generated";
    const plain = agentBuild({ providerIds: ["local-chat"] }).res;
    record(TOKEN_ONLY_TITLE, () => {
      mk(A, "session-plain");
      return buildContainPlan({ home: A, crowHome: crowHomeA, dataDir: dataDirA, cloudTokenPath: plain.cloudTokenPath,
        sessionDir: join(A, "session-plain"), cwd: join(A, "session-plain") });
    });
    const withCloud = agentBuild().res;
    record(TOKEN_ONLY_TITLE, () => {
      mk(A, "session-cloud");
      return buildContainPlan({ home: A, crowHome: crowHomeA, dataDir: dataDirA, cloudTokenPath: withCloud.cloudTokenPath,
        sessionDir: join(A, "session-cloud"), cwd: join(A, "session-cloud") });
    });

    const realHomeA = mk(A, "tokenhome-real");
    const realTokenA = join(realHomeA, "llm-cloud-token");
    writeFileSync(realTokenA, "cloud-door-token-value", { mode: 0o600 });
    const linkHomeA = join(A, "tokenhome-link");
    symlinkSync(realHomeA, linkHomeA);
    const linked = agentBuild({ cloudTokenPath: join(linkHomeA, "llm-cloud-token") }).res;
    const sessionLink = mk(A, "session-link");
    record("a symlinked CROW_HOME: the bound token and the !cat path are the same resolved file", () => buildContainPlan({
      home: A, crowHome: crowHomeA, dataDir: dataDirA, cloudTokenPath: linked.cloudTokenPath,
      sessionDir: sessionLink, cwd: sessionLink,
    }));

    // "the cloud-door token path matches the gateway's own llmCloudTokenPath()",
    // "a source settings.json that is itself a symlink ..." and
    // "a cloud token swapped for a symlink is never bound ..." call no plan builder.
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  return normalise(cases, { root });
}

// ---- egress transcripts --------------------------------------------------

/** An own-host view with no addresses (the seam every CONNECT test in the
 *  egress test file pins). */
const NO_LOCAL = { v4: [], v6: [], v4Failed: false, v6Failed: false };
/** The global-unicast fixture address the egress tests have always used. */
const PUB = "93.184.216.34";
/** The egress test file's own-view helper for the on-link tests. */
const view = (v = {}) => ({ v4: [], v6: [], onLink4: [], onLink6: [], v4Failed: false, v6Failed: false, onLinkFailed: false, ...v });

/**
 * One transcript per tests/pi-egress.test.js test that talks to a relay
 * socket: `{ name, exchanges: [{sent, received}], logs }`.
 *
 * SKIPPED, because the outcome is the machine's clock or its kernel, not the
 * relay's bytes:
 *   - "PROXY: only CONNECT; an oversize or unterminated head is refused" —
 *     the unterminated-head exchange is decided by the relay's 300 ms head
 *     timeout racing the recorder's window.
 *   - "connection cap per spawn, one log line per (decision, host)" —
 *     connection-cap timing (sleeps between connections decide it).
 *   - "a client that leaves during the DNS lookup opens no upstream
 *     connection" — the DNS-lookup race (a 300 ms lookup seam, a 600 ms wait).
 *   - "decision logging is bounded: distinct-host spraying cannot grow the
 *     spawner's memory" — 1010 sequential connections, each bounded by a
 *     wall-clock timeout.
 *   - "odd IPv4 spellings (octal, short) go through the real resolver and are
 *     refused once resolved" — this machine's real DNS resolver.
 *   - "the real kernel reader on this host" — this host's kernel tables
 *     (readLocalTable with no seam); it opens no relay socket anyway.
 * Every other test in that file sends no bytes to a relay socket: they are
 * pure predicate and readLocalTable assertions, or file-mode checks, so there
 * is no transcript to record.
 *
 * @returns {Promise<Array<{name: string, exchanges: Array<{sent: string, received: string}>, logs: string[]}>>}
 */
export async function buildEgressTranscripts() {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "crow-bot-golden-egress-")));
  const cases = [];
  const servers = [];
  const relays = [];
  const ports = new Map(); // port -> "<UPn>", in creation order
  let portSeq = 0;
  let relaySeq = 0;

  const notePort = (port) => { if (!ports.has(port)) ports.set(port, "<UP" + (++portSeq) + ">"); };

  /** A loopback echo upstream (the egress test file's echoServer). */
  const echoServer = (tag = "") => new Promise((resolve) => {
    const live = new Set();
    const srv = createNetServer((c) => {
      live.add(c); c.on("close", () => live.delete(c));
      c.on("data", (d) => c.write(tag + d.toString()));
    });
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      notePort(port);
      servers.push(() => {
        for (const c of live) { try { c.destroy(); } catch {} }
        return new Promise((r) => srv.close(() => r()));
      });
      resolve(port);
    });
  });

  /** An HTTP upstream standing in for the gateway (the egress test file's httpServer). */
  const httpServer = (tag = "OK") => new Promise((resolve) => {
    const srv = createHttpServer((req, res) => {
      if (req.url === "/llm/v1/big") { res.writeHead(200, { "content-length": 200000 }); res.end("y".repeat(200000)); return; }
      res.writeHead(200, { "content-type": "text/plain", "content-length": Buffer.byteLength(tag) });
      res.end(tag);
    });
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      notePort(port);
      servers.push(() => {
        try { srv.closeAllConnections?.(); } catch {}
        return new Promise((r) => srv.close(() => r()));
      });
      resolve(port);
    });
  });

  /** Start a relay exactly as the test file's relay() helper does. */
  const relay = async (logs, opts = {}) => {
    const r = await startEgressRelay({
      dir: join(scratch, "r" + (++relaySeq)), botId: "bot-x", log: (l) => logs.push(l),
      local: NO_LOCAL, denyNets: [], ...opts,
    });
    relays.push(r);
    return r;
  };

  /**
   * The test file's talk(), made deterministic: bytes are collected until the
   * peer closes, or until `settle` ms pass with no further bytes (a tunnel
   * stays open, so its reply is complete only after that quiet window).
   */
  const exchange = (sockPath, first, then = null, { end = false, timeout = 1500, settle = 250 } = {}) => new Promise((resolve) => {
    const c = connect({ path: sockPath, allowHalfOpen: end });
    let received = "";
    let sent = first;
    let followUp = false;
    let done = false;
    let settleTimer = null;
    let cap = null;
    const finish = () => {
      if (done) return;
      done = true;
      if (settleTimer) clearTimeout(settleTimer);
      if (cap) clearTimeout(cap);
      try { c.destroy(); } catch {}
      resolve({ sent, received });
    };
    cap = setTimeout(finish, timeout);
    const armSettle = () => {
      if (done || settle <= 0) return;
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = setTimeout(finish, settle);
    };
    c.on("connect", () => {
      try { c.write(first); } catch {}
      if (end) { try { c.end(); } catch {} }
    });
    c.on("data", (d) => {
      received += d.toString();
      if (then && !followUp && /\r\n\r\n/.test(received)) {
        followUp = true;
        sent += then;
        try { c.write(then); } catch {}
      }
      armSettle();
    });
    c.on("end", finish);
    c.on("error", finish);
    c.on("close", finish);
  });

  try {
    // ---- "public allowed"
    {
      const logs = [];
      const up = await echoServer("U:");
      const r1 = await relay(logs, { lookup: async () => [{ address: PUB, family: 4 }],
        _connectOverride: () => ({ host: "127.0.0.1", port: up }) });
      const exchanges = [await exchange(r1.socketPath, "PROXY\nCONNECT api.example.com:443 HTTP/1.1\r\nHost: api.example.com:443\r\n\r\n", "ping")];
      const mixed = await relay(logs, { lookup: async () => [{ address: PUB, family: 4 }, { address: "10.1.2.3", family: 4 }] });
      exchanges.push(await exchange(mixed.socketPath, "PROXY\nCONNECT a.example.com:443 HTTP/1.1\r\n\r\n"));
      cases.push({ name: "public allowed", exchanges, logs });
    }

    // ---- "own public address refused"
    {
      const logs = [];
      const own = "93.184.216.99";
      const local = { v4: [own + "/32"], v6: [], v4Failed: false, v6Failed: false };
      const r = await relay(logs, { local, lookup: async () => [{ address: own, family: 4 }] });
      const exchanges = [await exchange(r.socketPath, "PROXY\nCONNECT own.example.com:443 HTTP/1.1\r\n\r\n")];
      cases.push({ name: "own public address refused", exchanges, logs });
    }

    // ---- "unreadable local table fails closed"
    {
      const logs = [];
      const t = { v4: [], v6: [], onLink4: [], onLink6: [], v4Failed: true, v6Failed: true, onLinkFailed: true };
      const r = await relay(logs, { local: t, lookup: async () => [{ address: PUB, family: 4 }] });
      const exchanges = [
        await exchange(r.socketPath, "PROXY\nCONNECT a.example.com:443 HTTP/1.1\r\n\r\n"),
        await exchange(r.socketPath, "PROXY\nCONNECT [2606:4700:4700::1111]:443 HTTP/1.1\r\n\r\n"),
      ];
      const v6bad = { v4: ["127.0.0.1"], v6: [], v4Failed: false, v6Failed: true };
      const up = await echoServer("U:");
      const r6 = await relay(logs, { local: v6bad, lookup: async () => [{ address: PUB, family: 4 }],
        _connectOverride: () => ({ host: "127.0.0.1", port: up }) });
      exchanges.push(await exchange(r6.socketPath, "PROXY\nCONNECT a.example.com:443 HTTP/1.1\r\n\r\n", "ping"));
      exchanges.push(await exchange(r6.socketPath, "PROXY\nCONNECT [2606:4700:4700::1111]:443 HTTP/1.1\r\n\r\n"));
      cases.push({ name: "unreadable local table fails closed", exchanges, logs });
    }

    // ---- "PORT: the gateway port is served over the doors, and any other loopback port is refused"
    {
      const logs = [];
      const gw = await httpServer("OK");
      const other = await echoServer("B:");
      const r = await relay(logs, { gatewayPort: gw });
      const exchanges = [
        await exchange(r.socketPath, `PORT ${gw}\nGET /llm/v1/models HTTP/1.1\r\nHost: x\r\n\r\n`),
        await exchange(r.socketPath, `PORT ${gw}\nGET /internal/actor-sign HTTP/1.1\r\nHost: x\r\n\r\n`),
        await exchange(r.socketPath, `PORT ${other}\nhello`),
      ];
      cases.push({ name: "PORT: the gateway port is served over the doors, and any other loopback port is refused", exchanges, logs });
    }

    // ---- "PROXY CONNECT: a public host (via the lookup seam) is allowed and tunnelled; the response is 200"
    {
      const logs = [];
      const up = await echoServer("U:");
      const r = await relay(logs, { lookup: async () => [{ address: PUB, family: 4 }],
        _connectOverride: () => ({ host: "127.0.0.1", port: up }), egressPorts: [443] });
      const exchanges = [await exchange(r.socketPath, "PROXY\nCONNECT api.example.com:443 HTTP/1.1\r\nHost: api.example.com:443\r\n\r\n", "ping")];
      cases.push({ name: "PROXY CONNECT: a public host (via the lookup seam) is allowed and tunnelled; the response is 200", exchanges, logs });
    }

    // ---- "PROXY CONNECT: a rebinding name, a refused literal, a disallowed port and a host off the list are refused"
    {
      const logs = [];
      const exchanges = [];
      const rebinding = await relay(logs, { lookup: async () => [{ address: PUB, family: 4 }, { address: "127.0.0.1", family: 4 }], egressPorts: [443] });
      exchanges.push(await exchange(rebinding.socketPath, "PROXY\nCONNECT a.example.com:443 HTTP/1.1\r\n\r\n"));
      const lit = await relay(logs, { lookup: async () => { throw new Error("no lookup for literals"); }, egressPorts: [443] });
      for (const target of ["127.0.0.1:443", "[::1]:443", "10.20.30.40:443", "169.254.169.254:443", "[::ffff:127.0.0.1]:443", "100.64.20.5:443"]) {
        exchanges.push(await exchange(lit.socketPath, `PROXY\nCONNECT ${target} HTTP/1.1\r\n\r\n`));
      }
      const pub = await relay(logs, { lookup: async () => [{ address: PUB, family: 4 }], egressPorts: [443] });
      exchanges.push(await exchange(pub.socketPath, "PROXY\nCONNECT a.example.com:22 HTTP/1.1\r\n\r\n"));
      const listed = await relay(logs, { lookup: async () => [{ address: PUB, family: 4 }], egressPorts: [443], egressAllow: ["api.example.com"] });
      exchanges.push(await exchange(listed.socketPath, "PROXY\nCONNECT other.example.com:443 HTTP/1.1\r\n\r\n"));
      const listedLan = await relay(logs, { lookup: async () => [{ address: "192.168.1.20", family: 4 }], egressPorts: [443], egressAllow: ["api.example.com"] });
      exchanges.push(await exchange(listedLan.socketPath, "PROXY\nCONNECT nas.home.arpa:443 HTTP/1.1\r\n\r\n"));
      cases.push({ name: "PROXY CONNECT: a rebinding name, a refused literal, a disallowed port and a host off the list are refused", exchanges, logs });
    }

    // ---- "half-close: a client that sends FIN and waits still gets the whole reply"
    // A fixed body, collected until the server closes: no quiet-window settle.
    {
      const logs = [];
      const gw = await httpServer("OK");
      const r = await relay(logs, { gatewayPort: gw });
      const exchanges = [await exchange(r.socketPath,
        `PORT ${gw}\nGET /llm/v1/big HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`, null,
        { end: true, timeout: 3000, settle: 0 })];
      cases.push({ name: "half-close: a client that sends FIN and waits still gets the whole reply", exchanges, logs });
    }

    // ---- "every checked address is tried in order (a dual-stack host whose first address has no route)"
    {
      const logs = [];
      const up = await echoServer("U:");
      const r = await relay(logs, { lookup: async () => [{ address: "2606:4700:4700::1111", family: 6 }, { address: PUB, family: 4 }],
        _connectOverride: (addr) => (addr.includes(":") ? { host: "127.0.0.1", port: 1 } : { host: "127.0.0.1", port: up }) });
      const exchanges = [await exchange(r.socketPath, "PROXY\nCONNECT a.example.com:443 HTTP/1.1\r\n\r\n", "ping")];
      cases.push({ name: "every checked address is tried in order (a dual-stack host whose first address has no route)", exchanges, logs });
    }

    // ---- "port 80 is not proxied by default (CONNECT is for TLS)"
    {
      const logs = [];
      const r = await relay(logs, { lookup: async () => [{ address: PUB, family: 4 }] });
      const exchanges = [await exchange(r.socketPath, "PROXY\nCONNECT a.example.com:80 HTTP/1.1\r\n\r\n")];
      cases.push({ name: "port 80 is not proxied by default (CONNECT is for TLS)", exchanges, logs });
    }

    // ---- "a narrowed egress list cannot be bypassed with an IP literal in any IPv6 form of a private address"
    {
      const logs = [];
      const r = await relay(logs, { lookup: async () => [], egressAllow: ["api.example.com"], hostAddrs: [] });
      const exchanges = [];
      for (const lit of ["192.168.1.20", "[::ffff:192.168.1.20]", "[::ffff:0:c0a8:114]", "[64:ff9b::c0a8:114]", "[2002:c0a8:114::1]"]) {
        exchanges.push(await exchange(r.socketPath, `PROXY\nCONNECT ${lit}:443 HTTP/1.1\r\n\r\n`));
      }
      cases.push({ name: "a narrowed egress list cannot be bypassed with an IP literal in any IPv6 form of a private address", exchanges, logs });
    }

    // ---- "operator-listed extra refused networks (e.g. Kubernetes ClusterIP ranges) are refused"
    {
      const logs = [];
      const r = await relay(logs, { lookup: async () => [{ address: "10.43.0.10", family: 4 }], denyNets: ["10.43.0.0/16"] });
      const exchanges = [await exchange(r.socketPath, "PROXY\nCONNECT svc.cluster.local:443 HTTP/1.1\r\n\r\n")];
      cases.push({ name: "operator-listed extra refused networks (e.g. Kubernetes ClusterIP ranges) are refused", exchanges, logs });
    }

    // ---- "an unreadable operator deny entry refuses EVERY destination (public too), and a match says operator-denied"
    {
      const logs = [];
      const r = await relay(logs, { lookup: async () => [{ address: PUB, family: 4 }], denyNets: ["nope"] });
      const exchanges = [await exchange(r.socketPath, "PROXY\nCONNECT a.example.com:443 HTTP/1.1\r\n\r\n")];
      cases.push({ name: "an unreadable operator deny entry refuses EVERY destination (public too), and a match says operator-denied", exchanges, logs });
    }

    // ---- "a LAN neighbour's global IPv6 address is refused (on-link /64)"
    {
      const logs = [];
      const local = view({ v6: ["2001:db9:10:20::5/128"], onLink6: ["2001:db9:10:20::/64"] });
      const r = await relay(logs, { local, lookup: async () => [{ address: "2001:db9:10:20::f2b1", family: 6 }] });
      const exchanges = [await exchange(r.socketPath, "PROXY\nCONNECT nas.example.com:443 HTTP/1.1\r\n\r\n")];
      cases.push({ name: "a LAN neighbour's global IPv6 address is refused (on-link /64)", exchanges, logs });
    }

    // ---- "with no gateway port every PORT line is refused"
    {
      const logs = [];
      const r = await relay(logs, {});
      const exchanges = [];
      for (const port of [0, 80, 443, 3001]) {
        exchanges.push(await exchange(r.socketPath, `PORT ${port}\nGET /llm/v1/models HTTP/1.1\r\nHost: x\r\n\r\n`));
      }
      cases.push({ name: "with no gateway port every PORT line is refused", exchanges, logs });
    }
  } finally {
    for (const close of servers) { try { await close(); } catch {} }
    for (const r of relays) { try { await r.close(); } catch {} }
    rmSync(scratch, { recursive: true, force: true });
  }

  return normalise(cases, { root: scratch, ports });
}