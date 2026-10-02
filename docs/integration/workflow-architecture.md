# Workflow mimarisi — #31–#38 yetenekleri mevcut iş grafiğine nasıl oturur

**Durum (2026-10-02):** yalnız plan. `.github/` altına **hiçbir dosya eklenmedi**; önerilen YAML aşağıda metin olarak durur ve geçici bir worktree'de
(`origin/main` + 8 dal + bağlama yaması) doğrulandı: PyYAML ile sözdizimi, `orchestration-check --drift` (drift yok), `npm run typecheck` (temiz).
Her zamanlanmış iş **bir repo değişkeniyle kapalı** gelir ve açılması owner onayı ister. Hiçbir iş üretim sitesine yazmaz; yazma yalnız bu depodaki
`data/` yollarına ve yalnız tek yazıcı işle yapılır.

Kaynaklar: `.github/workflows/*.yml` (8 dosya), `DEVAM.md`, `docs/operating-model.md`, `docs/integrations/clarity-daily.md`, üretici dalların belgeleri. Cron'lar UTC;
Europe/Istanbul = UTC+3.

---

## 1. Mevcut grafik (FACT, dosyalardan)

| Workflow | Tetik | Cron (UTC) | `permissions` | `concurrency` | Yazar | Kapı | Secret |
|---|---|---|---|---|---|---|---|
| `portfolio-check.yml` | dispatch + schedule | Pzt 06:10 | contents: read | `portfolio-check` | artifact | — (**aktif**) | yok ("Deliberately NOT here: any credential") |
| `measure.yml` | dispatch + schedule | Pzt 06:40 | contents: **write** | `measure` | `reports/measure-latest.md`, `reports/runs/`, `content/topic-ledger.json` → **main**; artifact | — (**aktif**) | GSC, GA4 |
| `search-audit.yml` | dispatch + schedule | Pzt 06:40 | contents: read | `search-audit-<site>` | artifact | — (**aktif**, tek site, sample) | yok |
| `tests.yml` | pull_request + push(main) + dispatch | — | contents: read | `tests-<pr/ref>` | — | — | yok |
| `clarity-daily.yml` | dispatch + schedule | her gün 07:20 | contents: **write** | **`clarity`** | `data/clarity-history/` → main; artifact | schedule: `vars.SEARCH_GROWTH_CLARITY_DAILY_ENABLED == 'true'` (**kapalı**) | Clarity tokens |
| `clarity.yml` | yalnız dispatch | — | contents: read | **`clarity`** | artifact (Brain devri) | schedule YOK (test zorlar) | Clarity tokens |
| `index-probe.yml` | yalnız dispatch | — | contents: read | `index-probe` | artifact | schedule YOK (**`tests/index-candidates.test.ts:286` zorlar**) | GSC |
| `brain.yml` | yalnız dispatch | — | contents: read + actions: read | `brain` | artifact | — | Anthropic anahtarı, `vars` model |
| (workflow dışı) legacy `site-health-monitor` | CCR routine, günlük | ~06:10 (model) / "06:00" (`clarity-daily.md`) | — | — | kendi deposu | owner kapatana kadar aktif | — |

Gözlemler:

