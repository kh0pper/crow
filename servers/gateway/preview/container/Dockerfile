# Crow's preview renderer: Debian's Chromium, headless, driven over --remote-debugging-pipe
# by the gateway (servers/gateway/preview/). No network, no port, no display: the compose
# file runs it with network_mode none, read-only, all capabilities dropped and the
# seccomp-chrome.json profile, and Chromium keeps its own sandbox.
#
# The base digest is pinned and updated deliberately (a new digest changes the image tag,
# which hashes this file).
FROM debian:bookworm-slim@sha256:7ff6ba31527b9e336162fa061746c366c4b2032f4d2cff2078bea43f78efe3f8

RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      chromium fonts-dejavu-core fonts-noto-core ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --uid 10001 --user-group --no-create-home --home-dir /tmp --shell /usr/sbin/nologin render

COPY pipe-shim.sh /usr/local/bin/pipe-shim.sh
RUN chmod 0555 /usr/local/bin/pipe-shim.sh

ENV HOME=/tmp XDG_CONFIG_HOME=/tmp/.config XDG_CACHE_HOME=/tmp/.cache XDG_RUNTIME_DIR=/tmp/run
USER 10001:10001
ENTRYPOINT ["/usr/local/bin/pipe-shim.sh"]
