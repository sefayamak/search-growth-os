# Migration out of pam-crm, and the cleanup that follows

Search Growth OS was developed inside `sefayamak/pam-crm` because that was the
repository already attached to the working session. That was a convenience, not
an architecture: a search operating system has no business living inside a CRM.
This repository is the correction.

## What moved

Every tracked file of the former `pam-search-os/` directory, plus the audit
workflow that sat at the CRM repository root. Nothing was rewritten from
scratch, so no working code was lost. The product identifiers were renamed
coherently:

| Old | New |
|---|---|
| `pam-search-os` | `search-growth-os` |
| `PAM Search OS` | `Search Growth OS` |
| `PAMSearchOS` (crawler token, user agent) | `SearchGrowthOS` |
| `PAM_SEARCH_*` (environment variables) | `SEARCH_GROWTH_*` |

Deliberately **not** renamed, because they are facts rather than product names:
PAM İstanbul, PAM AI Studio, `pamistanbul.com`, the registry site id
`pamistanbul`, the `sefayamak/pamistanbul-site` repository, and references to
`pam-crm` where they describe history.

## Independence

This repository has no runtime dependency on the CRM. It does not read its
source, its `package.json`, its database, its Supabase project, its migrations,
its deployment, its environment variables or its Vercel project. It installs and
runs from a clean clone with Node alone and two dev-only packages (TypeScript
and `@types/node`) that are not required to run the crawler.

If CRM integration is ever wanted, it goes through an explicit adapter under
`src/adapters/` with its own connection state. It does not exist today.

## Cleanup sequence in pam-crm

The order matters, and it is deliberately conservative: nothing is deleted
until the replacement is proven.

1. Build the standalone repository and validate it from a clean checkout. **Done.**
2. Run the real production crawl and the full baseline from a runner with egress. **Done.**
3. Push the standalone repository to `sefayamak/search-growth-os`. **Blocked:** repository creation returns 403, so the empty private repository has to be created by its owner first.
4. Verify the pushed repository contains every file the local one does.
5. Remove `search-growth-os/` and `.github/workflows/search-audit.yml` from `pam-crm`, leaving the CRM untouched.
6. Close PR #21 without merging. It only ever contained this product, so merging it would put a search system inside a CRM, which is the mistake being corrected.

Until step 3 is possible, the copy inside `pam-crm` stays exactly where it is.
Deleting it first would leave the only validated implementation on one
unreplicated branch, which is the failure this sequence exists to prevent.

## The temporary push trigger

The audit workflow carries a push trigger scoped to the pilot branch. GitHub
resolves `workflow_dispatch` and `schedule` against a repository's default
branch, so neither could fire while the workflow existed only on a feature
branch, and the full baseline had to run somehow. In this repository the
workflow ships with `workflow_dispatch` and the weekly schedule only; the push
trigger is not carried over and must not be re-added.
