---
name: index-quality-audit
description: Assess what is (or would be) in the index — thin, duplicate, soft-404, parameter, stale and low-value URLs vs commercially important pages; consolidation candidates. Uses Search Console index coverage when connected.
allowed-tools: Bash(npm run cli*) Read Grep Glob Agent
arguments: [site_url]
---
**Evidence**: `content.thin`, `content.duplicate_text`, `indexability.soft_404`, `sitemap.*` findings; GSC Pages report when CONNECTED (else UNKNOWN).
**Procedure**: classify every crawled URL as keep / consolidate / noindex-candidate / fix-status with reason; large-scale deletion or noindex is high-risk and needs human approval.
**Stop**: no mass noindex proposals without per-URL evidence.
