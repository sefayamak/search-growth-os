# llms.txt — what the spec says, what Google says, and what that leaves

Retrieved 2026-09-20. Re-verify before citing after 2027-03.

## What the format actually is

`llms.txt` is a **link index**, not a question-and-answer file. The spec
([llmstxt.org](https://llmstxt.org/), v2) defines exactly one required element and a
small set of optional ones:

| Element | Required | Form |
|---|---|---|
| Project name | **yes** | a single H1 |
| Summary | no | a blockquote directly under the H1 |
| Detail | no | any markdown except headings |
| File lists | no | H2 sections whose items are `- [name](url): optional note` |
| `## Optional` | no | a reserved H2 naming links a reader may skip for a shorter context |

There is **no question section, no FAQ section, no limit on questions, and no stated size
limit** anywhere in the specification. A cap on questions cannot be quoted from it,
because the concept does not exist in it. Anyone stating a number as "the llms.txt limit"
is reporting a house rule, not the spec.

## What Google says

Google does not use the file. Gary Illyes stated at Search Central Live that Google does
not support `llms.txt` and has no plans to, and that ranking in AI Overviews needs
ordinary SEO
([Search Engine Land, 2025](https://searchengineland.com/google-says-normal-seo-works-for-ranking-in-ai-overviews-and-llms-txt-wont-be-used-459422)).
John Mueller compared the idea to the old keywords meta tag: a self-declared signal, and
therefore easy to game
([Search Engine Roundtable](https://www.seroundtable.com/google-does-not-endorse-llms-txt-40789.html)).
Reported secondary sources say Google added a "Clarifying guidance on llms.txt files"
section to its own documentation on 15 June 2026, stating the file is not needed to appear
in Google Search and neither helps nor harms visibility.

**Status of that last point:** secondary. `developers.google.com` is blocked by this
environment's egress proxy, so the primary page could not be read here. Confirm against
Google's own documentation before quoting the date.

The practical consequence: **no amount of content in `llms.txt` is a Google ranking
action.** Writing one is a bet on non-Google assistants that choose to fetch it.

## Does anything read it

Measured, not assumed. Two independent server-log studies point the same way.

**Ahrefs, published 2026-06-15** — 137,210 domains with traffic in May 2026, checked for an
`llms.txt` returning HTTP 200, then every request to `/llms.txt` classified by user agent:

| Finding | Figure |
|---|---|
| Files receiving **zero** requests in May 2026 | **97%** |
| Of the 3% with traffic, share that was bots | 96% |
| AI search bots (OAI-SearchBot, PerplexityBot, Claude Web) share of requests | **1.1%** |
| AI coding agents (e.g. Claude-Code) | ~10.5% |
| Largest single consumer | tools auditing whether you have an `llms.txt` |

**EZY Research** — 83 sites, 12 weeks of logs. Over that period OpenAI fetched `llms.txt`
7 times and `robots.txt` 3,990 times; Anthropic 9 against 3,120; PerplexityBot **0** against
775. Separate 48-day and 14-day single-host studies recorded zero `llms.txt` requests while
AI crawlers hit ordinary pages normally.

So the file is not merely unweighted by Google — it is, in the main, unfetched.

**Status of these figures:** reported through search result summaries. `ahrefs.com`,
`searchenginejournal.com` and `ppc.land` are all blocked by this environment's egress
proxy, so the primary write-ups could not be read here. Two independent studies agreeing
is why they are quoted at all; confirm before putting a number in a client-facing document.

## Neither does schema move AI citations

Relevant because "add FAQ schema" is the usual next suggestion after llms.txt. Ahrefs ran a
controlled test: 1,885 pages that added JSON-LD between August 2025 and March 2026, matched
against 4,000 control pages. Google AI Overviews citations **declined 4.6%** on the treated
pages (small, statistically significant against controls); AI Mode and ChatGPT differences
were within noise. The authors note schema correlates with better-maintained sites, which
is the more likely source of any apparent lift.

Treat structured data as what it is — machine-readable description, and the route to the
rich results it is actually eligible for — not as a lever on AI citation.

## So what does limit it

Not a rule — a budget. The file competes for space in a context window against the page
the assistant actually wants. Three constraints follow, and they are engineering facts
rather than SEO opinion:

1. **It must be cheap enough to fetch and keep.** A file that costs more than the answer
   is worth gets truncated or skipped, and a truncated link index is worse than a short
   one because the reader cannot tell what it lost.
2. **Redundancy is pure cost.** An answer already on an indexed HTML page earns nothing by
   being repeated here; it is the same words at a second location with no rich result, no
   ranking effect and a second place to go stale.
3. **It goes stale silently.** Nothing validates it, no tool warns on it, and no report
   flags a contradiction between it and the site. Every fact duplicated into it is a fact
   that can quietly diverge — which is exactly what happened to the pilot's founding year.

## The recommendation this system makes

**RECOMMENDATION**, not FACT — no published threshold supports a specific number.

Keep `llms.txt` an index: identity, disambiguation, the handful of facts that decide
whether the brand is the right answer, and links. Put questions on the pages that answer
them, where they can rank, be cited with a URL, and be seen by Google — which ignores this
file entirely.

If questions are kept in the file at all, keep only the ones that **decide whether to
recommend the brand** — the qualifying questions — and link the rest. Ten to fifteen is a
working ceiling for that job; past it the file has stopped being an index and become a
second website that no tool validates.

`llms-full.txt` deserves a separate decision. A file in the hundreds of thousands of
tokens will not be loaded whole by any assistant, so its real behaviour is "some
unpredictable prefix of this gets read". If it exists, it should be split by topic, and
its size should be a deliberate number rather than whatever the generator emitted.

## Measuring it

Size in tokens, not kilobytes, is the number that matters, because the context window is
what it competes for. Roughly 3.3–3.8 characters per token for mixed Turkish/English
prose; report a range, never a false-precision figure.
