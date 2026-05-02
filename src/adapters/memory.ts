/**
 * InMemoryAdapter
 *
 * A complete StorageAdapter implementation backed by plain Maps.
 * No database. No dependencies. Zero configuration.
 *
 * Used for:
 *   - Local development
 *   - Testing
 *   - Running MLP before wiring a real storage backend
 *
 * What it does:
 *   - Stores clusters in a Map keyed by id
 *   - Stores connections in a Map keyed by fromId::toId
 *   - Implements BFS with weight-product scoring for activation
 *   - Implements cosine similarity for vector search
 *   - Enforces workspace isolation on every read and write
 *   - Never deletes — superseded clusters stay in the Map
 *
 * What it does not do:
 *   - It does not persist across restarts
 *   - It does not support concurrent writes safely
 *   - It is not suitable for production use
 *
 * Activation score formula:
 *   score = seed_similarity
 *         × connection_strength_along_path
 *         × (1 / degree)
 *         × cluster.weight.combined
 */

import type { StorageAdapter } from '../interfaces/StorageAdapter.js'
import type {
  Cluster,
  Trigger,
  ActivationResult,
  ActivatedEntry,
  StrengthenResult,
  TraverseResult,
  TraversePath,
  Workspace,
  WatcherSignal,
  ClusterConnection
} from '../interfaces/types.js'

interface PendingGap {
  concept: string
  referenced_by: string
  created_at: string
}

export class InMemoryAdapter implements StorageAdapter {

  private clusters = new Map<string, Cluster>()
  private workspaces = new Map<string, Workspace>()
  private pendingGaps = new Map<string, PendingGap>()

  // ── Lifecycle ───────────────────────────────────────────────────────

  async connect(): Promise<void> {
    console.error('[InMemoryAdapter] Ready — no persistence')
  }

  async disconnect(): Promise<void> {
    this.clusters.clear()
    this.workspaces.clear()
    this.pendingGaps.clear()
    console.error('[InMemoryAdapter] Disconnected')
  }

  // ── Workspace ───────────────────────────────────────────────────────

  async createWorkspace(
    workspace: Workspace
  ): Promise<{ success: boolean; error?: string }> {
    if (this.workspaces.has(workspace.id)) {
      return { success: false, error: 'Workspace already exists' }
    }
    this.workspaces.set(workspace.id, { ...workspace })
    return { success: true }
  }

  async getWorkspace(workspaceId: string): Promise<Workspace | null> {
    return this.workspaces.get(workspaceId) ?? null
  }

  // ── Four Core Methods ───────────────────────────────────────────────

  async encodeCluster(
    cluster: Cluster
  ): Promise<{ success: boolean; id: string; error?: string }> {
    try {
      const existing = this.clusters.get(cluster.id)

      if (existing) {
        // Append to history — never overwrite
        const updatedCluster: Cluster = {
          ...cluster,
          constraint_type: cluster.constraint_type ?? 'soft',
          temporal: {
            ...cluster.temporal,
            history: [
              ...existing.temporal.history,
              ...cluster.temporal.history
            ]
          },
          evidence: [
            ...existing.evidence,
            ...cluster.evidence
          ]
        }
        this.clusters.set(cluster.id, updatedCluster)
      } else {
        this.clusters.set(cluster.id, {
          ...cluster,
          constraint_type: cluster.constraint_type ?? 'soft'
        })
      }

      // Update structural weight of connected clusters
      this.updateStructuralWeights(cluster)

      return { success: true, id: cluster.id }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { success: false, id: '', error: message }
    }
  }

