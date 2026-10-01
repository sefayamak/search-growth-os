// Canonical iliskileri: dil bagimsiz ve URL-alani tabanli. Iki GERCEK canli ornek fixture;
// geri kalani "ne YAPILMAMALI": metne bakmak, URL'leri tahminle birlestirmek, eksik alani
// SAME/DIFFERENT saymak, bir farki hata diye etiketlemek.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { classifyCanonicalRelations } from "../src/canonical-relations.ts";
import { classifyInspection } from "../src/index-probe.ts";
import { runProbe, probeToMarkdown, summarizeSitemaps } from "../src/index-probe.ts";

const FIX = JSON.parse(readFileSync(new URL("./fixtures/index-probe/canonical-live-2026-10-01.json", import.meta.url), "utf8"));
const SITE = { id: "pamistanbul", production_domain: "pamistanbul.com" };

function rels(inspected: string, g?: string, u?: string) { return classifyCanonicalRelations(inspected, g ?? "UNKNOWN", u ?? "UNKNOWN"); }

// --- iki GERCEK canli fixture --------------------------------------------------

for (const c of FIX.cases) {
  test(`GERCEK fixture ${c.name.split(":")[0]}: beklenen iliskiler ve review_required`, () => {
    const s = classifyInspection(c.inspectionResult);
    const r = classifyCanonicalRelations(c.inspected, s.google_canonical, s.user_canonical);
    for (const [k, v] of Object.entries(c.expected)) assert.equal((r as unknown as Record<string, unknown>)[k], v, k);
    assert.equal(r.review_status, "REVIEW_REQUIRED");
    assert.ok(r.reasons.includes("USER_CANONICAL_DIFFERS_FROM_GOOGLE"));
    assert.ok(r.reasons.includes("USER_CANONICAL_CROSS_DOMAIN"));
    assert.ok(!r.reasons.includes("GOOGLE_CANONICAL_DIFFERS_FROM_INSPECTED"), "Google denetlenen URL'yi canonical sectigi icin bu tetikleyici yok");
  });
}

test("B: www ile apex AYNI host sayilmaz (user_cross_domain true); A: baska domain da true", () => {
  const [a, b] = FIX.cases;
  const sa = classifyInspection(a.inspectionResult), sb = classifyInspection(b.inspectionResult);
  assert.equal(classifyCanonicalRelations(a.inspected, sa.google_canonical, sa.user_canonical).user_cross_domain, true);
  assert.equal(classifyCanonicalRelations(b.inspected, sb.google_canonical, sb.user_canonical).user_cross_domain, true);
  assert.equal(new URL(b.inspected).hostname, "www.pamistanbul.com");
});

// --- normal ornek (SENTETIK) ----------------------------------------------------

test("normal (sentetik): denetlenen == user == google -> hepsi SAME, cross_domain false, review gerekmez", () => {
  const u = "https://pamistanbul.com/en/works";
  const r = rels(u, u, u);
  assert.deepEqual(r, { inspected_vs_google: "SAME", user_vs_google: "SAME", user_vs_inspected: "SAME", user_cross_domain: false, google_cross_domain: false, review_required: false, review_status: "NO_DIVERGENCE_OBSERVED", reasons: [] });
});

// --- eksik alan = UNKNOWN, tahmin yok -----------------------------------------------

test("eksik user canonical: user iliskileri UNKNOWN; denetlenen == google ise tetikleyici yok ama 'SAME' denmez", () => {
  const u = "https://pamistanbul.com/a";
  const r = rels(u, u);
  assert.equal(r.user_vs_google, "UNKNOWN");
  assert.equal(r.user_vs_inspected, "UNKNOWN");
  assert.equal(r.user_cross_domain, "UNKNOWN");
  assert.equal(r.inspected_vs_google, "SAME");
  assert.equal(r.review_required, false);
  assert.equal(r.review_status, "NO_DIVERGENCE_OBSERVED");
});

test("eksik Google canonical: temel iliski UNKNOWN; baska tetikleyici yoksa status UNKNOWN (sorun yok DENMEZ)", () => {
  const r = rels("https://pamistanbul.com/a", undefined, "https://pamistanbul.com/a");
  assert.equal(r.inspected_vs_google, "UNKNOWN");
  assert.equal(r.user_vs_google, "UNKNOWN");
  assert.equal(r.google_cross_domain, "UNKNOWN");
  assert.equal(r.review_status, "UNKNOWN");
  assert.equal(r.review_required, false);
});

test("Google canonical eksik ama user canonical baska domain: tetikleyici GOZLENDI -> REVIEW_REQUIRED", () => {
  const r = rels("https://pamistanbul.com/a", undefined, "https://pamaistudio.com/a");
  assert.equal(r.review_status, "REVIEW_REQUIRED");
  assert.deepEqual(r.reasons, ["USER_CANONICAL_CROSS_DOMAIN"]);
});

