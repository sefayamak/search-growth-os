# Quality gates before a search change is "production-ready"

A green build is not evidence that an SEO change is safe. Applicable gates:

| Gate | How (Phase 1 tooling) |
|---|---|
| Build / typecheck / unit / integration tests | Repo's own commands |
| Route availability and status codes | `cli crawl` on the preview URL; compare with baseline crawl JSON |
| Redirect behaviour | `http.redirect_chain`, `http.error` checks |
| robots / noindex / canonical / hreflang | `indexability.*`, `canonical.*`, `i18n.*` checks on preview vs production |
| Sitemap consistency | `sitemap.*` checks |
| Structured data syntax + visible-content consistency | `schema.*` checks |
| Rendered content present | `content.js_dependent`; rendered-DOM comparison when Playwright is available |
| Broken links | `http.error` on internal links |
| Core Web Vitals / performance regression | Lab: Lighthouse on preview (when available); field: CrUX/GSC after deploy — UNKNOWN until connected |
| Accessibility regression | alt coverage (`media.alt_missing`), heading outline; full a11y audit is out of Phase 1 scope |
| Metadata regression | title/description diff between baseline and preview crawl |
| Internal-link regression | inbound-link counts per URL, depth (`links.*`) |
| Analytics / conversion tracking | Presence of the tracking snippet and conversion event on changed templates; must be verified in GA4 DebugView by a human when tracking code moved |
| Critical page visual integrity | Screenshot comparison of home, top service page, contact page (Playwright, when available) |

Any gate that cannot run reports UNKNOWN in the PR body; it is never marked passed.
