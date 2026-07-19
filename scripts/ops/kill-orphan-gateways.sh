#!/usr/bin/env bash
#
# kill-orphan-gateways.sh — reap orphaned crow gateways AND their whole
# process subtrees, plus already-orphaned bundle children. (Item 2a-FU,
# finding 4: a scratch gateway ran orphaned for 2 days; its maker-lab bundle
# child held the PROD ~/.crow/data/crow.db open — killing only the gateway
# would have re-parented that child to init and the DB lock would SURVIVE,
# so the whole descendant tree is reaped children-first.)
#
# Designed to run as a systemd ExecStartPre (with the `-` failure-tolerant
# prefix) and from the crow-orphan-sweep.timer — it therefore ALWAYS exits 0.
#
# What it does:
#   Sweep 1 (orphan gateways): every process whose cmdline matches
#     ORPHAN_MATCH_PATTERN with ppid==1 and which is not protected (see
#     PROTECTION below) → enumerate its descendant tree (recursive pgrep -P),
#     SIGTERM the tree children-first, wait ~2s, SIGKILL survivors.
#   Sweep 2 (already-orphaned bundle children): every ppid==1 process whose
#     cmdline matches ORPHAN_BUNDLE_PATTERN, whose /proc/<pid>/cwd contains
#     "/bundles/", and which is not protected → same TERM→wait→KILL
#     (subtree included).
#   Sweep 3 (orphaned native model runtime processes — Item G, Task 14):
#     every ppid==1 process whose cmdline matches ORPHAN_NATIVE_PATTERN AND
#     whose /proc/<pid>/exe OR /proc/<pid>/cwd contains the path fragment
#     "/runtimes/llamacpp/" (under ANY CROW_HOME — no literal ~/.crow
#     anywhere in this check), and which is not protected → same
#     TERM→wait→KILL. This is a llama-server process (Item G's native model
#     runtime, servers/gateway/models/runtime.js's startModel) that outlived
#     its gateway: it runs detached in its own process group precisely so a
#     gateway restart/swap doesn't kill an in-flight generation, but that
#     also means a gateway that died WITHOUT a clean stop() leaves it
#     running forever, holding a GPU/RAM allocation and a port reservation
#     no live process still owns. The cmdline match is a cheap first filter
#     (a llama-server invocation's argv always includes its own binPath,
#     which lives under <CROW_HOME>/runtimes/llamacpp/<release>/, whether or
#     not it's wrapped in `setpriv --pdeathsig=SIGTERM ...`); the exe/cwd
#     check is the actual identity proof — `setpriv` execve's the target
#     program, so /proc/<pid>/exe of the RUNNING process (setpriv-wrapped or
#     not) always resolves to the real llama-server binary path, never to
#     setpriv's own path. Requiring that check (not just the cmdline regex)
#     means a process that merely happens to mention that path in an
#     unrelated argument can never be swept.
#
#     ADOPTION CROSS-CHECK (fix round 1, Critical finding): `setpriv
#     --pdeathsig=SIGTERM` and startModel's own SIGTERM-the-group `stop()`
#     path mean a llama-server almost always dies WITH its gateway — but
#     that's a mitigation, not a guarantee (setpriv can be absent on the
#     host, or lose the pdeathsig race on a hard crash), and when it
#     survives, the RESTARTED gateway can legitimately ADOPT it instead of
#     respawning: gpu-orchestrator.js's acquireOrStartNative calls
#     identityProbe first, and a "resident" result (the surviving process is
#     still correctly answering as the right alias) returns
#     `{freshStart:false}` WITHOUT ever touching `_nativeHandles` or calling
#     `startModel` again — traffic gets routed to it, but this pid's ppid
#     stays 1 forever and it is never back under any gateway's supervision.
#     `models/state.js`'s `reconcileOnBoot` already encodes the correct rule
#     for this exact situation ("a live provider row means the runtime is
#     still legitimately using that port even though the reserving pid is
#     gone" — see its doc) and deliberately does NOT free that reservation.
#     Sweep 3 mirrors that rule before ever signaling a candidate: derive
#     the candidate's own CROW_HOME from the SAME exe/cwd match above (the
#     path fragment before "/runtimes/llamacpp/" is exactly the `dir`
#     `state.js`'s `statePath(dir)` expects), parse the candidate's OWN
#     bound port from its OWN cmdline's "--port" flag (buildLlamaServerArgs
#     in runtime.js always includes it, setpriv-wrapped or not — chosen over
#     ss/lsof so this needs no extra host tool and reflects exactly what the
#     process was launched with, matching state.json's own semantics), and
#     if THAT CROW_HOME's models/state.json holds ANY reservation for that
#     port, the candidate is skipped (logged) as an adopted native model,
#     never signaled. Fails CLOSED on ambiguity: if the candidate's own
#     CROW_HOME or port can't be determined at all (a raced/vanished
#     process, an unexpected invocation shape), it is also skipped rather
#     than guessed — a wrongly-killed live model cannot be undone, while a
#     genuinely orphaned process just gets caught on the next sweep. A
#     reservation-less llama-server on a random port remains reapable (truly
#     abandoned — its reservation was deleted or never existed, i.e. the
#     state file is missing entirely OR it parsed cleanly with no match for
#     this port). Residual case, stated honestly: if a reservation IS
#     present but the model is actually dead (crashed without ever calling
#     releasePort), the process has already exited on its own — there is
#     nothing left for this sweep to kill either way, so skipping it here
#     costs nothing.
#
#     Fix round 2: a state file that EXISTS but fails to parse (corrupt
#     JSON, permission error, unexpected shape) is a DIFFERENT case from
#     "confirmed no reservation" and must never be silently treated as one —
#     `port_reserved_model`'s node helper returns a distinct exit code for
#     it (2, vs. 1 for a confirmed clean miss) specifically so this can't
#     degrade into "couldn't read it, so assume unreserved, so kill it,"
#     which would defeat the whole point of this cross-check. That case
#     fails CLOSED too (skipped, logged) — the same fail-closed principle as
#     an undeterminable CROW_HOME/port above.
#
# PROTECTION (checked at candidate selection AND before every signal):
#   1. systemd-owned: any process whose /proc/<pid>/cgroup places it inside a
#      *.service cgroup belongs to systemd — in EVERY unit state. This is the
#      load-bearing guard: every systemd MainPID has ppid==1 (systemd IS pid
#      1), a unit in `deactivating` (draining through gracefulShutdown) is
#      excluded from an --state=active MainPID whitelist, and on hosts where
#      ExecStart is an npm/sh wrapper the REAL gateway node process is not the
#      MainPID at all. The cgroup test covers all of those; session scopes
#      (session-*.scope — where detached scratch orphans live) do not match.
#   2. MainPID whitelist of active crow-*gateway*/crow-mcp-bridge* units —
#      redundant with (1), kept as a second layer.
#   3. CROW_ALLOW_ORPHAN=1 in /proc/<pid>/environ: explicit operator opt-out
#      for deliberately detached gateways (same contract as parent-watch.js).
#      environ reflects exec-time env, which is exactly when the opt-out is
#      set. Readable same-uid (ExecStartPre) and as root (the sweep timer).
#   4. This script's own pid + full ancestor chain.
#
# Pid-reuse safety: each victim is captured as pid:starttime (field 22 of
# /proc/<pid>/stat); the starttime is re-verified immediately before EVERY
# signal, so a recycled pid can never be killed by a stale snapshot.
#
# NOTE on intent: a gateway backgrounded with nohup (but not systemd) dies
# with its shell via parent-watch.js, and a fully detached one is reaped here
# within a minute. That inversion of nohup's usual promise is the point of
# this guard — export CROW_ALLOW_ORPHAN=1 to opt a deliberate daemon out.
# The 2s TERM→KILL grace is shorter than the gateway's own ≤13s drain; an
# orphan's children already got TERM first and SQLite WAL is crash-safe.
#
# Environment seams (all optional, safe defaults):
#   ORPHAN_MATCH_PATTERN   regex (pgrep -f) selecting gateway processes.
#                          Default: node.*servers/gateway/index\.js
#   ORPHAN_BUNDLE_PATTERN  regex (pgrep -f) selecting bundle-child processes
#                          for sweep 2. Default: node server/index\.js
#   ORPHAN_NATIVE_PATTERN  regex (pgrep -f) selecting candidate native model
#                          runtime processes for sweep 3 (see above — cmdline
#                          match is only the first filter, exe/cwd is the
#                          real identity check). Default: runtimes/llamacpp
#   ORPHAN_DRY_RUN         set to 1 to only PRINT the victims (pid + cmdline);
#                          nothing is signalled. Default: 0
#
# Introspection: `kill-orphan-gateways.sh --owned-check <pid>` exits 0 if the
# pid is systemd-owned (*.service cgroup), 1 otherwise — lets tests exercise
# the protection helper directly against real unit pids.
#
# Logs via `logger -t orphan-gateway-killer` (and stdout for journal capture).

