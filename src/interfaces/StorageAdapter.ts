import type {
  Cluster,
  Trigger,
  ActivationResult,
  StrengthenResult,
  TraverseResult,
  Workspace,
  WatcherSignal
} from './types.js'

interface StorageAdapter {

  connect(): Promise<void>
  disconnect(): Promise<void>

  createWorkspace(workspace: Workspace): Promise<{
    success: boolean
    error?: string
  }>

  getWorkspace(workspaceId: string): Promise<Workspace | null>

  encodeCluster(cluster: Cluster): Promise<{
    success: boolean
    id: string
    error?: string
  }>

  activateCluster(
    trigger: Trigger,
    depth: number
  ): Promise<ActivationResult>

  strengthenPath(
    clusterIdA: string,
    clusterIdB: string,
    workspace: string
  ): Promise<StrengthenResult>

  traverseFrom(
    clusterId: string,
    degrees: number,
    workspace: string
  ): Promise<TraverseResult>

  processWatcherSignal(signal: WatcherSignal): Promise<{
    action: 'enriched' | 'contradicted' | 'created' | 'ignored'
    cluster_id: string | null
    reason: string
  }>

  getCluster(
    clusterId: string,
    workspace: string
  ): Promise<Cluster | null>

  getClusterHistory(
    clusterId: string,
    workspace: string
  ): Promise<Cluster | null>

  listDomains(workspace: string): Promise<Array<{
    module: string | null
    workflow: string | null
    cluster_count: number
    last_encoded: string
  }>>

  getHighWeightClusters(
    workspace: string,
    topK: number
  ): Promise<Cluster[]>

  getRecentlyChangedClusters(
    workspace: string,
    since: string,
    topK: number
  ): Promise<Cluster[]>

  getPendingGaps(workspace: string): Promise<Array<{
    concept: string
    referenced_by: string
    created_at: string
  }>>

  getWorkspaceStats(workspace: string): Promise<{
    total_clusters: number
    verified_clusters: number
    provisional_clusters: number
    superseded_clusters: number
    total_connections: number
    average_connections_per_cluster: number
    average_weight_combined: number
    last_activation: string | null
    last_encode: string | null
  }>

  findSimilarClusters(
    embedding: number[],
    workspace: string,
    threshold?: number,
    excludeId?: string
  ): Promise<Array<{ cluster: Cluster; similarity: number }>>

  supersedeClusters(
    clusterIds: string[],
    workspace: string,
    supersededBy: string
  ): Promise<void>

  rebuildVectorIndex(workspace: string): Promise<{ updated: number }>

  connectClusters(
    fromId: string,
    toIds: string[],
    workspace: string,
    connectionType: 'governs' | 'references'
  ): Promise<void>

}

export type { StorageAdapter }
