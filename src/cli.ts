// Search Growth OS CLI — read-only.
//   crawl <url> [--max-pages N] [--max-depth N] [--delay ms] [--out dir]
//   audit <url> [...same]           crawl + checks + dry-run report (json + md)
//   compliance <file> [--kind k]    run the compliance gate on a file
//   compliance --stdin --kind k     read content from stdin
//   registry <path>                 validate a site registry (yaml subset / json)
//   integrations                    print adapter connection states
//   portfolio [--site id] [--onboarded-only] [--sample N] [--delay ms] [--out dir]
//                                   measure publishing cadence across the registry
//   llmstxt [--site id] [--out dir]  inventory each site's llms.txt against the spec and the registry
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { crawl } from "./crawler.ts";
import { assessPortfolio, cadenceToMarkdown } from "./cadence.ts";
import { inspectPortfolio, llmsTxtToMarkdown } from "./llmstxt.ts";
import { runAudit } from "./audit.ts";
import { buildReport, reportToMarkdown } from "./report.ts";
import { checkCompliance, kindFromPath } from "./compliance.ts";
import { loadRegistry, onboardedSites } from "./registry.ts";
import { allStatuses } from "./adapters/index.ts";

const args = process.argv.slice(2);
const cmd = args[0];
function opt(name: string, def: string): string;
function opt(name: string): string | undefined;
function opt(name: string, def?: string) { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; }
const flag = (name: string) => args.includes(`--${name}`);

