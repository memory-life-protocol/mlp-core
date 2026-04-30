# MLP Core — Architecture

Memory Life Protocol is a memory layer that gives every AI tool
in your organisation the same deep understanding the founder has.

Built on three scientific foundations:
- Watts — small world networks, any knowledge reachable in six degrees
- Hebb — connections strengthen through use, memory improves automatically
- Vaswani — weighted attention, relevant context surfaces, irrelevant fades

---

## The Problem

Every person on a team has a different mental model of the product.
The founder has the deepest model — every decision, every constraint,
every reason why. Everyone else has a partial model built from whatever
context they received and retained.

When someone uses an LLM to build something, the output quality is
bounded by that person's understanding — not the actual spec.

- A senior developer who sat with the founder for a year gets good output
- A new hire who onboarded last week gets poor output
- A contractor who got a brief gets dangerous output
- QA who missed the architecture meeting tests against wrong assumptions

None of this is fixed by better prompting.
It is fixed by giving every person and every tool access to the same
complete organisational memory.

---

## What MLP Is Not

- Not a RAG system — RAG retrieves fragments, MLP activates structure
- Not a vector database — vectors find similarity, MLP follows meaning
- Not a document store — documents go stale, clusters strengthen with use
- Not a knowledge base — knowledge bases are read by humans, MLP is
  consumed by AI tools in real time

---

## The Cluster

Everything in MLP is a cluster. Not a row. Not a node. Not a document.

A cluster encodes:
- **what** — the knowledge itself
- **why** — the intent behind it
- **when** — full temporal history, not just a timestamp
- **connections** — what it relates to and how strongly
- **weight** — how significant it is in the full network
- **confidence** — provisional until corroborated by multiple sources
- **evidence** — every source that confirmed or challenged it

A cluster starts provisional.
It becomes verified when multiple independent sources corroborate it —
the founder states it, the codebase confirms it, the test suite locks it.
It becomes superseded when a contradiction is resolved against it.
It is never deleted. History is always preserved.

---

## Activation Not Search

MLP does not search. It activates.

A query arrives. The activation engine finds the most semantically
similar cluster — the seed. It spreads outward through weighted
connections following the strongest paths first, collecting everything
that genuinely co-activates with the seed within six degrees.

Activation score formula:
score = seed_similarity
× connection_strength_along_path
× (1 / degree)
× cluster.weight.combined

The six degree boundary is grounded in Watts small world theory:
L ≈ log(N) / log(k)
N = total clusters in the network
k = average connections per cluster
L = average path length between any two clusters

Beyond six degrees activation scores decay below signal threshold.
The boundary keeps activation fast, precise, and scoped.

---

## What Comes Back

MLP returns four layers on every activation:

**Direct** — what the query matched
Seed cluster plus everything connected within six degrees,
ordered by activation score.

**Structural** — what you need but did not ask for
High weight clusters connected to the activated neighbourhood
that the query did not reach. Important because the whole graph
says so — many things connect to them.

**Temporal** — what changed recently that affects this
Clusters whose knowledge changed in the last seven days and
connect to anything that just activated. Surfaces what is
different that the person needs to know about.

**Gaps** — what is missing
Concepts implied by activated clusters that have no cluster yet.
Flags what is not encoded so the consuming tool knows
what is uncertain.

---

## Guidance

Every activation assembles three lanes for the consuming tool:

**must_respect** — hard constraints, never violate
Verified clusters with governs connections.
Conflicts and recently changed knowledge always appear here
regardless of response mode.

**should_consider** — soft context, informs reasoning
Verified clusters that provide background and intent.

**open_space** — where the org has no position
Provisional clusters and unencoded areas.
The AI reasons freely here — MLP does not constrain
what it has not encoded.

**verify_before_building** — gaps needing human sign-off
Implied concepts with no cluster. The tool flags these
back to the team before building against them.

This is the layer that prevents AI drift.
MLP is the floor not the ceiling.
The context makes AI thinking better and more aligned —
it does not replace AI thinking.

---

## Enrichment Through Watchers

Clusters get richer through signal convergence not inference.

A watcher monitors an external source and emits signals
when it detects knowledge worth encoding or corroborating:
Founder says: "we use 7 status workflow for incidents"
→ cluster created, confidence: provisional
GitHub watcher sees: 7 status constants in codebase
→ same cluster enriched, confidence rising
Test watcher sees: test suite covering all 7 statuses
→ same cluster verified, confidence: verified

Three independent signals converging on the same knowledge.
The cluster is now not just encoded — it is corroborated by reality.

A watcher never touches the graph directly.
It emits WatcherSignals. The encoder processes them.
The protocol stays clean. The connector stays specific.

---

## Workspace Isolation

One protocol. Many isolated workspaces. Zero knowledge sharing.

Like TCP/IP — the protocol is universal, what travels through it
is private.

Every cluster carries domain.workspace.
Every query is scoped to a workspace.
The adapter enforces the boundary at the database query level.
No query can ever return clusters from a different workspace.
Not by accident. Not by design. Never.

A workspace must be explicitly created before any cluster
can be encoded. Authentication is workspace-scoped.
A tool connecting to MLP can only see its own workspace.

---

## Token Efficiency

