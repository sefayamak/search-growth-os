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

## Canonical ilişkileri (Phase 1.5b-küçük)

Her probe sonucu `canonical_relations` taşır (`src/canonical-relations.ts`, saf fonksiyon, her iki strateji için). Girdi **yalnız üç URL
alanıdır**: denetlenen URL, `googleCanonical`, `userCanonical`. `coverageState` metni (tr-TR yerelleştirilmiş: "Yönlendirmeli sayfa",
"Gönderildi ve dizine eklendi") karar için KULLANILMAZ; testle zorlanır.

| Alan | Değer |
|---|---|
| `inspected_vs_google` | SAME / DIFFERENT / UNKNOWN |
| `user_vs_google` | SAME / DIFFERENT / UNKNOWN |
| `user_vs_inspected` | SAME / DIFFERENT / UNKNOWN |
| `user_cross_domain` | true / false / UNKNOWN (userCanonical hostname ≠ denetlenen hostname) |
| `google_cross_domain` | true / false / UNKNOWN |
| `review_required` | tetikleyici gözlendiyse true |
| `review_status` | `REVIEW_REQUIRED` · `NO_DIVERGENCE_OBSERVED` · `UNKNOWN` |
| `reasons` | `GOOGLE_CANONICAL_DIFFERS_FROM_INSPECTED`, `USER_CANONICAL_DIFFERS_FROM_GOOGLE`, `USER_CANONICAL_CROSS_DOMAIN`, `GOOGLE_CANONICAL_CROSS_DOMAIN` |

- Eşitlik: parse + fragment atma. Sondaki `/`, scheme, query ve path harf duyarlılığı **korunur**; hiçbir şey tahminle birleştirilmez.
- "Cross-domain" tam hostname farkıdır: **`www.x.com` ile `x.com` FARKLI sayılır** (true).
- Eksik/geçersiz alan = UNKNOWN; UNKNOWN asla SAME/DIFFERENT değildir ve "sorun yok" anlamına gelmez.
- `REVIEW_REQUIRED` bir SEO hatası DEĞİLDİR: Google'ın yanıtındaki alanların karşılaştırması (FACT) ve insan incelemesi adayıdır (CANDIDATE).
  Raporda `ERROR` ile karıştırılmaz; "## Canonical candidates" bölümü yalnız `REVIEW_REQUIRED` satırlarını listeler, yoksa hiç yazılmaz.
  Segment tablosu ve JSON `canonical_candidate_count` taşır.

Canlı iki örnek (run 36827031582, 2026-10-01) fixture olarak testte (`tests/fixtures/index-probe/canonical-live-2026-10-01.json`):
(A) `pamistanbul.com/en/video/bath-loofah-lifestyle`: userCanonical `pamaistudio.com/...` (başka domain), Google denetlenen URL'yi canonical seçmiş;
(B) `www.pamistanbul.com/pamlab/ucretsiz-ai-gorsel-uretme-araclari-2026.html`: Google canonical kendisi (www + .html), userCanonical temiz apex URL.
İkisi de `REVIEW_REQUIRED` adayıdır; kaynak sayfaların düzeltilmesi bu sistemin işi değildir.

### `canonical_pattern` (Phase 1.5b ikinci dilim)

Mevcut ilişki FACT'leri ve `review_required` / `review_status` anlamı **değişmedi**. Üzerlerine türetilmiş bir alan eklendi; yalnız iki ilişkiden
(`inspected_vs_google`, `user_vs_google`) çıkar. Hostname / `*_cross_domain` kararın yerine geçmez, ek FACT olarak kalır (`www` ≠ apex).

| `canonical_pattern` | Koşul | Anlamı |
|---|---|---|
| `DECLARED_GOOGLE_CONFLICT` | `user_vs_google = DIFFERENT` (öncelikli) | sayfanın bildirdiği canonical ile Google'ın seçtiği uyuşmuyor. CANDIDATE / REVIEW_REQUIRED, insan incelemesi adayı; otomatik SEO hatası değil |
| `GOOGLE_USER_CONVERGE_ON_OTHER_URL` | `inspected_vs_google = DIFFERENT` ve `user_vs_google = SAME` | denetlenen URL başka bir varyant, Google ve sayfa aynı hedefte uzlaşıyor. Canonical çatışması değil; INFO / OBSERVED_CONVERGENCE. Doğru HTTP redirect/canonical uygulaması olduğu **iddia edilmez** (sayfa fetch edilmedi) |
| `NO_DIVERGENCE_OBSERVED` | `inspected_vs_google = SAME` ve `user_vs_google = SAME` | denetlenen == Google == bildirilen |
| `INCOMPLETE` | gerekli alan UNKNOWN | güvenilir desen çıkarılamıyor |

Dikkat — ad çakışması: `review_status = NO_DIVERGENCE_OBSERVED` daha geniştir (bildirilen canonical eksikken de olabilir); `canonical_pattern = NO_DIVERGENCE_OBSERVED`
siki ve user canonical bilinmesini ister, eksikse `INCOMPLETE` olur.

Rapor: `## Canonical candidates` iki alt gruba ayrılır — **Declared vs Google conflicts** ve **Google/user convergence on another URL**. `review_required` olup deseni
`INCOMPLETE` olan satırlar kaybolmasın diye (varsa) üçüncü bir **Incomplete canonical data** alt grubu yazılır. Sayımlar: `canonical_candidate_count`
(geriye uyumlu, `review_required` sayısı), `canonical_conflict_count`, `canonical_convergence_count` (JSON toplam + segment satırı; segment tablosunda `conflict` ve
`convergence` sütunları). `review_required` semantiğini daraltıp daraltmamak ayrı bir karardır.

Canlı dört vaka (run 36827031582 ve 36828755651): `bath-loofah-lifestyle` ve `www…ucretsiz-ai-gorsel-uretme-araclari-2026.html` = `DECLARED_GOOGLE_CONFLICT`;
`www…flux-ai-image-model-guide-2026` ve `http://www.pamistanbul.com/` = `GOOGLE_USER_CONVERGE_ON_OTHER_URL`.
