# llms.txt across the portfolio — inventory and decision

Measured 2026-09-20, read-only, run
[35523062526](https://github.com/sefayamak/search-growth-os/actions/runs/35523062526).
Nothing was changed on any site.

## The evidence that frames every decision below

Sources and retrieval dates: `policies/references/llms-txt.md`.

1. **The format is a link index, not a Q&A file.** The spec requires exactly one element
   (an H1) and defines optional H2 sections of `- [name](url)` links. It has no question
   section, no FAQ section, no question limit and no size limit.
2. **Google ignores it.** Stated by Google, repeatedly. No content placed here is a
   ranking action.
3. **Almost nothing fetches it.** Ahrefs, 137,210 domains: **97% got zero requests** in May
   2026. Of the 3% with any traffic, 96% was bots, and AI search bots were **1.1%** of
   requests. The largest single consumer was tools checking whether an llms.txt exists.
   EZY Research over 12 weeks on 83 sites: OpenAI fetched llms.txt 7 times against
   robots.txt 3,990; Anthropic 9 against 3,120; Perplexity 0 against 775.
4. **Schema does not move AI citations either.** Ahrefs controlled test, 1,885 pages
   adding JSON-LD against 4,000 controls: AI Overviews citations **declined 4.6%**; AI Mode
   and ChatGPT differences were within noise.

Conclusion: effort spent enlarging these files buys close to nothing. Effort spent making
them *correct and small* prevents a real harm — they are unvalidated second copies of each
brand's facts, and they drift.

## What the seven sites actually serve

Every site serves both files. That is more surface than the evidence justifies.

| Site | llms.txt | Tokens | Links | Questions | llms-full.txt | Contradictions |
|---|---|---|---|---|---|---|
| pamistanbul | yes | **~18,550–21,361** | 173 | **59** | **~277,283–319,295** | **1 CONFIRMED** |
| pamaistudio | yes | ~5,431–6,254 | **0** | 0 | ~8,811–10,146 | — |
| spryhand | yes | ~758–873 | 20 | 0 | **~66,817–76,941** | — |
| decideplan | yes | ~1,064–1,225 | 6 | 0 | ~9,133–10,517 | — |
| rightlisted | yes | ~3,448–3,970 | 51 | 0 | ~5,156–5,937 | — |
| untitledportraits | yes | ~5,518–6,354 | 14 | 0 | ~7,151–8,234 | — |
| myhappymade | yes | ~780–898 | 14 | 0 | ~5,886–6,778 | — |

## Findings, worst first

**pamistanbul — a contradiction on a live file.** `llms.txt` states the founding year as
2017; the owner-confirmed year is 2018. This is the exact harm the file's lack of
validation creates: the same wrong fact also sits in 288 HTML files and in llms-full.txt,
and nothing was ever going to flag it.

**pamistanbul — the file has become a second website.** 59 question headings, 34% prose,
~20K tokens. Those answers are duplicated from pages that can rank and be cited with a URL;
here they earn nothing and provide a second place to go stale.

**pamistanbul — llms-full.txt is ~300K tokens.** No assistant loads that whole, so its real
behaviour is "an unpredictable prefix gets read". Its size is whatever the generator
emitted rather than a decision.

**pamaistudio — an index that indexes nothing.** The file has zero markdown links, which is
the one thing the format is for, and no blockquote summary. It is prose in a file nothing
fetches.

**spryhand — the proportions are inverted.** An 873-token llms.txt pointing at a
~77K-token llms-full.txt, on a site that states no publish date on any of its 50 `/guides/`
pages (see the cadence report). Effort went to the file almost nobody reads rather than to
the pages that are read.

**decideplan, rightlisted, untitledportraits, myhappymade — proportionate.** Small,
link-bearing, no contradictions. Nothing to do.

## The decision

**Do not grow these files. Make them correct, small, and consistent with the sites.**

The instinct to answer more of the questions people ask is the right one — it is what AEO
is. The correction is only about *where* those answers live. An answer on an indexed HTML
page can rank, can be cited with a URL, and is seen by Google. The same answer in llms.txt
is read by roughly nobody and is invisible to Google. Putting the question set in llms.txt
is doing AEO in the one location where it does not count.

So: the question set gets **expanded**, on the pages. llms.txt gets **reduced**, to an index.

## Per-site plan, in priority order

Each is a proposal. Nothing is applied without approval, and each site is a separate PR.

| # | Site | Action | Why now |
|---|---|---|---|
| 1 | pamistanbul | Fix the founding year everywhere it is wrong: llms.txt, llms-full.txt, and the 288 HTML files | A live factual error about the business, already inventoried |
| 2 | pamistanbul | Cut llms.txt to an index: identity, disambiguation, qualifying facts, links. Move the 59 answers to pages that can rank | Duplicated answers earning nothing and drifting |
| 3 | pamistanbul | Decide llms-full.txt deliberately: split by topic or drop it | ~300K tokens is not a decision anyone made |
| 4 | pamaistudio | Give llms.txt links, or remove it | An index with no links has no function |
| 5 | spryhand | Add `datePublished` to the 50 `/guides/` pages before touching its llms files | The pages are the thing that gets read |
| 6 | four remaining sites | Nothing | Measured, proportionate, no defects |

Item 1 is the only one that fixes a live inaccuracy. It should go first regardless of what
is decided about the rest.
