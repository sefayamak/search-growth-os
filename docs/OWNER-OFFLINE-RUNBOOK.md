# Owner-offline runbook (Mac kapalı, ~5 gün)

> Kaynak: `.github/workflows/*.yml` (main, 2026-10-02) ve DEVAM.md. Bu belge **hiçbir kimlik bilgisi
> değeri içermez**; yalnız secret/variable **adları** geçer. Ölçülmeyen UNKNOWN kalır.

## 1. Mac kapalıyken ne çalışır (GitHub Actions, Mac gerektirmez)

| İş | Zamanlama (UTC) | Durum | Yazar | Kimlik bilgisi (ad) |
|---|---|---|---|---|
| `portfolio-check.yml` | Pzt 06:10 | AKTİF | yok (`contents: read`) | yok |
| `measure.yml` (GSC + GA4) | Pzt 06:40 | AKTİF | `reports/` → main (bot commit) | `SEARCH_GROWTH_GSC_CREDENTIALS_JSON`, `SEARCH_GROWTH_GA4_CREDENTIALS_JSON` |
| `search-audit.yml` | Pzt 06:40 | AKTİF | yok | yok |
| `tests.yml` | PR/push | AKTİF | yok | yok |

Not: `measure.yml` GSC için kişisel OAuth refresh token tabanlı credential kullanıyorsa, token iptal/rotasyonunda
bu iş de durur (bkz. §5).

## 2. Kasten kapalı / kapılı (kendiliğinden çalışmaz)

| İş | Neden çalışmaz | Açan |
|---|---|---|
| `clarity-daily.yml` zamanlanmış (`20 7 * * *`) | `vars.SEARCH_GROWTH_CLARITY_DAILY_ENABLED == 'true'` değil → job atlanır, API çağrısı yok | **Owner** (bayrak) |
| `clarity.yml`, `index-probe.yml`, `brain.yml` | yalnız `workflow_dispatch` | Elle |
| `clarity-daily.yml` dispatch | elle; bayrağa bağlı değil | Elle (insan eylemi) |

## 3. Mac kapalıyken DURAN veya belirsiz olanlar

- **Eski `site-health-monitor` rutini** (CCR, günlük ~06:10Z): ENABLED. Mac'e bağlı değil (Anthropic
  bulutunda); owner kapatana kadar çalışmaya devam eder, Clarity kotasını (proje başına 10/gün) yer.
  Çalışıp çalışmadığı bu repodan UNKNOWN; son bilinen: ENABLED, sonraki 2026-10-03T06:10Z.
- Owner Mac'inde çalışan her şey (yerel cron/launchd, yerel panel, elle terminal komutu): bu repodan
  **görünmez → UNKNOWN**. Mac kapanınca durduğu varsayılmaz, doğrulanmadığı not edilir.
- Secret yazma, Clarity token üretme, CCR rutini UI'dan kapatma: yalnız owner (§6).

## 4. Çift zamanlayıcı ve kota riski (Clarity)

Microsoft limiti: **10 istek / proje / gün**. Site başına maliyet:

| Kaynak | İstek/proje |
|---|---|
| Eski rutin (06:10Z) | 3 |
| `clarity.yml` (dispatch) | 3 |
| `clarity-daily.yml` | 3 |

Eski rutin + bayrak açık `clarity-daily` = 6/10 (güvenli). Üstüne elle `clarity.yml` + `force=true` = 9–12 → taşar.
Koruma: aynı UTC günde `measurement_success` kaydı varsa API çağrılmaz; `concurrency: clarity` iki işi
seri yapar. **Sprint boyunca Clarity çağrısı yapılmaz; bayrak kapalı kalır; `force=true` çalıştırılmaz.**

## 5. Kimlik bilgisi maruziyet riski

- Eski rutinin prompt'unda düz metin credential'lar var (7 Clarity token, GSC refresh token, OAuth client
  secret). Rutin açık kaldıkça maruz kalır. Rotasyon yalnız **eski rutin kapatıldıktan sonra** (owner).
