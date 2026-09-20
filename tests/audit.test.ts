import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startFixtureServer } from "./fixture-server.ts";
import { crawl } from "../src/crawler.ts";
import { runAudit } from "../src/audit.ts";
import { buildReport, reportToMarkdown } from "../src/report.ts";
import type { CrawlResult, Finding } from "../src/types.ts";

let origin = "";
let close: () => void = () => {};
let result: CrawlResult;
let findings: Finding[];

before(async () => {
  const s = await startFixtureServer();
  origin = s.origin; close = () => s.server.close();
  result = await crawl({ startUrl: origin + "/", maxPages: 40, maxDepth: 3, delayMs: 0, timeoutMs: 5000 });
  findings = runAudit(result);
});
after(() => close());

const ids = () => findings.map((f) => f.id);
const byId = (id: string) => findings.filter((f) => f.id === id);

test("crawl is read-only, same-host, robots-aware", () => {
  assert.ok(result.records.length >= 12, `expected ≥12 pages, got ${result.records.length}`);
  assert.ok(result.records.every((r) => new URL(r.page.url).origin === origin), "left the host");
  assert.ok(result.skippedByRobots.some((u) => u.endsWith("/admin/secret")), "did not honour Disallow: /admin/");
  assert.ok(!result.records.some((r) => r.page.url.endsWith("/admin/secret")));
  assert.equal(result.sitemapEntries.length, 5);
});

test("crawler access report reads robots.txt per token", () => {
  const gpt = result.crawlerAccess.find((a) => a.token === "GPTBot")!;
  const google = result.crawlerAccess.find((a) => a.token === "Googlebot")!;
  assert.equal(gpt.rootAllowed, false);
  assert.equal(google.rootAllowed, true);
  assert.ok(ids().includes("robots.crawler_blocked"));
});

test("detects accidental noindex (meta) listed in sitemap as critical", () => {
  const hit = byId("indexability.noindex").find((f) => f.url?.endsWith("/noindexed"));
  assert.ok(hit, "meta noindex not found");
  assert.equal(hit!.severity, "critical");
  assert.equal(hit!.evidence.inSitemap, true);
  assert.equal(hit!.label, "INFERENCE");
});

test("detects noindex from X-Robots-Tag header", () => {
  const hit = byId("indexability.noindex").find((f) => f.url?.endsWith("/header-noindex"));
  assert.ok(hit);
  assert.deepEqual(hit!.evidence.xRobotsTag, ["noindex", "nofollow"]);
});

test("detects broken and multiple canonicals", () => {
  assert.ok(byId("indexability.multiple_canonicals").some((f) => f.url?.endsWith("/bad-canonical")));
  assert.ok(byId("canonical.target_not_200").some((f) => f.url?.endsWith("/bad-canonical") && f.evidence.targetStatus === 500));
});

test("detects redirect chain and sitemap listing a redirecting URL", () => {
  const chain = byId("http.redirect_chain").find((f) => f.url?.endsWith("/old-a"));
  assert.ok(chain);
  assert.equal((chain!.evidence.chain as unknown[]).length, 2);
  assert.ok(byId("sitemap.non_canonical_entry").some((f) => f.url?.endsWith("/old-a")));
});

test("detects 500, soft 404, orphan sitemap URL, duplicates, hidden text, schema problems, missing alt", () => {
  assert.ok(byId("http.error").some((f) => f.url?.endsWith("/broken") && f.evidence.status === 500));
  assert.ok(byId("indexability.soft_404").some((f) => f.url?.endsWith("/soft404")));
  const orphan = byId("sitemap.orphan_candidates")[0];
  assert.ok(orphan && (orphan.evidence.sample as string[]).some((u) => u.endsWith("/orphan")));
  const dup = byId("content.duplicate_text")[0];
  assert.ok(dup && (dup.evidence.urls as string[]).length === 2);
  assert.ok(byId("content.hidden_text_suspect").some((f) => f.url?.endsWith("/hidden")));
  assert.ok(byId("schema.invalid_json").some((f) => f.url?.endsWith("/schema-mismatch")));
  assert.ok(byId("schema.not_in_visible_content").some((f) => f.url?.endsWith("/schema-mismatch")));
  assert.ok(byId("schema.rating_without_visible_reviews").some((f) => f.url?.endsWith("/schema-mismatch")));
  assert.ok(byId("content.js_dependent").some((f) => f.url?.endsWith("/js-only")));
  assert.ok(byId("media.alt_missing").some((f) => f.url === origin + "/"));
});

test("hreflang self-reference is satisfied on services page (no false positive)", () => {
  assert.ok(!byId("i18n.hreflang_no_self").some((f) => f.url?.endsWith("/services/")));
});

test("every finding carries an evidence label and business impact", () => {
  for (const f of findings) {
    assert.ok(["FACT", "INFERENCE"].includes(f.label), `${f.id} label ${f.label}`);
    assert.ok(f.businessImpact.length > 10, `${f.id} lacks businessImpact`);
    assert.ok(f.evidence && typeof f.evidence === "object");
  }
});

test("dry-run report labels missing integrations NOT_CONNECTED and never invents metrics", () => {
  const report = buildReport(result, findings, [{ name: "Google Search Console", state: "NOT_CONNECTED", note: "x" }]);
  assert.equal(report.noProductionChange, true);
  assert.equal(report.mode, "dry-run");
  assert.ok(report.unknowns.some((u) => /Core Web Vitals/.test(u)));
  const md = reportToMarkdown(report);
  assert.match(md, /NOT_CONNECTED/);
  assert.match(md, /no production change/);
  assert.doesNotMatch(md, /impressions:\s*\d/i);
});

