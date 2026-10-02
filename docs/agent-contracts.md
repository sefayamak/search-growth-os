# Ajan sözleşmeleri: iç link ve schema/entity

Kod: `src/agent-contracts.ts` · Şemalar: `schemas/agent-internal-link.schema.json`,
`schemas/agent-schema-entity.schema.json` · Test: `tests/agent-contracts.test.ts`

Bu sözleşmeler bir ajanın **ne önerebileceğini** tanımlar; **ne uygulayabileceğini** değil.
`mutation: "none"` literal'dir: başka değer `INVALID`. Modülde dosya/ağ/git işlemi yoktur.
Uygulama her zaman ayrı bir draft PR + insan merge'üdür (`policies/high-risk-changes.md`).

## Alanlar

| Alan | Kural |
|---|---|
| `site` | Registry'de kayıtlı ve onboard edilmiş olmalı (`registered_not_onboarded` -> `BLOCKED_NOT_ONBOARDED`) |
| `source_url`, `target_url_or_entity` | İç linkte ikisi de sitenin kendi host'unda mutlak URL. Schema'da hedef entity adı da olabilir |
| `reason` | Boş olamaz |
| `evidence` | `{refs[], label}`; refs en az 1; label öneriye uyan dört etiketten biri (FACT/INFERENCE/HYPOTHESIS/RECOMMENDATION). IMPLEMENTED_CHANGE ve VERIFIED_RESULT bir öneride geçersiz |
| `confidence` | CONFIRMED/CANDIDATE/FALSE_POSITIVE/UNKNOWN. FACT olmayan kanıt CONFIRMED olamaz; FALSE_POSITIVE yalnız REJECTED ile |
| `risk` | low/medium/high. Organization/Person/LocalBusiness önerisi en az medium |
| `expected_change` | `{hypothesis, test}`; testsiz hipotez yok; hipotezde yüzde/"3x" gibi sayısal kazanç iddiası `REJECTED_FABRICATED` |
| `approval_state` | PROPOSED / REVIEW_REQUIRED / OWNER_APPROVED / REJECTED. **Varsayılanı yok.** OWNER_APPROVED `approver` ister; ajan adları (claude, agent, bot, gpt...) kabul edilmez; diğer durumlarda `approver` yazılamaz |
| `mutation` | Yalnız `"none"` |

Bilinmeyen alan reddedilir (`apply`, `patch`, `deploy` gibi bir alanın sözleşmeye sızmaması için).

## Karar (verdict) ve öncelik

`BLOCKED_CROSS_SITE` > `BLOCKED_NOT_ONBOARDED` > `REJECTED_FABRICATED` > `INVALID`; hepsi yoksa `ACCEPTED`.
Tüm sorunlar `issues` içinde kalır; öncelik yalnız başlık kararını seçer. Engellenen öneri `value` döndürmez.

## Portföy izolasyonu (BLOCKED_CROSS_SITE)

Host sahipliği **tam eşitlik**: apex, `www.`, `canonical_hostname`, `known_subdomains`. `endsWith` yok, çünkü
`evilpamistanbul.com` gibi benzer host'lar içeri girerdi. `https://pamistanbul.com@pamaistudio.com` gibi userinfo
hilesi URL ayrıştırıcısıyla çözülür. Engellenenler:

- `source_url` / hedef URL başka kayıtlı sitede **ya da** hiçbir registry domain'inde değil (örnek: pamistanbul.com -> pamaistudio.com).
- `evidence.refs` içinde başka sitenin URL'si (başka sitenin verisi gerekçe yapılamaz).
- Schema taslağında `sameAs`, `url`, `@id`, `mainEntityOfPage` başka kayıtlı sitenin domain'ine işaret ediyorsa.
- Olgu kaynağı (`fact_sources`) başka sitenin sayfasıysa.

## Uydurma olgu (REJECTED_FABRICATED)

`aggregateRating, review, reviews, rating, foundingDate, award, numberOfEmployees` taslakta varsa (`@graph` ve iç içe dahil)
aynı `property` için `fact_sources` gerekir: `label: FACT` ve **sitenin kendi sayfasında** görünür bir URL.
Registry'de sayısal `foundation_year` varsa `foundingDate` onunla çelişemez (registry doğruluk kaynağıdır).
`sameAs` profili, registry `social_identity_urls` içinde değilse ya da kaynaksızsa uydurma sayılır.

## Schema tipleri ve taslak

Allow-list: `SCHEMA_TYPE_ALLOWLIST` (üst düzey) + `NESTED_ONLY_TYPES` (yalnız iç içe). Product/Offer yok.
`jsonld_draft` çıplak JSON-LD (nesne ya da JSON string); `<script>` sarmalı `INVALID`. Taslak yalnız **saklanır**.

## Kuyruk

`renderReviewQueue(items)` site başına gruplu markdown üretir; engellenenler "Uygulanamaz" altında nedenleriyle
görünür (sessizce düşmez). `summarize(items)` karar sayımı verir. Bölümler arası veri sızmaz.

## Bağlanması gereken (bu PR kapsamı dışı)

- `cli.ts` komutu (ör. `agent-contracts-check <dosya>`): JSON girdiyi okuyup kuyruğu yazar.
- Brain ajanlarının (`internal-linking`, `entity-structured-data-specialist`) çıktısını bu sözleşmeye eşleyen adaptör.
- JSON Schema doğrulaması çalışma anında yok (bağımlılıksız); şemalar dış araçlar içindir, asıl zorlayıcı TS doğrulayıcıdır.

## Sınırlar

- Sayfa içeriği çekilmez: bir olgunun sayfada gerçekten görünüp görünmediği **doğrulanmaz**, yalnız FACT kaynağı beyanı aranır.
- Sayısal-iddia regex'i yüzde ve "Nx/kat/times" yakalar; sözcükle yazılmış iddiayı ("iki katına çıkar") yakalamaz.
- Ajan-adı denetimi kaba bir korumadır; gerçek onay GitHub PR merge'üdür.
