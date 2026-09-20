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

| Status | Crawl | Analyse | Propose changes | Ship changes |
|---|---|---|---|---|
| `pilot_onboarding` | yes | yes | yes, PR only | only with explicit owner approval |
| `active` | yes | yes | yes, PR only | per `deployment_approval_policy` |
| `registered_not_onboarded` | **no** | **no** | **no** | **no** |

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
