# İçerik fırsatı + editör hattı (durum modeli)

Kod: `src/content-pipeline.ts` · Şema: `schemas/content-item.schema.json` (`sgos.content-item.v1`) ·
Test: `tests/content-pipeline.test.ts`.

Bu modül **yalnız doğrular**. Yazmaz, yayınlamaz, ağa çıkmaz. Sistemin "ölçer, insan merge eder"
kuralının (`CLAUDE.md`, `policies/change-management.md`) kayıt seviyesindeki karşılığıdır.

## Aşamalar

```
GSC_EVIDENCE → OPPORTUNITY → CLASSIFICATION → DRAFT → REVIEW → PR
      → HUMAN_APPROVAL → MERGE → DEPLOYMENT_VERIFICATION → LATER_MEASUREMENT
```

- Geçiş **yalnız ileri ve yalnız bir adım**: atlama (`SKIPPED_STAGE`) ve geri dönüş
  (`BACKWARD_OR_SAME_TRANSITION`) reddedilir. Reddedilen/yenilenen iş yeni bir kayıt olur.
- `classification = skip` olan kayıt `CLASSIFICATION` aşamasını geçemez.
- Hedef aşamanın ön koşulları `validateItem` ile aynı kurallardan gelir:

| Aşama ve sonrası | Ön koşul |
|---|---|
| `DRAFT` | `draft_ref` (dosya yolu) |
| `PR` | `pr.url`, `pr.draft = true` (PR her zaman draft) |
| `HUMAN_APPROVAL` | `approval.state = approved`, insan `approver`, `approved_at` |
| `MERGE` / `DEPLOYMENT_VERIFICATION` | onay (yukarıdaki, kaçınılmaz) |
| `DEPLOYMENT_VERIFICATION` | `pr.merged_at` |
| `LATER_MEASUREMENT` | `pr.deployed_at` |

Onay `HUMAN_APPROVAL` öncesinde verilemez (`APPROVED_BEFORE_APPROVAL_STAGE`): onay alanı,
geçişten önce insan tarafından doldurulur ve geçiş onu doğrular.

## Kayıt alanları

`site`, `id`, `gsc_rows[]`, `opportunity_source`, `classification`, `stage`, `evidence_label`,
`confidence`, `approval {state, approver}`, `risk`, `draft_ref?`, `pr?`, `expected_change? {text, test}`.
Bilinmeyen alan reddedilir; bu yüzden `draft_body` gibi bir alan kayda giremez.

- **GSC satırı:** `impressions/clicks/position` olduğu gibi taşınır; `source: "gsc"` ve
  `date_start/date_end` zorunlu. Ölçülmemiş değer `"UNKNOWN"`, asla tahmin değil.
- **Kaynak ekseni:** `gsc_evidence` kaydı >=1 GSC satırı taşır. `editorial` kayıt satır **taşıyamaz** ve
  `expected_change` metni hacim/gösterim/talep/yüzde dili içeremez (TR+EN). `editorial` bir kanıt
  etiketi değildir (`policies/evidence-labels.md`); etiket sözlüğü altı etiketle sabit.
- **Etiket + güven:** `INFERENCE/HYPOTHESIS/RECOMMENDATION` `CONFIRMED` olamaz.
  `HYPOTHESIS` bir `expected_change.test` adı vermek zorunda.
- **Taslak:** gövde hiçbir yerde yok; `draft_ref` yalnız `sites/<kendi-site>/drafts/...`
  (başka sitenin dizini, `..`, HTML reddedilir).
- **Onay:** `approver` hiçbir zaman varsayılan değil; boş, `claude`, `[bot]`, `default`, `UNKNOWN`,
  `auto` vb. insan onayı sayılmaz.

## Site izolasyonu

Her satır `site` etiketi taşır. Doğrulayıcı kaydı yalnız **kendi sitesinin** registry girdisine karşı
kontrol eder: satırın `site` değeri farklıysa (`CROSS_SITE_ROW`) ya da `page` hostu o sitenin
`production_domain`'i değilse (`ROW_PAGE_FOREIGN_DOMAIN`; `evil<domain>` son-ek tuzağı dahil) reddedilir.
`attachRow` aynı kontrolü yapıp **fırlatır**. `registered_not_onboarded` site için kayıt üretilmez
(`SITE_NOT_ONBOARDED`): ölçüm her siteye yapılır, tavsiye yalnız onboard edilmiş siteye
(`policies/portfolio-isolation.md`).

