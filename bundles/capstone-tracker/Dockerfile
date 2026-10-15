# Pinned to the exact Python + Debian release the running image was built on
# (Python 3.12.13, Debian 13 "trixie"); dependencies are pinned in
# constraints.txt. A digest pin can be added once the base is pulled locally.
FROM python:3.12.13-slim-trixie

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
      curl libgomp1 libmupdf-dev \
    && rm -rf /var/lib/apt/lists/*

# constraints.txt pins every installed version (captured from the image this
# replaces) so a rebuild does not silently re-resolve torch/transformers.
COPY pyproject.toml constraints.txt uv.lock* ./
RUN pip install --no-cache-dir uv==0.11.13 \
    && uv pip install --system -c constraints.txt .

COPY src/ ./src/

RUN mkdir -p /data && chown -R 1000:1000 /data /app

ENV PYTHONUNBUFFERED=1
EXPOSE 8000

USER 1000:1000

CMD ["uvicorn", "src.server:app", "--host", "0.0.0.0", "--port", "8000"]
