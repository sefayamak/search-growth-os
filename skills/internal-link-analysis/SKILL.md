---
name: internal-link-analysis
description: Analyse the internal link graph from crawl data — depth, inbound counts, orphan candidates, anchor text quality, nofollow waste, navigation coverage of commercial pages. Use for "internal linking", "orphan pages", "site architecture".
allowed-tools: Bash(npm run cli*) Read Grep Glob
arguments: [site_url]
---
**Evidence**: `links.*`, `sitemap.orphan_candidates` findings and raw `records[].html.links` from crawl JSON.
**Procedure**: compute inbound counts and depth per URL; list commercial pages with <3 inbound links or depth ≥3; check anchor text describes the target; flag internal nofollow.
**Output**: table + concrete link additions (source page, anchor, target) with rationale; navigation changes are high-risk (`policies/high-risk-changes.md`).
