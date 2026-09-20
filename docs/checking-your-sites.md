# "Siteleri kontrol et" — what happens and what it can honestly tell you

This is the everyday question: *which of my sites has gone quiet, and what should
I publish next?* One command answers the first half for the whole portfolio. The
second half is per-site, and deliberately harder to get.

## The command

```bash
node --experimental-strip-types src/cli.ts portfolio
```

Options: `--site <id>` for one site, `--onboarded-only` to skip placeholders,
`--sample N` for how many content pages to open per site (default 6), `--delay ms`
for politeness (default 800).

Without a terminal: **Actions → Portfolio content check (read-only) → Run workflow**.
It also runs by itself at 09:10 Europe/Istanbul every Monday, and needs no secrets,
because measuring a public site requires no credentials.

## What it actually measures

For each site: robots.txt, then the sitemaps, then a handful of the newest-looking
content pages. From those pages it reads the publish date the page states about
itself, in descending order of trust:

| Signal | Confidence | Why |
|---|---|---|
| JSON-LD `datePublished` | CONFIRMED | the page asserts when it was published |
| `article:published_time` | CONFIRMED | same claim, different surface |
| JSON-LD `dateModified` | CANDIDATE | the page changed; that is not the same as new content |
| `<time datetime>` | CANDIDATE | usually the publish date, occasionally something else |
| sitemap `lastmod` | CANDIDATE | the sitemap's claim about the page, not the page's own |

## The three lies it refuses to tell

**A build stamp is not a publish date.** Plenty of generators write today's date into
`lastmod` for every URL on every deploy. Read naively, a blog that died in 2024 reports
as published today. When lastmod values move in lockstep they are discarded as
evidence, and the report says why.

**A slug containing "blog" is not a blog post.** The section is matched on path
segments, so `/kurumsal-blogger-paketi/` and `/haberler-hakkinda/` are service pages,
not articles. Counting them would make a dormant site look active — the exact
direction of error that lets a problem hide.

**No date means UNKNOWN, never zero.** A site whose pages state no date gets `UNKNOWN`
plus the fix that makes it measurable: add `datePublished` to the article schema.
It never gets a confident "published 0 days ago".

## Reading the verdict

| Verdict | Meaning |
|---|---|
| `OK` | inside the cadence |
| `DUE` | past the cadence |
| `OVERDUE` | past **double** the cadence |
| `NO_CONTENT_SECTION` | this site has no editorial section — not late, just different |
| `UNKNOWN` | could not be measured; the row says why |

The cadence itself comes from `content_cadence_days` in the registry. It is an owner
decision, never inferred from the site's own history: a site that has published
erratically for two years would otherwise have its bad habit adopted as its target.
Where it is UNKNOWN, a stated default (14 days) applies and every row says
`(default)` so a fallback is never mistaken for the site's own norm.

`daysSincePublish` is a FACT. The verdict is an INFERENCE — a measurement compared
to a threshold. The report labels it that way rather than blurring the two.

## Then what to publish

For an onboarded site, `topic-recommendation` proposes at most three specific pieces,
each carrying the evidence rung it stands on:

1. Search Console queries — real demand from this site's own audience (FACT)
2. The site's own coverage gaps — what its commercial pages promise that no
   informational page supports (FACT about coverage)
3. A dated external source, cited with its retrieval date (HYPOTHESIS until cited)
4. Nothing — and then it says so

A trend nobody can source is not a recommendation, it is a guess with confident
punctuation. Invented search volumes and growth percentages are a REJECT-level
compliance violation, not a rounding error.

For a `registered_not_onboarded` site the measurement is reported and the advice
stops there. Recommending topics for a site whose audience, market and inventory
were never established is invention, and its neighbour being onboarded is not
evidence about it. See `policies/portfolio-isolation.md`.

## What it still cannot tell you

Whether what you published ranks, gets cited by AI assistants, or converts. Those
need Search Console and GA4. Until those are connected they are reported
`NOT_CONNECTED`, and no number is estimated in their place.
