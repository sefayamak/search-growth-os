# Google Search Console — connection

State today: **NOT_CONNECTED**.

1. Create a Google Cloud service account; enable "Google Search Console API".
2. In Search Console, add the service-account email as a **Restricted** user on the property (read-only is enough for Phase 1; Full is needed for URL Inspection quotas per property owner rules — verify in official docs).
3. Store the JSON key **outside the repo**; set `SEARCH_GROWTH_GSC_CREDENTIALS_JSON` (path or inline JSON).
4. Set `google_search_console_property` in `config/sites.yaml` (`sc-domain:pamistanbul.com` or the URL-prefix property exactly as shown in GSC).
5. Smoke test (read-only): request 7 days of `searchAnalytics.query` with `dimensions=[date]`; a 200 with rows flips the adapter to CONNECTED.

Capabilities we will use: Search Analytics (page/query/country/device/searchAppearance, date comparison), URL Inspection (index status, canonical selected by Google), Sitemaps API, and the generative-AI search performance report where the account/API exposes it (verify availability; do not assume).
Never: Indexing API for ordinary pages.
