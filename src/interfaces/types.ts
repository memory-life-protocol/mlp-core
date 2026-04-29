export interface ClusterHistory {
  what: string
  why: string
  changed_at: string
  changed_because: string
}

export interface ClusterTemporal {
  valid_from: string
  valid_to: string | null
  history: ClusterHistory[]
}

export interface ClusterSource {
  type: 'conversation' | 'document' | 'code' | 'decision' | 'experiment'
  tool: 'claude' | 'slack' | 'github' | 'notion' | 'manual'
  encoded_by: string
}

export interface ClusterDomain {
  workspace: string
  module: string | null
  workflow: string | null
  tags: string[]
}

export interface ClusterConnection {
  target_cluster_id: string
  type: 'triggers' | 'depends_on' | 'references' | 'generates' | 'governs'
  strength: number
  direction: 'unidirectional' | 'bidirectional'
  context: string
  established_at: string
  last_activated: string
  activation_count: number
}

export interface ClusterWeight {
  structural: number
  usage: number
  combined: number
}

export interface Cluster {
  id: string
  created_at: string
  updated_at: string
  what: string
  why: string
  temporal: ClusterTemporal
  source: ClusterSource
  domain: ClusterDomain
  connections: ClusterConnection[]
  weight: ClusterWeight
  embedding: number[]
}

export interface Signal {
  raw: string
  source_type: ClusterSource['type']
  source_tool: ClusterSource['tool']
  workspace: string
  encoded_by: string
  timestamp: string
}

export interface Trigger {
  query: string
  embedding: number[]
  workspace: string
  session_context: string[]
}

export interface ActivatedEntry {
  cluster: Cluster
  degree: number
  activation_score: number
}

export interface ActivationResult {
  seed: Cluster
  activated: ActivatedEntry[]
  total_activated: number
  depth_reached: number
}

export interface StrengthenResult {
  success: boolean
  new_strength: number
  previous_strength: number
}

export interface TraversePath {
  cluster: Cluster
  path: string[]
  degree: number
  path_strength: number
}

export interface TraverseResult {
  origin: Cluster
  paths: TraversePath[]
}
