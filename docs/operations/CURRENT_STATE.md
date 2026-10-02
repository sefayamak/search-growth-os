# Search Growth OS — CURRENT STATE (devir dosyası)

> **GitHub canonical source of truth. Yerel checkout otorite DEĞİLDİR.**
> Makine-okunur eşi: [`current-state.json`](current-state.json) (`sgos.handoff-state.v1`). İkisi birlikte okunur.
> Bu dosya **kimlik bilgisi DEĞERİ içermez**; yalnız secret İSİMLERİ geçer.

## 0. Yeni bilgisayarda / sıfır bağlamlı oturumda: "GitHub'a bak ve devam et"

Bu cümle şu protokolü tetikler (ayrıca `CLAUDE.md` başlangıç kuralı):

1. **Önce** `node --experimental-strip-types bin/project-status.ts --remote` (ya da `bash scripts/project-status.sh --remote`) çalıştır. Salt-okunur: merge/pull/reset/checkout/rebase/push/dispatch YAPMAZ.
   `--remote` yalnız `git fetch origin main` (yalnız `refs/remotes/origin/main` güncellenir) ve `gh pr list` çalıştırır. Bayraksız: yalnız yerel inceleme (uzak durum **doğrulanmadı** uyarısı verir).
2. Çıktıdaki **DURUM** sınıfına göre davran:

   | Durum | Anlamı | Güvenli sonraki adım |
   |---|---|---|
   | `CLEAN_SYNCED` | yerel main = uzak main, temiz | devir dosyalarını oku, `next_action`'ı uygula |
   | `BEHIND_REMOTE` | yerel main geride | güncelleme gerekli (`git pull --ff-only` ya da taze clone) — **araç yapmaz**, reset/merge/rebase yok |
   | `AHEAD_REMOTE` | push edilmemiş commit var | silme/reset yok; incele, push yalnız sahibin kararıyla |
   | `DIVERGED` | ayrışmış | otomatik merge/rebase/reset **yok**; owner'la karara bağla |
   | `DIRTY` | commit edilmemiş çalışma var | **korunur** (silme/reset/checkout/clean yok) |
   | `WRONG_BRANCH` | canonical (`main`) dışında bir daldasın | otomatik checkout yok; dalın bilinçli bir iş dalı olduğunu kontrol et |
   | `WRONG_REPOSITORY` | bu dizin `sefayamak/search-growth-os` değil | **DUR** (bkz. §9) |
   | `GIT_OBJECT_ERROR` | git nesne/yapı hatası | **DUR**; pull/merge/rebase/reset YOK; onarım ayrı owner eylemi |
   | `REMOTE_UNREACHABLE` | GitHub'a erişilemedi | **DUR**; yerel durum otorite gibi sunulmaz |
   | `UNKNOWN` | sınıflandırılamadı | **DUR**; `--remote` ile doğrula ya da taze clone |

3. `STALE_STATE_FILE` uyarısı = devir dosyası uzak main'in gerisinde; **canlı GitHub durumunu** (açık PR'lar, main SHA, CI) esas al, bu dosyayı öneri say.
4. Yerel durum uzakla çelişirse **uzak GitHub durumu tercih edilir** — ama yerel commit edilmemiş iş varsa **silinmez/sıfırlanmaz**.
5. Owner-gated hiçbir eylem yapılmaz (§6). Sonra `next_action` belirlenir.

## 1. Repository
`sefayamak/search-growth-os` · yedi site: pamistanbul (pilot), pamaistudio, spryhand, decideplan, rightlisted, untitledportraits, myhappymade.

## 2. Canonical branch
`main`. Her değişiklik: draft PR → CI → owner onayı → squash merge (`expectedHeadSha` ile).

## 3. Last known main
`a3ce11cdef02f91ae7533403337f09be9c7a3345` — 2026-10-02T13:30Z itibarıyla (`state_based_on_main_sha`).
Bu SHA dosyanın kendisini içeren commit **olmak zorunda değil** (§10). Canlı SHA her zaman bootstrap sırasında ayrıca okunur.

## 4. Current phase
**Development backlog closure / Clarity takeover validation pending.**
Main'de: sprint modülleri (#31–#38), persistence (#40, #43), measure JSON (#41), CLI bağlama (#39: 12 salt-okunur/yerel komut), takeover E2E testleri (#44), docs senkronu (#46), zaman-bağımlı test düzeltmesi (#42). Ayrıntı: `current-state.json` → `merged_capabilities`.

## 5. Open PRs
**#45 — HOLD** (`measure.yml`: Markdown + `reports/measure-report-latest.json` tek GSC fetch'ten).
- Neden HOLD: workflow değişikliği; ilk canlı koşusu Pzt 2026-10-05 ve aynı zamanda `persist-history.sh`'ın `measure.yml`'de ilk kullanımı. Merge **owner kararı**.
- Durum: tek-fetch refactor **PR'da uygulandı ve doğrulandı** (head `cfd12c8`, CI success, `MERGE_NOW_SAFE`); main'de DEĞİL. Canlı durumu GitHub'dan doğrula.

## 6. Owner-gated eylemler (açık, o anki onay olmadan yapılmaz)
- Clarity dispatch (`clarity-daily`, `clarity.yml`, `force=true`)
- legacy `site-health-monitor` kapatma
- credential rotasyonu / iptali
- `SEARCH_GROWTH_CLARITY_DAILY_ENABLED` veya herhangi yeni schedule'ı açma
- üretim sitesine yazma (push, deploy, robots/canonical/hreflang/schema/içerik)
- #45 (ve her feature PR) merge
Önceden verilmiş genel onay bu listeyi kapsamaz.

