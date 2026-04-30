/**
 * StubExtractionAdapter
 *
 * A deterministic extraction adapter for development and testing.
 * No API calls. No external dependencies. Zero configuration.
 *
 * Parses structured key:value format if present.
 * Falls back to simple heuristics for free text.
 *
 * Replace with AnthropicExtractionAdapter in production.
 * In production the LLM extracts dimensions faithfully —
 * this stub only approximates that behaviour.
 */

import type {
  ExtractionAdapter,
  ExtractionResult
} from '../interfaces/ExtractionAdapter.js'

export class StubExtractionAdapter implements ExtractionAdapter {
  readonly modelName = 'stub-heuristic-v1'
  readonly provider = 'stub'

  async extract(raw: string): Promise<ExtractionResult> {
    const structured = parseStructured(raw)
    if (structured) return structured

    const sentences = raw
      .split(/[.!?]+/)
      .map(s => s.trim())
      .filter(Boolean)

    const lower = raw.toLowerCase()

    return {
      what: sentences[0] ?? raw.substring(0, 150),
      why: sentences[1] ?? null,
      module: inferModule(lower),
      workflow: inferWorkflow(lower),
      connections_implied: inferConnections(raw),
      significance_hint: inferSignificance(lower)
    }
  }
}

function parseStructured(raw: string): ExtractionResult | null {
  const fields: Record<string, string> = {}
  const lines = raw.split('\n')
  let current: string | null = null
  const buffer: string[] = []

  for (const line of lines) {
    const match = line.match(
      /^(what|why|module|workflow|connections|significance):\s*(.+)$/i
    )
    if (match) {
      if (current) fields[current] = buffer.join(' ').trim()
      current = match[1].toLowerCase()
      buffer.length = 0
      buffer.push(match[2].trim())
    } else if (current) {
      buffer.push(line.trim())
    }
  }
  if (current) fields[current] = buffer.join(' ').trim()
  if (!fields['what']) return null

  return {
    what: fields['what'],
    why: fields['why'] ?? null,
    module: fields['module'] ?? null,
    workflow: fields['workflow'] ?? null,
    connections_implied: fields['connections']
      ? fields['connections'].split(',').map(s => s.trim())
      : [],
    significance_hint: (
      fields['significance'] === 'high' ||
      fields['significance'] === 'medium' ||
      fields['significance'] === 'low'
        ? fields['significance']
        : 'medium'
    ) as 'high' | 'medium' | 'low'
  }
}

function inferModule(lower: string): string | null {
  if (/incident|alert|outage/.test(lower)) return 'incident'
  if (/task|assignment|assign/.test(lower)) return 'task'
  if (/permission|access|role/.test(lower)) return 'permissions'
  if (/billing|invoice|payment/.test(lower)) return 'billing'
  return null
}

function inferWorkflow(lower: string): string | null {
  if (/incident.*closure|close.*incident/.test(lower)) return 'incident-to-closure'
  if (/task.*assign|assign.*task/.test(lower)) return 'task-assignment'
  return null
}

function inferConnections(raw: string): string[] {
  const matches = raw.match(/["']([^"']{3,40})["']/g) ?? []
  return matches
    .map(m => m.replace(/["']/g, '').trim())
    .slice(0, 5)
}

function inferSignificance(lower: string): 'high' | 'medium' | 'low' {
  if (/critical|must|never|always|required|mandatory/.test(lower)) return 'high'
  if (/should|recommend|prefer|important/.test(lower)) return 'medium'
  return 'low'
}