- Rotasyon öncesi eski credential iptal edilirse eski rutin kırılır; yenisi `SEARCH_GROWTH_*` secret'larına
  yazılmadan iptal edilirse `measure.yml` / `clarity-daily` NOT_CONNECTED olur (fail-closed, sahte sayı yok).
- GitHub secret'ları yazma-yalnız: bu ortam değeri okuyamaz ve okumamalıdır.

## 6. Owner gerektiren adımlar (sırayla)

1. 2026-10-03 UTC: FULL_TAKEOVER 1/2 doğrulaması (7/7 `measurement_success` **ve** 7/7 taze).
2. Sonraki **ayrı** UTC günü: 2/2.
3. Eski rutini kapat (CCR UI).
4. Credential rotasyonu (Clarity ×7, GSC refresh token, OAuth client secret) + `SEARCH_GROWTH_*` secret güncelle.
5. `SEARCH_GROWTH_CLARITY_DAILY_ENABLED=true`.
6. İlk zamanlanmış koşuyu doğrula (07:20Z).

## 7. FULL_TAKEOVER doğrulaması Mac olmadan çalışır mı?

**Evet, teknik olarak.** `clarity-daily.yml` `workflow_dispatch` ile tamamen GitHub Actions'ta koşar; Mac,
yerel secret veya terminal gerekmez (token `secrets.*` → env). Mac'e bağlı olan tek şey **tetikleyici
insan/agent**: dispatch'i bir Claude oturumu (GitHub MCP) veya owner (GitHub UI/telefon) başlatır.
Zamanlanmış koşu bayrak kapalıyken doğrulama yerine geçmez ve bayrağı açmak owner onayı ister.
Bu sprintte doğrulama **koşulmadı**; 2026-10-02 verisi yeni doğrulama sayılmaz.
Ofline durum hesaplayıcı: `docs/clarity-takeover-status.md` (ayrı draft PR).

## 8. Offline süresince güvenli işletim

- Hiçbir üretim sitesine yazma yok; tüm değişiklik draft PR; merge yalnız owner.
- Bot commit'leri yalnız `reports/` ve `data/clarity-history/` altına (main).
- Beklenmeyen: workflow kırmızıysa Actions sekmesinden bak; kırmızı iş sahte veri üretmez (fail-closed).

## 9. Mac kapalıyken ne ÇALIŞMAZ

- **Claude Code yerel oturumu çalışmaz.** Oturum açık kalmadıkça hiçbir agent PR açmaz, CI kırmızısını düzeltmez, review yanıtlamaz. PR'lar owner dönene kadar olduğu gibi bekler.
- Yalnız iki şey sürer: **GitHub Actions** (bkz. §1) ve **Anthropic'te çalışan legacy rutin** (bkz. §3). Bulut oturumundaki zamanlanmış check-in'ler garanti değildir; güvenme.
- Kırmızı iş kendini onarmaz; owner dönünce Actions sekmesinden bakılır.

## 10. Owner yokken ASLA OTOMATİK (NEVER AUTO)

Hiçbir zamanlayıcı, agent veya workflow şunları owner'ın açık, o anki onayı olmadan yapmaz:

- feature PR merge etmek (docs/test-only dahil),
- legacy `site-health-monitor` rutinini kapatmak,
- credential/token rotasyonu veya iptali,
- schedule cutover (`SEARCH_GROWTH_CLARITY_DAILY_ENABLED` veya başka bir kapı değişkenini açmak),
- production mutation (push, deploy, toplu indeksleme, robots/canonical/hreflang/schema/içerik yazımı),
- `force=true` Clarity koşusu veya kota yakan keşif çağrısı.

Önceden verilmiş genel onay bu listeyi kapsamaz: her madde için onay yeniden ve o işe özel verilir.
