# MLP Core — Technical Architecture
Version: 0.1.0

This document is the complete technical specification of the
Memory Life Protocol. Anyone implementing MLP in a new language,
building a new connector, or contributing to the protocol reads
this document first.

---

## Table of Contents

1. Protocol Overview
2. Core Data Types
3. The Adapter Interface
4. The Encoding Engine
5. The Activation Engine
6. The Surfacing Engine
7. The Consolidation Engine
8. The MCP Interface
9. Workspace Isolation
10. Response Shaping
11. Confidence and Verification
12. Connection Strengthening
13. Storage Stack
14. File Structure
15. Versioning

---

## 1. Protocol Overview

MLP is a memory protocol. It encodes organisational knowledge
into a weighted graph of clusters and activates relevant context
in response to queries.

Three scientific foundations:

**Watts small world networks**
Any cluster is reachable from any other cluster within six degrees
through the connection structure.
Formula: L ≈ log(N) / log(k)
Where N = total clusters, k = average connections per cluster,
L = average path length.
Six is the maximum activation depth. Beyond six degrees
activation scores decay below the signal threshold of 0.1.

**Hebb connection strengthening**
Connections between clusters that co-activate together grow stronger.
Formula: ΔW(i,j) = η × a(i) × a(j)
Where η = 0.01 (learning rate), a(i) and a(j) = activation scores.
Applied asynchronously after every activation. Never blocks response.

**Vaswani weighted attention**
Activation scores are weighted composites — not flat similarity scores.
Formula: score = seed_similarity
               × connection_strength_along_path
               × (1 / degree)
               × cluster.weight.combined
Higher weight clusters and stronger connection paths surface first.

---

## 2. Core Data Types

All types are defined in src/interfaces/types.ts.
This section documents the exact structure and constraints.

### SourceType

```typescript
type SourceType =
  'founder' | 'conversation' | 'document' | 'code' |
  'decision' | 'experiment' | 'test' | 'slack' | 'github'
```

Used in both ClusterSource.type and ClusterEvidence.source_type.
Unified to prevent type mismatch at assignment.

### ClusterConfidence

```typescript
type ClusterConfidence = 'provisional' | 'verified' | 'superseded'
```

- provisional: encoded from one source, not yet corroborated
- verified: corroborated by two or more independent sources
- superseded: contradiction resolved against this cluster
  Superseded clusters are never deleted. Never returned in
  activation unless explicitly requested.

### ClusterWeight

```typescript
interface ClusterWeight {
  structural: number  // 0 to 1 — inbound connection count normalised
  usage: number       // 0 to 1 — activation frequency normalised
  combined: number    // (structural + usage) / 2
}
```

All weights start at 0. Combined weight is used in activation
scoring. Structural weight updates when new clusters connect to
this one. Usage weight updates on every strengthenPath call.

### ClusterConnection

```typescript
interface ClusterConnection {
  target_cluster_id: string
  type: 'triggers' | 'depends_on' | 'references' |
        'generates' | 'governs' | 'contradicts' | 'supersedes'
  strength: number          // 0 to 1, starts at 0.5
  direction: 'unidirectional' | 'bidirectional'
  context: string           // condition under which this fires
  established_at: string    // ISO 8601
  last_activated: string    // ISO 8601
  activation_count: number
}
```

Connection strength starts at 0.5.
Maximum is 1.0 — capped on every update.
Strength increments by 0.01 per co-activation (Hebb default).
Contradicts connections are never followed during activation spread.

### Cluster

```typescript
interface Cluster {
  id: string                    // UUID v4, generated at encode time
  created_at: string            // ISO 8601
  updated_at: string            // ISO 8601
  what: string                  // the knowledge — 1 to 3 sentences
  why: string                   // the intent — 1 to 3 sentences
  confidence: ClusterConfidence
  evidence: ClusterEvidence[]   // append only, never deleted
  temporal: ClusterTemporal     // full history, append only
  source: ClusterSource         // origin of this cluster
  domain: ClusterDomain         // workspace, module, workflow, tags
  connections: ClusterConnection[] // lives inside the cluster
  weight: ClusterWeight         // starts at 0, grows through use
  embedding: number[]           // dimension matches EmbeddingAdapter
}
```

