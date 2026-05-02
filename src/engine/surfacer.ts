/**
 * Surfacer
 *
 * Takes a raw ActivationResult and enriches it into a
 * FullActivationResult by running four surfacing passes.
 *
 * What it does:
 *   - Structural surfacing — finds high weight clusters connected
 *     to the activated neighbourhood that the query did not reach.
 *     These are important because the whole graph says so.
 *
 *   - Temporal surfacing — finds clusters that changed recently
 *     and connect to anything that just activated.
 *     Surfaces what changed that the person needs to know about.
 *
 *   - Gap detection — finds concepts implied by activated clusters
 *     that have no cluster yet. Surfaces what is missing.
 *     Provisional clusters are flagged for human verification.
 *     Never auto-verifies. Never encodes without confidence gate.
 *
 *   - Conflict detection — finds clusters that contradict anything
 *     in the activated result. Surfaces conflicts explicitly so
 *     the consuming tool knows not to act on contested knowledge.
 *
 *   - Guidance assembly — builds three lanes for the consuming tool:
 *     must_respect: hard constraints, never violate
 *     should_consider: soft context, informs reasoning
 *     open_space: where org has no position, AI reasons freely
 *     verify_before_building: provisional gaps needing sign-off
 *
 * What it does not do:
 *   - It never modifies the graph
 *   - It never calls an LLM
 *   - It never crosses workspace boundaries
 *   - It never invents knowledge not present in the graph
 *   - It never auto-verifies provisional clusters
 *
 * This is the layer that makes MLP proactive not reactive.
 * The person asked a question. MLP returns what they asked for
 * plus what they did not know to ask for.
 */

import type { StorageAdapter } from '../interfaces/StorageAdapter.js'
import type {
  ActivationResult,
  FullActivationResult,
  Cluster,
  StructuralSurface,
  TemporalSurface,
  GapSurface,
  ConflictSurface,
  Guidance
} from '../interfaces/types.js'

// How far back to look for temporal changes — 7 days default
const TEMPORAL_WINDOW_DAYS = 7

// Minimum weight to surface a structural cluster
const STRUCTURAL_WEIGHT_THRESHOLD = 0.6

// Maximum clusters per surfacing pass
const SURFACE_TOP_K = 5

export class Surfacer {

  constructor(
    private storageAdapter: StorageAdapter
  ) {}

  async surface(
    activationResult: ActivationResult,
    workspace: string,
    query: string
  ): Promise<FullActivationResult> {

    const now = new Date()

    // Run four surfacing passes in parallel — none block each other
    const [
      structural,
      temporal,
      gaps,
      conflicts
    ] = await Promise.all([
      this.surfaceStructural(activationResult, workspace),
      this.surfaceTemporal(activationResult, workspace, now),
      this.surfaceGaps(activationResult, workspace),
      this.surfaceConflicts(activationResult, workspace)
    ])

    // Assemble guidance from everything surfaced
    const guidance = this.assembleGuidance(
      activationResult,
      structural,
      temporal,
      gaps,
      conflicts
    )

    // Build the full ranked picture — direct + surfaced combined
    const picture = this.assemblePicture(
      activationResult,
      structural,
      temporal
    )

    return {
      direct: activationResult,
      surfaced: {
        structural,
        temporal,
        gaps,
        conflicts
      },
      picture,
      guidance,
      query,
      workspace,
      activated_at: now.toISOString(),
      clusters_considered:
        activationResult.total_activated +
        structural.length +
        temporal.length
    }
  }

  // ── Structural Surfacing ──────────────────────────────────────────
  // Find high weight clusters connected to the activated neighbourhood
  // that the query did not directly reach.

  private async surfaceStructural(
    result: ActivationResult,
    workspace: string
  ): Promise<StructuralSurface[]> {

    const activatedIds = new Set([
      result.seed?.id,
      ...result.activated.map(a => a.cluster.id)
    ].filter(Boolean))

    const highWeight = await this.storageAdapter.getHighWeightClusters(
      workspace,
      SURFACE_TOP_K * 2
    )

    const surfaces: StructuralSurface[] = []

    for (const cluster of highWeight) {
      // Skip clusters already in the direct activation result
      if (activatedIds.has(cluster.id)) continue

      // Skip clusters below threshold
      if (cluster.weight.combined < STRUCTURAL_WEIGHT_THRESHOLD) continue

      // Check if this cluster connects to anything activated
      const connectsToActivated = cluster.connections.some(
        conn => activatedIds.has(conn.target_cluster_id)
      )

      if (connectsToActivated) {
        surfaces.push({
          cluster,
          reason: `High structural significance (weight: ${cluster.weight.combined.toFixed(2)}) connected to your query neighbourhood`,
          weight: cluster.weight.combined
        })
      }

      if (surfaces.length >= SURFACE_TOP_K) break
    }

    return surfaces
  }

