# Phase 1 acceptance record — 2026-09-20

Measured in this environment. Nothing below is claimed without a command that produced it.

## Gate items

| Requirement | Result | Evidence |
|---|---|---|
| Plugin loads | PASS | `claude plugin validate .` → "Validation passed" |
| Core skills discoverable | PASS | `claude --plugin-dir . -p "…ListSkills…"` listed all 15 `search-growth-os:*` skills |
| Core agents discoverable | PARTIAL | 9 agent files load with the plugin (validated manifest, plugin loads); the listing probe enumerated skills only, so agent exposure is confirmed by loading, not by a tool listing |
| Compliance rules active | PASS | PreToolUse hook: hidden-text write → exit 2 with policy reference; robots.txt write → FLAG with `additionalContext` |
| Test website crawled read-only | PASS | Local fixture site (15 pages) crawled; GET only, own robots token honoured (`/admin/secret` skipped) |
| Structured audit from real crawl data | PASS | `reports/runs/127.0.0.1_4321_*.audit.{json,md}`: 1 critical, 7 high, 24 medium, 19 low |
| Missing external data labelled | PASS | All 7 integrations printed `NOT_CONNECTED`; report carries an UNKNOWN section |
| Tests pass | PASS | 26/26 (`node --experimental-strip-types --test tests/*.test.ts`); `tsc --noEmit` clean |
| Plugin evals run | PASS | `claude plugin eval .` → **10/10 cases passed, overall score 1.0**, 10 runs, $0.90, 148 s. Results: `evals/results/phase1-run.json` (git-ignored) |
| No production website modified | PASS | Only `search-growth-os/` added; crawls targeted 127.0.0.1 only |

## Detections proven against the fixture site

accidental noindex in sitemap (critical, INFERENCE) · X-Robots-Tag noindex · multiple canonicals · canonical → 500 · 2-hop redirect chain · sitemap listing a redirecting URL · 500 on an internal link · soft 404 · orphan sitemap URL · duplicate visible text · hidden text block · invalid JSON-LD · schema name absent from visible content · aggregateRating without visible reviews · JS-dependent content · missing alt · robots-blocked crawler (GPTBot).

## Compliance gate proven

REJECT: keyword stuffing, hidden text, doorway generation, Indexing API outside JobPosting/BroadcastEvent, llms.txt-as-Google-ranking, fake evidence, fake freshness, UA cloaking, link buying, SERP scraping, prompt injection.
FLAG: FAQ rich-result objective, high-risk paths (robots.txt, layouts, sitemap, config).
PASS: natural Turkish service copy (no false positive).

## Eval cases (all passing)

detects accidental noindex and routes re-indexing away from the Indexing API · distinguishes seasonality from a deploy-caused drop and labels both as hypotheses · refuses to invent Search Console data · refuses Indexing API misuse · does not claim llms.txt helps Google · names conversion tracking as the forgotten quality gate · rejects doorway-page generation · rejects fake aggregateRating schema · rejects keyword stuffing · routes robots.txt and sitewide template changes to human approval with rollback.

Eval cases run in an empty sandbox working directory, so each prompt is self-contained; they test the plugin's guidance, not file access.

## Limitations

- The sandbox egress proxy blocks pamistanbul.com and developers.google.com. No live site was crawled; official policy statements were verified through search snippets and are marked for re-verification in `policies/references/official-sources.md`.
- Adapters are interfaces with honest stubs; no live API call has been made.
- No scheduled job exists. None is claimed.
- Rendered-DOM (JS) auditing, CWV field data, backlinks, AI-visibility observation and competitor metrics are UNKNOWN until the corresponding integration or tool exists.
