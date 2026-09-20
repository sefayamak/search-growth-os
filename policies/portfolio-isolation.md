# Portfolio isolation

One person owns every site in this registry. That is an ownership fact, not a
strategy fact. Nothing crosses between sites automatically.

## Never inherited between sites

Business objectives · target markets · languages · conversion events ·
competitors · keyword and topic universe · entity graph · SEO / AEO / GEO
strategy · baselines · experiments · findings · content.

A conclusion measured on one site is evidence about that site only. Reusing
pamistanbul's competitors or topics on another domain would be a fabricated
premise, and every downstream recommendation would inherit the error.

The registry validator enforces the narrow version of this: a site whose
`onboarding_status` is `registered_not_onboarded` must keep `competitor_set`,
`core_commercial_topics` and `core_informational_topics` empty. It cannot
enforce the broad version, so agents carry it: when working on site A, load
site A's registry entry and site A's artifacts, and nothing else.

## Onboarding status gates work

| Status | Observe | Crawl | Analyse | Propose changes | Ship changes |
|---|---|---|---|---|---|
| `pilot_onboarding` | yes | yes | yes | yes, PR only | only with explicit owner approval |
| `active` | yes | yes | yes | yes, PR only | per `deployment_approval_policy` |
| `registered_not_onboarded` | yes, bounded | **no** | **no** | **no** | **no** |

### Why observation is its own column

"Which of my sites has gone quiet" is a question about the portfolio, and refusing
to answer it for six sites out of seven would make the registry useless for the
first thing an owner asks. So observation is carved out explicitly rather than
smuggled in under crawling.

**Observation is the `portfolio` command and nothing else**: robots.txt, sitemaps,
and a small sample of content pages read for the publish date they state about
themselves. It yields one measurement — days since the last publish — and no
keyword, competitor, topic, audience or strategy. It cannot leak between sites
because it derives nothing that could leak.

The boundary holds where it matters: a measurement may be reported for any
registered site, but **turning that measurement into advice requires onboarding**.
For a `registered_not_onboarded` site the honest output is "42 days, and this site
is not onboarded, so no topic or strategy will be produced for it". Recommending
what to publish on a site whose audience, market and inventory were never
established is invention, and its neighbour being onboarded is not evidence
about it.

A registered-but-not-onboarded site exists so the portfolio is complete and so
nobody has to re-discover it later. Touching one requires the owner to onboard
it first: repository, objectives, market, languages, conversion events and
competitors confirmed, exactly as the pilot did.

## Per-site artifacts

Each onboarded site keeps its own directory under `sites/<site_id>/`:

```
sites/<site_id>/
  entity-graph.md      strategy.md        answer-map/
  baselines/           experiments/       reports/
  changelog.md         competitors.md
```

Paths are per site by construction, so a cross-site leak requires writing to
another site's directory, which is visible in any diff.

## Portfolio-level reporting

Portfolio reports aggregate per-site measurements; they never average away a
site's context. Every portfolio row names its site and carries that site's
data source and connection state, so one site's `NOT_CONNECTED` can never be
silently filled by another site's numbers. Template:
`templates/portfolio-report.md`.

No production change is ever applied to more than one site in a single action,
even when the fix is identical. Each site gets its own PR, its own tests, its
own approval and its own measurement window.
