# Search Growth OS — architecture

```
discover → verify (evidence) → prioritize → fix (PR) → test (gates) → measure (experiment) → learn → repeat
```

Standalone by design. This repository has no runtime dependency on any CRM,
database, Supabase project, migration, deployment target, environment or Vercel
project. It installs, tests and runs from a clean clone with nothing but Node.
A future CRM integration, should one ever be wanted, goes through an explicit
adapter boundary under `src/adapters/`; it does not exist today and must not be
assumed by any code here.

| Layer | Where | Nature |
|---|---|---|
| Policies | `policies/` | compliance, evidence labels, high-risk changes, change management, quality gates, source hierarchy, portfolio isolation. Shared references that skills and agents cite instead of duplicating |
| Site registry | `config/sites.yaml`, `schemas/site-registry.schema.json`, `src/registry.ts` | seven sites, onboarding gate, NOT_CONNECTED / UNKNOWN sentinels enforced |
| Content cadence | `src/cadence.ts`, CLI `portfolio` | measures days since last publish per site; rejects build-stamped `lastmod`; reports UNKNOWN rather than guessing |
| Crawl + audit engine | `src/crawler.ts`, `html.ts`, `robots.ts`, `sitemap.ts`, `audit.ts`, `report.ts` | deterministic, zero dependencies, honest user agent, robots-aware, hard caps, sample and full-baseline modes |
| Compliance gate | `src/compliance.ts`, `hooks/compliance-gate.ts` (PreToolUse on Write/Edit), CLI `compliance` | REJECT / FLAG / PASS with policy references |
| First-party adapters | `src/adapters/index.ts` | Search Console, GA4, Bing, IndexNow, logs, GitHub, third-party. Interfaces with honest stubs; a missing credential returns null, never zero |
| Agents | `agents/*.md` | nine narrow specialists, orchestrated by `chief-search-strategist` |
| Skills | `skills/*/SKILL.md` | eighteen workflows, each with inputs, evidence requirements, procedure, output and stop conditions |
| Schemas | `schemas/*.json` | audit report, AI-visibility record, experiment, opportunity, competitor candidate, site registry |
| Per-site artifacts | `sites/<id>/` | baselines, experiments, reports, competitors, entity facts. Never shared between sites |
| Evals | `evals/*/prompt.md` + graders | `claude plugin eval .` |
| Remote runner | `.github/workflows/search-audit.yml`, `portfolio-check.yml` | read-only crawl and weekly portfolio cadence check on a GitHub runner, no secrets |
| Binaries | `bin/summarize.ts` | compact greppable summary of an audit JSON |
| Reports | `reports/` | changelog, learning log, dry-run template; `reports/runs/` is git-ignored scratch |
| Monitors | `monitors/monitors.json` | alerts log tail (empty until scheduled audits write to it) |

Deliberately absent: Agent Teams as a core dependency, the Google Indexing API,
SERP scraping, any second agent framework, any auto-remediation workflow.

## Baseline vocabulary

`PARTIAL_BASELINE_SAMPLE` is a crawl that sampled the site by following links up
to a page cap. `FULL_BASELINE` is a run where the sitemap was the URL universe
and every eligible entry was either processed or carries an explicit failure
reason. The label is computed from coverage, never asserted, and a run truncated
by the page cap reports itself as partial.

## Finding trust

Every finding carries a confidence alongside its severity and evidence label:
`CONFIRMED` for a directly measured defect, `CANDIDATE` for anything a heuristic
inferred, plus `FALSE_POSITIVE` and `UNKNOWN`. A test enforces that an inference
cannot ship as confirmed. This exists because an early crawl produced 98 false
positives out of 100 high findings, and a report nobody can trust is worse than
no report.

## Cost discipline

Deterministic checks live in code. LLM reasoning is reserved for semantic work
that genuinely needs judgement. Crawl results carry a content hash for change
detection, deep audits are separate from lightweight recurring checks, and the
runner is free for public crawling because it needs no credentials.
