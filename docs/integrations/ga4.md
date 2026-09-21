# Google Analytics 4 — connection

State today: **client implemented, credential NOT_CONNECTED.**

`src/adapters/ga4.ts` `runReport` üzerinden gerçek çağrı yapıyor: landing page, organik edinim, AI asistan referansları ve dönüşümler — hepsi sayfalamalı. AI kaynak listesi `SEARCH_GROWTH_AI_REFERRERS` ile yapılandırılır, koda gömülü değildir. Kimlik yoksa `null`.

1. Service account (can be the same as GSC); enable "Google Analytics Data API".
2. Add the service-account email to the GA4 property as **Viewer**.
3. Set `SEARCH_GROWTH_GA4_CREDENTIALS_JSON` and `ga4_property` (numeric property id) in the registry.
4. Confirm conversion events named in `primary_conversion_events` actually exist as key events in GA4 — otherwise they stay UNKNOWN and cannot be KPIs.
5. AI referral classification: sessions whose `sessionSource` matches chatgpt.com, chat.openai.com, perplexity.ai, copilot.microsoft.com, gemini.google.com, claude.ai, bing.com (Copilot referrals appear as bing) — recorded as INFERENCE because referrer stripping is common.

Reports used: landing-page sessions/engagement, organic acquisition, key events, revenue if applicable, AI referral sources and their conversions.
