# Performans / Core Web Vitals (Lighthouse + CrUX)

Durum: **kod ve testler hazır, CLI/workflow bağlanmadı** (orkestratör bağlayacak). Canlı PSI çağrısı bu
sprintte yapılmadı; ölçülmüş canlı değer yoktur, bu belgede de yazılmaz.

Modül: `src/performance.ts` (ayrıştırma, geçmiş, regresyon, koşu, markdown),
`src/performance-psi.ts` (PSI istemcisi). Şema: `schemas/performance-record.schema.json`.

## Ne ölçer

PageSpeed Insights API v5 yanıtından URL başına bir kayıt (`sgos.performance.v1`):
`lcp_ms`, `inp_ms`, `cls`, `ttfb_ms`, `perf_score`, `source` (`field` | `lab` | `none`),
`state` (`MEASURED` | `UNKNOWN` | `NOT_CONNECTED` | `ERROR`).

| Konu | Karar | Neden |
|---|---|---|
| Eksik metrik | `null` + `UNKNOWN` sınıfı, asla `0` | Sıfır LCP "mükemmel" okunur; oysa o gün ölçüm yoktu (kural 1) |
| Field vs lab | Field (CrUX, gerçek kullanıcı) varsa kayıt `field`; yoksa lab. **Tek kayıtta karışmaz** | İkisi aynı şey değil; lab tek sentetik koşu |
| `perf_score` | Her zaman lab (Lighthouse kategorisi), 0-100 | PSI başka skor vermez |
| INP | Yalnız field; lab kayıtta `null` | Lab'de INP yok |
| CLS | CrUX percentile 100 ile çarpılmış gelir, `/100` yapılır | PSI sözleşmesi |
| TTFB (lab) | `server-response-time` denetimi | Lab'de doğrudan TTFB yok; CWV değildir |
| `origin_fallback` | `field_scope: "origin"`; URL düzeyiyle kıyaslanmaz | Sitenin ortalaması bir sayfayı temsil etmez |
| Etiket | Ölçülen sayı **FACT**; sağlayıcı = PSI (Google'ın sıralaması hakkında değil) | `policies/evidence-labels.md` |
| Güven | `MEASURED` + en az bir değer = `CONFIRMED`; aksi `UNKNOWN` | |

### Eşikler (INFERENCE / CANDIDATE)

web.dev Core Web Vitals eşikleri (erişim 2026-10-02; kaynağa bu sprintte ağ erişimi olmadan, mevcut
bilgiyle yazıldı — canlı doğrulama orkestratörde): iyi ≤ / zayıf >

| Metrik | İyi | Zayıf |
|---|---|---|
| LCP | 2500 ms | 4000 ms |
| INP | 200 ms | 500 ms |
| CLS | 0.1 | 0.25 |

TTFB için 800/1800 ms yardımcı bilgidir (CWV değil). Sınıf bir kuralın sonucudur; ölçüm değildir, bu yüzden
`ratings.label = INFERENCE`. Sınır değerler iyi tarafta (`2500` = GOOD).

## Sınırlar ve bütçe

- Site başına URL: varsayılan **5**, sert tavan **10** (`HARD_URL_CAP`), aşan URL `truncated_urls`'e yazılır.
- Her PSI çağrısı 1 birim (URL × strateji). Koşu tavanı `maxRequests` (varsayılan 70 = 7 site × 5 URL × 2 strateji).
  Tükenince çağrı yapılmaz, kalanlar `skipped: BUDGET_EXHAUSTED` olarak yazılır (sessizce yarım kalmaz).
- 429/5xx **yeniden denenmez**. 60 sn zaman aşımı.
- URL yalnız sitenin kendi `canonical_hostname` / `production_domain` host'unda olabilir (www varyantı dahil);
  başka site ya da üçüncü parti URL reddedilir (`rejected_urls`).
- Aynı gün + URL + strateji için geçmişte `MEASURED` varsa istek **harcanmaz** (`ALREADY_MEASURED_TODAY`).

## API anahtarı

Ortam değişkeni adı: **`PAGESPEED_API_KEY`** (GitHub secret olarak). Değer hiçbir argümanda, kayıtta, hata
mesajında ya da logda taşınmaz; yalnız istemcinin kapanışında yaşar ve sorguya istek anında girer. Hata metni
anahtardan arındırılır. Anahtar yoksa `createPsiFetcher` `null` döner ve her kayıt `NOT_CONNECTED` olur: istek yok,
sayı yok, geçmişe yazılmaz. Testler fixture kullanır, ağ çağırmaz.

## Geçmiş: `data/performance-history/<site>.json`

`sgos.performance-history.v1`, site başına **≤ 120 kayıt** (en eski düşer; 10 URL × 2 strateji ile yaklaşık 6 gün,
5 URL × 1 strateji ile 24 gün — bu yüzden varsayılan strateji yalnız `mobile`).

- (UTC gün, URL, strateji) başına **ilk başarılı ölçüm kazanır**; aynı günün ikinci koşusu geçmişi oynatamaz.
- Yalnız `MEASURED` kayıt yazılır. `ERROR` / `UNKNOWN` / `NOT_CONNECTED` raporda görünür ama geçmişe girmez:
  yoksa 120'lik pencere gerçek veriden boşalır. `parseHistory` bu kuralı da zorlar.
- Fail-closed: bozuk dosya (şema, site uyuşmazlığı, 0 değerli metrik, çift anahtar, sıra, >120) `PerfHistoryError`;
  o site için istek harcanmaz, dosyanın üstüne yazılmaz, diğer siteler etkilenmez.
- Başka sitenin kaydı geçmişe yazılamaz (izolasyon).

## Regresyon (INFERENCE / CANDIDATE / REVIEW_REQUIRED)

Baz: aynı (URL, strateji, source, field_scope) için **bugünden eski** en yeni kayıt, ilgili metriği `null` olmayan.
Field ile lab, url ile origin birbirine karşı kıyaslanmaz; bugünün kaydı baz olamaz; `null` baz regresyon üretmez.

Kural (metrik başına): sınıf kötüleşti **ve** göreli kötüleşme ≥ %10 (field) / ≥ %20 (lab, tek koşu gürültülü);
ya da zaten `POOR` olan metrik ≥ %25 daha kötüleşti. `perf_score` ≥ 10 puan düştüyse ayrı aday. Sınır civarındaki
küçük oynama (2490 → 2510 ms) alarm değildir.

Çıktıda `causal_claim: "NONE"`: neden (deploy, üçüncü parti script, CrUX 28 günlük pencere kayması, lab gürültüsü)
bilinmiyor ve yazılmaz. Önerilen insan adımı: aynı URL'de yeniden ölçüm + son değişikliklerin incelenmesi.
Onboard edilmemiş (`registered_not_onboarded`) sitede ölçüm yapılır ama aksiyon `OBSERVE_ONLY`'dir (tavsiye yok).

## Çıktı

`runPerformance()` → `sgos.performance-report.v1` JSON (`budget`, site başına `records`, `regressions`,
`rejected_urls`, `truncated_urls`, `skipped`, `history_actions`). `reportMarkdown(report)` Türkçe tablo üretir;
`UNKNOWN` hiçbir yerde `0` yazılmaz.

## Orkestratörün bağlaması gereken (bu sprintte eklenmedi)

- CLI alt komutu önerisi: `performance <config/sites.yaml> [--site id] [--url u]... [--urls-per-site N] [--strategy mobile,desktop] [--max-requests N] [--json|--md]`;
  gövdesi `runPerformance({ sites: registry.sites, ..., historyDir: "data/performance-history" })` + `reportMarkdown`.
- Workflow (aşağıdaki **önerilen, eklenmemiş** taslak). Üretim sitelerine yazmaz; yalnız geçmiş dosyasını bir PR'a koyar.

```yaml
# ÖNERİ — .github/workflows/performance-cwv.yml (henüz eklenmedi)
name: Performance CWV
on:
  workflow_dispatch:
    inputs:
      site: { description: "tek site id (boş = hepsi)", required: false }
  # schedule: cutover kararından sonra (haftalık öneri): cron "17 5 * * 1"
permissions:
  contents: write        # yalnız data/performance-history/ için PR dalı
  pull-requests: write
concurrency: { group: performance-cwv, cancel-in-progress: false }
jobs:
  measure:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 24 }
      - name: Measure (PSI)
        env:
          PAGESPEED_API_KEY: ${{ secrets.PAGESPEED_API_KEY }}   # yoksa NOT_CONNECTED, iş yeşil kalır
        run: |
          node --experimental-strip-types src/cli.ts performance config/sites.yaml \
            ${{ inputs.site && format('--site {0}', inputs.site) || '' }} --md > reports/performance-latest.md
      - name: Open draft PR with history
        run: |
          git config user.name "sgos-bot" && git config user.email "sgos-bot@users.noreply.github.com"
          git checkout -b "perf/history-$(date -u +%F)"
          git add data/performance-history reports/performance-latest.md
          git diff --cached --quiet || { git commit -m "perf: PSI history $(date -u +%F)" && git push -u origin HEAD \
            && gh pr create --draft --fill; }
        env: { GH_TOKEN: "${{ secrets.GITHUB_TOKEN }}" }
```

## Bilinen sınırlar

- Canlı PSI yanıtıyla doğrulanmadı; ayrıştırma PSI v5'in belgelenmiş alan adlarına dayanır, fixture'lar kırpılmış
  sentetik gövdelerdir. İlk canlı koşu (limit 1 URL) şema uyumunu doğrulamalı.
- CrUX field verisi düşük trafikli URL'lerde yoktur; o zaman kayıt `lab`'a düşer ve INP `UNKNOWN` kalır.
- Lab tek koşudur; lab regresyonları yalnız ADAYDIR.
- Origin düzeyi field (`origin_fallback`) bir sayfanın değil sitenin ortalamasıdır.
- 120 kayıt pencere sınırı çok URL × çok stratejide kısa geçmiş demektir.
