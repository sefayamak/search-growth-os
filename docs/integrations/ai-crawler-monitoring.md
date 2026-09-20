# AI crawler monitoring

Facts (official docs, see `policies/references/official-sources.md`):
- Googlebot is the control for Search **and** AI Overviews / AI Mode. `Google-Extended` controls Gemini/Vertex training only.
- `OAI-SearchBot` = ChatGPT search inclusion; `GPTBot` = training; `ChatGPT-User` = user-triggered fetch. Independent robots controls; IP ranges published as JSON.
- Google ignores llms.txt.

What the system does: reports per-token root access from robots.txt on every audit (`crawlerAccess`), and, when logs are CONNECTED, verified hit counts per token. It never changes robots.txt on its own (high-risk).
