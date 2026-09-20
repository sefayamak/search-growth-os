---
name: competitor-gap-analysis
description: Compare the site against its owner-confirmed competitor set on coverage, depth, evidence, architecture, entities, links, media, technical quality and citations; output a Competitor Gap Matrix that separates "better", "irrelevant", "risky" and "we can be superior". Use for "why does X outrank us".
allowed-tools: Bash(npm run cli*) Read Grep Glob Agent
arguments: [site_id]
---
Shared rules: `policies/compliance.md` (no copying, no SERP scraping), `templates/competitor-gap-matrix.md`.
**Evidence**: read-only crawls of competitor sites (`npm run cli -- crawl <url> --max-pages 20 --delay 1500`, respecting their robots.txt), licensed third-party data labelled by provider/date, first-party comparisons when CONNECTED.
**Procedure**: `competitor-intelligence-analyst` fills the matrix; `content-evidence-strategist` proposes where we can offer genuinely superior information.
**Stop**: competitor set empty → ask owner; never fabricate competitor traffic or rankings.
