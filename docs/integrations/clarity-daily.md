# Clarity günlük toplama (legacy site-health-monitor çıkışı)

## Durum (bu belgenin tarihi: 2026-10-02)

| Madde | Durum |
|---|---|
| **LEGACY SHM** | **STILL ACTIVE UNTIL LIVE CUTOVER.** CCR routine `trig_01Cr3tUKXBM9XHFEpGxmfhNc` (günlük 06:00 UTC) bu PR'da değiştirilmedi, kapatılmadı |
| P0 migration implementation | **READY / NOT YET LIVE VALIDATED** (offline testler yeşil; 7 sitenin hiçbirinde `clarity-daily` canlı koşmadı) |
| Credential rotation | **REQUIRED AFTER LEGACY DISABLE** (owner action; bu PR secret'a dokunmaz) |
| Canonical conflict'ler (3 + 1) | Ayrı backlog, **takeover blocker DEĞİL** |

Bu PR yalnız denetimde (2026-10-02) kanıtlanan iki P0'u kapatır: **P0-1** 7 site günlük Clarity toplama + kalıcılık, **P0-2** minimum Clarity alert.
**P0-SEC** (legacy routine prompt'undaki düz metin credential'lar) bu PR'ın konusu değildir.

## Başarı ölçütü: `measurement_success` (owner kararı, 2026-10-02)

> **Clarity takeover success measures observability coverage, not traffic volume.**
> **Confirmed complete zero response counts as a successful measurement.**
> **`usable` is an analysis/baseline eligibility concept, not a migration success criterion.**
> **Two consecutive full takeover validations require 7/7 `measurement_success=true`.**

`measurement_success = true` **yalnızca** `status == MEASURED` **ve** `confidence == CONFIRMED` **ve** `rows_complete == true` ise. `is_zero` bunu değiştirmez.
`usable = measurement_success && !is_zero` (yalnız analiz uygunluğu: baz, trend, friction alert).

| Durum | measurement_success | usable | is_zero | Baz | Friction alert | Bot alert |
|---|---|---|---|---|---|---|
| MEASURED + CONFIRMED + complete + sıfır değil | true | true | false | evet | evet | evet (koşullar sağlanırsa) |
| MEASURED + CONFIRMED + complete + **sıfır** | **true** | **false** | **true** | hayır | hayır | hayır (`total_sessions=0` ise `bot_pct` UNKNOWN) |
| NOT_CONNECTED | false | false | false | hayır | hayır | hayır |
| ERROR | false | false | false | hayır | hayır | hayır |
| PARTIAL / `rows_complete=false` | false | false | false | hayır | hayır | hayır |

Doğrulanmış sıfır: başarısızlık değildir, UNKNOWN değildir (sayılar gerçek 0; oturum alanları Traffic metriği yanıtta yoksa UNKNOWN kalır), baz olmaz, friction/bot alert üretmez.

Takeover'ın "taze" koşusu: o koşuda her site gerçekten API ile ölçülmüş olmalı (`fresh_measurement_success`). Aynı-gün guard'ı ile atlanan site önceki başarılı ölçümden miras kalır ve **taze sayılmaz** (`coverage` çıktısı ikisini ayrı verir).

**Geriye uyumluluk:** 2026-10-02 öncesi kayıtlarda `measurement_success` alanı yoktur; aynı kuraldan türetilir (`measurementSuccessOf`). Alan yazılıysa kuraldan türetilenle birebir aynı olmalıdır, değilse geçmiş dosyası bozuk sayılır (koşu kırmızı, üzerine yazılmaz).

## Ne yapar

`clarity-daily` (CLI) ve `.github/workflows/clarity-daily.yml`:

1. Registry'deki 7 siteyi sabit sırayla işler. Her site yalnız KENDİ token'ıyla, site başına 3 istek (en fazla 4 HTTP denemesi). 429'da yeniden deneme yok; 5xx'te sınırlı.
2. Her site/UTC gün için normalize bir kayıt üretir: `measurement_state`, `confidence`, `row_count`, `metric_row_count_total`, `max_metric_row_count`, `rows_complete`, `is_zero`, `usable`, friction (6 metrik + toplam), oturumlar (gerçek/bot/toplam/bot %).
3. Kaydı `data/clarity-history/<site_id>.json` dosyasına yazar (main'e commit; workflow). Site başına tek dosya, en fazla 120 gün.
4. İki sinyali deterministik değerlendirir (LLM yok, bildirim yok): friction artışı ve bot oranı.
5. Çıktı: `clarity-daily.md` (step summary), `clarity-alerts.json`, `clarity-<site>.json`, `clarity-summary.md` (artifact `clarity-daily-<run_id>`, 30 gün).

`clarity.yml` (elle, salt-okunur, Brain devri için) **değişmedi**; Brain handoff'u onu kullanmaya devam eder.

## Veri yok ≠ sıfır

| Durum | Sonuç |
|---|---|
| Token yok | `NOT_CONNECTED`; çağrı yok; sayılar `UNKNOWN`; `usable=false` |
| API hatası (401/403/429/5xx/ağ) | `ERROR`; sayılar `UNKNOWN`; `usable=false` |
| Bir istek düştü | `PARTIAL`; `usable=false` |
| Bir metrik 1000 satıra ulaştı | `rows_complete=false`; friction/oturum `UNKNOWN`; `usable=false` |
| Yanıtta bir friction metriği HİÇ yok | O metrik `UNKNOWN` (canlı yanıtlarda 9 metrik sıfır satırlarıyla hep döner; yokluk sıfır değildir) |
| 200 ve gerçekten satır yok (`is_zero`) | **Başarılı ölçüm** (`measurement_success=true`), `usable=false` (baz/alert olmaz) |

`usable=true` ⇔ `measurement_success` + gerçek-sıfır değil. **Yalnız usable kayıt baz olabilir ve alert üretebilir.** Takeover başarısı `usable`'a değil `measurement_success`'e bakar (yukarı).

## Ayni gün / duplicate

(site, UTC gün) başına **tek kayıt**. Birleştirme kuralı:

- gün yoksa ekle;
- mevcut kayıt **başarılı bir ölçümse** (`measurement_success`, doğrulanmış sıfır dahil) **dokunma** (ilk başarılı ölçüm kazanır; ikinci koşu geçmişi oynatamaz);
- mevcut kayıt başarısızsa (NOT_CONNECTED / ERROR / PARTIAL / kesik) yeni kayıt yerini alır;
- başarısız kayıt başarılı kaydı (doğrulanmış sıfır dahil) **asla** ezmez.

Kota koruması: aynı UTC günde **başarılı ölçümü** (`measurement_success`, sıfır dahil) olan site için **API çağrısı yapılmaz** (`SKIPPED_ALREADY_MEASURED_TODAY`). NOT_CONNECTED / ERROR / PARTIAL / `rows_complete=false` aynı gün başarılı yeniden denemeyi **engellemez**. Elle tekrar ve zamanlanmış koşu birbirinin kotasını yemez. `force` bunu bilerek aşar (kota harcar; başarılı kayıt yine değişmez).
Bozuk geçmiş dosyası **yalnız kendi sitesini** durdurur (kota harcanmaz, üzerine yazılmaz, iş kırmızı); diğer siteler ölçülür.

## Alert eşikleri (legacy `daily_health_check.py`'den koddan doğrulandı)

| Sinyal | Kural |
|---|---|
| Friction artışı | RageClick / ScriptError / ErrorClick / DeadClick için `bugün > 0` ve `bugün > önceki güvenilir ölçüm` (kesin artış). ExcessiveScroll ve QuickbackClick yalnız toplamaya girer (legacy ile aynı) |
| Bot oranı | `bot % > 50` ve `gerçek + bot oturum >= 5` (kesin büyük; tam %50 alert değil). Baz gerektirmez |

Bilinçli farklar: (1) önceki güvenilir ölçüm yoksa friction için "ilk kez görülen" alert'i **üretilmez** (`NO_BASELINE`, bot kontrolü yine çalışır); (2) baz = güncelden **eski** günlerin en yenisi olan **kullanılabilir** kayıt — UNKNOWN/hata günü ve aynı günün kaydı baz olamaz; (3) pencere 1 gün (legacy 3).
Alert etiketi: `FACT` / `CONFIRMED` / `REVIEW_REQUIRED` — iki ölçülmüş sayının karşılaştırmasıdır, kök neden iddia etmez.

Legacy'nin GSC click-drop alert'i **taşınmadı**: denetimde ölü kod olduğu (`prev` bugünkü satır yazıldıktan sonra okunuyor) kanıtlandı. Bu PR GSC'ye dokunmaz.

## Kota ve schedule

- Microsoft: proje başına 10 istek/gün. SGOS günlük koşusu 3 istek/site. Eski rutin (~06:10 UTC) açıkken 3 + 3 = 6/10; `clarity.yml` ile elle ek koşular bunu 9'a çıkarır. **Eski rutin kapanana kadar aynı gün başka Clarity koşusu yapma.**
- Cron `20 7 * * *` (07:20 UTC; eski rutinden sonra). **GitHub cron'u dosya main'e girer girmez çalışır**, bu yüzden zamanlanmış iş `vars.SEARCH_GROWTH_CLARITY_DAILY_ENABLED == 'true'` olmadıkça **atlanır** (skipped, API çağrısı yok). Elle başlatma bayrağa bağlı değildir.
- `concurrency: clarity` (`clarity.yml` ile aynı grup, iptal yok): iki Clarity işi aynı anda koşmaz.
- Workflow `contents: write` ister, **yalnız** `data/clarity-history/` commit'i için ve yalnız `main` üzerinde (`git pull --rebase` + `push`). main'e doğrudan push'a izin vermeyen bir branch protection varsa commit adımı başarısız olur (`measure.yml` aynı varsayımla çalışıyor).

## Cutover sırası (sıra bozulmaz)

1. PR merge. Bayrak yok ⇒ zamanlanmış koşu **atlanır**. Legacy routine açık kalır.
2. **Tek** kontrollü doğrulama: `Clarity daily (native, read-only)` → Run workflow (`site` boş, `force` kapalı, `commit_history` açık). Bütçe: 7 site × 3 = 21 istek (site başına 3/10; legacy aynı gün ~06:10'da 3 harcadıysa 6/10).
3. Doğrula: 7 site için `MEASURED` ya da gerçek yapılandırma durumu (`NOT_CONNECTED` = secret'ta o site için token yok, sıfır değil); token kapsamı; `data/clarity-history/*.json` main'de; `clarity-alerts.json` ve step summary; HTTP denemesi sayısı; 403/429 yok.
4. Sonuç temizse **legacy routine'i kapat** (owner action; bu PR dokunmaz).
5. **Credential rotation** (owner action): 7 Clarity token'ı, GSC refresh token, GSC OAuth client secret. Yeni Clarity token'larını `SEARCH_GROWTH_CLARITY_TOKENS_JSON` secret'ına yaz.
6. Repo değişkeni `SEARCH_GROWTH_CLARITY_DAILY_ENABLED=true` ayarla (zamanlanmış koşuyu açar).
7. Sonraki **zamanlanmış** koşuyu doğrula (07:20 UTC; history'ye yeni gün eklendi, çift kayıt yok).
8. Ancak bundan sonra legacy takeover COMPLETE.

Başarı ölçütü her adımda `measurement_success`'tir (7/7); `usable` değil. İki ardışık **tam** takeover doğrulaması: her biri 7/7 `measurement_success=true` ve bu koşuda 7/7 taze ölçüm.

## Bu PR'ın dokunmadıkları

Brain, index sistemi, canonical mantığı, GA4, GSC ölçüm semantiği, üretim siteleri, Vercel, DNS, `site-health-monitor` kodu/routine'i, secret'lar ve credential'lar.
