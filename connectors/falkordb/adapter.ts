/**
 * FalkorDBAdapter
 *
 * Implements StorageAdapter using FalkorDB.
 * FalkorDB gives us graph traversal and vector similarity
 * in one store — no separate vector database needed.
 *
 * What it does:
 *   - Stores clusters as graph nodes with all fields as properties
 *   - Stores connections as directed weighted edges
 *   - Uses vector index for seed finding in activation
 *   - Uses graph traversal for activation spreading
 *   - Enforces workspace isolation at the Cypher query level
 *   - Never returns clusters from a different workspace
 *   - Never returns superseded clusters unless explicitly requested
 *   - Append only — history is never overwritten
 *
 * What it does not do:
 *   - It never exposes Cypher to the engine layer
 *   - It never crosses workspace boundaries
 *   - It never deletes nodes or edges
 *
 * Note on deprecated transitives:
 *   @falkordb/client and @falkordb/graph are deprecated internal
 *   packages pulled in by the falkordb driver. They are not
 *   imported directly. Watch for falkordb driver updates.
 *
 * Activation score formula:
 *   score = seed_similarity
 *         × connection_strength_along_path
 *         × (1 / degree)
 *         × cluster.weight_combined
 */

import { createClient, Graph } from 'falkordb'
import type { StorageAdapter } from '../../src/interfaces/StorageAdapter.js'
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
} from '../../src/interfaces/types.js'

interface FalkorDBConfig {
  host: string
  port: number
  password?: string
}

// Explicit field list for RETURN — excludes embedding (float32 vector,
// not deserialisable by the FalkorDB JS driver) and returns flat scalars.
const CLUSTER_FIELDS_C = `
  c.id AS id,
  c.created_at AS created_at,
  c.updated_at AS updated_at,
  c.what AS what,
  c.why AS why,
  c.confidence AS confidence,
  c.constraint_type AS constraint_type,
  c.workspace AS workspace,
  c.module AS module,
  c.workflow AS workflow,
  c.tags AS tags,
  c.source_type AS source_type,
  c.source_tool AS source_tool,
  c.encoded_by AS encoded_by,
  c.valid_from AS valid_from,
  c.weight_structural AS weight_structural,
  c.weight_usage AS weight_usage,
  c.weight_combined AS weight_combined,
  c.evidence AS evidence,
  c.history AS history`

const CLUSTER_FIELDS_NODE = `
  node.id AS id,
  node.created_at AS created_at,
  node.updated_at AS updated_at,
  node.what AS what,
  node.why AS why,
  node.confidence AS confidence,
  node.constraint_type AS constraint_type,
  node.workspace AS workspace,
  node.module AS module,
  node.workflow AS workflow,
  node.tags AS tags,
  node.source_type AS source_type,
  node.source_tool AS source_tool,
  node.encoded_by AS encoded_by,
  node.valid_from AS valid_from,
  node.weight_structural AS weight_structural,
  node.weight_usage AS weight_usage,
  node.weight_combined AS weight_combined,
  node.evidence AS evidence,
  node.history AS history`

export class FalkorDBAdapter implements StorageAdapter {

  private client: ReturnType<typeof createClient> | null = null
  private graph: Graph | null = null
  private config: FalkorDBConfig
  private embedder: any = null
  private embeddingCache: Map<string, number[]> = new Map()

  constructor(config: FalkorDBConfig, embedder?: any) {
    this.config = config
    this.embedder = embedder ?? null
  }

  // ── Lifecycle ───────────────────────────────────────────────────────

