# Operating model and cadence

| Cadence | What | Cost class | Tooling |
|---|---|---|---|
| Per release | `release-seo-regression` on preview URL | cheap, deterministic | CI job in website repo (to be created after onboarding) |
| Daily/6h | lightweight crawl of home + top 20 commercial URLs; alert only on new critical/high | cheap | scheduled workflow → appends to `reports/alerts.log` |
| Weekly | `weekly-search-review` | cheap + small LLM | Routine / `/loop` after GSC+GA4 connect |
| Monthly | `index-quality-audit`, `internal-link-analysis`, `media-search-audit` | medium | manual or Routine |
| Quarterly | `strategic-deep-review` incl. competitor and GEO | expensive | manual |

Rules: no report without a decision or material change; notify only when material; cost per audit recorded in the report header when LLM/paid data is used; cache by `contentHash`.

**No scheduled job exists yet.** Creating one requires the website repository and is the next step after onboarding (see README "Onboarding the first real website").
