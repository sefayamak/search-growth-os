# Microsoft Clarity — native Search Growth OS adapter

Durum: Phase 2A. GSC, GA4 ve Clarity artık native Search Growth OS adapter'larıdır. Veri hattı **GitHub Actions runner'da** çalışır
(Claude Code runtime değildir). Eski `site-health-monitor`'a, kişisel bilgisayara ya da Chrome'a bağımlılık yoktur.

## Kaynak ve doğrulama sınırı

Bu sayfadaki Microsoft sınırları **proje sahibinin görevde verdiği özetten** alınmıştır (Microsoft Clarity Data Export API resmi dokümanı).
Bu geliştirme ortamından Microsoft dokümanına **erişilemedi**; aşağıdaki sınırlar burada yeniden doğrulanmadı ve ilk canlı koşuda
davranışla teyit edilmelidir. Doğrulanmamış hiçbir şey FACT olarak yazılmadı.

| Sınır | Değer (proje sahibinden, doğrulanmamış) |
|---|---|
| Uç nokta | `GET https://www.clarity.ms/export-data/api/v1/project-live-insights` |
| Kimlik | `Authorization: Bearer <proje token'ı>` |
| `numOfDays` | yalnız 1, 2 veya 3 (biz **hep 1**) |
| Günlük limit | proje başına en fazla **10 istek / gün** |
| Boyut | istek başına en fazla 3 |
| Yanıt | en fazla **1000 satır**, sayfalama **yok** |
| Hatalar | 401/403 yetki, 429 günlük limit |
| Saat dilimi | UTC |

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
3. `content`: `Url` (boyut adı site-health-monitor'un çalışan kodundan alındı; büyük/küçük harf duyarlılığı doğrulanmadı, satır anahtarları duyarsız okunur)

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
| 400/401/403/429/5xx/timeout/geçersiz JSON/beklenmeyen şekil | `ERROR` + sebep kodu; `row_count: "UNKNOWN"`, `is_zero: false` |
| bazı istekler tamam, bazıları değil | `PARTIAL` (güven `CANDIDATE`) |

**Veri yok / ölçülemedi asla sıfır olmaz.** Bir sitenin hatası diğer sitelerin sonucunu etkilemez.

## 1000 satır sınırı

Sayfalama yok. Bir yanıtın toplam satırı 1000'e ulaşırsa `rows_complete: false` yazılır ve sonuç `CONFIRMED` değil `CANDIDATE` olur
(toplamlar gerçek toplamın alt sınırı olabilir).

## Normalize çıktı (Brain sözleşmesi, `sgos.clarity.v1`)

Site başına `clarity-<site>.json`. Kaynak/provenans alanları: `source`, `site_id`, `measured_at` (UTC), `evidence_label` (**FACT**), `measurement_state`
(`MEASURED | PARTIAL | ERROR | NOT_CONNECTED`), `confidence` (`CONFIRMED | CANDIDATE | UNKNOWN`). Ölçüm alanları: `window_days`, `requests[]`
(`dimensions`, `http_status`, `attempts`, `error_code`, `row_count`, `rows_complete`), `metrics[]`, `row_count`, `rows_complete`, `is_zero`.

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