test("crawl target resolution is gated by the registry", async () => {
  // The remote runner passes --site, so the gate must live below the CLI surface.
  const { loadRegistry, onboardedSites } = await import("../src/registry.ts");
  const reg = loadRegistry(new URL("../config/sites.yaml", import.meta.url).pathname);
  assert.ok(reg.ok);
  const allowed = onboardedSites(reg.registry!).map((s) => s.id);
  assert.deepEqual(allowed, ["pamistanbul"]);
  for (const id of ["spryhand", "pamaistudio", "decideplan", "rightlisted", "untitledportraits", "myhappymade"]) {
    assert.ok(!allowed.includes(id), `${id} must not be crawlable`);
  }
});

test("an unreachable target is a failure, never an empty clean report", async () => {
  // A crawl of a dead port yields no usable record; the CLI turns that into exit 3.
  const { crawl } = await import("../src/crawler.ts");
  const res = await crawl({ startUrl: "http://127.0.0.1:1/", maxPages: 1, maxDepth: 0, delayMs: 0, timeoutMs: 2000 });
  const first = res.records[0];
  assert.ok(!first || first.page.status === 0 || first.page.status >= 400, "dead host must not look like a 200");
});

test("styled copy is not hidden text, and a title-shaped schema name is not a mismatch", () => {
  // Both of these fired as false positives against the real pamistanbul.com crawl:
  // `font-size:0` matched `font-size:0.95rem`, and the schema name carried a brand
  // suffix that never appears in body copy.
  const rec = result.records.find((r) => r.page.finalUrl.endsWith("/styled-copy"))!;
  assert.ok(rec, "fixture page was not crawled");
  assert.deepEqual(rec.html!.hiddenTextSuspects, [], "ordinary small type must not read as hidden text");
  assert.ok(!byId("content.hidden_text_suspect").some((f) => f.url?.endsWith("/styled-copy")));
  assert.ok(!byId("schema.not_in_visible_content").some((f) => f.url?.endsWith("/styled-copy")),
    "schema subject 'Alpet' is on the page, so this must not be flagged");
  // The genuine mismatch must still be caught.
  assert.ok(byId("schema.not_in_visible_content").some((f) => f.url?.endsWith("/schema-mismatch")));
  assert.ok(byId("content.hidden_text_suspect").some((f) => f.url?.endsWith("/hidden")));
});

test("full mode accounts for every sitemap URL, and only then is it a FULL_BASELINE", async () => {
  const full = await crawl({ startUrl: origin + "/", fromSitemap: true, maxPages: 60, maxDepth: 2, delayMs: 0, timeoutMs: 5000 });
  const c = full.coverage!;
  assert.equal(c.mode, "full");
  assert.equal(c.sitemapTotal, full.sitemapEntries.length);
  // Every sitemap URL is either attempted or carries an explicit reason. Nothing vanishes.
  assert.equal(c.attempted + c.notAttempted.length, c.sitemapTotal);
  for (const n of c.notAttempted) assert.ok(n.reason.length > 5, `no reason for ${n.url}`);
  // The orphan is only in the sitemap, so full mode must reach it where sample mode did not.
  assert.ok(full.records.some((r) => r.page.url.endsWith("/orphan")), "full mode missed the orphan page");
  const rep = buildReport(full, runAudit(full), []);
  assert.equal(rep.baseline.kind, c.complete ? "FULL_BASELINE" : "PARTIAL_BASELINE_SAMPLE");
  assert.equal(rep.baseline.coverage!.sitemapTotal, c.sitemapTotal);
});

test("a sample crawl is never labelled a full baseline", () => {
  const rep = buildReport(result, findings, []);
  assert.equal(rep.baseline.kind, "PARTIAL_BASELINE_SAMPLE");
  assert.match(reportToMarkdown(rep), /PARTIAL_BASELINE_SAMPLE/);
});

test("full mode truncated by the page cap reports incomplete coverage, not success", async () => {
  const tiny = await crawl({ startUrl: origin + "/", fromSitemap: true, maxPages: 2, maxDepth: 0, delayMs: 0, timeoutMs: 5000 });
  const c = tiny.coverage!;
  assert.equal(c.complete, false);
  assert.ok(c.notAttempted.length > 0);
  assert.ok(c.notAttempted.some((n) => /page cap/.test(n.reason)), JSON.stringify(c.notAttempted.slice(0, 3)));
  assert.equal(buildReport(tiny, [], []).baseline.kind, "PARTIAL_BASELINE_SAMPLE");
});

test("every finding carries a confidence, and heuristics never ship as CONFIRMED", () => {
  for (const f of findings) {
    assert.ok(["CONFIRMED", "CANDIDATE", "FALSE_POSITIVE", "UNKNOWN"].includes(f.confidence), `${f.id}: ${f.confidence}`);
    if (f.label === "INFERENCE") assert.equal(f.confidence, "CANDIDATE", `${f.id} inferred but marked ${f.confidence}`);
    if (f.label === "FACT") assert.equal(f.confidence, "CONFIRMED", `${f.id}`);
  }
  // A measured 500 is confirmed; an inferred accidental noindex is a candidate.
  assert.equal(byId("http.error")[0].confidence, "CONFIRMED");
  assert.equal(byId("indexability.noindex").find((f) => f.url?.endsWith("/noindexed"))!.confidence, "CANDIDATE");
});
