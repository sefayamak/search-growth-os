# Scorecard ↔ üretici sözleşmesi (drift notu)

**İlke.** Üreticilerin gerçek çıktı şemaları kanoniktir. Scorecard ikinci bir veri modeli kurmaz; `src/scorecard.ts`
içindeki *üretici adaptör katmanı* (`producerGate`, `performance`, `indexHealth`, `deploymentChange`) üretici alanlarını
kendi boyut durumuna çevirir. Üretici branch'lerine dokunulmaz. Tanınmayan / eksik / yanlış siteye ait şekil
**UNKNOWN** olur — asla OK, asla 0.

Üretici PR'ları henüz `main`'de değil; bu belge **okunan alanların tam listesidir**. Aynı liste kodda
`CONSUMED_PRODUCER_FIELDS` (src/scorecard.ts) olarak durur ve `tests/scorecard-contract.test.ts` iki yerde arar:
(1) üretici-şekilli fixture'larda, (2) bu belgede. Listeye alan eklenip burada belgelenmezse ya da üretici alanı
yeniden adlandırılırsa test kırılır.

Fixture'lar (`tests/fixtures/scorecard-contracts/`) üreticilerin **gerçek, export edilmiş kurucularından** üretildi
(`tests/scorecard-contract-builders.ts`; `runPerformance`, `appendSnapshot`/`buildReport`, `parseGithubDeployments`/`verifyDeployment`/`appendEvent`).
Üretici modül repoda bulunursa round-trip testi kuruyu tekrar koşar ve çıktıyı fixture ile **birebir** karşılaştırır;
modül yoksa test *skip* (neden yazılı), fail değil.

Dosya düzeni (üreticilerin yazdığıyla aynı): `<dizin>/<site>.json`. Üretici branch'leri: #36 `claude/sprint-lighthouse`,
#34 `claude/sprint-index-alarms`, #32 `claude/sprint-deployment-verifier`.

## 1. Okunan alanlar (tam liste)

### `sgos.performance-history.v1` (#36; `src/performance.ts`, `data/performance-history/<site>.json`)

Dosya: `schema`, `site`. Her kayıt `sgos.performance.v1`: `records[].schema`, `records[].site`, `records[].state`,
`records[].source`, `records[].date`, `records[].measured_at`, `records[].url`, `records[].strategy`, `records[].lcp_ms`,
`records[].inp_ms`, `records[].cls`.

Alanlar:

- `schema`, `site`
- `records[].schema`, `records[].site`, `records[].state`, `records[].source`, `records[].date`, `records[].measured_at`
- `records[].url`, `records[].strategy`, `records[].lcp_ms`, `records[].inp_ms`, `records[].cls`

### `sgos.performance-report.v1` (#36; opsiyonel, regresyon adayları)

`schema`, `generated_at`, `sites[].site`, `sites[].regressions[].label`, `sites[].regressions[].site`, `sites[].regressions[].metric`.
Rapor tüm siteleri taşır; yalnız istenen sitenin satırı okunur.

### `sgos.index-history.v1` (#34; `src/index-alarms.ts`, `data/index-history/<site>.json`)

- `schema`, `site`
- `snapshots[].site`, `snapshots[].taken_at`, `snapshots[].sample_size`, `snapshots[].universe_size`, `snapshots[].stopped`
- `snapshots[].entries[].state`, `snapshots[].entries[].verdict`, `snapshots[].entries[].in_sitemap`, `snapshots[].entries[].fetch_ok`,
  `snapshots[].entries[].canonical_self`, `snapshots[].entries[].indexable`

### `index-alarms-report` (#34 `buildReport` çıktısı; **şema kimliği yok**, opsiyonel)

