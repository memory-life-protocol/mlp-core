// What the extraction engine pulls from raw input.
// The LLM extracts exactly what is present.
// It never invents. It never infers beyond what is stated.

interface ExtractionResult {

  // The core knowledge — one to three sentences
  what: string

  // The intent or reason — null if not present in the input
  why: string | null

  // Which product area this belongs to — null if not stated
  module: string | null

  // Which workflow this relates to — null if not stated
  workflow: string | null

  // Concepts explicitly referenced in the input
  // These become candidate connections in the graph
  connections_implied: string[]

  // How significant this knowledge appears based on language used
  significance_hint: 'high' | 'medium' | 'low'

}

interface ExtractionAdapter {

  // Extract structured dimensions from raw text.
  // One call per encode operation.
  // Must not invent or infer beyond what is stated in the input.
  // Must return valid ExtractionResult or throw.
  extract(raw: string): Promise<ExtractionResult>

  // Human readable model name — stored for auditability.
  // Example: 'claude-3-5-haiku-20241022', 'gpt-4o-mini', 'llama-3'
  readonly modelName: string

  // Provider name — stored for auditability.
  // Example: 'anthropic', 'openai', 'ollama'
  readonly provider: string

}

export type { ExtractionAdapter, ExtractionResult }
