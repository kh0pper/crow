FROM node:20-slim

# Install Python 3 + uv (for uvx-based MCP servers like Google Workspace, Zotero, MCP Research)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv \
    && rm -rf /var/lib/apt/lists/* \
    && pip3 install --break-system-packages uv

WORKDIR /app

# Install Node dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Copy server code
COPY servers/ servers/
COPY scripts/init-db.js scripts/

# Copy MCP config (used by proxy to discover external servers)
COPY .mcp.json ./

# Initialize database
RUN mkdir -p data && node scripts/init-db.js

# Ensure npm/npx cache is writable for runtime package downloads
RUN mkdir -p /root/.npm && chmod -R 777 /root/.npm

# Expose gateway port
EXPOSE 3001

ENV CROW_TRANSPORT=http
ENV CROW_GATEWAY_PORT=3001
ENV CROW_DB_PATH=/app/data/crow.db

CMD ["node", "servers/gateway/index.js"]
