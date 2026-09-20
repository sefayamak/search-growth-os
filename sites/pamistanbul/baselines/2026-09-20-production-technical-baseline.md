# pamistanbul.com — first production technical baseline

Measured 2026-09-20 by the remote runner (GitHub Actions run 35503032935,
commit `38a5445`) against the live site. Read-only crawl, 120 pages, 800 ms
delay, honest user agent. **No production change was made.**

This supersedes the source-only baseline of the same date for everything a
crawl can see.

## Measured (FACT)

| Pages fetched | 200 OK | Non-200 | Sitemap URLs | Blocked for our token | Duration |
|---|---|---|---|---|---|
| 120 (cap) | 120 | 0 | 726 | 0 | 106 s |

| Severity | critical | high | medium | low | info |
|---|---|---|---|---|---|
| Count | **0** | **2** | 3 | 99 | 103 |

Findings by id:

| Finding | Count | Severity |
|---|---|---|
| `schema.faqpage_present` | 103 | info |
| `media.dimensions_missing` | 93 | low |
| `meta.title_long` | 5 | low |
| `schema.not_in_visible_content` | 2 | high |
| `robots.crawler_blocked` | 2 | medium |
| `indexability.soft_404` | 1 | medium |
| `links.internal_nofollow` | 1 | low |

Live crawler access, read from the production robots.txt:

| Allowed | Blocked |
|---|---|
| Googlebot, Google-Extended, Bingbot, OAI-SearchBot, ChatGPT-User, PerplexityBot | GPTBot, ClaudeBot |

## What did not appear, and that is the headline

Across 120 live pages there were **zero** HTTP errors, zero redirect chains,
zero broken or conflicting canonicals, zero accidental `noindex`, zero
duplicate-text clusters, zero invalid JSON-LD and zero pages missing a
viewport. For a 807-page bilingual site with 803 legacy redirects configured,
that is a genuinely well-maintained technical state, and it is consistent with
the guard architecture already running in the site repository.

## Two corrections to my own instrument

The first run of this crawl reported **100 high findings**. Verifying them
against the repository showed 98 were my detectors misfiring, not site defects.
Both are fixed and locked behind regression tests.

- `font-size:0` was matching `font-size:0.95rem`, so ordinary styled paragraphs
  read as hidden text. Five pages were accused; all were innocent. This bug also
  sat in the compliance gate, where it would have rejected legitimate copy.
- The schema-versus-visible-content check compared the full schema `name`, which
  here is the page title complete with brand suffix
  (`Alpet · Kurumsal Fotoğraf Çekimi | PAM İstanbul`) and never appears verbatim
  in body text. 95 pages were accused; on the sample I verified, the subject
  ("Alpet") appears 12 times in the body. It now compares the subject.

Recording this because a baseline nobody can trust is worse than no baseline,
and because the remaining `high` count only means something once the false
positives are gone.

## Open items from this crawl (not fixed)

1. **`schema.not_in_visible_content` ×2** — two pages still flagged after the
   fix. They must be opened individually from the run artifact and judged
   before anything is changed; two survivors out of 120 is the profile of a
   real finding, not a systematic one.
2. **`indexability.soft_404` ×1** — `/projects/yusuf-dikec` returns 200 while
   reading as a not-found page.
3. **`media.dimensions_missing` ×93** — images without width/height. Layout
   shift risk; the actual CLS impact is UNKNOWN until field data exists, so
   this is not yet worth a change on its own.
4. **`robots.crawler_blocked` ×2** — GPTBot and ClaudeBot blocked. Deliberate
   policy, reported for confirmation, not a defect.
5. **`schema.faqpage_present` ×103** — informational. No longer earns rich
   results for a non-government/health site; fine as answer content, never as a
   SERP lever.
6. **`meta.title_long` ×5**, **`links.internal_nofollow` ×1** — cosmetic.

## Repository versus production drift

| Check | Result |
|---|---|
| Production build source | Vercel production deployment built from `sefayamak/pamistanbul-site` @ `7741193`, which equals the audited clone HEAD |
| Sitemap size | 726 URLs live = 726 `<url>` in the repository |
| robots.txt behaviour | Live per-token access matches the repository's rules exactly, on all eight tokens tested |
| Canonical host | 120 apex URLs served 200 with no redirect to www, so the legacy `.htaccess` www-forcing rule is **inert**. Phase 1 flagged this as a possible conflict; it is dead configuration, not a live one |
| Legacy redirects | No internal link hit any of the 803 configured redirects; they are legacy-URL catchers, as intended |

**No drift detected at any layer this crawl can observe.**

Not covered by this crawl, and therefore still UNKNOWN: the 74 pages that
canonicalize to pamaistudio.com (not reached within 120 pages at depth 3),
whether `automation/` templates are publicly served, rendered-DOM content, and
everything that needs Search Console or GA4.

## Entity truth

Owner confirmed the founding year is **2018**. The live site asserts **2017** in
288 files: 58 JSON-LD `foundingDate` values, 118 Turkish prose passages, 130
English prose passages, and 4 machine-readable AI files. The full list is at
`sites/pamistanbul/entity-2017-inventory.txt`, to be corrected later in one
reviewed change. The `2017` inside `sitemap.xml` is a Vimeo video id, not a
date, and is excluded.
