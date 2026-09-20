#!/usr/bin/env node --experimental-strip-types
// Print a compact, greppable summary of an audit JSON. The full report is long, so
// CI logs get the numbers that matter as single lines at the end of the run.
//   usage: node --experimental-strip-types bin/summarize.ts <audit.json>
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AuditReport } from "../src/report.ts";

const path = process.argv[2];
if (!path) { console.error("usage: summarize.ts <audit.json>"); process.exit(1); }
const a = JSON.parse(readFileSync(resolve(path), "utf8")) as AuditReport;

console.log(`RESULT site=${a.site} kind=${a.baseline.kind} pages=${a.crawl.pagesFetched} ok=${a.crawl.pagesOk}` +
  ` sitemapUrls=${a.crawl.sitemapEntries} blockedByRobots=${a.crawl.skippedByRobots} seconds=${Math.round(a.crawl.durationMs / 1000)}`);

const c = a.baseline.coverage;
if (c) {
  const pct = c.sitemapTotal ? ((c.attempted / c.sitemapTotal) * 100).toFixed(1) : "0.0";
  console.log(`COVERAGE mode=${c.mode} sitemapTotal=${c.sitemapTotal} attempted=${c.attempted} notAttempted=${c.notAttempted.length}` +
    ` outsideSitemap=${c.discoveredOutsideSitemap.length} complete=${c.complete} percent=${pct}`);
  const byReason = new Map<string, number>();
  for (const n of c.notAttempted) byReason.set(n.reason, (byReason.get(n.reason) ?? 0) + 1);
  for (const [reason, n] of byReason) console.log(`UNCOVERED ${n} ${reason}`);
}

const s = a.summary;
console.log(`SEVERITY critical=${s.critical} high=${s.high} medium=${s.medium} low=${s.low} info=${s.info}`);

const conf = new Map<string, number>();
for (const f of a.findings) conf.set(f.confidence ?? "UNKNOWN", (conf.get(f.confidence ?? "UNKNOWN") ?? 0) + 1);
console.log("CONFIDENCE " + [...conf].map(([k, v]) => `${k}=${v}`).join(" "));

const by = new Map<string, { n: number; sev: string; conf: string }>();
for (const f of a.findings) {
  const e = by.get(f.id) ?? { n: 0, sev: f.severity, conf: f.confidence ?? "UNKNOWN" };
  e.n++; by.set(f.id, e);
}
for (const [id, e] of [...by].sort((x, y) => y[1].n - x[1].n)) console.log(`FINDING ${id} x${e.n} ${e.sev} ${e.conf}`);
for (const cr of a.crawlerAccess) console.log(`CRAWLER ${cr.token} allowed=${cr.rootAllowed}`);
for (const i of a.integrations) console.log(`INTEGRATION ${i.name} ${i.state}`);
