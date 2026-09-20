# Official sources — compliance knowledge base

Retrieval note: on 2026-09-20 the build sandbox's egress proxy blocked direct
fetches of developers.google.com, platform.openai.com and indexnow.org; the
statements below were verified through search-engine snippets of those
official pages. Re-verify with direct fetches at first run on a machine with
open egress and update the "verified" column. A statement older than 90 days
must be re-checked before it is used for a policy-sensitive decision.

| Topic | Statement we rely on | Source (official) | Verified |
|---|---|---|---|
| Indexing API scope | Only `JobPosting` and `BroadcastEvent` (livestream) pages | developers.google.com/search/apis/indexing-api/v3/quickstart | 2026-09-20 (snippet) |
| FAQ rich results | Shown only for well-known, authoritative government and health sites | developers.google.com/search/blog/2023/08/howto-faq-changes | 2026-09-20 (snippet) |
| llms.txt | Google Search ignores llms.txt and similar AI files; neither helps nor harms | developers.google.com/search/docs/fundamentals/ai-optimization-guide | 2026-09-20 (snippet) |
| AI features | No additional requirements or special markup to appear in AI Overviews / AI Mode; SEO fundamentals apply; AI-feature traffic is in Search Console | developers.google.com/search/docs/appearance/ai-features | 2026-09-20 (snippet) |
| Google-Extended | Controls Gemini/Vertex training use; does not affect Search inclusion; Googlebot is the control for Search incl. AI features | developers.google.com/crawling/docs/crawlers-fetchers/google-common-crawlers | 2026-09-20 (snippet) |
| Googlebot verification | Reverse DNS + forward confirm, or published IP range JSON | developers.google.com/search/docs/crawling-indexing/verifying-googlebot | prior knowledge — re-verify |
| Spam policies | Cloaking, doorway abuse, expired domain abuse, hidden text/links, keyword stuffing, link spam, machine-generated traffic, malware, misleading functionality, scaled content abuse, scraping, site reputation abuse, sneaky redirects, thin affiliation, user-generated spam | developers.google.com/search/docs/essentials/spam-policies | 2026-09-20 (snippet) |
| robots.txt semantics | Longest match wins; allow beats disallow on tie; 5xx robots = disallow all; 4xx = allow all | developers.google.com/crawling/docs/robots-txt/robots-txt-spec ; RFC 9309 | prior knowledge — re-verify |
| Gen-AI performance report | Search Console has a generative AI performance report (announced 2026-06) | developers.google.com/search/blog/2026/06/gen-ai-performance-reports | 2026-09-20 (snippet) |
| OpenAI crawlers | `OAI-SearchBot` (search inclusion), `GPTBot` (training), `ChatGPT-User` (user-triggered); independent robots controls; IP JSON at openai.com/searchbot.json, gptbot.json, chatgpt-user.json | developers.openai.com/api/docs/bots | 2026-09-20 (snippet) |
| IndexNow | Key file `{key}.txt` at host root (8–128 chars, a-zA-Z0-9-); endpoint `https://api.indexnow.org/indexnow`; batches up to 10,000 URLs; Bing, Yandex, Naver, Seznam, Yep participate | indexnow.org/documentation ; bing.com/indexnow | 2026-09-20 (snippet) |
| Bing AI performance | Bing Webmaster Tools exposes AI Performance / Copilot data for verified sites | bing.com/webmasters (docs) | UNKNOWN — verify on connect |
| Claude Code plugins | plugin.json in `.claude-plugin/`, `agents/`, `skills/`, `hooks/hooks.json`, `monitors/`, `evals/` with `prompt.md` + `graders/*.md`; `claude plugin validate|eval`; `--plugin-dir` | code.claude.com/docs/en/plugins, plugins-reference, plugin-evals | 2026-09-20 (direct) |

## Non-official, allowed for hypotheses only
Peer-reviewed / credible empirical studies may seed experiments (see
`schemas/experiment.schema.json`) but never become rules. Third-party tool
data is labelled by provider and date and never treated as algorithm access.
