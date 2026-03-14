---
name: localai
description: Local AI model management via LocalAI — OpenAI-compatible API for chat, embeddings, and TTS
triggers:
  - localai
  - local model
  - local ai
tools:
  - crow-memory
---

# LocalAI Management

## When to Activate

- User mentions LocalAI, local models, or running AI locally
- User wants an OpenAI-compatible local alternative
- User asks about embeddings or text generation without a cloud API

## Setup

LocalAI runs as a Docker container and provides an OpenAI-compatible API at `http://localhost:8080`.

### Connect to Crow's AI Chat

Set these in your `.env` or via the Settings panel:

```
AI_PROVIDER=openai
AI_BASE_URL=http://localhost:8080/v1
AI_MODEL=gpt-3.5-turbo
```

LocalAI maps standard OpenAI model names to local models. You can also use any model name installed in LocalAI.

### Model Management

Models are downloaded on first use. To pre-download:

```bash
docker compose exec localai local-ai models install llama3.2
```

## Tips

- LocalAI supports chat completions, embeddings, and text-to-speech
- CPU-only image works everywhere; GPU image requires nvidia-container-toolkit
- Default context size is 2048 tokens — increase `CONTEXT_SIZE` in docker-compose.yml for longer conversations
- Embedding models enable semantic memory search in Crow
