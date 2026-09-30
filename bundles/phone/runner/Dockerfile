FROM python:3.12-slim
WORKDIR /app
COPY pyproject.toml uv.lock* ./
COPY src/ ./src/
RUN pip install --no-cache-dir uv && uv pip install --system .
RUN mkdir -p /data && chown -R 1000:1000 /data /app
ENV PYTHONUNBUFFERED=1
USER 1000:1000
EXPOSE 3065
CMD ["uvicorn", "--factory", "crow_phone.app:make_app", "--host", "0.0.0.0", "--port", "3065"]
