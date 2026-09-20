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
| pamistanbul | **pilot** | — | UNKNOWN | — | 10d (registry) | **NO_CONTENT_SECTION** | none |
| pamaistudio | registered | — | UNKNOWN | — | 14d (default) | **NO_CONTENT_SECTION** | none |

## The pilot result, and why it is not the answer that was wanted

pamistanbul.com cannot be told "you have not published in N days", and the reason is not
a limitation of the measurement. Across **726 sitemap URLs there is no editorial section
at all**. The site's own top-level structure:

```
en (368) · projects (113) · video (92) · pamlab (87) · services (20)
artists (16) · case-studies (11) · +14 single root pages
```

Among those root pages are `produksiyon-sirketi-nasil-secilir`, `hibrit-produksiyon` and
`promo-filmi` — editorial writing that exists but sits loose at the root rather than in a
section, with no publish date attached to it.

So the honest statement is: **the site has articles but no content line.** Nothing on it
says when anything was added, which means no cadence can be measured, no freshness can be
signalled to a search engine, and no assistant can tell a current answer from a 2019 one.

That is a finding about the site, not a gap in the tool. It was separated from a
pattern-list blind spot by printing the site's real structure next to the verdict.

## What would make the pilot measurable

1. A section — `/blog/`, `/makale/` or `/rehber/` — with the existing loose articles moved
   into it under redirects, so a content line exists at all.
2. `datePublished` (and `dateModified` when revised) in `Article` / `BlogPosting` JSON-LD
   on every piece. This is what makes the cadence measurable, and it is the same field an
   AI assistant reads to decide whether an answer is current.

Both are content-architecture changes to `sefayamak/pamistanbul-site`. **Neither has been
made.** No production change has been proposed or shipped.

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
