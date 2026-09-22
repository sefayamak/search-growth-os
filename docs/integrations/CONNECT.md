> **Kurulum için: [KURULUM.md](KURULUM.md).** Anahtar GitHub Secret'ta durur,
> haftalık iş `reports/measure-latest.md` dosyasını üretir; rakamlara bakmak
> için kimsenin tarayıcısına ya da anahtara erişmesi gerekmez.

# Connecting Search Console, GA4 and Bing — exact steps

Read-only everywhere. Search Growth OS never needs write access to any search or
analytics property, and you should not grant it. Verified 2026-09-20; sources
and their retrieval dates are in `policies/references/official-sources.md`.

One decision first: **one Google Cloud project, one service account, used for
both Search Console and GA4.** Service account beats OAuth here because this
runs unattended (scheduled audits, CI) and a service account has no refresh
token to expire and no consent screen to re-approve. OAuth would be the right
choice only if a person had to be present for every run. Domain-wide delegation
is not needed and must not be enabled.

## 1. Google Cloud project and APIs

In a Google Cloud project (a new one, e.g. `search-growth-os`, keeps quota and
audit separate from anything else you run):

| API to enable | Service name | Used for |
|---|---|---|
| Google Search Console API | `searchconsole.googleapis.com` | Search Analytics, Sitemaps, URL Inspection |
| Google Analytics Data API | `analyticsdata.googleapis.com` | GA4 reporting |

Do not enable the Indexing API. It is only valid for `JobPosting` and
`BroadcastEvent` pages, so for this site it would be a policy violation.
Do not enable the Google Analytics Admin API; reporting does not need it.

Then: IAM → Service Accounts → create `search-growth-os-reader`. Grant it **no**
project IAM roles. Its access comes from being added as a user inside Search
Console and GA4, not from Cloud IAM. Create a JSON key and download it once.

## 2. Search Console

The service account's email (`search-growth-os-reader@<project>.iam.gserviceaccount.com`)
is added exactly like a person:

1. Search Console → the pamistanbul.com property → Settings → Users and permissions → Add user.
2. Paste the service-account email.
3. Permission level: **Full**.

Why Full and not Restricted: Restricted is enough for Search Analytics, Sites
and Sitemaps, which is most of what we read. The URL Inspection API's required
permission level is not stated in Google's public documentation, and reports of
`PERMISSION_DENIED` for non-owner accounts are common, so Full is the level I
can be confident covers index-status checks. Full is still read-only in the
sense that matters: it cannot remove users or delete the property; only Owner
can. If you prefer to start at Restricted, everything works except URL
Inspection, and I will report index status as UNKNOWN rather than guess.

**Which property ID:** whichever form your property actually is. Domain
property is `sc-domain:pamistanbul.com`; a URL-prefix property is the exact
URL including scheme and trailing slash, e.g. `https://pamistanbul.com/`. These
are different properties with different data. Copy the string exactly as
Search Console shows it. A domain property is preferable here because apex and
www are both attached to the Vercel project.

OAuth scope used: `https://www.googleapis.com/auth/webmasters.readonly`. Never
the read-write `webmasters` scope.

## 3. GA4

1. GA4 → Admin → Property access management → Add users.
2. Paste the same service-account email.
3. Role: **Viewer**. Uncheck "Notify new users by email" (a service account has no inbox).
4. Do not grant Analyst, Editor, or Administrator. Viewer can read every report we need.

**Which property ID:** the numeric Property ID from Admin → Property Settings
(looks like `123456789`). Not the Measurement ID (`G-XXXXXXX`), which is a
public tag identifier and is useless to the Data API.

OAuth scope used: `https://www.googleapis.com/auth/analytics.readonly`.

One thing to check while you are there: Admin → Events / Key events. The
registry currently lists `lead_form_submit` as the conversion event for
pamistanbul, taken from the site repository's commit history, not from GA4.
Until I can see it in GA4 it stays unconfirmed and cannot be used as a KPI.

## 4. Bing Webmaster Tools

No Google Cloud involvement, no OAuth, no service account.

1. Verify pamistanbul.com in Bing Webmaster Tools. Importing from Search Console is the fastest route and carries verification across.
2. Settings (top right) → API Access → API Key → accept the terms → Generate.
3. Copy the key.

Notes that matter: the key belongs to the **user**, not the site, so one key
covers every verified site in the portfolio. Only one key exists at a time;
regenerating invalidates the old one and the new one activates within about
30 minutes. The key grants whatever your Bing account can do, so treat it as a
secret and keep it out of anything public.

## 5. Environment variables

| Variable | Value | Where it lives |
|---|---|---|
| `SEARCH_GROWTH_GSC_CREDENTIALS_JSON` | path to the service-account JSON, or the JSON itself | local machine only |
| `SEARCH_GROWTH_GA4_CREDENTIALS_JSON` | same service-account JSON | local machine only |
| `SEARCH_GROWTH_BING_API_KEY` | the Bing key | local machine only |
| `SEARCH_GROWTH_LOG_SOURCE` | log drain or log path, when you set one up | local machine only |
| `SEARCH_GROWTH_GITHUB_TOKEN` | only if reading deploy history outside an authenticated session; scope `contents:read` | local machine only |

The property identifiers are **not** secrets and belong in
`config/sites.yaml`, in version control, next to the site they describe:
`google_search_console_property`, `ga4_property`, `bing_webmaster_property`.

## 6. Where secrets go, and where they must not

| Location | Put credentials here? |
|---|---|
| Your local machine (`.env`, git-ignored) | Yes. This is the only place needed today. |
| GitHub Actions secrets | Only when a scheduled audit actually exists. None does yet, so nothing goes there now. |
| Vercel environment variables | No. Vercel runs the website; the website never reads search data. |
| The `pam-crm` repository | Never. `.env` is git-ignored; only `.env.example` is tracked, and it holds names, not values. |
| The `pamistanbul-site` repository | Never. |
| A chat message, including to me | Never. Paste paths and property IDs, not key contents. |

Rotation: the Google key is rotated by creating a new key and deleting the old
one in Cloud IAM; the Bing key by delete-then-generate, which breaks anything
still using the old one.

## 7. Verify the connection

```bash
cd search-growth-os
npm run cli -- integrations      # each source should read CONNECTED, not NOT_CONNECTED
```

A source that stays `NOT_CONNECTED` after you set its variable means the
credential is present but the live call has not been proven yet; the adapter
reports `UNKNOWN` in that state rather than claiming success.

## What you are NOT granting

No write scope on Search Console. No Editor or Administrator on GA4. No
Indexing API. No domain-wide delegation. No Cloud IAM project roles. No
submission rights (IndexNow submission stays disabled in Phase 1). If any
instruction ever asks you for more than the above, it is wrong.
