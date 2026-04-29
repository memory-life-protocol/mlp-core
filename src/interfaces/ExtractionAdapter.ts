interface ExtractionResult {
  what: string
  why: string | null
  module: string | null
  workflow: string | null
  connections_implied: string[]
  significance_hint: 'high' | 'medium' | 'low'
}

interface ExtractionAdapter {

  // Extract structured dimensions from raw text
  // One call per encode operation
  // Must not invent or infer beyond what is stated in the text
  extract(raw: string): Promise<ExtractionResult>

  // Human readable model name — stored for auditability
  readonly modelName: string

  // Provider name — e.g. anthropic, openai, ollama
  readonly provider: string

}

export type { ExtractionAdapter, ExtractionResult }
