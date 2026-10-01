// Canonical iliskileri: dil bagimsiz ve URL-alani tabanli. Iki GERCEK canli ornek fixture;
// geri kalani "ne YAPILMAMALI": metne bakmak, URL'leri tahminle birlestirmek, eksik alani
// SAME/DIFFERENT saymak, bir farki hata diye etiketlemek.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { classifyCanonicalRelations, derivePattern } from "../src/canonical-relations.ts";
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
  assert.deepEqual(r, { inspected_vs_google: "SAME", user_vs_google: "SAME", user_vs_inspected: "SAME", user_cross_domain: false, google_cross_domain: false, review_required: false, review_status: "NO_DIVERGENCE_OBSERVED", reasons: [], canonical_pattern: "INSPECTED_USER_GOOGLE_ALIGNED" });
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
  assert.match(section, /hata değildir/i);
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

// ============================================================================
// canonical_pattern (Phase 1.5b ikinci dilim): conflict ile convergence ayri olgulardir
// ============================================================================

const ALL4: { inspected: string; inspectionResult: Record<string, unknown>; expected: Record<string, unknown> }[] = [...FIX.cases, ...FIX.convergence_cases];

test("DORT canli fixture: A, B = DECLARED_GOOGLE_CONFLICT; C, D = GOOGLE_USER_CONVERGE_ON_OTHER_URL", () => {
  assert.equal(ALL4.length, 4);
  const got = ALL4.map((c) => {
    const s = classifyInspection(c.inspectionResult);
    return classifyCanonicalRelations(c.inspected, s.google_canonical, s.user_canonical).canonical_pattern;
  });
  assert.deepEqual(got, ["DECLARED_GOOGLE_CONFLICT", "DECLARED_GOOGLE_CONFLICT", "GOOGLE_USER_CONVERGE_ON_OTHER_URL", "GOOGLE_USER_CONVERGE_ON_OTHER_URL"]);
});

for (const c of FIX.convergence_cases) {
  test(`GERCEK fixture ${c.name.split(":")[0]}: mevcut FACT iliskileri DEGISMEDI + pattern convergence`, () => {
    const s = classifyInspection(c.inspectionResult);
    const r = classifyCanonicalRelations(c.inspected, s.google_canonical, s.user_canonical);
    for (const [k, v] of Object.entries(c.expected)) assert.equal((r as unknown as Record<string, unknown>)[k], v, k);
    assert.equal(r.review_status, "REVIEW_REQUIRED", "review_required anlami korundu (canlida dogrulanmis davranis)");
    assert.deepEqual(r.reasons, ["GOOGLE_CANONICAL_DIFFERS_FROM_INSPECTED", "USER_CANONICAL_CROSS_DOMAIN", "GOOGLE_CANONICAL_CROSS_DOMAIN"]);
  });
}

test("A ve B icin mevcut iliskiler ve review_required AYNEN (pattern eklemesi onlari degistirmedi)", () => {
  for (const c of FIX.cases) {
    const s = classifyInspection(c.inspectionResult);
    const r = classifyCanonicalRelations(c.inspected, s.google_canonical, s.user_canonical);
    assert.equal(r.review_status, "REVIEW_REQUIRED");
    assert.deepEqual(r.reasons, ["USER_CANONICAL_DIFFERS_FROM_GOOGLE", "USER_CANONICAL_CROSS_DOMAIN"]);
  }
});

