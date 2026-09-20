---
name: answer-map
description: Build an Answer Map for one commercial topic — real questions clustered by intent, with a placement decision per cluster (existing page, service page, case study, guide, comparison, glossary, or new page). Not a FAQ generator. Use for AEO work.
allowed-tools: Read Grep Glob Agent
arguments: [site_id, topic]
---
Shared rules: `policies/compliance.md#faq-schema`, `templates/answer-map.md`.
**Evidence**: each question carries provenance (GSC query, site search, sales/customer question, conversion friction, competitor page URL, permitted public search evidence, AI-search prompt). Questions without provenance are marked HYPOTHESIS.
**Procedure** (`aeo-geo-strategist`): collect → cluster by intent → decide placement → specify answer shape (direct answer + evidence) → list which clusters do NOT deserve a page.
**Output**: `templates/answer-map.md` filled.
**Stop**: FAQ rich-result is never a goal; if the request is "make FAQ schema for rich results", explain the policy and stop.
