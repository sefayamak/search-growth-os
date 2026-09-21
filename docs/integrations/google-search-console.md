# Google Search Console — connection

State today: **client implemented, credential NOT_CONNECTED.**

`src/adapters/gsc.ts` artık gerçek çağrı yapıyor (Search Analytics + sayfalama, URL Inspection, Sitemaps). Kimlik yoksa `null` döner ve rapor `NOT_CONNECTED` yazar — sayı uydurulmaz. Kapsam salt-okunur; sitemap gönderme / URL kaldırma bu katmanda yok.

1. Create a Google Cloud service account; enable "Google Search Console API".
2. In Search Console, add the service-account email as a **Restricted** user on the property (read-only is enough for Phase 1; Full is needed for URL Inspection quotas per property owner rules — verify in official docs).
3. Store the JSON key **outside the repo**; set `SEARCH_GROWTH_GSC_CREDENTIALS_JSON` (path or inline JSON).
4. Set `google_search_console_property` in `config/sites.yaml` (`sc-domain:pamistanbul.com` or the URL-prefix property exactly as shown in GSC).
5. Smoke test (read-only): `npm run cli -- smoke`. 7 günlük `searchAnalytics` çağırır ve her site için OK/FAIL basar. **"Env dolu" ile "API cevap veriyor" ayrı şeylerdir**: servis hesabı property'ye eklenmemişse 403 gelir ve bu sıfır trafik gibi okunmamalıdır — smoke bunu ayırır.
6. Ölçüm: `npm run cli -- measure` — dönem karşılaştırması (son 28 gün vs geçen yıl aynı dönem, 2 gün gecikmeli) ve marka / marka dışı ayrımı.

Opsiyonel: `SEARCH_GROWTH_GSC_SUBJECT` (domain-wide delegation). Yalnızca açıkça gerekiyorsa; servis hesabına kullanıcı kimliği giydirmek geniş bir yetkidir ve varsayılan değildir.

Capabilities we will use: Search Analytics (page/query/country/device/searchAppearance, date comparison), URL Inspection (index status, canonical selected by Google), Sitemaps API, and the generative-AI search performance report where the account/API exposes it (verify availability; do not assume).
Never: Indexing API for ordinary pages.
