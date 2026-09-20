# pamistanbul.com — competitor discovery

Status: **DEFERRED, by design.** No candidate has been recorded yet.
Schema: `schemas/competitor-candidate.schema.json` · Skill:
`skills/competitor-discovery` · Isolation: `policies/portfolio-isolation.md`.

Nothing on this page is a competitor. Discovery produces
`CANDIDATE_COMPETITOR` only; promotion to `VALIDATED` is a human act.

## Why discovery is deferred rather than run now

The cheap, reliable evidence for "who competes with us" is query overlap from
Search Console, and that is `sc-domain:pamistanbul.com` waiting on credentials.
Running broad discovery first would mean leaning on paid third-party indexes or
on single-keyword rankings, and a domain that ranks once for one phrase is not a
competitor. Starting there produces a list that feels authoritative and is
mostly noise, and every gap analysis built on it inherits the error.

One real measurement already exists and is worth more than a speculative list:
the site's own `seo-audit/2026-08-28/search-llm-baseline.md` records that on
2026-08-28 Perplexity, asked "Istanbul production company", did not mention PAM
İstanbul and did not cite pamistanbul.com, while naming four other domains. That
is a dated observation from a permitted source, so those four are the only
legitimate starting candidates. They are not recorded as candidates here yet
because a single run of a stochastic system is not a measurement; the AI
visibility sampling has to repeat before its output is trustworthy.

## Categories, kept strictly separate

Merging these is the most common way competitor analysis goes wrong: a
directory that outranks the site is not a business rival, and "beat them" is
meaningless advice against a marketplace.

| Category | Definition | Typical action if confirmed |
|---|---|---|
| `DIRECT_BUSINESS_COMPETITOR` | Sells the same service to the same buyer in the same market | Positioning, evidence, proof of capability |
| `SEARCH_COMPETITOR` | Competes for the same queries without selling the same thing | Content and intent alignment |
| `CONTENT_COMPETITOR` | Competes for informational attention on the same topics | Information gain, original evidence |
| `AI_CITATION_COMPETITOR` | Cited by AI systems on prompts where this brand should appear | Retrievability, entity clarity, third-party citation |
| `DIRECTORY` / `MARKETPLACE` / `MEDIA` | Listings, aggregators, press | Get listed or earn coverage — never "outrank" |
| `NON_COMPETITOR` | Everything else | Recorded so it is not rediscovered every cycle |

A domain may occupy two categories only as two separate records, each with its
own evidence.

## Evidence rules

Each candidate needs at least one dated observation from a permitted source:
Search Console, a named and dated licensed provider, an AI platform answer
obtained by permitted means, or a page fetched read-only. Never automated
Google SERP scraping. One shared keyword is never enough: a candidate needs
repeated commercial-query overlap, or co-citation across several AI prompts, or
your own statement.

## Order of work, once Search Console is connected

1. Pull 3 months of queries, split brand from non-brand, keep commercial intent.
2. For the top commercial queries, gather competing domains from permitted sources.
3. Read one page of each domain to fill `offers_same_service` and `serves_same_market`; unread stays UNKNOWN.
4. Classify into exactly one category with a written rationale.
5. Bring you at most ten candidates to validate, each with its evidence in one line.

Expensive broad research (backlink intersects, large keyword databases, wide AI
prompt panels) stays off until step 1 exists, so it is spent on the topics that
actually carry commercial intent.
