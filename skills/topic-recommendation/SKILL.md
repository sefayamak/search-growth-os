---
name: topic-recommendation
description: "Propose at most three specific things to publish next for ONE onboarded site, each tied to real demand evidence and an SEO/AEO/GEO rationale. Triggers on 'ne yazmalıyım', 'blog konusu öner', 'what should I publish', 'trend konu', 'content idea'."
allowed-tools: ["Bash(npm run cli*)", "Bash(node --experimental-strip-types src/cli.ts*)", "Read", "Grep", "Glob", "WebSearch", "WebFetch"]
arguments: [site_id]
---

Shared rules: `policies/evidence-labels.md`, `policies/source-hierarchy.md`,
`policies/portfolio-isolation.md`, `policies/compliance.md`.

One site per run. A topic is a claim about what people are searching for, so it needs
evidence or an honest label saying it has none.

## Hard preconditions

- The site must be `pilot_onboarding` or `active`. For a `registered_not_onboarded` site,
  refuse and offer onboarding. Producing topics for an un-inventoried site means inventing
  its audience.
- Use only this site's inventory, history and market. Another site in the portfolio having
  the same owner is not evidence about this one.

## Evidence ladder — take the highest rung available, and say which rung you used

1. **Search Console queries** (CONNECTED): impressions with weak position, or rising
   queries. This is real demand from this site's own audience → FACT.
2. **The site's own content inventory**: which topics exist, which cluster has a hole,
   which page ranks for a question it never answers → FACT about coverage.
3. **Dated external evidence**: a source you retrieved, with its retrieval date and URL.
   A seasonal or industry shift is a HYPOTHESIS until such a source is cited.
4. **Nothing**: then say so. "I have no demand data for this site; here are coverage gaps
   from its own inventory" is a legitimate answer. An invented trend is not.

Never state a search volume, a growth percentage, a ranking or a competitor's traffic
unless a connected tool produced it. Fabricated statistics are a REJECT-level compliance
violation (`policies/compliance.md`), not a rounding issue.

## Procedure

1. Read the site's cadence result and `recentContent` (from `cli portfolio`), plus
   `sites/<id>/` baselines and any answer map.
2. Establish coverage: what this site already publishes about, and what its commercial
   pages promise that no informational page supports.
3. Pull the highest available rung of demand evidence.
4. Produce **at most three** candidates. Fewer is fine. Each one:

   | Field | Requirement |
   |---|---|
   | Title | The actual working title, in the site's primary language |
   | Question it answers | The literal question a person or an AI assistant would ask |
   | Evidence | Which ladder rung, with the source or the coverage fact |
   | Label | FACT / INFERENCE / HYPOTHESIS — per the evidence, not per confidence |
   | AEO shape | The extractable answer: a direct 40–60 word opener, then depth |
   | GEO rationale | Why an assistant would cite this over an existing page |
   | Internal links | Which existing pages it links to and which link back |
   | Schema | The type that genuinely applies (`Article`, `HowTo`, `FAQPage` only where eligible) |
   | Effort | Rough production cost, so the owner can pick |

5. End with one recommendation, not three equal options.

## AEO/GEO rules that are not folklore

- `FAQPage` rich results are limited to well-known authoritative government and health
  sites (Google, Aug 2023). Mass FAQ pages for a production studio will not earn rich
  results; propose FAQ blocks for answer extraction, never as a rich-result play.
- Google ignores `llms.txt` for ranking. Do not propose it as an SEO action.
- Citation by an assistant follows from a clear, verifiable, well-structured answer on a
  page the assistant may crawl. Check the site's own robots policy before promising reach
  to a crawler it blocks (`ai-crawler-access-audit`).

## Stop conditions

- Never publish, never open a PR against the production site, never mass-generate pages.
  The output is a proposal the owner acts on.
- Never recommend more than three. A list of twelve topics is a way of not deciding.
- If the only honest answer is "connect Search Console and this gets real", say that.