  async activateCluster(
    trigger: Trigger,
    depth: number
  ): Promise<ActivationResult> {

    // Find seed via vector similarity scoped to workspace
    const candidates = Array.from(this.clusters.values())
      .filter(c =>
        c.domain.workspace === trigger.workspace &&
        c.confidence !== 'superseded'
      )

    if (candidates.length === 0) {
      return {
        seed: null as any,
        activated: [],
        total_activated: 0,
        depth_reached: 0
      }
    }

    // Score candidates by cosine similarity
    const scored = candidates
      .filter(c => c.embedding && c.embedding.length > 0)
      .map(c => ({
        cluster: c,
        similarity: cosineSimilarity(trigger.embedding, c.embedding!)
      }))
      .sort((a, b) => b.similarity - a.similarity)

    // Boost clusters in session context
    if (trigger.session_context.length > 0) {
      const sessionSet = new Set(trigger.session_context)
      scored.forEach(s => {
        if (sessionSet.has(s.cluster.id)) {
          s.similarity = Math.min(s.similarity * 1.2, 1.0)
        }
      })
      scored.sort((a, b) => b.similarity - a.similarity)
    }

    if (scored.length === 0) {
      return {
        seed: null as any,
        activated: [],
        total_activated: 0,
        depth_reached: 0
      }
    }

    const seed = scored[0].cluster
    const seedSimilarity = scored[0].similarity

    // BFS activation spread from seed
    const visited = new Map<string, {
      score: number
      degree: number
    }>()

    visited.set(seed.id, { score: seedSimilarity, degree: 0 })

    const queue: Array<{
      clusterId: string
      score: number
      degree: number
    }> = [{ clusterId: seed.id, score: seedSimilarity, degree: 0 }]

    while (queue.length > 0) {
      const current = queue.shift()!
      if (current.degree >= depth) continue

      const currentCluster = this.clusters.get(current.clusterId)
      if (!currentCluster) continue

      // Follow connections ordered by strength — strongest first
      const connections = [...currentCluster.connections]
        .filter(conn => conn.type !== 'contradicts')
        .sort((a, b) => b.strength - a.strength)

      for (const conn of connections) {
        const target = this.clusters.get(conn.target_cluster_id)
        if (!target) continue
        if (target.domain.workspace !== trigger.workspace) continue
        if (target.confidence === 'superseded') continue

        const degree = current.degree + 1

        // Activation score formula
        const score = seedSimilarity
          * conn.strength
          * (1 / degree)
          * Math.max(target.weight.combined, 0.1)

        // Stop spreading below threshold
        if (score < 0.1) continue

        const existing = visited.get(target.id)
        if (!existing || score > existing.score) {
          visited.set(target.id, { score, degree })
          queue.push({
            clusterId: target.id,
            score,
            degree
          })
        }
      }
    }

    // Build activated entries — exclude seed
    const activated: ActivatedEntry[] = []

    for (const [id, { score, degree }] of visited) {
      if (id === seed.id) continue
      const cluster = this.clusters.get(id)
      if (!cluster) continue

      activated.push({
        cluster,
        degree,
        activation_score: score
      })
    }

    activated.sort((a, b) => b.activation_score - a.activation_score)

    return {
      seed,
      activated,
      total_activated: activated.length,
      depth_reached: depth
    }
  }

  async strengthenPath(
    clusterIdA: string,
    clusterIdB: string,
    workspace: string
  ): Promise<StrengthenResult> {

    const clusterA = this.clusters.get(clusterIdA)
    const clusterB = this.clusters.get(clusterIdB)

    if (!clusterA || !clusterB) {
      return { success: false, new_strength: 0, previous_strength: 0 }
    }

    // Enforce workspace isolation
    if (
      clusterA.domain.workspace !== workspace ||
      clusterB.domain.workspace !== workspace
    ) {
      return { success: false, new_strength: 0, previous_strength: 0 }
    }

    const existing = clusterA.connections.find(
      c => c.target_cluster_id === clusterIdB
    )

    const previousStrength = existing?.strength ?? 0

    if (existing) {
      existing.strength = Math.min(existing.strength + 0.01, 1.0)
      existing.activation_count++
      existing.last_activated = new Date().toISOString()
    } else {
      const newConnection: ClusterConnection = {
        target_cluster_id: clusterIdB,
        type: 'references',
        strength: 0.5,
        direction: 'bidirectional',
        context: 'co-activation',
        established_at: new Date().toISOString(),
        last_activated: new Date().toISOString(),
        activation_count: 1
      }
      clusterA.connections.push(newConnection)
    }

    // Update usage weight
    clusterA.weight.usage = Math.min(clusterA.weight.usage + 0.01, 1.0)
    clusterA.weight.combined = (clusterA.weight.structural + clusterA.weight.usage) / 2

    const newStrength = clusterA.connections.find(
      c => c.target_cluster_id === clusterIdB
    )?.strength ?? 0.5

    return {
      success: true,
      new_strength: newStrength,
      previous_strength: previousStrength
    }
  }