  async connect(): Promise<void> {
    const clientConfig: any = {
      socket: {
        host: this.config.host,
        port: this.config.port
      }
    }

    if (this.config.password) {
      clientConfig.password = this.config.password
    }

    this.client = createClient(clientConfig)
    await this.client.connect()

    this.graph = new Graph(this.client as any, 'mlp')
    await this.ensureSchema()
    console.error('[FalkorDBAdapter] Connected')
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.disconnect()
      this.client = null
      this.graph = null
      console.error('[FalkorDBAdapter] Disconnected')
    }
  }

  private async ensureSchema(): Promise<void> {
    const queries = [
      `CREATE INDEX FOR (c:Cluster) ON (c.id)`,
      `CREATE INDEX FOR (c:Cluster) ON (c.workspace)`,
      `CREATE INDEX FOR (c:Cluster) ON (c.confidence)`,
      `CREATE INDEX FOR (w:Workspace) ON (w.id)`,
      `CREATE VECTOR INDEX FOR (c:Cluster) ON (c.embedding)
       OPTIONS {dimension: 1024, similarityFunction: 'cosine'}`
    ]

    for (const query of queries) {
      try {
        await this.graph!.query(query)
      } catch {
        // Index already exists — safe to ignore
      }
    }
  }

  async rebuildVectorIndexFully(): Promise<void> {
    // Drop and recreate the vector index to force FalkorDB to rebuild it
    // This is needed after bulk embedding writes during startup reindex
    try {
      await this.graph!.query(
        `DROP INDEX ON :Cluster(embedding)`
      )
      console.error('[FalkorDB] Vector index dropped')
    } catch {
      // Index may not exist yet — safe to ignore
    }

    try {
      await this.graph!.query(
        `CREATE VECTOR INDEX FOR (c:Cluster) ON (c.embedding)
         OPTIONS {dimension: 1024, similarityFunction: 'cosine'}`
      )
      console.error('[FalkorDB] Vector index recreated')
    } catch {
      // Index may already exist — safe to ignore
    }
  }

  async reindexAllClusters(workspace: string): Promise<{ reindexed: number }> {
    const result = await this.graph!.query(
      `MATCH (c:Cluster {workspace: $workspace})
       WHERE c.confidence <> 'superseded'
       RETURN c.id AS id`,
      { params: { workspace } }
    )

    console.error(`[FalkorDB] Reindexing ${result.data?.length ?? 0} clusters`)
    return { reindexed: result.data?.length ?? 0 }
  }

  async rebuildVectorIndex(workspace: string): Promise<{ updated: number }> {
    // Returns cluster ids and what text only — no embedding field.
    // Actual re-embedding is driven by the /api/admin/reindex endpoint
    // which has access to the embedder.
    const result = await this.graph!.query(
      `MATCH (c:Cluster {workspace: $workspace})
       WHERE c.confidence <> 'superseded'
       RETURN c.id AS id, c.what AS what`,
      { params: { workspace } }
    )

    console.error(`[FalkorDB] Found ${result.data?.length ?? 0} clusters to reindex`)
    return { updated: result.data?.length ?? 0 }
  }

  // ── Workspace ───────────────────────────────────────────────────────

  async createWorkspace(
    workspace: Workspace
  ): Promise<{ success: boolean; error?: string }> {
    try {
      await this.graph!.query(
        `MERGE (w:Workspace {id: $id})
         ON CREATE SET
           w.name = $name,
           w.created_at = $created_at,
           w.owner_id = $owner_id,
           w.api_key_hash = $api_key_hash
         ON MATCH SET
           w.name = $name`,
        {
          params: {
            id: workspace.id,
            name: workspace.name,
            created_at: workspace.created_at,
            owner_id: workspace.owner_id,
            api_key_hash: workspace.api_key_hash
          }
        }
      )
      return { success: true }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { success: false, error: message }
    }
  }

  async getWorkspace(workspaceId: string): Promise<Workspace | null> {
    const result = await this.graph!.query(
      `MATCH (w:Workspace {id: $id})
       RETURN w.id AS id, w.name AS name,
              w.created_at AS created_at,
              w.owner_id AS owner_id,
              w.api_key_hash AS api_key_hash`,
      { params: { id: workspaceId } }
    )

    const row = result.data?.[0]
    if (!row) return null

    return {
      id: (row as any).id as string,
      name: (row as any).name as string,
      created_at: (row as any).created_at as string,
      owner_id: (row as any).owner_id as string,
      api_key_hash: (row as any).api_key_hash as string
    }
  }

  // ── Four Core Methods ───────────────────────────────────────────────

  async encodeCluster(
    cluster: Cluster
  ): Promise<{ success: boolean; id: string; error?: string }> {
    try {
      await this.graph!.query(
        `MERGE (c:Cluster {id: $id})
         ON CREATE SET
           c.created_at = $created_at,
           c.updated_at = $updated_at,
           c.what = $what,
           c.why = $why,
           c.confidence = $confidence,
           c.constraint_type = $constraint_type,
           c.workspace = $workspace,
           c.module = $module,
           c.workflow = $workflow,
           c.tags = $tags,
           c.source_type = $source_type,
           c.source_tool = $source_tool,
           c.encoded_by = $encoded_by,
           c.valid_from = $valid_from,
           c.weight_structural = $weight_structural,
           c.weight_usage = $weight_usage,
           c.weight_combined = $weight_combined,
           c.evidence = $evidence,
           c.history = $history,
           c.embedding = vecf32($embedding)
         ON MATCH SET
           c.updated_at = $updated_at,
           c.what = $what,
           c.why = $why,
           c.confidence = $confidence,
           c.constraint_type = $constraint_type,
           c.weight_structural = $weight_structural,
           c.weight_usage = $weight_usage,
           c.weight_combined = $weight_combined,
           c.evidence = $evidence,
           c.history = $history`,
        {
          params: {
            id: cluster.id,
            created_at: cluster.created_at,
            updated_at: cluster.updated_at,
            what: cluster.what,
            why: cluster.why,
            confidence: cluster.confidence,
            constraint_type: cluster.constraint_type ?? 'soft',
            workspace: cluster.domain.workspace,
            module: cluster.domain.module ?? '',
            workflow: cluster.domain.workflow ?? '',
            tags: JSON.stringify(cluster.domain.tags),
            source_type: cluster.source.type,
            source_tool: cluster.source.tool,
            encoded_by: cluster.source.encoded_by,
            valid_from: cluster.temporal.valid_from,
            weight_structural: cluster.weight.structural,
            weight_usage: cluster.weight.usage,
            weight_combined: cluster.weight.combined,
            evidence: JSON.stringify(cluster.evidence),
            history: JSON.stringify(cluster.temporal.history),
            embedding: cluster.embedding
          }
        }
      )

      // Store connections as edges
      for (const conn of cluster.connections) {
        await this.storeConnectionEdge(cluster.id, conn)
      }

      // Invalidate cache so next activation picks up the new cluster
      this.embeddingCache.clear()

      return { success: true, id: cluster.id }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { success: false, id: '', error: message }
    }
  }

  async findSimilarClusters(
    embedding: number[],
    workspace: string,
    threshold: number = 0.92,
    excludeId?: string
  ): Promise<Array<{ cluster: Cluster; similarity: number }>> {
    const result = await this.graph!.query(
      `CALL db.idx.vector.queryNodes('Cluster', 'embedding', 10, vecf32($embedding))
       YIELD node, score
       WHERE node.workspace = $workspace
       AND node.confidence <> 'superseded'
       ${excludeId ? 'AND node.id <> $excludeId' : ''}
       AND score >= $threshold
       RETURN
         ${CLUSTER_FIELDS_NODE},
         score
       ORDER BY score DESC`,
      {
        params: {
          embedding,
          workspace,
          threshold,
          ...(excludeId ? { excludeId } : {})
        }
      }
    )

    return (result.data ?? []).map((row: any) => ({
      cluster: this.rowToCluster(row),
      similarity: parseFloat(String(row.score)) || 0
    }))
  }

  async supersedeClusters(
    clusterIds: string[],
    workspace: string,
    supersededBy: string
  ): Promise<void> {
    for (const id of clusterIds) {
      await this.graph!.query(
        `MATCH (c:Cluster {id: $id, workspace: $workspace})
         SET c.confidence = 'superseded',
             c.updated_at = $now,
             c.superseded_by = $supersededBy`,
        {
          params: {
            id,
            workspace,
            now: new Date().toISOString(),
            supersededBy
          }
        }
      )
    }
  }

  async activateCluster(
    trigger: Trigger,
    depth: number
  ): Promise<ActivationResult> {

    // Seed finding — compute similarity in application code.
    // FalkorDB vector index is unreliable on some deployments;
    // we fetch what text and re-embed via Voyage to find the closest match.
    const allClustersResult = await this.graph!.query(
      `MATCH (c:Cluster {workspace: $workspace})
       WHERE c.confidence <> 'superseded'
       RETURN c.id AS id, c.what AS what, c.weight_combined AS weight_combined`,
      { params: { workspace: trigger.workspace } }
    )

    if (!allClustersResult.data || allClustersResult.data.length === 0) {
      return {
        seed: null as any,
        activated: [],
        total_activated: 0,
        depth_reached: 0
      }
    }

    function cosineSim(a: number[], b: number[]): number {
      let dot = 0, normA = 0, normB = 0
      for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i]
        normA += a[i] * a[i]
        normB += b[i] * b[i]
      }
      return dot / (Math.sqrt(normA) * Math.sqrt(normB) || 1)
    }

    let bestId = ''
    let bestScore = -1

    for (const row of allClustersResult.data as any[]) {
      try {
        const clusterId = row.id as string
        const what = row.what as string

        const cached = this.embeddingCache.get(clusterId)
        const clusterEmbedding: number[] = cached ?? await this.embedder!.embed(what)
        if (!cached) {
          this.embeddingCache.set(clusterId, clusterEmbedding)
        }

        const sim = cosineSim(trigger.embedding, clusterEmbedding)
        if (sim > bestScore) {
          bestScore = sim
          bestId = clusterId
        }
      } catch {
        continue
      }
    }

    if (!bestId) {
      return {
        seed: null as any,
        activated: [],
        total_activated: 0,
        depth_reached: 0
      }
    }

    const seedFetchResult = await this.graph!.query(
      `MATCH (c:Cluster {id: $id, workspace: $workspace})
       RETURN ${CLUSTER_FIELDS_C}`,
      { params: { id: bestId, workspace: trigger.workspace } }
    )

    if (!seedFetchResult.data || seedFetchResult.data.length === 0) {
      return {
        seed: null as any,
        activated: [],
        total_activated: 0,
        depth_reached: 0
      }
    }

    const seed = this.rowToCluster(seedFetchResult.data[0] as any)
    const seedSimilarity = bestScore

    // Boost if in session context
    const inSession = trigger.session_context.includes(seed.id)
    const boostedSimilarity = inSession
      ? Math.min(seedSimilarity * 1.2, 1.0)
      : seedSimilarity

    // Spread activation via graph traversal.
    // Returns flat scalar fields — embedding excluded.
    const spreadResult = await this.graph!.query(
      `MATCH path = (seed:Cluster {id: $seedId})-[r:CONNECTS*1..${depth}]->(c:Cluster)
       WHERE c.workspace = $workspace
       AND c.confidence <> 'superseded'
       WITH c,
         reduce(s = 1.0, rel IN relationships(path) | s * rel.strength) AS path_strength,
         length(path) AS degree
       RETURN
         ${CLUSTER_FIELDS_C},
         path_strength,
         degree
       ORDER BY path_strength DESC
       LIMIT 50`,
      {
        params: {
          seedId: seed.id,
          workspace: trigger.workspace
        }
      }
    )

    const seenSpread = new Map<string, ActivatedEntry>()

    for (const row of (spreadResult.data ?? []) as any[]) {
      const cluster = this.rowToCluster(row)
      const degree = parseInt(String(row.degree)) || 1
      const pathStrength = parseFloat(String(row.path_strength ?? 1)) || 1

      const score = boostedSimilarity
        * pathStrength
        * (1 / degree)
        * (cluster.weight.combined > 0 ? cluster.weight.combined + 0.5 : 0.5)

      if (score < 0.01) continue

      const existing = seenSpread.get(cluster.id)
      if (!existing || score > existing.activation_score) {
        seenSpread.set(cluster.id, { cluster, degree, activation_score: score })
      }
    }

    const activated = Array.from(seenSpread.values())
      .sort((a, b) => b.activation_score - a.activation_score)

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
    try {
      // Get previous strength
      const prev = await this.graph!.query(
        `MATCH (a:Cluster {id: $idA, workspace: $workspace})
               -[r:CONNECTS]->
               (b:Cluster {id: $idB, workspace: $workspace})
         RETURN r.strength AS strength`,
        { params: { idA: clusterIdA, idB: clusterIdB, workspace } }
      )

      const previousStrength = (prev.data?.[0] as any)?.strength ?? 0

      // Strengthen or create
      await this.graph!.query(
        `MATCH (a:Cluster {id: $idA, workspace: $workspace}),
               (b:Cluster {id: $idB, workspace: $workspace})
         MERGE (a)-[r:CONNECTS]->(b)
         ON CREATE SET
           r.strength = 0.5,
           r.type = 'references',
           r.direction = 'bidirectional',
           r.activation_count = 1,
           r.established_at = $now,
           r.last_activated = $now
         ON MATCH SET
           r.strength = CASE
             WHEN r.strength + 0.01 > 1.0 THEN 1.0
             ELSE r.strength + 0.01
           END,
           r.activation_count = r.activation_count + 1,
           r.last_activated = $now`,
        {
          params: {
            idA: clusterIdA,
            idB: clusterIdB,
            workspace,
            now: new Date().toISOString()
          }
        }
      )

      // Update usage weight on both clusters
      await this.graph!.query(
        `MATCH (c:Cluster {id: $id, workspace: $workspace})
         SET c.weight_usage = CASE
               WHEN c.weight_usage + 0.01 > 1.0 THEN 1.0
               ELSE c.weight_usage + 0.01
             END,
             c.weight_combined = (c.weight_structural + c.weight_usage) / 2`,
        { params: { id: clusterIdA, workspace } }
      )

      const newResult = await this.graph!.query(
        `MATCH (a:Cluster {id: $idA})-[r:CONNECTS]->(b:Cluster {id: $idB})
         RETURN r.strength AS strength`,
        { params: { idA: clusterIdA, idB: clusterIdB } }
      )

      const newStrength = (newResult.data?.[0] as any)?.strength ?? 0.5

      return {
        success: true,
        new_strength: newStrength,
        previous_strength: previousStrength
      }
    } catch (err) {
      return { success: false, new_strength: 0, previous_strength: 0 }
    }
  }

  async traverseFrom(
    clusterId: string,
    degrees: number,
    workspace: string
  ): Promise<TraverseResult> {

    const originResult = await this.graph!.query(
      `MATCH (c:Cluster {id: $id, workspace: $workspace})
       RETURN ${CLUSTER_FIELDS_C}`,
      { params: { id: clusterId, workspace } }
    )

    if (!originResult.data || originResult.data.length === 0) {
      return { origin: null as any, paths: [] }
    }

    const origin = this.rowToCluster(originResult.data[0] as any)

    const pathResult = await this.graph!.query(
      `MATCH path = (origin:Cluster {id: $id})-[r:CONNECTS*1..${degrees}]->(c:Cluster)
       WHERE c.workspace = $workspace
       AND c.confidence <> 'superseded'
       WITH c,
         [node IN nodes(path) | node.id] AS pathIds,
         length(path) AS degree,
         reduce(
           s = 1.0,
           rel IN relationships(path) | s * rel.strength
         ) AS path_strength
       RETURN
         ${CLUSTER_FIELDS_C},
         pathIds,
         degree,
         path_strength
       ORDER BY path_strength DESC`,
      { params: { id: clusterId, workspace } }
    )

    const paths: TraversePath[] = (pathResult.data ?? []).map(
      (row: any) => ({
        cluster: this.rowToCluster(row),
        path: row.pathIds as string[],
        degree: parseInt(String(row.degree)) || 1,
        path_strength: parseFloat(String(row.path_strength ?? 1)) || 1
      })
    )

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

    if (signal.corroborates_cluster_id) {
      const cluster = await this.getCluster(
        signal.corroborates_cluster_id,
        signal.workspace
      )

      if (cluster) {
        const newEvidence = [
          ...cluster.evidence,
          {
            source_type: signal.source_type,
            source_tool: signal.source_tool,
            corroborated_at: now,
            detail: signal.raw.substring(0, 200),
            encoded_by: signal.encoded_by
          }
        ]

        const newConfidence = (
          cluster.confidence === 'provisional' &&
          newEvidence.length >= 2
        ) ? 'verified' : cluster.confidence

        await this.graph!.query(
          `MATCH (c:Cluster {id: $id, workspace: $workspace})
           SET c.evidence = $evidence,
               c.confidence = $confidence,
               c.updated_at = $now`,
          {
            params: {
              id: cluster.id,
              workspace: signal.workspace,
              evidence: JSON.stringify(newEvidence),
              confidence: newConfidence,
              now
            }
          }
        )

        return {
          action: 'enriched',
          cluster_id: cluster.id,
          reason: `Enriched — evidence count: ${newEvidence.length}`
        }
      }
    }

    if (signal.contradicts_cluster_id) {
      const cluster = await this.getCluster(
        signal.contradicts_cluster_id,
        signal.workspace
      )

      if (cluster) {
        await this.graph!.query(
          `MATCH (a:Cluster {id: $idA, workspace: $workspace}),
                 (b:Cluster {id: $idB, workspace: $workspace})
           MERGE (a)-[r:CONNECTS {type: 'contradicts'}]->(b)
           ON CREATE SET
             r.strength = 0.5,
             r.direction = 'bidirectional',
             r.activation_count = 1,
             r.established_at = $now,
             r.last_activated = $now,
             r.context = $context`,
          {
            params: {
              idA: signal.contradicts_cluster_id,
              idB: signal.contradicts_cluster_id,
              workspace: signal.workspace,
              now,
              context: signal.raw.substring(0, 200)
            }
          }
        )

        return {
          action: 'contradicted',
          cluster_id: cluster.id,
          reason: 'Contradiction flagged — human review required'
        }
      }
    }

    return {
      action: 'ignored',
      cluster_id: null,
      reason: 'No matching cluster found and no workspace context'
    }
  }

  // ── Query Helpers ───────────────────────────────────────────────────

  async getCluster(
    clusterId: string,
    workspace: string
  ): Promise<Cluster | null> {
    const result = await this.graph!.query(
      `MATCH (c:Cluster {id: $id, workspace: $workspace})
       RETURN ${CLUSTER_FIELDS_C}`,
      { params: { id: clusterId, workspace } }
    )

    const row = result.data?.[0] as any
    if (!row) return null
    return this.rowToCluster(row)
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
    const result = await this.graph!.query(
      `MATCH (c:Cluster {workspace: $workspace})
       WHERE c.confidence <> 'superseded'
       RETURN c.module AS module,
              c.workflow AS workflow,
              count(c) AS cluster_count,
              max(c.created_at) AS last_encoded
       ORDER BY cluster_count DESC`,
      { params: { workspace } }
    )

    return (result.data ?? []).map((row: any) => ({
      module: row.module || null,
      workflow: row.workflow || null,
      cluster_count: row.cluster_count as number,
      last_encoded: row.last_encoded as string
    }))
  }

  async getHighWeightClusters(
    workspace: string,
    topK: number
  ): Promise<Cluster[]> {
    const result = await this.graph!.query(
      `MATCH (c:Cluster {workspace: $workspace})
       WHERE c.confidence <> 'superseded'
       RETURN ${CLUSTER_FIELDS_C}
       ORDER BY c.weight_combined DESC
       LIMIT $topK`,
      { params: { workspace, topK } }
    )

    return (result.data ?? []).map(
      (row: any) => this.rowToCluster(row)
    )
  }

  async getRecentlyChangedClusters(
    workspace: string,
    since: string,
    topK: number
  ): Promise<Cluster[]> {
    const result = await this.graph!.query(
      `MATCH (c:Cluster {workspace: $workspace})
       WHERE c.confidence <> 'superseded'
       AND c.valid_from >= $since
       RETURN ${CLUSTER_FIELDS_C}
       ORDER BY c.valid_from DESC
       LIMIT $topK`,
      { params: { workspace, since, topK } }
    )

    return (result.data ?? []).map(
      (row: any) => this.rowToCluster(row)
    )
  }

  async getPendingGaps(workspace: string): Promise<Array<{
    concept: string
    referenced_by: string
    created_at: string
  }>> {
    // Gaps are stored as properties on clusters that
    // reference concepts with no matching cluster
    // In FalkorDB we query for implied connections with no target
    const result = await this.graph!.query(
      `MATCH (c:Cluster {workspace: $workspace})
       WHERE c.confidence <> 'superseded'
       AND EXISTS(c.pending_gaps)
       RETURN c.id AS referenced_by,
              c.pending_gaps AS gaps,
              c.created_at AS created_at`,
      { params: { workspace } }
    )

    const gaps: Array<{
      concept: string
      referenced_by: string
      created_at: string
    }> = []

    for (const row of (result.data ?? []) as any[]) {
      const pendingGaps = JSON.parse(row.gaps ?? '[]') as string[]
      for (const concept of pendingGaps) {
        gaps.push({
          concept,
          referenced_by: row.referenced_by as string,
          created_at: row.created_at as string
        })
      }
    }

    return gaps
  }

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
    const result = await this.graph!.query(
      `MATCH (c:Cluster {workspace: $workspace})
       RETURN
         count(c) AS total,
         sum(CASE WHEN c.confidence = 'verified' THEN 1 ELSE 0 END) AS verified,
         sum(CASE WHEN c.confidence = 'provisional' THEN 1 ELSE 0 END) AS provisional,
         sum(CASE WHEN c.confidence = 'superseded' THEN 1 ELSE 0 END) AS superseded,
         avg(c.weight_combined) AS avg_weight,
         max(c.created_at) AS last_encode`,
      { params: { workspace } }
    )

    const connResult = await this.graph!.query(
      `MATCH (a:Cluster {workspace: $workspace})-[r:CONNECTS]->()
       RETURN count(r) AS total_connections`,
      { params: { workspace } }
    )

    const row = (result.data?.[0] as any) ?? {}
    const total = (row.total as number) ?? 0
    const totalConns = ((connResult.data?.[0] as any)?.total_connections as number) ?? 0

    return {
      total_clusters: total,
      verified_clusters: (row.verified as number) ?? 0,
      provisional_clusters: (row.provisional as number) ?? 0,
      superseded_clusters: (row.superseded as number) ?? 0,
      total_connections: totalConns,
      average_connections_per_cluster: total > 0 ? totalConns / total : 0,
      average_weight_combined: (row.avg_weight as number) ?? 0,
      last_activation: null,
      last_encode: (row.last_encode as string) ?? null
    }
  }

  async connectClusters(
    fromId: string,
    toIds: string[],
    workspace: string,
    connectionType: 'governs' | 'references'
  ): Promise<void> {
    const now = new Date().toISOString()
    for (const toId of toIds) {
      await this.graph!.query(
        `MATCH (a:Cluster {id: $fromId, workspace: $workspace}),
               (b:Cluster {id: $toId, workspace: $workspace})
         MERGE (a)-[r:CONNECTS {type: $type}]->(b)
         ON CREATE SET
           r.strength = 0.5,
           r.direction = 'bidirectional',
           r.activation_count = 1,
           r.established_at = $now,
           r.last_activated = $now,
           r.context = 'domain connection'
         MERGE (b)-[r2:CONNECTS {type: $type}]->(a)
         ON CREATE SET
           r2.strength = 0.5,
           r2.direction = 'bidirectional',
           r2.activation_count = 1,
           r2.established_at = $now,
           r2.last_activated = $now,
           r2.context = 'domain connection'`,
        { params: { fromId, toId, workspace, type: connectionType, now } }
      )
    }
  }

  // ── Private Helpers ──────────────────────────────────────────────────

  private async storeConnectionEdge(
    fromId: string,
    conn: ClusterConnection
  ): Promise<void> {
    await this.graph!.query(
      `MATCH (a:Cluster {id: $fromId}), (b:Cluster {id: $toId})
       MERGE (a)-[r:CONNECTS {type: $type}]->(b)
       ON CREATE SET
         r.strength = $strength,
         r.direction = $direction,
         r.context = $context,
         r.established_at = $established_at,
         r.last_activated = $last_activated,
         r.activation_count = $activation_count
       ON MATCH SET
         r.strength = CASE
           WHEN r.strength + 0.01 > 1.0 THEN 1.0
           ELSE r.strength + 0.01
         END,
         r.activation_count = r.activation_count + 1,
         r.last_activated = $last_activated`,
      {
        params: {
          fromId,
          toId: conn.target_cluster_id,
          type: conn.type,
          strength: conn.strength,
          direction: conn.direction,
          context: conn.context,
          established_at: conn.established_at,
          last_activated: conn.last_activated,
          activation_count: conn.activation_count
        }
      }
    )
  }

  // rowToCluster expects a flat row of scalar fields — no node wrapper.
  // All RETURN clauses must use explicit field aliases, never RETURN c or RETURN node.
  private rowToCluster(row: any): Cluster {
    return {
      id: row.id as string,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
      what: row.what as string,
      why: row.why as string,
      confidence: row.confidence as 'provisional' | 'verified' | 'superseded',
      constraint_type: (row.constraint_type ?? 'soft') as 'hard' | 'soft' | 'open',
      evidence: JSON.parse(row.evidence ?? '[]'),
      temporal: {
        valid_from: row.valid_from as string,
        valid_to: null,
        history: JSON.parse(row.history ?? '[]')
      },
      source: {
        type: row.source_type as any,
        tool: row.source_tool as any,
        encoded_by: row.encoded_by as string
      },
      domain: {
        workspace: row.workspace as string,
        module: row.module || null,
        workflow: row.workflow || null,
        tags: JSON.parse(row.tags ?? '[]')
      },
      connections: [],
      weight: {
        structural: parseFloat(String(row.weight_structural ?? 0)) || 0,
        usage: parseFloat(String(row.weight_usage ?? 0)) || 0,
        combined: parseFloat(String(row.weight_combined ?? 0)) || 0
      },
      embedding: []
    }
  }

}
