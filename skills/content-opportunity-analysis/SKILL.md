---
name: content-opportunity-analysis
description: Find content opportunities modelled on intent, task, entity/topic coverage and first-party evidence for the site's core commercial topics. Produces page briefs and an explicit "do not add" list. Use for "what should we write", "content gaps".
allowed-tools: Read Grep Glob Agent Bash(npm run cli*)
arguments: [site_id, topic]
---
Shared rules: `policies/compliance.md` (doorway, scaled content), `templates/page-brief.md`.
**Inputs**: registry topics, crawl JSON, Search Console queries when CONNECTED, owner-supplied assets (case studies, photos, process docs).
**Procedure**: `content-evidence-strategist` maps existing pages to intents; identifies missing evidence rather than missing keywords; drafts briefs only for needs with distinct user value; `search-policy-compliance-officer` reviews the brief list.
**Output**: briefs + "should NOT be added" list + questions for the owner (assets needed).
**Stop**: no confirmed commercial topics in registry → ask.