Clusters are the atomic unit. Everything is a cluster.
Nothing is stored as anything other than a cluster.
Clusters are never deleted. History is always preserved.

### Signal

```typescript
interface Signal {
  raw: string           // the raw input content
  source_type: SourceType
  source_tool: ClusterSource['tool']
  workspace: string     // must exist before encoding
  encoded_by: string    // member id or watcher id
  timestamp: string     // ISO 8601
}
```

### Trigger

```typescript
interface Trigger {
  query: string
  embedding: number[]       // pre-computed by activation engine
  workspace: string         // hard scoped — never crosses boundary
  session_context: string[] // cluster ids from this session
}
```

### ActivationResult

```typescript
interface ActivationResult {
  seed: Cluster             // primary activated cluster
  activated: ActivatedEntry[]
  total_activated: number
  depth_reached: number
}

interface ActivatedEntry {
  cluster: Cluster
  degree: number            // hops from seed
  activation_score: number  // see formula in section 1
}
```

### FullActivationResult

```typescript
interface FullActivationResult {
  direct: ActivationResult
  surfaced: {
    structural: StructuralSurface[]
    temporal: TemporalSurface[]
    gaps: GapSurface[]
    conflicts: ConflictSurface[]
  }
  picture: PictureEntry[]
  guidance: Guidance
  query: string
  workspace: string
  activated_at: string
  clusters_considered: number
}
```

### Guidance

```typescript
interface Guidance {
  must_respect: string[]          // hard constraints
  should_consider: string[]       // soft context
  open_space: string[]            // unencoded areas — AI reasons freely
  verify_before_building: string[] // gaps needing human sign-off
}
```

---

## 3. The Adapter Interface

Defined in src/interfaces/StorageAdapter.ts.
The adapter is the only thing that touches the database.
The protocol never calls any database directly.

### Lifecycle

```typescript
connect(): Promise<void>
disconnect(): Promise<void>
```

### Workspace Management

```typescript
createWorkspace(workspace: Workspace): Promise<{
  success: boolean
  error?: string
}>

getWorkspace(workspaceId: string): Promise<Workspace | null>
```

Workspace must exist before any cluster can be encoded.
Protocol does not auto-create workspaces.

### Four Core Methods

```typescript
encodeCluster(cluster: Cluster): Promise<{
  success: boolean
  id: string
  error?: string
}>
```
Upsert by id. Append to history and evidence on match.
Never overwrite. Never delete.

```typescript
activateCluster(
  trigger: Trigger,
  depth: number   // 1 to 6
): Promise<ActivationResult>
```
Find seed via vector similarity scoped to workspace.
Spread through weighted connections up to depth hops.
Apply activation score formula from section 1.
Never return superseded clusters.
Never return clusters from a different workspace.

```typescript
strengthenPath(
  clusterIdA: string,
  clusterIdB: string,
  workspace: string
): Promise<StrengthenResult>
```
Increment connection weight by 0.01.
Cap at 1.0.
Create connection at 0.5 if it does not exist.
Both clusters must belong to the same workspace.

```typescript
traverseFrom(
  clusterId: string,
  degrees: number,  // 1 to 6
  workspace: string
): Promise<TraverseResult>
```
Spread outward from cluster up to degrees hops.
Return every reachable cluster with full path and path strength.
Path strength = weakest connection weight along the path.

### Query Helpers

