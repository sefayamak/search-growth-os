---
name: structured-data-audit
description: Audit JSON-LD for syntax, schema.org validity, and consistency with visible content; build/refresh the entity graph; recommend only truthful, supported types. Use for "schema markup", "rich results", "structured data".
allowed-tools: Bash(npm run cli*) Read Grep Glob Agent
arguments: [site_url]
---
Shared rules: `policies/compliance.md#structured-data`, `templates/entity-graph.md`.
**Evidence**: `schema.*` findings from a fresh audit; the page's visible text; Search Console enhancement reports when CONNECTED.
**Procedure**: `entity-structured-data-specialist` validates each block, maps to entity graph, lists contradictions, proposes minimal truthful changes.
**Stop**: never add ratings, reviews, awards, sameAs or people that are not on the page and true.
