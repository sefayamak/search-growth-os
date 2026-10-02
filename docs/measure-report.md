# `sgos.measure-report.v1` — makine-okunur ölçüm raporu

`measure` komutu bugüne dek yalnız stdout'a metin basıyordu (workflow bunu `measure.txt` ->
`reports/measure-latest.md` olarak sarıyor). Bu belge, **aynı sonuçlardan** üretilen JSON
çıktısını anlatır. Markdown'a dokunulmadı: dosya adı, içerik ve stdout byte-byte aynı
(`tests/measure-report.test.ts`, golden: `tests/fixtures/measure-report/measure-stdout.golden.txt`,
eski koddan üretildi).

- Şema: `schemas/measure-report.schema.json` · tipler/üretici: `src/measure-report.ts`
- Örnek: `tests/fixtures/measure-report.sample.json` (sahte Google yanıtlarıyla, deterministik)
- Karar: owner K4=B.

## Nasıl üretilir

```bash
node --experimental-strip-types src/cli.ts measure config/sites.yaml --out reports/runs
# -> stdout: bugünkü Markdown'a giren metin (DEĞİŞMEDİ)
# -> reports/runs/measure-report.json   (yalnız --out verilirse; stderr'e "written: ..." yazılır)
```

`measure` daha önce bir `--out` seçeneği taşımıyordu; diğer komutların (`audit`, `portfolio`,
`llmstxt`) kullandığı `--out <dizin>` kuralı aynen izlendi. **`--out` yoksa dosya yazılmaz**, yani
mevcut workflow'un davranışı değişmez. `measure.yml`'e bu satırı eklemek ayrı bir iştir
(workflow bu PR'da değiştirilmedi): `measure.yml` bağlantısı artık yapıldı: bkz. **Workflow** bölümü (yol `reports/runs/` değil, aşağıdaki karar).

## Workflow

`measure.yml` (haftalık, Pzt 06:40 UTC) Markdown'a ek olarak bu JSON'u da üretir. Cron, izinler, concurrency, secret'lar ve
kapılar değişmedi; tek yazıcı `measure.yml`, tek commit adımı mevcut `scripts/persist-history.sh` çağrısı.

**Karar (owner onayına açık): ROLLING SNAPSHOT, append-only geçmiş DEĞİL.**

- Kanonik yol: **`reports/measure-report-latest.json`**. Her koşu üzerine yazar. Tarihli kopya (`reports/runs/<tarih>-measure-report.json`) yazılmaz.
- Gerekçe: tüketici skorkart (`src/scorecard.ts` `searchOpportunity`) TEK dosya okur (`sites[siteId]`) ve `generated_at` tazeliğini
  10 gün eşiğiyle denetler; tek, değişmeyen bir yol ister. Dosya 7 site x en çok 500 sorgu satırı taşır (örnek: 2 site ~34 KB), haftalık
  tarihli kopya yılda yüzlerce MB'a gidebilirdi ve hiçbir tüketicisi yok. Sürüm geçmişini zaten git tutar (`git log -p -- reports/measure-report-latest.json`);
  insan okuyacaksa Markdown arşivi (`reports/runs/<tarih>-measure.md`) durur. Gerçek bir zaman serisi ihtiyacı doğarsa ayrı, sahipli ve
  boyutu sınırlı bir tarihçe (history-ownership kaydıyla) tasarlanır; bu karar onu engellemez.
- `reports/` öneki `persist-history.sh` izin listesinde zaten var; **izin listesi genişletilmedi**. Çağrıya yalnız `reports/measure-report-latest.json` eklendi.
- Üretim: ayrı adım `Ölçüm raporu (JSON)` aynı `measure ... --out measure-json` komutunu (CLI `measure-json/measure-report.json` yazar)
  `continue-on-error` ile çalıştırır. "Ölçüm" adımı (Markdown kaynağı) bayt-bayt aynı kaldı. Maliyet: `measure` günde bir kez yerine iki kez
  GSC çağırır (aynı salt-okunur çağrılar); iki koşu arasında saniyeler olduğu için fark anlamsız, JSON kendi `period`/`generated_at`'ini taşır.
- Hata davranışı (fail-safe, sessiz değil): JSON üretimi patlarsa **Markdown raporu ve commit yolu kırmızıya dönmez** (JSON ikincil çıktı; owner
  kırmızı isterse adımdan `continue-on-error` kaldırılır). Ama `::warning::` ve step summary'ye "UYARI: JSON üretilemedi" yazılır, mevcut
  `latest` dosyasına DOKUNULMAZ: bayat dosya 10 gün sonra skorkartta `UNKNOWN-STALE` olur; bozuk/boş dosya yazılmaz, taze görünen bayat veri olmaz.
- Artifact (`measure-<run_id>`) hem `reports/measure-report-latest.json` hem ham `measure-json/measure-report.json`'ı içerir.
- Skorkart bağlantısı: `--measure-report reports/measure-report-latest.json`.
- Testler: `tests/measure-workflow.test.ts` (cron/izin/concurrency değişmezleri, tek persist çağrısı ve yollarının betikten okunan
  izin listesine uyması, satır içi git yazımı yok, fail-safe, artifact, Markdown adımlarının dokunulmazlığı; CLI'yi sahte Google ile koşup
  skorkartın dosyayı okuduğunu doğrular).
- İlk canlı koşuda `persist-history.sh` ilk kez gerçek workflow'da çalışacak (ilk planlı koşu 2026-10-05); beklenen: `reports/measure-report-latest.json` yeni dosya olarak commit'lenir.

## Tek dosya, site anahtarlı `sites{}`

Tek dosya, `sites` bir **nesne** ve anahtar tam site kimliği (dizi değil). Gerekçe: skorkart
(`src/scorecard.ts` `searchOpportunity`) tam olarak `raw.sites[siteId]` okuyor; bir siteyi okumak
için diğerlerine dokunmak gerekmiyor. Her giriş kendi içinde tamdır: kendi `site_id`, dönemleri,
marka desenleri, durumları. Bir sitenin sorgusu, deseni ya da sayısı başka girişe geçmez
(test: girdi tek başına ve birlikte üretilince beta girişi birebir aynı; alpha'nın marka deseni
beta'ya sızmaz). Site başına ayrı dosya da mümkündü; tek dosya, workflow'un tek artifact'ını ve
tek `git add`'ini korur.

## Bugün gerçekten ölçülen (denetim, 2026-10-02) ve şemaya taşınan

| Konu | Bugünkü gerçek | Şemada |
|---|---|---|
| Dönem | `periods(new Date())`: son 28 gün (bitiş = bugün−2), 2 gün GSC gecikmesi | `period` |
| Karşılaştırma | **Yıl-yıl** (364 gün kaydırma). "Önceki 28 gün" hesaplanıp başlıkta yazılıyor ama **hiç sorgulanmıyor** | `comparison_period.kind = "year_over_year"`; önceki dönem şemada YOK |
| GSC toplam | Boyutsuz `searchAnalytics` çağrısı (clicks, impressions, ctr, position) | `gsc.totals` |
| GSC sorgular | `query` boyutu, tüm satırlar (25000'lik sayfalama; adapter keserse sessiz kayıp riski adapter'da kapatıldı) | `gsc.queries[]` (gösterime göre azalan, en çok 500) |
| Marka / marka-dışı | **Var**: registry `brand_entities` + `people_entities` + domain'den türetilen desenlerle kural-tabanlı (`classifyQuery`) | `gsc.brand_split` (INFERENCE/CANDIDATE) ve satır başına `brand_class` |
| Düşük hacimli kuyruk | Markdown'daki "not" satırı: toplam − sorgu toplamı (GSC anonimleştirir) | `gsc.coverage.anonymized_tail_impressions` |
| Sayfa tablosu | `measure`'da **yok** (yalnız `detail` komutunda) | `gsc.pages = {state: "NOT_MEASURED", rows: null}` |
| Sorgu×sayfa | **Yok** | `search_opportunity_inputs.query_page_rows = NOT_MEASURED` |
| GA4 | `measure` GA4'ü **hiç çağırmaz**; yalnız `smoke` çağırır. Başlıktaki durum kimlik varlığını söyler | `ga4.state` NOT_CONNECTED / UNKNOWN; metrikler `null` |
| Satır sınırı / kesilme bayrağı | Adapter'da bayrak **yok**: sayfalama sonuna kadar gider. Raporda tablo üst sınırı ve kesildi bilgisi bu şemada **yeni eklendi** | `gsc.rows_complete`, `gsc.coverage.*` |
| Durumlar | NOT_CONNECTED (kimlik/property yok), HATA (çağrı hata), UNKNOWN (kimlik var, çağrı yok) | `MEASURED / NOT_CONNECTED / UNKNOWN / ERROR` |
| Provenance | Raporda yalnız çalıştıran workflow'un run/commit'i vardı | `provenance` + `retrieved_at` |

Marka ayrımı bugün var olduğu için şemaya alındı; yeni bir sınıflandırma **icat edilmedi**.
Sayfa, sorgu×sayfa ve GA4 metrikleri mevcut ölçümde yok; uydurulmadı, açıkça `NOT_MEASURED` /
`null`. Bunlar için ölçüm eklemek (ör. `measure`'a GA4 çağrısı) ayrı bir karardır; eklendiğinde
şema alanları (`ga4.metrics`, `pages.rows`) zaten hazır, `state` `MEASURED` olur.

## UNKNOWN ASLA 0 DEĞİLDİR

| Durum | Anlam | Sayısal alanlar |
|---|---|---|
| `MEASURED` | Canlı çağrı yanıt verdi | Ham değer; **gerçek 0, 0 kalır** |
| `NOT_CONNECTED` | Kimlik ya da registry property'si yok | `null` |
| `UNKNOWN` | Ölçüm denenmedi/yapılamadı | `null` |
| `ERROR` | Çağrı hata verdi (`state_reason`) | `null` |

- "API 200 döndü, satır yok" = doğrulanmış sıfır: `clicks/impressions/ctr = 0`,
  `totals_source = "api_empty_response"`, state `MEASURED`. Bu durumda `position` **`null`**'dır
  (gösterim yokken ortalama konum tanımsız; Markdown'daki `0.0` bu yüzden JSON'a geçmedi).
- Karşılaştırma dönemi alınamazsa `comparison.state = UNKNOWN`, değerler `null`.
- Yüzde değişim (`delta.*.pct`) önceki dönem 0 ise `null` (Markdown'daki "(yeni)"); mutlak fark yine yazılır.

## Kanıt etiketleri

Yalnız altı etiket (`policies/evidence-labels.md`). Güven: CONFIRMED / CANDIDATE / FALSE_POSITIVE / UNKNOWN.

| Alan | Etiket | Güven |
|---|---|---|
| `gsc.totals`, `gsc.queries[]` ham metrikler, `gsc.comparison.totals` | FACT | CONFIRMED (MEASURED iken) |
| Ölçülmemiş her blok (`NOT_CONNECTED`/`UNKNOWN`/`ERROR`) | FACT (durum) | UNKNOWN |
| `gsc.comparison.delta` | INFERENCE | CANDIDATE |
| `gsc.brand_split`, `queries[].brand_class` | INFERENCE | CANDIDATE |
| `search_opportunity_inputs` (adaylar, sayı) | INFERENCE | CANDIDATE (ölçülmediyse UNKNOWN) |

Testler: yorum asla FACT/CONFIRMED olamaz; ölçülmeyen blokta sayısal alan `null`.

## `search_opportunity_inputs`

Skorkart ve fırsat üretimi için girdi. Mevcut `topicOpportunities` kuralı aynen kullanıldı
(marka dışı, sıra 5–30, gösterim ≥ 20, skor = gösterim / sıra; `criteria` bunları rapora yazar).
`opportunity_count` tablo kesilmesinden **bağımsız**, tüm sorgu satırlarından hesaplanır;
`candidates[]` en çok 15 aday. Bu bir **öneri değil, aday**dır ve yalnız onboard edilmiş site için
öneriye dönüşebilir (portföy izolasyonu kuralı).

## Skorkart (#38) tüketimi

`origin/claude/sprint-scorecard-orchestration` içindeki `src/scorecard.ts` `searchOpportunity()`
(salt-okunur incelendi, dal değiştirilmedi) şunları okuyor; alan adları buna hizalandı, takip
adaptörü tek satırlık:

| Skorkartın okuduğu | Bu şemada | Not |
|---|---|---|
| `raw.schema === "sgos.measure-report.v1"` | `schema` | aynı sabit |
| `raw.sites[siteId]` | `sites[siteId]` | nesne, dizi değil |
| `entry.generated_at ?? raw.generated_at` | `sites[id].generated_at` | ISO; tazelik eşiği için |
| `entry.gsc_state === "NOT_CONNECTED"` / `"CONNECTED"` | `sites[id].gsc_state` | `MEASURED` -> `CONNECTED`; `ERROR`, `UNKNOWN` aynen |
| `entry.opportunity_count` (sayı) | `sites[id].opportunity_count` | ölçülmediyse `null` (skorkart UNKNOWN verir) |

Skorkart etiketi INFERENCE/CANDIDATE basıyor; rapordaki `search_opportunity_inputs` etiketiyle
aynı. Skorkart daha zengin okumak isterse (`gsc.totals`, `brand_split`, `candidates`) alanlar
hazır; `gsc.state`'i (MEASURED/…) kullanmak `gsc_state` takma adından daha ayrıntılıdır.

## Sınırlar

- GA4 metrikleri şimdilik hep `null`: `measure` GA4'ü çağırmıyor.
- Sayfa ve sorgu×sayfa ölçümü yok.
- `queries[]` en çok 500 satır; kesilirse `queries_truncated = true` (toplam `query_rows_total`).
- Karşılaştırma yalnız yıl-yıl; "önceki 28 gün" ölçülmüyor.
- Üretici ağ çağrısı yapmaz; yalnız `measure`'ın çektiği veriyi serileştirir. Testler sahte `fetch` kullanır.
