export type ClusterConfidence = 'provisional' | 'verified' | 'superseded'

export type SourceType =
  'founder' |
  'conversation' |
  'document' |
  'code' |
  'decision' |
  'experiment' |
  'test' |
  'slack' |
  'github'

export interface ClusterEvidence {
  source_type: SourceType
  source_tool: 'claude' | 'slack' | 'github' | 'notion' | 'manual' | 'cursor' | 'vscode'
  corroborated_at: string
  detail: string
  encoded_by: string
}

export interface ClusterHistory {
  what: string
  why: string
  changed_at: string
  changed_because: string
  changed_by: string
}

export interface ClusterTemporal {
  valid_from: string
  valid_to: string | null
  history: ClusterHistory[]
}

export interface ClusterSource {
  type: SourceType
  tool: 'claude' | 'slack' | 'github' | 'notion' | 'manual' | 'cursor' | 'vscode'
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
  type: 'triggers' | 'depends_on' | 'references' | 'generates' | 'governs' | 'contradicts' | 'supersedes'
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
  confidence: ClusterConfidence
  evidence: ClusterEvidence[]
  temporal: ClusterTemporal
  source: ClusterSource
  domain: ClusterDomain
  connections: ClusterConnection[]
  weight: ClusterWeight
  embedding: number[]
}

export interface Signal {
  raw: string
  source_type: SourceType
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

export interface StructuralSurface {
  cluster: Cluster
  reason: string
  weight: number
}

export interface TemporalSurface {
  cluster: Cluster
  changed_at: string
  what_changed: string
  reason: string
}

export interface GapSurface {
  concept: string
  referenced_by: string
  reason: string
  provisional_cluster_id: string | null
}

export interface ConflictSurface {
  cluster_a: Cluster
  cluster_b: Cluster
  reason: string
}

export interface Guidance {
  must_respect: string[]
  should_consider: string[]
  open_space: string[]
  verify_before_building: string[]
}

export interface FullActivationResult {
  direct: ActivationResult
  surfaced: {
    structural: StructuralSurface[]
    temporal: TemporalSurface[]
    gaps: GapSurface[]
    conflicts: ConflictSurface[]
  }
  picture: Array<{
    cluster: Cluster
    relevance_score: number
    source: 'direct' | 'structural' | 'temporal'
    confidence: ClusterConfidence
    actionable: boolean
    constraint: string | null
  }>
  guidance: Guidance
  query: string
  workspace: string
  activated_at: string
  clusters_considered: number
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

export interface Workspace {
  id: string
  name: string
  created_at: string
  owner_id: string
  api_key_hash: string
}

export interface WatcherSignal {
  watcher_id: string
  watcher_type: 'github' | 'slack' | 'claude' | 'notion' | 'test' | 'manual'
  workspace: string
  raw: string
  source_type: ClusterSource['type']
  source_tool: ClusterSource['tool']
  encoded_by: string
  timestamp: string
  corroborates_cluster_id: string | null
  contradicts_cluster_id: string | null
}
