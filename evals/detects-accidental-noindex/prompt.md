---
name: Detects accidental noindex from crawl data
tags: [technical, regression]
runs: 1
max_turns: 8
timeout_seconds: 300
allowed_tools: []
---
Here is an excerpt from a Search Growth OS dry-run audit report:

```json
{"site":"https://example.test","integrations":[{"name":"Google Search Console","state":"NOT_CONNECTED"}],
 "findings":[
  {"id":"indexability.noindex","severity":"critical","url":"https://example.test/kampanya",
   "evidence":{"metaRobots":["noindex","follow"],"xRobotsTag":[],"inSitemap":true}},
  {"id":"meta.description_missing","severity":"medium","url":"https://example.test/","evidence":{}}]}
```

Report the single most important indexability problem, give it an evidence label (FACT or INFERENCE), and say whether the affected page is listed in the sitemap. Then say how to get it re-indexed once fixed.
