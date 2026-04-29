import type {
  Cluster,
  Trigger,
  ActivationResult,
  StrengthenResult,
  TraverseResult
} from './types.js'

interface StorageAdapter {

  // Lifecycle
  connect(): Promise<void>
  disconnect(): Promise<void>

  // Four core methods — these are the entire adapter contract

  encodeCluster(cluster: Cluster): Promise<{ success: boolean; id: string; error?: string }>

  activateCluster(
    trigger: Trigger,
    depth: number   // 1 to 6
  ): Promise<ActivationResult>

  strengthenPath(
    clusterIdA: string,
    clusterIdB: string
  ): Promise<StrengthenResult>

  traverseFrom(
    clusterId: string,
    degrees: number  // 1 to 6
  ): Promise<TraverseResult>

}

export type { StorageAdapter }
