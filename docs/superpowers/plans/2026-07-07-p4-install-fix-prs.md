# P4 Install-Fix PRs Implementation Plan (PR-INSTALL-A + PR-INSTALL-B)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the CRITICAL/MAJOR fresh-install defects from the P4 audit (`.superpowers/messages-plan/p4-findings.md`) so the documented `curl | bash` appliance install produces a *booted, reachable, correctly-scoped* Crow on the first try — as two independent PRs.

**Architecture:** PR-INSTALL-A hardens `scripts/crow-install.sh` (prompt safety, SIGPIPE-safe pipelines, destructive-rename defaults, systemd restart policy, Tailscale Serve wiring, cloud-scoped 443). PR-INSTALL-B makes first boot viable in product code (never-crash OAuth issuer resolution, host-local gating in the GPU orchestrator, headless local-MCP-token mint). Neither PR depends on the other; PR-A merges first, PR-B rebases over it (both touch `crow-install.sh`, disjoint regions except the final "What's next" echo).

**Tech Stack:** bash (installer), Node ESM (gateway), node built-in test runner (`node --test tests/<file>.test.js`).

## Global Constraints

- **BLACK-SWAN IS PRISTINE** — no deploys, restarts, installs, or wizard completion on black-swan. Installer changes are verified by `bash -n`, shellcheck (if installed, skip gracefully), the sourcing-harness tests below, and review — NEVER by re-running on black-swan. (Verified: crow-install.sh creates no auto-update timer, so merging to main cannot reach black-swan.)
- **Commit discipline:** `git commit <path> …` positional paths only; `git pull --rebase` before push; NEVER attribute Claude as co-author.
- **F-INSTALL-8 fix must not disturb existing installs:** crow/grackle/MPA/black-swan all set `CROW_GATEWAY_URL` to a valid HTTPS URL via systemd drop-ins → the resolver must return that URL byte-identical (non-degraded path).
- **fix-the-product-not-the-instance:** every fix must work on a fresh single-click install.
- Tests: node built-in runner only. There is NO `npm test` script (R1-C3) — the full-suite command is `node --test tests/*.test.js`; re-baseline the pass count with that exact command on `main` before branching (memory-anchor "1183/1183" came from prior sessions running it).
- Check-runs gate: GitHub Actions check-runs API (not legacy commit-status). `check-ports` is path-filtered — these diffs don't touch bundle ports.
- Deploy after merge: crow (`git pull` + `sudo systemctl restart crow-gateway`), MPA (`sudo systemctl restart crow-mpa-gateway`), grackle (`git -C /home/kh0pp/crow pull`, restart `crow-mcp-bridge` THEN `crow-gateway`). Never black-swan.

## Findings → Tasks map

| Finding | Sev | Fix | Task |
|---|---|---|---|
| F-INSTALL-5 confirm prompt kills `curl\|bash` | S2-MAJOR | `/dev/tty`-reading `ask_yn` helper + `--yes`/`CROW_INSTALL_YES=1`; headless resolves to defaults | A1 |
| F-INSTALL-6 pipefail+`head`/`grep -q` SIGPIPE aborts Step 9 (also `echo y \| ufw enable`) | S2-MAJOR | capture `tailscale status --json` ONCE into a var, bash-regex extraction, zero pipes; `ufw --force enable` | A2 |
| F-INSTALL-7 unattended default RENAMES tailscale hostname to 'crow' | S1-CRITICAL (latent) | rename prompts default **N**; headless never renames; collision check SIGPIPE-safe | A2 |
| F-INSTALL-11 OS hostname renamed to 'crow' | S3-MINOR | same default-N treatment; Caddy vhost follows the *actual* hostname | A3 |
| F-INSTALL-9 `Restart=unless-stopped` invalid systemd | S2-MINOR | `Restart=on-failure` | A3 |
| F-INSTALL-1 installer never wires Tailscale Serve | S1-CRITICAL | offer Serve wiring (default Y) + write `CROW_GATEWAY_URL=https://<MagicDNS>` into `~/.crow/.env` + restart gateway | A4 |
| F-INSTALL-2 443 open to Anywhere on cloud VPS | S2-MAJOR | 443 prompt; cloud-metadata heuristic flips default to N + warning | A4 |
| F-INSTALL-8 fresh gateway DEAD ON ARRIVAL ("Issuer URL must be HTTPS") | S1-CRITICAL | `resolveIssuerUrl()` — valid HTTPS/localhost passes through untouched; anything the SDK would reject degrades to `http://localhost:<port>` + loud actionable warn; try/catch belt on the OAuth mounts | B1, B2 |
| F-INSTALL-10 fresh install orchestrates hardcoded 'grackle-embed' CUDA bundle | S2-MAJOR | `isLocallyOrchestratable()` PHYSICAL gate (baseUrl is loopback or an own-interface IP) on `alwaysResidentProviders`, `acquireProvider`, `resolveWarmableProviderName`, sibling-stop; `host` column is NOT trusted (R1-C1/C2: the fleet data violates its invariant) | B3 |
| F-INSTALL-3 no local MCP token minted at setup | S2 | headless `npm run local-token` (mint/rotate via `generateLocalToken`, one-time print); installer "What's next" pointer. Interactive path already exists (Connect panel one-time reveal + onboarding deep-link) | B4 |

