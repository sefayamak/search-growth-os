# Deployment dogrulayici ve zaman cizelgesi

Modul: `src/deployment-timeline.ts`. Salt-okunur; hicbir deploy tetiklemez, hicbir siteye yazmaz
(bkz. `docs/integrations/deployment-providers.md`). Ag cagrisi modulde yok: canli probe enjekte edilir.

## Neden

"Dusus deploy'dan sonra basladi" hipotezi, deploy'un gercekten canli olup olmadigi bilinmeden
anlamsiz. Saglayicinin raporu (GitHub Deployments, Vercel) "deploy ettim" demektir; canli sitenin
hangi commit'i sundugu ayri bir olcumdur. Bu yuzden parser'lar `UNVERIFIED` uretir, yalniz
`verifyDeployment` `VERIFIED` verebilir.

## DeploymentEvent (`sgos.deployment-event.v1`, `schemas/deployment-event.schema.json`)

`site`, `environment` (production|preview|unknown), `commit_sha` (tam 40 hex; kisa SHA reddedilir),
`deployed_at` (ISO UTC), `verification_state`, `provenance {source, retrieved_at, ref}`, `evidence: FACT`.
Kanit etiketi altı etiketli ontolojiye uyar; `verification_state` ayri bir eksendir, guven (confidence) degildir.

## Dogrulama durumlari

| Durum | Anlami |
|---|---|
| VERIFIED | Canli SHA, beklenen SHA ile tam eslesti |
| MISMATCH | Canli SHA olculdu ve farkli |
| UNKNOWN | Erisilemedi, SHA donmedi/bozuk, probe hata verdi. Asla VERIFIED sayilmaz |
| UNVERIFIED | Henuz denenmedi (parser ciktisi) |

Erisilemez probe'un dondurdugu SHA'ya guvenilmez (UNKNOWN).

## Zaman cizelgesi (`sgos.deployment-timeline.v1`)

Site basina; deployed_at'a gore sirali; `site+sha+environment` ile tekrarsiz (ilk kayit korunur);
en fazla 200 olay (en eski duser). `parseTimeline` fail-closed: tek bozuk olay, baska siteye ait olay,
tekrar, sira bozuklugu veya bilinmeyen alan tum cizelgeyi reddeder. Parser'lar (`parseGithubDeployments`,
`parseVercelDeployments`) satir bazinda `rejected` listesi dondurur; taninmayan govde sekli throw eder.
Tanimsiz ortam adi `unknown` olur, production varsayilmaz.

## Korelasyon: `temporal_coincidence`

`correlate(event, metricChange)` yalniz `INFERENCE` / `CANDIDATE` doner ve her zaman bir
`confirming_test` icerir (dokunulan vs dokunulmayan sayfalari ayni pencerede karsilastir).
Nedensellik dili yoktur; test cikti metinlerini yasakli ifadeler icin tarar. Uretilmeyen durumlar:
baska site (izolasyon), preview/unknown ortam, MISMATCH deploy, deploy'dan once veya 72 saat sonrasi.
`MetricChange` kasitli olarak buyukluk alani tasimaz: rakam uydurulmaz, yalniz yon ve kaynak referansi.

## Baglanti (orkestrator)

- `cli.ts`'e komut eklenmedi. Onerilen: `deployments <timeline.json>` (parseTimeline + ozet).
- Canli probe gercek uygulamasi (meta/header okuma) ayri is; arayuz: `LiveProbe`.

## Sinirlar

Gercek GitHub/Vercel cagrisi yok (fixture-first). Canli SHA probe'unun sitede nasil acilacagi
(meta etiketi, header) site sahibiyle belirlenmeli; o zamana kadar durum UNKNOWN/UNVERIFIED kalir.