```typescript
getCluster(clusterId: string, workspace: string): Promise<Cluster | null>
getClusterHistory(clusterId: string, workspace: string): Promise<Cluster | null>
listDomains(workspace: string): Promise<DomainEntry[]>
getHighWeightClusters(workspace: string, topK: number): Promise<Cluster[]>
getRecentlyChangedClusters(workspace: string, since: string, topK: number): Promise<Cluster[]>
getPendingGaps(workspace: string): Promise<GapEntry[]>
getWorkspaceStats(workspace: string): Promise<WorkspaceStats>
```

### Enrichment

```typescript
processWatcherSignal(signal: WatcherSignal): Promise<{
  action: 'enriched' | 'contradicted' | 'created' | 'ignored'
  cluster_id: string | null
  reason: string
}>
```

Corroboration raises confidence from provisional to verified
when evidence count reaches 2.
Contradiction creates a contradicts connection and flags
both clusters for human review.

---

## 4. The Encoding Engine

Defined in src/engine/encoder.ts.
Transforms a Signal into a Cluster and stores it.

### Six Steps

**Step 1 — Validate**
Reject empty or whitespace-only signals immediately.

**Step 2 — Extract dimensions**
One call to ExtractionAdapter.extract(signal.raw).
Returns: what, why, module, workflow, connections_implied,
significance_hint.
Never invents. Never infers beyond what is stated.

**Step 3 — Generate embedding**
One call to EmbeddingAdapter.embed(extracted.what).
Returns number array of adapter dimension.

**Step 4 — Build cluster**
Construct full Cluster from extracted dimensions.
confidence: 'provisional'
weight: all zeros
evidence: one entry from signal source
connections: empty — resolved in step 5

**Step 5 — Resolve implied connections**
For each string in connections_implied:
  Embed the concept string
  Call activateCluster with depth 1
  If seed returned: add references connection at strength 0.5
  If no seed: store as pending gap

**Step 6 — Store**
Call storageAdapter.encodeCluster(cluster).
Return result directly.

Target: under 2 seconds total encode time.

### Watcher Signal Processing

```typescript
encoder.processWatcherSignal(signal: WatcherSignal)
```
Delegates to storageAdapter.processWatcherSignal.
Enrichment and contradiction detection handled by adapter.

---

## 5. The Activation Engine

Defined in src/engine/activator.ts.
Takes a query and returns a raw ActivationResult.

### Five Steps

**Step 1 — Clamp depth**
depth = Math.min(Math.max(depth ?? 6, 1), 6)

**Step 2 — Embed query**
One call to EmbeddingAdapter.embed(query).

**Step 3 — Build trigger**
Construct Trigger with query, embedding, workspace,
session_context.

**Step 4 — Activate**
Call storageAdapter.activateCluster(trigger, depth).

**Step 5 — Hebbian strengthening**
Extract all cluster ids from result.
Generate every unique pair.
Call strengthenPath for each pair.
Fire and forget — Promise.allSettled with no await.
Never blocks response.

Returns raw ActivationResult.
Surfacing happens in the Surfacing Engine.

---

## 6. The Surfacing Engine

Defined in src/engine/surfacer.ts.
Takes ActivationResult and returns FullActivationResult.
Four passes run in parallel via Promise.all.

### Pass 1 — Structural Surfacing

Fetch getHighWeightClusters(workspace, topK * 2).
Filter out clusters already in direct activation result.
Filter to weight.combined >= 0.6.
Keep only clusters that connect to something activated.
Surface top 5.

Purpose: surface important clusters the query did not reach
because they are structurally significant to the neighbourhood.

### Pass 2 — Temporal Surfacing

Fetch getRecentlyChangedClusters(workspace, since, topK * 2).
since = now minus 7 days.
Filter out clusters already in direct activation result.
Keep only clusters that connect to something activated
and have at least one history entry.
Surface top 5.

Purpose: surface knowledge that changed recently and affects
the activated neighbourhood. Always included in must_respect
regardless of response mode.

### Pass 3 — Gap Detection

