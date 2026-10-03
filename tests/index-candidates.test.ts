// Segmentli aday havuzu. Bu testlerin cogu NE YAPILMAMASI gerektigi hakkinda: bir kaynak
// okunamadiginda "tum URL'ler GSC'de gozlenmedi / sitemap'te yok" diye yazmak, kanitsiz
// bir "sorunlu" listesi uretir (CLAUDE.md kural 6: haksiz suclama).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  SEGMENTS, BASE_QUOTA, segmentCandidates, isHostVariant, hashSorted, rotate, scaleQuota, allocate, selectSegmented,
  type UrlSource, type Segment, type SegmentPool,
} from "../src/index-candidates.ts";
import { HARD_LIMIT, runProbe, probeToMarkdown, summarizeSitemaps } from "../src/index-probe.ts";

const ORIGIN = "https://pamistanbul.com";
const DOMAIN = "pamistanbul.com";
const A: Segment = "SITEMAP_NOT_OBSERVED_IN_GSC_WINDOW";
const D: Segment = "HOST_VARIANT_RISK";
const B: Segment = "GSC_NOT_IN_SITEMAP";
const C: Segment = "SITEMAP_AND_GSC";
const ok = (...urls: string[]): UrlSource => ({ state: "MEASURED", urls });
const unk = (reason = "test"): UrlSource => ({ state: "UNKNOWN", reason });
const build = (sitemap: UrlSource, gsc: UrlSource) => segmentCandidates({ sitemap, gsc, canonicalOrigin: ORIGIN, productionDomain: DOMAIN });
const urlsOf = (p: SegmentPool) => (p.state === "COMPUTED" ? p.urls : null);
const mk = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `https://pamistanbul.com/${prefix}-${i}`);

// --- segment modeli ------------------------------------------------------------

test("segment adlari iddia tasir: eski/yaniltici adlar yok", () => {
  assert.deepEqual([...SEGMENTS], [A, D, B, C]);
  assert.ok(!SEGMENTS.some((s) => /SITEMAP_NO_GSC|CANONICAL_OR_REDIRECT_RISK/.test(s)));
  assert.equal(Object.values(BASE_QUOTA).reduce((a, b) => a + b, 0), 20);
});

test("sitemap-only -> A; GSC-only -> B; iki kaynakta ayni tam URL -> C", () => {
  const r = build(ok("https://pamistanbul.com/s", "https://pamistanbul.com/both"), ok("https://pamistanbul.com/g", "https://pamistanbul.com/both"));
  assert.deepEqual(urlsOf(r.pools[A]), ["https://pamistanbul.com/s"]);
  assert.deepEqual(urlsOf(r.pools[B]), ["https://pamistanbul.com/g"]);
  assert.deepEqual(urlsOf(r.pools[C]), ["https://pamistanbul.com/both"]);
  assert.deepEqual(urlsOf(r.pools[D]), []);
});

test("http ve www varyantlari GSC'de goruluyorsa HOST_VARIANT_RISK'e gider; uretim origin'i gitmez", () => {
  const r = build(ok(), ok("http://www.pamistanbul.com/", "http://pamistanbul.com/x", "https://www.pamistanbul.com/y", "https://pamistanbul.com/z"));
  assert.deepEqual(urlsOf(r.pools[D])!.sort(), ["http://pamistanbul.com/x", "http://www.pamistanbul.com/", "https://www.pamistanbul.com/y"]);
  assert.deepEqual(urlsOf(r.pools[B]), ["https://pamistanbul.com/z"]);
  assert.equal(isHostVariant("https://pamistanbul.com/a", ORIGIN), false);
  assert.equal(isHostVariant("http://pamistanbul.com/a", ORIGIN), true);
});

