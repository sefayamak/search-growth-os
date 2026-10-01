# Microsoft Clarity — native Search Growth OS adapter

Durum: Phase 2A. GSC, GA4 ve Clarity artık native Search Growth OS adapter'larıdır. Veri hattı **GitHub Actions runner'da** çalışır
(Claude Code runtime değildir). Eski `site-health-monitor`'a, kişisel bilgisayara ya da Chrome'a bağımlılık yoktur.

## Kaynak ve doğrulama sınırı

Aşağıdaki Microsoft Clarity Data Export API sınırları **resmi Microsoft dokümanında doğrulanmıştır** (FACT):

| Konu | Değer |
|---|---|
| Uç nokta | `GET https://www.clarity.ms/export-data/api/v1/project-live-insights` |
| Kimlik | `Authorization: Bearer <proje token'ı>` |
| Token | Project → Settings → Data Export → Generate new API token; yalnız proje admin'i yönetebilir |
| `numOfDays` | yalnız 1, 2 veya 3 (biz **hep 1**) |
| İstek boyutları | `Browser`, `Device`, `Country/Region`, `OS`, `Source`, `Medium`, `Campaign`, `Channel`, `URL` |
| Boyut sayısı | istek başına en fazla 3 |
| Günlük limit | proje başına en fazla **10 istek / gün** |
| Yanıt | en fazla **1000 satır**, sayfalama **yok** |
| Saat dilimi | UTC |
| Belgelenen hatalar | 400, 401, 403, 429 |

