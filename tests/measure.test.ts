// Bu katmanin tek isi, credential gelmeden once analizi hazir tutmak. En buyuk
// riski de o: veri yokken "0" uretip her seyin olculdugu izlenimi vermek.
// Testlerin cogu bu yuzden NE URETILMEMESI gerektigi hakkinda.
import { test } from "node:test";
import assert from "node:assert/strict";
import { periods, normalizeQuery, brandPatterns, classifyQuery, splitByBrand, measured } from "../src/measure.ts";

test("dönemler Search Console gecikmesini hesaba katar ve üst üste binmez", () => {
  const p = periods(new Date("2026-09-21T00:00:00Z"));
  // Veri ~2 gun gecikmeli; bugunden baslamak her raporu yapay bir dususle acardi.
  assert.equal(p.current.end, "2026-09-19");
  assert.equal(p.current.start, "2026-08-23");
  // Onceki donem bitisi, mevcut donem baslangicindan TAM bir gun once olmali.
  assert.equal(p.previous.end, "2026-08-22");
  assert.ok(p.previous.end < p.current.start, "dönemler örtüşemez");
  // 364 gun = 52 tam hafta: gun-of-week hizasi korunur, hafta sonu kaymasi olmaz.
  assert.equal(p.yearAgo.end, "2025-09-20");
});

test("Türkçe normalizasyonu noktasız ı ile noktalı i'yi eşitler", () => {
  // "İstanbul" ve "istanbul" ayri kalirsa marka aramasi marka-disi sayilir.
  assert.equal(normalizeQuery("PAM İstanbul"), "pam istanbul");
  assert.equal(normalizeQuery("pam ıstanbul"), "pam istanbul");
  assert.equal(normalizeQuery("Şişli-Güzel_Çekim"), "sisli guzel cekim");
});

test("marka desenleri registry'den gelir, kodda sabit değildir", () => {
  const pat = brandPatterns({
    brand_entities: ["PAM İstanbul"], people_entities: ["Sefa Yamak"],
    production_domain: "pamistanbul.com",
  } as never);
  assert.deepEqual(pat, ["pam istanbul", "pamistanbul", "pamistanbul com", "sefa yamak"]);
  // Farkli bir site farkli desen uretir — hicbiri hardcode degil.
  const other = brandPatterns({ brand_entities: [], people_entities: [], production_domain: "untitledportraits.com" } as never);
  assert.deepEqual(other, ["untitledportraits", "untitledportraits com"]);
});

test("sınıflandırma kelime sınırına bakar, parça eşleşmesine değil", () => {
  const pat = ["pam istanbul", "pamistanbul", "sefa yamak"];
  assert.equal(classifyQuery("pam istanbul reklam", pat), "brand");
  assert.equal(classifyQuery("PAM İSTANBUL", pat), "brand");
  assert.equal(classifyQuery("reklam filmi fiyatları", pat), "non-brand");
  // "pamistanbul" deseni "pamistanbuldaki" icinde GECMEMELI: parca eslesmesi
  // marka-disi aramalari markaya yazar ve raporu yaniltir.
  assert.equal(classifyQuery("pamistanbuldaki stüdyolar", pat), "non-brand");
});

test("bölme, ortalamaları gösterimle ağırlıklandırır", () => {
  const rows = [
    { query: "pam istanbul", clicks: 10, impressions: 100, ctr: 0.1, position: 1 },
    { query: "reklam filmi", clicks: 1, impressions: 900, ctr: 0.0011, position: 41 },
  ];
  const s = splitByBrand(rows, ["pam istanbul"]);
  assert.equal(s.brand.clicks, 10);
  assert.equal(s.nonBrand.impressions, 900);
  // Duz ortalama 21 verirdi; gosterimle agirliklandirinca 37 — gercege bu yakin,
  // cunku gosterimlerin %90'i 41. siradaki sorgudan geliyor.
  assert.equal(Math.round(s.all.position), 37);
  assert.equal(Math.round(s.all.ctr * 10000) / 10000, 0.011);
});

test("veri yokluğu SIFIR değil, NOT_CONNECTED olarak taşınır", () => {
  // En onemli test: adapter null dondugunde "0 tiklama" yazmak, olcum yapildigi
  // ve sonucun sifir oldugu izlenimini verir. Ikisi ayri seydir.
  const none = measured(null, "SEARCH_GROWTH_GSC_CREDENTIALS_JSON yok");
  assert.equal(none.state, "NOT_CONNECTED");
  assert.ok(!("data" in none));
  const some = measured([{ clicks: 1, impressions: 2, ctr: 0.5, position: 3 }], "x");
  assert.equal(some.state, "CONNECTED");
});
