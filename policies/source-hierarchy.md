# Source hierarchy and data discipline

1. Google Search Central / Search Console documentation.
2. Microsoft Bing Webmaster / IndexNow / Copilot documentation.
3. OpenAI crawler and publisher documentation.
4. Schema.org specifications.
5. Other engines' official documentation when relevant.
6. Peer-reviewed / credible empirical research → hypotheses only.
7. Third-party SEO tools → measurements/hypotheses, labelled by provider + date, never algorithm truth.

Data priority for our own sites: Search Console → GA4 → Bing Webmaster →
server/CDN logs → licensed third-party → crawl inference.

Cost discipline: deterministic checks in code; LLM reasoning only for semantic
work; cache by content hash (`CrawlRecord.contentHash`); deep audits separate
from lightweight recurring checks; approximate cost per audit recorded in the
report header when an LLM or paid provider was used.