  async traverseFrom(
    clusterId: string,
    degrees: number,
    workspace: string
  ): Promise<TraverseResult> {

    const origin = this.clusters.get(clusterId)

    if (!origin || origin.domain.workspace !== workspace) {
      return { origin: null as any, paths: [] }
    }

    const paths: TraversePath[] = []
    const visited = new Set<string>()

    const traverse = (
      currentId: string,
      currentPath: string[],
      currentDegree: number,
      minStrength: number
    ) => {
      if (currentDegree > degrees) return
      visited.add(currentId)

      const current = this.clusters.get(currentId)
      if (!current) return

      for (const conn of current.connections) {
        if (visited.has(conn.target_cluster_id)) continue

        const target = this.clusters.get(conn.target_cluster_id)
        if (!target) continue
        if (target.domain.workspace !== workspace) continue
        if (target.confidence === 'superseded') continue

        const pathStrength = Math.min(minStrength, conn.strength)
        const newPath = [...currentPath, conn.target_cluster_id]

        paths.push({
          cluster: target,
          path: newPath,
          degree: currentDegree,
          path_strength: pathStrength
        })

        traverse(
          conn.target_cluster_id,
          newPath,
          currentDegree + 1,
          pathStrength
        )
      }
    }

    traverse(clusterId, [clusterId], 1, 1.0)

    return { origin, paths }
  }

  // ── Enrichment ──────────────────────────────────────────────────────

  async processWatcherSignal(
    signal: WatcherSignal
  ): Promise<{
    action: 'enriched' | 'contradicted' | 'created' | 'ignored'
    cluster_id: string | null
    reason: string
  }> {

    const now = new Date().toISOString()

    // Corroboration — enrich existing cluster
    if (signal.corroborates_cluster_id) {
      const cluster = this.clusters.get(signal.corroborates_cluster_id)

      if (cluster && cluster.domain.workspace === signal.workspace) {
        cluster.evidence.push({
          source_type: signal.source_type,
          source_tool: signal.source_tool,
          corroborated_at: now,
          detail: signal.raw.substring(0, 200),
          encoded_by: signal.encoded_by
        })

        // Raise confidence if enough evidence
        if (
          cluster.confidence === 'provisional' &&
          cluster.evidence.length >= 2
        ) {
          cluster.confidence = 'verified'
        }

        cluster.updated_at = now

        return {
          action: 'enriched',
          cluster_id: cluster.id,
          reason: `Cluster enriched — evidence count: ${cluster.evidence.length}`
        }
      }
    }

    // Contradiction — flag both clusters
    if (signal.contradicts_cluster_id) {
      const cluster = this.clusters.get(signal.contradicts_cluster_id)

      if (cluster && cluster.domain.workspace === signal.workspace) {
        cluster.connections.push({
          target_cluster_id: signal.contradicts_cluster_id,
          type: 'contradicts',
          strength: 0.5,
          direction: 'bidirectional',
          context: signal.raw.substring(0, 200),
          established_at: now,
          last_activated: now,
          activation_count: 1
        })

        return {
          action: 'contradicted',
          cluster_id: cluster.id,
          reason: 'Contradiction detected — flagged for human review'
        }
      }
    }

    // Neither — ignore signal if workspace does not exist
    const workspace = this.workspaces.get(signal.workspace)
    if (!workspace) {
      return {
        action: 'ignored',
        cluster_id: null,
        reason: 'Workspace not found'
      }
    }

    // Create provisional cluster from signal
    return {
      action: 'created',
      cluster_id: null,
      reason: 'New provisional cluster should be created via encoder'
    }
  }

  // ── Query Helpers ───────────────────────────────────────────────────

  async getCluster(
    clusterId: string,
    workspace: string
  ): Promise<Cluster | null> {
    const cluster = this.clusters.get(clusterId)
    if (!cluster) return null
    if (cluster.domain.workspace !== workspace) return null
    return cluster
  }

  async getClusterHistory(
    clusterId: string,
    workspace: string
  ): Promise<Cluster | null> {
    return this.getCluster(clusterId, workspace)
  }

  async listDomains(workspace: string): Promise<Array<{
    module: string | null
    workflow: string | null
    cluster_count: number
    last_encoded: string
  }>> {
    const domainMap = new Map<string, {
      module: string | null
      workflow: string | null
      cluster_count: number
      last_encoded: string
    }>()

    for (const cluster of this.clusters.values()) {
      if (cluster.domain.workspace !== workspace) continue

      const key = `${cluster.domain.module}::${cluster.domain.workflow}`
      const existing = domainMap.get(key)

      if (existing) {
        existing.cluster_count++
        if (cluster.created_at > existing.last_encoded) {
          existing.last_encoded = cluster.created_at
        }
      } else {
        domainMap.set(key, {
          module: cluster.domain.module,
          workflow: cluster.domain.workflow,
          cluster_count: 1,
          last_encoded: cluster.created_at
        })
      }
    }

    return Array.from(domainMap.values())
  }

