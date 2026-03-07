FROM node:20-slim

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Copy server code
COPY servers/ servers/
COPY scripts/init-db.js scripts/

# Initialize database
RUN mkdir -p data && node scripts/init-db.js

# Expose gateway port
EXPOSE 3001

ENV CROW_TRANSPORT=http
ENV CROW_GATEWAY_PORT=3001
ENV CROW_DB_PATH=/app/data/crow.db

CMD ["node", "servers/gateway/index.js"]
