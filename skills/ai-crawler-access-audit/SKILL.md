---
name: ai-crawler-access-audit
description: Report which search and AI crawlers (Googlebot, Google-Extended, Bingbot, OAI-SearchBot, GPTBot, ChatGPT-User, PerplexityBot, ClaudeBot) can reach the site per robots.txt, meta/X-Robots directives and (when logs are connected) verified crawler hits. Reports facts; does not change access.
allowed-tools: Bash(npm run cli*) Read Grep Glob
arguments: [site_url]
---
**Evidence**: `crawlerAccess` table from the audit (FACT from robots.txt); log adapter crawler hits with verification status when CONNECTED; otherwise UNKNOWN.
**Facts to state**: Googlebot governs Search and AI Overviews/AI Mode; Google-Extended affects only Gemini/Vertex training; OAI-SearchBot and GPTBot are independent controls; Google ignores llms.txt.
**Output**: access table + implications per business objective + the decision the owner must make (blocking is policy, not optimization).