**Canlı doğrulama bekleyenler** (resmi doküman söylemiyor; ilk canlı koşu artifact'ıyla teyit edilecek):

- bizim gerçek proje token'larımızın çalışması
- yanıttaki `metricName` kümesi (kod, site-health-monitor'un çalışan kodundan türetilen adları tanır; bilinmeyenleri korur)
- yanıt satırındaki boyut-yankısı büyük/küçük harfi (`Url` mi `URL` mi)
- 1000 satır sınırının **çok-metrikli** yanıttaki sayım davranışı (aşağıya bakın)
- 5xx davranışı
- 5xx yeniden denemelerinin günlük kotayı tüketip tüketmediği

## Token üretimi

Clarity Project → Settings → Data Export → Generate new API token. Her sitenin Clarity projesi için ayrı token.

## `SEARCH_GROWTH_CLARITY_TOKENS_JSON`

Kanonik (tek) secret. **Site id** bazlı JSON; anahtarlar `config/sites.yaml` içindeki `id` değerleridir:

```json
{ "pamistanbul": "<token>", "pamaistudio": "<token>", "spryhand": "<token>", "decideplan": "<token>",
  "rightlisted": "<token>", "untitledportraits": "<token>", "myhappymade": "<token>" }
```

- Token'ı olmayan site → `NOT_CONNECTED`. Registry'de olmayan anahtar → kullanılmaz (yalnız adı uyarı olarak yazılır).
- Eski `site-health-monitor`'ın `CLARITY_TOKENS_JSON`'u **okunmaz** (domain bazlı anahtarlar; migrasyon için anahtarları site id'ye çevirip yeni secret'a elle taşı).
- Token yalnız `Authorization` başlığına girer. Log, hata mesajı, rapor, artifact ve CLI argümanında **bulunmaz**. `--token` argümanı reddedilir (değeri yankılanmaz).
  Uç nokta koda gömülüdür; ortam değişkeniyle değiştirilemez.

## İstek bütçesi

Bir koşuda **site başına 3 istek**, hepsi `numOfDays=1`:

1. `device`: `Device`
2. `acquisition`: `Source`, `Medium`
3. `content`: `URL` — **istek** boyutu resmi dokümandaki yazımla gönderilir (`dimension1=URL`). Yanıt satırındaki alan adı canlı örneklerde `Url` gelebilir (canlı doğrulanmadı); satır anahtarları büyük/küçük harfe duyarsız okunur. İstek yazımı ile yanıt yankısı farklı şeylerdir.

Neden 3: resmi günlük limit 10/proje. Bir koşu 3 harcar; aynı gün en fazla 3 koşu (9) güvenli. Kod ayrıca bir site için bir koşuda
**en fazla 4 HTTP denemesi** yapar (3 + yalnız 5xx için paylaşımlı 1 yeniden deneme). 401/403/429'dan sonra kalan istekler **atlanır**;
429 hiç yeniden denenmez. `clarity-smoke` API'ye gitmez (yoksa her koşu 6 istek yakardı). Günlük sayaç tutulmaz: limit insana ve
`concurrency` grubuna bırakılmıştır.

## UNKNOWN / zero

| Durum | Anlam |
|---|---|
| token yok | `NOT_CONNECTED` |
| 200 ve satır var | `MEASURED` |
| 200 ve gerçekten boş | `MEASURED`, `row_count: 0`, `is_zero: true` (ölçüldü, sıfır) |
| 400/401/403/429/5xx/timeout/geçersiz JSON/beklenmeyen şekil | `ERROR` + sebep kodu; `row_count`/`metric_row_count_total`/`max_metric_row_count: "UNKNOWN"`, `is_zero: false` |
| bazı istekler tamam, bazıları değil | `PARTIAL` (güven `CANDIDATE`) |

**Veri yok / ölçülemedi asla sıfır olmaz.** Bir sitenin hatası diğer sitelerin sonucunu etkilemez.

## 1000 satır sınırı ve satır sayıları

Yanıt `[{ metricName, information: [...] }]` biçimindedir; **aynı boyut satırı birçok metrik nesnesinde tekrarlanabilir**. Bu yüzden satır sayıları ayrı adlandırılır:

| Alan | Anlam |
|---|---|
| `metrics[].row_count` | o metriğin `information.length` değeri |
| `metric_row_count_total` | tüm metrik `information` satırlarının toplamı (benzersiz URL/satır sayısı **değildir**) |
| `max_metric_row_count` | tek bir metrikteki en yüksek satır sayısı |
| `row_count` | **geriye uyumluluk için** `metric_row_count_total` ile aynı değer; benzersiz URL/satır sayısı olarak okunmamalı |

Kesilme gözlemi yalnız `max_metric_row_count` ile yapılır: herhangi bir metrik **1000 satıra ulaştıysa** belgelenmiş sınıra temas edilmiştir →
`rows_complete: false`, güven `CANDIDATE`. Hiçbir metrik 1000'e ulaşmıyorsa, toplam 1000'i aşsa bile (ör. 9 metrik × 150 satır = 1350) **kesilme denmez**:
Microsoft'un sınırı çok-metrikli yanıtta nasıl saydığı canlı doğrulanmadı, ilk canlı koşuda gerçek payload üzerinden ayrıca teyit edilecek.
Bu PR'da tahminle kesinleştirilmedi.

## Normalize çıktı (Brain sözleşmesi, `sgos.clarity.v1`)

Site başına `clarity-<site>.json`. Kaynak/provenans alanları: `source`, `site_id`, `measured_at` (UTC), `evidence_label` (**FACT**), `measurement_state`
(`MEASURED | PARTIAL | ERROR | NOT_CONNECTED`), `confidence` (`CONFIRMED | CANDIDATE | UNKNOWN`). Ölçüm alanları: `window_days`, `requests[]`
(`dimensions`, `http_status`, `attempts`, `error_code`, `row_count`, `rows_complete`), `metrics[]`, `row_count` (= `metric_row_count_total`), `metric_row_count_total`, `max_metric_row_count`, `rows_complete`, `is_zero`.

Metrikler: Traffic, Engagement Time, Scroll Depth, Popular Pages, Dead/Rage Click Count, Quickback Click, Excessive Scroll, Script/Error Click Count.
Yanıttaki `metricName` **ham haliyle** `metric_name`'de korunur; bilinen adlar `metric_key`'e normalize edilir, **bilinmeyenler atılmaz** (`metric_key: null`).
Satırlarda URL'lerden sorgu dizesi ve fragment atılır; e-posta/IP/kullanıcı-oturum kimliği/çerez benzeri alanlar saklanmaz.

Evidence ontolojisi değişmedi (FACT / INFERENCE / HYPOTHESIS / RECOMMENDATION / IMPLEMENTED_CHANGE / VERIFIED_RESULT). Bu katman yalnız FACT üretir.

## Komutlar ve workflow

```bash
SEARCH_GROWTH_CLARITY_TOKENS_JSON='{"pamistanbul":"..."}' node --experimental-strip-types src/cli.ts clarity-smoke   config/sites.yaml   # offline
SEARCH_GROWTH_CLARITY_TOKENS_JSON='...'                    node --experimental-strip-types src/cli.ts clarity-measure config/sites.yaml [--site id] [--out dir]
```

`.github/workflows/clarity.yml`: yalnız `workflow_dispatch`, `contents: read`, depoya commit yok, artifact 30 gün. **Schedule yok.**
Çıkış kodu: `ERROR` ya da `PARTIAL` varsa 1 (iş kırmızı), `NOT_CONNECTED` değilse etkilemez.

## Legacy site-health-monitor sınırı

Bu fazda eski rutin **kapatılmadı, değiştirilmedi, arşivlenmedi**. Native hat en az **2 başarılı takeover koşusu** üretmeden legacy Clarity yolu kapatılmaz.
Kalıcı geçmiş (history) ve zamanlama ilk canlı doğrulamadan sonra ayrıca tasarlanır.