Fetch getPendingGaps(workspace).
Filter to gaps referenced by activated clusters only.
Surface top 5.

Purpose: surface concepts implied by activated clusters
that have no cluster yet. Added to verify_before_building
in guidance.

### Pass 4 — Conflict Detection

For every activated cluster check connections of type contradicts.
Fetch the conflicting cluster.
Surface all conflicts found.

Purpose: surface contradictions explicitly so consuming tools
do not act on contested knowledge. Always included in
must_respect regardless of response mode.

### Guidance Assembly

must_respect:
  Verified clusters with governs connections
  All temporal surfaces
  All conflicts

should_consider:
  Verified clusters without governs connections
  Structural surfaces with verified confidence

open_space:
  Provisional clusters in activated result
  Areas with no encoded clusters

verify_before_building:
  All gap surfaces

### Picture Assembly

Combine direct, structural, and temporal into one ranked list.
Sort by relevance_score descending.
Direct clusters: relevance_score = activation_score
Structural clusters: relevance_score = weight.combined × 0.8
Temporal clusters: relevance_score = 0.9

---

## 7. The Consolidation Engine

Defined in src/engine/consolidator.ts.
Background process. Never blocks queries.

### Behaviour

Receives co-activation events via recordCoActivation(ids, workspace).
Records every unique pair from the id array as a co-activation event.
Runs on setInterval — default 60 seconds.
On each cycle:
  Drain event log into local batch
  Count occurrences of each unique pair
  Key: workspace::sortedIdA::sortedIdB
  For each pair: call strengthenPath
  Fire and forget per pair — failures are silent

Prevents duplicate processing within a cycle by draining
the log before processing.

---

## 8. The MCP Interface

Defined in src/mcp/server.ts.
Exposes seven tools over stdio transport.

### Tools

| Tool | Input | Output |
|------|-------|--------|
| encode_memory | raw, source_type, source_tool, workspace, encoded_by | { success, id } |
| activate_memory | query, workspace, session_context?, depth?, response_mode? | shaped FullActivationResult |
| get_cluster | cluster_id, workspace | Cluster without embedding |
| traverse_from | cluster_id, degrees, workspace | TraverseResult without embeddings |
| strengthen_connection | cluster_id_a, cluster_id_b, workspace | StrengthenResult |
| list_domains | workspace | DomainEntry[] |
| cluster_history | cluster_id, workspace | temporal history |

### Invariants

Embeddings are never returned to consuming tools.
Full temporal history is only returned by cluster_history.
Superseded clusters are never returned.
Workspace is required on every call.

---

## 9. Workspace Isolation

Workspace isolation is enforced at the database query level.
Not in application logic. Not in the MCP layer.
At the Cypher query or equivalent for every adapter.

Every encodeCluster, activateCluster, strengthenPath,
traverseFrom, and all query helpers filter by workspace.

A cluster in workspace A can never be returned to a query
from workspace B under any circumstance.

Workspace must be created via createWorkspace before any
cluster can be encoded. The protocol does not auto-create
workspaces.

---

## 10. Response Shaping

Three modes controlled by response_mode parameter on
activate_memory.

**compact** — default
Returns: guidance blocks + cluster ids with one-line summaries
Strips: embeddings, full history, surfaced detail
Token budget: ~200-400 tokens

**standard**
Returns: full guidance + top 5 cluster summaries + surfaced
Strips: embeddings, full history
Token budget: ~800-1200 tokens

**full**
Returns: complete FullActivationResult
Strips: embeddings only — never returned
Token budget: ~3000+ tokens

### Automatic Override

Regardless of response_mode:
Conflicts are always included.
Temporal surfaces are always included in must_respect.
These are never stripped regardless of mode.

---

## 11. Confidence and Verification

### Transitions

provisional → verified:
  evidence array reaches 2 or more entries
  Each entry must be from a different source_type
  Transition happens in processWatcherSignal

