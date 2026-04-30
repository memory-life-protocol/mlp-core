# Memory Life Protocol

AI coding is genuinely powerful. But context loss mid-session
is not a minor inconvenience for production software teams —
it is a structural problem.

Every developer gives their AI tool context based on their own
understanding. Every session starts over. Every tool switch loses
everything. The result is a team where the AI is powerful but the
thinking is fragmented — each person's AI reflects their partial
model of the product, not the product itself.

MLP is the base layer that fixes this. Not by replacing human or
AI thinking — but by giving both a single source to think from.

Engineers encode architecture decisions. QA encodes test logic.
PMs encode requirements. Founders encode intent. The graph becomes
the shared understanding of the whole team. Any AI tool that
connects operates from that shared understanding. Any human that
queries it gets the same picture.

The thinking happens on top. The memory lives underneath.
Permanent, collective, owned by the team.

---

## The Science

Built on three proven foundations:

**Watts** — small world networks. Any piece of knowledge is
reachable from any other in six degrees through the connection
structure. The graph does not need to be exhaustive to be complete.

**Hebb** — connections strengthen through use. Every time two
clusters activate together their connection grows stronger.
The memory improves automatically the more it is used.
No manual curation required.

**Vaswani** — weighted attention. Relevant context surfaces
strongly. Irrelevant context fades. The protocol returns signal
not noise.

No existing tool combines all three as a standalone protocol
that any team can connect to.

---

## How It Works

Everything in MLP is a cluster — a unit of knowledge that carries
what was decided, why it exists, when it changed, what it connects
to, and how confident the network is in it.

When a query arrives MLP does not search. It activates.

The engine finds the most relevant cluster, spreads outward through
weighted connections up to six degrees, and returns not just what
you asked for but what you did not know to ask for — structurally
important connected knowledge, recently changed decisions that affect
your query, and explicit gaps where knowledge has not been encoded yet.

Every activation strengthens the connections that fired.
The graph gets more precise the more it is used.

---

## Who Uses It

**Developers** — query before building. Get the architecture
decisions, constraints, and intent behind the module you are
touching. Build aligned output without a briefing call.

**AI coding tools** — Claude Code, Cursor, and any MCP-compatible
tool connects directly. The tool gets the same organisational
context every developer gets. Every session. Every tool. Every model.

**QA engineers** — query before writing tests. Get the full spec
including edge cases, permission constraints, and workflow
dependencies. Test against the real behaviour not a partial
understanding of it.

**New hires** — connect on day one. Query anything. Get the
full context — what was decided, why, what changed, what it
connects to. No onboarding meetings required.

**PMs and founders** — encode decisions as they are made.
Not retroactively. Not in a document nobody reads. In the moment,
into the protocol, where it immediately becomes part of the
organisational memory every tool accesses.

---

## Quick Start

**Development — zero dependencies, no database, no API keys:**

```bash
git clone https://github.com/memory-life-protocol/mlp-core
cd mlp-core
npm install
npm run build
MLP_ENV=development node dist/index.js
```

MLP starts immediately using in-memory storage and stub adapters.
No external services required.

**Production with FalkorDB and Anthropic:**

```bash
# Start FalkorDB
docker run -p 6379:6379 falkordb/falkordb

# Set environment
export ANTHROPIC_API_KEY=your_key
export FALKORDB_HOST=localhost
export FALKORDB_PORT=6379
export MLP_ENV=production

# Start MLP
node dist/index.js
```

Copy `.env.example` to `.env` for local configuration.

---

## Connect Your AI Tool

Add MLP to your Claude Code MCP configuration:

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

Any MCP-compatible tool connects the same way.
Claude Code, Cursor, or any tool that speaks MCP.

Once connected your tool has access to seven tools:

- `encode_memory` — knowledge enters MLP
- `activate_memory` — query fires activation, returns full picture
- `get_cluster` — fetch one cluster by id in full detail
- `traverse_from` — explore the neighbourhood of a cluster
- `strengthen_connection` — explicit Hebbian boost
- `list_domains` — see what knowledge exists before querying
- `cluster_history` — full history of how a decision evolved

---

## Encode Your First Memory

```json
{
  "tool": "encode_memory",
  "raw": "We use a seven status workflow for incidents — open, triaged, assigned, investigating, resolved, closed, cancelled. Each status has a defined owner and explicit handoff criteria. This was designed after unstructured incident handling caused three missed escalations in Q2.",
  "source_type": "decision",
  "source_tool": "manual",
  "workspace": "your-workspace-id",
  "encoded_by": "founder"
}
```

Query it back:

```json
{
  "tool": "activate_memory",
  "query": "incident module task assignment",
  "workspace": "your-workspace-id",
  "response_mode": "compact"
}
```

MLP returns the incident workflow, everything connected to it,
what governs it, what changed recently, and explicit guidance
on what any tool must respect when building against it.

---

## Write Your Own Connector

MLP ships with reference connectors for FalkorDB and Anthropic.
Any database and any LLM provider works.

Implement one interface. Nothing else changes.

```typescript
import type { EmbeddingAdapter } from './src/interfaces/EmbeddingAdapter.js'

export class OpenAIEmbeddingAdapter implements EmbeddingAdapter {
  readonly dimension = 3072
  readonly modelName = 'text-embedding-3-large'
  readonly provider = 'openai'

  async embed(text: string): Promise<number[]> {
    // your implementation
  }
}
```

Four interfaces cover everything:

- `StorageAdapter` — swap the database
- `EmbeddingAdapter` — swap the embedding model
- `ExtractionAdapter` — swap the LLM used for encoding
- `WatcherAdapter` — add a new knowledge source

See `connectors/` for reference implementations.
See `ARCHITECTURE.md` for the full protocol specification.

---

## Workspace Isolation

Every organisation gets a completely isolated workspace.
Clusters, connections, and weights never cross workspace boundaries.
The isolation is enforced at the database query level — not in
application logic.

One protocol. Many isolated workspaces. Zero knowledge sharing.

Like TCP/IP — the protocol is universal.
What travels through it is private.

---

## What MLP Never Does

- Never invents — only returns what is real in the graph
- Never deletes — knowledge consolidates but is always preserved
- Never shares across workspaces — isolation is absolute
- Never locks your data — MIT license, full export always available
- Never replaces thinking — it is the floor, not the ceiling

---

## Contributing

MLP is open source and MIT licensed.
The protocol interfaces are the contribution target —
`src/interfaces/` defines what MLP is.

If you build a connector for a new database or LLM provider
open a PR in `connectors/`.

If you find a flaw in the protocol design open an issue.
The interfaces are the contract. Changes to them are breaking changes
and need discussion before merging.

---

## License

MIT — the protocol is open. What you encode is yours.
