---
name: strategic-deep-review
description: Quarterly deep review — architecture, content and evidence inventory, entity/trust, competitor gap, AI visibility, experiment outcomes and what the system learned about this site. Expensive; run at most quarterly or after a major site change.
allowed-tools: Bash(npm run cli*) Read Grep Glob Agent
arguments: [site_id]
---
Shared rules: all `policies/*.md`; `templates/executive-report.md`.
**Procedure**: full-site-audit + competitor-gap-analysis + geo-visibility-analysis + review of all experiment records (what worked here, what did not) → `chief-search-strategist` writes the quarterly plan with ≤10 prioritized opportunities and explicit "stop doing" items.
**Output**: executive report + updated opportunity backlog + learning log entry in `reports/learning.md`.
