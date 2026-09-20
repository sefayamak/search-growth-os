---
name: technical-audit
description: Technical-only search audit (crawlability, indexability, canonicals, redirects, sitemaps, robots, rendering, hreflang, mobile). Faster and cheaper than full-site-audit. Use for "check indexing", "canonical issues", "why isn't X indexed".
allowed-tools: Bash(npm run cli*) Read Grep Glob Agent
arguments: [site_url, max_pages]
---
Shared rules: `policies/compliance.md`, `policies/evidence-labels.md`.
**Inputs**: `site_url`, optional `max_pages`, optional website repo path for cause analysis.
**Evidence**: fresh crawl JSON; Search Console URL Inspection when CONNECTED (else UNKNOWN).
**Procedure**: run `npm run cli -- audit`, then `technical-search-auditor` on the JSON; when a repo path is given, locate the template/config line causing each critical/high finding.
**Output**: findings table (id, severity, label, url, cause, smallest fix, risk category), "looks wrong but fine" list, UNKNOWNs.
**Stop**: same as full-site-audit; never propose Indexing API use for ordinary pages.
