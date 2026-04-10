FROM pytorch/pytorch:2.1.2-cuda12.1-cudnn8-runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir \
    diffusers \
    transformers \
    accelerate \
    Pillow \
    fastapi \
    uvicorn \
    pydantic

WORKDIR /app
COPY scripts/sdxl-service.py /app/sdxl-service.py

RUN mkdir -p /app/backgrounds/gallery /app/models

EXPOSE 3005

CMD ["python", "sdxl-service.py"]