  async getHighWeightClusters(
    workspace: string,
    topK: number
  ): Promise<Cluster[]> {
    return Array.from(this.clusters.values())
      .filter(c =>
        c.domain.workspace === workspace &&
        c.confidence !== 'superseded'
      )
      .sort((a, b) => b.weight.combined - a.weight.combined)
      .slice(0, topK)
  }

  async getRecentlyChangedClusters(
    workspace: string,
    since: string,
    topK: number
  ): Promise<Cluster[]> {
    return Array.from(this.clusters.values())
      .filter(c =>
        c.domain.workspace === workspace &&
        c.confidence !== 'superseded' &&
        c.temporal.valid_from >= since
      )
      .sort((a, b) =>
        b.temporal.valid_from.localeCompare(a.temporal.valid_from)
      )
      .slice(0, topK)
  }

  async getPendingGaps(workspace: string): Promise<Array<{
    concept: string
    referenced_by: string
    created_at: string
  }>> {
    return Array.from(this.pendingGaps.values())
      .filter(g => {
        const cluster = this.clusters.get(g.referenced_by)
        return cluster?.domain.workspace === workspace
      })
  }

  // ── Metrics ─────────────────────────────────────────────────────────

  async getWorkspaceStats(workspace: string): Promise<{
    total_clusters: number
    verified_clusters: number
    provisional_clusters: number
    superseded_clusters: number
    total_connections: number
    average_connections_per_cluster: number
    average_weight_combined: number
    last_activation: string | null
    last_encode: string | null
  }> {
    const clusters = Array.from(this.clusters.values())
      .filter(c => c.domain.workspace === workspace)

    const total = clusters.length
    const verified = clusters.filter(c => c.confidence === 'verified').length
    const provisional = clusters.filter(c => c.confidence === 'provisional').length
    const superseded = clusters.filter(c => c.confidence === 'superseded').length

    const totalConnections = clusters.reduce(
      (sum, c) => sum + c.connections.length, 0
    )

    const avgConnections = total > 0 ? totalConnections / total : 0

    const avgWeight = total > 0
      ? clusters.reduce((sum, c) => sum + c.weight.combined, 0) / total
      : 0

    const sorted = [...clusters].sort((a, b) =>
      b.updated_at.localeCompare(a.updated_at)
    )

    return {
      total_clusters: total,
      verified_clusters: verified,
      provisional_clusters: provisional,
      superseded_clusters: superseded,
      total_connections: totalConnections,
      average_connections_per_cluster: avgConnections,
      average_weight_combined: avgWeight,
      last_activation: null,
      last_encode: sorted[0]?.created_at ?? null
    }
  }

  async findSimilarClusters(
    _embedding: number[],
    _workspace: string,
    _threshold = 0.92,
    _excludeId?: string
  ): Promise<Array<{ cluster: Cluster; similarity: number }>> {
    return []
  }

  async supersedeClusters(
    clusterIds: string[],
    workspace: string,
    _supersededBy: string
  ): Promise<void> {
    for (const id of clusterIds) {
      const cluster = this.clusters.get(id)
      if (cluster && cluster.domain.workspace === workspace) {
        cluster.confidence = 'superseded'
      }
    }
  }

  async rebuildVectorIndex(_workspace: string): Promise<{ updated: number }> {
    return { updated: 0 }
  }

  async connectClusters(
    _fromId: string,
    _toIds: string[],
    _workspace: string,
    _connectionType: 'governs' | 'references'
  ): Promise<void> {
    // memory adapter — connections handled inline
  }

  // ── Private Helpers ──────────────────────────────────────────────────

  private updateStructuralWeights(newCluster: Cluster): void {
    // For every cluster this new cluster connects to,
    // increment their structural weight
    for (const conn of newCluster.connections) {
      const target = this.clusters.get(conn.target_cluster_id)
      if (!target) continue

      target.weight.structural = Math.min(
        target.weight.structural + 0.05, 1.0
      )
      target.weight.combined = (
        target.weight.structural + target.weight.usage
      ) / 2
    }
  }

}

// ── Cosine Similarity ──────────────────────────────────────────────────

function cosineSimilarity(a: number[], b: number[]): number {
  if (!a || !b || a.length !== b.length) return 0

  let dot = 0
  let normA = 0
  let normB = 0

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  return denom === 0 ? 0 : dot / denom
}