set -u

MATCH_PATTERN="${ORPHAN_MATCH_PATTERN:-node.*servers/gateway/index\.js}"
BUNDLE_PATTERN="${ORPHAN_BUNDLE_PATTERN:-node server/index\.js}"
NATIVE_PATTERN="${ORPHAN_NATIVE_PATTERN:-runtimes/llamacpp}"
DRY_RUN="${ORPHAN_DRY_RUN:-0}"

log() {
  logger -t orphan-gateway-killer -- "$*" 2>/dev/null || true
  echo "orphan-gateway-killer: $*"
}

# ppid of a pid, parsed robustly from /proc/<pid>/stat (comm may contain
# spaces, so split after the last ')').
ppid_of() {
  local stat rest
  stat=$(cat "/proc/$1/stat" 2>/dev/null) || return 1
  rest=${stat##*) }
  # rest = "<state> <ppid> ..." — deliberately unquoted: this splits rest
  # into positional fields on whitespace, which is the whole point here.
  # shellcheck disable=SC2086
  set -- $rest
  echo "$2"
}

# starttime (clock ticks since boot) — field 22 of /proc/<pid>/stat, i.e.
# field 20 of the post-comm remainder. Unique per pid incarnation.
starttime_of() {
  local stat rest
  stat=$(cat "/proc/$1/stat" 2>/dev/null) || return 1
  rest=${stat##*) }
  # shellcheck disable=SC2086  # deliberate field-split, see ppid_of above
  set -- $rest
  echo "${20}"
}

cmdline_of() {
  tr '\0' ' ' < "/proc/$1/cmdline" 2>/dev/null || echo "?"
}

alive() { [ -d "/proc/$1" ]; }

# True iff pid's exe symlink OR cwd symlink contains "/runtimes/llamacpp/"
# — the actual identity proof for sweep 3 (see the header comment on why
# this, not just the cmdline pattern, is what makes a candidate real).
# Any CROW_HOME: this is a substring test, never anchored to ~/.crow.
exe_or_cwd_under_native_runtimes() {
  local target
  target=$(readlink "/proc/$1/exe" 2>/dev/null) || target=""
  case "$target" in
    */runtimes/llamacpp/*) return 0 ;;
  esac
  target=$(readlink "/proc/$1/cwd" 2>/dev/null) || target=""
  case "$target" in
    */runtimes/llamacpp/*) return 0 ;;
  esac
  return 1
}

# The CROW_HOME implied by a native-runtime candidate's exe/cwd — the path
# fragment BEFORE "/runtimes/llamacpp/" (same exe-then-cwd precedence as
# exe_or_cwd_under_native_runtimes). This is exactly the `dir` argument
# `models/state.js`'s `statePath(dir)` expects (`<dir>/models/state.json`),
# since `ensureRuntime` in runtime.js builds the binary path as
# `<dir>/runtimes/llamacpp/<release>/...` from that very same `dir`. Prints
# nothing and returns 1 if neither exe nor cwd matches (fail closed — see
# the adoption cross-check in the header comment).
native_crow_home_of() {
  local target
  target=$(readlink "/proc/$1/exe" 2>/dev/null) || target=""
  case "$target" in
    */runtimes/llamacpp/*) echo "${target%%/runtimes/llamacpp/*}"; return 0 ;;
  esac
  target=$(readlink "/proc/$1/cwd" 2>/dev/null) || target=""
  case "$target" in
    */runtimes/llamacpp/*) echo "${target%%/runtimes/llamacpp/*}"; return 0 ;;
  esac
  return 1
}

# The port a native-runtime candidate was told to bind, parsed from its OWN
# cmdline's "--port" flag (buildLlamaServerArgs in runtime.js always
# includes literal "--port <port>", whether or not setpriv wraps the
# invocation). Chosen over ss/lsof: no extra host tool required, and this
# reflects exactly what the process was launched with — the same thing
# state.json's reservation records, not a live socket scrape that could in
# principle diverge (a process bound to a DIFFERENT port than it was told
# to would fail identityProbe's caller anyway). Prints nothing and returns
# 1 if "--port" isn't found (a raced/vanished process, or an unexpected
# invocation shape) — fail closed, never guess.
native_port_of() {
  local cmdline prev=""
  cmdline=$(cmdline_of "$1")
  # shellcheck disable=SC2086  # deliberate field-split to walk argv tokens
  set -- $cmdline
  while [ "$#" -gt 0 ]; do
    if [ "$prev" = "--port" ]; then
      echo "$1"
      return 0
    fi
    prev="$1"
    shift
  done
  return 1
}

# Adoption cross-check (fix round 1, Critical finding — see the Sweep 3
# header comment for the full scenario): does `statePath`'s models/
# state.json hold ANY reservation for `port`? Exit code is a real 3-way
# result (fix round 2 — a corrupt state file must NOT silently degrade to
# "not reserved", or a state file corrupted at the wrong moment could get a
# legitimately-adopted model killed, defeating the whole point of this
# check):
#   0 = reserved — reserving modelId printed on stdout.
#   1 = CONFIRMED not reserved — the file is missing entirely (never had,
#       or had and lost, a reservation — explicitly fine to treat as
#       reapable, see the Sweep-3 header's "residual case" note) OR it
#       parsed cleanly with no matching port.
#   2 = UNKNOWN — the file exists but could not be read/parsed (corrupt
#       JSON, permission error, unexpected shape). Callers MUST treat this
#       as fail-closed (skip), never as "not reserved" — see the header
#       comment's fail-closed principle.
# Parsed with `node` rather than `jq`: every Crow host already requires
# node to run the gateway itself, so this adds no new host dependency (jq
# is NOT a guaranteed install-time dependency — confirmed absent from
# scripts/crow-install.sh).
port_reserved_model() {
  local state_path="$1" port="$2"
  [ -f "$state_path" ] || return 1
  node - "$state_path" "$port" <<'EOF' 2>/dev/null
const fs = require("node:fs");
try {
  const state = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  const port = parseInt(process.argv[3], 10);
  const reservations = (state && typeof state.reservations === "object" && state.reservations) || {};
  for (const [modelId, r] of Object.entries(reservations)) {
    if (r && r.port === port) {
      process.stdout.write(modelId);
      process.exit(0);
    }
  }
  process.exit(1);
} catch {
  process.exit(2);
}
EOF
}

# systemd-owned: the pid's cgroup path contains a *.service component.
systemd_owned() {
  grep -q '\.service' "/proc/$1/cgroup" 2>/dev/null
}

# Explicit operator opt-out (exec-time env; NUL-separated records).
allow_orphan() {
  grep -zq '^CROW_ALLOW_ORPHAN=1$' "/proc/$1/environ" 2>/dev/null
}

if [ "${1:-}" = "--owned-check" ]; then
  systemd_owned "${2:?usage: --owned-check <pid>}" && exit 0
  exit 1
fi

# --- Whitelist: active crow service MainPIDs + self + ancestors -------------
WHITELIST=" "

for unit in $(systemctl list-units --type=service --state=active --no-legend --plain \
                'crow-*gateway*.service' 'crow-mcp-bridge*.service' 2>/dev/null \
                | awk '{print $1}'); do
  mainpid=$(systemctl show -p MainPID --value "$unit" 2>/dev/null)
  if [ -n "${mainpid:-}" ] && [ "$mainpid" != "0" ]; then
    WHITELIST="${WHITELIST}${mainpid} "
  fi
done

# Never kill ourselves or anything above us (shell, terminal, session leader).
p=$$
while [ -n "$p" ] && [ "$p" -gt 1 ] 2>/dev/null; do
  WHITELIST="${WHITELIST}${p} "
  p=$(ppid_of "$p") || break
done

whitelisted() { case "$WHITELIST" in *" $1 "*) return 0 ;; *) return 1 ;; esac; }

# Every protection, one place. Checked at candidate selection and again
# before EVERY signal (a descendant could be a systemd unit's process, and
# the tree snapshot could be stale).
protected() {
  whitelisted "$1" && return 0
  systemd_owned "$1" && return 0
  allow_orphan "$1" && return 0
  return 1
}

# --- Subtree enumeration (children-first / deepest-first order) --------------
descendants_of() {
  local parent=$1 child
  for child in $(pgrep -P "$parent" 2>/dev/null); do
    descendants_of "$child"
    echo "$child"
  done
}

# Build "pid:starttime" tokens for a whitespace-separated pid list; pids that
# vanish between enumeration and stamping are silently dropped.
stamp_pids() {
  local pid st
  for pid in $1; do
    st=$(starttime_of "$pid") || continue
    echo "$pid:$st"
  done
}

# Same incarnation as when we enumerated it?
same_incarnation() { # $1=pid $2=starttime
  [ "$(starttime_of "$1" 2>/dev/null)" = "$2" ]
}

# TERM the given pid:starttime tokens (children-first order expected), wait
# ~2s, KILL survivors. Re-checks protection AND starttime before each signal.
reap_tree() {
  local tokens="$1" reason="$2" tok pid st sent=0
  if [ "$DRY_RUN" = "1" ]; then
    for tok in $tokens; do
      pid=${tok%%:*}; st=${tok##*:}
      protected "$pid" && continue
      same_incarnation "$pid" "$st" || continue
      log "DRY RUN — would kill pid $pid ($reason): $(cmdline_of "$pid")"
    done
    return 0
  fi
  for tok in $tokens; do
    pid=${tok%%:*}; st=${tok##*:}
    protected "$pid" && continue
    same_incarnation "$pid" "$st" || continue
    log "SIGTERM pid $pid ($reason): $(cmdline_of "$pid")"
    kill -TERM "$pid" 2>/dev/null && sent=1
  done
  [ "$sent" = "1" ] || return 0
  sleep 2
  for tok in $tokens; do
    pid=${tok%%:*}; st=${tok##*:}
    protected "$pid" && continue
    same_incarnation "$pid" "$st" || continue
    if alive "$pid"; then
      log "SIGKILL survivor pid $pid ($reason)"
      kill -KILL "$pid" 2>/dev/null || true
    fi
  done
}

# --- Sweep 1: orphaned gateways (ppid==1), whole subtree ---------------------
for pid in $(pgrep -f "$MATCH_PATTERN" 2>/dev/null); do
  [ "$pid" = "$$" ] && continue
  protected "$pid" && continue
  ppid=$(ppid_of "$pid") || continue
  [ "$ppid" = "1" ] || continue
  # Children first, gateway itself last — killing the gateway first would
  # re-parent its bundle children to init and their DB locks would survive.
  tree="$(stamp_pids "$(descendants_of "$pid") $pid")"
  log "orphan gateway pid $pid (ppid=1) — reaping subtree: $(echo "$tree" | tr '\n' ' ')"
  reap_tree "$tree" "orphan gateway subtree"
done

# --- Sweep 2: already-orphaned bundle children (ppid==1, cwd in /bundles/) ---
for pid in $(pgrep -f "$BUNDLE_PATTERN" 2>/dev/null); do
  [ "$pid" = "$$" ] && continue
  protected "$pid" && continue
  ppid=$(ppid_of "$pid") || continue
  [ "$ppid" = "1" ] || continue
  cwd=$(readlink "/proc/$pid/cwd" 2>/dev/null) || continue
  case "$cwd" in
    */bundles/*) ;;
    *) continue ;;
  esac
  tree="$(stamp_pids "$(descendants_of "$pid") $pid")"
  log "orphaned bundle child pid $pid (ppid=1, cwd=$cwd) — reaping"
  reap_tree "$tree" "orphaned bundle child"
done

# --- Sweep 3: orphaned native model runtime processes (ppid==1, exe/cwd
# under ANY CROW_HOME's runtimes/llamacpp/) — Item G, Task 14 ----------------
for pid in $(pgrep -f "$NATIVE_PATTERN" 2>/dev/null); do
  [ "$pid" = "$$" ] && continue
  protected "$pid" && continue
  ppid=$(ppid_of "$pid") || continue
  [ "$ppid" = "1" ] || continue
  exe_or_cwd_under_native_runtimes "$pid" || continue

  # Adoption cross-check (fix round 1) — see the Sweep 3 header comment.
  # Fail CLOSED: if this candidate's own CROW_HOME or bound port can't be
  # determined, skip rather than guess.
  native_home=$(native_crow_home_of "$pid")
  native_port=$(native_port_of "$pid")
  if [ -z "$native_home" ] || [ -z "$native_port" ]; then
    log "skipping native model runtime pid $pid — could not determine its own CROW_HOME/port, refusing to guess"
    continue
  fi
  reserved_model=$(port_reserved_model "${native_home}/models/state.json" "$native_port")
  reserved_rc=$?
  if [ "$reserved_rc" = "0" ]; then
    log "skipping adopted native model on port $native_port (reserved for '$reserved_model' in ${native_home}/models/state.json) — pid $pid"
    continue
  elif [ "$reserved_rc" != "1" ]; then
    # Fix round 2: exit 2 (state file exists but unreadable/corrupt) or any
    # other unexpected code must NEVER be treated as "confirmed not
    # reserved" — only a real exit 1 (missing file, or a clean parse with no
    # match) means that. Fail CLOSED, same principle as the CROW_HOME/port
    # check above: a state file corrupted at the wrong moment must not cost
    # a live, adopted model its life.
    log "skipping native model runtime pid $pid — ${native_home}/models/state.json unreadable, refusing to guess"
    continue
  fi

  # A native runtime process has no children of its own to worry about
  # (unlike the gateway/bundle sweeps, there is no downstream lock-holder
  # depending on it), but stamp+reap through the same single-pid "tree" for
  # a uniform, already-hardened code path (protection + starttime
  # re-verification on every signal).
  tree="$(stamp_pids "$pid")"
  log "orphaned native model runtime pid $pid (ppid=1) — reaping: $(cmdline_of "$pid")"
  reap_tree "$tree" "orphaned native model runtime"
done

exit 0
