FROM python:3.12-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
      curl libgomp1 libmupdf-dev \
    && rm -rf /var/lib/apt/lists/*

COPY pyproject.toml uv.lock* ./
RUN pip install --no-cache-dir uv && uv pip install --system .

COPY src/ ./src/

RUN mkdir -p /data && chown -R 1000:1000 /data /app

ENV PYTHONUNBUFFERED=1
EXPOSE 8000

USER 1000:1000

CMD ["uvicorn", "src.server:app", "--host", "0.0.0.0", "--port", "8000"]
