# Cloud Brain — GitHub Actions üzerinde gerçek ajan orkestrasyonu

Durum: Phase 2C (canlı çalışma zamanı bağlandı). Kanıt devri (Clarity artifact → evidence → routing) **canlı doğrulandı** (Brain run 36840181816, Anthropic çağrısı 0).
**Phase 2C henüz canlı Anthropic ile doğrulanmadı**: `brain-run` adımı kodda ve testlerde (sahte Anthropic sunucusu) var, gerçek bir API çağrısıyla hiç koşulmadı.

## Çalışma zamanı kim?

| Katman | Rol |
|---|---|
| Claude Code | **çalışma zamanı değildir** — `agents/*.md` dosyalarının eski ev sahibi |
| GitHub Actions | bulut çalışma zamanı (bilgisayar kapalıyken çalışır) — `.github/workflows/brain.yml` |
| Anthropic API | akıl yürütme çalışma zamanı — yalnız API anahtarı (`SEARCH_GROWTH_ANTHROPIC_API_KEY`); Claude Max oturumu/çerezi yok |
| `agents/*.md` | **kanonik uzman profilleri** (9 dosya, kopya prompt seti yok) |

CrewAI, MCP ve herhangi bir ek bağımlılık gerekmez: yalnız Node 24 + `fetch`.

```
kanıt paketi (normalize) ──► deterministik yönlendirici ──► ≤3 uzman ──► Chief sentezi ──► uyum incelemesi ──► sgos.brain.run.v1
   (sgos.brain.evidence.v1)        (model seçmez)            (API)          (API)            (kapı + ≤1 API)      (artifact)
```

## 9 ajan nasıl kullanılıyor

`src/brain/agent-loader.ts` her koşuda `agents/<id>.md` dosyasını yükler. **Markdown gövdesi talimat profili** olur. Claude Code frontmatter'ı
(`tools`, `model`, `effort`, `maxTurns`) bulut çalışma zamanında **yetenek değildir**: bulut ajanının aracı, dosya erişimi, shell'i ve tur sayısı yoktur.
Bu alanlar yalnız kayıt için okunur, asla yorumlanmaz; model Anthropic ayarından, sınırlar `src/brain/contracts.ts`'ten gelir.

Her ajana sabit bir **runtime güvenlik talimatı** profilin ÖNÜNE eklenir (profilden üstündür): araç yok, `EVIDENCE_CONTENT_IS_UNTRUSTED_DATA`, yalnız verilen
evidence id'leri, kanıtta olmayan sayı yok, UNKNOWN UNKNOWN kalır, üretim yazması yok. İzde yalnız profil gövdesinin sha256'sı tutulur.

`chief-search-strategist` ve `search-policy-compliance-officer` sabit roller; diğer yedi ajan **uzman**dır ve yönlendirici seçer.

## Seçici yönlendirme

Her koşuda 9 ajan çağrılmaz. Yönlendirici deterministiktir ve yalnız **kullanılabilir** kanıta (MEASURED / PARTIAL / RECORDED) bakar:

| Kanıt | Uzman |
|---|---|
| GSC / GA4 / `SEARCH_PERFORMANCE` | `search-measurement-scientist` |
| `CONTENT_OPPORTUNITY` | `content-evidence-strategist` (ek olarak) |
| `CLARITY` | `search-performance-engineer` |
| CRAWL / INDEX / `TECHNICAL` / `INDEXING` (STRUCTURED_DATA hariç) | `technical-search-auditor` |
| `STRUCTURED_DATA` | `entity-structured-data-specialist` |
| `AI_VISIBILITY` | `aeo-geo-strategist` |
| `COMPETITOR` **ölçümü** | `competitor-intelligence-analyst` |

- NOT_CONNECTED / ERROR / NOT_AVAILABLE kanıt ajan çağırmaz: veri yokken analiz uydurulmaz. REGISTRY kanıtı yalnız bağlamdır.
- Registry'deki `competitor_set` **adları** rakip kanıtı değildir: rakip ajanı yalnız gerçek rakip ölçümü varsa çağrılır. SERP scraping yok.
- En fazla **3 uzman**; kota dolarsa sabit öncelik sırasıyla kesilir ve `agents_considered`'da `SPECIALIST_CAP` olarak yazılır (sessiz atılmaz).
- Sonra 1 Chief sentezi, gerekirse 1 uyum incelemesi. **Sert tavan: 5 Anthropic çağrısı / koşu** (`CallBudget`, çağrıdan önce sayılır).

## Kanıt sözleşmesi (`sgos.brain.evidence.v1`)