## Kanıttan sınıflandırma (`classifyFromEvidence(rows, policy?)`)

Çıktı her zaman `INFERENCE`; `CONFIRMED` **olamaz** (eşik bir kuraldır, ölçüm değil). Politika da
bunu değiştirmez. Yalnız ölçülmüş `impressions >= min_impressions` ve sayısal `position` taşıyan
satırlar sayılır; gerisi `UNKNOWN`.

| Durum (varsayılan değerlerle) | Sınıf | Güven |
|---|---|---|
| Satır yok / hepsi UNKNOWN / eşik altı | `skip` | `UNKNOWN` (neye bakıldığı `reason`'da) |
| Aynı sorgu >=`consolidate_min_pages` sayfada gösterim alıyor | `consolidate` | `CANDIDATE` |
| En iyi pozisyon `refresh_position_min`–`refresh_position_max` (8–20) | `refresh` | `CANDIDATE` |
| En iyi pozisyon < `refresh_position_min` | `skip` | `CANDIDATE` |
| En iyi pozisyon > `refresh_position_max` | `new_page` | `CANDIDATE` |

### ContentPolicy (eşikler varsayımdır)

Eşikler (50 gösterim, 8/20, 2 sayfa) ölçüm değil **başlangıç varsayımıdır**; artık koda gömülü değil,
`ContentPolicy` olarak verilir. Politika kaynağı (`provenance`) **ayrı bir alandır**, kanıt etiketi
değildir: altı etiket (FACT, INFERENCE, HYPOTHESIS, RECOMMENDATION, IMPLEMENTED_CHANGE,
VERIFIED_RESULT) aynen kalır, yeni etiket eklenmedi.

```ts
{ min_impressions, refresh_position_min, refresh_position_max, consolidate_min_pages,
  provenance: { origin: "policy", status: "DEFAULT_ASSUMPTION" | "OWNER_SET", set_by, note } }
```

- **Varsayılan** (`DEFAULT_CONTENT_POLICY`): `{50, 8, 20, 2}`, `provenance = {origin:"policy",
  status:"DEFAULT_ASSUMPTION", set_by:"unset", note}`. Politika verilmezse (`undefined`/`null`/`{}`) sistem
  bununla çalışır.
- **Kısmi politika:** eksik alanlar varsayılanla tamamlanır ve durum `DEFAULT_ASSUMPTION` kalır
  (`note` hangi alanların tamamlandığını yazar). `OWNER_SET` yalnız **tüm** alanlar verilmiş, `set_by`
  insan adı (bot/`claude`/`default` değil) ve `status: "OWNER_SET"` açıkça yazılmışsa olur.
- **Fail-closed:** `NaN`, `Infinity`, negatif, string, `refresh_position_min > refresh_position_max`,
  `position < 1`, bilinmeyen anahtar, bozuk `provenance` → `POLICY_REJECTED:<kod,...>` fırlatır; hiçbir
  değer sessizce düzeltilmez. `resolvePolicy(x)` aynı kontrolü fırlatmadan `{ok:false, errors}` döner.
- **`require_policy: true`:** tam ve `OWNER_SET` politika yoksa varsayılana düşülmez; çıktı
  `skip` / `UNKNOWN` olur (`reason` nedenini yazar).
- **Çıktı politikayı kaydeder:** `Classified.policy` sınıflandırmayı üreten değerleri ve `provenance`'ı
  taşır; politika sınıfı değiştirebilir ama `evidence_label=INFERENCE` ve `confidence` hiçbir zaman
  politikadan `CONFIRMED` olmaz.
- **Dosyadan yükleme (isteğe bağlı):** `loadContentPolicy(path)` yerel JSON okur (ağ yok), doğrular,
  bozuksa fırlatır. Şema + örnek: `schemas/content-policy.schema.json`. `config/content-policy.json`
  bu depoda **yoktur**; politikayı belirlemek sahibin kararıdır.

## Bağlama (henüz yapılmadı)

Bu modül CLI'ye bağlı değildir. Gerekenler: bir `content-validate <dosya>` komutu, GSC satırlarını
`measure` çıktısından `GscRow`'a çeviren bir adaptör ve `sites/<site>/drafts/` dizin sözleşmesi.
