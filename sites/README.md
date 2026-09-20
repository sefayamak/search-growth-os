# Per-site artifacts

One directory per onboarded site, named by its registry `id`. Nothing is shared
between them: competitors, topics, strategy, baselines and experiments are
per-site work products even though one person owns the whole portfolio. See
`policies/portfolio-isolation.md`.

```
sites/<site_id>/
  baselines/     point-in-time measured state (dated)
  experiments/   one record per change, schemas/experiment.schema.json
  reports/       executive and weekly reports for this site
  entity-graph.md · strategy.md · competitors.md · changelog.md   (added as the work produces them)
```

A directory exists only for a site that is actually onboarded. Today that is
`pamistanbul` alone; the other six portfolio sites are `registered_not_onboarded`
in `config/sites.yaml` and are deliberately untouched.