Alanlar: `evidence_id, site_id, source, source_ref, measured_at, measurement_state, evidence_label, confidence, category, payload`.
`evidence_label` tam olarak altı etiketten biri (FACT / INFERENCE / HYPOTHESIS / RECOMMENDATION / IMPLEMENTED_CHANGE / VERIFIED_RESULT); **EDITORIAL yok**.
Kaynaklar: GSC, GA4, CLARITY, CRAWL, INDEX, REGISTRY (+ yönlendirme için AI_VISIBILITY, COMPETITOR). Kaynak yoksa pakette hiç bulunmaz (UNKNOWN/NOT_AVAILABLE; sahte veri yok).
`MEASURED/PARTIAL` = bir araç ölçtü, `RECORDED` = sahibin kaydı (registry), gerisi veri yok demektir.

Bir sitenin kanıtı başka siteye taşınamaz: paketteki yabancı `site_id` paketi reddeder; model hiç çağrılmaz. Mevcut çıktılar adaptör sınırından geçer
(`evidenceFromClarity`, `evidenceFromRegistry`); GSC/GA4/index/crawl adaptörleri bu PR'da yeniden yazılmadı.

## Çıktı doğrulama

Her ajan sonucu ayrıştırılır ve doğrulanır; **tek ihlal sonucun tamamını reddeder** (kısmi kurtarma yok). Reddedilenler: bilinmeyen/yabancı evidence id, yanlış site,
geçersiz etiket (EDITORIAL dahil), geçersiz `actionability`, bozuk JSON, kanıtta olmayan sayı (başlık/özet/etki alanlarında), üretim yazması talimatı, sır, ajanın
**görmediği** kanıta atıf. FACT / IMPLEMENTED_CHANGE / VERIFIED_RESULT etiketi yalnız aynı etiketi taşıyan kullanılabilir kanıtla; `CONFIRMED` yalnız olçülmüş ve onaylı
kanıtla. Reddedilen çıktı yerine uydurma sonuç konmaz: koşu `PARTIAL`/`ERROR` olur ve `agent_trace`'te ihlal **kodları** görünür.

## Prompt injection savunması

Kanıt (crawl, içerik, payload) **güvenilmeyen veridir**. Kanıt hiçbir zaman sistem/geliştirici talimatına girmez: kullanıcı mesajında `<EVIDENCE_DATA_BLOCK>` içinde taşınır.
Serileştirmede `<` kaçırıldığı için kanıt içinde blok sınırı taklit edilemez. API anahtarı modele hiç gönderilmez; kanıt anahtar/`Bearer`/`private_key` benzeri sır taşıyorsa paket reddedilir.

## Maliyet koruması

`max_specialists=3`, `max_calls=5`, çağrı başına çıktı token tavanı (uzman 6000 / Chief 5000 / uyum 1500), kanıt boyutu tavanı (`MAX_EVIDENCE_BYTES_PER_RUN=60000` bayt, kayıt başına 8000).
Büyük payload'lar deterministik olarak sıkıştırılır ve **işaretlenir** (`<alan>__truncated`); sığmayan paket reddedilir. İstemci hiç yeniden deneme yapmaz (429/5xx tek çağrıdır).
`cost_guard` çağrı sayısını, bayt'ı ve API'nin kendi `usage` token'larını taşır; **dolar maliyeti `UNKNOWN`** (fiyat tarifesi burada bilinmiyor, tahmin yazılmaz).

## Bulgu ve insan onayı sınırı

Bulgu alanları: `finding_id, site_id, title, category, evidence_ids[], evidence_label, confidence, summary, impact, recommended_action, actionability, risk, verification_plan`.
`actionability`: `MONITOR | HUMAN_REVIEW | DRAFT_PR_CANDIDATE`. **`DRAFT_PR_CANDIDATE` bu fazda yalnız etikettir**: PR açılmaz, hiçbir yere yazılmaz (`production_write` her zaman `false`).
Değişiklik öneren bulgu önce deterministik uyum kapısından (`src/compliance.ts`), sonra gerekirse `search-policy-compliance-officer`'den geçer. `execution_candidate` yalnız
`DRAFT_PR_CANDIDATE` + açık `PASS` ile true olur; REJECT / FLAG / incelenmemiş aday değildir. Her değişiklik yine PR → CI → insan merge zincirinden geçer.

## Bellek temeli

`sgos.brain.memory.v1`: `memory_id, site_id, created_at, finding_id, action, expected_signal, observed_result, status, evidence_ids`;
durumlar `OPEN | WAITING_FOR_RESULT | VERIFIED_POSITIVE | VERIFIED_NEGATIVE | INCONCLUSIVE | REJECTED`. `src/brain/memory.ts` okuma/ekleme kütüphanesidir ama
**varsayılan salt-okunurdur**: `brain-run` bellek **adaylarını** artifact klasörüne (`memory-candidates-<site>.jsonl`) yazar; kalıcı yazım yalnız açık `--write-memory`
ile `brain/memory/<site>.jsonl`'e gider (workflow geçmez, `contents: read`). Bir sitenin belleği yalnız kendi dosyasına gider. Kalıcı bulut belleği sonraki güvenli dilimde açılacak.