test("hepsi eksik / gecersiz string / bos -> hepsi UNKNOWN, hicbiri SAME ya da DIFFERENT degil", () => {
  for (const [g, u] of [["UNKNOWN", "UNKNOWN"], ["", ""], ["bu bir url degil", "::::"], [undefined, null], [42, {}]] as const) {
    const r = classifyCanonicalRelations("https://pamistanbul.com/a", g, u);
    assert.deepEqual([r.inspected_vs_google, r.user_vs_google, r.user_vs_inspected, r.user_cross_domain, r.google_cross_domain], ["UNKNOWN", "UNKNOWN", "UNKNOWN", "UNKNOWN", "UNKNOWN"]);
    assert.equal(r.review_status, "UNKNOWN");
  }
  assert.equal(classifyCanonicalRelations("gecersiz", "https://x.com/", "https://x.com/").inspected_vs_google, "UNKNOWN");
});

// --- kanitsiz birlestirme yok ---------------------------------------------------------

test("sondaki '/', scheme, query ve path buyuk/kucuk harf FARK sayilir; fragment ve host harfi sayilmaz", () => {
  const base = "https://pamistanbul.com/a";
  assert.equal(rels(base, base + "/", base).inspected_vs_google, "DIFFERENT", "/a != /a/");
  assert.equal(rels(base, "http://pamistanbul.com/a", base).inspected_vs_google, "DIFFERENT", "http != https");
  assert.equal(rels(base, base + "?x=1", base).inspected_vs_google, "DIFFERENT", "query korunur");
  assert.equal(rels(base, "https://pamistanbul.com/A", base).inspected_vs_google, "DIFFERENT", "path harf duyarli");
  assert.equal(rels(base, base + "#bolum", base).inspected_vs_google, "SAME", "fragment atilir");
  assert.equal(rels(base, "https://PAMISTANBUL.com/a", base).inspected_vs_google, "SAME", "host kucuk harfe indirilir");
});

test("cross_domain tam hostname farkidir: alt alan adi ve www TRUE, ayni host (farkli scheme) FALSE", () => {
  const ins = "https://pamistanbul.com/a";
  assert.equal(rels(ins, ins, "https://www.pamistanbul.com/a").user_cross_domain, true);
  assert.equal(rels(ins, ins, "https://blog.pamistanbul.com/a").user_cross_domain, true);
  assert.equal(rels(ins, ins, "http://pamistanbul.com/a").user_cross_domain, false);
  assert.equal(rels(ins, "https://pamaistudio.com/a", ins).google_cross_domain, true);
});

test("sadece user canonical Google'dan farkli (cross-domain degil): REVIEW_REQUIRED, tek neden", () => {
  const ins = "https://pamistanbul.com/a";
  const r = rels(ins, ins, "https://pamistanbul.com/a/");
  assert.equal(r.review_status, "REVIEW_REQUIRED");
  assert.deepEqual(r.reasons, ["USER_CANONICAL_DIFFERS_FROM_GOOGLE"]);
  assert.equal(r.user_cross_domain, false);
});

test("Google canonical denetlenen URL'den farkli (Google baska URL'yi sectiyse): REVIEW_REQUIRED", () => {
  const r = rels("http://www.pamistanbul.com/", "https://pamistanbul.com/", "https://pamistanbul.com/");
  assert.equal(r.inspected_vs_google, "DIFFERENT");
  assert.equal(r.user_vs_google, "SAME");
  assert.equal(r.review_status, "REVIEW_REQUIRED");
  assert.ok(r.reasons.includes("GOOGLE_CANONICAL_DIFFERS_FROM_INSPECTED"));
  assert.ok(r.reasons.includes("GOOGLE_CANONICAL_CROSS_DOMAIN"), "www -> apex hostname farki");
});

// --- dil bagimsizlik: coverageState metni karari ETKILEMEZ ---------------------------------

test("coverageState metni (Turkce, Ingilizce, anlamsiz, bos) iliskileri DEGISTIRMEZ", () => {
  const [a] = FIX.cases;
  const outcomes = ["Gönderildi ve dizine eklendi", "Submitted and indexed", "Yönlendirmeli sayfa", "Redirected page", "???", ""].map((cov) => {
    const res = JSON.parse(JSON.stringify(a.inspectionResult));
    res.indexStatusResult.coverageState = cov;
    const s = classifyInspection(res);
    return JSON.stringify(classifyCanonicalRelations(a.inspected, s.google_canonical, s.user_canonical));
  });
  assert.equal(new Set(outcomes).size, 1);
});

