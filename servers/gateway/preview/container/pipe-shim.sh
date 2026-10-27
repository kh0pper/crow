#!/bin/sh
# Chromium reads CDP on fd 3 (the container's stdin) and writes it on fd 4 (its stdout),
# NUL-delimited JSON; its own logs go to stderr. The real binary, never the
# /usr/bin/chromium wrapper, so nothing in /etc/chromium.d can add flags.
exec /usr/lib/chromium/chromium --headless=new --remote-debugging-pipe --user-data-dir=/tmp/profile --no-first-run --disable-extensions --disable-sync --disable-background-networking --disable-component-update --disable-crash-reporter --disable-dev-shm-usage --dns-prefetch-disable --host-resolver-rules="MAP * ~NOTFOUND, EXCLUDE ${CROW_PREVIEW_ARTIFACT_HOST}" --mute-audio about:blank 3<&0 4>&1 1>/dev/null 0</dev/null