  // ── Temporal Surfacing ────────────────────────────────────────────
  // Find clusters that changed recently and connect to what activated.

  private async surfaceTemporal(
    result: ActivationResult,
    workspace: string,
    now: Date
  ): Promise<TemporalSurface[]> {

    const activatedIds = new Set([
      result.seed?.id,
      ...result.activated.map(a => a.cluster.id)
    ].filter(Boolean))

    const since = new Date(
      now.getTime() - TEMPORAL_WINDOW_DAYS * 24 * 60 * 60 * 1000
    ).toISOString()

    const recentlyChanged = await this.storageAdapter.getRecentlyChangedClusters(
      workspace,
      since,
      SURFACE_TOP_K * 2
    )

    const surfaces: TemporalSurface[] = []

    for (const cluster of recentlyChanged) {
      // Skip clusters already in direct activation
      if (activatedIds.has(cluster.id)) continue

      // Check if this cluster connects to anything activated
      const connectsToActivated = cluster.connections.some(
        conn => activatedIds.has(conn.target_cluster_id)
      )

      if (connectsToActivated && cluster.temporal.history.length > 0) {
        const lastChange = cluster.temporal.history[
          cluster.temporal.history.length - 1
        ]

        surfaces.push({
          cluster,
          changed_at: lastChange.changed_at,
          what_changed: lastChange.what,
          reason: `This cluster changed ${this.daysAgo(lastChange.changed_at, now)} and connects to your query`
        })
      }

      if (surfaces.length >= SURFACE_TOP_K) break
    }

    return surfaces
  }

  // ── Gap Detection ─────────────────────────────────────────────────
  // Find concepts implied by activated clusters with no cluster yet.

  private async surfaceGaps(
    result: ActivationResult,
    workspace: string
  ): Promise<GapSurface[]> {

    const pendingGaps = await this.storageAdapter.getPendingGaps(workspace)

    const activatedIds = new Set([
      result.seed?.id,
      ...result.activated.map(a => a.cluster.id)
    ].filter(Boolean))

    const surfaces: GapSurface[] = []

    for (const gap of pendingGaps) {
      // Only surface gaps referenced by activated clusters
      if (!activatedIds.has(gap.referenced_by)) continue

      surfaces.push({
        concept: gap.concept,
        referenced_by: gap.referenced_by,
        reason: `This concept is implied by an activated cluster but has no encoded knowledge yet`,
        provisional_cluster_id: null
      })

      if (surfaces.length >= SURFACE_TOP_K) break
    }

    return surfaces
  }

  // ── Conflict Detection ────────────────────────────────────────────
  // Find clusters that contradict anything in the activated result.

  private async surfaceConflicts(
    result: ActivationResult,
    workspace: string
  ): Promise<ConflictSurface[]> {

    if (!result.seed) return []

    const allActivated: Cluster[] = [
      result.seed,
      ...result.activated.map(a => a.cluster)
    ]

    const conflicts: ConflictSurface[] = []

    for (const cluster of allActivated) {
      const contradictions = cluster.connections.filter(
        conn => conn.type === 'contradicts'
      )

      for (const contradiction of contradictions) {
        const conflictingCluster = await this.storageAdapter.getCluster(
          contradiction.target_cluster_id,
          workspace
        )

        if (conflictingCluster) {
          conflicts.push({
            cluster_a: cluster,
            cluster_b: conflictingCluster,
            reason: `These clusters contain contradicting knowledge — resolve before acting`
          })
        }
      }
    }

    return conflicts
  }

  // ── Guidance Assembly ─────────────────────────────────────────────
  // Build three lanes for the consuming tool.

