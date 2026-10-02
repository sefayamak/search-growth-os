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
(workflow bu PR'da değiştirilmedi): `measure` adımına `--out reports/runs` ve
"Raporu depoya yaz" adımına `git add reports/runs/measure-report.json`.

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