function slug(u: string) { return u.replace(/^https?:\/\//, "").replace(/[^a-z0-9.-]+/gi, "_"); }

async function main() {
  switch (cmd) {
    case "crawl":
    case "audit": {
      // Two ways in. `--site <id>` resolves the target through the registry and is the
      // only path the remote runner uses, because the registry is where the
      // onboarding gate lives: a site that is merely registered must never be crawled.
      const siteId = opt("site");
      let url = args[1] && !args[1].startsWith("--") ? args[1] : undefined;
      if (siteId) {
        const reg = loadRegistry(opt("registry", join("config", "sites.yaml")));
        if (!reg.ok) throw new Error(`registry invalid:\n${reg.errors.join("\n")}`);
        const site = reg.registry!.sites.find((s) => s.id === siteId);
        if (!site) throw new Error(`site "${siteId}" is not in the registry`);
        if (!onboardedSites(reg.registry!).some((s) => s.id === siteId))
          throw new Error(`site "${siteId}" is ${site.onboarding_status}: it must be onboarded before it can be crawled (policies/portfolio-isolation.md)`);
        const host = site.canonical_hostname && !["UNKNOWN", "NOT_CONNECTED"].includes(site.canonical_hostname) ? site.canonical_hostname : site.production_domain;
        url = `https://${host}/`;
        console.error(`site ${siteId} (${site.onboarding_status}) → ${url}`);
      }
      if (!url) throw new Error("usage: audit <url> | audit --site <registry id>");
      const full = flag("full");
      // In full mode the sitemap is the universe, so the cap must not silently truncate it.
      // The explicit --max-pages still acts as a ceiling, raised to cover the sitemap.
      const cap = Number(opt("max-pages", full ? "5000" : "50"));
      const result = await crawl({ startUrl: url, fromSitemap: full, maxPages: full ? Math.max(cap, 5000) : cap, maxDepth: Number(opt("max-depth", full ? "2" : "3")), delayMs: Number(opt("delay", "500")) }, (s) => process.stderr.write(s + "\n"));
      // Unreachable target must fail loudly. A report built from zero fetched pages
      // would otherwise look like a clean site.
      const first = result.records[0];
      if (!first || first.page.status === 0 || first.page.status >= 400) {
        const why = first ? `${first.page.status || "no response"}${first.page.error ? ` (${first.page.error})` : ""}` : "no pages fetched";
        console.error(`CRAWL FAILED: ${url} unreachable — ${why}`);
        const robotsOk = result.robots.fetched && result.robots.status > 0 && result.robots.status < 400;
        console.error(robotsOk
          ? `robots.txt returned ${result.robots.status}, so the host is reachable and this page itself is failing.`
          : `robots.txt also failed (${result.robots.status || "no response"}): the whole host is unreachable from this runner — DNS, TLS, network egress policy, or a WAF refusing the crawler.`);
        process.exitCode = 3;
        return;
      }
      const outDir = opt("out", join("reports", "runs"));
      mkdirSync(outDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const base = join(outDir, `${slug(result.site)}_${stamp}`);
      writeFileSync(`${base}.crawl.json`, JSON.stringify(result, null, 2));
      if (cmd === "crawl") { console.log(`${base}.crawl.json`); return; }
      const findings = runAudit(result);
      const report = buildReport(result, findings, allStatuses().map(({ name, state, note }) => ({ name, state, note })));
      writeFileSync(`${base}.audit.json`, JSON.stringify(report, null, 2));
      writeFileSync(`${base}.audit.md`, reportToMarkdown(report));
      console.log(reportToMarkdown(report));
      console.error(`\nwritten: ${base}.audit.json / .audit.md / .crawl.json`);
      return;
    }
    case "compliance": {
      const path = flag("stdin") ? undefined : args[1];
      const content = path ? readFileSync(path, "utf8") : readFileSync(0, "utf8");
      const kind = (opt("kind") ?? (path ? kindFromPath(path) : "text")) as Parameters<typeof checkCompliance>[1]["kind"];
      const res = checkCompliance(content, { kind, path });
      console.log(JSON.stringify(res, null, 2));
      process.exitCode = res.verdict === "REJECT" ? 2 : res.verdict === "FLAG" ? 1 : 0;
      return;
    }
    case "registry": {
      const res = loadRegistry(args[1] ?? join("config", "sites.example.yaml"));
      if (res.ok) console.log(`OK: ${res.registry!.sites.length} site(s): ${res.registry!.sites.map((s) => s.id).join(", ")}`);
      else { console.error(res.errors.join("\n")); process.exitCode = 1; }
      return;
    }
    case "portfolio": {
      // Cadence measurement reads sitemaps and publish dates only. It derives no keyword,
      // competitor or strategy, so unlike `audit` it may look at every registered site —
      // that is what makes "check my sites" answerable in one pass. Turning a measurement
      // into ADVICE is still gated: see policies/portfolio-isolation.md.
      const reg = loadRegistry(opt("registry", join("config", "sites.yaml")));
      if (!reg.ok) throw new Error(`registry invalid:\n${reg.errors.join("\n")}`);
      const only = opt("site");
      let sites = reg.registry!.sites;
      if (only) {
        sites = sites.filter((s) => s.id === only);
        if (!sites.length) throw new Error(`site "${only}" is not in the registry`);
      }
      if (flag("onboarded-only")) sites = sites.filter((s) => onboardedSites(reg.registry!).some((o) => o.id === s.id));

      const results = await assessPortfolio(
        sites.map((s) => ({
          id: s.id,
          domain: s.canonical_hostname && !["UNKNOWN", "NOT_CONNECTED"].includes(s.canonical_hostname) ? s.canonical_hostname : s.production_domain,
          onboardingStatus: s.onboarding_status,
          sitemaps: (s.sitemap_locations ?? []).filter((u) => typeof u === "string" && u.startsWith("http")),
          cadenceDays: typeof s.content_cadence_days === "number" ? s.content_cadence_days : null,
          contentSections: Array.isArray(s.content_sections) ? s.content_sections : [],
        })),
        { samplePages: Number(opt("sample", "6")), delayMs: Number(opt("delay", "800")) },
        (s) => process.stderr.write(s + "\n"),
      );

      const outDir = opt("out", join("reports", "runs"));
      mkdirSync(outDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const base = join(outDir, `portfolio_${stamp}`);
      writeFileSync(`${base}.cadence.json`, JSON.stringify(results, null, 2));
      const md = cadenceToMarkdown(results);
      writeFileSync(`${base}.cadence.md`, md);
      console.log(md);
      for (const r of results) {
        console.error(`CADENCE ${r.siteId} verdict=${r.verdict} days=${r.daysSincePublish ?? "null"} expected=${r.expectedCadenceDays}`
          + ` section=${r.contentSection?.pattern ?? "none"} source=${r.latestPublish?.source ?? "none"} status=${r.onboardingStatus}`);
      }
      // A site that could not be measured is not a passing site. Exit 4 keeps an
      // unreachable host from reading as "nothing to report" in a scheduled run.
      if (results.some((r) => r.error)) process.exitCode = 4;
      console.error(`\nwritten: ${base}.cadence.json / .cadence.md`);
      return;
    }
    case "llmstxt": {
      // Inventory only. This reads two public files per site and compares them to facts the
      // owner already confirmed; it derives no strategy, so like `portfolio` it may look at
      // every registered site (policies/portfolio-isolation.md).
      const reg = loadRegistry(opt("registry", join("config", "sites.yaml")));
      if (!reg.ok) throw new Error(`registry invalid:\n${reg.errors.join("\n")}`);
      const only = opt("site");
      let sites = reg.registry!.sites;
      if (only) {
        sites = sites.filter((s) => s.id === only);
        if (!sites.length) throw new Error(`site "${only}" is not in the registry`);
      }
      const results = await inspectPortfolio(
        sites.map((s) => ({
          id: s.id,
          domain: s.canonical_hostname && !["UNKNOWN", "NOT_CONNECTED"].includes(s.canonical_hostname) ? s.canonical_hostname : s.production_domain,
          onboardingStatus: s.onboarding_status,
          foundationYear: typeof s.foundation_year === "number" ? s.foundation_year : null,
          brandEntities: Array.isArray(s.brand_entities) ? s.brand_entities : [],
        })),
        {},
        (s) => process.stderr.write(s + "\n"),
      );
      const outDir = opt("out", join("reports", "runs"));
      mkdirSync(outDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const base = join(outDir, `llmstxt_${stamp}`);
      writeFileSync(`${base}.json`, JSON.stringify(results, null, 2));
      const md = llmsTxtToMarkdown(results);
      writeFileSync(`${base}.md`, md);
      console.log(md);
      for (const r of results) {
        console.error(`LLMSTXT ${r.siteId} present=${r.present} status=${r.status} tokens=${r.tokensLow}-${r.tokensHigh}`
          + ` links=${r.spec?.linkCount ?? 0} questions=${r.spec?.questionCount ?? 0} full=${r.full.present}`
          + ` contradictions=${r.contradictions.length}`);
      }
      // A contradiction is a real defect on a live site, so it must not exit green.
      if (results.some((r) => r.contradictions.some((c) => c.confidence === "CONFIRMED"))) process.exitCode = 5;
      console.error(`\nwritten: ${base}.json / ${base}.md`);
      return;
    }
    case "integrations": {
      for (const s of allStatuses()) console.log(`${s.state.padEnd(14)} ${s.name} — ${s.note}`);
      return;
    }
    default:
      console.error("commands: crawl | audit | compliance | registry | integrations | portfolio | llmstxt");
      process.exitCode = 1;
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