- `measure.yml` ve `search-audit.yml` aynı dakikada (Pzt 06:40) tetiklenir: farklı kaynak, zararsız (model `INFO`).
- **`measure.yml` `git push`'u rebase'siz** (`clarity-daily.yml` `git pull --rebase origin main` kullanır). Bugün tek main-yazıcısı olduğu için sorun çıkmadı; ikinci yazıcı gelince yarış gerçek olur (bölüm 4).
- `tests.yml` `npm test` glob'u (`tests/*.test.ts`) ile yeni testleri **otomatik** koşar; ayrı workflow gerekmez. `tests/orchestration.test.ts` gerçek workflow dosyalarını okur: **her workflow değişikliği `src/orchestration.ts` modeliyle aynı PR'da** olmalı.
- Legacy rutinin saati iki yerde farklı yazılı (06:10 / 06:00); bu depodan doğrulanamaz → owner teyit. Kota/çakışma sonucunu değiştirmez (ikisi de 07:20'den önce).

---

## 2. Yetenek → workflow eşlemesi (önce mevcut olanlar)

| Yetenek | Karar | Gerekçe |
|---|---|---|
| Clarity takeover durumu (#31) | **`clarity-daily.yml` içinde bir adım** (salt-okunur, ağsız) + scorecard raporunda | Zaten Clarity işinin sahibi dosya; yeni zamanlayıcı yok. Koşu kaydı üreticisi eksik (B4) |
| İndeks alarmı + canonical backlog (#34) | **Yeni `index-alarms.yml`** (günlük, gated) | `index-probe.yml`'e eklemek bilerek reddedildi: dosya "elle, contents: read, schedule YOK" kararını taşıyor ve test zorluyor. Aynı CLI, aynı `index-probe` concurrency grubu → elle probe ile zamanlanmış koşu aynı anda çalışmaz. Probe'u workflow içinde bir kez koşup alarm adımını besler; tek yazıcı |
| Performans / CWV (#36) | **Yeni `lighthouse.yml`** (haftalık, gated) | `measure.yml`'e eklenmedi: PSI tek istek 20–40 sn (üretici belgesi) → `measure`'ın 20 dk timeout'unu zorlar ve GSC+GA4 ölçümünü kırmızı yapabilir; ayrı secret ve ayrı kota havuzu; bağımsız kapı/rollback. `portfolio-check`/`search-audit` bilerek secret'sız → uymaz |
| Deployment çizelgesi (#32) | **Yeni `deployment-timeline.yml`** (haftalık yoklama, gated). **Olay-tetikli DEĞİL** | Deploy olayları 7 ayrı **site** deposunda oluşur; bu depodaki `deployment_status` tetikleyicisi onları görmez. Olay iletmek site depolarına dokunmak demek → kapsam dışı. Registry'deki `repository` alanından `GET /deployments` yoklaması. Canlı SHA doğrulaması yok → tüm olaylar `UNVERIFIED` |
| Scorecard + orkestrasyon kontrolü (#38) | **Yeni `scorecard.yml`** (haftalık, gated, `contents: read`) | Haftalık yazıcıların **sonunda** koşmalı (workflow'lar arası `needs` yok; sıra cron aralığıyla). `portfolio-check` (06:10) çok erken; `measure.yml` yazma yetkili + GSC/GA4 secret'lı. Hiçbir şey commit etmez: step summary + artifact |
| İçerik hattı (#33), ajan sözleşmeleri (#35), değişiklik güvenliği (#37) | **Workflow YOK** | İnsan döngüsündeki, dosya girdili doğrulayıcılar (CLI). Bunlara bağlanacak otomatik girdi üreticisi yok (GSC→`GscRow` adaptörü, Brain→sözleşme adaptörü, ledger yazarı); boş çalışan zamanlanmış iş "sorun yok" izlenimi verirdi |
| `measure.yml` sertleştirme | **Küçük değişiklik:** `git pull --rebase` + sınırlı yeniden deneme | Ek main-yazıcılar geliyor (bölüm 4) |

**Reddedilen alternatifler:** lighthouse'ı `measure.yml`'in ikinci job'ı yapmak (aynı dispatch'te PSI kotası harcar, `measure` grubunu 40 dk bekletir); scorecard'ı `portfolio-check`'e adım yapmak
(yanlış sıra: veriden önce koşar); indeks alarmını `index-probe.yml`'e eklemek (test + güvenlik duruşu); tüm yazıcıları tek paylaşılan concurrency grubuna koymak (bölüm 4: bekleyen koşu iptal edilir).

---

## 3. Zaman çizelgesi

### Günlük (UTC; her gün)

| Saat | İş | Durum | Not |
|---|---|---|---|
| ~06:10 | legacy `site-health-monitor` (CCR) | aktif | Clarity 3 istek/proje. Owner kapatana kadar |
| 07:20 | `clarity-daily` | **gated** (`SEARCH_GROWTH_CLARITY_DAILY_ENABLED`) | 3 istek/site; `clarity` grubu |
| 07:40 | `index-alarms` | **gated, yeni** (`SEARCH_GROWTH_INDEX_ALARMS_ENABLED`) | yalnız pamistanbul, limit 20 (property günlük 2000'in %1'i) |

### Haftalık (Pazartesi, UTC)

| Saat | İş | Yazdığı | Not |
|---|---|---|---|
| 06:10 | `portfolio-check` | artifact | aktif |
| 06:40 | `measure` | `reports/`, `content/topic-ledger.json` | aktif |
| 06:40 | `search-audit` | artifact | aktif |
| 07:10 | `lighthouse` | `data/performance-history/` | **gated, yeni** (`SEARCH_GROWTH_LIGHTHOUSE_ENABLED`) |
| 07:55 | `deployment-timeline` | `data/deployment-timeline/` | **gated, yeni** (`SEARCH_GROWTH_DEPLOYMENT_TIMELINE_ENABLED`) |
| 08:10 | `scorecard` | artifact (commit yok) | **gated, yeni** (`SEARCH_GROWTH_SCORECARD_ENABLED`); hepsinden sonra |

Pazartesi dışında günlük işler dışında bir şey koşmaz. Cron dakikaları :00/:30 dışında seçildi (yoğun saat gecikmesi). GitHub zamanlanmış koşuyu geciktirebilir: scorecard sıraya **güvenmez**, girdi bayatsa
`UNKNOWN-STALE` yazar (varsayılan sınır: clarity/index 3 gün, performans/ölçüm/deployment 10 gün).

### Aylık

**Zamanlanmış aylık iş yok ve eklenmedi** (orkestrasyon modeli de "monthly döngüde henüz iş yok" diyor; uydurma iş eklenmez). Aylık ritim `docs/operating-model.md` gereği **elle/dispatch**:

| Ritüel | Araç | Çıktı |
|---|---|---|
| Canonical backlog incelemesi (yaşlanma kovaları; `owner_status` yalnız sahip tarafından, PR ile) | `index-alarms` raporu + `data/canonical-backlog/` | owner kararı |
| Tam site taraması | `search-audit` dispatch, `mode=full` | `reports/runs` artifact |
| İç link / schema önerileri kuyruğu | `agent-contracts-validate` (elle) | inceleme kuyruğu |
| Kota ve model gözden geçirme | `orchestration-check` + `scorecard` | `DUPLICATE_SCHEDULER`/`QUOTA_*` bulguları |

---

## 4. Tek yazıcı kuralı ve commit yarışı

**Kural:** her `data/…` yolunun **tek** yazıcı işi vardır; başka hiçbir iş o yola `git add` etmez. Okuyucular (scorecard, takeover-status) yalnız okur.

| Yol | Tek yazıcı | Concurrency grubu | Okuyucular |
|---|---|---|---|
| `data/clarity-history/` | `clarity-daily.yml` | `clarity` (**`clarity.yml` ile paylaşımlı**: Clarity kotası) | scorecard, takeover-status |
| `data/performance-history/` | `lighthouse.yml` | `lighthouse` | scorecard |
| `data/index-history/`, `data/canonical-backlog/` | `index-alarms.yml` | `index-probe` (**elle `index-probe.yml` ile paylaşımlı**) | scorecard (B1: şu an okuyamıyor) |
| `data/deployment-timeline/` | `deployment-timeline.yml` | `deployment-timeline` | scorecard (B1) |
| `reports/measure-latest.md`, `reports/runs/<tarih>-measure.md`, `content/topic-ledger.json` | `measure.yml` | `measure` | insanlar/ajanlar |
| scorecard çıktısı | — (commit **yok**; artifact + summary) | `scorecard` | — |

**Yarış protokolü.** (1) Yollar ayrık → `git rebase` çakışması yok. (2) Her iş yalnız **kendi** yolunu `git add` eder. (3) Commit sonrası `git pull --rebase origin main && git push`, **3 deneme**,
aralarda 5/10/15 sn; asla `--force`. (4) Değişiklik yoksa commit yok. (5) Bot kimliği ve `contents: write` yalnız yazıcı işlerde; `main` dışı ref'te commit adımı atlanır (`github.ref == 'refs/heads/main'`).

**Neden tek paylaşımlı grup değil?** GitHub concurrency grubunda **en fazla bir çalışan + bir bekleyen** iş olur ve yeni bekleyen eskisini iptal eder: yedi yazıcıyı tek gruba koymak,
bir zamanlanmış koşunun sessizce iptal edilmesine yol açar. Gruplar yalnız **kota/sahiplik** için paylaşılır (`clarity`, `index-probe`).

**Gerçek örtüşme riski.** Pazartesi `measure` (06:40, timeout 20 dk) 07:00'de biter; ama `lighthouse` (07:10, timeout 40 dk) → `clarity-daily` (07:20), `index-alarms` (07:40), `deployment-timeline` (07:55) ile
**çakışabilir**. Hepsi `main`'e push ettiği için rebase+yeniden deneme zorunludur; bu yüzden `measure.yml`'deki rebase'siz `git push` ilk iş olarak düzeltilir (bölüm 7.1).
**Varsayım (doğrulanmadı):** `github-actions[bot]`'un `main`'e doğrudan push'u bugün çalışıyor (main'de `clarity: gunluk ozet … (otomatik)` commit'leri var); ileride branch protection eklenirse **bütün yazıcılar kırmızı** olur.

---

## 5. Clarity: ikinci zamanlayıcı yok, kota 3+3(+3)

- Günlük zamanlayıcı **yalnız** `clarity-daily` (+ owner kapatana kadar legacy). **`clarity.yml`'e schedule eklenmez** (test zorlar). `scorecard`, `takeover-status`, `orchestration-check` Clarity'ye **hiç** çağrı yapmaz.
- Kota (Microsoft: proje başına 10 istek/gün, `clarity-daily.md`): legacy 3 + `clarity-daily` 3 + `clarity.yml` (Brain devri) 3 = **9/10** en kötü gün (model `QUOTA_NEAR_LIMIT`).
  `clarity-daily --force` aynı günde 3 daha ekler → **12 > 10**: `force` yalnız legacy kapandıktan sonra ya da `clarity.yml` o gün koşmadıysa. Aynı-gün guard'ı (başarılı kayıt varsa 0 çağrı) normal yolda bunu önler.
- Legacy kapanınca: 3 + (3 manuel) = 6/10 (`force` ile 9). Model `legacy-site-health-monitor.state → DISABLED` olur; `DUPLICATE_SCHEDULER` ve `QUOTA_NEAR_LIMIT` söner.
- **Legacy'yi, `clarity-daily` iki ardışık tam doğrulamadan ve bayraktan sonraki ilk zamanlanmış koşu doğrulanmadan KAPATMA** (cutover sırası `clarity-daily.md`). Sonradan geri dönüş: bayrağı `false` yaparsan **legacy kapalıysa günlük Clarity toplaması durur**
  (elle `clarity-daily` dispatch kalır) — bu yüzden sıra bozulmaz.

---

## 6. Kapılar: değişkenler ve secret'lar

Değişken **tanımsız = iş ATLANIR** (skipped; API çağrısı yok). Elle başlatma (dispatch) kapıya bağlı değildir (insan eylemi; mevcut `clarity-daily` deseni). `vars` yalnız repo yöneticisi ayarlayabilir;
`GITHUB_TOKEN` değişken yazamaz → **otomasyon kendi kendini açamaz**. Açma = (1) workflow PR'ını owner merge eder, (2) owner değişkeni `true` yapar.

| Değişken | Kapıladığı iş | Varsayılan | Kim ayarlar |
|---|---|---|---|
| `SEARCH_GROWTH_CLARITY_DAILY_ENABLED` | `clarity-daily.yml` (mevcut) | tanımsız | owner, cutover adım 6 sonrası |
| `SEARCH_GROWTH_LIGHTHOUSE_ENABLED` | `lighthouse.yml` | tanımsız | owner |
| `SEARCH_GROWTH_INDEX_ALARMS_ENABLED` | `index-alarms.yml` | tanımsız | owner |
| `SEARCH_GROWTH_DEPLOYMENT_TIMELINE_ENABLED` | `deployment-timeline.yml` | tanımsız | owner |
| `SEARCH_GROWTH_SCORECARD_ENABLED` | `scorecard.yml` | tanımsız | owner |
| `SEARCH_GROWTH_SCHEDULES_PAUSED` | yukarıdaki **yeni** işlerin hepsi (`!= 'true'` koşulu) | tanımsız | owner (acil durdurma; mevcut `clarity-daily` bu koşula **eklenmedi**, ayrı karar) |

| Secret (yalnız ad; değer yok) | Kullanan | Durum |
|---|---|---|
| `SEARCH_GROWTH_PAGESPEED_API_KEY` → env `PAGESPEED_API_KEY` | `lighthouse.yml` | **yeni**, owner oluşturur. Yoksa `NOT_CONNECTED`, iş yeşil |
| `SEARCH_GROWTH_GITHUB_READ_TOKEN` → env `GH_TOKEN` | `deployment-timeline.yml` | **yeni**, owner oluşturur: fine-grained, salt-okunur (Deployments: read + Metadata: read), **yalnız 7 site deposu**. Yoksa `NOT_CONNECTED`, iş yeşil |
| `SEARCH_GROWTH_GSC_CREDENTIALS_JSON` | `index-alarms.yml` (mevcut secret) | var |
| `SEARCH_GROWTH_CLARITY_TOKENS_JSON` | `clarity-daily.yml` (mevcut) | var |

`GITHUB_TOKEN` başka depoları okuyamaz; bu yüzden deployment işi ayrı token ister. Token yoksa "sıfır deploy" yazılmaz.

---

## 7. Önerilen değişiklikler (METİN; `.github/` altına eklenmedi)

Aşağıdaki dosyalar `origin/main` + 8 dal + bağlama yamasında deneme olarak yazıldı: PyYAML sözdizimi geçti, `orchestration-check --drift` **drift yok** döndü. Action SHA'ları mevcut workflow'larla aynı.
Her workflow PR'ında `src/orchestration.ts` + ilgili test **aynı PR'da** güncellenir (bölüm 7.6).

### 7.1 `measure.yml` — rebase + yeniden deneme (mevcut dosyada tek değişiklik)

```diff
diff --git a/.github/workflows/measure.yml b/.github/workflows/measure.yml
index 38d2e21..5220ba8 100644
--- a/.github/workflows/measure.yml
+++ b/.github/workflows/measure.yml
@@ -178,5 +178,10 @@ jobs:
           # Değişiklik yoksa commit etme: her hafta boş commit atmak geçmişi kirletir.
           git diff --cached --quiet || git commit -m "ölçüm: $(date -u +%Y-%m-%d) (otomatik)"
-          git push
+          # Diger yazicilar (clarity-daily, performance, index, deployment) ayni main'e ayri yollara commit eder: rebase + sinirli yeniden deneme.
+          for i in 1 2 3; do
+            git pull --rebase origin main && git push && exit 0
+            sleep $((i * 5))
+          done
+          echo "push basarisiz (3 deneme)"; exit 1
 
       - name: Artifact
```

### 7.2 `clarity-daily.yml` — takeover durumu adımı (salt-okunur)

```diff
diff --git a/.github/workflows/clarity-daily.yml b/.github/workflows/clarity-daily.yml
index 3f8fdd9..0128b3b 100644
--- a/.github/workflows/clarity-daily.yml
+++ b/.github/workflows/clarity-daily.yml
@@ -92,4 +92,10 @@ jobs:
           git push
 
+      # Salt-okunur ve agsiz: commit'li gecmisten takeover zinciri. Kosu kaydi (--runs) verilmedikce tazelik UNKNOWN ve FULL_TAKEOVER iddia edilmez.
+      - name: Takeover durumu
+        if: always()
+        run: |
+          node --experimental-strip-types src/cli.ts clarity-takeover-status config/sites.yaml --history data/clarity-history >> "$GITHUB_STEP_SUMMARY" || echo "takeover durumu uretilemedi" >> "$GITHUB_STEP_SUMMARY"
+
       - name: Artifact
         if: always()
```

### 7.3 `lighthouse.yml` (yeni)

```yaml
# Search Growth OS — performans / Core Web Vitals (PageSpeed Insights + CrUX, salt-okunur)
#
# NEDEN AYRI DOSYA: farkli secret (PSI anahtari), farkli kota havuzu, ~3x daha uzun sure (PSI tek istek 20-40 sn) ve
# bagimsiz kapi/rollback. measure.yml'e eklenseydi 20 dk'lik timeout'u zorlar, GSC+GA4 olcumunun kirmizi olmasina
# neden olabilirdi.
#
# YAZMA: yalniz `data/performance-history/` (bu depo, main). Hicbir uretim sitesine yazilmaz; PSI yalniz GET.
# Anahtar YALNIZCA `secrets.*` -> env; CLI argumani, log, artifact, commit'e girmez. Anahtar yoksa NOT_CONNECTED, iş yeşil, istek yok.
# KAPI: zamanlanmis kosu repo degiskeni SEARCH_GROWTH_LIGHTHOUSE_ENABLED == 'true' olmadikca ATLANIR. Elle baslatma (dispatch) kapiya bagli degil.

name: Performance (PSI/CrUX, read-only)

on:
  workflow_dispatch:
    inputs:
      site:
        description: "Tek site kimligi (bos = registry'deki tum siteler)."
        type: string
        default: ""
      write_history:
        description: "Gecmisi main'e yaz (kapatirsan yalniz artifact uretir)."
        type: boolean
        default: true
  schedule:
    # 07:10 UTC Pazartesi (10:10 Europe/Istanbul) — measure (06:40) sonrasi, scorecard (08:10) oncesi.
    - cron: "10 7 * * 1"

permissions:
  contents: write # yalniz data/performance-history/ commit'i icin

concurrency:
  group: lighthouse
  cancel-in-progress: false

jobs:
  performance:
    name: PSI olcumu (varsayilan ana sayfa, mobile)
    if: github.event_name == 'workflow_dispatch' || (vars.SEARCH_GROWTH_LIGHTHOUSE_ENABLED == 'true' && vars.SEARCH_GROWTH_SCHEDULES_PAUSED != 'true')
    runs-on: ubuntu-latest
    timeout-minutes: 40
    steps:
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2

      - uses: actions/setup-node@39370e3970a6d050c480ffad4ff0ed4d3fdee5af # v4.1.0
        with:
          node-version: "24"

      - name: Registry gate
        run: node --experimental-strip-types src/cli.ts registry config/sites.yaml

      - name: PSI olcumu
        env:
          PAGESPEED_API_KEY: ${{ secrets.SEARCH_GROWTH_PAGESPEED_API_KEY }}
          SITE: ${{ inputs.site }}
          EVENT: ${{ github.event_name }}
          WRITE_HISTORY: ${{ inputs.write_history }}
        run: |
          set -o pipefail
          case "$SITE" in ''|*[!a-z0-9]*) [ -z "$SITE" ] || { echo "site kimligi kucuk harf/rakam olmali"; exit 1; };; esac
          WRITE_FLAG="--write"; [ "$EVENT" = "workflow_dispatch" ] && [ "$WRITE_HISTORY" != "true" ] && WRITE_FLAG=""
          node --experimental-strip-types src/cli.ts performance-measure config/sites.yaml ${SITE:+--site "$SITE"} \
            --strategy mobile --max-requests 35 --history data/performance-history --out performance-out $WRITE_FLAG | tee performance.txt

      - name: Ozet
        if: always()
        run: |
          { cat performance-out/performance-report.md 2>/dev/null || echo "Performans raporu uretilemedi — adim loglarina bak."; } >> "$GITHUB_STEP_SUMMARY"

      # Tek yazar: bu is data/performance-history/'in TEK yazicisidir. Yalniz kendi yolunu ekler; commit sonrasi rebase + sinirli yeniden deneme.
      - name: Gecmisi main'e yaz
        if: always() && github.ref == 'refs/heads/main' && (github.event_name == 'schedule' || inputs.write_history)
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
          git add data/performance-history/
          git diff --cached --quiet && { echo "gecmis degismedi"; exit 0; }
          git commit -m "performance: PSI gecmisi $(date -u +%Y-%m-%d) (otomatik)"
          for i in 1 2 3; do
            git pull --rebase origin main && git push && exit 0
            sleep $((i * 5))
          done
          echo "push basarisiz (3 deneme)"; exit 1

      - name: Artifact
        if: always()
        uses: actions/upload-artifact@6f51ac03b9356f520e9adb1b1b7802705f340c2b # v4.5.0
        with:
          name: performance-${{ github.run_id }}
          path: |
            performance-out/
            performance.txt
          retention-days: 30
          if-no-files-found: warn
```

### 7.4 `index-alarms.yml` (yeni; `index-probe.yml` değişmez)

```yaml
# Search Growth OS — indeks alarmlari + canonical backlog (pamistanbul, salt-okunur URL Inspection ORNEKLEMI)
#
# NEDEN index-probe.yml'e EKLENMEDI: o dosya bilerek "elle, contents: read, schedule YOK" (tests/index-candidates.test.ts bunu zorlar).
# Bu is onun yerine gecmez; ayni CLI'yi cagirir, gozlemi gecmise ekler ve TEK yazicidir. Concurrency grubu `index-probe` ile AYNI:
# elle probe ile zamanlanmis alarm kosusu ayni anda koşmaz (URL Inspection kotasi: property basina gunluk 2000; bu is limit 20).
#
# ORNEKLEM: tam coverage degil. Alarm yalniz iki ardisik gozlemde (>24 saat) "indekslenmeli" kosullari saglanirken INDEXED olmayan URL icin
# uretilir; INFERENCE / CANDIDATE / REVIEW_REQUIRED. Sitemap uyeligi yalniz `segmented` stratejide bilinir (gsc'de UNKNOWN: alarm uretilemez).
# YAZMA: yalniz data/index-history/ + data/canonical-backlog/ (bu depo, main). Google Indexing API yok. Uretim sitesine yazilmaz.
# KAPI: zamanlanmis kosu SEARCH_GROWTH_INDEX_ALARMS_ENABLED == 'true' olmadikca ATLANIR. Dispatch kapiya bagli degil.

name: Index alarms (pamistanbul, read-only sample)

on:
  workflow_dispatch:
    inputs:
      limit:
        description: "Kosu basina en fazla kac URL (varsayilan 20, kod sert tavani 100)"
        type: string
        default: "20"
      record_history:
        description: "Gozlemi gecmise yaz ve main'e commit et (kapatirsan yalniz artifact)."
        type: boolean
        default: true
  schedule:
    # 07:40 UTC her gun (10:40 Europe/Istanbul).
    - cron: "40 7 * * *"

permissions:
  contents: write # yalniz data/index-history/ + data/canonical-backlog/ commit'i icin

concurrency:
  group: index-probe
  cancel-in-progress: false

jobs:
  alarms:
    name: index-probe (SAMPLE) + alarm gecmisi
    if: github.event_name == 'workflow_dispatch' || (vars.SEARCH_GROWTH_INDEX_ALARMS_ENABLED == 'true' && vars.SEARCH_GROWTH_SCHEDULES_PAUSED != 'true')
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2

      - uses: actions/setup-node@39370e3970a6d050c480ffad4ff0ed4d3fdee5af # v4.1.0
        with:
          node-version: "24"

      - name: Registry gate
        run: node --experimental-strip-types src/cli.ts registry config/sites.yaml

      - name: index-probe (segmented)
        env:
          SEARCH_GROWTH_GSC_CREDENTIALS_JSON: ${{ secrets.SEARCH_GROWTH_GSC_CREDENTIALS_JSON }}
          LIMIT: ${{ inputs.limit || '20' }}
        run: |
          set -o pipefail
          case "$LIMIT" in ''|*[!0-9]*) echo "limit sayi olmali"; exit 1;; esac
          node --experimental-strip-types src/cli.ts inspect-index config/sites.yaml --site pamistanbul --limit "$LIMIT" --strategy segmented --write | tee probe.md

      - name: Indeks alarmlari (gecmis + canonical backlog)
        if: always()
        env:
          EVENT: ${{ github.event_name }}
          RECORD: ${{ inputs.record_history }}
        run: |
          set -o pipefail
          F="sites/pamistanbul/index-baseline/$(date -u +%Y-%m-%d)-index-probe.json"
          [ -f "$F" ] || { echo "bugunun probe ciktisi yok: gecmise YAZILMADI (bos gozlem 'sorun yok' demek degildir)" | tee index-alarms.md; exit 0; }
          WRITE_FLAG="--write"; [ "$EVENT" = "workflow_dispatch" ] && [ "$RECORD" != "true" ] && WRITE_FLAG=""
          node --experimental-strip-types src/cli.ts index-alarms config/sites.yaml --site pamistanbul --probe "$F" $WRITE_FLAG | tee index-alarms.md

      - name: Ozet
        if: always()
        run: |
          for f in probe.md index-alarms.md; do [ -f "$f" ] && { cat "$f"; echo; } >> "$GITHUB_STEP_SUMMARY"; done
          true

      - name: Gecmisi main'e yaz
        if: always() && github.ref == 'refs/heads/main' && (github.event_name == 'schedule' || inputs.record_history)
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
          git add data/index-history/ data/canonical-backlog/
          git diff --cached --quiet && { echo "gecmis degismedi"; exit 0; }
          git commit -m "index: gozlem $(date -u +%Y-%m-%d) (otomatik)"
          for i in 1 2 3; do
            git pull --rebase origin main && git push && exit 0
            sleep $((i * 5))
          done
          echo "push basarisiz (3 deneme)"; exit 1

      - name: Artifact
        if: always()
        uses: actions/upload-artifact@6f51ac03b9356f520e9adb1b1b7802705f340c2b # v4.5.0
        with:
          name: index-alarms-${{ github.run_id }}
          path: |
            probe.md
            index-alarms.md
            sites/pamistanbul/index-baseline/
          retention-days: 30
          if-no-files-found: warn
```

### 7.5 `deployment-timeline.yml` (yeni)

```yaml
# Search Growth OS — deploy zaman cizelgesi (GitHub Deployments, salt-okunur)
#
# NEDEN OLAY-TETIKLI DEGIL: deploy olaylari siteleri barindiran 7 AYRI depoda olusur; bu depodaki bir `deployment_status`
# tetikleyicisi onlari gormez. Olay iletmek (repository_dispatch/webhook) uretim sitesi depolarina dokunmayi gerektirir: kapsam disi.
# Bu yuzden haftalik YOKLAMA: her sitenin registry'deki `repository` alani icin GET /deployments (yalniz okuma).
#
# KIMLIK: salt-okunur fine-grained token (Deployments: read + Metadata: read, yalniz 7 site deposu) -> SEARCH_GROWTH_GITHUB_READ_TOKEN.
# GITHUB_TOKEN baska depolari okuyamaz. Token yoksa NOT_CONNECTED: is yesil, hicbir olay uretilmez, sayi uydurulmaz.
# TUM olaylar UNVERIFIED kalir: canli SHA probe'u (sitede meta/header) bu repoda yok ve site sahibinin karari gerektirir.
# `created_at` kaydin olusma zamanidir, canliya cikis ani DEGIL: korelasyon yalniz INFERENCE/CANDIDATE.
# KAPI: zamanlanmis kosu SEARCH_GROWTH_DEPLOYMENT_TIMELINE_ENABLED == 'true' olmadikca ATLANIR.

name: Deployment timeline (read-only)

on:
  workflow_dispatch:
    inputs:
      write_history:
        description: "Cizelgeyi main'e yaz (kapatirsan yalniz artifact)."
        type: boolean
        default: true
  schedule:
    # 07:55 UTC Pazartesi (10:55 Europe/Istanbul) — scorecard (08:10) oncesi.
    - cron: "55 7 * * 1"

permissions:
  contents: write # yalniz data/deployment-timeline/ commit'i icin

concurrency:
  group: deployment-timeline
  cancel-in-progress: false

jobs:
  timeline:
    name: GitHub Deployments yoklamasi
    if: github.event_name == 'workflow_dispatch' || (vars.SEARCH_GROWTH_DEPLOYMENT_TIMELINE_ENABLED == 'true' && vars.SEARCH_GROWTH_SCHEDULES_PAUSED != 'true')
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2

      - uses: actions/setup-node@39370e3970a6d050c480ffad4ff0ed4d3fdee5af # v4.1.0
        with:
          node-version: "24"

      - name: Registry gate
        run: node --experimental-strip-types src/cli.ts registry config/sites.yaml

      - name: Yokla ve cizelgeye ekle
        env:
          GH_TOKEN: ${{ secrets.SEARCH_GROWTH_GITHUB_READ_TOKEN }}
          EVENT: ${{ github.event_name }}
          WRITE_HISTORY: ${{ inputs.write_history }}
        run: |
          set -o pipefail
          if [ -z "$GH_TOKEN" ]; then echo "NOT_CONNECTED: SEARCH_GROWTH_GITHUB_READ_TOKEN yok; olay uretilmedi (sifir degil)."; exit 0; fi
          WRITE_FLAG="--write"; [ "$EVENT" = "workflow_dispatch" ] && [ "$WRITE_HISTORY" != "true" ] && WRITE_FLAG=""
          node --experimental-strip-types -e 'import("./src/registry.ts").then((m)=>{for(const s of m.loadRegistry("config/sites.yaml").registry.sites)console.log(s.id,s.repository)})' > sites.txt
          FAIL=0
          while read -r ID REPO; do
            case "$ID" in ''|*[!a-z0-9]*) echo "gecersiz site kimligi"; FAIL=1; continue;; esac
            case "$REPO" in */*) ;; *) echo "ATLANDI $ID: registry'de repository yok (UNKNOWN)"; continue;; esac
            # </dev/null: gh/node dongunun stdin'ini (sites.txt) yemesin.
            if gh api "repos/$REPO/deployments?per_page=30" > "dep-$ID.json" </dev/null; then
              node --experimental-strip-types src/cli.ts deployment-ingest "dep-$ID.json" --site "$ID" --provider github $WRITE_FLAG </dev/null || FAIL=1
            else
              echo "ERISILEMEDI $ID ($REPO): token kapsami/izin"; FAIL=1
            fi
          done < sites.txt > timeline.txt 2>&1
          # Dongu boru hattinda DEGIL (FAIL alt kabukta kaybolmasin).
          cat timeline.txt
          exit $FAIL

      - name: Ozet
        if: always()
        run: |
          { cat timeline.txt 2>/dev/null || echo "Cizelge raporu uretilemedi."; } >> "$GITHUB_STEP_SUMMARY"

      - name: Cizelgeyi main'e yaz
        if: always() && github.ref == 'refs/heads/main' && (github.event_name == 'schedule' || inputs.write_history)
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
          git add data/deployment-timeline/
          git diff --cached --quiet && { echo "cizelge degismedi"; exit 0; }
          git commit -m "deployment: zaman cizelgesi $(date -u +%Y-%m-%d) (otomatik)"
          for i in 1 2 3; do
            git pull --rebase origin main && git push && exit 0
            sleep $((i * 5))
          done
          echo "push basarisiz (3 deneme)"; exit 1

      - name: Artifact
        if: always()
        uses: actions/upload-artifact@6f51ac03b9356f520e9adb1b1b7802705f340c2b # v4.5.0
        with:
          name: deployment-timeline-${{ github.run_id }}
          path: |
            timeline.txt
            data/deployment-timeline/
          retention-days: 30
          if-no-files-found: warn
```

### 7.6 `scorecard.yml` (yeni)

```yaml
# Search Growth OS — haftalik scorecard (salt-okunur, AGSIZ, secret YOK)
#
# NEDEN AYRI DOSYA: scorecard, haftalik yazicilarin (measure 06:40, performance 07:10, deployment 07:55) SONUNDA ve onlarin
# commit ettigi dosyalari okuyarak calismali; baska bir workflow'a `needs` ile baglanamaz (workflow'lar arasi bagimlilik yok),
# sira cron araligiyla saglanir. portfolio-check (06:10) cok erken, measure.yml ise yazma yetkili ve GSC/GA4 secret'li: ikisi de uymaz.
# Bu is HICBIR SEY commit etmez (contents: read): ciktisi step summary + artifact. Girdisi bayatsa boyut UNKNOWN-STALE olur, OK olmaz.
#
# KAPI: zamanlanmis kosu repo degiskeni SEARCH_GROWTH_SCORECARD_ENABLED == 'true' olmadikca ATLANIR. Dispatch kapiya bagli degil.

name: Scorecard (read-only, offline)

on:
  workflow_dispatch:
  schedule:
    # 08:10 UTC Pazartesi (11:10 Europe/Istanbul) — tum haftalik yazicilardan sonra.
    - cron: "10 8 * * 1"

permissions:
  contents: read

concurrency:
  group: scorecard
  cancel-in-progress: false

jobs:
  scorecard:
    name: scorecard + orkestrasyon kontrolu
    if: github.event_name == 'workflow_dispatch' || (vars.SEARCH_GROWTH_SCORECARD_ENABLED == 'true' && vars.SEARCH_GROWTH_SCHEDULES_PAUSED != 'true')
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2

      - uses: actions/setup-node@39370e3970a6d050c480ffad4ff0ed4d3fdee5af # v4.1.0
        with:
          node-version: "24"

      - name: Registry gate
        run: node --experimental-strip-types src/cli.ts registry config/sites.yaml

      - name: Scorecard
        run: |
          set -o pipefail
          node --experimental-strip-types src/cli.ts scorecard config/sites.yaml --json > scorecard.json
          node --experimental-strip-types src/cli.ts scorecard config/sites.yaml | tee scorecard.md

      # Legacy rutin DISABLED olana kadar DUPLICATE_SCHEDULER (ERROR) beklenir: bu adim bilgi verir, isi kirmizi yapmaz.
      # Legacy kapaninca `continue-on-error` KALDIRILIR (rollback/enable dizisi: docs/integration/workflow-architecture.md).
      - name: Orkestrasyon kontrolu (+ drift)
        continue-on-error: true
        run: |
          set -o pipefail
          node --experimental-strip-types src/cli.ts orchestration-check --drift | tee orchestration.md

      - name: Clarity takeover durumu
        run: |
          set -o pipefail
          node --experimental-strip-types src/cli.ts clarity-takeover-status config/sites.yaml --history data/clarity-history | tee takeover.md

      - name: Ozet
        if: always()
        run: |
          for f in scorecard.md orchestration.md takeover.md; do [ -f "$f" ] && { cat "$f"; echo; } >> "$GITHUB_STEP_SUMMARY"; done
          true

      - name: Artifact
        if: always()
        uses: actions/upload-artifact@6f51ac03b9356f520e9adb1b1b7802705f340c2b # v4.5.0
        with:
          name: scorecard-${{ github.run_id }}
          path: |
            scorecard.json
            scorecard.md
            orchestration.md
            takeover.md
          retention-days: 30
          if-no-files-found: warn
```

### 7.7 `src/orchestration.ts` modeli (her workflow PR'ında yalnız kendi işi)

Hepsi birden gösteriliyor; **PR başına yalnız ilgili iş** çevrilir (aksi halde `tests/orchestration.test.ts:97` "dört yeni katman PLANNED" testi kırılır; o test de aynı PR'da o iş için güncellenir). `index-probe.yml` ve onun testi **dokunulmaz**.

```diff
diff --git a/src/orchestration.ts b/src/orchestration.ts
index 0ae045e..bafbe93 100644
--- a/src/orchestration.ts
+++ b/src/orchestration.ts
@@ -53,2 +53,3 @@ export const QUOTA_POOLS: QuotaPool[] = [
   { id: "gsc-ga4-measure", daily_limit: "UNKNOWN", unit: "UNKNOWN", source: "bu depoda belgelenmemis; tahmin yazilmaz" },
+  { id: "psi-api", daily_limit: "UNKNOWN", unit: "UNKNOWN", source: "bu depoda belgelenmemis; tahmin yazilmaz (PSI anahtari/kota owner'dan teyit)" },
 ];
@@ -97,13 +98,16 @@ export const JOBS: Job[] = [
   { id: "lighthouse-weekly", loop: "weekly", cadence: "weekly", cron: "10 7 * * 1", runner: "github_actions", workflow: "lighthouse.yml",
-    api_calls_per_site: "UNKNOWN", quota_cost: null, state: "PLANNED", writes: ["data/performance-history/*.json"], depends_on: [],
-    note: "Planli saat oneri; workflow olusunca model guncellenir." },
+    api_calls_per_site: "UNKNOWN", quota_cost: { pool: "psi-api", per_site: "UNKNOWN" }, state: "GATED", gate: "vars.SEARCH_GROWTH_LIGHTHOUSE_ENABLED == 'true'",
+    writes: ["data/performance-history/*.json (commit, main)", "artifact:performance-<run_id>"], depends_on: [],
+    note: "PSI (mobile, varsayilan ana sayfa); anahtar yoksa NOT_CONNECTED." },
   { id: "index-alarms-daily", loop: "daily", cadence: "daily", cron: "40 7 * * *", runner: "github_actions", workflow: "index-alarms.yml",
-    api_calls_per_site: "UNKNOWN", quota_cost: { pool: "gsc-url-inspection", per_site: "UNKNOWN" }, state: "PLANNED",
-    writes: ["data/index-history/*.json"], depends_on: [], note: "Kota kullanimi olculene kadar UNKNOWN." },
-  { id: "deployment-verifier", loop: "on_demand", cadence: "event", runner: "github_actions", workflow: "deployment-verifier.yml",
-    api_calls_per_site: 0, quota_cost: null, state: "PLANNED", writes: ["data/deployment-timeline/*.json"], depends_on: [],
-    note: "Deploy olayinda tetiklenir; cron'u yok." },
+    api_calls_per_site: "UNKNOWN", quota_cost: { pool: "gsc-url-inspection", per_site: "UNKNOWN" }, state: "GATED", gate: "vars.SEARCH_GROWTH_INDEX_ALARMS_ENABLED == 'true'",
+    writes: ["data/index-history/*.json (commit, main)", "data/canonical-backlog/*.json (commit, main)", "artifact:index-alarms-<run_id>"], depends_on: [],
+    note: "Yalniz pamistanbul, ORNEKLEM (segmented, limit 20). index-probe.yml DEGISMEZ (elle, contents: read, schedule YOK; test ile korunur)." },
+  { id: "deployment-timeline", loop: "weekly", cadence: "weekly", cron: "55 7 * * 1", runner: "github_actions", workflow: "deployment-timeline.yml",
+    api_calls_per_site: 1, quota_cost: null, state: "GATED", gate: "vars.SEARCH_GROWTH_DEPLOYMENT_TIMELINE_ENABLED == 'true'",
+    writes: ["data/deployment-timeline/*.json (commit, main)", "artifact:deployment-timeline-<run_id>"], depends_on: [],
+    note: "Olay-tetikli DEGIL (olaylar site depolarinda); haftalik GitHub Deployments yoklamasi. Tum olaylar UNVERIFIED." },
   { id: "scorecard-weekly", loop: "weekly", cadence: "weekly", cron: "10 8 * * 1", runner: "github_actions", workflow: "scorecard.yml",
-    api_calls_per_site: 0, quota_cost: null, state: "PLANNED", writes: ["reports/scorecard-<tarih>.{json,md}"],
-    depends_on: ["measure", "clarity-daily", "lighthouse-weekly", "index-alarms-daily", "deployment-verifier"],
+    api_calls_per_site: 0, quota_cost: null, state: "GATED", gate: "vars.SEARCH_GROWTH_SCORECARD_ENABLED == 'true'", writes: ["artifact:scorecard-<run_id>"],
+    depends_on: ["measure", "clarity-daily", "lighthouse-weekly", "index-alarms-daily", "deployment-timeline"],
     note: "Yalniz artifact dosyalarini okur; ag yok. Monthly dongude henuz is tanimli degil (uydurma is eklenmedi)." },
```

---

## 8. Owner kapılı açma sırası

Her adımda **owner**: PR'ı ready yapar ve merge eder (CLAUDE.md: draft aç, merge'i Sefa'ya bırak), değişkeni ayarlar. Ajan hiçbirini yapmaz. Bir adım koşulu sağlamazsa **dur**, sonrakine geçme.

| Faz | Adım | Kabul ölçütü (ölçülür, tahmin değil) |
|---|---|---|
| **0 Merge** | 0.1 #31–#38'i incele/merge (sıra serbest). 0.2 bağlama PR'ı (`cli-wiring.patch`) | `npm run typecheck` temiz; `npm test` geçer (bu oturumda 669 → yama ile 682). `orchestration-check` exit **1** (beklenen) |
| **1 Scorecard** (salt-okunur) | 1.1 `scorecard.yml` PR'ı + model/test (yalnız `scorecard-weekly` → GATED). 1.2 Elle dispatch. 1.3 `SEARCH_GROWTH_SCORECARD_ENABLED=true` | Özet: girdisi olmayan boyut **UNKNOWN**, hiçbiri yanlış `OK` değil (B1 nedeniyle index/deployment/opportunity UNKNOWN beklenir). 1.4 İlk Pazartesi 08:10 koşusu görülür |
| **2 Clarity cutover** (mevcut sıra; bu plan değiştirmez) | `docs/integrations/clarity-daily.md` "Cutover" 1–8. Kanıt aracı: `clarity-takeover-status` (koşu kaydı eksikliği B4) | 7/7 `measurement_success`, iki ayrı UTC gün, her birinde 7/7 taze. **Legacy kapatma ve credential rotation owner eylemidir** |
| **3 Lighthouse** | 3.1 Owner PSI anahtarı üretir, secret `SEARCH_GROWTH_PAGESPEED_API_KEY`. 3.2 PR+model. 3.3 Dispatch `site=pamistanbul`, `write_history=false`. 3.4 Artifact'ı şemayla karşılaştır (**ilk canlı doğrulama; üretici belgesi canlı PSI ile doğrulanmadığını söylüyor**). 3.5 7 site, `write_history=true`. 3.6 Değişken | 3.4: kayıtlar şemaya uyar, eksik metrik `null`/UNKNOWN (sıfır değil), anahtar log/artifact'ta yok. 3.5: `data/performance-history/*.json` main'de, çift kayıt yok. PSI kotası/maliyeti bu depoda **UNKNOWN** → owner teyit |
| **4 Index alarms** | Ön koşul: owner `segmented` zamanlanmış koşuyu ve R2'yi kabul eder. 4.1 PR+model. 4.2 Dispatch iki ayrı günde. 4.3 Değişken | `data/index-history/pamistanbul.json` iki snapshot; **aynı URL'nin ≥2 snapshot'ta görülme oranı raporlanır** (alarm etkinliğinin ön koşulu; ölçülmedi). Alarm yoksa "değerlendirilemeyen URL" sayısı yazılı |
| **5 Deployment** | 5.1 Owner salt-okunur token üretir (7 depo). 5.2 PR+model. 5.3 Dispatch `write_history=false`. 5.4 `write_history=true`. 5.5 Değişken | Her site için olay sayısı ve `REDDEDILDI` satırları görünür; tüm olaylar `UNVERIFIED`; token yoksa `NOT_CONNECTED`. **Canlı SHA probe'u bu planın dışında (site sahibi kararı)** |
| **6 Legacy kapandıktan sonra** | `scorecard.yml`'deki orkestrasyon adımından `continue-on-error: true` kaldır; modelde legacy `DISABLED` | `orchestration-check` exit **0** |

Adımlar arası bağımlılık: 1 → 2/3/4/5 herhangi sırada (birbirinden bağımsız); 6, 2'nin sonucuna bağlı.

---

## 9. Rollback

| Seviye | Eylem | Etki |
|---|---|---|
| L0 acil | `SEARCH_GROWTH_SCHEDULES_PAUSED=true` | yeni 4 zamanlanmış iş atlanır; mevcut aktif işler ve dispatch etkilenmez |
| L1 iş bazlı | ilgili `SEARCH_GROWTH_*_ENABLED` değişkenini sil ya da `false` yap | o iş atlanır; veri dosyaları kalır |
| L2 | Actions arayüzünde workflow'u Disable et | zamanlama durur |
| L3 | workflow PR'ını `git revert` (PR ile) | dosya silinir; model + test aynı revert'te geri döner. **`--force` yok** |
| L4 veri | yazıcının bot commit'ini `git revert` (PR ile) | geçmiş dosyaları fail-closed ayrıştırılır; bozuk dosya yalnız **kendi sitesini** durdurur, yeniden yazılmaz. Gözlem silmek geri getirilemez → revert tercih edilir, silme değil |
| L5 kimlik | ilgili secret'ı sil/rotate | `lighthouse`/`deployment-timeline` `NOT_CONNECTED` olur, iş yeşil, geçmişe yazılmaz |
| Bağlama yaması | bağlama PR'ını revert | hiçbir veriye dokunmaz |
| Clarity | bayrak `false` | **yalnız legacy açıkken güvenli**; legacy kapalıysa günlük toplama durur → sıra bölüm 5 |

---

## 10. Riskler (öncelik sırasıyla)

| # | Risk | Etki | Azaltma |
|---|---|---|---|
| R1 | **Scorecard ↔ üretici şema uyuşmazlığı** (index `snapshots` vs `records`; deployment `site` vs `site_id`, `generated_at` yok). Ölçüldü (`cli-wiring-plan.md` B1) | iki boyut veri gelse de `UNKNOWN`; `MISMATCH` deploy görünmez. **Güvenli yönde** (yanlış `OK` yok) ama kör | #38 okuyucusunu düzelt (K1); faz 1 kabulünde UNKNOWN beklenir |
| R2 | **İndeks alarmı örnekleme sorunu (ölçülmedi):** alarm aynı URL'nin ≥2 ardışık gözleminde (>24 sa) doğar; `segmented` rotasyonu stateless ve günlük → aynı URL'nin tekrar örneklenme sıklığı bilinmiyor. `--urls` listesi `segmented` ile birlikte kullanılamıyor, `gsc` stratejisinde sitemap üyeliği UNKNOWN → alarm üretilemez | alarm hiç ya da çok seyrek çıkabilir ("sorun yok" izlenimi) | Faz 4'te tekrar-gözlem oranını **ölç ve raporla**; yetersizse küçük sabit izleme listesi için `inspect-index` değişikliği ayrı karar |
| R3 | `orchestration-check` legacy kapanana kadar kırmızı | CI'da zorunlu kapı yapılırsa herkesi bloke eder | scorecard'da `continue-on-error`, faz 6'da kaldır; `tests.yml`'e **eklenmez** |
| R4 | İki mevcut koruma testi (index-probe schedule yok; model `PLANNED`) bilinçli güncelleme ister | yanlış PR sırası testleri kırar | PR başına tek iş çevir; `index-probe.yml` dokunulmaz |
| R5 | Commit yarışı: `measure.yml` rebase'siz; lighthouse (40 dk) diğer yazıcılarla örtüşür | push reddi → rapor/geçmiş kaybı | 7.1 + 3 denemeli rebase; yollar ayrık |
| R6 | Clarity kotası: `--force` + `clarity.yml` aynı gün → 12 > 10; legacy saati 06:10 mi 06:00 mı belirsiz | 429, ölçüm kaybı | bölüm 5 kuralı; owner saati teyit eder |
| R7 | PSI: kota/maliyet bu depoda belgesiz; yanıt şeması canlıda doğrulanmadı; lab tek koşu gürültülü; düşük trafikli URL'de CrUX yok; ilk faz yalnız ana sayfa | yanlış regresyon adayı / boş veri | ilk koşu 1 URL ile (faz 3.3–3.4); regresyonlar yalnız ADAY; URL listesi owner kararı |
| R8 | Deployment: `created_at` kayıt zamanıdır, canlıya çıkış anı değil; Vercel Git entegrasyonunun GitHub Deployments kaydı oluşturduğu bu depoda **doğrulanmadı**; token kapsamı 7 depo | zaman penceresi kayar; olay hiç gelmeyebilir | tüm olaylar `UNVERIFIED`; `correlate` yalnız INFERENCE/CANDIDATE; boş sonuç "deploy yok" diye yazılmaz |
| R9 | Branch protection eklenirse bot push'u kırılır | tüm yazıcılar kırmızı | önceden owner'a bildir; alternatif PR tabanlı yazım ayrı karar |
| R10 | Üretici modüller canlı veriyle uçtan uca denenmedi (yalnız fixture); `index-alarms` gerçek `index-probe` JSON'uyla, `deployment-ingest` gerçek GitHub yanıtıyla ilk kez canlıda | ilk koşu şema sürprizi | faz kabulleri `write_history=false` ilk koşuyu şart koşar |
| R11 | Takeover koşu kaydı üreticisi yok (B4) | zincir hiç `FULL_TAKEOVER_2_OF_2` olmaz | ayrı küçük iş; o zamana kadar legacy kapatma kararı elle `clarity-daily` çıktılarından |
| R12 | Değişiklik ledger'ının yazarı yok; kill-switch dosyası depoda yok → `change-eval` strict modda her şeyi engeller | yanlış negatif (boş ledger = bütçe boş) ya da kullanışsız | yalnız bilgi aracı; yazma yolu eklenmeden otomatiğe bağlanmaz |
| R13 | GitHub zamanlanmış koşuları geciktirebilir; scorecard sıraya güvenmez | bayat girdi | `UNKNOWN-STALE` (varsayılan sınırlar) |
