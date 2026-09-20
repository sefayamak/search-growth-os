---
name: geo-visibility-analysis
description: Generative-search visibility diagnosis by stage (discovery → crawl → indexing → retrieval → citation → mention → referral → conversion) with AI-crawler access facts and stored AI-visibility observations. Use for "are we cited by ChatGPT/AI Overviews", "AI visibility".
allowed-tools: Bash(npm run cli*) Read Grep Glob Agent
arguments: [site_id]
---
Shared rules: `policies/compliance.md` (llms.txt, AI manipulation), `schemas/ai-visibility-record.schema.json`.
**Evidence**: crawler-access table from the audit (FACT); GA4 AI referral rows when CONNECTED; AI-visibility observations (multiple runs per prompt) when a permitted method or licensed provider exists; otherwise UNKNOWN.
**Procedure**: `aeo-geo-strategist` diagnoses the weakest stage; `search-measurement-scientist` computes Mention/Citation rates with sample sizes.
**Output**: stage table with evidence per stage, metrics with n, recommended truthful page strengthening, UNKNOWNs.
**Stop**: any suggestion to add AI-directed text, hidden content or llms.txt-for-Google is rejected.
