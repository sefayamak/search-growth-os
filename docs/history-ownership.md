# Tarihçe sahipliği ve main'e yazma yarışı

Kapsam: `src/orchestration.ts` modeli + `tests/history-ownership.test.ts`. Bu belge **tasarım ve doğrulama kuralıdır**;
hiçbir schedule açılmadı, hiçbir workflow yazılmadı. Model durumu: `lighthouse-weekly`, `index-alarms-daily`,
`deployment-verifier`, `scorecard-weekly` = **PLANNED**; `clarity-daily` = **GATED** (bayrak: `vars.SEARCH_GROWTH_CLARITY_DAILY_ENABLED == 'true'`).

## 1. Kanonik kural

```
ölçüm modülü → makine-okunur çıktı → tarihçe sahipliği → kalıcılık → scorecard tüketimi
```

Her halka `HISTORY_OWNERS` kaydında (src/orchestration.ts) ayrı bir alandır ve boş bırakılamaz (`HISTORY_CHAIN_INCOMPLETE`):

| Halka | Alan | Anlamı |
|---|---|---|
| 1 | `measurement_module` | ölçümü yapan modül (`src/...`) |
| 2 | `schema` | modülün makine-okunur çıktı şema kimliği |
| 3 | `owner_job` | bu yola yazan **tek** iş (`Job.id`) |
| 4 | `persistence` | `commit_main` (main'e commit) ya da `artifact_only` |
| 5 | `consumers` + `scorecard_dimensions` | salt-okunur tüketici iş(ler) ve beslediği boyutlar |

**Tek yazar kuralı yol bazlıdır, iş bazlı değil**: bir iş birden çok dizine yazabilir (`index-alarms-daily` iki dizine yazar), ama bir dizinin
iki yazarı olamaz. Yol çakışması dizin önekiyle de yakalanır (`reports/` ile `reports/scorecard-…`). `artifact:` yazımları depo yolu değildir; çakışmaz.

## 2. Tarihçe → yazar tablosu

| Yol | Ölçüm modülü | Çıktı şeması | TEK yazar (`writes`) | Kalıcılık | Scorecard tüketimi | Üretici durumu |
|---|---|---|---|---|---|---|
| `data/clarity-history/` | `src/clarity-daily.ts` | `sgos.clarity-history.v1` | `clarity-daily` (GATED) | commit_main | `measurement_health`, `ux_friction` | main |
| `data/performance-history/` | `src/performance.ts` | `sgos.performance-history.v1` | `lighthouse-weekly` (PLANNED) | commit_main | `performance` | PR #36 |
| `data/index-history/` | `src/index-alarms.ts` | `sgos.index-history.v1` | `index-alarms-daily` (PLANNED) | commit_main | `index_health` | PR #34 |
| `data/canonical-backlog/` | `src/index-alarms.ts` | `sgos.canonical-backlog.v1` | `index-alarms-daily` (PLANNED) | commit_main | **okunmuyor** | PR #34 |
| `data/deployment-timeline/` | `src/deployment-timeline.ts` | `sgos.deployment-timeline.v1` | `deployment-verifier` (PLANNED) | commit_main | `deployment_change` | PR #32 |

Diğer yazarlar (tarihçe değil, rapor): `measure` → `reports/` ve `content/topic-ledger.json` (commit, main). Hepsi `scorecard-weekly` dahil
başka hiçbir iş bu yollara yazmaz. **`scorecard-weekly` yalnız `artifact:scorecard-<run_id>` yazar, hiçbir şey commit etmez** (`HISTORY_CONSUMER_WRITES`
bunu zorlar). `reports/scorecard-…` yazması gerekirse önce kendi yolu ve tek-yazar kaydı olmalı; v1'de bilerek artifact.

## 3. Doğrulayıcı (`validateModel`) — yeni kodlar

| Kod | Ne yakalar |
|---|---|
| `MULTI_WRITER` (ERROR) | iki iş (DISABLED hariç, PLANNED dahil) aynı/üst-alt yola yazıyor |
| `HISTORY_WRITER_NOT_OWNER` | kayıtlı bir tarihçe yoluna sahibi olmayan iş yazıyor |
| `HISTORY_UNREGISTERED_WRITE` | `data/` altına yazan iş var ama `HISTORY_OWNERS` kaydı yok |
| `HISTORY_PATH_REQUIRED_MISSING` | beş zorunlu yoldan birinin sahibi yok (`REQUIRED_HISTORY_PATHS`) |
| `HISTORY_DUPLICATE_PATH` | aynı yol için iki sahip kaydı |
| `HISTORY_OWNER_UNKNOWN_JOB` | sahip/tüketici iş modelde yok |
| `HISTORY_OWNER_NOT_WRITER` | sahip iş yolu `writes`'ında taşımıyor |
| `HISTORY_CHAIN_INCOMPLETE` | zincir halkası boş; boyut var tüketici yok (ya da tersi) |
| `HISTORY_PERSISTENCE_MISMATCH` | `commit_main`/`artifact_only` ile işin `commits_to_main`'i çelişiyor |
| `HISTORY_CONSUMER_WRITES` | tüketici depoya yazıyor / commit ediyor |
| `HISTORY_CONSUMER_NOT_DEPENDENT` | tüketici sahibine `depends_on` ile bağlı değil |
| `COMMIT_POLICY_MISSING` | commit eden işte `commit_group`/`push_strategy` yok; ya da `(commit, main)` yazıp bayrak yok |
| `MAIN_COMMIT_RACE` | main'e commit eden iki iş farklı concurrency grubunda (WARN: ikisi de canlı; INFO: biri PLANNED) |
| `PUSH_WITHOUT_REBASE` | `plain_push` iş + başka commit eden iş var (WARN canlı; ERROR PLANNED) |

**Drift** (`diffWorkflows`, gerçek `.github/workflows/*.yml` ile): `COMMIT_NOT_IN_MODEL` (workflow `git push` ediyor, model bilmiyor),
`MODEL_COMMIT_NOT_IN_WORKFLOW`, `PUSH_STRATEGY_DRIFT`, `CONCURRENCY_NOT_IN_WORKFLOW`, `GIT_ADD_NOT_IN_MODEL` (workflow modelde olmayan bir yolu stage ediyor).
Yani modelde olmayan gizli bir yazar test kırar.

## 4. Eşzamanlılık / yarış analizi (bugünkü gerçek durum)

Gerçek workflow'lardan okunanlar (`.github/workflows/`, bu oturumda doğrulandı):

| Workflow | concurrency grubu | commit | `git pull --rebase` | Zaman (UTC) |
|---|---|---|---|---|
| `measure.yml` | `measure` | `reports/measure-latest.md`, `reports/runs/`, `content/topic-ledger.json` | **YOK** (düz `git push`) | Pzt 06:40 |
| `clarity-daily.yml` | `clarity` (`clarity.yml` ile kota için paylaşılır) | `data/clarity-history/` | var (`git pull --rebase origin main`, sonra push) | günlük 07:20 (GATED) |

Bulgular:

1. **İki farklı grup = iki iş aynı anda main'e push edebilir.** `measure` grubu ile `clarity` grubu birbirini kilitlemez. Bugün zamanlar ayrı (Pzt 06:40 vs 07:20) olduğu için
   pratikte çakışma düşük, ama bu bir *zamanlama şansı*, garanti değil. Model bunu `MAIN_COMMIT_RACE` (WARN) olarak gösterir.
2. **`measure.yml` push öncesi rebase yapmıyor.** O iş çalışırken main ilerlerse (clarity-daily commit'i, insan merge'i, başka bot) `git push` non-fast-forward ile reddedilir,
   rapor commit'i **kaybolur** (artifact kalır). `PUSH_WITHOUT_REBASE` (WARN). Düzeltme tek satır ama mevcut workflow'a dokunmak bu PR'ın kapsamı dışında → takip işi (§7).
3. **`git pull --rebase` yalnız farklı dosyalarda temizdir.** Her tarihçe dizininin tek yazarı olduğu için bot-bot çatışması **yapısal olarak** yok; kalan çatışma kaynağı **insan**:
   `data/canonical-backlog/` içindeki `owner_status` alanlarını sahip PR ile elle yazar (index-alarms'ın tasarım kararı). Bot aynı dosyayı aynı anda güncellerse rebase çatışır → iş **yüksek sesle başarısız
   olur** (ezmez) ve bir sonraki koşu yeniden hesaplar. Bu kabul edilen risk; kalıcı çözüm sahip kararlarını ayrı bir dosyada tutmak (üretici tarafında değişiklik; §7).
4. **Scorecard yarıştan etkilenmez, yalnız bayat görür.** Scorecard salt-okunur; yazar işler henüz commit etmediyse dosya eski kalır ve boyut `UNKNOWN-STALE` olur (yanlış `OK` değil).
   `depends_on` zamanlama garantisi değil, model bağıdır: scorecard cron'u (Pzt 08:10) yazarların cron'larından sonra seçildi (lighthouse 07:10, index-alarms 07:40, clarity 07:20, measure 06:40).
5. **Bot commit'leri başka workflow'u tetiklemez** (varsayılan `GITHUB_TOKEN` push'ları yeni workflow koşusu başlatmaz) — *GitHub Actions belgelerinden bilinen davranış; bu oturumda belgeye erişilmedi,
   doğrulanmadı.* `tests.yml` bot commit'lerinde koşmaz; bu kabul edilebilir çünkü bot yalnız veri dosyası yazar.
6. **Concurrency kuyruğunun sınırı:** aynı grupta en fazla 1 koşan + 1 bekleyen iş vardır; üçüncü bekleyen gelince eski bekleyen **iptal edilir** (`cancel-in-progress: false` olsa bile) — *yine belgelerden bilinen
   davranış, bu oturumda doğrulanmadı.* Bu yüzden ortak grup tek başına "kayıpsız kuyruk" değildir; asıl koruma **tek yazar + rebase + sınırlı yeniden deneme**dir, grup ek kemerdir.
   `deployment-verifier` olay güdümlü (deploy patlamasında çok koşu) olduğu için en çok bundan etkilenir; çözümü her koşunun **tüm** deploy listesini çekmesi (idempotent, `appendEvent` zaten site+sha+ortam ile tekilleştirir),
   böylece iptal edilen koşu veri kaybettirmez.
7. **Branch koruması bilinmiyor.** `main` koruma kuralı bot push'unu engelliyorsa bütün commit'ler başarısız olur; bu depodan doğrulanamaz → `UNKNOWN`, Sefa'nın teyidi gerekir.

## 5. Önerilen tek-yazar tasarımı

1. **Her üreticinin KENDİ workflow'u yalnız KENDİ dizinini commit eder** (`git add data/<kendi-dizini>/`; başka yol yok). `GIT_ADD_NOT_IN_MODEL` drift testi bunu zorlar.
2. **Scorecard salt-okunur tüketici**: hiçbir şey commit etmez; çıktısı yalnız artifact (`artifact:scorecard-<run_id>`). İleride `reports/scorecard-latest.md` istenirse önce tek-yazar kaydı açılır.
3. **Commit adımı ayrı `persist` job'ına** taşınır: `needs: <ölçüm job'ı>`, `concurrency: { group: main-writes, cancel-in-progress: false }`, adımlar: taze checkout → artifact indir →
   yalnız kendi dizinini yaz → `git pull --rebase origin main` → `git push`; push reddedilirse en çok 3 kez `pull --rebase && push`. Ölçüm job'ının kendi grubu (örn. `clarity`: Clarity kotası) **ayrı kalır**:
   kota kilidi ile main-yazma kilidi farklı şeylerdir, tek grupta birleştirilmez.
4. **Tüm commit eden işler aynı `main-writes` grubunu** (`TARGET_COMMIT_GROUP`) kullanır; model bunu PLANNED işler için zaten böyle tanımlar. `measure` ve `clarity-daily` bu hedefe geçince `MAIN_COMMIT_RACE` ve
   `PUSH_WITHOUT_REBASE` bulguları söner (testle gösterildi: gruplar eşitlenince bulgu kalkar).
5. **Zamanlar kademeli kalır** (grup garanti vermediği için ikinci savunma): Pzt 06:40 measure → 07:10 lighthouse → 07:20 clarity → 07:40 index-alarms → 08:10 scorecard.
6. **Reddedilen alternatif:** ayrı bir `data` dalı. Yarışı tamamen kaldırırdı ama `clarity-daily` tasarım kararıyla çelişir ("geçmiş main zincirinde yaşar: her gün ayrı dala push etme hatası tekrarlanmaz"); verilmiş karar tartışılmadı.

## 6. Kararlar

- Tek yazar kuralı **yol bazlı**; `index-alarms-daily` iki dizinin tek yazarıdır, `index-probe` yalnız artifact yazar.
- Scorecard commit etmez (v1). `scorecard-weekly.writes = ["artifact:scorecard-<run_id>"]`.
- `commits_to_main`, `commit_group`, `push_strategy` model alanlarıdır ve gerçek workflow'larla drift testine bağlıdır (`measure`: `measure` + `plain_push`; `clarity-daily`: `clarity` + `rebase_then_push`).
- PLANNED işler gelecekteki hedef düzene (`main-writes`, `rebase_then_push`) göre tanımlıdır; PLANNED iş `plain_push` ise ERROR (tasarım aşamasında yakalanır).
- Hiçbir schedule açılmadı; PLANNED işler için workflow dosyası bulunmadığı testle sabitlendi.

## 7. Kalan boşluklar (bu PR yapmaz)

- `measure.yml` düz `git push`: `git pull --rebase origin main` eklenmeli ve commit adımı ortak gruba taşınmalı (mevcut workflow değişikliği; Sefa onayı + ayrı PR).
- `clarity-daily.yml` commit adımı `clarity` grubunda; ortak `main-writes` grubuna `persist` job'ı ile taşınması gerekir (aynı PR).
- Üretici workflow'ları (`lighthouse.yml`, `index-alarms.yml`, `deployment-verifier.yml`, `scorecard.yml`) henüz yok; yazıldıklarında modelle birlikte gelir, drift testi kırılır (istenen).
- `canonical-backlog` insan yazımı (`owner_status`) ile bot yazımı aynı dosyada: sahip kararlarının ayrı dosyaya alınması üretici (#34) tarafında karar bekliyor.
- GitHub concurrency/GITHUB_TOKEN davranışı ve `main` branch koruması bu oturumda doğrulanamadı.
