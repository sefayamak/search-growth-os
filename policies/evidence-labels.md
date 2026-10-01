# Evidence labels

Every statement an agent or report makes carries exactly one label. Code emits
only FACT and INFERENCE; the rest are human/agent judgements.

| Label | Meaning | Example |
|---|---|---|
| FACT | Measured directly (fetch, parse, API row) with the raw value attached | `/kampanya` returns `<meta name=robots content=noindex>` |
| INFERENCE | Deterministic rule over facts | noindex + listed in sitemap → likely accidental |
| HYPOTHESIS | Plausible cause, not yet verified; must name the test that would confirm it | "Drop on 2026-08-12 coincides with deploy abc123; compare pages touched vs untouched" |
| RECOMMENDATION | Proposed action with expected effect, effort, risk, rollback | Remove noindex, verify with URL Inspection |
| IMPLEMENTED_CHANGE | Merged and deployed; PR link and date | PR #12, deployed 2026-09-22 |
| VERIFIED_RESULT | Measured after the window; compared to baseline and guardrails | clicks +18% (28d vs prior 28d), conversions flat |

Rules:
- An INFERENCE never becomes a FACT by repetition.
- A HYPOTHESIS without a proposed test is not allowed in a report.
- Missing data is `NOT_CONNECTED` or `UNKNOWN`, never an estimate presented as a number.
- Third-party numbers carry provider + retrieval date and are FACT *about the provider's index*, not about Google.

## Not an evidence label: opportunity source

`editorial` is **not** a label. Whether an idea (a topic, a content gap) is backed by a
search signal is a separate axis, recorded as `opportunity_source: "gsc_evidence" | "editorial"`
(`src/types.ts`, `schemas/opportunity.schema.json`). It says *where the idea came from*, never
*how sure we are*. An editorial idea stays editorial however often it repeats, and it is never
reported as measured demand. The six labels above are the whole evidence ontology.
