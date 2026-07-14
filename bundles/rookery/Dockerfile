FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      curl ca-certificates git \
    && rm -rf /var/lib/apt/lists/*
RUN npm install -g @synsci/openscience@1.3.2
COPY host-shim.mjs /app/host-shim.mjs
COPY entrypoint.sh /app/entrypoint.sh
COPY wrapper-exec.sh /app/wrapper-exec.sh
COPY scrub-env.sh /app/scrub-env.sh
RUN chmod +x /app/entrypoint.sh /app/wrapper-exec.sh \
    && mkdir -p /data /workspaces \
    && chown -R 1000:1000 /data /workspaces /app
ENV HOME=/data
EXPOSE 3061
USER 1000:1000
ENTRYPOINT ["/app/entrypoint.sh"]
