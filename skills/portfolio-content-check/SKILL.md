---
name: portfolio-content-check
description: "Check every registered site at once: how long each has gone without publishing, which are overdue against their own cadence, and — for onboarded sites only — what to publish next. Triggers on 'siteleri kontrol et', 'check my sites', 'portföy kontrolü', 'which sites need content', 'ne yayınlamalıyım'."
allowed-tools: ["Bash(npm run cli*)", "Bash(node --experimental-strip-types src/cli.ts*)", "Read", "Grep", "Glob", "WebSearch", "Agent"]
arguments: [site_id]
---

Shared rules: `policies/evidence-labels.md`, `policies/portfolio-isolation.md`, `policies/compliance.md`.

This is the skill behind "siteleri kontrol et". One command answers it for the whole
portfolio; the judgement afterwards is per-site and never shared between sites.

## Procedure

1. **Measure, don't ask.** Run the portfolio cadence pass:
   `node --experimental-strip-types src/cli.ts portfolio`
   (one site: `--site <id>`; onboarded only: `--onboarded-only`).
   This reads robots.txt, sitemaps and a handful of content pages. It writes nothing to
   any website.

2. **Report the table first**, worst first, in the owner's language. Every row states the
   gap, the expected cadence, where that cadence came from, and which signal dated the
   last publish. A site whose date could not be established is reported `UNKNOWN` — never
   as zero days and never as "probably fine".

3. **Say what is overdue in one plain sentence per site.** The shape the owner asked for:
   > PAM İstanbul: 10 gündür yeni içerik yok, hedeflenen aralık 10 gün. Yayın zamanı.

   `OVERDUE` = past double the cadence. `DUE` = past the cadence. `OK` = inside it.

4. **Then, and only for `pilot_onboarding` or `active` sites, recommend what to publish.**
   Delegate to the `topic-recommendation` skill, once per site, with that site's own
   inventory. Never carry a topic, angle, keyword or competitor from one site to another,
   even though one person owns them all (`policies/portfolio-isolation.md`).

5. **For `registered_not_onboarded` sites, stop at the measurement.** State the gap, then
   say the site is not onboarded, so no topic, keyword or strategy will be produced for it.
   Offer onboarding as the next step. This boundary is the point of the registry: advice
   built on an un-inventoried site is guesswork wearing a table's clothes.

6. **Close with the single most useful next action**, not a list.

## Evidence rules

- `daysSincePublish` is a FACT — it came from a date the page or sitemap stated.
- The verdict (`DUE` / `OVERDUE`) is an INFERENCE: a measurement compared to a threshold.
- Any topic suggestion is a RECOMMENDATION, and a claim that a topic is trending is a
  HYPOTHESIS until a dated source is cited. See `topic-recommendation`.
- A sitemap `lastmod` that moves in lockstep across URLs is a build stamp, not a publish
  date. The engine already discards it; do not reintroduce it in the write-up.

## Stop conditions

- **Never write or deploy anything to a production website.** This skill measures and
  recommends. Publishing is a separate, human-approved act.
- If a host is unreachable, say so and name the failure. Do not report an unreachable site
  as clean; the command exits 4 for exactly this reason.
- If a site has no editorial section at all, report `NO_CONTENT_SECTION` and stop. Telling
  a site that never blogged that it is 400 days late is noise, not insight.
- If no page states a publish date, the honest output is `UNKNOWN` plus the fix that makes
  it measurable: add `datePublished` to the article schema.