Out of scope (stay findings / post-arc theme): F-INSTALL-4 (UFW tailnet-3001 — superseded by Serve wiring, raw :3001 not needed), F-CONTACT-1/-2, F-ONBOARD-1 (verdict pending Kevin's S3), full models.json generalization (post-arc `crow-generalization-and-install-ease-gaps`).

## Key code facts (verified in-repo 2026-07-07)

- SDK check: `node_modules/@modelcontextprotocol/sdk/dist/esm/server/auth/router.js:13` — throws unless `protocol === "https:"` OR hostname `localhost`/`127.0.0.1` OR `MCP_DANGEROUSLY_ALLOW_INSECURE_ISSUER_URL`; also throws on hash/search. Called by BOTH `mcpAuthRouter` and `createOAuthMetadata`.
- `servers/gateway/index.js:394-420` — `publicUrl = CROW_GATEWAY_URL || RENDER_EXTERNAL_URL`; fallback `new URL("http://${BIND}:${PORT}")` with `BIND` default `0.0.0.0` → always throws on fresh installs.
- `servers/gateway/gpu-orchestrator.js:207` — `maybeAcquireLocalProvider` has the host gate; `alwaysResidentProviders()` (line 156), `acquireProvider()` (line 266), and `resolveWarmableProviderName()` direct-`bundleId` path (line 229, checks bundleId BEFORE host) do NOT.
- `servers/shared/providers-db.js` DOCUMENTS a host invariant (`"local"` | `<peer instance-id>` | `"cloud"`) but the LIVE FLEET DATA VIOLATES IT (verified 2026-07-07, R1-C1/C2): grackle's own DB stores `grackle-embed` with `host='grackle-5fc01ac74463b6f4'` — a hand-written models.json label matching NO `crow_instances` id (grackle's real instance-id is `49cf71ca…`) — and stores crow's providers as `host='local'` ON GRACKLE (the providers table syncs fleet-wide with crow's perspective baked in). Grackle keeps its own embed resident today ONLY because `alwaysResidentProviders()` has no gate. Consequently NO host-string gate can be correct: `host==='local'` breaks grackle's embed (C1), and it also passes crow's `host:"local"`-tagged bundles on a fresh install (C2). The gate must use PHYSICAL truth: baseUrl hostname is loopback/localhost or one of this machine's own interface IPs. models.json baseUrls verified: `crow-*` → `100.118.41.122` (crow's IP), `grackle-*` → `100.121.254.89` (grackle's IP), `crow-llm` → `localhost:3001` but `bundleId:null` (already excluded). On a fresh install NOTHING matches the machine's own interfaces → zero bundles attempted (C2 closed, not just rescoped).
- `servers/gateway/local-token.js` — `generateLocalToken(db)` stores sha256 only (local-scoped setting), returns raw once. Connect panel (`dashboard/panels/connect.js:168`) already generates/rotates with one-time reveal; onboarding "connect" step deep-links to it.
- Installer pipe audit (complete): line 62 `read -p` (F-5); 82 `node --version | cut | cut` SAFE (cut reads all); 118-119 `curl | gpg` / `curl | tee` SAFE; **242 `echo "y" | sudo ufw enable` UNSAFE** (ufw may not read stdin → SIGPIPE on echo → pipefail+set-e abort); 276 `… | grep -o | head -1 | cut` UNSAFE (F-6); 282 `… | grep -q` UNSAFE-false-negative (F-7); 342 `seq` SAFE; 382 `grep -q file` SAFE (if-condition, no pipe).

---

# PR-INSTALL-A — `scripts/crow-install.sh` hardening

**Branch:** `fix/p4-install-hardening` off `main`.
**Files:** Modify `scripts/crow-install.sh`; Create `tests/crow-install-script.test.js`.

### Task A1: Prompt helpers (`ask_yn`/`ask_line`), `--yes`, source-only test seam; migrate the Continue confirm (F-INSTALL-5)

**Files:**
- Modify: `scripts/crow-install.sh` (insert helper block after the color/log helpers at line ~36; replace the confirm block at lines 62-67)
- Create: `tests/crow-install-script.test.js`

**Interfaces:**
- Produces (bash, used by every later task): `ask_yn <prompt> <Y|N>` → exit 0=yes/1=no; `ask_line <prompt>` → prints reply or empty; globals `ASSUME_YES`, `HAS_TTY`; env seam `CROW_INSTALL_SOURCE_ONLY=1` stops execution right after the helpers (lets tests source them).
- Produces (test): `sourceHelpers(bashSnippet)` harness in the test file that later tasks' tests reuse.

- [ ] **Step 1: Write the failing test**

Create `tests/crow-install-script.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SCRIPT = resolve(import.meta.dirname, "..", "scripts", "crow-install.sh");
const src = () => readFileSync(SCRIPT, "utf-8");

/** Source the installer's helper layer (CROW_INSTALL_SOURCE_ONLY=1) and run a
 *  snippet against it. detached:true puts the child in a NEW SESSION with no
 *  controlling terminal, so the /dev/tty open-probe fails and the headless
 *  path is exercised even when the test runner itself sits on an interactive
 *  terminal (otherwise ask_yn would block on real keyboard input). */
function runWithHelpers(snippet, env = {}) {
  return spawnSync("bash", ["-c", `set -euo pipefail; CROW_INSTALL_SOURCE_ONLY=1 source "${SCRIPT}"; ${snippet}`], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...env },
    encoding: "utf-8",
    detached: true,
  });
}

test("bash -n: installer parses", () => {
  execFileSync("bash", ["-n", SCRIPT]);
});

test("shellcheck passes when available (skips otherwise)", (t) => {
  const which = spawnSync("shellcheck", ["--version"], { stdio: "ignore" });
  if (which.error) return t.skip("shellcheck not installed");
  // SC2154/SC1090/SC1091: sourced-file + installer-pattern noise; everything else must pass
  const r = spawnSync("shellcheck", ["-e", "SC1090,SC1091", SCRIPT], { encoding: "utf-8" });
  assert.equal(r.status, 0, r.stdout);
});

test("F-5: headless ask_yn resolves to its default (Y and N)", () => {
  const y = runWithHelpers(`if ask_yn "Continue?" Y; then echo YES; else echo NO; fi`);
  assert.equal(y.status, 0, y.stderr);
  assert.match(y.stdout, /YES/);
  const n = runWithHelpers(`if ask_yn "Rename?" N; then echo YES; else echo NO; fi`);
  assert.equal(n.status, 0, n.stderr);
  assert.match(n.stdout, /NO/);
});

test("F-5: CROW_INSTALL_YES=1 forces defaults without a tty", () => {
  const r = runWithHelpers(`if ask_yn "Continue?" Y; then echo YES; fi; if ask_yn "Rename?" N; then echo BAD; else echo SKIPPED; fi`, { CROW_INSTALL_YES: "1" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /YES/);
  assert.match(r.stdout, /SKIPPED/);
});

test("F-5: ask_line returns empty headlessly instead of failing under set -e", () => {
  const r = runWithHelpers(`v="$(ask_line "name: ")"; echo "got:[\${v}]"`);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /got:\[\]/);
});

// EXECUTION NOTE: the "no raw read -p remains" end-state pin CANNOT land in A1
// (Tasks A2-A3 still own the other read -p sites) — it is added in Task A4,
// after every prompt is migrated. (Sequencing slip found live during SDD.)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/crow-install-script.test.js`
Expected: FAIL — `ask_yn: command not found` (source seam missing) and `read -p` still present.

- [ ] **Step 3: Implement the helper layer**

In `scripts/crow-install.sh`, insert AFTER the `header()` definition (line ~36) and BEFORE the root check:

```bash
# ─── Prompt helpers (F-INSTALL-5/-7) ──────────────────────
# The documented `curl … | bash` one-liner has no usable stdin (the script
# body IS stdin), so prompts read /dev/tty when a terminal exists and resolve
# to their DEFAULT when it does not (headless / cloud-init / CI).
# `--yes` / `-y` / CROW_INSTALL_YES=1 forces defaults everywhere.
ASSUME_YES=false
for _arg in "$@"; do
  case "$_arg" in
    -y|--yes) ASSUME_YES=true ;;
  esac
done
if [ "${CROW_INSTALL_YES:-}" = "1" ]; then ASSUME_YES=true; fi

# Real tty detection (R1-I1): [ -r /dev/tty ] only tests the device node's
# permission bits and is TRUE even with no controlling terminal. Actually
# opening it is the reliable probe (fails with ENXIO when headless), and it
# keeps genuinely-headless installs from spraying /dev/tty errors into logs.
HAS_TTY=false
if { exec 3</dev/tty; } 2>/dev/null; then
  exec 3<&-
  HAS_TTY=true
fi

# ask_yn <prompt> <default Y|N> — 0=yes, 1=no. Headless/--yes → default.
ask_yn() {
  local prompt="$1" default="$2" reply=""
  if [ "$ASSUME_YES" = true ] || [ "$HAS_TTY" = false ]; then
    [ "$default" = "Y" ] && return 0 || return 1
  fi
  if [ "$default" = "Y" ]; then
    printf "  %s [Y/n] " "$prompt" > /dev/tty
  else
    printf "  %s [y/N] " "$prompt" > /dev/tty
  fi
  IFS= read -r reply < /dev/tty || reply=""
  case "$reply" in
    [Yy]*) return 0 ;;
    [Nn]*) return 1 ;;
    *) [ "$default" = "Y" ] && return 0 || return 1 ;;
  esac
}

# ask_line <prompt> — prints the reply; empty when headless/--yes/EOF.
ask_line() {
  local prompt="$1" reply=""
  if [ "$ASSUME_YES" = true ] || [ "$HAS_TTY" = false ]; then
    return 0
  fi
  printf "  %s" "$prompt" > /dev/tty
  IFS= read -r reply < /dev/tty || reply=""
  printf "%s" "$reply"
}

# Test seam: tests source the helpers without executing the install.
if [ "${CROW_INSTALL_SOURCE_ONLY:-}" = "1" ]; then
  return 0 2>/dev/null || exit 0
fi
```

Replace the confirm block (old lines 62-67):

```bash
read -p "  Continue? [Y/n] " -n 1 -r
echo
if [[ $REPLY =~ ^[Nn]$ ]]; then
  echo "  Cancelled."
  exit 0
fi
```

with:

```bash
if ! ask_yn "Continue?" Y; then
  echo "  Cancelled."
  exit 0
fi
```

Placement: the helper block + source-only seam go BEFORE the root/sudo checks (so tests can source the helpers as any user, in any environment); the root check stays immediately after the seam, unchanged.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/crow-install-script.test.js`
Expected: PASS (shellcheck test may skip).

- [ ] **Step 5: Commit**

```bash
git commit scripts/crow-install.sh tests/crow-install-script.test.js -m "fix(install): tty-safe prompts + --yes — the documented curl|bash one-liner no longer dies at the confirm (F-INSTALL-5)"
```

### Task A2: SIGPIPE-safe Step 9 + ufw enable; destructive tailscale rename defaults N (F-INSTALL-6, F-INSTALL-7)

**Files:**
- Modify: `scripts/crow-install.sh` (Step 8 ufw enable line ~242; Step 9 block lines ~268-327)
- Modify: `tests/crow-install-script.test.js` (append tests)

**Interfaces:**
- Consumes: `ask_yn`, `ask_line`, `HAS_TTY` from Task A1.
- Produces: `TS_JSON` (captured once), `CURRENT_TS_HOSTNAME`, `TS_DNSNAME` (empty-safe) — Task A4's Serve wiring reads `TS_JSON`/`TS_DNSNAME`.

- [ ] **Step 1: Write the failing tests** (append to `tests/crow-install-script.test.js`)

```js
test("F-6: no pipeline consumes `tailscale status --json` (captured into TS_JSON instead)", () => {
  assert.doesNotMatch(src(), /tailscale status --json[^\n]*\|/);
  assert.match(src(), /TS_JSON=/);
});

test("F-6: no `| head` pipelines remain in the installer", () => {
  assert.doesNotMatch(src(), /\|\s*head\b/);
});

test("F-6: ufw enable is --force, not echo-piped", () => {
  assert.doesNotMatch(src(), /echo[^\n]*\|\s*sudo ufw enable/);
  assert.match(src(), /sudo ufw --force enable/);
});

test("F-7: tailscale rename prompt defaults N (never renames headlessly)", () => {
  assert.match(src(), /ask_yn "Set Tailscale hostname to 'crow'\?" N/);
});

test("F-6/F-7: helper extraction — first HostName in TS_JSON via bash regex, no pipes", () => {
  const fakeJson = JSON.stringify({ Self: { HostName: "black-swan", DNSName: "black-swan.tn.ts.net." }, Peer: { k: { HostName: "crow", DNSName: "crow.tn.ts.net." } } });
  const r = runWithHelpers(`TS_JSON='${fakeJson}'; ts_first_field HostName; echo; ts_first_field DNSName`);
  assert.equal(r.status, 0, r.stderr);
  const [host, dns] = r.stdout.trim().split("\n");
  assert.equal(host, "black-swan");
  assert.equal(dns, "black-swan.tn.ts.net.");
});
```

- [ ] **Step 2: Run to verify the new tests fail**

Run: `node --test tests/crow-install-script.test.js`
Expected: the five new tests FAIL (old pipelines still present, `ts_first_field` undefined).

- [ ] **Step 3: Implement**

(a) Add `ts_first_field` to the helper layer (before the source-only seam):

```bash
# ts_first_field <JsonKey> — first "<JsonKey>":"value" in $TS_JSON, no pipes
# (F-INSTALL-6: `… | grep | head` SIGPIPEs under pipefail on big tailnets).
# The first match is always the Self block (tailscale status --json emits
# Self before Peer).
ts_first_field() {
  local key="$1"
  # Whitespace-tolerant: real `tailscale status --json` is INDENTED
  # ("HostName": "crow" — space after the colon). Found live during SDD;
  # the original script's no-space grep never matched real output either.
  if [[ ${TS_JSON:-} =~ \"${key}\"[[:space:]]*:[[:space:]]*\"([^\"]*)\" ]]; then
    printf "%s" "${BASH_REMATCH[1]}"
  fi
}
```

(b) Replace `echo "y" | sudo ufw enable` (line ~242) with:

```bash
sudo ufw --force enable
```

(c) Replace the whole Step 9 tailscale-hostname body (inside `if tailscale status &>/dev/null; then`, old lines ~272-316) with:

```bash
    log "Tailscale is authenticated"

    # Capture status JSON ONCE — never pipe it (F-INSTALL-6).
    TS_JSON="$(tailscale status --json 2>/dev/null || true)"
    CURRENT_TS_HOSTNAME="$(ts_first_field HostName)"

    if [ "$CURRENT_TS_HOSTNAME" = "crow" ]; then
      log "Tailscale hostname is already set to 'crow'"
    elif [[ $TS_JSON =~ \"HostName\"[[:space:]]*:[[:space:]]*\"crow\" ]]; then
      warn "Tailscale hostname 'crow' is already taken by another device on your tailnet."
      TS_HOSTNAME="$(ask_line "Enter a Tailscale hostname (or press Enter to skip): ")"
      if [ -n "$TS_HOSTNAME" ]; then
        sudo tailscale set --hostname="$TS_HOSTNAME"
        log "Tailscale hostname set to '$TS_HOSTNAME'"
      else
        warn "Skipped Tailscale hostname setup"
      fi
    else
      # Destructive rename: default NO; headless installs never rename
      # (F-INSTALL-7 — the old default-Y renamed fresh nodes to 'crow').
      if ask_yn "Set Tailscale hostname to 'crow'?" N; then
        sudo tailscale set --hostname=crow
        log "Tailscale hostname set to 'crow'"
      else
        warn "Keeping Tailscale hostname '${CURRENT_TS_HOSTNAME:-unknown}'"
      fi
    fi
```

(Note: the `elif [[ … == *'"HostName":"crow"'* ]]` substring check would also match Self — unreachable because the first branch already handled Self=="crow".)

- [ ] **Step 4: Run tests**

Run: `node --test tests/crow-install-script.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git commit scripts/crow-install.sh tests/crow-install-script.test.js -m "fix(install): SIGPIPE-proof step 9 + ufw enable; tailscale rename defaults No (F-INSTALL-6, F-INSTALL-7)"
```

### Task A3: Restart=on-failure; OS hostname default-N; Caddy vhost follows actual hostname (F-INSTALL-9, F-INSTALL-11)

**Files:**
- Modify: `scripts/crow-install.sh` (Step 5 hostname block lines ~136-145; Step 7 unit `Restart=` + Caddyfile lines ~193-219; final message lines ~361-372)
- Modify: `tests/crow-install-script.test.js` (append)

**Interfaces:**
- Produces: `MDNS_HOST` global (e.g. `crow.local` or `black-swan.local`) — used by the Caddyfile, Step-8 prompt (Task A4), and the final message.

- [ ] **Step 1: Failing tests** (append)

```js
test("F-9: systemd unit uses Restart=on-failure (unless-stopped is Docker, not systemd)", () => {
  assert.match(src(), /Restart=on-failure/);
  assert.doesNotMatch(src(), /Restart=unless-stopped/);
});

test("R2-I1: unit ordering matches prod (gateway runs docker compose and keys residency on the tailscale IP)", () => {
  assert.match(src(), /After=network-online\.target docker\.service tailscaled\.service/);
  assert.match(src(), /Wants=network-online\.target/);
  assert.match(src(), /Requires=docker\.service/);
});

test("F-11: OS hostname rename prompt defaults N", () => {
  assert.match(src(), /ask_yn "Set hostname to 'crow' \(enables crow\.local\)\?" N/);
});

test("F-11: Caddy vhost and final URL follow the ACTUAL hostname (MDNS_HOST)", () => {
  assert.match(src(), /MDNS_HOST="\$\(hostname\)\.local"/);
  assert.match(src(), /\$\{MDNS_HOST\} \{/);          // Caddyfile vhost
  assert.match(src(), /https:\/\/\$\{MDNS_HOST\}\/setup/); // final message
});
```

- [ ] **Step 2: Run — expect the three new tests FAIL.**

- [ ] **Step 3: Implement**

(a) Step 5 hostname block (replace old lines 136-145):

```bash
CURRENT_HOSTNAME=$(hostname)
if [ "$CURRENT_HOSTNAME" != "crow" ]; then
  # Renaming the machine is destructive under automation (F-INSTALL-11):
  # default NO, headless never renames. When skipped, Caddy serves
  # <hostname>.local instead of crow.local (below).
  if ask_yn "Set hostname to 'crow' (enables crow.local)?" N; then
    sudo hostnamectl set-hostname crow
    log "Hostname set to 'crow' — accessible as crow.local on your network"
  else
    warn "Keeping hostname '$CURRENT_HOSTNAME' — Crow will be at https://${CURRENT_HOSTNAME}.local"
  fi
fi
MDNS_HOST="$(hostname).local"
```

(b) Unit file: change `Restart=unless-stopped` → `Restart=on-failure`, and replace the `[Unit]` section's `After=network.target` with the prod-parity ordering (R2-I1 — the gateway shells out to `docker compose` and the orchestrator keys residency on the tailscale IP, and `tailscaled.service` being absent is harmless: `After=` is ordering-only):

```
[Unit]
Description=Crow Gateway
Wants=network-online.target
After=network-online.target docker.service tailscaled.service
Requires=docker.service
```

(c) Caddyfile heredoc: change `<< 'EOF'` to `<< EOF` (enable expansion) and `crow.local {` → `${MDNS_HOST} {`. The body has no other `$`/backticks, so unquoting is safe.

(d) Final message: `https://crow.local/setup` → `https://${MDNS_HOST}/setup`; the Caddy log line `log "Caddy configured for https://crow.local"` → `log "Caddy configured for https://${MDNS_HOST}"`.

- [ ] **Step 4: Run tests — PASS.** Also `bash -n scripts/crow-install.sh`.

- [ ] **Step 5: Commit**

```bash
git commit scripts/crow-install.sh tests/crow-install-script.test.js -m "fix(install): Restart=on-failure; OS hostname rename opt-in; Caddy vhost follows actual hostname (F-INSTALL-9, F-INSTALL-11)"
```

### Task A4: Tailscale Serve wiring + CROW_GATEWAY_URL; cloud-scoped 443 (F-INSTALL-1, F-INSTALL-2)

**Files:**
- Modify: `scripts/crow-install.sh` (Step 8 443 rule lines ~238-243; Step 9 after the hostname logic; final message)
- Modify: `tests/crow-install-script.test.js` (append)

**Interfaces:**
- Consumes: `TS_JSON`, `ts_first_field`, `ask_yn`, `MDNS_HOST`.
- Produces: `GATEWAY_HTTPS_URL` (may be empty) — final message shows it when set. Writes `CROW_GATEWAY_URL` into `$CROW_HOME/.env` — this is the durable F-INSTALL-8 companion (PR-B makes the gateway boot even without it).

- [ ] **Step 1: Failing tests** (append)

```js
test("F-1: Serve wiring present — serve command + CROW_GATEWAY_URL write + gateway restart", () => {
  assert.match(src(), /tailscale serve --bg --https=443 http:\/\/127\.0\.0\.1:3001/);
  assert.match(src(), /CROW_GATEWAY_URL=\$\{GATEWAY_HTTPS_URL\}|CROW_GATEWAY_URL=%s/);
  assert.match(src(), /systemctl restart crow-gateway/);
});

test("F-2: 443 is prompted, with cloud-metadata heuristic flipping the default", () => {
  assert.match(src(), /169\.254\.169\.254/);
  assert.match(src(), /OPEN_443_DEFAULT/);
  // The bare unconditional allow must be gone:
  assert.doesNotMatch(src(), /^sudo ufw allow 443\/tcp/m);
});

test("F-5 end-state pin (deferred from A1): no raw read -p prompts remain anywhere", () => {
  assert.doesNotMatch(src(), /read -p/);
});
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement**

(a) Step 8 — replace `sudo ufw allow 443/tcp comment 'HTTPS (Caddy)'` with:

```bash
# 443 serves only Caddy's LAN vhost (https://${MDNS_HOST}); on a cloud VM
# that is an unintended PUBLIC surface (F-INSTALL-2). Cloud heuristic: the
# link-local metadata endpoint answers on AWS/Oracle/GCP/Azure/DO and never
# on home LANs. (Local-address checks don't work — Oracle NATs a private IP.)
IS_CLOUD_HOST=false
if curl -s -m 2 -o /dev/null http://169.254.169.254/ 2>/dev/null; then
  IS_CLOUD_HOST=true
fi
OPEN_443_DEFAULT=Y
if [ "$IS_CLOUD_HOST" = true ]; then
  OPEN_443_DEFAULT=N
  warn "Cloud/VPS environment detected — opening 443 would expose it to the internet."
fi
if ask_yn "Open port 443 for LAN access to https://${MDNS_HOST}?" "$OPEN_443_DEFAULT"; then
  sudo ufw allow 443/tcp comment 'HTTPS (Caddy)'
  log "Port 443 open (LAN HTTPS via Caddy)"
else
  warn "Port 443 closed — use Tailscale for remote access"
fi
```

Adjust the `log "Firewall enabled (SSH + HTTPS only)"` line to `log "Firewall enabled"` (443 is now conditional).

NOTE: `MDNS_HOST` is set in Step 5 which runs before Step 8 — but the 443 test regex above uses `^sudo ufw allow` anchored to line start; the new allow is indented inside the `if`, so the negative assertion holds.

(b) Step 9 — append AFTER the hostname if/else chain, still inside `if tailscale status &>/dev/null; then`:

```bash
    # ── F-INSTALL-1: wire Tailscale Serve so the dashboard is reachable over
    # the tailnet with real HTTPS (and the gateway gets an HTTPS issuer URL —
    # without it a cloud install has NO reachable dashboard at all).
    # Serve is tailnet-only; this never touches Funnel (public exposure).
    GATEWAY_HTTPS_URL=""
    TS_DNSNAME="$(ts_first_field DNSName)"
    TS_DNSNAME="${TS_DNSNAME%.}"   # strip trailing dot
    if [ -n "$TS_DNSNAME" ]; then
      if ask_yn "Serve the dashboard at https://${TS_DNSNAME}/ (tailnet-only, recommended)?" Y; then
        if sudo tailscale serve --bg --https=443 http://127.0.0.1:3001 >/dev/null 2>&1; then
          GATEWAY_HTTPS_URL="https://${TS_DNSNAME}"
          log "Tailscale Serve wired: ${GATEWAY_HTTPS_URL}/ → localhost:3001 (tailnet only)"
          if grep -q '^CROW_GATEWAY_URL=' "$CROW_HOME/.env" 2>/dev/null; then
            sed -i "s|^CROW_GATEWAY_URL=.*|CROW_GATEWAY_URL=${GATEWAY_HTTPS_URL}|" "$CROW_HOME/.env"
          else
            printf '\nCROW_GATEWAY_URL=%s\n' "$GATEWAY_HTTPS_URL" >> "$CROW_HOME/.env"
          fi
          sudo systemctl restart crow-gateway
          log "CROW_GATEWAY_URL=${GATEWAY_HTTPS_URL} written to $CROW_HOME/.env (gateway restarted)"
        else
          warn "tailscale serve failed — wire it later: sudo tailscale serve --bg --https=443 http://127.0.0.1:3001"
        fi
      else
        warn "Skipped Tailscale Serve — remote HTTPS access not configured"
      fi
    fi
```

(c) Final message — after the `https://${MDNS_HOST}/setup` line add:

```bash
if [ -n "${GATEWAY_HTTPS_URL:-}" ]; then
  echo "    ${GATEWAY_HTTPS_URL}/setup   (any device on your tailnet)"
fi
```

- [ ] **Step 4: Run the full script-test file — PASS.** Then `bash -n scripts/crow-install.sh`.

- [ ] **Step 5: Commit**

```bash
git commit scripts/crow-install.sh tests/crow-install-script.test.js -m "feat(install): wire Tailscale Serve + CROW_GATEWAY_URL at install; scope port 443 on cloud hosts (F-INSTALL-1, F-INSTALL-2)"
```

### Task A5: PR-A wrap — full suite, self-review, PR

- [ ] **Step 1:** `node --test tests/*.test.js` — expect full suite green (baseline count + new script tests; there is NO `npm test` script, R1-C3).
- [ ] **Step 2:** `bash -n scripts/crow-install.sh` + `shellcheck -e SC1090,SC1091 scripts/crow-install.sh` (if installed).
- [ ] **Step 3:** Manual read-through: trace the headless path (`HAS_TTY=false`) end-to-end — every prompt resolves (confirm→Y continue; OS rename→N skip; 443→Y on LAN/N on cloud; ts rename→N skip; Serve→Y wire) and NO `read` executes.
- [ ] **Step 4:** `git pull --rebase`, push branch, open PR (base `main`) titled `fix(install): P4 audit hardening — unattended-safe installer (F-INSTALL-1/2/5/6/7/9/11)`, body maps findings→fixes. Verify check-runs all `completed`/`success` via `/commits/<sha>/check-runs`.

---

# PR-INSTALL-B — first-boot viability (gateway + orchestrator + token)

**Branch:** `fix/p4-first-boot-viability` off `main` (rebase over PR-A's merge).
**Files:** Create `servers/gateway/issuer-url.js`, `scripts/mint-local-token.js`, `tests/issuer-url.test.js`, `tests/gpu-orchestrator-host-gate.test.js`, `tests/mint-local-token.test.js`; Modify `servers/gateway/index.js`, `servers/gateway/gpu-orchestrator.js`, `servers/shared/providers.js`, `package.json`, `scripts/crow-install.sh` (one echo line).

### Task B1: `resolveIssuerUrl()` (F-INSTALL-8 core)

**Files:**
- Create: `servers/gateway/issuer-url.js`
- Test: `tests/issuer-url.test.js`

**Interfaces:**
- Produces: `resolveIssuerUrl({ publicUrl, port }) → { url: URL, degraded: boolean, configured: boolean, reason: string|null }`. Task B2 consumes it in `index.js`.

- [ ] **Step 1: Failing test** — create `tests/issuer-url.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveIssuerUrl } from "../servers/gateway/issuer-url.js";

test("configured HTTPS URL passes through byte-identical (existing drop-in installs)", () => {
  const r = resolveIssuerUrl({ publicUrl: "https://black-swan.dachshund-chromatic.ts.net", port: 3001 });
  assert.equal(r.url.href, "https://black-swan.dachshund-chromatic.ts.net/");
  assert.equal(r.degraded, false);
});

test("unset publicUrl → http://localhost:<port>, NOT degraded (nothing configured)", () => {
  const r = resolveIssuerUrl({ publicUrl: undefined, port: 3001 });
  assert.equal(r.url.href, "http://localhost:3001/");
  assert.equal(r.degraded, false);
  assert.equal(r.configured, false);
});

test("F-8 repro: http non-localhost URL degrades to localhost instead of throwing", () => {
  const r = resolveIssuerUrl({ publicUrl: "http://crow.local", port: 3001 });
  assert.equal(r.url.href, "http://localhost:3001/");
  assert.equal(r.degraded, true);
  assert.match(r.reason, /HTTPS/);
});

test("http localhost / 127.0.0.1 are SDK-exempt and pass through", () => {
  assert.equal(resolveIssuerUrl({ publicUrl: "http://localhost:3001", port: 3001 }).degraded, false);
  assert.equal(resolveIssuerUrl({ publicUrl: "http://127.0.0.1:3001", port: 3001 }).degraded, false);
});

test("query/fragment are stripped (SDK throws on them)", () => {
  const r = resolveIssuerUrl({ publicUrl: "https://x.ts.net/?a=1#b", port: 3001 });
  assert.equal(r.url.search, "");
  assert.equal(r.url.hash, "");
  assert.equal(r.degraded, false);
});

test("garbage URL degrades instead of throwing", () => {
  const r = resolveIssuerUrl({ publicUrl: "not a url", port: 3001 });
  assert.equal(r.url.href, "http://localhost:3001/");
  assert.equal(r.degraded, true);
});
```

- [ ] **Step 2: Run — FAIL (module not found).** `node --test tests/issuer-url.test.js`

- [ ] **Step 3: Implement** `servers/gateway/issuer-url.js`:

```js
/**
 * OAuth issuer URL resolution (F-INSTALL-8).
 *
 * The MCP SDK's mcpAuthRouter/createOAuthMetadata THROW at mount time on any
 * issuer that is not HTTPS (localhost/127.0.0.1 exempt) or that carries a
 * query/fragment — which killed the gateway on every fresh install (no
 * CROW_GATEWAY_URL → http://0.0.0.0:3001). Resolve the issuer here instead:
 * a valid configured URL passes through byte-identical; anything the SDK
 * would reject degrades to http://localhost:<port> (SDK-exempt) with a
 * reason, so the gateway ALWAYS boots. A degraded issuer only breaks the
 * remote OAuth dance — dashboard, local-token MCP, and peer auth are
 * unaffected.
 */
export function resolveIssuerUrl({ publicUrl, port }) {
  const fallback = new URL(`http://localhost:${port}`);
  if (!publicUrl) {
    return { url: fallback, degraded: false, configured: false, reason: null };
  }
  let url;
  try {
    url = new URL(publicUrl);
  } catch {
    return {
      url: fallback, degraded: true, configured: true,
      reason: `CROW_GATEWAY_URL is not a valid URL: ${JSON.stringify(publicUrl)}`,
    };
  }
  url.hash = "";
  url.search = "";
  const localhostExempt = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !localhostExempt) {
    return {
      url: fallback, degraded: true, configured: true,
      reason: `issuer ${url.href} is not HTTPS (the MCP SDK requires HTTPS for non-localhost issuers)`,
    };
  }
  return { url, degraded: false, configured: true, reason: null };
}
```

- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit**

```bash
git commit servers/gateway/issuer-url.js tests/issuer-url.test.js -m "fix(gateway): resolveIssuerUrl — never let the OAuth issuer kill boot (F-INSTALL-8 core)"
```

### Task B2: Wire the resolver into `index.js` + boot-proof verification (F-INSTALL-8)

**Files:**
- Modify: `servers/gateway/index.js:394-420`

**Interfaces:**
- Consumes: `resolveIssuerUrl` from B1.
- Behavior contract: with a valid HTTPS `CROW_GATEWAY_URL`, the mounted routes and `serverUrl` are IDENTICAL to today (drop-in installs unaffected). `authMiddleware` (`requireBearerAuth`) is built OUTSIDE the try/catch — MCP transports stay token-protected even if OAuth discovery mounting fails.

- [ ] **Step 1: Capture the red state (manual repro, no test file):**

```bash
TMP=$(mktemp -d) && CROW_DATA_DIR=$TMP CROW_DB_PATH=$TMP/crow.db NODE_ENV=production \
CROW_GATEWAY_URL= RENDER_EXTERNAL_URL= CROW_GATEWAY_PORT=3117 \
timeout 25 node servers/gateway/index.js 2>&1 | tail -5
```

Expected TODAY: crash with `Issuer URL must be HTTPS` (this is the exact black-swan DOA).

- [ ] **Step 2: Implement.** In `servers/gateway/index.js` replace lines 394-420 region:

```js
if (!noAuth) {
  const provider = createOAuthProvider();
  const publicUrl = process.env.CROW_GATEWAY_URL || process.env.RENDER_EXTERNAL_URL;
  const { url: serverUrl, degraded, reason } = resolveIssuerUrl({ publicUrl, port: PORT });
  if (degraded) {
    console.warn(`[oauth] ${reason}`);
    console.warn(`[oauth] Falling back to issuer ${serverUrl.href} so the gateway can boot. ` +
      `Remote MCP OAuth needs an HTTPS URL: set CROW_GATEWAY_URL in .env (easiest: ` +
      `sudo tailscale serve --bg --https=443 http://127.0.0.1:${PORT}, then ` +
      `CROW_GATEWAY_URL=https://<this-machine>.<tailnet>.ts.net) and restart the gateway.`);
  }

  try {
    // Auth routes (register, authorize, token)
    app.use(mcpAuthRouter({
      provider,
      issuerUrl: serverUrl,
      scopesSupported: ["mcp:tools"],
    }));

    // Protected resource metadata
    const oauthMetadata = createOAuthMetadata({
      provider,
      issuerUrl: serverUrl,
      scopesSupported: ["mcp:tools"],
    });

    app.use(mcpAuthMetadataRouter({
      oauthMetadata,
      resourceServerUrl: serverUrl,
      scopesSupported: ["mcp:tools"],
      resourceName: "Crow",
    }));
  } catch (err) {
    // Belt-and-suspenders for F-INSTALL-8: a fresh appliance must never be
    // dead-on-arrival because OAuth *discovery* couldn't mount. MCP transports
    // stay behind requireBearerAuth (below); only the OAuth dance endpoints
    // are missing in this state.
    console.error(`[oauth] Failed to mount OAuth routes: ${err.message}. ` +
      `Remote MCP OAuth is disabled until CROW_GATEWAY_URL is a valid HTTPS URL.`);
  }
```

with the import added at the top of the file next to the other local imports: `import { resolveIssuerUrl } from "./issuer-url.js";`
Everything from `// Introspection endpoint` (line ~422) through `authMiddleware = requireBearerAuth({...})` stays OUTSIDE the try, unchanged (uses `serverUrl` which is always defined now).

- [ ] **Step 3: Green verification — the DOA repro now boots:** re-run the Step-1 command; expected: boot log includes the two `[oauth]`-prefixed lines? NO — with `CROW_GATEWAY_URL` unset, `configured:false` → NOT degraded, NO warn, issuer `http://localhost:3117`; gateway reaches "Crow's Nest mounted". Then `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3117/health` → `200`. ALSO run the degraded variant (`CROW_GATEWAY_URL=http://crow.local`) and confirm the actionable warn appears + `/health` 200.
- [ ] **Step 4: Regression:** `node --test tests/auth-network.test.js` (network-invariant guard) + boot the REAL config path: `node servers/gateway/index.js` with repo `.env` (HTTPS URL) — confirm the old `OAuth 2.1 enabled` line and NO `[oauth]` warnings, ctrl-C.
- [ ] **Step 5: Commit**

```bash
git commit servers/gateway/index.js -m "fix(gateway): fresh installs boot without an HTTPS CROW_GATEWAY_URL — issuer degrades to localhost with an actionable warning instead of crashing (F-INSTALL-8)"
```

### Task B3: PHYSICAL locality gate in the GPU orchestrator (F-INSTALL-10; redesigned per R1-C1/C2)

**Why not a `host`-string gate (R1-C1/C2, live-verified):** grackle's own DB row for `grackle-embed` carries `host='grackle-5fc01ac74463b6f4'` (a models.json label, not a real instance id) — so `host==='local'` would stop grackle keeping its OWN embed resident (C1, prod outage). And crow's bundles are tagged `host:"local"` in models.json, so the same gate would still let a fresh install docker-up `vllm-rocm-qwen35-4b` (C2, F-10 not fixed). The question the orchestrator actually asks is *"does this bundle run on THIS machine?"* — and the baseUrl answers it physically: a bundle-backed provider is locally orchestratable iff its baseUrl hostname is loopback/localhost or one of this machine's own interface addresses. Verified discrimination: `crow-*` → `100.118.41.122` (own-IP only on crow), `grackle-*` → `100.121.254.89` (own-IP only on grackle), fresh install → nothing matches → zero compose attempts. DNS-name baseUrls (none exist today on bundle-backed providers) are conservatively non-local.

**Files:**
- Modify: `servers/gateway/gpu-orchestrator.js` (lines 156-161, 202-214, 225-239, 266+, the mutex sibling-stop loop ~279-289, `startIdleRevertTimer` ~344-357, and `initOrchestrator` 391-429)
- Test: `tests/gpu-orchestrator-host-gate.test.js`

**Interfaces:**
- Produces (all exported from `gpu-orchestrator.js`): `getOwnAddresses() → Set<string>` (non-virtual interface addrs + `"localhost"`, `"127.0.0.1"`, `"::1"`); `isLocallyOrchestratable(p, ownAddrs = getOwnAddresses()) → boolean`; `alwaysResidentProviders(cfg = loadProviders(), ownAddrs = getOwnAddresses())` (test seam mirrors `resolveWarmableProviderName(cfg, name)`, which gains an optional `ownAddrs` third param); `retryDeferredResidents({cfg, ownAddrs, ensure} = {}) → Promise<string[]>` and `_setDeferredResidentsForTest(names)` (R2-C1 self-heal + its seam).
- The `host` column stays untouched (it is synced fleet-wide and per-instance-wrong; fixing the data model is the post-arc generalization theme).
- Behavior preservation: `maybeAcquireLocalProvider` KEEPS its existing `host!=="local"` early-return AND adds the physical gate (AND semantics) — grackle's vision/rerank chat-path acquire stays a no-op exactly as today; no new docker activity anywhere on the fleet.

- [ ] **Step 1: Failing test** — create `tests/gpu-orchestrator-host-gate.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getOwnAddresses, isLocallyOrchestratable,
  alwaysResidentProviders, resolveWarmableProviderName,
  retryDeferredResidents, _setDeferredResidentsForTest,
} from "../servers/gateway/gpu-orchestrator.js";

// Real fleet shapes (models.json fallback on a fresh install):
const CFG = { providers: {
  "crow-voice":    { baseUrl: "http://100.118.41.122:8011/v1", host: "local", bundleId: "vllm-rocm-qwen35-4b", gpuPolicy: { alwaysResident: true } },
  "grackle-embed": { baseUrl: "http://100.121.254.89:9100/v1", host: "grackle-5fc01ac74463b6f4", bundleId: "vllm-cuda-embed", gpuPolicy: { alwaysResident: true } },
  "crow-llm":      { baseUrl: "http://localhost:3001/llm/v1", host: "local", bundleId: null },
  "cloud-alias":   { baseUrl: "https://api.together.xyz/v1", host: "cloud" },
  "loop-bundle":   { baseUrl: "http://127.0.0.1:8004/v1", bundleId: "llamacpp-cpu-qwen3-embed", gpuPolicy: { alwaysResident: true } },
} };
const CROW = new Set(["localhost", "127.0.0.1", "::1", "100.118.41.122"]);
const GRACKLE = new Set(["localhost", "127.0.0.1", "::1", "100.121.254.89"]);
const FRESH = new Set(["localhost", "127.0.0.1", "::1", "10.0.0.5"]);

test("isLocallyOrchestratable is physical: own-IP or loopback, never the host string", () => {
  assert.equal(isLocallyOrchestratable(CFG.providers["crow-voice"], CROW), true);
  assert.equal(isLocallyOrchestratable(CFG.providers["crow-voice"], GRACKLE), false);   // host:"local" LIES on grackle
  assert.equal(isLocallyOrchestratable(CFG.providers["grackle-embed"], GRACKLE), true); // host:"grackle-…" LIES on grackle (C1)
  assert.equal(isLocallyOrchestratable(CFG.providers["grackle-embed"], CROW), false);
  assert.equal(isLocallyOrchestratable(CFG.providers["loop-bundle"], FRESH), true);     // loopback is local everywhere
  assert.equal(isLocallyOrchestratable(CFG.providers["cloud-alias"], FRESH), false);
  assert.equal(isLocallyOrchestratable({ baseUrl: "not a url" }, FRESH), false);
  assert.equal(isLocallyOrchestratable({}, FRESH), false);
});

test("F-10 headline: a FRESH install ensures NO alwaysResident bundles from the shipped models.json", () => {
  // loop-bundle is synthetic; the real shipped set (crow-voice, grackle-embed) must be empty on fresh
  const shipped = { providers: { "crow-voice": CFG.providers["crow-voice"], "grackle-embed": CFG.providers["grackle-embed"] } };
  assert.deepEqual(alwaysResidentProviders(shipped, FRESH), []);
});

test("C1 closed: grackle keeps its own embed resident; crow keeps its own voice; neither ensures the other's", () => {
  assert.deepEqual(alwaysResidentProviders(CFG, GRACKLE), ["grackle-embed"]);
  const crowNames = alwaysResidentProviders(CFG, CROW).sort();
  assert.deepEqual(crowNames, ["crow-voice", "loop-bundle"]);
});

test("resolveWarmableProviderName refuses foreign bundles even though they HAVE a bundleId", () => {
  assert.equal(resolveWarmableProviderName(CFG, "grackle-embed", CROW), null);
  assert.equal(resolveWarmableProviderName(CFG, "crow-voice", CROW), "crow-voice");
  // bundle-less alias resolves only to a PHYSICALLY-local sibling
  assert.equal(resolveWarmableProviderName(CFG, "cloud-alias", CROW), null);
});

test("getOwnAddresses always contains loopback names", () => {
  const own = getOwnAddresses();
  assert.ok(own.has("localhost") && own.has("127.0.0.1"));
});
```

- [ ] **Step 2: Run — FAIL** (`getOwnAddresses`/`isLocallyOrchestratable` not exported; foreign bundles currently resolve/ensure).

- [ ] **Step 3: Implement** in `servers/gateway/gpu-orchestrator.js`:

(a) Add near the top (after the existing imports; add `import { networkInterfaces } from "node:os";`):

```js
/**
 * F-INSTALL-10 — physical locality gate.
 *
 * The orchestrator's job is `docker compose up/stop` on THIS machine, so the
 * only trustworthy signal is whether the provider's baseUrl points AT this
 * machine (loopback or one of our own interface addresses). The providers
 * `host` column cannot be used: it syncs fleet-wide with the seeding
 * instance's perspective baked in (live fleet: grackle's own embed row says
 * host='grackle-5fc01ac74463b6f4', crow's bundles say 'local' everywhere),
 * so a host-string gate either breaks a peer keeping its own bundle resident
 * or lets a fresh install start the maintainer-lab's bundles.
 */
// Bridge/virtual interfaces carry SHARED-SUBNET gateway IPs (every docker
// host has 172.17.0.1; libvirt ships 192.168.122.1) — never machine identity
// (R2-M1). Skip them so a peer's hypothetical bridge-IP baseUrl can't
// false-match here.
const VIRTUAL_IF_RE = /^(docker|br-|veth|virbr|vmnet|lxc|cni)/;

export function getOwnAddresses() {
  const own = new Set(["localhost", "127.0.0.1", "::1"]);
  try {
    for (const [ifname, addrs] of Object.entries(networkInterfaces())) {
      if (VIRTUAL_IF_RE.test(ifname)) continue;
      for (const a of addrs || []) own.add(a.address);
    }
  } catch {}
  return own;
}

export function isLocallyOrchestratable(p, ownAddrs = getOwnAddresses()) {
  if (!p?.baseUrl) return false;
  try {
    // WHATWG URL keeps brackets on IPv6 hostnames ("[::1]"); interface
    // addresses don't have them.
    const h = new URL(p.baseUrl).hostname.replace(/^\[|\]$/g, "");
    return ownAddrs.has(h);
  } catch {
    return false;
  }
}
```

(b) `alwaysResidentProviders` → exported, injectable, gated:

```js
export function alwaysResidentProviders(cfg = loadProviders(), ownAddrs = getOwnAddresses()) {
  const entries = Object.entries(cfg.providers || {})
    .filter(([, v]) => v.gpuPolicy?.alwaysResident === true || v.alwaysResident === true);
  const skipped = entries.filter(([, v]) => !isLocallyOrchestratable(v, ownAddrs)).map(([n]) => n);
  if (skipped.length) {
    console.log(`[gpu-orchestrator] skipping alwaysResident provider(s) not hosted on this machine: ${skipped.join(", ")}`);
  }
  return entries.filter(([, v]) => isLocallyOrchestratable(v, ownAddrs)).map(([n]) => n);
}
```

(c) `maybeAcquireLocalProvider` — KEEP the existing `if (p.host && p.host !== "local") return null;` and add directly below it:

```js
  if (!isLocallyOrchestratable(p)) return null; // F-INSTALL-10: not this machine's bundle
```

(d) `resolveWarmableProviderName(cfg, name, ownAddrs = getOwnAddresses())` — replace the body's gate logic with exactly this (physical gate before the bundleId early-return, and in the sibling loop):

```js
  const direct = provs[name];
  if (!direct) return null;
  if (direct.bundleId) {
    if (!isLocallyOrchestratable(direct, ownAddrs)) return null; // F-INSTALL-10
    return name;
  }
  if (direct.host != null && direct.host !== "local") return null; // cloud alias — not warmable
  const base = direct.baseUrl || direct.baseURL || direct.base_url;
  if (!base) return null;
  for (const [n, v] of Object.entries(provs)) {
    if (n === name || !v || !v.bundleId) continue;
    if (!isLocallyOrchestratable(v, ownAddrs)) continue; // F-INSTALL-10
    if ((v.baseUrl || v.baseURL || v.base_url) === base) return n;
  }
  return null;
```

(e) `acquireProvider` — add a guard right after its provider lookup (read the function body first; insert after the `getProvider`/not-found handling):

```js
  if (!isLocallyOrchestratable(p)) {
    console.warn(`[gpu-orchestrator] refusing to orchestrate ${providerName} — its baseUrl is not on this machine`);
    return null;
  }
```

(Callers treat the result truthily — `null` reads as not-acquired, same as a readiness timeout `false`.)

(f) Mutex sibling-stop loop (~line 279-289, R1-M2): skip siblings that aren't physically local before `bundleStop`:

```js
      const sib = getProvider(sibName);
      if (!sib?.bundleId || !isLocallyOrchestratable(sib)) continue;
```

(adapt to the loop's actual variable names — `docker compose stop` on a foreign bundle is a no-op anyway; this makes intent explicit.)

(g) **Deferred-resident self-heal (R2-C1 — MANDATORY).** The physical predicate samples `networkInterfaces()` at check time, and `initOrchestrator()` runs ONCE at boot with no re-ensure path (`checkIdleRevert` only reverts resident non-defaults; it never warms a cold resident). A gateway that boots before `tailscale0` carries its address would skip its OWN alwaysResident bundle (crow-voice on crow, grackle-embed on grackle) with **no self-heal** — a regression the current ungated code doesn't have, on a race this fleet has actually hit (the 13-day ntfy outage). Fix: providers skipped as non-local at boot go into a deferred set that the existing idle interval retries with FRESH `getOwnAddresses()` each tick (2-min `IDLE_CHECK_INTERVAL_MS`) — residency converges within one tick of the interface coming up; entries that never become local (a peer's bundle) just stay parked (a Set membership check per tick, free).

Extract the per-name ensure body from `initOrchestrator` into a reusable helper, restructure `initOrchestrator`, and add the retry — use exactly this shape:

```js
let _deferredResidents = new Set();

/** Test seam (R2-C1 tests). */
export function _setDeferredResidentsForTest(names) {
  _deferredResidents = new Set(names);
}

/** Ensure ONE alwaysResident provider: probe → bundleUp → waitForReady.
 *  Returns true iff it warmed an embed-capable provider (caller may
 *  trigger the embedding backfill). Never throws. */
async function ensureResident(name, cfg = loadProviders()) {
  try {
    const p = (cfg.providers || {})[name];
    if (!p?.bundleId) {
      console.warn(`[gpu-orchestrator] ${name} has no bundleId — skipping`);
      return false;
    }
    if (await probeReady(p.baseUrl)) {
      console.log(`[gpu-orchestrator] ${name} already resident`);
      return false;
    }
    console.log(`[gpu-orchestrator] starting ${name} (bundleId=${p.bundleId})`);
    await bundleUp(p.bundleId);
    const ready = await waitForReady(p.baseUrl);
    if (!ready) {
      console.warn(`[gpu-orchestrator] ${name} did NOT warm up in time`);
      return false;
    }
    return providerHasEmbedModel(p);
  } catch (err) {
    console.error(`[gpu-orchestrator] failed to bring up ${name}: ${err.message}`);
    return false;
  }
}

/** R2-C1: re-check boot-deferred alwaysResident providers against FRESH own
 *  addresses (tailscale0 may come up after the gateway). Called from the
 *  idle-revert interval. Returns the names ensured this pass. */
export async function retryDeferredResidents({
  cfg = loadProviders(),
  ownAddrs = getOwnAddresses(),
  ensure = ensureResident,
} = {}) {
  if (!_deferredResidents.size) return [];
  const ensured = [];
  let embedRecovered = false;
  for (const name of [..._deferredResidents]) {
    const p = (cfg.providers || {})[name];
    if (!p) { _deferredResidents.delete(name); continue; }
    if (!isLocallyOrchestratable(p, ownAddrs)) continue; // still not ours — stays parked
    _deferredResidents.delete(name);
    console.log(`[gpu-orchestrator] deferred alwaysResident ${name} is now locally hosted — ensuring (its interface came up after boot)`);
    if (await ensure(name, cfg)) embedRecovered = true;
    ensured.push(name);
  }
  if (embedRecovered) triggerEmbedBackfill();
  return ensured;
}
```

`initOrchestrator` becomes:

```js
export async function initOrchestrator() {
  if (_initialized) return;
  _initialized = true;
  const cfg = loadProviders();
  const ownAddrs = getOwnAddresses();
  const residents = alwaysResidentProviders(cfg, ownAddrs); // logs the skip line
  _deferredResidents = new Set(
    Object.entries(cfg.providers || {})
      .filter(([, v]) => (v.gpuPolicy?.alwaysResident === true || v.alwaysResident === true)
        && !isLocallyOrchestratable(v, ownAddrs))
      .map(([n]) => n)
  );
  if (residents.length === 0 && _deferredResidents.size === 0) {
    console.log("[gpu-orchestrator] no alwaysResident providers declared");
    startIdleRevertTimer();
    return;
  }
  if (residents.length) {
    console.log(`[gpu-orchestrator] ensuring alwaysResident: ${residents.join(", ")}`);
  }
  let embedRecovered = false;
  for (const name of residents) {
    if (await ensureResident(name, cfg)) embedRecovered = true;
  }
  startIdleRevertTimer();
  if (embedRecovered) {
    triggerEmbedBackfill(); // fire-and-forget — don't block gateway startup
  }
}
```

And inside `startIdleRevertTimer`'s interval callback, add BEFORE the existing idle-revert check:

```js
    retryDeferredResidents().catch(() => {});
```

Append these tests to `tests/gpu-orchestrator-host-gate.test.js` (part of Step 1's red run):

```js
test("R2-C1 self-heal: a resident deferred at boot is ensured once its IP appears, exactly once", async () => {
  _setDeferredResidentsForTest(["crow-voice"]);
  const calls = [];
  const ensure = async (name) => { calls.push(name); return false; };
  // interface still down → stays parked, no ensure
  assert.deepEqual(await retryDeferredResidents({ cfg: CFG, ownAddrs: FRESH, ensure }), []);
  assert.deepEqual(calls, []);
  // tailscale0 up → ensured exactly once, then drained
  assert.deepEqual(await retryDeferredResidents({ cfg: CFG, ownAddrs: CROW, ensure }), ["crow-voice"]);
  assert.deepEqual(calls, ["crow-voice"]);
  assert.deepEqual(await retryDeferredResidents({ cfg: CFG, ownAddrs: CROW, ensure }), []);
  assert.deepEqual(calls, ["crow-voice"]);
});

test("R2-C1: a peer's resident parks forever without ensure calls or errors", async () => {
  _setDeferredResidentsForTest(["grackle-embed"]);
  const calls = [];
  const ensure = async (name) => { calls.push(name); return false; };
  assert.deepEqual(await retryDeferredResidents({ cfg: CFG, ownAddrs: CROW, ensure }), []);
  assert.deepEqual(calls, []);
  _setDeferredResidentsForTest([]); // isolation for later tests
});
```

- [ ] **Step 4: Run** `node --test tests/gpu-orchestrator-host-gate.test.js` — PASS. Then the adjacent regression: `node --test tests/embed-provider.test.js`.
- [ ] **Step 5: Commit**

```bash
git commit servers/gateway/gpu-orchestrator.js tests/gpu-orchestrator-host-gate.test.js -m "fix(orchestrator): physical locality gate — never docker-up a bundle whose baseUrl isn't this machine (F-INSTALL-10)"
```

### Task B4: Headless local-MCP-token mint (F-INSTALL-3)

**Files:**
- Create: `scripts/mint-local-token.js`
- Modify: `package.json` (scripts), `scripts/crow-install.sh` (one "What's next" line)
- Test: `tests/mint-local-token.test.js`

**Interfaces:**
- Consumes: `generateLocalToken`/`getLocalTokenMeta`/`validateLocalToken` from `servers/gateway/local-token.js`; `createDbClient` from `servers/db.js` (honors `CROW_DB_PATH`).
- Produces: `npm run local-token` (refuses if a token exists; `--rotate` replaces). Prints the raw token ONCE to stdout.

- [ ] **Step 1: Failing test** — create `tests/mint-local-token.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const dir = mkdtempSync(join(tmpdir(), "crow-mint-"));
const env = { ...process.env, CROW_DATA_DIR: dir, CROW_DB_PATH: join(dir, "crow.db") };

function run(args = []) {
  return spawnSync("node", ["scripts/mint-local-token.js", ...args], { cwd: ROOT, env, encoding: "utf-8" });
}

test("mints a 64-hex token on a fresh DB and it validates", async () => {
  const init = spawnSync("node", ["scripts/init-db.js"], { cwd: ROOT, env, encoding: "utf-8" });
  assert.equal(init.status, 0, init.stderr);
  const r = run();
  assert.equal(r.status, 0, r.stderr);
  const token = (r.stdout.match(/\b[0-9a-f]{64}\b/) || [])[0];
  assert.ok(token, "prints the raw token once");
  process.env.CROW_DB_PATH = env.CROW_DB_PATH;
  const { createDbClient } = await import("../servers/db.js");
  const { validateLocalToken } = await import("../servers/gateway/local-token.js");
  assert.equal(await validateLocalToken(createDbClient(), token), true);
});

test("refuses a second mint without --rotate; --rotate replaces", () => {
  const again = run();
  assert.notEqual(again.status, 0);
  assert.match(again.stderr, /--rotate/);
  const rot = run(["--rotate"]);
  assert.equal(rot.status, 0, rot.stderr);
  assert.match(rot.stdout, /\b[0-9a-f]{64}\b/);
});
```

(R1-I2 verified: `createDbClient()` reads `CROW_DB_PATH` at CALL time (db.js:307) and the client exposes `.close()`; init-db creates both `dashboard_settings` and `dashboard_settings_overrides` and honors `CROW_DB_PATH` — the dynamic-import-after-env trick works. One dependency to know: `writeSetting(scope:"local")` calls `getOrCreateLocalInstanceId()`, which materializes an instance identity file under `CROW_DATA_DIR` — the test sets a temp `CROW_DATA_DIR`, so this is self-contained; the script therefore also works pre-first-boot on a real install.)

- [ ] **Step 2: Run — FAIL (script missing).**

- [ ] **Step 3: Implement** `scripts/mint-local-token.js`:

```js
#!/usr/bin/env node
/**
 * Mint (or rotate) the local MCP token HEADLESSLY (F-INSTALL-3).
 *
 * The interactive path is the dashboard Connect panel (one-time reveal).
 * This is the no-browser path for appliances/harnesses: only sha256(token)
 * is stored (local-scoped dashboard setting keyed to this instance); the raw
 * value is printed exactly once, to stdout, and never logged elsewhere.
 *
 * Usage:
 *   npm run local-token             # refuses if a token already exists
 *   npm run local-token -- --rotate # replace (existing clients stop working)
 */
import { createDbClient } from "../servers/db.js";
import { generateLocalToken, getLocalTokenMeta } from "../servers/gateway/local-token.js";

const db = createDbClient();
try {
  const meta = await getLocalTokenMeta(db);
  const rotate = process.argv.includes("--rotate");
  if (meta.present && !rotate) {
    console.error(`A local MCP token already exists (created ${meta.createdAt || "unknown"}).`);
    console.error("Re-run with --rotate to replace it — existing MCP clients using it will stop working.");
    process.exit(1);
  }
  const token = await generateLocalToken(db);
  console.log("Local MCP token (shown ONCE — copy it now):");
  console.log(token);
  console.log("");
  console.log("Use it as an Authorization: Bearer header on any MCP path, e.g. /sharing/mcp.");
  console.log("Manage/rotate later in the dashboard: Connect panel.");
} finally {
  try { db.close(); } catch {}
}
```

`package.json` scripts: add `"local-token": "node scripts/mint-local-token.js",` (alphabetical/nearby placement per existing style).

`scripts/crow-install.sh` "What's next" block: insert after the API-keys line:

```bash
echo "    3. Headless MCP token:  cd $CROW_APP && npm run local-token"
```

(renumber the following lines. R1-M1: PR-B lands AFTER PR-A, which already rewrote this block — resolve the insertion point against the branch's post-rebase content, not `main`'s stale line numbers.)

- [ ] **Step 4: Run — PASS.** Also re-run `node --test tests/crow-install-script.test.js` (installer still parses; no `read -p` regression).
- [ ] **Step 5: Commit**

```bash
git commit scripts/mint-local-token.js package.json scripts/crow-install.sh tests/mint-local-token.test.js -m "feat(gateway): npm run local-token — headless one-time mint of the local MCP token (F-INSTALL-3)"
```

### Task B5: PR-B wrap — suite, boot smokes, PR

- [ ] **Step 1:** `node --test tests/*.test.js` full suite green (R1-C3: no `npm test` script exists).
- [ ] **Step 2:** Boot smokes: (a) fresh-datadir NODE_ENV=production no-CROW_GATEWAY_URL boot → `/health` 200 (the F-8 DOA repro, now green); (b) repo `.env` boot → `OAuth 2.1 enabled`, no `[oauth]` warns, and the gpu-orchestrator skip line shows `grackle-embed` and **must NOT contain `crow-voice`** (R2-C1: the skip line listing the machine's OWN provider is the boot-race signature) while `ensuring alwaysResident:` lists `crow-voice`. CAVEAT: both smokes run ON crow with tailscale up, so they cannot exercise the cold-tailscale boot race or the fresh-VPS skip — those are pinned by the unit tests' injected address sets and the R2-C1 self-heal tests (Task B3), which is exactly why the predicate and retry take `ownAddrs`/`ensure` as parameters.
- [ ] **Step 3:** `node --test tests/auth-network.test.js` + `node --test tests/embed-provider.test.js` once more on the final tree.
- [ ] **Step 4:** `git pull --rebase`, push, open PR titled `fix(gateway): first-boot viability — issuer never kills boot, orchestrator never starts foreign bundles, headless token mint (F-INSTALL-8/10/3)`. Verify check-runs green.

---

## Merge + deploy sequence (after final security review of each branch)

1. Merge PR-A (merge commit), then rebase PR-B, re-run suite, merge PR-B.
2. (Pre-deploy live check RESOLVED during planning, R1-C1: grackle's rows are `host='grackle-5fc01ac74463b6f4'`, crow's are `'local'` everywhere — which is WHY the gate is physical, not host-string. No remaining data dependency.)
3. Deploy crow: `git -C /home/kh0pp/crow pull` + `sudo systemctl restart crow-gateway` → `/health` 200, `NRestarts=0`, journal: `OAuth 2.1 enabled`, NO `[oauth]` warn, orchestrator: `ensuring alwaysResident:` lists `crow-voice`, the skip line lists `grackle-embed` and **must NOT list `crow-voice`** (R2-C1 signature) — no `vllm-cuda-embed` compose attempt.
4. Deploy MPA: `sudo systemctl restart crow-mpa-gateway` → `:3006/health` 200.
5. Deploy grackle: `git -C /home/kh0pp/crow pull`, restart `crow-mcp-bridge` THEN `crow-gateway` → `:3002/health` 200 AND journal shows **grackle-embed still ensured/resident** (THE F-10 regression sentinel) with the skip line listing `crow-voice` and **NOT `grackle-embed`**.
6. **black-swan: UNTOUCHED.** (No auto-update timer exists on fresh installs — verified.)
7. Update `p4-findings.md` statuses + MEMORY.md + ledger.

## Known limitations / honest notes

- The F-8 localhost-issuer fallback means a *misconfigured* (http, non-localhost) CROW_GATEWAY_URL yields a booting gateway whose remote OAuth dance is broken until fixed — deliberate: a dead appliance is strictly worse; the warn is loud and actionable, and PR-A's Serve wiring writes a correct HTTPS URL on tailscale hosts.
- `resolveIssuerUrl` drops the old `http://${BIND}:${PORT}` fallback (which could only ever have worked with `CROW_GATEWAY_BIND=127.0.0.1`; default `0.0.0.0` always threw). Behavior change is cosmetic (localhost vs 127.0.0.1 in metadata for an undocumented configuration).
- Cloud detection (F-2) is a heuristic (metadata endpoint probe). False negative → 443 default stays Y on an exotic VPS; the advisory warn still prints. Documented, not perfect.
- models.json still ships lab topology (providers list, model names) and the synced `providers.host` column remains per-instance-wrong (R1-C1 evidence). Out of scope here — that's the post-arc generalization theme. The PHYSICAL gate makes the shipped topology genuinely inert on foreign hosts (fresh install: zero compose attempts — closed, not rescoped), but the data model itself still needs the generalization work.
- `maybeAcquireLocalProvider` deliberately keeps its old `host!=="local"` early-return in ADDITION to the physical gate: on grackle this preserves today's no-op for grackle-vision/rerank chat-path acquires (their rows carry the fake host label). Removing it would *enable* on-demand vision/rerank swaps on grackle — possibly desirable, but a behavior change out of this PR's scope; noted for the generalization theme.
- Headless installs never see prompts and `HAS_TTY` uses a real open-probe of `/dev/tty` (R1-I1) — `[ -r /dev/tty ]` alone is a permission-bit check that is true even with no controlling terminal. (R2 empirically confirmed the open-probe survives `set -euo pipefail` in a setsid shell and fd 3 is otherwise unused.)
- **PR-A alone does NOT close the fresh-install DOA** (R2-M3): a fresh install without Tailscale (or declining Serve) still has no `CROW_GATEWAY_URL` and the OLD gateway still crashes until PR-B merges. Both PRs ship the same session; no auto-update reaches appliances between the merges (no timer exists).
- Boot-race residual after the R2-C1 self-heal: a provider deferred by the tailscale race is ensured within one idle tick (~2 min) of the interface coming up — a bounded cold window on reboot, versus today's behavior of attempting `bundleUp` immediately regardless of interface state. Documented trade for never starting foreign bundles.
- `getOwnAddresses` filters virtual/bridge interfaces (R2-M1) since their subnets are shared across hosts; IPv6-mapped-IPv4 baseUrls would not match (R2-M2 — none exist; cosmetic).
- A4's `.env` append leaves `.env.example`'s commented `# CROW_GATEWAY_URL=` line in place above the real one (R2-M4 — dotenv ignores comments; cosmetic).
- The installer tests are invariant pins (grep/bash-regex) + a real functional harness for the helper layer via `CROW_INSTALL_SOURCE_ONLY=1`; the full install path is NOT executed in CI (needs root/apt/docker) and is verified by review — per the campaign's black-swan-pristine constraint.

## Review ledger

- R1 (adversarial, opus): **REVISE — 3 CRITICAL / 2 IMPORTANT / 3 MINOR, ALL FOLDED.**
  - C1 (host gate would break grackle's own embed residency — live DB row `host='grackle-5fc01ac74463b6f4'`, not `'local'`) + C2 (host gate passes crow's `host:"local"` bundles → fresh install still docker-ups `vllm-rocm-qwen35-4b` → F-10 unfixed): BOTH closed by redesigning Task B3 to the PHYSICAL `isLocallyOrchestratable` predicate (baseUrl hostname ∈ own interface addrs ∪ loopback). Reviewer's prescribed C1 fix (accept own `selfId`) was rejected as insufficient — it cannot close C2, and grackle's label matches no real instance id anyway; independently confirmed by the planner's own live-fleet queries.
  - C3 (`npm test` doesn't exist): all suite gates now `node --test tests/*.test.js`, baseline re-measured at SDD time.
  - I1 (HAS_TTY permission-bit check fires the wrong mechanism + /dev/tty error spray): real open-probe detector adopted.
  - I2 (token-mint test viability + identity-dir dependency): confirmed workable; dependency documented in B4.
  - M1 (PR-A/PR-B "What's next" overlap): resolve against post-rebase content — noted in B4. M2 (sibling-stop ungated): physical gate added, step (f). M3 (tailscale serve syntax drift): already degrades to warn — accepted as-is.
  - R1 VERIFIED-GOOD (R2 need not relitigate): source-only seam + `"$@"` under `set -u`; `ts_first_field` regex (empirical); first-HostName=Self (verified against real `tailscale status --json`); all `ask_yn` sites in if-conditions; `ask_line` command-substitution errexit-safe (empirical); pipe-audit completeness; F-8 resolver matches SDK `checkIssuerUrl` exactly, `serverUrl` post-try usage safe (`getOAuthProtectedResourceMetadataUrl` cannot throw), introspection/requireBearerAuth correctly outside the try; `--no-auth` hard-exit guard not engaged by A4's Serve wiring; gateway loads `$CROW_APP/.env` so A4's write is picked up on restart; `import.meta.dirname` fine on repo Node v20.20; NO new public-repo exposure in fixtures (all strings already committed); cloud-443 heuristic curl semantics correct.
- R2 (adversarial, opus): **REVISE — 1 CRITICAL / 1 IMPORTANT / 4 MINOR, ALL FOLDED.**
  - C1 (physical gate + boot-once initOrchestrator = a gateway that boots before tailscale0 skips its OWN resident bundle with NO self-heal; verification was structurally blind to it): folded as Task B3 step (g) — `_deferredResidents` set + `retryDeferredResidents()` on the existing idle tick with fresh `getOwnAddresses()` per pass (converges ≤1 tick after the interface appears; peer bundles park forever, free), `ensureResident()` extraction, injectable test seams, B5/deploy verification now asserts the skip line does NOT list the machine's own provider.
  - I1 (installer unit `After=network.target` only — weaker than prod): A3 now writes `Wants=network-online.target` / `After=network-online.target docker.service tailscaled.service` / `Requires=docker.service` + test.
  - M1 (bridge/virtual interface IPs are shared across hosts): `getOwnAddresses` filters `docker*/br-*/veth*/virbr*/vmnet*/lxc*/cni*`. M2 (IPv6-mapped) documented cosmetic. M3 (PR-A-only window doesn't close F-8): Known-limitations honesty line added. M4 (duplicate commented .env line): documented cosmetic.
  - R2 CONFIRMED-CLOSED (do not relitigate): HAS_TTY open-probe empirically survives set -euo pipefail headless, fd 3 free; zero-compose-on-fresh claim holds (no localhost alwaysResident bundle exists); AND-semantics = no fleet behavior change; acquireProvider guard placement valid, all 3 callers tolerate null (and it fixes a latent meta-glasses foreign-acquire bug); idle-revert path covered via acquireProvider; skip-line text consistent across plan; B3 fixtures hold; `node --test tests/*.test.js` is the historical 1183/1183 command (198 test files); `.env.example:148` append path confirmed.
- R2b (focused confirm, opus): **REVISE→CONFIRMED — 1 mechanical blocker F1 (R2-C1 tests lacked the `retryDeferredResidents`/`_setDeferredResidentsForTest` imports) FIXED IN-PLACE, + F2/F3 cosmetic (stale Files/Interfaces lists) FIXED.** R2b verified: ensureResident preserves today's per-name semantics exactly (incl. embed-recovery: probeReady-success → no backfill); startIdleRevertTimer reached on every initOrchestrator path incl. the fresh-VPS all-deferred case; interval insertion cannot leak an unhandled rejection; test isolation sound (both R2-C1 tests drain/reset the Set; no other test reads it; explicit cfg/ownAddrs/ensure → no timers/DB touched); hoisting/TDZ clean; A3 unit block is BYTE-PARITY with the live prod unit (`systemctl cat` verified) and safe in the unquoted heredoc; VIRTUAL_IF_RE keeps lo/eno1/wlan0/wlx*/tailscale0 and filters br-*/veth* on the real fleet interfaces; skip-line phrasing consistent plan-wide; no cross-round contradictions. **PLAN FINAL — SDD may start.**
- Final whole-branch security review: gates each merge.
