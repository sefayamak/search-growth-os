# High-risk changes — always explicit human approval

The agent may prepare a PR; it never merges. Approval is recorded in the PR.

| Category | Why | Extra requirement |
|---|---|---|
| robots.txt | One line can de-index the site or block rendering | Diff + before/after crawler-access table |
| Sitewide noindex/index | Same | List of affected URLs with current index status (GSC if connected) |
| Canonical strategy | Consolidation mistakes lose rankings silently | Mapping table old→new canonical |
| Domain / hostname changes | Migration risk | Not in scope for the agent at all |
| URL migrations, redirect maps | Signal loss on wrong mapping | Full map, 1:1, tested with status checks |
| Large-scale page deletion | Traffic and link loss | List + inbound link counts + 410/301 decision per URL |
| Large-scale content generation | Scaled content abuse risk | Rejected unless each page has a distinct, evidenced user need |
| Major navigation changes | Internal link graph rewrite | Depth/inbound-link before/after |
| Sitewide template SEO changes | Touches every page | Rendered diff on 3 representative pages |
| hreflang architecture | Cross-locale mis-signalling | Self + return links validated |
| Mass structured-data changes | Misleading-schema policy | Visible-content consistency check per template |
| Substantial rewrites of high-traffic or high-converting pages | Conversion risk | Baseline from GA4/GSC; guardrail metric; rollback |

Sites with `risk_level: high` in the registry treat **every** change as PR +
human approval (`deployment_approval_policy: pr_plus_human_approval`).