test("derivePattern: dort desen, celiski onceliklidir, eksik alan INCOMPLETE", () => {
  assert.equal(derivePattern("SAME", "DIFFERENT"), "DECLARED_GOOGLE_CONFLICT");
  assert.equal(derivePattern("DIFFERENT", "DIFFERENT"), "DECLARED_GOOGLE_CONFLICT", "iki fark birlikteyse celiski");
  assert.equal(derivePattern("UNKNOWN", "DIFFERENT"), "DECLARED_GOOGLE_CONFLICT", "user vs google bilindigi surece denetlenen URL gerekmez");
  assert.equal(derivePattern("DIFFERENT", "SAME"), "GOOGLE_USER_CONVERGE_ON_OTHER_URL");
  assert.equal(derivePattern("SAME", "SAME"), "INSPECTED_USER_GOOGLE_ALIGNED");
  for (const [a, b] of [["UNKNOWN", "UNKNOWN"], ["SAME", "UNKNOWN"], ["DIFFERENT", "UNKNOWN"], ["UNKNOWN", "SAME"]] as const) assert.equal(derivePattern(a, b), "INCOMPLETE", `${a}/${b}`);
});

test("normal (sentetik) INSPECTED_USER_GOOGLE_ALIGNED; eksik canonical INCOMPLETE (tahmin yok)", () => {
  const u = "https://pamistanbul.com/en/works";
  assert.equal(rels(u, u, u).canonical_pattern, "INSPECTED_USER_GOOGLE_ALIGNED");
  assert.equal(rels(u, u).canonical_pattern, "INCOMPLETE", "user canonical yok");
  assert.equal(rels(u, undefined, u).canonical_pattern, "INCOMPLETE", "Google canonical yok");
  assert.equal(rels(u).canonical_pattern, "INCOMPLETE");
  assert.equal(rels(u, "https://pamistanbul.com/baska", undefined).canonical_pattern, "INCOMPLETE", "user yok: convergence/conflict denemez");
});

test("hostname / cross-domain kararin YERINE GECMEZ: ayni desen farkli host iliskileriyle", () => {
  // Her ikisinde Google ve user ayni hedefte, denetlenen farkli -> convergence; hostname iliskisi degisse de desen ayni.
  const sameHost = rels("https://pamistanbul.com/a", "https://pamistanbul.com/a/", "https://pamistanbul.com/a/");
  const crossHost = rels("https://pamistanbul.com/a", "https://pamaistudio.com/a", "https://pamaistudio.com/a");
  assert.equal(sameHost.canonical_pattern, "GOOGLE_USER_CONVERGE_ON_OTHER_URL");
  assert.equal(crossHost.canonical_pattern, "GOOGLE_USER_CONVERGE_ON_OTHER_URL");
  assert.equal(sameHost.user_cross_domain, false);
  assert.equal(crossHost.user_cross_domain, true, "FACT alanlari etkilenmedi");
  // Cross-domain olmayan ama celiskili vaka yine celiski.
  assert.equal(rels("https://pamistanbul.com/a", "https://pamistanbul.com/a", "https://pamistanbul.com/a/").canonical_pattern, "DECLARED_GOOGLE_CONFLICT");
});

test("www ile apex hala FARKLI hostname (user_cross_domain / google_cross_domain davranisi bozulmadi)", () => {
  const r = rels("http://www.pamistanbul.com/", "https://pamistanbul.com/", "https://pamistanbul.com/");
  assert.equal(r.user_cross_domain, true);
  assert.equal(r.google_cross_domain, true);
});

