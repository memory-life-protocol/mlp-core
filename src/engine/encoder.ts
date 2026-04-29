/**
 * Encoder
 *
 * Takes raw input and produces a structured Cluster.
 * Extracts: summary, intent, rationale, domain, tags.
 * Generates embedding via the injected EmbeddingAdapter.
 * Finds connections via vector similarity on the StorageAdapter.
 *
 * No storage driver imported. No embedding SDK imported.
 * Pure logic operating on injected adapters.
 */

import { randomUUID } from 'crypto';
import type { Cluster, Connection, EncodeInput } from '../interfaces/types.js';
import type { StorageAdapter } from '../interfaces/StorageAdapter.js';
import type { EmbeddingAdapter } from '../interfaces/EmbeddingAdapter.js';

export interface EncoderConfig {
  storage: StorageAdapter;
  embedder: EmbeddingAdapter;

  /**
   * How many existing clusters to check for connections
   * when connectTo is not explicitly provided.
   */
  autoConnectTopK?: number;

  /**
   * Minimum similarity score (0–1) to auto-create a connection.
   */
  autoConnectThreshold?: number;
}

export interface EncodeResult {
  cluster: Cluster;
  connectionsCreated: number;
}

export class Encoder {
  private storage: StorageAdapter;
  private embedder: EmbeddingAdapter;
  private autoConnectTopK: number;
  private autoConnectThreshold: number;

  constructor(config: EncoderConfig) {
    this.storage = config.storage;
    this.embedder = config.embedder;
    this.autoConnectTopK = config.autoConnectTopK ?? 5;
    this.autoConnectThreshold = config.autoConnectThreshold ?? 0.75;
  }

  async encode(input: EncodeInput): Promise<EncodeResult> {
    // 1. Extract dimensions from raw content
    const dimensions = this.extractDimensions(input);

    // 2. Generate embedding for semantic search
    const embeddingText = `${dimensions.summary} ${dimensions.intent} ${dimensions.rationale}`;
    const embedding = await this.embedder.embed(embeddingText);

    // 3. Build the cluster
    const cluster: Cluster = {
      id: randomUUID(),
      summary: dimensions.summary,
      intent: dimensions.intent,
      rationale: dimensions.rationale,
      domain: input.domain ?? dimensions.inferredDomain,
      tags: [...(input.tags ?? []), ...dimensions.inferredTags],
      timestamp: new Date().toISOString(),
      strength: 1.0,
      embedding,
    };

    // 4. Store it
    await this.storage.storeCluster(cluster);

    // 5. Resolve connections
    let connectionsCreated = 0;

    if (input.connectTo && input.connectTo.length > 0) {
      // Explicit connections provided — trust them
      for (const targetId of input.connectTo) {
        const connection: Connection = {
          fromId: cluster.id,
          toId: targetId,
          relationshipType: 'related',
          weight: 1.0,
          activations: 1,
        };
        await this.storage.storeConnection(connection);
        connectionsCreated++;
      }
    } else {
      // Auto-connect: find similar clusters by vector similarity
      const similar = await this.storage.vectorSearch(embedding, this.autoConnectTopK);

      for (const candidate of similar) {
        if (candidate.id === cluster.id) continue;
        if (candidate.score < this.autoConnectThreshold) continue;

        const relationshipType = this.inferRelationshipType(cluster, candidate);

        const connection: Connection = {
          fromId: cluster.id,
          toId: candidate.id,
          relationshipType,
          weight: candidate.score, // initial weight = similarity score
          activations: 1,
        };
        await this.storage.storeConnection(connection);
        connectionsCreated++;
      }
    }

    return { cluster, connectionsCreated };
  }

  /**
   * Extract structured dimensions from raw content.
   *
   * In v1 this uses heuristic parsing.
   * In v2 this will call an LLM via the EmbeddingAdapter or a separate
   * ExtractionAdapter — keeping the interface consistent.
   */
  private extractDimensions(input: EncodeInput): {
    summary: string;
    intent: string;
    rationale: string;
    inferredDomain: string;
    inferredTags: string[];
  } {
    const content = input.content.trim();
    const lines = content.split('\n').map(l => l.trim()).filter(Boolean);

    // Structured format: if content uses explicit keys, parse them
    const structured = this.parseStructured(content);
    if (structured) return structured;

    // Fallback: treat first sentence as summary, rest as rationale
    const sentences = content.split(/[.!?]+/).map(s => s.trim()).filter(Boolean);

    return {
      summary: sentences[0] ?? content.substring(0, 120),
      intent: lines.length > 1 ? lines[1] : 'Not specified',
      rationale: sentences.slice(1).join('. ') || 'Not specified',
      inferredDomain: input.domain ?? this.inferDomain(content),
      inferredTags: this.inferTags(content),
    };
  }

  /**
   * Parse structured input format:
   *
   * summary: ...
   * intent: ...
   * rationale: ...
   * domain: ...
   * tags: tag1, tag2
   */
  private parseStructured(content: string): ReturnType<Encoder['extractDimensions']> | null {
    const fields: Record<string, string> = {};
    const fieldPattern = /^(summary|intent|rationale|domain|tags):\s*(.+)$/im;
    const lines = content.split('\n');

    let currentField: string | null = null;
    let buffer: string[] = [];

    for (const line of lines) {
      const match = line.match(fieldPattern);
      if (match) {
        if (currentField) fields[currentField] = buffer.join(' ').trim();
        currentField = match[1].toLowerCase();
        buffer = [match[2].trim()];
      } else if (currentField) {
        buffer.push(line.trim());
      }
    }
    if (currentField) fields[currentField] = buffer.join(' ').trim();

    if (!fields['summary']) return null;

    return {
      summary: fields['summary'],
      intent: fields['intent'] ?? 'Not specified',
      rationale: fields['rationale'] ?? 'Not specified',
      inferredDomain: fields['domain'] ?? 'general',
      inferredTags: fields['tags'] ? fields['tags'].split(',').map(t => t.trim()) : [],
    };
  }

  private inferDomain(content: string): string {
    const lower = content.toLowerCase();
    if (/\b(deploy|infra|server|database|api|code|build)\b/.test(lower)) return 'engineering';
    if (/\b(customer|user|persona|journey|market|growth)\b/.test(lower)) return 'product';
    if (/\b(revenue|cost|budget|pricing|invoice|payment)\b/.test(lower)) return 'finance';
    if (/\b(hire|team|culture|onboard|role|policy)\b/.test(lower)) return 'ops';
    return 'general';
  }

  private inferTags(content: string): string[] {
    const tags: string[] = [];
    const lower = content.toLowerCase();

    const tagPatterns: [RegExp, string][] = [
      [/\bdecision\b/, 'decision'],
      [/\bworkflow\b/, 'workflow'],
      [/\bpermission|access|role\b/, 'permissions'],
      [/\bincident|alert|outage\b/, 'incident'],
      [/\bfounding|origin|vision\b/, 'founding'],
      [/\bintegration|connect|protocol\b/, 'integration'],
    ];

    for (const [pattern, tag] of tagPatterns) {
      if (pattern.test(lower)) tags.push(tag);
    }

    return tags;
  }

  private inferRelationshipType(from: Cluster, to: Cluster): string {
    if (from.domain === to.domain) return 'related';
    if (from.tags.some(t => to.tags.includes(t))) return 'shares-context';
    return 'connected';
  }
}
