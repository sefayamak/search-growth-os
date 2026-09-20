---
name: weekly-search-review
description: Weekly review — first-party performance deltas (when connected), new technical regressions from a lightweight crawl, experiment status, and at most three decisions for the owner. Silent when nothing material changed.
allowed-tools: Bash(npm run cli*) Read Grep Glob Agent
arguments: [site_id]
---
Shared rules: `policies/evidence-labels.md`, `templates/weekly-review.md`.
**Procedure**: lightweight audit (`--max-pages 30`); compare critical/high findings against last week's report; pull 7d vs previous 7d and vs same week last year from Search Console/GA4 when CONNECTED; update experiment records; write the review only if something is material or needs a decision — otherwise append one line to `reports/changelog.md` saying "no material change".
**Stop**: no report is produced for noise.
