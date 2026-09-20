---
name: full-site-audit
description: Run the complete Search Growth OS audit for a registered site — read-only crawl, technical/content/schema/media checks, integration status, expert-agent interpretation and a prioritized dry-run report. Use when asked to "audit the site", "full SEO audit", "search health check".
allowed-tools: Bash(npm run cli*) Bash(node --experimental-strip-types*) Read Grep Glob Agent
arguments: [site_url, max_pages]
---
Shared rules: `policies/compliance.md`, `policies/evidence-labels.md`, `policies/source-hierarchy.md`.

**Inputs**: `site_url` (production or preview), optional `max_pages` (default 50), site registry entry.
**Evidence requirements**: a fresh crawl JSON from this run; integration states from `npm run cli -- integrations`.

**Procedure**
1. `npm run cli -- audit $site_url --max-pages ${max_pages:-50}` (read-only; identifies as SearchGrowthOS; obeys robots.txt).
2. Hand the `*.audit.json` path to `technical-search-auditor`, `entity-structured-data-specialist`, `search-performance-engineer` (parallel, isolated context).
3. Hand the crawl + registry to `content-evidence-strategist` and `aeo-geo-strategist` for the top 5 commercial pages only.
4. `chief-search-strategist` merges, resolves conflicts, scores opportunities (`schemas/opportunity.schema.json`) and runs `search-policy-compliance-officer` on every proposed change.
5. Write `reports/runs/<site>_<date>.executive.md` from `templates/executive-report.md`.

**Output schema**: executive report + opportunity list (JSON, opportunity schema) + list of UNKNOWNs.
**Stop conditions**: crawl fetches 0 pages; robots disallows our token at root (report, do not bypass); site not in registry (ask before crawling a third-party site).