verified → superseded:
  Manual only — via encode with contradicts connection
  Never automatic
  Superseded clusters remain in graph permanently

provisional → superseded:
  Same as verified → superseded

### Provisional Clusters

Appear in open_space guidance lane.
Never appear in must_respect.
Never appear in should_consider.
Consuming tools treat as uncertain.
Cannot have their connections strengthened via Hebb
until verified.

---

## 12. Connection Strengthening

Three paths to strengthening:

**Automatic — Activator**
After every activateCluster call.
Every pair in the result gets strengthenPath called.
Fire and forget. Increment: 0.01 per activation.

**Background — Consolidator**
Every 60 seconds by default.
Processes batched co-activation events.
Increment: count × 0.05 per cycle.

**Explicit — strengthen_connection MCP tool**
Called directly by consuming tool.
Used when a co-activation was especially valuable.
Increment: 0.01 default.

All three paths cap strength at 1.0.
Strength never decreases in v0.1.0.

---

## 13. Storage Stack

MLP supports any storage backend via StorageAdapter.
Reference implementation uses FalkorDB.

### FalkorDB Reference Implementation

Graph nodes: Cluster nodes with all fields as properties.
Embedding stored as vecf32 for vector index queries.
Graph edges: CONNECTS edges with strength, type, direction,
activation_count as properties.

Vector index: cosine similarity, dimension 1024 (voyage-3).
Graph index: Cluster.id, Cluster.workspace, Cluster.confidence.

Seed finding: db.idx.vector.queryNodes
Activation spread: variable-length path query *1..depth
Workspace isolation: WHERE workspace = $workspace on every query.

### Dev Adapter

src/adapters/memory.ts — plain Maps, BFS traversal,
cosine similarity in process.
No persistence. No external dependencies.
Used for development and testing only.

---

## 14. File Structure
mlp-core/
src/
interfaces/
types.ts              all data types and interfaces
StorageAdapter.ts     storage backend contract
EmbeddingAdapter.ts   embedding provider contract
ExtractionAdapter.ts  LLM extraction contract
WatcherAdapter.ts     watcher connector contract
engine/
encoder.ts            signal to cluster
activator.ts          query to activation result
surfacer.ts           activation to full picture
consolidator.ts       background Hebbian strengthening
mcp/
server.ts             MCP server, seven tools
adapters/
memory.ts             dev StorageAdapter
stub-embedder.ts      dev EmbeddingAdapter
stub-extractor.ts     dev ExtractionAdapter
index.ts                entry point
connectors/
anthropic/
embedder.ts           EmbeddingAdapter via Voyage API
extractor.ts          ExtractionAdapter via Claude API
README.md
falkordb/
adapter.ts            StorageAdapter via FalkorDB
README.md
ARCHITECTURE.md           this document
README.md                 overview and quick start
CONTRIBUTING.md           contribution rules
Dockerfile                multi-stage production build
.env.example              environment variable reference
.gitignore
package.json
tsconfig.json

---

## 15. Versioning

MLP follows semantic versioning.

**Patch** x.x.N — bug fixes, no interface changes
**Minor** x.N.x — new features, backward compatible
**Major** N.x.x — breaking changes to src/interfaces/

Any change to a file in src/interfaces/ is a breaking change
and requires a major version bump. The interfaces are the
protocol contract. Breaking them breaks every connector and
every implementation built on them.

Current version: 0.1.0
Protocol interfaces: established, open for feedback
Production ready: not yet — v1.0.0 target

### What Requires a PR

Everything. No direct pushes to main.
main is protected.

### What Requires an Issue First

Any proposed change to src/interfaces/.
Discussion required before implementation.
Breaking changes need consensus.

### What Constitutes a Breaking Change

- Adding a required method to any interface
- Changing a method signature in any interface
- Changing a field type in Cluster or any core type
- Removing any field from Cluster or any core type
- Changing workspace isolation behaviour
