# pamistanbul.com — FULL_BASELINE

Measured 2026-09-20 by the remote runner, read-only, 800 ms between requests,
robots-aware, honest user agent. Coverage is complete: every eligible sitemap
URL was processed. **No production change was made.**

This supersedes the 120-page run of the same date, which is correctly labelled
`PARTIAL_BASELINE_SAMPLE` and must not be described as a full audit.

## Coverage — complete

| Sitemap URLs | Attempted | Not attempted | Pages fetched | 200 OK | Non-200 | Discovered outside sitemap | Blocked by robots | Duration |
|---|---|---|---|---|---|---|---|---|
| 726 | 726 (100.0%) | 0 | 818 | 818 | 0 | 91 | 17 | 12 min |

The live sitemap was re-fetched at the start of the run and still holds 726
URLs, unchanged from the earlier observation. Link discovery on top of the
sitemap surfaced 91 same-site URLs the sitemap omits, which is consistent with
the repository inventory (806 canonical-bearing pages against 726 sitemap
entries).

17 URLs were skipped because robots.txt disallows them for our crawler token.
That is the site's own policy working as written, not a defect.

## Severity and trust

| critical | high | medium | low | info |
|---|---|---|---|---|
| **0** | 78 | 40 | 590 | 357 |

| CONFIRMED | CANDIDATE |
|---|---|
| 949 | 116 |

Every finding carries both. CONFIRMED means the measurement is itself the
defect; CANDIDATE means a heuristic fired and a human must look before anything
changes.

## Findings

| Finding | Count | Severity | Confidence |
|---|---|---|---|
| `media.dimensions_missing` | 502 | low | CONFIRMED |
| `schema.faqpage_present` | 357 | info | CONFIRMED |
| `canonical.cross_host` | 74 | high | CANDIDATE |
| `meta.title_long` | 65 | low | CONFIRMED |
| `meta.title_duplicate` | 17 | medium | CANDIDATE |
| `content.duplicate_text` | 17 | medium | CANDIDATE |
| `http.internal_link_redirects` | 17 | low | CONFIRMED |
| `schema.not_in_visible_content` | 4 | high | CANDIDATE |
| `robots.crawler_blocked` | 2 | medium | CONFIRMED |
| `indexability.soft_404` | 2 | medium | CANDIDATE |
| `links.internal_nofollow` | 2 | low | CONFIRMED |
| `links.empty_anchor_text` | 2 | low | CONFIRMED |
| `canonical.points_to_redirecting_url` | 1 | medium | CONFIRMED |
| `sitemap.non_canonical_entry` | 1 | medium | CONFIRMED |
| `robots.internal_links_blocked` | 1 | low | CANDIDATE |
| `performance.html_weight` | 1 | low | CANDIDATE |

## What is not there

Across 818 live pages: zero 4xx, zero 5xx, zero fetch failures, zero accidental
`noindex`, zero conflicting index signals, zero multiple-canonical pages, zero
invalid JSON-LD, zero missing viewport, zero hreflang self-reference failures,
zero redirect chains of two or more hops. For an 807-page bilingual site this is
an unusually clean technical state.

## Reading the 78 high findings

74 of them are `canonical.cross_host`: the video pages that canonicalize to
pamaistudio.com. The repository inventory shows this is deliberate cross-domain
consolidation of the AI-produced work, so these are expected, not defects. They
remain worth a decision for one reason only: those same URLs are still listed in
this site's sitemap, which is a mixed signal, and Search Console URL Inspection
would settle which canonical Google actually selected.

That leaves **4 genuinely unexplained high findings**, all
`schema.not_in_visible_content` and all CANDIDATE. They need to be opened
individually before anything is changed.

## Crawler access, live

| Allowed | Blocked |
|---|---|
| Googlebot, Google-Extended, Bingbot, OAI-SearchBot, ChatGPT-User, PerplexityBot | GPTBot, ClaudeBot |

Unchanged from the repository's robots.txt, so there is no drift at this layer.

## Still UNKNOWN

Index status, impressions, clicks and queries (needs Search Console).
Conversions and AI referral traffic (needs GA4). Core Web Vitals field data.
Rendered-DOM content, since this crawl reads server HTML. Whether the
pamaistudio.com canonical targets resolve. Backlinks, competitor rankings and
AI citations.

None of these were estimated.