test("modul kaynagi metin/kapsam alanina BAKMAZ: coverage/Yönlendirmeli/Submitted/verdict gecmez", () => {
  const src = readFileSync(new URL("../src/canonical-relations.ts", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  for (const bad of [/coverage/i, /Y[oö]nlendirmeli/i, /Submitted/i, /verdict/i, /includes\(\s*["'`]/]) assert.ok(!bad.test(src), `yasak desen: ${bad}`);
  assert.equal(classifyCanonicalRelations.length, 3, "yalnizca uc parametre");
});

// --- probe entegrasyonu ------------------------------------------------------------------

function probeWith(results: Record<string, Record<string, unknown>>, segmentOf?: Record<string, "SITEMAP_NOT_OBSERVED_IN_GSC_WINDOW" | "GSC_NOT_IN_SITEMAP" | "HOST_VARIANT_RISK" | "SITEMAP_AND_GSC">) {
  const urls = Object.keys(results);
  const segs = segmentOf ? urls.map((url) => ({ url, segment: segmentOf[url] })) : undefined;
  return runProbe({
    site: SITE, ...(segs ? { candidates: segs, segmentInfo: { day_index: 1, segments: {
      SITEMAP_NOT_OBSERVED_IN_GSC_WINDOW: { state: "COMPUTED", pool: 5, quota: 2 }, HOST_VARIANT_RISK: { state: "COMPUTED", pool: 5, quota: 2 },
      GSC_NOT_IN_SITEMAP: { state: "COMPUTED", pool: 5, quota: 2 }, SITEMAP_AND_GSC: { state: "COMPUTED", pool: 5, quota: 2 } } } } : { urls }),
    candidateSource: "t", limit: 10, delayMs: 0, connected: true, sleep: async () => {}, inspect: async (u) => results[u],
  });
}
const byUrl = Object.fromEntries(FIX.cases.map((c: { inspected: string; inspectionResult: Record<string, unknown> }) => [c.inspected, c.inspectionResult]));
const NORMAL = "https://pamistanbul.com/en/works";
const normalResult = { indexStatusResult: { verdict: "PASS", googleCanonical: NORMAL, userCanonical: NORMAL } };

test("runProbe: her sonuc canonical_relations tasir; sayim yalniz REVIEW_REQUIRED'lari sayar; verdict ve state degismez", async () => {
  const r = await probeWith({ ...byUrl, [NORMAL]: normalResult });
  assert.equal(r.results.length, 3);
  assert.ok(r.results.every((x) => x.canonical_relations));
  assert.equal(r.canonical_candidate_count, 2);
  assert.ok(r.results.every((x) => x.summary.state === "INSPECTED" && x.summary.index_verdict === "INDEXED"), "ERROR/NOT_INDEXED degil");
  assert.equal(r.results.find((x) => x.url === NORMAL)!.canonical_relations!.review_required, false);
});

test("segment raporunda canonical_candidate_count segment basina; markdown 'Canonical candidates' yalniz dikkat gerektirenleri listeler", async () => {
  const urls = Object.keys(byUrl);
  const r = await probeWith({ ...byUrl, [NORMAL]: normalResult }, { [urls[0]]: "GSC_NOT_IN_SITEMAP", [urls[1]]: "HOST_VARIANT_RISK", [NORMAL]: "SITEMAP_AND_GSC" });
  const seg = (n: string) => r.segments!.find((s) => s.segment === n)!;
  assert.equal(seg("GSC_NOT_IN_SITEMAP").canonical_candidate_count, 1);
  assert.equal(seg("HOST_VARIANT_RISK").canonical_candidate_count, 1);
  assert.equal(seg("SITEMAP_AND_GSC").canonical_candidate_count, 0);
  const md = probeToMarkdown(r, summarizeSitemaps(null), "2026-10-01");
  assert.match(md, /\| canonical adayı \|/);
  const section = md.split("## Canonical candidates")[1].split("## Sitemap")[0];
  assert.match(section, /CANDIDATE \/ REVIEW_REQUIRED/);
  assert.match(section, /hata değildir/);
  assert.ok(section.includes("bath-loofah-lifestyle") && section.includes("ucretsiz-ai-gorsel-uretme-araclari-2026.html"));
  assert.ok(!section.includes(NORMAL), "normal URL listelenmez");
  assert.ok(!/\bERROR\b/.test(section) && !/SEO hatası\b(?! olarak etiketlenmez)/.test(section));
  assert.match(section, /user cross-domain/);
});

test("dikkat gerektiren yoksa 'Canonical candidates' bolumu hic yazilmaz (Phase 1 cikti bicimi korunur)", async () => {
  const r = await probeWith({ [NORMAL]: normalResult });
  assert.equal(r.canonical_candidate_count, 0);
  assert.ok(!probeToMarkdown(r, summarizeSitemaps(null), "2026-10-01").includes("Canonical candidates"));
});

test("gsc stratejisi da (segmentsiz) canonical_relations alir; ERROR sonuc UNKNOWN iliski uretir", async () => {
  const r = await probeWith({ ...byUrl });
  assert.equal(r.strategy, "gsc");
  assert.equal(r.canonical_candidate_count, 2);
  const err = await runProbe({ site: SITE, urls: [NORMAL], candidateSource: "t", limit: 5, delayMs: 0, connected: true, sleep: async () => {}, inspect: async () => { throw new Error("HTTP 500 x"); } });
  assert.equal(err.results[0].canonical_relations!.review_status, "UNKNOWN");
  assert.equal(err.canonical_candidate_count, 0);
});
