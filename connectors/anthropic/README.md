# Anthropic Connector

Reference implementation of EmbeddingAdapter and ExtractionAdapter
using the Anthropic API.

## EmbeddingAdapter
File: embedder.ts
Model: voyage-3
Dimension: 1024
Requires: ANTHROPIC_API_KEY

## ExtractionAdapter
File: extractor.ts
Model: claude-3-5-haiku-20241022
Requires: ANTHROPIC_API_KEY

## Swap this connector
Implement EmbeddingAdapter or ExtractionAdapter from
src/interfaces/ with any provider.
OpenAI, Cohere, Ollama, or any local model works.
Nothing else in the protocol changes.
