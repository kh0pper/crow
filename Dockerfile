FROM node:24-slim

# Python 3 + uv (for uvx-based MCP servers like Google Workspace, Zotero, MCP Research).
# uv is copied from its published image, pinned to one version AND one digest, so
# no installer script is downloaded and run here. curl stays installed for other
# tooling, and libatomic1 is what rocksdb-native's prebuild links against; git is
# needed by some npx packages.
# The container still runs as root on purpose: the documented usage execs
# `cat /root/.crow/setup-token` and bind-mounts ./data. Moving to a non-root USER
# is a deliberate follow-up that has to come with those paths reworked.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-venv curl git libatomic1 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=ghcr.io/astral-sh/uv:0.13.7@sha256:96f40d3904aad8d0bd010539001d36c8e2188b981e1334471a90c4a1d93bb490 /uv /uvx /bin/

WORKDIR /app

# Install Node dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Copy the whole build context: init-db and the gateway reach well beyond
# servers/ — scripts/, the migrations it walks, bundles/ and registry/ are all
# imported at runtime. .dockerignore keeps secrets, data and junk out.
COPY . .

# Initialize database
RUN mkdir -p data && node scripts/init-db.js

# Ensure npm/npx cache is writable for runtime package downloads
RUN mkdir -p /root/.npm && chmod -R 755 /root/.npm

# Expose gateway port
EXPOSE 3001

ENV CROW_TRANSPORT=http
ENV CROW_GATEWAY_PORT=3001
ENV CROW_DB_PATH=/app/data/crow.db

CMD ["node", "servers/gateway/index.js"]
