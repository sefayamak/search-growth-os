# Search Growth OS — architecture (Phase 1)

```
discover → verify (evidence) → prioritize → fix (PR) → test (gates) → measure (experiment) → learn (learning.md) → repeat
```

| Layer | Where | Nature |
|---|---|---|
| Policies (compliance, evidence labels, high-risk, change mgmt, quality gates, sources) | `policies/` | Shared references; skills and agents cite them instead of duplicating |
| Site registry | `config/sites.yaml` (+ `sites.example.yaml`), `schemas/site-registry.schema.json`, `src/registry.ts` | NOT_CONNECTED / UNKNOWN sentinels enforced |
| Read-only crawl + audit engine | `src/crawler.ts`, `html.ts`, `robots.ts`, `sitemap.ts`, `audit.ts`, `report.ts` | Deterministic, zero deps, honest UA, robots-aware, hard caps |
| Compliance gate | `src/compliance.ts`, `hooks/compliance-gate.ts` (PreToolUse on Write/Edit), CLI `compliance` | REJECT / FLAG / PASS with policy refs |
| First-party adapters | `src/adapters/index.ts` | Interfaces + honest stubs; real clients added per integration |
| Agents | `agents/*.md` | Narrow scopes, labelled output, orchestrated by `chief-search-strategist` |
| Skills | `skills/*/SKILL.md` | Inputs, evidence requirements, procedure, output, stop conditions |
| Measurement schemas | `schemas/*.json` | audit report, AI-visibility record, experiment, opportunity |
| Evals | `evals/*/prompt.md` + graders | `claude plugin eval .` |
| Reports | `reports/` | version-controlled outputs; `reports/runs/` git-ignored scratch |
| Monitors | `monitors/monitors.json` | alerts log tail (empty until scheduled audits exist) |

Not used: Agent Teams (not a core dependency); Indexing API; SERP scraping; any second agent framework.

Scheduling (not yet created — see `docs/operating-model.md`): GitHub scheduled workflow in the *website* repo running `cli audit` on the production URL and failing on new critical findings; `/loop` or cloud Routines for weekly review once first-party data is connected.