MLP never returns full clusters to consuming tools by default.
Three response modes:

**compact** — default, ~200-400 tokens
Guidance blocks plus cluster IDs and one-line summaries.
Enough for Claude Code to write aligned code.

**standard** — ~800-1200 tokens
Full guidance plus top five cluster summaries.
For complex reasoning tasks.

**full** — ~3000+ tokens
Complete activation result.
For deep debugging only.

Embeddings are never returned to consuming tools.
Temporal history is only returned when explicitly requested
via cluster_history tool.

Conflicts and critical changes are always included
regardless of response mode.

---

## The Adapter Interface

The adapter is the only thing that touches the database.
The protocol never talks to any database directly.

Four core methods — this is the entire contract:

```typescript
encodeCluster(cluster: Cluster)
  → { success: boolean, id: string }

activateCluster(trigger: Trigger, depth: number)
  → ActivationResult

strengthenPath(clusterIdA: string, clusterIdB: string, workspace: string)
  → StrengthenResult

traverseFrom(clusterId: string, degrees: number, workspace: string)
  → TraverseResult
```

Any database that implements these four methods works with MLP.
FalkorDB, Neo4j, Postgres, SQLite — all the same contract.
The underlying storage mechanism is invisible to the protocol.

---

## The MCP Tools

Seven tools exposed to any LLM or tool that connects via MCP:

| Tool | Purpose |
|------|---------|
| encode_memory | Knowledge enters MLP |
| activate_memory | Query fires activation, returns shaped picture |
| get_cluster | Fetch one cluster by ID in full detail |
| traverse_from | Spread outward from a cluster N degrees |
| strengthen_connection | Explicit Hebbian boost between two clusters |
| list_domains | Return all domains in a workspace |
| cluster_history | Full temporal history of a cluster |

---

## File Structure
mlp-core/
src/
interfaces/         ← the protocol contracts
types.ts          ← all data types
StorageAdapter.ts ← storage contract
EmbeddingAdapter.ts ← embedding contract
ExtractionAdapter.ts ← extraction contract
WatcherAdapter.ts ← watcher contract
engine/             ← the protocol logic
encoder.ts        ← signal to cluster
activator.ts      ← query to activation result
surfacer.ts       ← activation to full picture
consolidator.ts   ← background Hebbian strengthening
mcp/
server.ts         ← MCP server, seven tools
adapters/           ← dev adapters, zero dependencies
memory.ts         ← in-memory StorageAdapter
stub-embedder.ts  ← hash-based EmbeddingAdapter
stub-extractor.ts ← heuristic ExtractionAdapter
connectors/           ← reference implementations
anthropic/
embedder.ts       ← EmbeddingAdapter via Voyage API
extractor.ts      ← ExtractionAdapter via Claude API
falkordb/
adapter.ts        ← StorageAdapter via FalkorDB
src/index.ts          ← entry point, adapter wiring

---

## Deploying Your Own MLP

MLP runs as a Node.js process that exposes tools over MCP stdio.
Any MCP-compatible tool connects to it directly.

**Minimum requirements:**
- Node.js 22+
- A StorageAdapter implementation
- An EmbeddingAdapter implementation
- An ExtractionAdapter implementation
- ANTHROPIC_API_KEY if using Anthropic connectors

**Development — zero dependencies:**
```bash
MLP_ENV=development node dist/index.js
```
Uses InMemoryAdapter and stub adapters.
No database. No API keys. Starts immediately.

**Production with FalkorDB:**
```bash
# Start FalkorDB
docker run -p 6379:6379 falkordb/falkordb

# Set environment
ANTHROPIC_API_KEY=your_key
FALKORDB_HOST=localhost
FALKORDB_PORT=6379
MLP_ENV=production

# Start MLP
node dist/index.js
```

**Connect Claude Code:**
Add to your Claude Code MCP config:
```json
{
  "mcpServers": {
    "mlp": {
      "command": "node",
      "args": ["/path/to/mlp-core/dist/index.js"],
      "env": {
        "MLP_ENV": "production",
        "ANTHROPIC_API_KEY": "your_key",
        "FALKORDB_HOST": "your_host",
        "FALKORDB_PORT": "6379"
      }
    }
  }
}
```

---

## Writing Your Own Connector

Implement any of the four interfaces in src/interfaces/.
No other files change.

Example — OpenAI embedding connector:
```typescript
import type { EmbeddingAdapter } from '../../src/interfaces/EmbeddingAdapter.js'

export class OpenAIEmbeddingAdapter implements EmbeddingAdapter {
  readonly dimension = 3072
  readonly modelName = 'text-embedding-3-large'
  readonly provider = 'openai'

  async embed(text: string): Promise<number[]> {
    // your implementation
  }
}
```

Swap it into index.ts. Everything else stays the same.

---

## What MLP Never Does

- Never predicts — prediction belongs to the AI layer on top
- Never invents — only returns what is real in the graph
- Never overlaps concepts — cluster boundaries are precise
- Never deletes — knowledge consolidates but is always preserved
- Never locks knowledge to a tool or vendor — data belongs to the org
- Never crosses workspace boundaries — isolation is enforced at query level
- Never auto-verifies — verification requires multiple independent sources

---

## License

MIT. The protocol is open. What you encode is yours.