test("pattern coverageState metnine bagli degil", () => {
  const c = FIX.convergence_cases[0];
  const outs = ["Yönlendirmeli sayfa", "Redirected page", "Gönderildi ve dizine eklendi", "???", ""].map((cov) => {
    const res = JSON.parse(JSON.stringify(c.inspectionResult)); res.indexStatusResult.coverageState = cov;
    const s = classifyInspection(res);
    return classifyCanonicalRelations(c.inspected, s.google_canonical, s.user_canonical).canonical_pattern;
  });
  assert.deepEqual([...new Set(outs)], ["GOOGLE_USER_CONVERGE_ON_OTHER_URL"]);
  const src = readFileSync(new URL("../src/canonical-relations.ts", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.ok(!/coverage/i.test(src) && !/Y[oö]nlendirmeli/i.test(src));
});

// --- runProbe / rapor ---------------------------------------------------------------------

const byUrl4 = Object.fromEntries(ALL4.map((c) => [c.inspected, c.inspectionResult]));

test("runProbe: 4 canli vaka + normal -> candidate 4, conflict 2, convergence 2; verdict'ler degismez", async () => {
  const r = await probeWith({ ...byUrl4, [NORMAL]: normalResult });
  assert.equal(r.canonical_candidate_count, 4, "geriye uyumluluk: review_required sayisi");
  assert.equal(r.canonical_conflict_count, 2);
  assert.equal(r.canonical_convergence_count, 2);
  const v = (u: string) => r.results.find((x) => x.url === u)!.summary;
  assert.equal(v("http://www.pamistanbul.com/").index_verdict, "NEUTRAL");
  assert.equal(v("https://pamistanbul.com/en/video/bath-loofah-lifestyle").index_verdict, "INDEXED");
  assert.ok(r.results.every((x) => x.summary.state === "INSPECTED"));
  assert.equal(r.results.find((x) => x.url === NORMAL)!.canonical_relations!.canonical_pattern, "INSPECTED_USER_GOOGLE_ALIGNED");
});

test("segment satiri conflict ve convergence ayri sayar; markdown iki alt grup + tablo sutunlari", async () => {
  const urls = ALL4.map((c) => c.inspected);
  const r = await probeWith({ ...byUrl4, [NORMAL]: normalResult }, {
    [urls[0]]: "GSC_NOT_IN_SITEMAP", [urls[1]]: "HOST_VARIANT_RISK", [urls[2]]: "HOST_VARIANT_RISK", [urls[3]]: "HOST_VARIANT_RISK", [NORMAL]: "SITEMAP_AND_GSC" });
  const seg = (n: string) => r.segments!.find((s) => s.segment === n)!;
  assert.deepEqual([seg("HOST_VARIANT_RISK").canonical_candidate_count, seg("HOST_VARIANT_RISK").canonical_conflict_count, seg("HOST_VARIANT_RISK").canonical_convergence_count], [3, 1, 2]);
  assert.deepEqual([seg("GSC_NOT_IN_SITEMAP").canonical_candidate_count, seg("GSC_NOT_IN_SITEMAP").canonical_conflict_count, seg("GSC_NOT_IN_SITEMAP").canonical_convergence_count], [1, 1, 0]);
  assert.deepEqual([seg("SITEMAP_AND_GSC").canonical_candidate_count, seg("SITEMAP_AND_GSC").canonical_conflict_count], [0, 0]);
  const md = probeToMarkdown(r, summarizeSitemaps(null), "2026-10-01");
  assert.match(md, /\| canonical adayı \| conflict \| convergence \|/);
  const section = md.split("## Canonical candidates")[1].split("## Sitemap")[0];
  const conflict = section.split("### Google/user convergence")[0];
  const converge = section.split("### Google/user convergence on another URL")[1];
  assert.match(conflict, /### Declared vs Google conflicts \(2\)/);
  assert.match(converge, /^ \(2\)/);
  assert.ok(conflict.includes("bath-loofah-lifestyle") && conflict.includes("ucretsiz-ai-gorsel-uretme-araclari-2026.html"));
  assert.ok(!conflict.includes("flux-ai-image-model-guide-2026") && !conflict.includes("http://www.pamistanbul.com/"));
  assert.ok(converge.includes("flux-ai-image-model-guide-2026") && converge.includes("http://www.pamistanbul.com/"));
  assert.ok(!converge.includes("bath-loofah-lifestyle") && !converge.includes("ucretsiz-ai-gorsel"));
});

test("convergence bolumu istenen metni yazar; ERROR / SEO hatasi / fix onerisi yok; conflict bolumu CANDIDATE / REVIEW_REQUIRED der", async () => {
  const r = await probeWith({ ...byUrl4 });
  const md = probeToMarkdown(r, summarizeSitemaps(null), "2026-10-01");
  const converge = md.split("### Google/user convergence on another URL")[1].split("## Sitemap")[0];
  for (const phrase of [
    "Google canonical ile bildirilen canonical aynı hedefte uzlaşıyor",
    "Bu `canonical_pattern`, declared-vs-Google conflict DEĞİLDİR.",
    "Mevcut `review_required` alanı geriye uyumluluk amacıyla `true` kalabilir",
    "bu flag'in varlığı bu pattern'i SEO hatası veya canonical conflict yapmaz",
    "Doğru HTTP redirect/canonical uygulaması henüz fetch ile doğrulanmamıştır.",
  ]) assert.ok(converge.includes(phrase), phrase);
  assert.match(converge, /INFO \/ OBSERVED_CONVERGENCE/);
  assert.ok(!/CANDIDATE \/ REVIEW_REQUIRED/.test(converge), "convergence aday/inceleme olarak etiketlenmez");
  const section = md.split("## Canonical candidates")[1].split("## Sitemap")[0];
  assert.ok(!/\bERROR\b/.test(section) && !/önerilir|düzelt(in|elim)|fix\b|should/i.test(section.replace("düzeltme önerisi içermez", "")));
  assert.match(md.split("### Declared vs Google conflicts")[1].split("### Google/user")[0], /CANDIDATE \/ REVIEW_REQUIRED/);
});

test("yalniz convergence varsa conflict alt grubu 'Yok.' yazar; aday yoksa bolum hic yazilmaz", async () => {
  const [, , c, d] = ALL4;
  const r = await probeWith({ [c.inspected]: c.inspectionResult, [d.inspected]: d.inspectionResult });
  assert.equal(r.canonical_conflict_count, 0);
  assert.equal(r.canonical_convergence_count, 2);
  assert.match(probeToMarkdown(r, summarizeSitemaps(null), "2026-10-01").split("### Declared vs Google conflicts (0)")[1].split("###")[0], /Yok\./);
  assert.ok(!probeToMarkdown(await probeWith({ [NORMAL]: normalResult }), summarizeSitemaps(null), "2026-10-01").includes("Canonical candidates"));
});

test("review_required olup deseni INCOMPLETE olan satir kaybolmaz: 'Incomplete canonical data' alt grubunda gorunur ve sayimla tutarlidir", async () => {
  const U = "https://pamistanbul.com/x";
  const r = await probeWith({ [U]: { indexStatusResult: { verdict: "PASS", googleCanonical: "https://pamistanbul.com/y" } } });
  assert.equal(r.canonical_candidate_count, 1);
  assert.equal(r.canonical_conflict_count, 0);
  assert.equal(r.canonical_convergence_count, 0);
  const md = probeToMarkdown(r, summarizeSitemaps(null), "2026-10-01");
  assert.match(md, /### Incomplete canonical data \(1\)/);
  assert.ok(md.split("### Incomplete canonical data")[1].includes(U));
});

// ============================================================================
// Ad netlestirme: canonical_pattern icinde NO_DIVERGENCE_OBSERVED YOK (review_status ile cakisiyordu)
// ============================================================================

test("canonical_pattern enum: tam dort deger; 'NO_DIVERGENCE_OBSERVED' artik pattern degeri degil", () => {
  const rels3 = ["SAME", "DIFFERENT", "UNKNOWN"] as const;
  const seen = new Set<string>();
  for (const a of rels3) for (const b of rels3) seen.add(derivePattern(a, b));
  assert.deepEqual([...seen].sort(), ["DECLARED_GOOGLE_CONFLICT", "GOOGLE_USER_CONVERGE_ON_OTHER_URL", "INCOMPLETE", "INSPECTED_USER_GOOGLE_ALIGNED"]);
  const src = readFileSync(new URL("../src/canonical-relations.ts", import.meta.url), "utf8");
  const typeBlock = /export type CanonicalPattern =([\s\S]*?);/.exec(src)![1];
  assert.ok(!typeBlock.includes("NO_DIVERGENCE_OBSERVED"));
  assert.deepEqual([...typeBlock.matchAll(/"([A-Z_]+)"/g)].map((m) => m[1]), ["DECLARED_GOOGLE_CONFLICT", "GOOGLE_USER_CONVERGE_ON_OTHER_URL", "INSPECTED_USER_GOOGLE_ALIGNED", "INCOMPLETE"]);
});

test("A) inspected == user == google: pattern INSPECTED_USER_GOOGLE_ALIGNED; review_status NO_DIVERGENCE_OBSERVED (degismedi)", () => {
  const u = "https://pamistanbul.com/en/works";
  const r = rels(u, u, u);
  assert.equal(r.canonical_pattern, "INSPECTED_USER_GOOGLE_ALIGNED");
  assert.equal(r.review_status, "NO_DIVERGENCE_OBSERVED");
  assert.equal(r.review_required, false);
});

test("B) user canonical eksik: pattern INCOMPLETE, review_status mevcut davranisi korur (NO_DIVERGENCE_OBSERVED)", () => {
  const u = "https://pamistanbul.com/a";
  const r = rels(u, u);
  assert.equal(r.canonical_pattern, "INCOMPLETE");
  assert.equal(r.review_status, "NO_DIVERGENCE_OBSERVED", "geriye uyumluluk: ayni deger artik YALNIZ review_status'ta");
  assert.equal(r.review_required, false);
});

test("C) flux ve http://www kok (canli): pattern CONVERGE, review_required true / review_status REVIEW_REQUIRED mevcut davranista KALIR", () => {
  for (const c of FIX.convergence_cases) {
    const s = classifyInspection(c.inspectionResult);
    const r = classifyCanonicalRelations(c.inspected, s.google_canonical, s.user_canonical);
    assert.equal(r.canonical_pattern, "GOOGLE_USER_CONVERGE_ON_OTHER_URL");
    assert.notEqual(r.canonical_pattern, "DECLARED_GOOGLE_CONFLICT");
    assert.equal(r.review_required, true);
    assert.equal(r.review_status, "REVIEW_REQUIRED");
    assert.deepEqual(r.reasons, ["GOOGLE_CANONICAL_DIFFERS_FROM_INSPECTED", "USER_CANONICAL_CROSS_DOMAIN", "GOOGLE_CANONICAL_CROSS_DOMAIN"]);
  }
});

test("D) bath-loofah ve www+.html (canli): pattern DECLARED_GOOGLE_CONFLICT", () => {
  for (const c of FIX.cases) {
    const s = classifyInspection(c.inspectionResult);
    assert.equal(classifyCanonicalRelations(c.inspected, s.google_canonical, s.user_canonical).canonical_pattern, "DECLARED_GOOGLE_CONFLICT");
  }
});

test("E) 4 canli fixture: candidate 4, conflict 2, convergence 2 (sayimlar degismedi)", async () => {
  const r = await probeWith({ ...byUrl4 });
  assert.equal(r.canonical_candidate_count, 4);
  assert.equal(r.canonical_conflict_count, 2);
  assert.equal(r.canonical_convergence_count, 2);
});

test("docs ve fixture eski pattern adini kullanmaz: 'NO_DIVERGENCE_OBSERVED' yalniz review_status baglaminda", () => {
  const doc = readFileSync(new URL("../docs/integrations/index-probe.md", import.meta.url), "utf8");
  const patternTable = doc.split("### `canonical_pattern`")[1].split("Ad netleştirmesi")[0];
  assert.ok(!patternTable.includes("NO_DIVERGENCE_OBSERVED"));
  assert.ok(patternTable.includes("INSPECTED_USER_GOOGLE_ALIGNED"));
  assert.ok(!JSON.stringify(FIX).includes("NO_DIVERGENCE_OBSERVED"));
});