`site`, `generated_at`, `index_alarms.status`, `index_alarms.alarms`. (`canonical_backlog` scorecard'da **okunmaz**; bkz. §4.)

### `sgos.deployment-timeline.v1` + `sgos.deployment-event.v1` (#32; `src/deployment-timeline.ts`)

- Zaman çizelgesi: `schema`, `site`, `events`
- Olay: `events[].schema`, `events[].site`, `events[].environment`, `events[].commit_sha`, `events[].deployed_at`,
  `events[].verification_state`, `events[].provenance.retrieved_at`

## 2. Eşleme: üretici alanı → scorecard boyutu

| Boyut | Üretici alanı | Kural | Durum / etiket / güven |
|---|---|---|---|
| `performance` | `records[]` (yalnız `schema=sgos.performance.v1`, `site` eşleşir, `state=MEASURED`, `source∈{field,lab}`, tarih tutarlı) | **En son GÜNÜN** tüm kayıtları (üretici günde URL×strateji kadar kayıt yazar); field varsa yalnız field, yoksa lab; metrik başına **en kötü** değer | eşik aşımı `ATTENTION` · `INFERENCE`/`CANDIDATE`; eşik altı `OK` · `INFERENCE`/`CANDIDATE`; eksik metrik/boş `UNKNOWN` |
| `performance` | `lcp_ms`, `inp_ms`, `cls` | Eşik web.dev "good": LCP ≤ 2500, INP ≤ 200, CLS ≤ 0.1 (üreticinin `THRESHOLDS.good` ile aynı). `lcp/inp ≤ 0` = ölçüm yok (null gibi), CLS=0 geçerli | field: üçü de gerekli; lab: INP yoktur, LCP+CLS yeterli (basis "saha değil" der) |
| `performance` | rapor `sites[].regressions[]` (opsiyonel) | Yalnız **yükseltir**: OK→ATTENTION; hiçbir zaman ATTENTION'ı düşürmez. Rapor bayat/başka site/şema uyumsuz → kullanılmaz, basis'e yazılır | `ATTENTION` · `INFERENCE`/`CANDIDATE` (neden iddiası yok) |
| `index_health` | `snapshots[]` en yeni `taken_at` | Yalnız `entries[].state=INSPECTED` gözlemdir; `ERROR` ne gözlem ne "indexli değil". `sample_size` = INSPECTED sayısı olmalı (tutarsız → UNKNOWN) | `OK` yalnız hepsi `INDEXED` ise, `INFERENCE`/`CANDIDATE` ("ÖRNEKLEM n URL, tam coverage değil") |
| `index_health` | `entries[].verdict` + uygunluk (`in_sitemap`, `fetch_ok`, `canonical_self`, `indexable` hepsi `true`) | `NOT_INDEXED` → ATTENTION; **indekslenmesi beklenen** `NEUTRAL` → ATTENTION; uygunsuz/bilinmeyen `NEUTRAL`/`UNKNOWN` → **UNKNOWN** (OK denmez) | `ATTENTION` · `INFERENCE`/`CANDIDATE` (bilinçli noindex/canonical olabilir) |
| `index_health` | rapor `index_alarms.status/alarms` (opsiyonel) | >24 saat süre hesabı üreticinin işidir; scorecard yeniden hesaplamaz. `status=ALARMS` → ATTENTION; rapor snapshot'tan eskiyse/başka siteyse kullanılmaz | `ATTENTION` · `INFERENCE`/`CANDIDATE` |
| `deployment_change` | `events[]` (`environment=production`, son 14 gün) | `preview`/`unknown` aramada görünmez → sayılmaz (basis'e sayısı yazılır). Tek bozuk/yabancı olay **tüm çizelgeyi** reddeder (üretici `parseTimeline` ile aynı fail-closed) | aşağıya bak |
| `deployment_change` | `verification_state` | `MISMATCH` → ATTENTION `FACT`/`CONFIRMED` (ölçüp uyuşmadığını gördük); `UNVERIFIED`/`UNKNOWN` → **UNKNOWN** (sağlayıcı "deploy ettim" dedi, canlı doğrulanmadı); tümü `VERIFIED` → OK `FACT`/`CONFIRMED`; 14 günde production deploy yok → OK `INFERENCE`/`CANDIDATE` | — |
| `deployment_change` | tazelik: en yeni `provenance.retrieved_at` | Çizelgenin kendi `generated_at`'i **yok**; bu alan "sağlayıcı/doğrulayıcı en son ne zaman sorgulandı"dır. Bayat → `UNKNOWN-STALE`. Boş çizelge → UNKNOWN | — |

Ölçüt: üreticinin kanıt etiketi (`evidence`, `ratings.label`, `confidence`) **taşınır, yükseltilmez**. Ölçülen sayı FACT'tir;
eşik/yorum INFERENCE'tır; INFERENCE hiçbir yerde CONFIRMED olmaz (`dimensionInvariantProblems` her senaryoda koşar).

## 3. Verilen kararlar

1. **Üretici kanonik, scorecard uyarlanır.** İlk sürümün uydurma alanları (`site_id`, `records[].measurement_state`,
   `not_indexed_count`, `{generated_at, events}`) **kaldırıldı**; eski şekil artık UNKNOWN verir (testli). Ciddi bir hata da düzeldi:
   üreticiler `site` yazar, `site_id` değil; eski kod `site_id` bulamayınca izolasyon kontrolünü *atlıyordu*.
   Yeni kapı `site` yoksa UNKNOWN verir ("izolasyon doğrulanamadı").
2. **`UNVERIFIED` ≠ ATTENTION.** Üretici parser'ları her olayı `UNVERIFIED` üretir; bu "sorun var" değil "bilmiyoruz"dur.
   Eski kod bunu ATTENTION sayıyordu (yanlış pozitif).
3. **Index NEUTRAL.** Gerçek örneklemde 8 INDEXED + 2 NEUTRAL görüldü (DEVAM.md). Uygun olup NEUTRAL kalan URL = ATTENTION; uygunsuz NEUTRAL
   = UNKNOWN. İkisi de "hepsi indexli" denmesine izin vermez (yanlış negatif koruması).
4. **Performans "son kayıt" değil "son gün".** Üretici günde çok kayıt yazar; tek kayıt okumak kötü URL'yi saklayabilirdi (FN testi var).
5. **Field ↔ lab karıştırılmaz** (üretici de karıştırmaz). Field varken kötü lab ATTENTION üretmez (FP), kötü field iyi lab ile maskelenmez (FN).
6. **Scorecard üreticiyi import etmez.** Round-trip testi dinamik import eder, modül yoksa skip.

## 4. Kalan boşluklar (üretici tarafında yapılması gerekenler; bu PR üretici branch'ine dokunmaz)

- **#32 zaman çizelgesinde `generated_at`/`last_checked_at` yok.** Tazelik `provenance.retrieved_at`'ten türetilir; çok uzun süre deploy
  olmayan site yanlışlıkla `UNKNOWN-STALE` görünür. Öneri: çizelgeye `generated_at` alanı (şema `additionalProperties:false` olduğu için
  üretici tarafında eklenmeli).
- **#34 alarm raporunun şema kimliği yok** (`CombinedReport` yalnız `{site, generated_at, index_alarms, canonical_backlog}`). Öneri: `schema: "sgos.index-alarm-report.v1"`.
  `canonical_backlog` scorecard'a bağlanmadı (ayrı bir boyut değil, `index_health` altında sayılabilir; ayrı karar).
- **Rapor dosyalarının kalıcı yeri tanımsız.** `performance-report` ve index raporu kalıcı bir yola yazılmıyor (yalnız `runPerformance`/`buildReport`
  dönüşü). Scorecard opsiyonel girdi olarak alır (`--performance-report`, `--index-report`); yoksa yalnız geçmişten hesaplar.
- **#34 index-history'de `NOT_CONNECTED` durumu yok.** Boş örnek (`sample_size=0`) → UNKNOWN; bağlı olmama ile erken durma ayırt edilemez.
- `sgos.measure-report.v1` üreticisi (#41) artık var ve scorecard gerçek şeklini okuyor (bkz. §5). `measure.yml` artık JSON'u üretir ve
  `reports/measure-report-latest.json` olarak (rolling snapshot, bkz. `docs/measure-report.md` §Workflow) commit eder; ilk planlı koşu
  2026-10-05'e kadar dosya depoda yoksa boyut UNKNOWN kalır (`--measure-report reports/measure-report-latest.json`).

## 5. `sgos.measure-report.v1` → `search_opportunity` (#41; `src/measure-report.ts`, `docs/measure-report.md`)

Scorecard **üretici modülü import etmez**; JSON'u yalnız şema kimliğiyle okur. Fixture: `tests/fixtures/scorecard-contracts/measure-report.pamistanbul.json`
(#41'in gerçek `buildMeasureReport`'undan; modül repodaysa round-trip testi birebir karşılaştırır, yoksa skip).
`{site}` = istenen site kimliği (`sites` bir **anahtarlı nesne**, dizi değil). Okunan alanlar:

- `schema`, `generated_at`
- `sites.{site}.site_id`, `sites.{site}.generated_at`, `sites.{site}.gsc_state`, `sites.{site}.opportunity_count`
- `sites.{site}.period.start`, `sites.{site}.period.end`
- `sites.{site}.gsc.state`, `sites.{site}.gsc.state_reason`, `sites.{site}.gsc.rows_complete`
- `sites.{site}.gsc.coverage.queries_truncated`, `sites.{site}.gsc.coverage.query_rows_total`, `sites.{site}.gsc.coverage.query_rows_returned`
- `sites.{site}.search_opportunity_inputs.state`, `sites.{site}.search_opportunity_inputs.candidates`

| Koşul | `search_opportunity` | Etiket / güven |
|---|---|---|
| dosya yok / şema ≠ `sgos.measure-report.v1` / `sites` nesne değil / site anahtarı yok | `UNKNOWN` | FACT / UNKNOWN |
| girdinin `site_id`'si ≠ istenen site (ya da yok) — anahtar doğru olsa bile | `UNKNOWN` (izolasyon doğrulanamadı) | FACT / UNKNOWN |
| `generated_at` > eşik (varsayılan 10 gün) | `UNKNOWN-STALE` | FACT / UNKNOWN |
| `gsc` yok, ya da `gsc_state` ≠ `gsc.state` takma adı (MEASURED↔CONNECTED) | `UNKNOWN` (şema kayması) | FACT / UNKNOWN |
| `gsc.state = NOT_CONNECTED` | `NOT_CONNECTED` (boyutun mevcut sözleşmesi; ne OK ne 0) | FACT / CONFIRMED |
| `gsc.state = ERROR` / `UNKNOWN` | `UNKNOWN` (`state_reason` basis'e) | FACT / UNKNOWN |
| `MEASURED`, `opportunity_count` sayı değil / aday listesi sayıyla tutarsız (0↔dolu, >0↔boş, aday>sayı) | `UNKNOWN` | FACT / UNKNOWN |
| `MEASURED`, sayı > 0 | `ATTENTION` | INFERENCE / CANDIDATE |
| `MEASURED`, sayı = 0, `rows_complete=true` | `OK` ("gerçek sıfır") | INFERENCE / CANDIDATE |
| `MEASURED`, sayı = 0, `rows_complete` false/null | `UNKNOWN`: eksik satırlardan "fırsat yok" çıkmaz | FACT / UNKNOWN |

**ATTENTION kararı.** `opportunity_count > 0` bir *arıza* değil *fırsat sinyalidir*; ama boyutun sözleşmesi "ATTENTION = insan bakmalı"
ve bu ilk sürümden beri böyle. Yeni durum icat edilmedi; fırsat adayı etiketi INFERENCE/CANDIDATE kalır (aday kural-tabanlı çıkarımdır,
asla FACT/CONFIRMED, asla RECOMMENDATION: öneri yalnız onboard edilmiş siteye ve insan kararına bağlıdır).
**Kesilme / eksik satır.** `rows_complete=false` ya da `queries_truncated=true` iken durum yine ölçülen sayıdan hesaplanır (`opportunity_count`
üreticide tablo kesilmesinden bağımsız, tüm satırlardan sayılır), ama `basis` "UYARI: …" taşır (`rows_complete=false` → sayı alt sınır; kesilme →
adaylar tam liste değil). Tek istisna yukarıdaki sıfır satırıdır: sıfır, tamamlanmamış veriyle **kanıtlanmaz** (yanlış negatif, kural 6).
Gerçek ölçülmüş sıfır (`api_empty_response` dahil, gösterim 0) geçerli bir `OK`'tur ve UNKNOWN ile karıştırılmaz.

Eşleme (üretici alanı → boyut): `gsc.state`/`gsc_state` → durum; `opportunity_count` + `search_opportunity_inputs.candidates` → ATTENTION/OK ve
tutarlılık; `period.start..end` → basis; `gsc.rows_complete`, `gsc.coverage.*` → basis uyarıları; `generated_at` → `as_of` ve tazelik.
