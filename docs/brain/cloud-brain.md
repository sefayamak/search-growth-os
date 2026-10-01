# Cloud Brain — GitHub Actions üzerinde gerçek ajan orkestrasyonu

Durum: Phase 2B (temel). **Henüz canlı koşulmadı**; kod sahte (enjekte) Anthropic istemcisiyle test edildi.

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

`max_specialists=3`, `max_calls=5`, çağrı başına çıktı token tavanı (uzman 2000 / Chief 3000 / uyum 1500), kanıt boyutu tavanı (`MAX_EVIDENCE_BYTES_PER_RUN=60000` bayt, kayıt başına 8000).
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

## Workflow ve kanıt devri (Phase 2B.1)

`.github/workflows/brain.yml` artık **kanıt devri** workflow'udur ve **Anthropic'e hiç gitmez** (anahtar, model değişkeni ve `brain-run` adımı yoktur;
canlı Brain koşusu devrin doğrulanmasından sonra ayrı bir dilimde, açık onayla eklenir). Yalnız `workflow_dispatch`; inputlar `site` ve **zorunlu**
`clarity_run_id`. İzinler `contents: read` + `actions: read` (bu reponun run/artifact'ini OKUMAK için; yazma izni yok). Schedule, commit, PR, Vercel, bellek yazımı yok.

Akış (`Clarity artifact → güvenli devir → sgos.brain.evidence.v1 → brain-validate`):

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

Canlı Anthropic çağrısı (workflow'da `brain-run` adımı), kalıcı bulut belleği, schedule, GSC/GA4/index/crawl için artifact devri (yalnız Clarity var), PR açma. Model çıktı kalitesi
**canlıda doğrulanmadı**: sayı kuralı (özette yalnız kanıtta geçen sayılar) muhafazakârdır ve gerçek modelde fazla sert çıkabilir; ilk canlı pilot bunu ölçecek.
