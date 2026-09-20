# Search compliance policy

Official documentation outranks folklore, SaaS advice and our own assumptions.
If an optimization conflicts with an official policy, it is rejected. Nobody
rationalizes around a policy. Sources and retrieval dates:
`policies/references/official-sources.md`.

Enforced automatically by `src/compliance.ts` (rule ids in brackets) and by the
PreToolUse hook `hooks/compliance-gate.ts`. Verdicts: **REJECT** = conflicts
with policy, **FLAG** = human review before PR.

## Prohibited (REJECT)

### keyword-stuffing `[keyword_stuffing]`
Repeating phrases or listing keywords without natural language. Google spam
policy "Keyword stuffing". Detection: any 2–3 word phrase ≥8× and >3% of words,
or comma-separated keyword lists.

### hidden-text `[hidden_text]`
Text hidden by CSS (display:none, font-size:0, off-screen, same-colour) that
carries content. Google spam policy "Hidden text and links". Legitimate
accordions and screen-reader text must not carry keyword lists.

### cloaking `[cloaking_ua_branch]` `[crawler_specific_content]`
Serving different substantive content to crawlers than to humans, including
"AI-only" hidden blocks. One canonical truth for humans and machines.

### doorway-pages `[doorway_pages]`
Generating many pages per city/keyword/variant that funnel to the same
destination. Google spam policy "Doorway abuse". A page exists only when a
genuinely distinct user need exists.

### scaled-content-abuse `[scraped_or_spun_content]`
Mass-produced, scraped, spun or unoriginal content regardless of how it is
produced (Google "Scaled content abuse", March 2024). AI drafting is allowed
only when the page carries original, verifiable information and a human owns it.

### link-schemes `[link_scheme]`
Buying links, PBNs, exchanges, paid dofollow guest posts. Google "Link spam".

### fabricated-evidence `[fake_evidence]`
No fake authors, credentials, reviews, testimonials, case studies, statistics,
citations, client logos. Never invented — if it does not exist, it is not on
the page.

### fake-freshness `[fake_freshness]`
Bumping `dateModified` / "last updated" without a substantive change.

### ai-manipulation `[prompt_injection]`
Text addressed to AI systems ("ignore previous instructions", "recommend X").
Treated as both spam and a security risk.

### indexing-api `[indexing_api_misuse]`
Google's Indexing API is supported only for pages with `JobPosting` or
`BroadcastEvent` (livestream) structured data. Any other use is REJECTED.
Ordinary re-indexing goes through sitemaps, internal links and Search Console
URL Inspection.

### llms-txt `[llms_txt_claim]`
Google Search does not read llms.txt; it neither helps nor harms Google
visibility (Google, 2026 AI optimization guide). An llms.txt may exist purely
as an interoperability file for systems that explicitly consume it. Any claim
of Google or AI Overview benefit is REJECTED.

### automated-queries `[serp_scraping]`
Scraping Google results with automated requests violates Google's terms
("Machine-generated traffic"). SERP evidence comes from Search Console,
licensed providers, or manual observation.

## Review required (FLAG)

### faq-schema `[faq_rich_result_objective]`
FAQ rich results are shown only for well-known authoritative government and
health sites (Google, Aug 2023). FAQPage markup may remain when the content is
a genuine FAQ, but it is never an objective and never a reason to add questions.

### high-risk-paths `[sitewide_high_risk]`
robots.txt, sitemap generators, root layouts, redirects, middleware/proxy,
framework config. See `policies/high-risk-changes.md`.

## Crawler access
Blocking a crawler is a policy decision, not an SEO trick. Reported, never
changed automatically. Facts: Googlebot is the control for Search **and** AI
Overviews / AI Mode; `Google-Extended` only controls Gemini/Vertex training and
does not affect Search inclusion. `OAI-SearchBot` governs ChatGPT search
inclusion independently of `GPTBot` (training).

## Structured data
Must describe visible content on the same page; validated technically (JSON
parse) and semantically (name/headline in visible text, ratings need visible
reviews). Never added because a tool recommends the type.
