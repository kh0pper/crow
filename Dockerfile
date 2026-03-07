FROM node:20-slim

# Install Python 3 + uv (for uvx-based MCP servers like Google Workspace, Zotero, MCP Research)
# Also install curl for uv installer and git which some npx packages need
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-venv curl git \
    && rm -rf /var/lib/apt/lists/* \
    && curl -LsSf https://astral.sh/uv/install.sh | sh

# Add uv/uvx to PATH
ENV PATH="/root/.local/bin:${PATH}"

WORKDIR /app

# Install Node dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Copy server code
COPY servers/ servers/
COPY scripts/init-db.js scripts/

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