test("D bir canonical/redirect HATASI iddiasi degildir: adi ve raporu bunu soyler", () => {
  assert.ok(!SEGMENTS.includes("CANONICAL_OR_REDIRECT_RISK" as never));
  const md = probeToMarkdown(
    { site: "pamistanbul", mode: "SAMPLE", coverage_notice: "x", candidate_source: "t", candidates: 0, attempted: 0, limit: 10, stopped: null, results: [], skipped: [],
      segments: [{ segment: A, state: "COMPUTED", pool: 3, quota: 2, probed: 0, verdicts: {} }] },
    summarizeSitemaps(null), "2026-10-01");
  assert.match(md, /son 28 günlük GSC page dataset'inde gözlenmedi/);
  assert.match(md, /HATA değildir/);
  assert.match(md, /canonical\/redirect hatası İDDİA ETMEZ/);
  assert.ok(!/GSC'de yok/.test(md));
});

test("sitemap'te listelenen varyant host URL'si GSC'de gozlenmediyse D degil A'dir (D yalniz GSC gozlemi)", () => {
  const r = build(ok("http://www.pamistanbul.com/only-sitemap"), ok());
  assert.deepEqual(urlsOf(r.pools[A]), ["http://www.pamistanbul.com/only-sitemap"]);
  assert.deepEqual(urlsOf(r.pools[D]), []);
});

test("/a ve /a/ kanitsiz BIRLESTIRILMEZ (sondaki egik cizgi silinmez)", () => {
  const r = build(ok("https://pamistanbul.com/a"), ok("https://pamistanbul.com/a/"));
  assert.deepEqual(urlsOf(r.pools[A]), ["https://pamistanbul.com/a"], "sitemap /a, GSC'de /a/ gozlendi: /a gozlenmedi");
  assert.deepEqual(urlsOf(r.pools[B]), ["https://pamistanbul.com/a/"]);
  assert.deepEqual(urlsOf(r.pools[C]), []);
});

test("/en/ ile TR ayri kalir; query string korunur; fragment uyelikte kaldirilir", () => {
  const r = build(ok("https://pamistanbul.com/pamlab/x", "https://pamistanbul.com/p?page=2"), ok("https://pamistanbul.com/en/pamlab/x", "https://pamistanbul.com/p?page=3", "https://pamistanbul.com/pamlab/x#bolum"));
  assert.deepEqual(urlsOf(r.pools[C]), ["https://pamistanbul.com/pamlab/x"], "fragment atilir, TR URL iki kaynakta da var");
  assert.deepEqual(urlsOf(r.pools[A]), ["https://pamistanbul.com/p?page=2"], "farkli query = farkli URL");
  assert.deepEqual(urlsOf(r.pools[B])!.sort(), ["https://pamistanbul.com/en/pamlab/x", "https://pamistanbul.com/p?page=3"]);
});

test("kosu: host disi ve gecersiz URL reddedilir ve gorunur kalir", () => {
  const r = build(ok("https://pamistanbul.com/a", "https://evil.example/a", "::::"), ok("https://spryhand.com/x"));
  assert.equal(r.rejected.length, 3);
  assert.deepEqual(urlsOf(r.pools[A]), ["https://pamistanbul.com/a"]);
});

test("URL iki segmente birden girmez (karisik girdi)", () => {
  const sm = [...mk("a", 7), ...mk("both", 4), "http://www.pamistanbul.com/v"];
  const gs = [...mk("g", 5), ...mk("both", 4), "http://www.pamistanbul.com/v", "https://www.pamistanbul.com/w"];
  const r = build(ok(...sm), ok(...gs));
  const all = SEGMENTS.flatMap((s) => urlsOf(r.pools[s])!);
  assert.equal(new Set(all).size, all.length);
  assert.deepEqual(urlsOf(r.pools[D])!.sort(), ["http://www.pamistanbul.com/v", "https://www.pamistanbul.com/w"]);
});

// --- kaynak UNKNOWN: yanlis negatif korumasi ------------------------------------

test("GSC UNKNOWN iken sitemap URL'leri 'GSC'de gozlenmedi' diye siniflanmaz; hicbir segment hesaplanmaz", () => {
  const r = build(ok(...mk("s", 50)), unk("HTTP 403"));
  for (const s of SEGMENTS) { assert.equal(r.pools[s].state, "UNKNOWN", s); }
  assert.match((r.pools[A] as { reason: string }).reason, /GSC .* okunamadi/);
  assert.equal(selectSegmented({ pools: r.pools, limit: 20, dayIndex: 5 }).order.length, 0);
});

test("sitemap UNKNOWN iken GSC URL'leri 'sitemap'te yok' diye siniflanmaz; yalniz D hesaplanir", () => {
  const r = build(unk("HTTP 404"), ok("https://pamistanbul.com/g", "http://www.pamistanbul.com/"));
  assert.equal(r.pools[A].state, "UNKNOWN");
  assert.equal(r.pools[B].state, "UNKNOWN");
  assert.equal(r.pools[C].state, "UNKNOWN");
  assert.deepEqual(urlsOf(r.pools[D]), ["http://www.pamistanbul.com/"]);
  const sel = selectSegmented({ pools: r.pools, limit: 20, dayIndex: 1 });
  assert.deepEqual(sel.order.map((o) => o.segment), [D]);
  assert.ok(!sel.order.some((o) => o.url === "https://pamistanbul.com/g"), "B'ye ait gibi secilmez");
});

test("UNKNOWN (olculemedi) ile bos kume (olculdu, hic URL yok) ayri seydir", () => {
  const empty = build(ok(), ok("https://pamistanbul.com/g"));
  assert.equal(empty.pools[A].state, "COMPUTED");
  assert.deepEqual(urlsOf(empty.pools[A]), []);
  assert.equal(build(unk(), ok("https://pamistanbul.com/g")).pools[A].state, "UNKNOWN");
});

// --- rotasyon -------------------------------------------------------------------

test("hash sirasi kaynak sirasindan bagimsiz; ayni gun + ayni veri = ayni secim", () => {
  const urls = mk("p", 30);
  assert.deepEqual(hashSorted(urls), hashSorted([...urls].reverse()));
  assert.deepEqual(rotate(urls, 5, 20000), rotate([...urls].reverse(), 5, 20000));
  assert.equal(rotate(urls, 5, 20000).length, 5);
});

test("farkli gunde rotasyon ilerler; q|n iken ceil(n/q) gunde tum URL'ler tekrarsiz gezilir", () => {
  const urls = mk("p", 25);
  assert.notDeepEqual(rotate(urls, 5, 20000), rotate(urls, 5, 20001));
  const seen: string[] = [];
  for (let d = 20000; d < 20005; d++) seen.push(...rotate(urls, 5, d));
  assert.equal(seen.length, 25);
  assert.equal(new Set(seen).size, 25, "tur icinde tekrar yok");
});

test("q|n degilken de n gun icinde hepsi gezilir; sarma ve q>=n davranisi", () => {
  const urls = mk("p", 23);
  const seen = new Set<string>();
  for (let d = 20000; d < 20000 + 23; d++) for (const u of rotate(urls, 5, d)) seen.add(u);
  assert.equal(seen.size, 23);
  assert.equal(rotate(urls, 40, 7).length, 23, "q >= n: tum havuz, tekrar yok");
  assert.deepEqual(rotate([], 5, 7), []);
  assert.deepEqual(rotate(urls, 0, 7), []);
});

// --- kota dagitimi ----------------------------------------------------------------

const pools = (a: number, d: number, b: number, c: number): Record<Segment, SegmentPool> => ({
  [A]: { state: "COMPUTED", urls: mk("a", a) }, [D]: { state: "COMPUTED", urls: mk("d", d).map((u) => u.replace("https://", "http://www.")) },
  [B]: { state: "COMPUTED", urls: mk("b", b) }, [C]: { state: "COMPUTED", urls: mk("c", c) },
});

test("taban dagilim 20 icin 10/5/2/3; limit olcekleme toplami korur", () => {
  assert.deepEqual(scaleQuota(20), { [A]: 10, [D]: 5, [B]: 2, [C]: 3 });
  for (const n of [1, 5, 7, 10, 13, 20, 37, 100]) assert.equal(Object.values(scaleQuota(n)).reduce((a, b) => a + b, 0), n, `limit ${n}`);
  assert.equal(Object.values(scaleQuota(10)).reduce((a, b) => a + b, 0), 10);
});

test("toplam secim limiti asmaz; HARD_LIMIT asilmaz", () => {
  for (const lim of [0, 1, 5, 10, 20, 100, 5000]) {
    const sel = selectSegmented({ pools: pools(500, 500, 500, 500), limit: lim, dayIndex: 3 });
    assert.ok(sel.order.length <= Math.min(lim, HARD_LIMIT), `limit ${lim}: ${sel.order.length}`);
  }
  assert.equal(selectSegmented({ pools: pools(500, 500, 500, 500), limit: 5000, dayIndex: 3 }).order.length, HARD_LIMIT);
});

test("bos segment kotasi sirayla A, D, B, C ile BIRER BIRER aktarilir (ayni URL ile doldurma yok)", () => {
  // D 5->1 (4 bos). Bos slotlar A, B, C'ye (D tukendi) dongu halinde.
  const q = allocate(pools(300, 1, 10, 400), 20);
  assert.equal(q[D], 1);
  assert.equal(Object.values(q).reduce((a, b) => a + b, 0), 20);
  assert.deepEqual(q, { [A]: 12, [D]: 1, [B]: 3, [C]: 4 }, "A+2, B+1, C+1");
});

test("havuz kotadan kucukse daha az probe yapilir; tekrar URL ile doldurulmaz", () => {
  const sel = selectSegmented({ pools: pools(2, 1, 1, 1), limit: 20, dayIndex: 9 });
  assert.equal(sel.order.length, 5);
  assert.equal(new Set(sel.order.map((o) => o.url)).size, 5);
  assert.equal(selectSegmented({ pools: pools(0, 0, 0, 0), limit: 20, dayIndex: 9 }).order.length, 0);
});

test("UNKNOWN segmentlere kota verilmez; slotlar hesaplananlara akar", () => {
  const p = pools(0, 3, 0, 0); p[A] = { state: "UNKNOWN", reason: "x" }; p[B] = { state: "UNKNOWN", reason: "x" }; p[C] = { state: "UNKNOWN", reason: "x" };
  const sel = selectSegmented({ pools: p, limit: 20, dayIndex: 1 });
  assert.equal(sel.order.length, 3);
  assert.equal(sel.segments[A].quota, 0);
  assert.equal(sel.segments[A].state, "UNKNOWN");
});

test("secim: ayni gun ayni veri ayni; farkli gun A'da ilerler; calisma sirasi A, D, B, C; URL tekrari yok", () => {
  const p = pools(300, 20, 15, 200);
  const s1 = selectSegmented({ pools: p, limit: 20, dayIndex: 20000 });
  assert.deepEqual(s1, selectSegmented({ pools: p, limit: 20, dayIndex: 20000 }));
  const s2 = selectSegmented({ pools: p, limit: 20, dayIndex: 20001 });
  const aOf = (s: typeof s1) => s.order.filter((o) => o.segment === A).map((o) => o.url);
  assert.notDeepEqual(aOf(s1), aOf(s2));
  const segOrder = s1.order.map((o) => o.segment);
  assert.deepEqual(segOrder, [...segOrder].sort((x, y) => SEGMENTS.indexOf(x) - SEGMENTS.indexOf(y)));
  assert.equal(new Set(s1.order.map((o) => o.url)).size, s1.order.length);
  assert.equal(s1.rotation, "stateless_approximate");
});

// --- runProbe entegrasyonu: 403/429, kilit, rapor ----------------------------------

const SITE = { id: "pamistanbul", production_domain: "pamistanbul.com" };
const PASS = { indexStatusResult: { verdict: "PASS", coverageState: "Submitted and indexed", googleCanonical: "x" } };
function segCandidates(n = 6) { return selectSegmented({ pools: pools(n, 2, 2, 2), limit: 20, dayIndex: 4 }); }

test("segmentli kosuda sonuclar segment etiketi tasir; rapor SAMPLE / TAM COVERAGE DEGIL + yaklasik rotasyon der", async () => {
  const sel = segCandidates();
  const r = await runProbe({ site: SITE, candidates: sel.order, segmentInfo: { segments: sel.segments, day_index: sel.day_index }, candidateSource: "t", limit: 20, delayMs: 0, connected: true, sleep: async () => {}, inspect: async () => PASS });
  assert.equal(r.strategy, "segmented");
  assert.ok(r.results.every((x) => x.segment));
  assert.match(r.coverage_notice, /ÖRNEKLEM \(SAMPLE\) — TAM COVERAGE DEĞİL/);
  assert.match(r.coverage_notice, /YAKLAŞIK bir turdur/);
  assert.match(r.coverage_notice, /TEMSİL EDİLMEZ/);
  const rowA = r.segments!.find((x) => x.segment === A)!;
  assert.equal(rowA.probed, rowA.quota);
  assert.equal(rowA.verdicts.INDEXED, rowA.probed);
  assert.match(probeToMarkdown(r, summarizeSitemaps(null), "2026-10-01"), /\| segment \| havuz \| kota \| denetlenen \| dağılım \|/);
});

for (const code of [403, 429]) {
  test(`segmentli kosuda HTTP ${code}: ERROR, tum kosu durur, NOT_INDEXED denmez`, async () => {
    const sel = segCandidates(); let n = 0;
    const r = await runProbe({ site: SITE, candidates: sel.order, segmentInfo: { segments: sel.segments, day_index: 1 }, candidateSource: "t", limit: 20, delayMs: 0, connected: true, sleep: async () => {}, inspect: async () => { n++; throw new Error(`HTTP ${code} x`); } });
    assert.equal(n, 1);
    assert.equal(r.stopped, code === 429 ? "rate_limited_429" : "forbidden_403");
    assert.equal(r.results[0].summary.state, "ERROR");
    assert.notEqual(r.results[0].summary.index_verdict, "NOT_INDEXED");
    assert.equal(r.segments!.find((x) => x.segment === A)!.verdicts.ERROR, 1);
  });
}

test("segmentli yol da registry kilidini (knownSiteIds verilince) ve host kilidini korur", async () => {
  await assert.rejects(runProbe({ site: { id: "evil-not-registered", production_domain: "evil-not-registered.com" }, knownSiteIds: ["pamistanbul", "spryhand"], candidates: [{ url: "https://evil-not-registered.com/", segment: A }], candidateSource: "t", limit: 5, delayMs: 0, connected: true, inspect: async () => PASS }), /kayit defterinde/);
  // Registry'de olan, pamistanbul OLMAYAN bir site de artik calisabilir (PAM-only kilit kaldirildi).
  {
    let n = 0;
    const r = await runProbe({ site: { id: "spryhand", production_domain: "spryhand.com" }, knownSiteIds: ["pamistanbul", "spryhand"], candidates: [{ url: "https://spryhand.com/", segment: A }], candidateSource: "t", limit: 5, delayMs: 0, connected: true, inspect: async () => { n++; return PASS; } });
    assert.equal(n, 1);
    assert.equal(r.results.length, 1);
  }
  let calls = 0;
  const r = await runProbe({ site: SITE, candidates: [{ url: "https://evil.example/a", segment: A }, { url: "https://pamistanbul.com/ok", segment: A }], candidateSource: "t", limit: 5, delayMs: 0, connected: true, sleep: async () => {}, inspect: async () => { calls++; return PASS; } });
  assert.equal(calls, 1);
  assert.equal(r.skipped.length, 1);
});

test("kimlik yokken segmentli kosu NOT_CONNECTED, sifir cagri", async () => {
  let calls = 0;
  const r = await runProbe({ site: SITE, candidates: [], candidateSource: "t", limit: 5, delayMs: 0, connected: false, inspect: async () => { calls++; return PASS; } });
  assert.equal(r.stopped, "not_connected");
  assert.equal(calls, 0);
});

// --- CLI geriye uyumluluk ----------------------------------------------------------

const ROOT = new URL("..", import.meta.url).pathname;
const cli = (cwd: string, ...a: string[]) => spawnSync("node", ["--experimental-strip-types", join(ROOT, "src/cli.ts"), "inspect-index", join(ROOT, "config/sites.yaml"), ...a], { cwd, encoding: "utf8", env: { ...process.env, SEARCH_GROWTH_GSC_CREDENTIALS_JSON: "" } });

test("cli: varsayilan strateji gsc (Phase 1 cikti bicimi), segment bolumu yok", () => {
  const cwd = mkdtempSync(join(tmpdir(), "seg-"));
  const f = join(cwd, "u.txt"); writeFileSync(f, "https://pamistanbul.com/\n");
  const r = cli(cwd, "--urls", f);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /NOT_CONNECTED/);
  assert.ok(!/## Segmentler/.test(r.stdout));
  assert.match(r.stdout, /\| URL \| durum \| karar \| coverage \| Google canonical \|/);
});

test("cli: --strategy segmented kimlik yokken NOT_CONNECTED + SAMPLE; --urls ile birlikte reddedilir; gecersiz deger reddedilir", () => {
  const cwd = mkdtempSync(join(tmpdir(), "seg-"));
  const r = cli(cwd, "--strategy", "segmented");
  assert.equal(r.status, 0);
  assert.match(r.stdout, /NOT_CONNECTED/);
  assert.match(r.stdout, /TAM COVERAGE DEĞİL/);
  assert.match(r.stdout, /## Segmentler/);
  assert.match(r.stdout, /SITEMAP_NOT_OBSERVED_IN_GSC_WINDOW \| UNKNOWN/);
  assert.equal(cli(cwd, "--strategy", "segmented", "--urls", "x").status, 1);
  assert.equal(cli(cwd, "--strategy", "bogus").status, 1);
  assert.equal(cli(cwd, "--site", "spryhand", "--strategy", "segmented").status, 1, "pamistanbul kilidi");
});

test("workflow: strategy input varsayilan gsc, schedule YOK, Indexing API yok", () => {
  const w = readFileSync(join(ROOT, ".github/workflows/index-probe.yml"), "utf8");
  assert.match(w, /strategy:[\s\S]*default: gsc/);
  const onBlock = w.split(/^on:/m)[1].split(/^permissions:/m)[0];
  assert.ok(!/schedule:/.test(onBlock), "schedule eklenmedi");
  assert.ok(!/urlNotifications|indexing\.googleapis/.test(w));
});
