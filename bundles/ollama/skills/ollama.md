---
name: ollama
description: Use local AI models via Ollama for embeddings, summarization, and classification
triggers:
  - ollama
  - local model
  - run locally
  - embeddings
  - local AI
tools:
  - crow-memory
---

# Ollama Integration

## When to Activate

- User wants to run AI tasks locally (privacy-sensitive content)
- User asks about Ollama, local models, or embeddings
- User wants to generate embeddings for memory search enhancement
- User wants to summarize or classify content without sending it to external APIs

## How It Works

Ollama runs as a local HTTP API server. The primary AI (Claude, ChatGPT, etc.) calls Ollama's endpoints for specific tasks — it does NOT route its own inference to Ollama.

**Base URL:** `OLLAMA_HOST` environment variable (default: `http://localhost:11434`)

## Workflow 1: Generate Text with a Local Model

Use Ollama to process content that should stay local:

```
POST ${OLLAMA_HOST}/api/generate
{
  "model": "llama3.2",
  "prompt": "Summarize this document: ...",
  "stream": false
}
```

Good for:
- Summarizing private/sensitive documents
- Classifying content categories
- Extracting key phrases from local files

## Workflow 2: Generate Embeddings

Use Ollama for embeddings (useful for semantic search over memories):

```
POST ${OLLAMA_HOST}/api/embed
{
  "model": "nomic-embed-text",
  "input": "Text to embed"
}
```

## Workflow 3: List and Manage Models

```
GET ${OLLAMA_HOST}/api/tags          # List installed models
POST ${OLLAMA_HOST}/api/pull         # Download a model
  { "name": "llama3.2" }
DELETE ${OLLAMA_HOST}/api/delete     # Remove a model
  { "name": "model-name" }
```

## Recommended Models

| Model | Size | Use Case |
|---|---|---|
| `llama3.2` | 2-3 GB | General text generation, summarization |
| `nomic-embed-text` | 275 MB | Text embeddings for semantic search |
| `mistral` | 4 GB | Code and technical content |

## Tips

- Always check if Ollama is running before making API calls — `GET ${OLLAMA_HOST}/api/tags`
- Models must be pulled before first use — guide the user through `ollama pull <model>`
- Ollama runs on CPU by default. GPU passthrough dramatically improves speed.
- For Raspberry Pi / ARM64: use smaller models (llama3.2:1b, phi3:mini)
- Store model preferences in Crow memory so the right model is used automatically

## Error Handling

- If Ollama is unreachable: "Ollama doesn't seem to be running. Start it with `ollama serve` or `docker compose up -d` in the ollama bundle directory."
- If model not found: "That model isn't installed yet. Pull it with `ollama pull <model-name>`."
