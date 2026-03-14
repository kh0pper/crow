## OpenClaw — Personal AI Assistant Gateway
##
## Builds an OpenClaw image from source.
## The gateway listens on port 18789 by default.
##
## Usage:
##   docker compose up --build -d

FROM node:20-slim

RUN apt-get update && \
    apt-get install -y --no-install-recommends git ca-certificates curl && \
    rm -rf /var/lib/apt/lists/*

# Clone OpenClaw source
ARG OPENCLAW_VERSION=main
RUN git clone --depth 1 --branch ${OPENCLAW_VERSION} \
    https://github.com/openclaw/openclaw.git /opt/openclaw

WORKDIR /opt/openclaw

# Install dependencies
RUN npm ci --omit=dev

# Config and workspace directories (bind-mounted at runtime)
RUN mkdir -p /root/.openclaw /workspace

EXPOSE 18789

# Start the OpenClaw gateway
CMD ["node", "src/gateway.js"]