## Komutlar

```bash
node --experimental-strip-types src/cli.ts brain-evidence config/sites.yaml --site pamistanbul --clarity clarity-out/clarity-pamistanbul.json --out ev.json   # yerel, ağ yok
node --experimental-strip-types src/cli.ts brain-validate config/sites.yaml --site pamistanbul --evidence ev.json   # OFFLINE: profiller + paket + yönlendirme planı
SEARCH_GROWTH_ANTHROPIC_API_KEY=... SEARCH_GROWTH_ANTHROPIC_MODEL=... \
node --experimental-strip-types src/cli.ts brain-run config/sites.yaml --site pamistanbul --evidence ev.json --out brain-out
```

Anahtar CLI argümanı olarak kabul edilmez. `NOT_CONFIGURED` çıkış kodu 0 (kimlik yok ≠ hata); `ERROR`/`PARTIAL` 1.

## Canlı mimari (Phase 2C) — workflow

```
Clarity workflow → Clarity artifact → Brain workflow → handoff → evidence normalization → brain-validate (offline)
   → deterministik router → uzman → Chief → (gerekirse) uyum → doğrulanmış Brain artifact
```

`.github/workflows/brain.yml`: yalnız `workflow_dispatch`; inputlar **yalnız** `site` ve zorunlu `clarity_run_id` (manuel `evidence_path` yok; anahtar/model input olamaz).
İzinler `contents: read` + `actions: read` (bu reponun run/artifact'ini OKUMAK için; yazma yok). Schedule, commit, PR, deploy, bellek yazımı (`--write-memory` geçilmez) yok.
Adımlar `set -e` semantiğiyle sıralıdır; **önceki adım kırmızı biterse sonrakiler çalışmaz**:

1. `brain-handoff` (yerel; açık run id, ağ/API yok) → 2. `brain-validate` (offline) → 3. **`brain-run`** (Anthropic API).

`brain-run` adımının env'inde — yalnız orada — `SEARCH_GROWTH_ANTHROPIC_API_KEY` (**`secrets`** bağlamı) ve `SEARCH_GROWTH_ANTHROPIC_MODEL` (**`vars`** bağlamı) bulunur. Model koda gömülü değildir; anahtar/model
CLI argümanı olamaz (`--api-key`, `--model` reddedilir ve yankılanmaz), artifact'e, log'a ve istemlere girmez (anahtar yalnız `x-api-key` başlığında).
Anahtar ya da model yoksa `brain-run` **hiç HTTP çağrısı yapmaz**, `status=NOT_CONFIGURED` yazar, iş yeşil kalır ve artifact yine üretilir (canlı pilotta bunu ayrıca kontrol edin).
Handoff `FAILED` / `NOT_AVAILABLE`, kanıt doğrulama hatası, yabancı site ya da kullanılamaz kanıt (`ERROR`/`NOT_CONNECTED`) → **0 Anthropic çağrısı**.

**Çağrı bütçesi:** en fazla 3 uzman + 1 Chief + 1 uyum = **5 HTTP çağrısı** (`CallBudget`, istek başlamadan önce tüketilir); 429 ve 5xx dahil **hiçbir yeniden deneme yok**.
İlk pilot (REGISTRY + CLARITY) için router yalnız `search-performance-engineer`'i seçer; Chief onun geçerli sonucundan sentez yapar. Uyum incelemesi yalnız **MONITOR dışı** (değişiklik öneren)
bir bulgu varsa çalışır, bu yüzden çağrı sayısı 2 ya da 3 olur — sabit değildir, orkestratör karar verir.

**Artifact'ler** (`brain-evidence-<github_run_id>` ve `brain-run-<github_run_id>`, 7 gün; repoya commit edilmez):
`brain-run-<site>.json` (`sgos.brain.run.v1`), `brain-report-<site>.md`, `agent-trace-<site>.json`, `cost-guard-<site>.json`, `memory-candidates-<site>.jsonl` (yalnız aday; kalıcı değil).
**Artifact'e asla girmeyenler:** API anahtarı, `Authorization`, model adı, tam sistem/kullanıcı istemi, ham (doğrulanmamış) model tamamlaması, yanıt gövdesi. İz yalnız
`agent_id, role, zamanlar, status, input_evidence_ids, output_finding_ids, error_code, ihlal kodları, http_status, token sayıları, profile_sha256` taşır.
`cost_guard`: `max_calls, calls_used, specialists_called, evidence_bytes, output_token_caps` ve API'nin kendi `usage` alanından `input/output_tokens_measured`; **dolar maliyeti `UNKNOWN`** (fiyat tablosu yok).
Artifact yazılmadan önce `brain-run` kendi çıktısını `validateBrainRun` ile sözleşmeye karşı doğrular (yabancı site, kanıt dışı id, EDITORIAL, izde bilinmeyen alan, sır, bütçe aşımı, `production_write`);
ihlalde model kaynaklı metin (bulgu/sonuç/bilinmeyen) artifact'e **yazılmaz** (`RUN_CONTRACT_VIOLATION`, status `ERROR`).

Geçersiz model çıktısı: uzman çıktısı reddedilirse uydurma fallback bulgu üretilmez (`PARTIAL`/`ERROR`, geçerli uzman yoksa Chief çağrılmaz); Chief reddedilirse `PARTIAL` (SUCCESS değil).

### Kanıt devri (Phase 2B.1, canlı doğrulandı)

Devir adımları (`Clarity artifact → güvenli devir → sgos.brain.evidence.v1 → brain-validate`):

1. `gh api repos/<repo>/actions/runs/<id>` + artifact listesi + `gh run download --name clarity-<id>` (yalnız bu repo, **açık run id**; "en son" seçimi yok).
2. `brain-handoff` (yerel dosyalar, ağ/API yok) `src/brain/handoff.ts` ile doğrular:
   - run: bu reponun `clarity.yml`'i, `main` üzerinde, `workflow_dispatch`, `completed/success`; id eşleşir; `repository` ve `head_repository` bu repo;
   - artifact: adı tam `clarity-<run_id>`, tek, süresi dolmamış, aynı run'a (id + `head_sha`) ait;
   - dosya: **yalnız** `clarity-out/clarity-<site>.json` açılır (aynı artifact başka siteleri de taşıyabilir; onlar açılmaz); sembolik bağlantı/2 MB üstü reddedilir;
   - içerik: sır benzeri veri → FAIL; `site_id` seçilen siteyle aynı değilse **FOREIGN_SITE_ARTIFACT**; `sgos.clarity.v1` sözleşmesi doğrulanır
     (ölçülememiş sonuç sayı taşıyorsa sözleşme ihlali).
3. `evidence.json` (REGISTRY + CLARITY, additive `provenance` ile) yalnız `handoff-out/` altına yazılır ve **7 günlük artifact** olur (`brain-evidence-<run_id>`); repoya commit edilmez
   (`handoff-out/`, `handoff-work/` `.gitignore`'da). 4. `brain-validate` yönlendirme planını yazar.

**Hata semantiği** (çıkış kodu 1, `handoff-status.json` her zaman yazılır; kod, içerik/sır taşımaz):
`NOT_AVAILABLE` = run/artifact/dosya yok ya da süresi dolmuş (`RUN_NOT_AVAILABLE`, `ARTIFACT_NOT_AVAILABLE`, `ARTIFACT_EXPIRED`, `CLARITY_FILE_NOT_AVAILABLE`, …) — sahte veri yok.
`FAILED` = belirsiz/yabancı/bozuk (`FOREIGN_SITE_ARTIFACT`, `RUN_NOT_CLARITY_WORKFLOW`, `RUN_NOT_MAIN`, `RUN_FOREIGN_REPOSITORY`, `ARTIFACT_RUN_MISMATCH`, `ARTIFACT_AMBIGUOUS`,
`CLARITY_JSON_INVALID`, `CLARITY_CONTRACT_INVALID`, `CLARITY_SECRET_DETECTED`, `EVIDENCE_REJECTED`, …).
Clarity ölçümü `ERROR`/`NOT_CONNECTED` ise devir **OK ama kullanılamaz**: pakette sayı yoktur, serbest metin notu düşülür, `brain-validate` hiçbir uzmanı çağırmaz ve CLI açıkça `KANIT KULLANILAMAZ` yazar.

**Provenance** (zarfta additive, isteğe bağlı `provenance`; mevcut sözleşme kırılmadı): `handoff, source_workflow, source_run_id, source_run_attempt, source_head_sha,
source_artifact_name, source_artifact_id, source_artifact_digest, source_measured_at, handoff_run_id`. Yalnız katı kalıpla doğrulanmış kimlik/zaman; GitHub'dan gelen serbest metin
(başlık, commit mesajı, not) **hiçbir yere kopyalanmaz** ve talimat olarak yorumlanmaz. Artifact içeriği (satırlar) yine güvenilmeyen veridir ve modele yalnız DATA bloğunda gider.

Yerel kullanım: `brain-handoff config/sites.yaml --site pamistanbul --run-id <id> --repo <owner/repo> --artifact-dir … --run-meta … --artifacts-meta … --out handoff-out`.

## Henüz YOK (bilinçli)

- **Gerçek Anthropic API ile doğrulanmış koşu.** Phase 2C `brain-run` adımı kodda ve sahte Anthropic sunucusuyla (gerçek CLI → gerçek istemci → sahte `fetch`) test edildi; canlı pilot ayrıca,
  secret/variable tanımlandıktan ve açık onaydan sonra yapılacak. Bu yüzden canlıda doğrulanmayanlar: modelin JSON sözleşmesine uyumu, `usage` alanı, gerçek gecikme ve çağrı sayısı (beklenen 2–3).
- Kalıcı bulut belleği, schedule, GSC/GA4/index/crawl için artifact devri (yalnız Clarity var), PR açma.
- Model çıktı kalitesi: sayı kuralı (başlık/özet/etkide yalnız kanıtta geçen sayılar) muhafazakârdır ve gerçek modelde fazla sert çıkabilir; ilk canlı pilot bunu ölçecek.

## Phase 2C.1 — model çıktısı kesilmesi (canlı pilotun bulgusu)

İlk canlı pilot (run 36845827563, pamistanbul) `search-performance-engineer` çağrısında HTTP 200 + `output_tokens=2000` (= o günkü uzman tavanı) döndü; sonuç `MALFORMED_JSON` → `NO_VALID_SPECIALIST_OUTPUT` oldu. İstemci `stop_reason`'ı okumadığı için kesilme izde görünmüyordu.

- İstemci `stop_reason`'ı okur ve normalize eder (`end_turn|max_tokens|stop_sequence|tool_use|pause_turn|refusal`, aksi `UNKNOWN`); ham yanıt saklanmaz. İz alanı: `stop_reason` (yanıt alınmadıysa `null`).
- `stop_reason=max_tokens` ise HTTP 200 olsa bile çıktı kabul edilmez: `status=INVALID_OUTPUT`, `error_code=MODEL_OUTPUT_TRUNCATED`, `violations` içinde `MODEL_OUTPUT_TRUNCATED` (parse de başarısızsa ikincil `MALFORMED_JSON`). Parse edilebilir yarım JSON da bulguya dönüşmez. Chief/uyum çağrılmaz, yeniden deneme yok.
- Uzman çıktı tavanı 2000 → 4000 (Phase 2C.2 ile 6000). Chief 3000, uyum 1500, `max_calls=5`, `max_specialists=3` aynı. `estimated_cost_usd` `UNKNOWN`.
- Bu düzeltme canlı Anthropic ile henüz doğrulanmadı.

## Phase 2C.2 — uzman çıktısını sınırlama (more tokens + bounded output)

Canlı pilotlar (ikisi de `pamistanbul`, Clarity run 36835627390, 2 kayıt / 8933 bayt, tek uzman `search-performance-engineer`):

| Pilot | Run | Uzman tavanı | Gözlem | Sonuç |
|---|---|---|---|---|
| 1 | 36845827563 | 2000 | `output_tokens=2000`, `http_status=200`; `stop_reason` o zaman izlenmiyordu | `MALFORMED_JSON` → `NO_VALID_SPECIALIST_OUTPUT`; kesilme sonradan çıkarıldı |
| 2 | 36847868355 | 4000 | `output_tokens=4000`, `stop_reason=max_tokens` | `MODEL_OUTPUT_TRUNCATED` + `MALFORMED_JSON`; truncation **kesin doğrulandı** |

Amaç: **daha fazla token + sınırlı çıktı**. Yalnız tavanı artırmak yetmez; çıktı hem kısa istenir hem doğrulayıcıda sınırlanır.

- Uzman tavanı 4000 → **6000**. Chief 3000, uyum 1500, `max_calls=5`, `max_specialists=3` aynı.
- Uzman sonucu en fazla `MAX_FINDINGS_PER_SPECIALIST = 5` bulgu. Alan sınırları (karakter): title 120, category 60, summary 500, impact 300, recommended_action 300, verification_plan 300, risk 120. `unknowns` en fazla 5 (her biri ≤ 200), `conflicts` en fazla 5 (açıklama ≤ 300).
- Sınırı aşan çıktı `INVALID_OUTPUT` olur (`TOO_MANY_FINDINGS`, `FIELD_TOO_LONG`, `BAD_UNKNOWNS`, `BAD_CONFLICTS`). **Sessiz kesme yok**: ilk 5 bulgu "kurtarılmaz".
- Limitler yalnız uzmana uygulanır (`ValidationContext.role = "specialist"`); Chief doğrulaması ve istemi değişmedi.
- Uzman istemine `OUTPUT SIZE LIMITS` bloğu eklendi: yalnız JSON, en fazla 5 bulgu, kısa alanlar, kanıtı tekrar etme, metodoloji/akıl yürütme/chain-of-thought yok, yalnız karar için gerekli sayılar. Kanıt `EVIDENCE_DATA_BLOCK` içinde kalır; prompt-injection koruması aynı.
- `stop_reason=max_tokens` → `MODEL_OUTPUT_TRUNCATED` davranışı aynen korunur; retry yok, Chief çağrılmaz.
- Bu düzeltme canlı Anthropic ile henüz doğrulanmadı.

## Phase 2C.3 — site_id sözleşmesi (canlı pilot 3)

Pilot 3 (run 36849150571, 6000 token tavanı): `stop_reason=end_turn`, `output_tokens=2520`; truncation, `TOO_MANY_FINDINGS` ve `FIELD_TOO_LONG` yok. Uzman çıktısı yalnız **`WRONG_SITE`** ile reddedildi → `NO_VALID_SPECIALIST_OUTPUT`. Phase 2C.2 truncation sorununu çözmüş görünüyor.

- Doğrulayıcı `site_id`'yi tam eşitlikle kontrol eder (`raw.site_id !== ctx.siteId`; bulgu düzeyinde eksik/string değilse `WRONG_SITE`, farklı string ise `FOREIGN_SITE_FINDING`). Beklenen değer `runBrain`'in `siteId`'sidir (kanonik iç kimlik, ör. `pamistanbul`).
- Kök neden (koddan): çıktı sözleşmesi `"site_id": "<the site id>"` yer tutucusu taşıyordu; gerçek değer yalnız `SITE_ID:` başlığında vardı. Kanıt kayıtları ise alan adı (`pamistanbul.com`) taşır. Modelin tam olarak hangi değeri döndürdüğü artifact'te tutulmaz (ham tamamlama yok), bu yüzden bu kod düzeyinde bir gerekçedir, ölçülmüş bir gözlem değil.
- Düzeltme: sözleşme ve yeni `SITE ID CONTRACT` bloğu (tüm roller) kimliği çalışma zamanından **aynen** verir: `site_id = "<id>"`; hostname/URL/görünen ad döndürülmez, değer kanıttan türetilmez. Kimlik her çağrıda `runtimeSystemPrompt(..., siteId)` ile gelir; siteye özel sabit yok.
- Doğrulayıcı gevşetilmedi: takma ad, normalizasyon, bulanık eşleştirme yok. `pamistanbul.com` ≠ `pamistanbul`.
- Bu düzeltme canlı Anthropic ile henüz doğrulanmadı.

## Phase 2C.4 — doğrulama tanısı (`violation_details`)

Pilot 4 (run 36850293981): `stop_reason=end_turn`, `output_tokens=2227`; uzman çıktısı `UNSUPPORTED_NUMBER` + `WRONG_SITE` ile reddedildi. Artifact'te yalnız kod listesi vardı: hangi yol, hangi değer, ne beklenmişti belli değildi.

- İz'e **additive** alan: `violation_details` (eski `violations: string[]` aynen korunur). Her kayıt: `code`, `path` (≤160), `expected`/`observed` (≤120, kontrol karakteri yok, sır içeriyorsa `[REDACTED_SECRET]`), `evidence_ids_checked` (≤10), `reason` (kısa kod), `corpus_size`. En fazla 10 kayıt. Ham tamamlama, istem, uzun serbest metin yok.
- `WRONG_SITE`: üst düzey `$.site_id` ile bulgu düzeyi `$.findings[i].site_id` ayrı yollarla görünür; eksik/string olmayan değer `<missing>` / `<number>` gibi yer tutucu olur. `UNSUPPORTED_NUMBER`: reddedilen her sayı için yol + sayı + bakılan kanıt kimlikleri.
- **Doğrulayıcı anlamı değişmedi:** tam eşitlik, alias/normalizasyon yok, aynı ret kümesi. Yalnız ayrıntı üretilir.
- GitHub Actions `Ozet` adımı artık `brain-trace-summary` ile güvenli iz özetini (agent_id, status, error_code, violations, violation_details, stop_reason, token) hem loga hem step summary'ye yazar; artifact erişimi olmadan da tanı görünür.
- `quarantineRun`, sözleşme ihlalinde `violation_details`'i artifact'e yazmaz. `validateBrainRun`, sınır aşan/bozuk ayrıntıyı `BAD_VIOLATION_DETAILS` sayar.

### Sayı kuralı hakkında kod incelemesi (anlam değişmedi; gözlemler)
- Çıkarıcı `\d+(?:[.,]\d+)*`; **yalnız `title`, `summary`, `impact`** alanlarında çalışır. `recommended_action`, `verification_plan`, `risk` plan alanı sayılır, taranmaz.
- İzin listesi = atıf yapılan kanıt **zarfının tamamındaki** (`JSON.stringify`) her sayı simgesi: payload sayıları, `measured_at` parçaları (2026/10/01/09/00…), şema sürümü (`v1` → `1`), kanıt kimliğindeki rakam parçaları. Yani üst veri sayıları örtük olarak "destekli"dir; bu tasarlanmış bir izin listesi değil, zarfın yan etkisidir.
- Eşleşme tam simge eşitliğidir: `2` simgesi `2026` ile desteklenmez. Binlik ayırıcı (`58.071` ↔ `58071`) dışında ondalık biçim farkı (`12,5` ↔ `12.5`) eşleşmez.
- Kelime sınırı yok: `GA4` içindeki `4` sayı sayılır (kanıtta `4` yoksa reddedilir); `H1` yalnız kanıtta `1` geçtiği için geçer. Yüzde (`%58`) ve türetilmiş aritmetik (`3 + 4 = 7`), kanıtta aynı simge yoksa desteksizdir. Yazıyla yazılan sayılar (`iki`) çıkarılmaz.
- Gerçek pilot 4 kanıtında hangi sayının reddedildiği artifact okunana kadar bilinmiyor; bu gözlemler `evidenceFromRegistry` zarfı üzerinde deneyle doğrulandı, canlı kanıt üzerinde değil.

## Phase 2C.5 — bulgu düzeyi `site_id` zorunlu (canlı pilot 5)

Pilot 5 (run 36852517399; `Ozet` logundaki `violation_details` ile doğrulandı): üst düzey `$.site_id` doğruydu; model en az 4 bulgu döndürdü ve **hiçbirinde `site_id` yoktu** (`$.findings[0..3].site_id`, gözlenen `<missing>`). Truncation, `TOO_MANY_FINDINGS`, `FIELD_TOO_LONG`, `UNSUPPORTED_NUMBER` yok. Fail-closed doğrulayıcı çıktıyı doğru şekilde reddetti.

- Phase 2C.5 yalnız **çıktı sözleşmesini** sıkılaştırır; doğrulayıcı anlamı değişmedi: her bulguda `finding.site_id === siteId`, eksik alan tamamlanmaz, üst düzeyden kopyalanmaz, alias/normalizasyon yok.
- Uzman ve Chief istemlerinde (bulgu listesi üreten roller) yeni `FINDING REQUIRED FIELDS` bloğu: zorunlu alanlar tek listede (`site_id` ilk, `FINDING_REQUIRED_FIELDS`: `brain-agent-result.schema.json` ile aynı, test ile kilitli), "her bulgu `"site_id": "<id>"` içermek ZORUNDA, üst düzeyde de olsa", "kısalık için tekrarlanan zorunlu alanı atlama", kanıttan türetme / domain-marka yerine koyma yasağı. Bulgu şablonunda `site_id` ilk alan.
- Phase 2C.2 kısalık kuralları ("concise", "tekrar etme") artık açıkça yalnız serbest metin içindir; zorunlu şema alanlarına uygulanmaz.
- Bu düzeltme canlı Anthropic ile henüz doğrulanmadı.

## Phase 2C FINAL — Chief + uyum runtime stabilizasyonu ve kapanış

### Canlı pilot 6 (run 36860277917) — zincirin ilk gerçek ilerleyişi
| Ajan | status | stop_reason | in / out token | not |
|---|---|---|---|---|
| uzman (`search-performance-engineer`) | `OK` | `end_turn` | 6908 / 3499 | ihlal yok; bulgu düzeyi `site_id` dahil site sözleşmesi geçti |
| Chief | `INVALID_OUTPUT` / `MODEL_OUTPUT_TRUNCATED` | `max_tokens` | 9811 / 3000 | tavan 3000'de kesildi |
| uyum | çağrılmadı | — | — | Chief geçerli çıktı vermedi |

Sonuç `PARTIAL / CHIEF_OUTPUT_UNAVAILABLE`, 2/5 çağrı. Uzman dondurulmuştur (istem, 6000 tavanı, doğrulayıcı, bulgu/alan limitleri değişmedi).

### Chief nihai sözleşmesi
- Tavan 3000 → **5000**. En fazla **5** nihai bulgu; alan sınırları (karakter): title 120, category 60, summary 500, impact 300, recommended_action 300, verification_plan 300, risk 120; `unknowns` ≤ 3 (≤150), `conflicts` ≤ 2 (açıklama ≤200). Gerçek zorunlu alanların tümü (`FINDING_REQUIRED_FIELDS`), `site_id` tam kanonik id. Aşan çıktı `INVALID_OUTPUT`; sessiz kesme yok.
- Chief istemi: yalnız JSON, anlatı/yöntem/düşünce zinciri yok, örtüşen bulguları birleştir, kanıtı/uzman metnini tekrar etme, zorunlu alanlar kısalık için atlanamaz.
- unknowns/conflicts bilinçli dar: 5 bulgu alan tavanlarında + en fazla unknowns/conflicts çıktısı (en kötü durum) 5000 token tavanına **2.5 karakter/token** varsayımıyla sığar (testle kilitli). Karakter/token oranı **ölçülmedi** (artifact içeriği okunamadı); bu varsayım canlı pilotta doğrulanacak.

### Uyum sözleşmesi (henüz canlıda çağrılmadı) ve 1500 tavanı gerekçesi
- Uyum bulguları yeniden yazmaz: gönderilen **her** bulgu için tam bir `{finding_id, verdict, reason}`; en fazla 5 inceleme (= Chief bulgu tavanı); `reason` ≤ 300 karakter (eskiden 600).
- Doğrulayıcı sonucu şu durumlarda **bütünüyle** reddeder: eksik inceleme (`MISSING_REVIEW`), fazla inceleme (`TOO_MANY_REVIEWS`), yinelenen/bilinmeyen/yabancı `finding_id`, geçersiz karar, uzun gerekçe, yanlış site/ajan, sır, `max_tokens`, bozuk JSON. Reddedilen uyum sonucu bulguyu asla "uyumlu" yapmaz: `compliance=null`, `execution_candidate=false`, run `PARTIAL / COMPLIANCE_REVIEW_UNAVAILABLE`.
- **Tavan hesabı:** en kötü geçerli çıktı = 5 inceleme × (64 karakterlik id + `REJECT` + 300 karakterlik gerekçe) = **2186 karakter**. Karamsar 2 karakter/token ile **1093 token**, 3 karakter/token ile 729 token; tavan 1500 → yeterli, bu yüzden **artırılmadı** (keyfi artış yok). Eski `reason ≤ 600` sınırında en kötü durum 3686 karakter = 1843 token (karamsar oranda tavanı aşardı): sorun tavanda değil, sınırsız gerekçeydi; çözüm sınırdır. Test her iki rakamı kilitler.

### Girdi şişmesi incelemesi (ölçüm; kod değişmedi)
- Chief girdisi = sistem istemi (~7076 karakter) + `EVIDENCE_DATA_BLOCK` içinde `{evidence, specialist_results}`. Kanıt (8933 bayt) **bir kez**, uzman sonucu **bir kez** gönderilir; uzman bulguları kanıtı kimlikle (`evidence_ids`) atıf yapar, metni tekrarlamaz. Canlı 9811 token ≈ sistem + kanıt + uzman çıktısı (3499 token); fark uzman çıktısının kendisidir. Deterministik yinelenme **yok** → değiştirilmedi. Kanıtı Chief'ten çıkarmak sayı kuralı/etiket doğrulamasını ve kimlik izolasyonunu zayıflatırdı.
- Uyum girdisi = sistem istemi (~3848 karakter) + yalnız öneri alanları (`finding_id, title, category, recommended_action, risk, actionability`; en kötü ~4003 karakter). Kanıt gönderilmez, yinelenme yok → değiştirilmedi.

### Fail-closed matrisi (testle kilitli)
| Durum | Sonuç |
|---|---|
| tüm roller `stop_reason=max_tokens` | `MODEL_OUTPUT_TRUNCATED` → `INVALID_OUTPUT`, yeniden deneme yok; kesik veya ayrıştırılabilir yarım çıktıdan bulgu üretilmez |
| uzman OK → Chief geçersiz/kesik | `PARTIAL / CHIEF_OUTPUT_UNAVAILABLE`, uyum **çağrılmaz**, bulgu yok |
| uzman OK → Chief OK → uyum geçersiz/kesik | `PARTIAL / COMPLIANCE_REVIEW_UNAVAILABLE`, bulgular çalıştırılamaz (`execution_candidate=false`) |
| tam zincir OK | `SUCCESS`, aday yalnız `DRAFT_PR_CANDIDATE` + uyum `PASS` |
| her durumda | `production_write=false`, ≤5 çağrı, ≤3 uzman, ham tamamlama/istem/sır izde ve artifact'te yok |

Bu PR'dan sonra Phase 2C kapsamı: CI yeşil → merge → tek final canlı pilot → kapanış.
