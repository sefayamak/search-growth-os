---
name: traffic-drop-investigation
description: Forensic workflow for an organic or AI-referral traffic drop. Segments first-party data, correlates with deploys and confirmed search updates, produces ranked hypotheses with tests — never a reflexive "algorithm update" verdict. Use for "traffic dropped", "clicks fell", "lost rankings".
allowed-tools: Bash(npm run cli*) Read Grep Glob Agent
arguments: [site_id, drop_start_date]
---
Shared rules: `policies/evidence-labels.md`, `templates/traffic-drop.md`.
**Inputs**: site id, approximate drop date, Search Console + GA4 (via adapters), deploy history (GitHub adapter), latest and pre-drop crawl JSON if any.
**Evidence requirements**: at least one first-party source CONNECTED; otherwise the output is limited to technical hypotheses from crawl diff and says so.
**Procedure** (run by `search-measurement-scientist`): segment by date/page/query/brand-nonbrand/country/device/appearance/AI appearance/conversion; overlay deploy history and official update announcements; run `technical-audit` on the current site and diff against the last stored crawl; rank hypotheses with evidence for/against and a confirming test.
**Output**: `templates/traffic-drop.md` filled; no recovery change proposed until a cause is defensible.
**Stop**: no data source and no prior crawl → report "cannot investigate; connect Search Console" instead of speculating.
