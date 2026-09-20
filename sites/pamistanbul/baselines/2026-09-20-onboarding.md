# pamistanbul.com — onboarding baseline, 2026-09-20

Source-level baseline taken from the repository at commit `7741193`, which is
the exact commit the live production deployment was built from. **No production
change was made. No live crawl was possible from this environment.**

Labels per `policies/evidence-labels.md`. "FACT (repo)" means I read the file.

## Verification chain (FACT)

| Claim | Evidence |
|---|---|
| `sefayamak/pamistanbul-site` is the production source | Vercel deployment `dpl_4CyY9N8AG8rP5JsVcBymeFzdsiwN`, target `production`, state READY, `githubOrg/githubRepo` = sefayamak/pamistanbul-site, branch main |
| The clone I audited matches what is deployed | deployment `githubCommitSha` = `7741193d13c0511d91772663f177441a41ffefbd` = clone HEAD |
| The domain belongs to that project | Vercel project `pamistanbul` (`prj_S9dGhXvSg9xbSA0o7rPg0wfbUv85`) holds `pamistanbul.com` and `www.pamistanbul.com` |
| Filtering Vercel projects by repo returns only this project | `list_projects?repo=pamistanbul-site` → 1 result |

Not verified: that the bytes served at the apex today equal this commit's build.
Fetching the live site and the deployed files were both refused by the egress
policy, so drift beyond the git layer is UNKNOWN from here. The repository's own
`production-drift.yml` workflow checks exactly this daily, which is the right
control and already exists.

## Existing SEO / AEO / GEO infrastructure (FACT, repo)

This site is not greenfield. It already runs a deliberate, documented program.

**Scale.** 807 HTML files. 806 carry an absolute canonical. Sitemap holds 726
URLs with 7,996 image and 368 video entries and 2,108 hreflang alternates.
803 permanent redirects in `vercel.json`.

**Bilingual.** TR at root, EN under `/en/`. 730 files carry hreflang; every
hreflang page has `x-default` and a self-reference. Directory mirrors are
near-complete; EN carries five extra market pages by design.

**Crawler policy.** Search and AI-answer crawlers (Googlebot, bingbot,
Applebot, OAI-SearchBot, PerplexityBot, Claude-SearchBot) allowed. Training
crawlers (GPTBot, ClaudeBot, anthropic-ai, CCBot, Bytespider) disallowed.
`Google-Extended` explicitly allowed with a comment calling it a deliberate
mixed-purpose exception. That distinction is correct: `Google-Extended` governs
Gemini training only and does not affect Search or AI Overviews inclusion.

**GEO surface.** `llms.txt` (73 KB entity index), `llms-full.txt` (1.05 MB
portfolio index), `ai.txt`, `.well-known/ai.txt` with an explicit policy block,
and three JSON endpoints under `/ai/`. An RSS feed with 40 items.

**Structured data.** Large and, importantly, clean on the risk axis: zero
`aggregateRating`, zero `Review`, zero `award`, zero `hasCredential`. Nothing
fabricated to chase rich results. 355 pages carry `FAQPage`.

**Analytics.** GA4 via direct gtag, measurement ID `G-EYY9Z20XJ4`, 1,604
references. No Tag Manager, no Universal Analytics, no Ads tag. The contact
form's Resend key is read from the environment and is not committed.

**Governance.** Three-layer guard architecture: repo integrity on every PR,
production-vs-repo drift daily and after merge, plus a local-only link check.
A weekly content pipeline that is PR-only with auto-merge deliberately off,
and split privileges so the job holding secrets cannot write.

**Prior audit record.** `docs/measurement/` (23 docs, Phase 1 closed
2026-08-02), `coverage-audit-2026-08/` (37 files), `docs/site-audit/` (9 files),
`seo-audit/2026-08-28/` (2 files). Treated as context, not as verified truth.

## Findings carried into the backlog (not fixed)

Nothing below was changed. Severity is my assessment; the first four are the
ones I would act on first.

1. **Perplexity did not mention or cite the brand** for "Istanbul production
   company" on 2026-08-28, per the repo's own baseline doc. One observation is
   not a measurement; the GEO stack is built but unvalidated. This is the
   highest-value open question and needs repeated sampling.
2. **Founding year contradicts itself.** 2017 appears in 58 JSON-LD blocks and
   four AI files; the 2026-08-28 entity audit states the first-party truth is
   2018. One of them is wrong, and entity contradictions are exactly what
   erodes AI citation confidence. Owner must say which year is correct.
3. **One IndexNow key file is corrupt** — `af3b9d12….txt` contains a different
   key, so submissions signed with it fail verification. Known since
   2026-08-04, never cleaned up.
4. **Host policy conflicts.** Everything canonical points at the apex, while
   the legacy `.htaccess` forces `www`. Dead on Vercel, live if any DNS still
   points at the old Apache host.
5. **74 video pages canonicalize to pamaistudio.com yet stay in this site's
   sitemap.** Deliberate cross-domain consolidation, but submitting a URL that
   disclaims itself is a mixed signal, and those pages also carry no hreflang.
6. **80 canonical-bearing pages are absent from the sitemap** (806 vs 726).
7. **`automation/` is not in `.vercelignore`**, so internal templates and a
   contact sheet may be publicly served and crawlable.
8. One dangling hreflang pair and two `hreflang="'+to+'"` template leaks.
9. **Indexing submissions have been dead since 2026-06-19**, roughly 155 URLs
   never submitted.
10. 355 `FAQPage` blocks no longer earn rich results for a non-gov/health site.
    They are still legitimate as answer content; they are not a SERP lever, and
    nothing here should be maintained as if they were.

## Open UNKNOWNs

Live served HTML · index status and query data · conversions · Core Web Vitals
field data · whether the pamaistudio.com canonical targets resolve · which GA4
property backs `G-EYY9Z20XJ4` · the exact Search Console property string.
