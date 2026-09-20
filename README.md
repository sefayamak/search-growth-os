# Search Growth OS

Reusable, multi-site **search growth operating system** for Claude Code:
SEO + AEO (answer engines) + GEO (generative search). It discovers problems
with a read-only crawler, verifies them with evidence, prioritizes, prepares
safe changes as PRs, tests them, measures, and learns — while obeying official
search-engine policy. It is not a ranking trick; it makes a site the most
useful, accessible, credible and retrievable source it can legitimately be.

Status: **standalone**. This repository is the sole canonical home of Search
Growth OS. It has no runtime dependency on any CRM, database, Supabase project,
migration, deployment or environment outside itself. A future CRM integration,
if it ever happens, goes through an explicit adapter boundary and does not exist
today. No production website has been modified.

## Layout

```
.claude-plugin/plugin.json   manifest (claude plugin validate .)
agents/                      9 expert agents (chief-search-strategist orchestrates)
skills/                      15 workflows (full-site-audit … strategic-deep-review)
hooks/                       PreToolUse compliance gate on Write/Edit
monitors/                    alerts.log tail (empty until scheduled audits exist)
policies/                    compliance, evidence labels, high-risk, change mgmt, quality gates, sources
schemas/                     site registry, audit report, AI-visibility record, experiment, opportunity
config/sites.example.yaml    registry example (copy to sites.yaml, git-ignored)
src/                         zero-dependency engine: crawler, html, robots, sitemap, audit, compliance, report, registry, adapters, cli
tests/                       node:test suite + fixture site + fixture server
evals/                       10 plugin eval cases (claude plugin eval .)
templates/                   executive report, traffic drop, answer map, gap matrix, page brief, entity graph, PR body
docs/                        architecture, operating model, integration guides
reports/                     changelog, learning log, dry-run template; runs/ is scratch
```

## Run

```bash
npm test                                   # 26 tests, spins a local fixture site
npm run cli -- audit --site pamistanbul    # registry-gated, read-only, sample crawl
npm run cli -- audit --site pamistanbul --full   # FULL_BASELINE: every eligible sitemap URL
npm run cli -- audit https://example.com   # ad-hoc URL (bypasses the registry gate)
npm run cli -- crawl https://example.com --max-pages 20 --delay 1000
npm run cli -- compliance path/to/file     # exit 0 PASS · 1 FLAG · 2 REJECT
npm run cli -- registry config/sites.example.yaml
npm run cli -- integrations
claude plugin validate .
claude plugin eval . --no-publish
claude --plugin-dir .                      # load locally
```

Node ≥ 22.18 (native TypeScript type stripping). No runtime dependencies.
`npm i --no-save typescript @types/node` then `npm run typecheck` for types.

## Guarantees
- Crawler: GET only, honest user agent (`SearchGrowthOS/…`), obeys robots.txt for its own token, same host, fixed delay, hard page cap. Never impersonates Googlebot.
- Reports: every finding has an evidence label (FACT/INFERENCE) and raw evidence. Missing data prints `NOT_CONNECTED` / `UNKNOWN`. Report header says `no production change was made`.
- Compliance gate rejects keyword stuffing, hidden text, cloaking, doorway pages, link schemes, scraped/spun content, fake evidence, fake freshness, prompt injection, SERP scraping, Indexing API misuse, llms.txt-for-Google claims; flags FAQ-rich-result objectives and high-risk paths.
- Change management: PR only, human approval for high-risk categories, rollback in every PR body.

## Onboarding the first real website (exact next action)
1. Owner confirms the website repository for pamistanbul.com and its framework; fill `repository`, `framework` in `config/sites.yaml` (copy of the example).
2. From a machine with open egress: `npm run cli -- audit https://pamistanbul.com --max-pages 80` → review the dry-run report together (this sandbox cannot reach the domain).
3. Connect Search Console and GA4 read-only (`docs/integrations/`), then set the property ids; run `npm run cli -- integrations` to confirm CONNECTED.
4. Load the plugin (`claude --plugin-dir ./search-growth-os`) and run `/search-growth-os:full-site-audit https://pamistanbul.com`.
5. Only then: first PR through `policies/change-management.md`, starting with the top critical/high finding.

## Baseline vocabulary

A crawl that sampled the site is a `PARTIAL_BASELINE_SAMPLE`. Only a run that
accounted for every eligible sitemap URL — each one processed or carrying an
explicit failure reason — is a `FULL_BASELINE`. The report prints which one it
is, and the label is computed, never asserted.

Every finding also carries a confidence: `CONFIRMED` for a directly measured
defect, `CANDIDATE` for anything a heuristic inferred, plus `FALSE_POSITIVE`
and `UNKNOWN`. Nothing is promoted to confirmed without evidence.
