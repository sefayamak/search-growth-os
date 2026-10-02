# Scorecard ve orkestrasyon modeli

İki parça, ikisi de **salt-okunur ve ağsızdır**: ne bir iş çalıştırır, ne bir siteye dokunur.

- `src/orchestration.ts` — hangi iş, nerede, ne zaman, hangi kotayı yer, neye yazar. Tek kanonik model (veri) + doğrulayıcı.
- `src/scorecard.ts` — site başına altı boyutlu durum kartı; girdisi **artifact dosyalarıdır**.

## 1. Orkestrasyon modeli

Her iş: `{id, loop, cadence, cron, runner, workflow, api_calls_per_site, quota_cost, state, gate, writes, depends_on}`.
`state`: `ACTIVE` (çalışıyor) · `GATED` (bayrak/owner eylemi açınca çalışır) · `DISABLED` · `PLANNED` (henüz kod yok).
Döngüler: `daily`, `weekly`, `monthly`, `on_demand` (dispatch/event). **Monthly döngüde henüz iş yok**; uydurma iş eklenmedi.

Tohum, gerçek `.github/workflows/*.yml` dosyalarından:

| İş | Cron (UTC) | Durum | Kota |
|---|---|---|---|
| portfolio-check | Pzt 06:10 | ACTIVE | – |
| measure | Pzt 06:40 | ACTIVE | GSC+GA4 (UNKNOWN) |
| search-audit | Pzt 06:40 | ACTIVE | – |
| clarity-daily | 07:20 günlük | **GATED** (`vars.SEARCH_GROWTH_CLARITY_DAILY_ENABLED == 'true'`) | Clarity 3/site |
| legacy-site-health-monitor | 06:10 günlük (ccr_routine) | ACTIVE (owner kapatana kadar) | Clarity 3/site |
| clarity-manual / index-probe / brain / tests-ci | schedule yok | ACTIVE (dispatch/event) | Clarity 3 / URL Inspection / – / – |
| lighthouse-weekly, index-alarms-daily, deployment-verifier, scorecard-weekly | – | **PLANNED** | – |

PLANNED işlerin cron saatleri **öneridir**; workflow yazılınca model güncellenir.

### Doğrulayıcı (`validateModel`)

| Kod | Ne yakalar |
|---|---|
| `DUPLICATE_SCHEDULER` (ERROR) | Aynı kota havuzunu tüketen ≥2 **günlük zamanlayıcı** (ACTIVE/GATED). Tohum modelde bugün **yanar**: legacy + clarity-daily. Legacy `DISABLED` olunca söner. |
| `QUOTA_OVERBOOKED` / `QUOTA_NEAR_LIMIT` | En kötü gün toplamı (dispatch işleri dahil) tavanı aşar / %80'e varır. Tohum: Clarity 3+3+3 = **9/10**. Maliyeti `UNKNOWN` olan işler toplanmaz ve mesajda belirtilir; "tavan aşıldı" uydurulmaz. |
| `SCHEDULE_COLLISION` | Referans haftada aynı dakikada tetiklenen iki iş. Aynı havuz/aynı runner = WARN; farklı kaynak = INFO (measure ve search-audit Pzt 06:40: bilinen, zararsız). |
| `BAD_CRON` / `MISSING_CRON` / `UNEXPECTED_CRON` | 5 alan, aralık, adım, liste; event/manual işin cron'u olmaz. |
| diğerleri | tekrar id, bilinmeyen bağımlılık/havuz, GATED kapısız, loop-cadence uyumsuzluğu, `quota_cost` ile `api_calls_per_site` farkı. |

**Drift testi** (`tests/orchestration.test.ts`): gerçek workflow dosyalarını okur; (a) modelde olmayan schedule, (b) modelde olup workflow'da olmayan cron, (c) modelde işi olmayan workflow, (d) workflow'dan kaybolan GATED kapısı → test kırılır. Yorum satırındaki örnek cron yok sayılır.