  private assembleGuidance(
    result: ActivationResult,
    structural: StructuralSurface[],
    temporal: TemporalSurface[],
    gaps: GapSurface[],
    conflicts: ConflictSurface[]
  ): Guidance {

    const must_respect: string[] = []
    const should_consider: string[] = []
    const open_space: string[] = []
    const verify_before_building: string[] = []

    if (!result.seed) {
      open_space.push(
        'No organisational memory found for this query — reason freely'
      )
      return { must_respect, should_consider, open_space, verify_before_building }
    }

    // Treat as verified if: confidence === 'verified' OR encoded by founder
    function shouldTreatAsVerified(cluster: Cluster): boolean {
      if (cluster.confidence === 'verified') return true
      if (cluster.source.encoded_by.toLowerCase() === 'founder') return true
      if (cluster.source.type === 'founder') return true
      return false
    }

    const allActivated = [
      result.seed,
      ...result.activated.map(a => a.cluster)
    ].filter(Boolean)

    // Route by confidence + constraint_type
    for (const cluster of allActivated) {
      if (shouldTreatAsVerified(cluster)) {
        if (cluster.constraint_type === 'hard') {
          if (!must_respect.includes(cluster.what)) {
            must_respect.push(cluster.what)
          }
        } else if (cluster.constraint_type === 'open') {
          if (!open_space.includes(cluster.what)) {
            open_space.push(cluster.what)
          }
        } else {
          if (!should_consider.includes(cluster.what)) {
            should_consider.push(cluster.what)
          }
        }
      } else {
        // Provisional non-founder clusters go to open_space
        if (!open_space.includes(cluster.what)) {
          open_space.push(cluster.what)
        }
      }
    }

    // Structural surfaces routed by confidence + constraint_type
    for (const surface of structural) {
      const cluster = surface.cluster
      if (shouldTreatAsVerified(cluster)) {
        if (cluster.constraint_type === 'hard') {
          must_respect.push(`${cluster.what} — ${surface.reason}`)
        } else if (cluster.constraint_type === 'open') {
          open_space.push(`${cluster.what} — ${surface.reason}`)
        } else {
          should_consider.push(`${cluster.what} — ${surface.reason}`)
        }
      } else {
        open_space.push(`${cluster.what} — ${surface.reason}`)
      }
    }

    // Temporal surfaces become must_respect if recently changed
    for (const surface of temporal) {
      must_respect.push(
        `RECENTLY CHANGED: ${surface.cluster.what} — changed ${surface.changed_at}`
      )
    }

    // Gaps become verify_before_building
    for (const gap of gaps) {
      verify_before_building.push(
        `"${gap.concept}" is referenced but not yet encoded — verify with team before building`
      )
    }

    // Conflicts block action entirely
    for (const conflict of conflicts) {
      must_respect.push(
        `CONFLICT: "${conflict.cluster_a.what}" contradicts "${conflict.cluster_b.what}" — do not act until resolved`
      )
    }

    return { must_respect, should_consider, open_space, verify_before_building }
  }

  // ── Picture Assembly ──────────────────────────────────────────────
  // Combine direct + surfaced into one ranked list.

  private assemblePicture(
    result: ActivationResult,
    structural: StructuralSurface[],
    temporal: TemporalSurface[]
  ): FullActivationResult['picture'] {

    const picture: FullActivationResult['picture'] = []

    // Direct clusters first
    if (result.seed) {
      picture.push({
        cluster: result.seed,
        relevance_score: 1.0,
        source: 'direct',
        confidence: result.seed.confidence,
        actionable: result.seed.confidence === 'verified',
        constraint: result.seed.connections.some(
          c => c.type === 'governs'
        ) ? 'This cluster governs dependent workflows' : null
      })
    }

    for (const entry of result.activated) {
      picture.push({
        cluster: entry.cluster,
        relevance_score: entry.activation_score,
        source: 'direct',
        confidence: entry.cluster.confidence,
        actionable: entry.cluster.confidence === 'verified',
        constraint: null
      })
    }

    // Structural surfaces
    for (const surface of structural) {
      picture.push({
        cluster: surface.cluster,
        relevance_score: surface.weight * 0.8,
        source: 'structural',
        confidence: surface.cluster.confidence,
        actionable: surface.cluster.confidence === 'verified',
        constraint: null
      })
    }

    // Temporal surfaces
    for (const surface of temporal) {
      picture.push({
        cluster: surface.cluster,
        relevance_score: 0.9,
        source: 'temporal',
        confidence: surface.cluster.confidence,
        actionable: surface.cluster.confidence === 'verified',
        constraint: `Changed recently: ${surface.changed_at}`
      })
    }

    // Sort by relevance score descending
    return picture.sort((a, b) => b.relevance_score - a.relevance_score)
  }

  // ── Helpers ───────────────────────────────────────────────────────

  private daysAgo(isoDate: string, now: Date): string {
    const diff = now.getTime() - new Date(isoDate).getTime()
    const days = Math.floor(diff / (1000 * 60 * 60 * 24))
    if (days === 0) return 'today'
    if (days === 1) return 'yesterday'
    return `${days} days ago`
  }

}
