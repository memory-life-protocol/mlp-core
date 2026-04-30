/**
 * AnthropicExtractionAdapter
 *
 * Implements ExtractionAdapter using the Anthropic API.
 * Uses claude-3-5-haiku-20241022 — fast, cheap, accurate
 * for structured extraction tasks.
 *
 * What it does:
 *   - Makes one API call per encode operation
 *   - Sends a structured prompt that extracts dimensions
 *     exactly as present in the input
 *   - Never invents. Never infers beyond what is stated.
 *   - Returns a valid ExtractionResult or throws
 *
 * What it does not do:
 *   - It does not import the Anthropic SDK
 *   - It uses native fetch only — zero extra dependencies
 *   - It does not cache or batch requests
 *   - It does not retry on failure — let the caller handle that
 *
 * To use a different LLM provider:
 *   Implement ExtractionAdapter with a different fetch target.
 *   Nothing else in the protocol changes.
 */

import type {
  ExtractionAdapter,
  ExtractionResult
} from '../interfaces/ExtractionAdapter.js'

const EXTRACTION_PROMPT = `You are an encoding engine for a memory protocol.
Extract the following from the input exactly as present.
Do not invent. Do not infer beyond what is stated.
Do not add context that is not explicitly in the input.

Return only valid JSON with no markdown, no backticks, no explanation.
Return exactly this structure:
{
  "what": "the core knowledge — one to three sentences maximum",
  "why": "the intent or reason — one to three sentences, null if not present",
  "module": "which product area this belongs to or null if not stated",
  "workflow": "which workflow this relates to or null if not stated",
  "connections_implied": ["list of concepts explicitly referenced in the input"],
  "significance_hint": "high if critical/must/never/always language, low if minor, medium otherwise"
}`

interface AnthropicExtractionConfig {
  apiKey: string
  model?: string
}

export class AnthropicExtractionAdapter implements ExtractionAdapter {
  readonly modelName: string
  readonly provider = 'anthropic'

  private apiKey: string

  constructor(config: AnthropicExtractionConfig) {
    if (!config.apiKey) {
      throw new Error(
        'AnthropicExtractionAdapter requires ANTHROPIC_API_KEY'
      )
    }
    this.apiKey = config.apiKey
    this.modelName = config.model ?? 'claude-3-5-haiku-20241022'
  }

  async extract(raw: string): Promise<ExtractionResult> {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: this.modelName,
        max_tokens: 1024,
        messages: [
          {
            role: 'user',
            content: `${EXTRACTION_PROMPT}\n\nInput:\n${raw}`
          }
        ]
      })
    })

    if (!response.ok) {
      const error = await response.text()
      throw new Error(
        `Anthropic API error ${response.status}: ${error}`
      )
    }

    const data = await response.json() as {
      content: Array<{ type: string; text: string }>
    }

    const text = data.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('')
      .trim()

    let parsed: any
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new Error(
        `Extraction returned invalid JSON: ${text.substring(0, 200)}`
      )
    }

    // Validate and normalise the response
    return {
      what: String(parsed.what ?? '').trim() || raw.substring(0, 150),
      why: parsed.why ? String(parsed.why).trim() : null,
      module: parsed.module ? String(parsed.module).trim() : null,
      workflow: parsed.workflow ? String(parsed.workflow).trim() : null,
      connections_implied: Array.isArray(parsed.connections_implied)
        ? parsed.connections_implied
            .map((c: any) => String(c).trim())
            .filter(Boolean)
        : [],
      significance_hint: (
        parsed.significance_hint === 'high' ||
        parsed.significance_hint === 'low'
          ? parsed.significance_hint
          : 'medium'
      ) as 'high' | 'medium' | 'low'
    }
  }
}
