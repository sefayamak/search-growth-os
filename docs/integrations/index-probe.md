# index-probe (pamistanbul) — aday stratejileri

Salt-okunur URL Inspection **ÖRNEKLEMİ**. Tam index coverage ölçümü değildir; her çıktı bunu başlığına yazar.
Yalnız `pamistanbul`; Google Indexing API yok; indeksleme talebi gönderilmez.

Canlı doğrulama (2026-10-01, run 36824162453): 5/5 URL INSPECTED, 5/5 INDEXED, ham alanlar
(`indexingState`, `pageFetchState`, `robotsTxtState`, `googleCanonical`, `userCanonical`, `lastCrawlTime`)
`UrlInspectionSummary` ile uyumlu. Bu yalnız `strategy=gsc` için geçerlidir.

## `--strategy gsc` (varsayılan, Phase 1)

Adaylar son 28 günde GSC'de gösterimi olan sayfalardır. Google'ın zaten gösterdiği sayfaları iyi temsil
eder; sitemap'te olup bu pencerede hiç gözlenmeyen URL'leri temsil etmez. "5/5 INDEXED" bu yüzden
"site index coverage'ı sağlıklı" demek değildir.

## `--strategy segmented` (Phase 1.5a)

Kaynaklar: sitemap evreni (registry `sitemap_locations` + varsa robots.txt `Sitemap:` satırları; ayrıştırma
mevcut `src/sitemap.ts`) ve son 28 günlük GSC page dataset'i. Sayfalar fetch EDİLMEZ.

| Segment | Anlamı | Ne DEĞİLDİR |
|---|---|---|
| `SITEMAP_NOT_OBSERVED_IN_GSC_WINDOW` | sitemap evreninde var, 28 günlük GSC page dataset'inde **gözlenmedi** | hata değil; "GSC'de yok" ya da "Google bilmiyor" değil. Daha az gözlenmiş, daha yüksek inceleme öncelikli havuz |
| `HOST_VARIANT_RISK` | GSC'de üretim origin'inden (`https://<canonical_hostname>`) farklı scheme/host ile gözlenen URL (ör. `http://www…`) | canonical/redirect hatası iddiası değil; hiçbir sayfa fetch edilmedi |
| `GSC_NOT_IN_SITEMAP` | GSC'de gözlenen, sitemap evreninde olmayan | |
| `SITEMAP_AND_GSC` | iki kaynakta da tam URL olarak var | düşük risk, doğrulama örneklemi |

Segmentler ayrıktır. `CANONICAL_OR_REDIRECT_RISK` ve `NEW_OR_CHANGED` Phase 1.5b'dedir (fetch kanıtı gerekir).

**URL eşitliği:** yalnız parse/normalize + fragment atma. Sondaki `/` silinmez, `/a` ≠ `/a/`, `/en/` ≠ TR, query korunur,
www/http birleştirilmez. Canonical ya da redirect kanıtı olmadan URL birleştirilmez.

**Kaynak okunamazsa:** GSC `UNKNOWN` → hiçbir segment hesaplanmaz. Sitemap `UNKNOWN` (kök ya da alt sitemap
okunamadı, giriş yok, derinlik/evren sınırı aşıldı) → A, B, C hesaplanmaz; yalnız D (GSC + origin) hesaplanır.
`UNKNOWN` bir kaynak asla boş küme gibi davranmaz.

**Günlük bütçe (varsayılan 20):** A 10 · D 5 · C 3 · B 2. Başka limitte oranla ölçeklenir. Kotasını dolduramayan
segmentin boş slotları sırayla A → D → B → C, birer birer, havuzunda hâlâ URL'si olan segmentlere aktarılır.
Aynı URL ile doldurulmaz; havuzlar küçükse daha az probe yapılır. `HARD_LIMIT` 100 değişmedi.

**Rotasyon (stateless, yaklaşık):** her segment SHA-256(url) sırasında; `başlangıç = (UTC epoch günü × kota) mod havuz`;
döngüsel ardışık pencere. Aynı gün + aynı veri = aynı seçim. Havuz boyu değişirse pencere kayar: **tam tur garantisi
yoktur**. Kalıcı durum (ledger, cache, commit) yoktur.

**Yorum kuralı:** `NOT_INDEXED` Google'ın kendi kararıdır; `SITEMAP_NOT_OBSERVED_IN_GSC_WINDOW` içinde çıkması
tek başına bir kusur kanıtı değildir (CANDIDATE: insan bakar). `coverageState` metni `tr-TR` yerelleştirilmiş gelir;
karar için metin değil `verdict` kullanılır.

## Kota

Actions'ta kalıcı ledger yok. Koruma: varsayılan 20, `HARD_LIMIT` 100, `concurrency: index-probe`, 403/429'da durma
(çıkış kodu 1). Yerel `quota-ledger.json` davranışı aynen duruyor. Bu fazda `schedule` yok.
