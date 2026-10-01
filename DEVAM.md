# DEVAM — 20 Eylül 2026 akşamı bırakıldığı yer

Bu dosya, işi devralanın (insan ya da yeni bir Claude oturumu) okuyacağı ilk yer.
Türkçe yazıldı; teknik terimler İngilizce kaldı.

**"Devam et" denildiğinde:** aşağıdaki "Sıradaki tek adım"dan başla. Geçmişi bu
dosyadan öğren, oturum geçmişinden değil — o kaybolur, bu kalır.

**Ofis bilgisayarından, kurulum yapmadan çalışacaksan:** [`OFIS.md`](OFIS.md).
Her şey tarayıcıdan yapılabiliyor — ölçüm GitHub Actions'ta koşuyor, Vercel'in bu
sistemle bir ilgisi yok (o yalnız siteleri yayına alıyor).

---

## GÜNCEL DURUM — 1 Ekim 2026 (bu bölüm, aşağıdaki 20 Eylül notlarından önceliklidir)

20 Eylül'den sonra değişenler. Aşağıdaki bölümler **tarihsel kayıt** olarak kaldı; çelişen yerde bu bölüm doğrudur.

| Eski not (20 Eylül) | Bugün (doğrulandı) |
|---|---|
| "GSC/GA4 bağlı değil, UNKNOWN kalır" (bölüm 6) | **Bağlı.** `reports/measure-latest.md` (28 Eylül): 7/7 GSC OK, 7/7 GA4 OK. Service account + Search Console + GA4 erişimi tamamlandı |
| "65 test" | **345 test**, `npm run typecheck` temiz |
| "iki workflow var" | Beş: `measure.yml` (haftalık GSC+GA4), `tests.yml` (her PR'da test), `index-probe.yml` (yalnız elle), `portfolio-check.yml`, `search-audit.yml` |
| "Sıradaki adım: 3 PR'ı merge et" (pamistanbul-site #89/#90, pamaistudio#40) | Bu depodan **doğrulanamadı**; o repolar bu oturumun kapsamı dışı. Sefa'nın teyidi gerekir |
| 18 skill | 18 skill (README'deki "15" eskiydi, düzeltildi) |

**Bu depodaki PR #1–#12 kapalı/merge edilmiş; açık PR yok** (Phase 1 PR'ı hariç). Eski `claude/*` branch'ler duruyor, silinmedi.

### Web Growth OS birleştirmesi (Issue #13)

`search-growth-os` canonical sistemdir. `sefayamak/site-health-monitor` ayrı bir günlük rutin
(Clarity + GSC) olarak **çalışmaya devam eder**; Phase 1'de ona dokunulmadı.

Phase 1'de eklenenler (hepsi salt-okunur; sınır sözleşmesi: `docs/integrations/site-health-monitor.md`):

- `import-health <dizin>` — shm snapshot'ını **yerel dizinden** okur ve doğrular. "Veri yok ≠ sıfır",
  çift-tarih/idempotency, site izolasyonu. Ağ, git ya da token gerekmez.
- URL envanteri tipi + şeması (`schemas/url-inventory.schema.json`).
- `inspect-index` — **yalnız pamistanbul**, URL Inspection **ÖRNEKLEMİ** (tam coverage değil), düşük
  varsayılan limit (20, sert tavan 100), 403/429 = ERROR, eksik alan = UNKNOWN. Google Indexing API'nin yazma ucu kod tabanında yok.
- `opportunity_source: "gsc_evidence" | "editorial"` ayrı alan. `EDITORIAL` bir evidence label **değildir**;
  evidence sözlüğü altı etiketle sabit.

Verilmiş kararlar (tekrar tartışılmaz): `pamistanbul` **`pilot_onboarding` olarak kalır**, Phase 1 kabul
edilene kadar `active` yapılmaz. Eski sistemler kapatılmaz/temizlenmez; mevcut workflow'lar değişmedi.

**Güncelleme (1 Ekim, merge sonrası):** PR #14 main'de (`f68706e`). `index-probe.yml` canlı koşuldu
(run 36824162453, limit 5): 5/5 INSPECTED, 5/5 INDEXED, ham alanlar şemayla uyumlu, sitemap listesi döndü. Phase 1
canlı doğrulanmış sayılır. Dikkat: bu 5/5, adaylar yalnız GSC'de görünen sayfalar olduğu için "site index coverage
sağlıklı" demek **değildir**. Phase 1.5a bunu `--strategy segmented` ile ele alır (`docs/integrations/index-probe.md`):
varsayılan hâlâ `gsc`, `schedule` yok; ilk canlı segmented koşu (limit 10) merge sonrası, ayrı kararla.

**Phase 1.5a canlı doğrulandı (run 36827031582, segmented, limit 10):** 10/10 INSPECTED, 8 INDEXED, 2 NEUTRAL, 0 ERROR; ham alanlar
(indexingState, pageFetchState, robotsTxtState, lastCrawlTime) uyumlu; dört segment COMPUTED. İki **canonical divergence adayı** çıktı
(`bath-loofah-lifestyle`: userCanonical pamaistudio.com; `ucretsiz-ai-gorsel-uretme-araclari-2026.html`: Google www+.html varyantını seçmiş).
Bunlar henüz hata sayılmaz: CONFIRMED ilişki verisi + CANDIDATE / REVIEW_REQUIRED. Phase 1.5b ilk dilim: `canonical_relations` sınıflandırıcısı
(`docs/integrations/index-probe.md`); fetch tabanlı ön-tarama hâlâ yok.

**Phase 1.5b ilk dilim tam canlı doğrulandı (run 36828755651, main 9e7b701):** 4 canonical candidate (HOST_VARIANT_RISK 3, GSC_NOT_IN_SITEMAP 1),
JSON ve markdown birebir uyumlu. Dördünün ikisi gerçek canonical disagreement (`user_vs_google = DIFFERENT`), ikisi Google ile sayfanın aynı hedefte uzlaştığı
host varyantı. Bunları ayırmak için ikinci dilim: `canonical_pattern` (`docs/integrations/index-probe.md`); `review_required` anlamı korundu.

**Phase 2A (main'de, #18): native Clarity adapter — canlı doğrulandı.** `src/adapters/clarity.ts`, `clarity-smoke` (offline) / `clarity-measure`,
`.github/workflows/clarity.yml` (yalnız workflow_dispatch, schedule yok). Secret: `SEARCH_GROWTH_CLARITY_TOKENS_JSON` (site id → token). İlk canlı koşu (run 36835627390,
site=pamistanbul, main b9a0edd): workflow/job success, log'da `3/3 request, MEASURED`, token log'da maskeli. Artifact içeriği bu oturumdan okunamadı (blob host egress'te kapalı);
proje sahibinin artifact'tan bildirdiği değerler (sahip bildirimi, bu depoda ayrıca saklanmadı): `confidence=CONFIRMED`, 3 istek HTTP 200 / attempts=1, `metric_row_count_total=428`,
`max_metric_row_count=57`, `rows_complete=true`, yanıt satır anahtarı `Url`, 9 bilinen metricName (DeadClickCount, EngagementTime, ErrorClickCount, ExcessiveScroll, QuickbackClick,
RageClickCount, ScriptErrorCount, ScrollDepth, Traffic), bilinmeyen metrik yok, privacy temiz. Legacy site-health-monitor HÂLÂ çalışır; ikinci bağımsız takeover koşusu gelmeden kapatılmaz.
Ayrıntı: `docs/integrations/clarity.md`.

**Phase 2B (main'de, #19): Cloud Brain temeli.** `src/brain/*`, `agents/*.md` (9 kanonik ajan) → GitHub Actions → Anthropic API → seçici yönlendirme (≤3 uzman) → Chief →
uyum. `brain-evidence` / `brain-validate` (offline) / `brain-run`; `.github/workflows/brain.yml` (yalnız workflow_dispatch, contents: read). Secret `SEARCH_GROWTH_ANTHROPIC_API_KEY`,
model repo variable `SEARCH_GROWTH_ANTHROPIC_MODEL`. **Canlı koşulmadı**; testler sahte istemciyle. Hiçbir şey yazmaz (production_write=false), DRAFT_PR_CANDIDATE yalnız etiket,
bellek varsayılan salt-okunur. Ayrıntı: `docs/brain/cloud-brain.md`.

**Phase 2B.1 (PR açık, merge edilmedi): kanıt devri.** `brain.yml` artık Clarity artifact'ını açık `clarity_run_id` ile (bu repo, `actions: read`) indirip yalnız seçilen sitenin
`clarity-<site>.json`'unu doğrular, `sgos.brain.evidence.v1` + additive `provenance` üretir ve `brain-validate` çalıştırır; **Anthropic çağrısı yok**, evidence repoya commit edilmez (7 günlük artifact).
Yabancı site = FAILED, artifact yok = NOT_AVAILABLE. Ayrıntı: `docs/brain/cloud-brain.md`.

**Bilinen veri sorunu (FACT):** 28 Eylül'de shm, Clarity'ye 7 sitenin 7'sinde erişemedi (ağ izni) ve
history'ye sıfır satır yazdı; pamistanbul ve spryhand için aynı güne iki **farklı** satır var. İçe aktarıcı
bunları `UNKNOWN` sayar. Clarity serisi, shm'nin ağ izni düzelene kadar güvenilmezdir.

**Phase 2'ye kalanlar:** Clarity client'ı, shm OAuth yolunun emekliliği, Lighthouse/CWV, deploy geçmişi,
içerik taslağı → PR hattı, dashboard.

---

## 0. Yeni oturum: ilk beş dakika

**YAPMA.** Bunlar zaten yapıldı ve tekrarı saatler yer:

- Depoyu yeniden keşfetme, dosyaları tek tek okuma — durum bu dosyada
- Ölçümleri yeniden çalıştırma — 20 Eylül sonuçları bölüm 5'te, sitelerde değişen
  bir şey yoksa yeniden koşmaya gerek yok
- `llms.txt` konusunu yeniden araştırma — bitti, kaynaklar
  `policies/references/llms-txt.md` içinde tarihli duruyor
- Kuruluş yılını yeniden sorgulama — 2018, karar verildi (bölüm 3)
- Diğer altı siteyi klonlama — yalnız o siteye dokunacaksan gerekir
- Yeni bir denetim aracı yazma — `portfolio`, `llmstxt`, `audit` zaten var

**YAP.** Tek komut, otuz saniye:

```bash
cd search-growth-os && git pull && npm test
```

345 test yeşil gelmeli (20 Eylül'de 65 idi). Sonra bölüm 2'deki tek adıma geç.

Bir şeyin hâlâ geçerli olup olmadığından şüphelenirsen ölçümü tekrarla —
ama önce bu dosyadaki sayıya bak; çoğu soru orada cevaplı.

---

## 1. Tek cümleyle nerede kaldık

Search Growth OS kuruldu ve çalışıyor; 7 sitenin içerik ritmi ve `llms.txt`
durumu ölçüldü; bulunan iki gerçek hata için üç PR açıldı ve **üçü de yeşil,
merge edilmeyi bekliyor**.

---

## 2. Sıradaki tek adım

**Üç PR'ı merge et.** Hepsi `draft` durumda, o yüzden GitHub merge düğmesini
kapatıyor. Her biri için: PR'ı aç → **Ready for review** → **Merge pull request**.

| PR | Ne yapıyor | CI |
|---|---|---|
| [pamistanbul-site#89](https://github.com/sefayamak/pamistanbul-site/pull/89) | Kuruluş yılı 2017 → 2018 (275 geçiş, 137 dosya) | yeşil |
| [pamistanbul-site#90](https://github.com/sefayamak/pamistanbul-site/pull/90) | `llms.txt`'i indekse döndür (−%28) | yeşil |
| [pamaistudio#40](https://github.com/sefayamak/pamaistudio/pull/40) | Kuruluş yılı + 2017'yi dayatan guard'ı ters çevir | yeşil |

#89 ve #90 aynı depoda ama farklı satırlara dokunuyor — sırası önemli değil,
çakışmazlar. Merge sonrası Vercel canlıya alır.

---

## 3. Bu oturumda alınan kararlar — bir daha tartışılmasın

**Kuruluş yılı 2018.** Sefa 20 Eylül'de doğruladı. Bu, 28 Ağustos'taki
"2018 → 2017" talimatının yerine geçer. `pamaistudio/scripts/fixes/2026-08-28-entity-2017-600.mjs`
o eski talimatın kaydıdır ve **kasten değiştirilmedi** — hangi kararın ne zaman
verildiğinin kanıtı olarak duruyor.

**`llms.txt` büyütülmeyecek, küçültülecek.** Gerekçe ölçülmüş:

- Spec bir link indeksi tanımlıyor; soru bölümü, FAQ bölümü, soru limiti yok
- Google dosyayı yok sayıyor (kendi dokümanında yazılı)
- Ahrefs, 137.210 domain: dosyaların **%97'si sıfır istek** aldı (Mayıs 2026)
- Şema da AI alıntısını artırmıyor: 1.885 sayfalık kontrollü testte AI Overviews
  alıntıları **%4.6 düştü**

Sorular sayfalarda durmalı — orada sıralanır, URL'le alıntılanır ve Google görür.
Tam gerekçe ve kaynaklar: `policies/references/llms-txt.md`.

**PAM AI Studio 2025'te açıldı** ve bu ayrı bir gerçek. Onun için hem 2017 hem
2018 yanlış. `entity-truth.mjs`'teki `AI_UNIT_WRONG_YEAR` kuralı bu yüzden
değiştirilmedi.

---

## 4. Sistem ne yapıyor, nasıl çalıştırılır

Depo: `sefayamak/search-growth-os` · yerel: `/home/user/search-growth-os`

### Terminalsiz (ana yol)

GitHub → **Actions** → iş seç → **Run workflow**:

| Workflow | Ne yapar | Otomatik |
|---|---|---|
| **Portfolio content check** | 7 sitenin son yayın tarihi + `llms.txt` envanteri | Pazartesi 09:10 (İstanbul) |
| **Search audit** | Teknik SEO denetimi (tek site) | Pazartesi 09:40 |

Sonuç: run sayfasının **Summary** sekmesinde, ayrıca **Artifacts**'ta dosya olarak.

### Terminalden

```bash
node --experimental-strip-types src/cli.ts portfolio     # içerik ritmi, 7 site
node --experimental-strip-types src/cli.ts llmstxt       # llms.txt envanteri
node --experimental-strip-types src/cli.ts audit --site pamistanbul --full
node --experimental-strip-types src/cli.ts registry config/sites.yaml
npm test                                                  # 345 test
```

Bağımlılık yok, sadece Node 24.

### Konuşarak (Claude Code bu klasörde açıkken)

18 skill var. "siteleri kontrol et", "ne yayınlamalıyım", "rakip keşfi başlat",
"trafik düştü sebebini bul" gibi düz cümlelerle çalışır.

---

## 5. Son ölçümler (20 Eylül)

### İçerik ritmi

| Site | Bölüm | Son yayın | Gün | Hedef | Karar |
|---|---|---|---|---|---|
| **pamistanbul** | /pamlab/ (175) | 2026-09-03 | **17** | 10 gün | **DUE** |
| decideplan | /blog/ (10) | 2026-08-20 | 31 | 14 (varsayılan) | OVERDUE |
| myhappymade | /blog/ (34) | 2026-08-20 | 31 | 14 (varsayılan) | OVERDUE — `dateModified`, CANDIDATE |
| spryhand | /guides/ (50) | — | — | — | UNKNOWN — hiçbir sayfa tarih belirtmiyor |
| rightlisted · untitledportraits · pamaistudio | — | — | — | — | içerik bölümü yok |

### llms.txt

7 sitenin hepsi hem `llms.txt` hem `llms-full.txt` sunuyor.

| Site | Token | Link | Soru | Durum |
|---|---|---|---|---|
| pamistanbul | ~18.5–21.4K → **~13.4–15.4K** (#90 ile) | 173 | 59 → **0** | düzeltiliyor |
| pamaistudio | ~5.4–6.3K | **0** | 0 | link indeksi hiçbir şeyi indekslemiyor |
| spryhand | ~0.8K (full: **~67–77K**) | 20 | 0 | oransız |
| decideplan · rightlisted · untitledportraits · myhappymade | 0.8–6.4K | 6–51 | 0 | **temiz, dokunma** |

---

## 6. Bekleyen işler — öncelik sırasıyla

### Sefa'dan gereken (bunlar gelmeden ölçülemez)

1. **Google service account** aç
2. **Search Console** → `sc-domain:pamistanbul.com` → Users and permissions → **Full**
3. **GA4** → Property access management → aynı e-posta → **Viewer**
4. `G-EYY9Z20XJ4` ölçüm ID'sine ait **sayısal Property ID**

Bunlar olmadan index durumu, impression, tıklama, sorgu ve dönüşüm **UNKNOWN**
kalır ve uydurulmaz.

### Karar bekleyenler

| # | İş | Not |
|---|---|---|
| 1 | **pamaistudio llms.txt'e link ekle** ya da dosyayı kaldır | 20 KB dosyada sıfır link; H1 "llms.txt — PAM AI Studio" (dosya adı, marka adı değil); blockquote özet yok. Dosya `scripts/gen-ai-endpoints.mjs` ile üretiliyor — kaynak `content/company-facts.json` |
| 2 | **`llms-full.txt` kararı (pamistanbul)** | ~277–319 bin token. Hiçbir asistan bütün yüklemez; gerçek davranışı "tahmin edilemez bir kısmı okunur". Konuya böl ya da kaldır |
| 3 | **spryhand `/guides/` sayfalarına `datePublished`** | 50 sayfa, hiçbirinde tarih yok. Önce sayfalar, sonra llms dosyaları |
| 4 | **PamLab'a yeni içerik** | 17 gün oldu, hedef 10. "Konu öner" dersen çalışır — ama Search Console bağlı olmadığı için yalnızca sitenin kendi kapsam boşluklarından öneri çıkar, gerçek arama talebinden değil |
| 5 | **pamistanbul 2017 → 2018 sonrası kontrol** | #89 merge edilince canlıda doğrula: `pamistanbul.com/llms.txt` ilk satırında "founded in 2018" yazmalı |

### Dokunulmayacaklar

- **decideplan, rightlisted, untitledportraits, myhappymade** — llms.txt'leri
  ölçüldü, spec'e uygun, çelişkisiz. Yapılacak bir şey yok.
- **pam-crm** — özellik dondurması altında, Search Growth OS ile ilgisi yok.
- **pamaistudio `scripts/fixes/*`** — geçmiş kararların tarihli arşivi.

---

## 7. Bu sistemin değişmez kuralları

1. **Ölçülmeyen sayı yazılmaz.** Bağlı olmayan entegrasyon `NOT_CONNECTED`,
   bilinmeyen değer `UNKNOWN`. Tahmin yok.
2. **Her bulgu iki etiket taşır:** kanıt türü (FACT / INFERENCE / HYPOTHESIS /
   RECOMMENDATION) ve güven (CONFIRMED / CANDIDATE / FALSE_POSITIVE / UNKNOWN).
   `CANDIDATE` gören hiçbir şey insan bakmadan değişmez.
3. **Portföy izolasyonu.** Bir sitenin anahtar kelimesi, rakibi, stratejisi,
   baseline'ı asla diğerine taşınmaz. Ölçüm her site için yapılabilir; **tavsiye
   yalnızca onboard edilmiş site için** üretilir.
4. **Üretim sitesine doğrudan yazılmaz.** Her değişiklik PR olarak gelir,
   insan merge eder.
5. **Uydurma istatistik REJECT seviyesi ihlaldir.** Arama hacmi, büyüme yüzdesi,
   sıralama, rakip trafiği — bağlı bir araç üretmediyse yazılmaz.

---

## 8. Bu oturumda yapılan hatalar — tekrarlanmasın

Araç dört kez yanlış çalıştı. Dördü de teste bağlandı (`tests/llmstxt.test.ts`,
`tests/cadence.test.ts`):

| Hata | Sonuç |
|---|---|
| `beri` kelimesi `rehberi` içinde eşleşti | Kendi dosyamızda 7 yanlış alarm |
| `2017'de kuruldu` kalıbı desende yoktu | pamaistudio'nun 8 hatası "temiz" göründü |
| Türkçe/İngilizce kelime sırası tek yönlü tarandı | İki dilli sitenin yarısı atlandı |
| `llms-full.txt`'te başka şirketlerin kuruluş yılı PAM'ınki sanıldı | 5 yanlış alarm |

Beşincisi bu devir notunu yazarken çıktı: `pamaistudio` kaydına
`foundation_year: 2018` eklemek, "hiçbir site pilotun yılını miras almasın"
testini kırdı. Test haklı bir endişeyi koruyordu; kural gevşetilmedi, pamaistudio
adıyla ve gerekçesiyle istisna olarak yazıldı. Onaylanmış bir gerçek ile kolaya
kaçmış bir kopya arasındaki fark, testin okunabilir olmasıyla korunuyor.

Ayrıca:

- **`pamlab` bölümü tanınmadı** → pamistanbul "içerik hattı yok" diye raporlandı,
  oysa 175 makale vardı. Yanlış negatif yanlış pozitiften tehlikelidir: suçlanan
  siteye itiraz edilir, "hattın yok" denen siteye inanılır. Çözüm: registry'de
  `content_sections` alanı.
- **Baseline kararı ilk seferde yanlış verildi.** "Guard'ı susturma, senin kararın"
  denip CI kırmızı bırakıldı; oysa depo bu durum için belgelenmiş bir istisna
  mekanizması sunuyordu (`claim-baseline-exceptions.json`). Gerçek bypass belgesiz
  `baseline:write`; gerekçeli kayıt değil.

**Genel ders:** bir bulguyu raporlamadan önce deponun kendi koduna bak. 2017/2018
çelişkisi canlı taramada görünmüyordu; `scripts/fixes/` altındaki tarihli talimatta
duruyordu.

---

## 9. Ortam notları

- Bu sandbox `pamistanbul.com`, `ahrefs.com`, `developers.google.com` ve Vercel
  preview adreslerine **erişemiyor** (egress proxy). Canlı ölçüm GitHub Actions
  runner'ından yapılıyor. Önizlemeye kendin bakmalısın.
- İki makine var; tek doğru kaynak GitHub. Çalışmaya başlamadan `git pull`.
- Yerel klonlar: `/home/user/` altında pamistanbul-site, pamaistudio, spryhand,
  decideplan, rightlisted, untitledportraits, myhappymade.
- Açık branch'ler: `claude/focused-dirac-3v8kyz` (pamistanbul-site, pamaistudio),
  `claude/llms-index-3v8kyz` (pamistanbul-site).

---

## 10. Okuma sırası

1. Bu dosya
2. `reports/2026-09-20-portfolio-cadence-baseline.md` — içerik ritmi ölçümü
3. `reports/2026-09-20-llmstxt-portfolio-inventory.md` — llms.txt envanteri ve kararı
4. `policies/references/llms-txt.md` — kaynaklar, tarihli
5. `docs/checking-your-sites.md` — "siteleri kontrol et" ne yapıyor
6. `docs/architecture.md` — sistemin katmanları
