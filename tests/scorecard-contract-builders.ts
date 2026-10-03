// Producer-sekilli fixture'lari URETICILERIN GERCEK, export edilmis kurucularindan uretir.
//
// NEDEN: scorecard'in okuma sozlesmesi uretici sema'larindan alinir (uretici = kanonik). Ama uretici
// modulleri (#32 deployment-timeline, #34 index-alarms, #36 performance) main'de degil. Bu yuzden
// iki katman var:
//   1) tests/fixtures/scorecard-contracts/*.json: bu dosyanin ciktisi, repoya girer (modul yokken de testler kosar);
//   2) uretici modul MEVCUTSA tests/scorecard-contract.test.ts bu dosyayi tekrar kosar ve sonucu fixture ile
//      birebir karsilastirir: uretici alan adini/sekli degistirirse fixture eskir ve test kirilir (drift alarmi).
// Ag yok, saat sabit (parametre), rastgelelik yok: cikti deterministiktir.
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const SITE = "pamistanbul";
export const GEN_NOW = "2026-10-02T09:00:00.000Z";

export interface ProducerModules { perf: any; index: any; deploy: any; measure: any }
export interface ContractFixtures {
  performanceHistory: unknown; performanceReport: unknown; indexHistory: unknown; indexReport: unknown; deploymentTimeline: unknown; measureReport: unknown;
}

export const FIXTURE_FILES: Record<keyof ContractFixtures, string> = {
  performanceHistory: "performance-history.pamistanbul.json",
  performanceReport: "performance-report.json",
  indexHistory: "index-history.pamistanbul.json",
  indexReport: "index-report.pamistanbul.json",
  deploymentTimeline: "deployment-timeline.pamistanbul.json",
  measureReport: "measure-report.pamistanbul.json",
};

const psiField = (lcp: number, inp: number, clsPct: number) => ({
  loadingExperience: { origin_fallback: false, metrics: {
    LARGEST_CONTENTFUL_PAINT_MS: { percentile: lcp }, INTERACTION_TO_NEXT_PAINT: { percentile: inp },
    CUMULATIVE_LAYOUT_SHIFT_SCORE: { percentile: clsPct }, EXPERIMENTAL_TIME_TO_FIRST_BYTE: { percentile: 600 } } },
  lighthouseResult: { categories: { performance: { score: 0.8 } }, audits: {} },
});
const psiLab = (lcp: number, cls: number) => ({
  lighthouseResult: { categories: { performance: { score: 0.6 } },
    audits: { "largest-contentful-paint": { numericValue: lcp }, "cumulative-layout-shift": { numericValue: cls }, "server-response-time": { numericValue: 400 } } },
});

export async function buildPerformance(perf: any): Promise<{ history: unknown; report: unknown }> {
  const dir = mkdtempSync(join(tmpdir(), "sgos-perf-"));
  const site = { id: SITE, canonical_hostname: "www.pamistanbul.com", production_domain: "pamistanbul.com", onboarding_status: "pilot_onboarding" };
  // 1. gun: temiz taban (baz). 2. gun: LCP bozulur + ayni gun lab/desktop (field varken lab ignore edilmeli).
  const fetchBase = async () => ({ status: 200, body: psiField(2000, 180, 5) });
  await perf.runPerformance({ sites: [site], fetcher: fetchBase, now: new Date("2026-09-24T06:00:00.000Z"), historyDir: dir, strategies: ["mobile"], urlsPerSite: 1 });
  const fetchNow = async (req: { strategy: string }) => ({ status: 200, body: req.strategy === "mobile" ? psiField(2900, 180, 5) : psiLab(3300, 0.02) });
  const report = await perf.runPerformance({ sites: [site], fetcher: fetchNow, now: new Date("2026-10-01T06:00:00.000Z"), historyDir: dir, strategies: ["mobile", "desktop"], urlsPerSite: 1 });
  return { history: JSON.parse(readFileSync(join(dir, `${SITE}.json`), "utf8")), report };
}

