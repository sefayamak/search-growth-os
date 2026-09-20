// Dry-run report: JSON (machine, schema in schemas/audit-report.schema.json) and
// Markdown (human). Missing external data is printed as NOT_CONNECTED — never estimated.
import type { CrawlResult, Finding, IntegrationState } from "./types.ts";

export interface IntegrationStatus { name: string; state: IntegrationState; note: string }

export interface AuditReport {
  schemaVersion: "1.0";
  generatedAt: string;
  site: string;
  mode: "dry-run";
  crawl: { pagesFetched: number; pagesOk: number; maxPages: number; maxDepth: number; sitemapEntries: number; skippedByRobots: number; durationMs: number; userAgent: string };
  crawlerAccess: CrawlResult["crawlerAccess"];
  baseline: { kind: "FULL_BASELINE" | "PARTIAL_BASELINE_SAMPLE"; coverage: CrawlResult["coverage"] };
  integrations: IntegrationStatus[];
  summary: Record<string, number>;
  findings: Finding[];
  unknowns: string[];         // what this report cannot tell you
  noProductionChange: true;
}

export function buildReport(result: CrawlResult, findings: Finding[], integrations: IntegrationStatus[]): AuditReport {
  const summary: Record<string, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const x of findings) summary[x.severity]++;
  return {
    schemaVersion: "1.0",
    generatedAt: new Date().toISOString(),
    site: result.site,
    mode: "dry-run",
    crawl: {
      pagesFetched: result.records.length,
      pagesOk: result.records.filter((r) => r.page.status === 200).length,
      maxPages: result.options.maxPages, maxDepth: result.options.maxDepth,
      sitemapEntries: result.sitemapEntries.length, skippedByRobots: result.skippedByRobots.length,
      durationMs: new Date(result.finishedAt).getTime() - new Date(result.startedAt).getTime(),
      userAgent: result.options.userAgent,
    },
    crawlerAccess: result.crawlerAccess,
    baseline: {
      // A sample is never called a baseline. Only a run that accounted for every
      // eligible sitemap URL earns the FULL_BASELINE label.
      kind: result.coverage?.complete ? "FULL_BASELINE" : "PARTIAL_BASELINE_SAMPLE",
      coverage: result.coverage,
    },
    integrations,
    summary,
    findings,
    unknowns: [
      "Rendered-DOM (JavaScript) content: this crawl reads server HTML only.",
      "Core Web Vitals field data (LCP/INP/CLS): requires CrUX or Search Console; not measured here.",
      "Index status, impressions, clicks, queries: require Search Console (see integrations).",
      "Conversions and AI referral traffic: require GA4 (see integrations).",
      "Backlinks, competitor rankings, AI citations: third-party data, labelled by provider when connected.",
      result.records.length >= result.options.maxPages ? `Crawl hit the ${result.options.maxPages}-page cap; site may be larger.` : "Crawl completed within the page cap.",
    ],
    noProductionChange: true,
  };
}

export function reportToMarkdown(r: AuditReport): string {
  const lines: string[] = [];
  lines.push(`# Search Growth OS — dry-run audit: ${r.site}`, "", `Generated ${r.generatedAt} · mode: ${r.mode} · **no production change was made**`, "");
  lines.push("## What was measured (FACT)", "",
    `| Pages fetched | 200 OK | Sitemap URLs | Blocked by robots (own token) | Duration |`, `|---|---|---|---|---|`,
    `| ${r.crawl.pagesFetched} (cap ${r.crawl.maxPages}, depth ≤ ${r.crawl.maxDepth}) | ${r.crawl.pagesOk} | ${r.crawl.sitemapEntries} | ${r.crawl.skippedByRobots} | ${(r.crawl.durationMs / 1000).toFixed(1)} s |`, "");
  const cov = r.baseline.coverage;
  if (cov) {
    lines.push(`## Baseline coverage — **${r.baseline.kind}**`, "",
      `| Mode | Sitemap URLs | Attempted | Processed | Not attempted | Discovered outside sitemap |`, `|---|---|---|---|---|---|`,
      `| ${cov.mode} | ${cov.sitemapTotal} | ${cov.attempted} | ${cov.processed} | ${cov.notAttempted.length} | ${cov.discoveredOutsideSitemap.length} |`, "");
    if (cov.notAttempted.length) {
      lines.push("Every sitemap URL that was not processed, with its reason:", "");
      const byReason = new Map<string, number>();
      for (const n of cov.notAttempted) byReason.set(n.reason, (byReason.get(n.reason) ?? 0) + 1);
      for (const [reason, n] of byReason) lines.push(`- ${n} × ${reason}`);
      lines.push("", `Sample: ${cov.notAttempted.slice(0, 10).map((n) => n.url).join(", ")}`, "");
    }
  }
  lines.push("## Crawler access at root (from robots.txt)", "", "| Token | Allowed | Purpose | Note |", "|---|---|---|---|");
  for (const a of r.crawlerAccess) lines.push(`| ${a.token} | ${a.rootAllowed === "UNKNOWN" ? "UNKNOWN" : a.rootAllowed ? "yes" : "**no**"} | ${a.purpose} | ${a.note} |`);
  lines.push("", "## Integrations", "", "| Source | State | Note |", "|---|---|---|");
  for (const i of r.integrations) lines.push(`| ${i.name} | ${i.state} | ${i.note} |`);
  lines.push("", "## Findings by severity", "", `critical ${r.summary.critical} · high ${r.summary.high} · medium ${r.summary.medium} · low ${r.summary.low} · info ${r.summary.info}`, "");
  const top = r.findings.filter((x) => x.severity === "critical" || x.severity === "high");
  lines.push("### Critical and high (act on these first)", "");
  if (!top.length) lines.push("_None._", "");
  for (const x of top) {
    lines.push(`- **[${x.severity}] ${x.id}** · ${x.label}${x.url ? ` · ${x.url}` : ""}`, `  ${x.message}`, `  Why it matters: ${x.businessImpact}`);
    if (x.fixHint) lines.push(`  Fix: ${x.fixHint}`);
    if (x.policyRef) lines.push(`  Policy: ${x.policyRef}`);
    lines.push(`  Evidence: \`${JSON.stringify(x.evidence).slice(0, 300)}\``);
  }
  lines.push("", "### Medium / low / info (grouped)", "");
  const grouped = new Map<string, Finding[]>();
  for (const x of r.findings.filter((x) => !top.includes(x))) grouped.set(x.id, [...(grouped.get(x.id) ?? []), x]);
  for (const [id, xs] of grouped) lines.push(`- **${id}** (${xs[0].severity}) ×${xs.length} — ${xs[0].businessImpact}${xs.length <= 3 ? " — " + xs.map((x) => x.url ?? "").filter(Boolean).join(", ") : ""}`);
  lines.push("", "## What this report cannot tell you (UNKNOWN)", "");
  for (const u of r.unknowns) lines.push(`- ${u}`);
  lines.push("", "## Next", "", "- Review critical/high findings with the site owner; each fix goes through `policies/change-management.md` (branch → tests → PR).", "- Connect Search Console and GA4 to replace UNKNOWN with measured data (`docs/integrations/`).", "");
  return lines.join("\n");
}