Sınırlar: YAML ayrıştırıcı yok, yalnız `cron: "..."` satırları okunur; çakışma analizi tek referans hafta ile yapılır (ay/gün-of-ay kısıtlı cron'lar için eksik kalabilir); `ccr_routine`/`owner_mac` işleri workflow'dan doğrulanamaz, modelde **el ile** tutulur (legacy cron 06:10Z beyana dayalı, `docs/integrations/clarity-daily.md`).

Kota tavanları kaynaklıdır: Clarity 10/gün/proje (`docs/integrations/clarity-daily.md`), URL Inspection 2000/gün/property (`src/index-probe.ts` yorumu). GSC+GA4 `measure` tavanı bu depoda belgelenmemiş → `UNKNOWN`.

## 2. Scorecard

Boyutlar: `measurement_health`, `index_health`, `search_opportunity`, `ux_friction`, `performance`, `deployment_change`.
Her boyut `{state, evidence_label, confidence, basis, as_of}`. `state`: `OK | ATTENTION | UNKNOWN | UNKNOWN-STALE | NOT_CONNECTED`.
Evidence ontolojisi tam altı etiket + `CONFIRMED/CANDIDATE/FALSE_POSITIVE/UNKNOWN`; **yeni etiket yok**.

Kurallar (hepsi testli):

1. **Girdi yok → UNKNOWN, asla OK.** Bozuk JSON, yanlış şema kimliği, boş kayıt da UNKNOWN.
2. **Bayat girdi → UNKNOWN-STALE** (varsayılan sınır: clarity/index 3 gün, performans/ölçüm/deployment 10 gün; `buildScorecard(..., maxAge)` ile ayarlanır). Gelecek tarihli kayıt bayatlık testini kandıramaz (UNKNOWN).
3. **Tek skor yok.** Özet yalnız `counts` (durum sayımı).
4. **İzolasyon.** Başka siteye ait dosya/olay/rapor girişi hiçbir boyuta girmez (`site_id` uyuşmazlığı → UNKNOWN; deployment olayları site'ye göre süzülür, sayısı basis'e yazılır).
5. **Çıkarım onaylanmış gibi raporlanmaz.** Doğrudan okuma (Clarity `measurement_success`, NOT_CONNECTED, doğrulanmamış deploy) = `FACT/CONFIRMED`. Eşik/yorum gerektiren her `OK/ATTENTION` (friction, performans, index, firsat, "deploy yok") = `INFERENCE/CANDIDATE`. UNKNOWN durumları `confidence=UNKNOWN`. `dimensionInvariantProblems()` bunu zorlar.
6. **"Bulunamadı" ile "baktık, yok" ayrılır:** `basis` neye baktığını yazar (örn. "ÖRNEKLEM 20 URL, tam coverage değil").

Boyuta özel yanlış-negatif korumaları: `ux_friction` yalnız `usable` Clarity kaydını kullanır (hata/sıfır/eksik gün friction=0 sayılmaz); gerçek oturum < 5 ise UNKNOWN; `UNKNOWN` metrik sıfır sayılmaz. `dead_click` tek başına eşik değildir (taban çizgisi olmadan; trend `clarity-daily` alert'inin işi). `performance` eksik metrikle OK vermez. `index_health` ERROR/PARTIAL'ı "indexli değil" saymaz; örneklem 0 → UNKNOWN.

Kayıtlı ama onboard edilmemiş site için kart üretilir (ölçüm her kayıtlı site için yapılabilir) fakat markdown "tavsiye üretilmez" notu taşır; scorecard zaten tavsiye (`RECOMMENDATION`) üretmez.

### Girdi şemaları (id ile okunur, başka modül import edilmez)

Dosya düzeni: `<dizin>/<site_id>.json`. Okunan **asgari** alanlar (fazlası yok sayılır):

- `sgos.clarity-history.v1` — `src/clarity-daily.ts` ile birebir (`records[]`: `date, measured_at, measurement_state, confidence, rows_complete, usable, friction, sessions, error_code`). Gerçek: `data/clarity-history/`.
- `sgos.performance-history.v1` — `records[]`: `date|measured_at`, `measurement_state` (MEASURED/NOT_CONNECTED/…), `lcp_ms`, `cls`, `inp_ms`. Eşikler web.dev Core Web Vitals "good": LCP ≤ 2500 ms, CLS ≤ 0.1, INP ≤ 200 ms.
- `sgos.index-history.v1` — `records[]`: `date|measured_at`, `measurement_state`, `sample_size`, `not_indexed_count`.
- `sgos.deployment-event.v1` — dosya `{generated_at, events[]}` ya da olay dizisi; olay: `schema, site_id, deployed_at, verification_state` (`VERIFIED` değilse ATTENTION). Tazelik dosyanın `generated_at`'inden gelir (olay olmaması bayatlık değildir).
- `sgos.measure-report.v1` — `{generated_at, sites: {<id>: {gsc_state, opportunity_count, generated_at?}}}`.

**Önemli varsayım:** performance/index/deployment/measure şemalarının yukarıdaki alanları bu PR'ın **okuma sözleşmesidir**; diğer sprint'lerin birleşmemiş üreticileri farklı alan adı yazarsa ilgili boyut güvenle `UNKNOWN` döner (yanlış OK vermez) ve burada hizalanır. Bugün `measure` yalnız Markdown (`reports/measure-latest.md`) üretiyor; JSON çıktısı yazılana kadar `search_opportunity` UNKNOWN kalır.

### Kullanım

```bash
node --experimental-strip-types bin/scorecard.ts config/sites.yaml [--site ID] [--json] \
  [--clarity data/clarity-history] [--performance DIR] [--index DIR] [--deployments DIR] [--measure FILE]
```

Şema: `schemas/scorecard.schema.json` (`sgos.scorecard.v1`).

## Bağlama (bu PR yapmaz)

- `src/cli.ts`: `orchestration` (modeli + bulguları yazdır) ve `scorecard` alt komutları; şu an `bin/scorecard.ts` bağımsız çalışır.
- `package.json` `test` zaten `tests/*.test.ts` glob'u; ek iş yok.
- `scorecard.yml` (haftalık, ağsız, PLANNED) workflow'u yazılınca modelde `workflow`/`cron` doğrulanır; yeni her workflow aynı PR'da modele eklenmezse drift testi kırılır (istenen davranış).
- Legacy rutin kapandığında `legacy-site-health-monitor.state` → `DISABLED`; `DUPLICATE_SCHEDULER` ve `QUOTA_NEAR_LIMIT` söner.
- `clarity-daily` cutover bayrağı açılınca `state` → `ACTIVE` (gate kaldırılır; workflow `if:`'i değişirse drift testi kırılır).