export function buildIndex(index: any): { history: unknown; report: unknown } {
  const root = mkdtempSync(join(tmpdir(), "sgos-idx-"));
  mkdirSync(join(root, "index-history"), { recursive: true });
  const e = (url: string, o: Record<string, unknown> = {}) => ({ url, state: "INSPECTED", verdict: "INDEXED", in_sitemap: true, fetch_ok: true, canonical_self: true, indexable: true, ...o });
  let h = index.emptyHistory(SITE);
  const snap = (taken_at: string, entries: unknown[]) => ({ taken_at, site: SITE, sample_size: (entries as { state: string }[]).filter((x) => x.state === "INSPECTED").length, universe_size: "UNKNOWN", stopped: null, entries });
  h = index.appendSnapshot(h, snap("2026-09-30T06:00:00.000Z", [e("https://www.pamistanbul.com/a", { verdict: "NOT_INDEXED" }), e("https://www.pamistanbul.com/b"), e("https://www.pamistanbul.com/c", { verdict: "NEUTRAL", canonical_self: false })]));
  h = index.appendSnapshot(h, snap("2026-10-01T07:00:00.000Z", [e("https://www.pamistanbul.com/a", { verdict: "NOT_INDEXED" }), e("https://www.pamistanbul.com/b"), e("https://www.pamistanbul.com/c", { verdict: "NEUTRAL", canonical_self: false }), e("https://www.pamistanbul.com/d", { state: "ERROR", verdict: "UNKNOWN", in_sitemap: "UNKNOWN", fetch_ok: "UNKNOWN", canonical_self: "UNKNOWN", indexable: "UNKNOWN" })]));
  index.saveHistory(h, root);
  const history = JSON.parse(readFileSync(index.historyPath(SITE, root), "utf8"));
  return { history, report: index.buildReport(h, index.emptyBacklog(SITE), GEN_NOW) };
}

export async function buildDeployment(d: any): Promise<unknown> {
  const sha = (c: string) => c.repeat(40);
  const gh = [
    { id: 101, sha: sha("a"), environment: "production", created_at: "2026-09-29T10:00:00Z" },
    { id: 102, sha: sha("b"), environment: "Preview", created_at: "2026-09-30T10:00:00Z" },
    { id: 103, sha: sha("c"), environment: "production", created_at: "2026-08-15T10:00:00Z" },
  ];
  const parsed = d.parseGithubDeployments(gh, SITE, "2026-10-01T06:00:00Z");
  let t = d.emptyTimeline(SITE);
  for (const ev of parsed.events) {
    // Yalniz ilk uretim deploy'u canli dogrulanir; digerleri saglayici beyanida (UNVERIFIED) kalir.
    const out = ev.commit_sha === sha("a") ? await d.verifyDeployment(ev, async () => ({ reachable: true, live_sha: sha("a") }), new Date("2026-10-01T06:30:00Z")) : ev;
    t = d.appendEvent(t, out).timeline;
  }
  return JSON.parse(JSON.stringify(d.parseTimeline(t)));
}

/** #41 buildMeasureReport'u sahte GSC satirlariyla kosar (ag yok). Marka satiri, sira<5 satiri ve dusuk-gosterimli satir aday DEGIL;
 *  boylece fixture eleme kurallarini ve sayiyi (2) birlikte tasir. */
export function buildMeasure(m: any): unknown {
  const row = (query: string, clicks: number, impressions: number, position: number) => ({ query, clicks, impressions, ctr: clicks / impressions, position });
  const current = [
    row("pamistanbul", 40, 400, 1.2), row("organik pamuk havlu", 3, 300, 8.5), row("pamuklu bornoz fiyat", 1, 120, 14),
    row("havlu modelleri", 30, 500, 3), row("pamuk pestemal", 0, 15, 9),
  ];
  const total = (rows: { clicks: number; impressions: number }[]) => {
    const clicks = rows.reduce((a, r) => a + r.clicks, 0), impressions = rows.reduce((a, r) => a + r.impressions, 0);
    return [{ clicks, impressions, ctr: clicks / impressions, position: 6 }];
  };
  const yearAgo = [row("pamistanbul", 30, 300, 1.3), row("organik pamuk havlu", 1, 100, 12)];
  const report = m.buildMeasureReport([{
    siteId: SITE, gscProperty: "sc-domain:pamistanbul.com", ga4Property: "NOT_CONNECTED", patterns: ["pamistanbul", "pam istanbul"],
    outcome: { kind: "ok", current, yearAgo, currentTotal: total(current), yearAgoTotal: total(yearAgo) },
    ga4Outcome: { kind: "not_connected", reason: "GA4 kimligi yok" },
  }], {
    now: new Date(GEN_NOW), current: { label: "son 28 gun", start: "2026-09-04", end: "2026-10-01" }, yearAgo: { label: "gecen yil", start: "2025-09-05", end: "2025-10-02" },
    toolVersion: "0.1.0", commit: null, registryPath: null,
  });
  return JSON.parse(JSON.stringify(report));
}

export async function buildContractFixtures(m: ProducerModules): Promise<ContractFixtures> {
  const p = await buildPerformance(m.perf);
  const i = buildIndex(m.index);
  return { performanceHistory: p.history, performanceReport: JSON.parse(JSON.stringify(p.report)), indexHistory: i.history, indexReport: JSON.parse(JSON.stringify(i.report)), deploymentTimeline: await buildDeployment(m.deploy), measureReport: buildMeasure(m.measure) };
}
