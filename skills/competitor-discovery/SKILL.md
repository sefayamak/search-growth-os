---
name: competitor-discovery
description: Discover candidate competitors for one site from permitted evidence (Search Console query overlap, AI citation/mention overlap, topic overlap, pages actually read), classify each into strictly separated categories, and hand the owner a short validation list. Produces CANDIDATE_COMPETITOR only — never a confirmed competitor.
allowed-tools: [Read, Grep, Glob, "Bash(npm run cli*)", Agent]
arguments: [site_id]
---
Shared rules: `policies/compliance.md` (no SERP scraping, no copying), `policies/portfolio-isolation.md` (candidates belong to one site and are never reused across sites), `schemas/competitor-candidate.schema.json`.

**Stop condition, checked first:** if the site has no first-party search data connected, do not run broad discovery. Query overlap is the only evidence that distinguishes a real search competitor from a domain that happens to rank once. Without it, record that discovery is deferred and stop. Cheap exceptions that may still run: AI citation overlap from measurements already stored, and domains named in the site's own content or the owner's statements.

**Inputs**: registry entry for `site_id`; Search Console query and page data when CONNECTED; stored AI-visibility observations; the site's own crawl.

**Evidence rules**
- Every candidate needs at least one concrete observation with a source and timestamp.
- Permitted sources only: Search Console, licensed providers (named and dated), AI platform answers obtained by permitted means, and pages fetched read-only. Never automated Google SERP scraping.
- One shared keyword is never sufficient. A candidate needs either repeated commercial-query overlap, or citation alongside the brand on several AI prompts, or an owner statement.

**Procedure**
1. Gather overlap evidence per source; keep the raw observation.
2. For each domain, read a page of their site to answer `offers_same_service` and `serves_same_market`. Unread means UNKNOWN, not a guess.
3. Classify into exactly one category, and never merge categories:
   - `DIRECT_BUSINESS_COMPETITOR` — sells the same service to the same buyer in the same market.
   - `SEARCH_COMPETITOR` — competes for the same queries without selling the same thing.
   - `CONTENT_COMPETITOR` — competes for informational attention on the same topics.
   - `AI_CITATION_COMPETITOR` — cited by AI systems on prompts where this brand wants to appear.
   - `DIRECTORY` / `MARKETPLACE` / `MEDIA` — aggregators, listings, press. They may outrank us and are still not competitors; treating them as such produces nonsense gap analysis.
   - `NON_COMPETITOR` — everything else, kept so it is not rediscovered every cycle.
   A domain can legitimately appear in two categories only as two separate records with their own evidence.
4. Write every record with `status: CANDIDATE_COMPETITOR` to `sites/<site_id>/competitors.md` plus a JSON sidecar.
5. Hand the owner at most ten candidates to validate, ordered by commercial relevance, each with its evidence in one line.

**Output**: the candidate table, the deferred-evidence list, and the explicit statement that nothing is a competitor until validated.

**Never**: promote a candidate yourself; copy competitor text; infer a competitor from a single ranking; carry a candidate from one site to another.
