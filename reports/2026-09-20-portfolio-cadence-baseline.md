# Portfolio content cadence — first measurement, 2026-09-20

Measured by the remote runner (read-only): robots.txt, sitemaps, and up to six content
pages per site. No production site was changed. Runs
[35521251353](https://github.com/sefayamak/search-growth-os/actions/runs/35521251353) and
[35521325855](https://github.com/sefayamak/search-growth-os/actions/runs/35521325855).

This is the reference point the weekly Monday check compares against.

| Site | Status | Section | Last publish | Days | Expected | Verdict | Date source |
|---|---|---|---|---|---|---|---|
| decideplan | registered | /blog/ (10) | 2026-08-20 | 31 | 14d (default) | **OVERDUE** | `datePublished` · CONFIRMED |
| myhappymade | registered | /blog/ (34) | 2026-08-20 | 31 | 14d (default) | **OVERDUE** | `dateModified` · CANDIDATE |
| spryhand | registered | /guides/ (50) | UNKNOWN | — | 14d (default) | **UNKNOWN** | none |
| rightlisted | registered | — | UNKNOWN | — | 14d (default) | **UNKNOWN** | none |
| untitledportraits | registered | — | UNKNOWN | — | 14d (default) | **UNKNOWN** | none |
| pamistanbul | **pilot** | /pamlab/ (175) | 2026-09-03 | 17 | 10d (registry) | **DUE** | `datePublished` · CONFIRMED |
| pamaistudio | registered | — | UNKNOWN | — | 14d (default) | **NO_CONTENT_SECTION** | none |

## Correction — the first pilot result was wrong

The first run reported pamistanbul.com as `NO_CONTENT_SECTION` across 726 sitemap URLs.
**That was an instrument error, not a finding about the site.**

PAM İstanbul publishes under `/pamlab/`: 86 Turkish and 89 English articles, every one of
them already carrying `datePublished` in `BlogPosting` JSON-LD. The content line exists,
is well formed, and was measurable the whole time. What failed is that no generic word
list contains a brand's own name for its blog, and `pamlab` is such a name.

This is a **false negative**, and it is the more dangerous direction. A site wrongly
accused of a defect gets argued with; a site wrongly told it has no content line is
believed, and the real measurement never happens. It was caught only because the report
prints the site's own top-level structure next to the verdict — `pamlab (87)` was sitting
in that list.

Fixed by letting the registry declare `content_sections`, which is merged ahead of the
generic list without overriding the most-populated-pattern rule. Re-measured live in run
[35522205646](https://github.com/sefayamak/search-growth-os/actions/runs/35522205646):

```
CADENCE pamistanbul verdict=DUE days=17 expected=10 section=pamlab
        source=jsonld_datePublished status=pilot_onboarding
```

The newest article states **2026-09-03**, which is **17 days** against the owner-set
10-day cadence. Past the cadence, not yet double it, so the verdict is `DUE`.

## Two things this measurement does not claim

`dateModified` is not a publish date. myhappymade's 31 days rests on a modification
stamp, so it is CANDIDATE: the site changed 31 days ago, which is not proof that it
published 31 days ago.

spryhand has 50 pages under `/guides/` and states a date on none of them. Its sitemap
`lastmod` values move together, which makes them a build stamp rather than publish dates,
so they were discarded rather than reported as freshness. UNKNOWN is the correct output.

## Isolation

Every row above is that site's own measurement. Six of the seven are
`registered_not_onboarded`: their cadence is reported, and no topic, keyword, competitor
or strategy is produced for them. Advice requires onboarding — see
`policies/portfolio-isolation.md`.
