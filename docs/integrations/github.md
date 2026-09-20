# GitHub — deploy and change history

State today: **NOT_CONNECTED** for the website repository (repository is UNKNOWN in the registry).

Purpose: overlay commit/deploy timeline on search metrics for forensics; open PRs through the change-management path. Token scope: `contents:read` for history; PR creation uses the normal Claude Code GitHub integration, never a stored broad token. Set `SEARCH_GROWTH_GITHUB_TOKEN` only if history must be read outside an authenticated session.
