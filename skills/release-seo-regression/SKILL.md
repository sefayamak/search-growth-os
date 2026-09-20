---
name: release-seo-regression
description: Pre-release regression test for search — crawl the preview/staging URL, compare with the last production crawl, and report metadata, indexability, canonical, redirect, structured-data, link and tracking regressions. Use before merging a website PR.
allowed-tools: Bash(npm run cli*) Read Grep Glob
arguments: [preview_url, baseline_crawl_json]
---
Shared rules: `policies/quality-gates.md`.
**Procedure**: `npm run cli -- audit $preview_url`; diff titles/descriptions/canonicals/robots/hreflang/JSON-LD types/inbound counts/status codes per URL against the baseline crawl JSON; list every gate with PASS / FAIL / UNKNOWN.
**Output**: gate table for the PR body (`templates/pr-body.md`). A gate that could not run is UNKNOWN, never PASS.
**Stop**: preview URL unreachable → report, do not approve.
