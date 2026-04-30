# Contributing to MLP Core

MLP is an open protocol. Contributions are welcome.
Read this document before opening a PR or issue.

---

## The Most Important Rule

src/interfaces/ is the protocol contract.
Changes to any file in src/interfaces/ are breaking changes.
Breaking changes require an issue and discussion before
any code is written. No exceptions.

If you are unsure whether your change is breaking —
open an issue and ask. Always safer than a rejected PR.

---

## What You Can Contribute

### New connectors — welcome, no issue required
Build a connector for a new database, embedding provider,
LLM extractor, or watcher source.
Place it in connectors/your-connector-name/.
Include a README.md explaining configuration and usage.
Open a PR directly.

Examples of connectors we want:
- connectors/openai/ — OpenAI embedding and extraction
- connectors/neo4j/ — Neo4j StorageAdapter
- connectors/postgres/ — Postgres StorageAdapter
- connectors/ollama/ — local model embedding and extraction
- connectors/github/ — GitHub watcher
- connectors/slack/ — Slack watcher
- connectors/notion/ — Notion watcher

### Bug fixes — welcome, no issue required
Fix a bug in src/engine/, src/mcp/, or src/adapters/.
Open a PR with a clear description of the bug and the fix.
Include the behaviour before and after.

### Documentation improvements — welcome, no issue required
Fix errors, improve clarity, add examples.
Open a PR directly.

### New engine features — issue required first
Any change to src/engine/ that adds new behaviour.
Open an issue describing what you want to add and why.
Wait for discussion before writing code.

### Protocol interface changes — issue required, discussion required
Any change to src/interfaces/.
Open an issue with exact proposed change and full rationale.
Breaking changes require maintainer approval before any
code is written.

---

## Branch Rules

main is protected. No direct pushes. Ever.

Branch naming:
  feat/your-feature-name     — new features
  fix/what-you-are-fixing    — bug fixes
  docs/what-you-are-updating — documentation
  connector/provider-name    — new connectors

All branches are cut from main.
All PRs target main.

---

## PR Requirements

Every PR must:
- Pass the TypeScript build with zero errors: npx tsc --noEmit
- Include a clear description of what changed and why
- Not modify src/interfaces/ without a prior approved issue
- Not break existing connector interfaces
- Not add runtime dependencies to package.json without discussion

Every PR should:
- Include a brief test description — how did you verify it works
- Update relevant documentation if behaviour changed

---

## Versioning Rules

MLP follows semantic versioning strictly.

patch x.x.N
  Bug fixes only.
  No interface changes.
  No new features.

minor x.N.x
  New features in src/engine/ or src/mcp/.
  New query helpers in StorageAdapter.
  New connectors.
  Fully backward compatible.
  No changes to existing interface method signatures.

major N.x.x
  Any change to src/interfaces/.
  Any breaking change to existing method signatures.
  Any removal of existing fields from core types.
  Requires maintainer approval and documented migration path.

Current version: 0.1.0
The protocol interfaces are established but not yet locked.
v1.0.0 is the first locked release — interfaces frozen.

---

## What a Breaking Change Is

A breaking change is anything that requires existing connectors
or implementations to change their code to keep working.

Breaking:
  Adding a required method to StorageAdapter
  Changing a method signature in any interface
  Renaming a field in Cluster or any core type
  Changing a field type in Cluster or any core type
  Removing any field from Cluster or any core type
  Changing workspace isolation behaviour
  Changing the activation score formula

Not breaking:
  Adding an optional field to Cluster
  Adding a new optional method to StorageAdapter
  Adding a new MCP tool
  Adding a new engine feature that does not change interfaces
  Adding a new connector
  Fixing a bug that does not change the interface contract

---

## Writing a Connector

Implement one or more of the four interfaces
in src/interfaces/.

Your connector must:
  Implement every method in the interface
  Enforce workspace isolation if StorageAdapter
  Never expose database internals to the engine
  Include a README.md with configuration instructions
  Export named classes — no default exports

Your connector must not:
  Import from src/engine/ or src/mcp/
  Modify any file in src/
  Add dependencies to the root package.json
  Use a different package.json in connectors/ without discussion

Structure:
  connectors/your-name/
    adapter.ts or embedder.ts or extractor.ts or watcher.ts
    README.md
    package.json (optional — only if connector has own deps)

---

## Opening an Issue

For interface changes use this format:

**What you want to change:**
Exact file and line or method name.

**Why:**
What problem does this solve that cannot be solved
without changing the interface.

**Proposed change:**
Exact TypeScript showing the before and after.

**Breaking impact:**
Which connectors and implementations would need to change.

For bugs use this format:

**What you expected:**
Exact behaviour you expected.

**What happened:**
Exact behaviour you observed.

**How to reproduce:**
Minimal steps to reproduce.

---

## Code Style

TypeScript strict mode. No exceptions.
No any types without a comment explaining why.
Import type for all interface imports.
Named exports only. No default exports.
Comments on every class explaining what it does
and what it does not do.

---

## License

By contributing you agree your contribution is licensed
under the MIT license that covers this project.
