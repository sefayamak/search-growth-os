# index-alarms — indeks alarmları ve canonical backlog

Modül: `src/index-alarms.ts`. Salt-okunur, ağ yok, Indexing API yok, üretim yazısı yok.
Girdi: `index-probe` ÖRNEKLEM sonuçları ve `canonical-relations` çıktısı (ikisi de yalnız okunur).

## Neden var

`index-probe` tek koşunun anlık görüntüsüdür. "Bu URL 24 saatten uzun süredir indekste değil"
bilgisi ancak iki koşunun farkından çıkar. Bu modül o fark için site başına yerel geçmiş tutar.

## Örneklem, kapsam değil

URL Inspection tek URL cevaplar; toplu Pages raporu API'de yok. Bu yüzden her çıktı
`coverage_basis: "sample"`, örnek boyu ve (biliniyorsa) evren boyu taşır; evren bilinmiyorsa
`UNKNOWN`. Örnekten tüm site için oran/yüzde **üretilmez** (test: çıktıda `%` yok).
Örnek yoksa durum `UNKNOWN`'dur, "ok" değildir. Alarm yoksa durum `NO_ALARM_IN_SAMPLE`'dır;
yanında "değerlendirilemeyen URL" sayısı yazılır (bir koşulu UNKNOWN olan URL için alarm
üretilemez ve "sorun yok" da denemez).

## 1. İndeks geçmişi

- Dosya: `data/index-history/<site>.json`, şema `sgos.index-history.v1`
  (`schemas/index-history.schema.json`), en fazla 120 snapshot (eskiler kırpılır).
- `parseHistory` fail-closed: bozuk dosya, yanlış site, zaman sırası bozuk, geçersiz alan => hata.
  Bozuk dosya sessizce boş geçmişe dönmez (boş geçmiş "sorun yok" gibi okunurdu).
- Dosya yoksa boş başlar. Başka sitenin dosyası/snapshot'ı reddedilir (portföy izolasyonu).
- `snapshotFromProbe(probeResult, takenAt, universeSize?)`: uygunluk alanları yalnız probe'un FACT
  alanlarından türer. `HOST_VARIANT_RISK` ve segmentsiz (`gsc`) koşuda sitemap üyeliği bilinmez => UNKNOWN.
  `fetch_ok` Google'ın `pageFetchState` değeridir, bizim HTTP 200 ölçümümüz DEĞİL.

## 2. İndeks alarmı

URL "indekslenmeli" sayılır: sitemap'te + Google fetch başarılı + canonical kendisi + indekslenebilir
(`INDEXING_ALLOWED` ve robots `ALLOWED`). Alarm: bu koşullar sağlanırken ardışık >= 2 gözlemde karar
`INDEXED` değil (`NOT_INDEXED`, `NEUTRAL`, `UNKNOWN`) ve ilk-son fark **> 24 saat** (tam 24 saat alarm değil).

- Seri `INDEXED` gözlemi ya da uygunluk kaybıyla kesilir. `ERROR` (çağrı hatası) gözlem sayılmaz: ne uzatır ne keser.
- URL'nin örneğe girmediği snapshot'lar atlanır (örnekleme döner); yalnız gözlenenler sayılır.
- Etiket: **INFERENCE / CANDIDATE / REVIEW_REQUIRED**. Onaylayan test: manuel URL Inspection.
  Kod hiçbir şeyi onaylamaz; tekrar etmek çıkarımı FACT yapmaz.

## 3. Canonical conflict backlog

- Dosya: `data/canonical-backlog/<site>.json`, şema `sgos.canonical-backlog.v1`.
- İzlenen desenler: `DECLARED_GOOGLE_CONFLICT` (cross-domain dahil; `cross_domain` alanı kayıtlıdır) ve
  `GOOGLE_USER_CONVERGE_ON_OTHER_URL`. Sınıflandırma `canonical-relations`'tan **okunur**, yeniden yazılmaz.
- Alanlar: `first_seen`, `last_seen`, `observation` (OBSERVED | NOT_OBSERVED), `owner_status`.
- **Durum yalnız sahibindir.** `owner_status` null => OPEN; sahip dosyada `ACKNOWLEDGED` veya
  `RESOLVED_BY_OWNER` yazar (`owner_by`, `owner_at`, `owner_note`). Kod bu alanlara asla yazmaz, otomatik çözmez.
- Kayıt sonraki taramada görünmezse **NOT_OBSERVED** olur, çözülmüş sayılmaz. Neden ayrılır:
  `INSPECTED_NO_LONGER_MATCHING` (denetlendi, artık eşleşmiyor; yine de çözüm kanıtı değil) ile
  `NOT_INSPECTED_IN_SAMPLE` (bu turda denetlenmedi; hiçbir şey bilinmiyor; INCOMPLETE denetim de buraya girer).
  Boş tarama (NOT_CONNECTED / erken durma) kayıtlara dokunmaz.
- Sahip RESOLVED yazdıktan sonra kayıt yeniden gözlenirse `reobserved_after_resolution: true` işaretlenir.
- Yaşlanma kovaları (kapanmamışlar, `first_seen`'den): `0-7d`, `8-30d`, `31-90d`, `>90d`.
- Etiket: INFERENCE / CANDIDATE / REVIEW_REQUIRED (boş backlog: UNKNOWN güven).

## 4. Çıktı

`buildReport(history, backlog, nowIso)` => JSON (`index_alarms`, `canonical_backlog`);
`reportToMarkdown(report)` => Türkçe markdown. Başlıkta örneklem uyarısı her zaman var.

## Bağlama (bu sprintte yapılmadı)

`cli.ts` / workflow dokunulmadı. Önerilen akış, `index-probe` koşusundan sonra:

```ts
const h = appendSnapshot(loadHistory(site), snapshotFromProbe(probe, now, universeSizeOrUnknown));
const b = updateBacklog(loadBacklog(site), probe.results, now);
saveHistory(h); saveBacklog(b);
console.log(reportToMarkdown(buildReport(h, b, now)));
```

Geçmiş/backlog dosyalarını bir workflow'un commit etmesi ayrı karar ister (veri yazımı; PR olarak gelmeli).

## Sınırlar

- Alarm örneklemdedir; örneğe girmeyen URL hakkında bir şey söylemez.
- `canonical_self` yalnız index-probe'un üç-URL desenine dayanır (fetch ile doğrulanmadı).
- İki snapshot arası zaman, koşu saatidir; Google'ın gerçek durum değişim anı bilinmez.
