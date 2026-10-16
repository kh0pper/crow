# Design kit renderer (spec §3.3). Base image (multi-arch index digest) and D2
# (version + per-arch tarball sha256, cross-checked against upstream SHA256SUMS)
# are pinned; tests/design-kit-container.test.js enforces both pins.
#
# Chromium is not pinned, by decision: Debian ships it through bookworm-security,
# which keeps only the newest build (155.0.8059.39-1~deb12u1 at the time of
# writing), so a pinned `chromium=<ver>` would stop building at the next security
# update. Accepted drift: each build takes Debian's current, patched Chromium;
# the version that was installed is recorded in /chromium-version.txt in the image.
FROM node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5
ARG TARGETARCH
ARG D2_VERSION=0.9.0
RUN apt-get update \
 && apt-get install -y --no-install-recommends chromium fonts-dejavu-core fonts-liberation util-linux ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*
COPY d2.sha256 /tmp/d2.sha256
RUN curl -fsSL -o /tmp/d2-${TARGETARCH}.tar.gz "https://github.com/d2lang/d2/releases/download/v${D2_VERSION}/d2-v${D2_VERSION}-linux-${TARGETARCH}.tar.gz" \
 && grep " /tmp/d2-${TARGETARCH}.tar.gz\$" /tmp/d2.sha256 | sha256sum -c - \
 && tar -xzf /tmp/d2-${TARGETARCH}.tar.gz -C /tmp \
 && install -m 0755 /tmp/d2-v${D2_VERSION}/bin/d2 /usr/local/bin/d2 \
 && rm -rf /tmp/d2-* /tmp/d2.sha256 \
 && apt-get purge -y curl && apt-get autoremove -y \
 && chromium --version > /chromium-version.txt
WORKDIR /renderer
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && test -f node_modules/mermaid/dist/mermaid.min.js && npm cache clean --force
COPY *.mjs ./
COPY engines ./engines
ENV CHROMIUM_PATH=/usr/bin/chromium HOME=/tmp NODE_ENV=production
USER node
EXPOSE 8018
CMD ["node", "main.mjs"]
