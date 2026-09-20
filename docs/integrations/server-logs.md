# Server / CDN logs and crawler verification

State today: **NOT_CONNECTED**.

Options for a Vercel-hosted site: a Log Drain (to a store you control) or the runtime logs API. Set `SEARCH_GROWTH_LOG_SOURCE`.

Classification rule: a user-agent string is a claim, not a fact. Verify Googlebot via reverse DNS (`googlebot.com` / `google.com`) + forward lookup, or the published IP-range JSON; Bingbot via its published ranges; OpenAI bots via `openai.com/searchbot.json`, `gptbot.json`, `chatgpt-user.json`. Store `verified: true|false|UNKNOWN` per hit. Unverified hits are reported separately.
