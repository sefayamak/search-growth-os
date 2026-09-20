# Google Search Console — implementation readiness

Property: **`sc-domain:pamistanbul.com`** (owner-confirmed, recorded in
`config/sites.yaml`). A domain property covers apex, www and every subdomain,
which is the right shape here because both apex and www are attached to the
Vercel project.

State: **NOT_CONNECTED** — the property string is known, the credential is not
issued. The adapter reports that honestly and returns `null` rather than a number.

## What is already built

`src/adapters/index.ts` defines the stable surface the skills call:

| Method | Returns | Used by |
|---|---|---|
| `searchAnalytics(property, range, dimensions)` | rows of clicks, impressions, CTR, position by date / page / query / country / device / searchAppearance | weekly review, traffic-drop forensics, competitor discovery, content opportunity |
| `urlInspection(property, url)` | index status and the canonical Google actually selected | index quality audit, verifying a fix |
| `sitemaps(property)` | submitted sitemaps and their processing state | sitemap consistency |

Each is a stub that returns `null` while the credential is missing. That is
deliberate: a stub returning zeros would be indistinguishable from a site with
no traffic.

## Exactly what makes it live

1. Enable **Google Search Console API** (`searchconsole.googleapis.com`) in a Google Cloud project.
2. Create service account `search-growth-os-reader`, no project IAM roles, download one JSON key.
3. Search Console → pamistanbul.com property → Settings → Users and permissions → add the service-account email as **Full**.
4. Set `SEARCH_GROWTH_GSC_CREDENTIALS_JSON` locally to the key path.
5. `npm run cli -- integrations` must print CONNECTED.

Scope: `webmasters.readonly` only. Never the read-write `webmasters` scope.
Full rather than Restricted is about URL Inspection, whose required level Google
does not state publicly; Restricted is enough for Search Analytics and
sitemaps, and with it I report index status as UNKNOWN instead of guessing.
Full still cannot remove users or delete the property.

Full rationale, including where secrets live and what is deliberately not
granted: `docs/integrations/CONNECT.md`.

## First queries once connected

1. 16 months of `date` totals, to establish a baseline and see the seasonality the owner already suspects.
2. `query` split into brand and non-brand — non-brand is the number that matters.
3. `page` for the commercial pages, to see which of the 807 actually earn impressions.
4. `searchAppearance`, which is where AI-feature traffic shows up; Google states that pages appearing in AI Overviews and AI Mode are included in Search Console's overall Search traffic.
5. URL Inspection on a sample: the 74 pages that canonicalize to pamaistudio.com, to learn which canonical Google actually selected.

None of this is run before the credential exists, and none of it is estimated
in the meantime.
