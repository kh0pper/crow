# Build scratch-gui from source, serve the resulting static bundle with nginx.
# First build on a Pi 4 takes ~10-15 min; on x86 ~2 min. Build artifacts are
# discarded — only the ~30-50 MB of static HTML/JS/CSS ships in the runtime
# image.

# ---- Stage 1: build ------------------------------------------------
FROM node:20-bullseye AS build

ARG SCRATCH_GUI_REF=master
ENV CI=true

WORKDIR /src
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
RUN git clone --depth=1 --branch "${SCRATCH_GUI_REF}" https://github.com/scratchfoundation/scratch-gui.git .

# scratch-gui's package-lock is strict; npm ci is the right call.
RUN npm ci --no-audit --no-fund --loglevel=error

# NODE_OPTIONS=--openssl-legacy-provider is required on Node 17+ because
# scratch-gui still uses webpack 4 with legacy OpenSSL hashing.
RUN NODE_OPTIONS=--openssl-legacy-provider npm run build

# ---- Stage 2: serve ------------------------------------------------
FROM nginx:1.27-alpine AS runtime

# Drop the default nginx page; copy the scratch-gui build artifacts in.
RUN rm -rf /usr/share/nginx/html/*
COPY --from=build /src/build/ /usr/share/nginx/html/

# Scratch's service worker uses long-cacheable hashed filenames, but the
# entry HTML needs no-cache to pick up new builds. Simple override:
RUN printf 'server {\n\
  listen 8080 default_server;\n\
  server_name _;\n\
  root /usr/share/nginx/html;\n\
  index index.html;\n\
  location = /index.html { add_header Cache-Control "no-cache"; }\n\
  location / { try_files $uri $uri/ /index.html; }\n\
}\n' > /etc/nginx/conf.d/default.conf

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://localhost:8080/ || exit 1
