# Portfolio baseline — every site, measured the same way

2026-09-21. Seven sites, built locally and audited in their own **production URL
space** (`audit <url> --local <server>`). No production site was touched.

This is the first time all seven have been measured with one instrument. Read the
numbers against the instrument's own history below, not against the earlier
per-site reports — four of the seven had never been audited end to end, and the
detector was wrong about six things before this run was trustworthy.

## Where each site stands

Measured on each site's **own canonical host**, after this session's fixes.

| Site | pages | critical | high | medium | low | what is left |
|---|---|---|---|---|---|---|
| pamistanbul.com | 804 | 0 | 0 | 2 | 0 | both mediums are the deliberate training-crawler block |
| pamaistudio.com | 255 | 0 | 0 | 10 | 22 | 10 thin portfolio/contact pages · 22 long titles |
| www.untitledportraits.com | 657 | 0 | 0 | 0 | 92 | 92 long titles |
| spryhand.com | 181 | 0 | 0 | 1 | 24 | `/fitness` deliberate noindex · 22 long titles |
| decideplan.com | 142 | 0 | 0 | 3 | 11 | login/signup noindex · `/refunds` legal page · 9 long titles |
| myhappymade.com | 180 | 0 | 0 | 0 | 18 | 18 long titles |
| www.rightlisted.com | 52 | 0 | 0 | 3 | 20 | 3 interactive tool pages · 19 long titles |

**Zero critical and zero high across the portfolio.** Every remaining medium is a
deliberate decision (a noindex, a crawler policy) or the nature of the page (a
contact form, a legal page, an interactive tool). The lows are almost entirely
title length, which is a keyword decision for the owner rather than a defect.

### What changed in this session

| Site | before | after |
|---|---|---|
| pamaistudio | high 2 · medium 12 | high 0 · medium 10 |
| untitledportraits | medium 1 · low 899 | medium 0 · low 92 |
| spryhand | medium 14 · low 32 | medium 1 · low 24 |
| myhappymade | medium 16 · low 164 | medium 0 · low 18 |
| decideplan | medium 4 · low 32 | medium 3 · low 11 |
| rightlisted | medium 6 · low 20 | medium 3 · low 20 |

The real defects behind those numbers, in order of what they cost:

1. **spryhand** served `noindex` *and* a canonical to `/templates` on every
   faceted view. Google documents that pairing as a contradiction and the risk
   runs the wrong way — the noindex can be attributed to the canonical target,
   dropping the strongest commercial page on the site.
2. **pamaistudio**'s homepage published `BlogPosting` schema for three articles,
   two of which appeared nowhere in the server HTML. Google renders and would not
   notice; OAI-SearchBot and PerplexityBot do not render and saw a claim with no
   content. Fixed by making the page show what the schema says, which also took
   the homepage from 88 to 172 server-rendered words.
3. **untitledportraits** reserved no space for images on 354 pages, so the layout
   reflowed as every photo loaded — CLS, on a photography site, on the pages that
   matter most. The gallery already solved this; three other surfaces had not.
4. **myhappymade** linked Turkish readers to English URLs in three places, each
   costing a 307 on every click.
5. **decideplan** served two near-identical pages under one title, competing with
   each other for one query.

Each is now guarded by a test or a build-time check in its own repository, not
only fixed.

## The instrument was wrong first

The first full run produced **1,107 findings that were wrong**, and acting on any
of them would have damaged a correct site. They are worth listing because they
share a shape.

| Detector | Wrong | What it actually saw |
|---|---|---|
| `schema.not_in_visible_content` | 842 | A founder `Person` node with `@id` and `sameAs` — correct on every page, and the markup that ties a brand to a named human |
| `i18n.hreflang_no_self` | 256 | Parameter variants that canonicalize to the clean URL, which are not members of the hreflang set |
| `media.dimensions_missing` | 592 | Images whose box CSS already reserves — `aspect-ratio`, `next/image` fill, or width+height at 100% |
| `links.empty_anchor_text` | 26 | Image links, whose anchor text is the image `alt` |
| `meta.title_duplicate` / `content.duplicate_text` | 25 | The same variants, one final URL counted twice, and an hreflang pair named after a place |
| `indexability.soft_404` | 2 | `404 Magni`, the name of a photographic series |

Four patterns behind all of them: a signal judged on the URL that happened to be
fetched instead of the URL search engines consolidate to; a rule applied to markup
it was never about; a CSS mechanism the parser could not see; and a keyword
matched inside a proper noun.

The `schema` one is the one to remember. Its implied fix was *remove the founder
entity from 842 pages* — deleting a real GEO asset to satisfy a rule that does not
apply to it. An instrument that invents defects is worse than none, because its
output gets acted on.

Every correction is pinned by a test that also asserts the real defect it
resembles still reports: 86 tests, up from 71.

## Two registry facts were wrong

Both `rightlisted` and `untitledportraits` were recorded as `canonical_hostname:
UNKNOWN`, with the note "apex and www both attached, neither redirects".

Both redirect, and have for some time:

* `rightlisted/server.js` 301s the apex to `www` for **every path**, with a
  comment explaining that GoDaddy's forwarding only handled `/`.
* `untitledportraits/next.config.ts` 301s the apex *and* the old `vercel.app`
  host to `www`.

The note was read from Vercel's domain configuration, which shows what is
attached, not what the application does with it. That is how a site can be
correct and be recorded as broken.

`pamaistudio` is the mirror case and also correct: `vercel.json` 301s `www` to the
apex.

## What is still not measured

Nothing here says whether any of it improved traffic.

Search Console and GA4 remain `NOT_CONNECTED` — the service-account key was issued
but never installed. Until it is, every number above is about **structure**: what
a crawler is served and whether the signals in it agree with each other. Rankings,
impressions, clicks, and whether an answer engine actually cites these sites are
all unmeasured, and no number in this report should be read as a claim about them.

Off-site is equally unmeasured: backlinks, brand mentions, and citation presence
were not looked at. For GEO in particular that is the larger half of the problem,
and site structure is only the part that can be fixed from a repository.
