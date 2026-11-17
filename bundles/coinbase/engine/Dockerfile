# Crow's Coinbase engine.
#
#   base    - the package and its runtime dependencies, from the locked requirements
#   test    - base + the dev extra + tests/ (CI runs pytest through uv; this stage is
#             what a container-based test run uses)
#   runtime - base as the unprivileged service: the LAST stage, so a plain
#             `docker build` yields it and docker-compose's `target: runtime` matches it

FROM python:3.12-slim AS base
WORKDIR /app
COPY pyproject.toml uv.lock ./
COPY src/ ./src/
RUN pip install --no-cache-dir uv && uv export --frozen --no-dev --no-hashes -o /tmp/req.txt && uv pip install --system -r /tmp/req.txt && uv pip install --system --no-deps .

FROM base AS test
ENV PYTHONDONTWRITEBYTECODE=1
# The project itself is already installed (base, --no-deps): only the dev extra is
# exported here, so the requirements file carries no project line.
RUN uv export --frozen --no-hashes --extra dev --no-emit-project -o /tmp/req-dev.txt && uv pip install --system -r /tmp/req-dev.txt
COPY tests/ ./tests/
# Nothing is written outside /tmp: no bytecode, no pytest cache.
CMD ["pytest", "-q", "-p", "no:cacheprovider"]

FROM base AS runtime
RUN mkdir -p /data && chown -R 1000:1000 /data /app
ENV PYTHONUNBUFFERED=1
USER 1000:1000
EXPOSE 3062
# Every interface INSIDE the container, so the published port reaches the app.
# The host side of the mapping is 127.0.0.1 only (docker-compose.yml).
CMD ["uvicorn", "--factory", "crow_coinbase.api:make_app", "--host", "0.0.0.0", "--port", "3062"]