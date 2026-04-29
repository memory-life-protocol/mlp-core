/**
 * StorageAdapter Interface
 *
 * Any storage backend that wants to work with MLP must implement this.
 * FalkorDB, Neo4j, Postgres, SQLite, in-memory — all the same contract.
 *
 * MLP core never imports a database driver. It only ever calls these methods.
 */

import type { Cluster, Connection, ActivatedCluster } from './types.js';

export interface StorageAdapter {

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /**
   * Initialise connection to the storage backend.
   * Called once at server startup.
   */
  connect(): Promise<void>;

  /**
   * Gracefully close connections.
   * Called on server shutdown.
   */
  disconnect(): Promise<void>;

  // ── Clusters ───────────────────────────────────────────────────────────────

  /**
   * Store a new cluster or update an existing one (upsert by id).
   */
  storeCluster(cluster: Cluster): Promise<string>;

  /**
   * Retrieve a single cluster by ID.
   * Returns null if not found.
   */
  getCluster(id: string): Promise<Cluster | null>;

  /**
   * Vector similarity search.
   * Find the top-k clusters whose embeddings are closest to the query vector.
   * Returns clusters with a similarity score attached.
   */
  vectorSearch(embedding: number[], topK: number): Promise<Array<Cluster & { score: number }>>;

  // ── Connections ────────────────────────────────────────────────────────────

  /**
   * Create a connection between two clusters, or strengthen if it exists.
   */
  storeConnection(connection: Connection): Promise<void>;

  /**
   * Increase the weight of an existing connection by delta.
   */
  strengthenConnection(fromId: string, toId: string, delta: number): Promise<void>;

  // ── Activation ─────────────────────────────────────────────────────────────

  /**
   * Spread activation from a set of seed cluster IDs.
   * Traverses weighted connections up to maxDegrees hops.
   * Returns clusters ordered by composite activation score.
   *
   * Score formula: product of connection weights along the path × cluster strength
   * This is the Watts + Hebb combination at the core of MLP.
   */
  spreadActivation(
    seedIds: string[],
    maxDegrees: number,
    topK: number
  ): Promise<ActivatedCluster[]>;
}
