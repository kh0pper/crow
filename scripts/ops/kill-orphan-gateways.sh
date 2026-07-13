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
  # rest = "<state> <ppid> ..."
  set -- $rest
  echo "$2"
}

# starttime (clock ticks since boot) — field 22 of /proc/<pid>/stat, i.e.
# field 20 of the post-comm remainder. Unique per pid incarnation.
starttime_of() {
  local stat rest
  stat=$(cat "/proc/$1/stat" 2>/dev/null) || return 1
  rest=${stat##*) }
  set -- $rest
  echo "${20}"
}

cmdline_of() {
  tr '\0' ' ' < "/proc/$1/cmdline" 2>/dev/null || echo "?"
}

alive() { [ -d "/proc/$1" ]; }

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
  log "orphan gateway pid $pid (ppid=1) — reaping subtree: $(echo $tree | tr '\n' ' ')"
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

exit 0