## 7. Clarity göçü
- **2026-10-02:** `COVERAGE_VALIDATION_SUCCESS` (7/7 `measurement_success`).
- **FULL_TAKEOVER: 0/2 tamamlandı.** Gün 1 ve gün 2 ayrı UTC günleri; her biri 7/7 `measurement_success` **ve** 7/7 taze, aynı `source_run_id`.
- Başarı ölçütü: `measurement_success = MEASURED ∧ CONFIRMED ∧ rows_complete==true` (doğrulanmış sıfır geçer).
- Sonraki gerekli: **2026-10-03 taze 7/7 doğrulama**.

## 8. Legacy · zamanlanmış çalışma · kimlik bilgisi
- **Legacy `site-health-monitor`:** son bilinen **ENABLED** (owner beyanı; bu depodan yeniden okunamaz).
- **Canonical `clarity-daily`:** workflow var; zamanlanmış koşu `SEARCH_GROWTH_CLARITY_DAILY_ENABLED=='true'` değişkenine kapılı; **değişkenin canlı değeri UNKNOWN** (GitHub değişkeni açıkça doğrulanmadıkça). Manuel `workflow_dispatch` her zaman mevcut.
- **Kimlik bilgileri (yalnız metadata, DEĞER YOK):** yeni canonical Clarity kimlik bilgisi yapılandırılmış (`SEARCH_GROWTH_CLARITY_TOKENS_JSON`; 2026-10-02 doğrulaması bununla geçti). GSC (`SEARCH_GROWTH_GSC_CREDENTIALS_JSON`) ve GA4 (`SEARCH_GROWTH_GA4_CREDENTIALS_JSON`) yapılandırılmış. **Eski legacy kimlik bilgileri güvenli cutover'a kadar KALMALI.** Rotasyon bekliyor (owner; yalnız legacy kapandıktan sonra).

## 9. PAM CRM / ST10 ile karışmama kuralı
Bu depo `sefayamak/search-growth-os`. **PAM CRM / ST10 / staging veritabanı / Supabase `service_role`** gibi başka repo ve sistemlerin bağlamı bu repoya **asla** taşınmaz (aynı kural diğer repolar için de geçerli). Depo kimliği uyuşmazsa (`WRONG_REPOSITORY`): **DUR**. Bootstrap, `origin` URL'sini (kimlik bilgisi maskelenerek) `sefayamak/search-growth-os` ile karşılaştırır.

## 10. State güncelleme politikası
- Anlamlı bir **merge / cutover / karar** sonrası bu dosya ve `current-state.json` güncellenir (aynı PR'da ya da hemen ardından).
- Her commit'te SHA güncellenmez: dosyayı içeren commit kendi SHA'sını yazamaz. Bu yüzden alan **`state_based_on_main_sha`** ("bu state main'in şu halinden türedi").
- Bootstrap canlı uzak SHA'yı ayrıca okur. `state_based_on_main_sha` ≠ uzak main ve aradaki değişiklikler **yalnız devir dosyaları/aracı** değilse → **`STALE_STATE_FILE`**. Devir yolları: `docs/operations/`, `bin/project-status.ts`, `src/project-status.ts`, `scripts/project-status.sh`, `schemas/handoff-state.schema.json`, `tests/project-status.test.ts`, `CLAUDE.md`.
- `STALE_STATE_FILE` bir hata değil uyarıdır: canlı GitHub durumu esas alınır, dosya güncelleme PR'ı önerilir.

## 11. Yarının runbook'u (2026-10-03, UTC) — değiştirilmedi
1. Legacy ~06:10Z koşusunun tamamlanmasını bekle.
2. O güne ait canonical ölçüm kaydı olmadığını doğrula (`data/clarity-history/*.json`), `main` yeşil.
3. **Tam bir** `clarity-daily` dispatch (`main`, varsayılanlar: `site` boş, `force=false`, `commit_history=true`).
4. Koşuyu incele: 7/7 `measurement_success` ve 7/7 taze, aynı `qualifying_run_id`, 0 same-day skip.
5. Persistence commit'ini doğrula (`persist-history.sh` ile main'e düştü).
6. `node --experimental-strip-types bin/clarity-takeover-status.ts config/sites.yaml --json` → `FULL_TAKEOVER_1_OF_2`.
7. **Kırmızı koşuda ikinci dispatch YOK**: önce log/artifact/persistence teşhisi (kota: legacy 3 + 3 + 3 = 9/10).

## 12. Güvenlik
Bu dosyada, `CLAUDE.md`'de, script'lerde, loglarda ve testlerde JWT, refresh token, client secret, service role, DB parolası, API token **DEĞERİ bulunmaz**; yalnız secret İSMİ/referans. `tests/project-status.test.ts` bunu tarar.

## 13. Bilinen riskler
- `persist-history.sh` GitHub Actions'ta ilk canlı kullanım: yarınki dispatch ya da Pzt 2026-10-05 `measure.yml`.
- Clarity kotası (proje başına 10/gün).
- Çoğu sprint modülü `IMPLEMENTED_NOT_LIVE_VALIDATED`; GA4 metrikleri ölçülmüyor; legacy ve bayrak değerleri bu depodan UNKNOWN.
- Orkestrasyon doğrulayıcısı cutover bitene kadar 1 beklenen ERROR verir (`DUPLICATE_SCHEDULER`).

## 14. İzleme issue'su (öneri — bu turda issue'ya yazılmadı)
Issue #13'ün (ya da kanonik izleme issue'sunun) açıklamasına tek satır eklenmesi önerilir: *"Güncel devir durumu: `docs/operations/CURRENT_STATE.md` (GitHub → main)."* Issue'ya yazmak owner onayına bağlıdır.
