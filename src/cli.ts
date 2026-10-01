// Search Growth OS CLI — read-only.
//   crawl <url> [--max-pages N] [--max-depth N] [--delay ms] [--out dir]
//   audit <url> [...same]           crawl + checks + dry-run report (json + md)
//   audit <prod-url> --local <url>  same, but served from a local build (pre-deploy)
//   compliance <file> [--kind k]    run the compliance gate on a file
//   compliance --stdin --kind k     read content from stdin
//   registry <path>                 validate a site registry (yaml subset / json)
//   integrations                    print adapter connection states
//   portfolio [--site id] [--onboarded-only] [--sample N] [--delay ms] [--out dir]
//                                   measure publishing cadence across the registry
//   llmstxt [--site id] [--out dir]  inventory each site's llms.txt against the spec and the registry
//   topics [--site id] [--count N=2] [--top N] [--ledger path] [--write-ledger]
//                                   2 weekly topics per site: GSC gap first, business_category fallback
//   clarity-smoke [registry]        OFFLINE: token map shape, site routing and request budget (NO API call, NO token printed)
//   clarity-measure [registry] [--site id] [--out dir]
//                                   native Microsoft Clarity export: 3 requests/site/run, numOfDays=1; writes JSON+MD to --out (default clarity-out)
//   brain-evidence [registry] --site id --clarity <clarity-<site>.json> [--out file]
//                                   normalize existing collector output into a sgos.brain.evidence-bundle.v1 file (local, no network)
//   brain-handoff [registry] --site id --run-id N --repo owner/repo [--artifact-dir d] [--run-meta f] [--artifacts-meta f] [--handoff-run-id N] [--out dir=handoff-out]
//                                   Clarity artifact -> sgos.brain.evidence.v1 (LOCAL files, no network, no API call). Explicit run id; only
//                                   the selected site's clarity-<site>.json is read; foreign site = FAILED, missing = NOT_AVAILABLE
//   brain-validate [registry] --site id [--evidence file] [--no-config-report]
//                                   OFFLINE: load the 9 agents/*.md profiles, validate the evidence bundle, print the routing plan (NO API call)
//   brain-run [registry] --site id [--evidence file] [--out dir=brain-out] [--write-memory]
//                                   cloud Brain: route -> <=3 specialists -> Chief -> compliance via the Anthropic API (key + model from env;
//                                   NOT_CONFIGURED = zero calls). Writes nothing to any site; memory persists only with --write-memory
//   import-health <snapshotDir> [--registry path] [--site id] [--write]
//                                   validate a site-health-monitor snapshot DIRECTORY (local path, no network);
//                                   "no data" never becomes zero; --write merges into sites/<id>/health-import.json
//   inspect-index [registry] --site pamistanbul [--limit N] [--urls file] [--delay ms] [--write] [--strategy gsc|segmented]
//                                   read-only URL Inspection SAMPLE for pamistanbul only (NOT full coverage).
//                                   gsc (default) = candidates from the last 28 days of GSC pages;
//                                   segmented = sitemap + GSC, split into risk segments, stateless daily rotation
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { crawl } from "./crawler.ts";
import { assessPortfolio, cadenceToMarkdown } from "./cadence.ts";
import { inspectPortfolio, llmsTxtToMarkdown } from "./llmstxt.ts";
import { runAudit } from "./audit.ts";
import { buildReport, reportToMarkdown } from "./report.ts";
import { checkCompliance, kindFromPath } from "./compliance.ts";
import { loadRegistry, onboardedSites } from "./registry.ts";
import { allStatuses } from "./adapters/index.ts";
import type { QuotaLedger } from "./index-probe.ts";

const args = process.argv.slice(2);
const cmd = args[0];
function opt(name: string, def: string): string;
function opt(name: string): string | undefined;
function opt(name: string, def?: string) { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; }
const flag = (name: string) => args.includes(`--${name}`);

function slug(u: string) { return u.replace(/^https?:\/\//, "").replace(/[^a-z0-9.-]+/gi, "_"); }

async function main() {
  switch (cmd) {
    case "crawl":
    case "audit": {
      // Two ways in. `--site <id>` resolves the target through the registry and is the
      // only path the remote runner uses, because the registry is where the
      // onboarding gate lives: a site that is merely registered must never be crawled.
      const siteId = opt("site");
      let url = args[1] && !args[1].startsWith("--") ? args[1] : undefined;
      if (siteId) {
        const reg = loadRegistry(opt("registry", join("config", "sites.yaml")));
        if (!reg.ok) throw new Error(`registry invalid:\n${reg.errors.join("\n")}`);
        const site = reg.registry!.sites.find((s) => s.id === siteId);
        if (!site) throw new Error(`site "${siteId}" is not in the registry`);
        if (!onboardedSites(reg.registry!).some((s) => s.id === siteId))
          throw new Error(`site "${siteId}" is ${site.onboarding_status}: it must be onboarded before it can be crawled (policies/portfolio-isolation.md)`);
        const host = site.canonical_hostname && !["UNKNOWN", "NOT_CONNECTED"].includes(site.canonical_hostname) ? site.canonical_hostname : site.production_domain;
        url = `https://${host}/`;
        console.error(`site ${siteId} (${site.onboarding_status}) → ${url}`);
      }
      if (!url) throw new Error("usage: audit <url> | audit --site <registry id>");
      // Pre-deploy mode. The target keeps its production origin for every judgement the
      // audit makes; only the bytes come from the local server. The onboarding gate above
      // is not involved, because this reads a build, not a live site.
      const local = opt("local");
      const originAlias = local ? { from: new URL(url).origin, to: new URL(local).origin } : undefined;
      if (originAlias) console.error(`pre-deploy: ${originAlias.from} served from ${originAlias.to}`);
      const full = flag("full");
      // In full mode the sitemap is the universe, so the cap must not silently truncate it.
      // The explicit --max-pages still acts as a ceiling, raised to cover the sitemap.
      const cap = Number(opt("max-pages", full ? "5000" : "50"));
      const result = await crawl({ startUrl: url, fromSitemap: full, maxPages: full ? Math.max(cap, 5000) : cap, maxDepth: Number(opt("max-depth", full ? "2" : "3")), delayMs: Number(opt("delay", originAlias ? "0" : "500")), originAlias }, (s) => process.stderr.write(s + "\n"));
      // Unreachable target must fail loudly. A report built from zero fetched pages
      // would otherwise look like a clean site.
      const first = result.records[0];
      if (!first || first.page.status === 0 || first.page.status >= 400) {
        const why = first ? `${first.page.status || "no response"}${first.page.error ? ` (${first.page.error})` : ""}` : "no pages fetched";
        console.error(`CRAWL FAILED: ${url} unreachable — ${why}`);
        const robotsOk = result.robots.fetched && result.robots.status > 0 && result.robots.status < 400;
        console.error(robotsOk
          ? `robots.txt returned ${result.robots.status}, so the host is reachable and this page itself is failing.`
          : `robots.txt also failed (${result.robots.status || "no response"}): the whole host is unreachable from this runner — DNS, TLS, network egress policy, or a WAF refusing the crawler.`);
        process.exitCode = 3;
        return;
      }
      const outDir = opt("out", join("reports", "runs"));
      mkdirSync(outDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const base = join(outDir, `${slug(result.site)}_${stamp}`);
      writeFileSync(`${base}.crawl.json`, JSON.stringify(result, null, 2));
      if (cmd === "crawl") { console.log(`${base}.crawl.json`); return; }
      const findings = runAudit(result);
      const report = buildReport(result, findings, allStatuses().map(({ name, state, note }) => ({ name, state, note })));
      writeFileSync(`${base}.audit.json`, JSON.stringify(report, null, 2));
      writeFileSync(`${base}.audit.md`, reportToMarkdown(report));
      console.log(reportToMarkdown(report));
      console.error(`\nwritten: ${base}.audit.json / .audit.md / .crawl.json`);
      return;
    }
    case "compliance": {
      const path = flag("stdin") ? undefined : args[1];
      const content = path ? readFileSync(path, "utf8") : readFileSync(0, "utf8");
      const kind = (opt("kind") ?? (path ? kindFromPath(path) : "text")) as Parameters<typeof checkCompliance>[1]["kind"];
      const res = checkCompliance(content, { kind, path });
      console.log(JSON.stringify(res, null, 2));
      process.exitCode = res.verdict === "REJECT" ? 2 : res.verdict === "FLAG" ? 1 : 0;
      return;
    }
    case "registry": {
      const res = loadRegistry(args[1] ?? join("config", "sites.example.yaml"));
      if (res.ok) console.log(`OK: ${res.registry!.sites.length} site(s): ${res.registry!.sites.map((s) => s.id).join(", ")}`);
      else { console.error(res.errors.join("\n")); process.exitCode = 1; }
      return;
    }
    case "portfolio": {
      // Cadence measurement reads sitemaps and publish dates only. It derives no keyword,
      // competitor or strategy, so unlike `audit` it may look at every registered site —
      // that is what makes "check my sites" answerable in one pass. Turning a measurement
      // into ADVICE is still gated: see policies/portfolio-isolation.md.
      const reg = loadRegistry(opt("registry", join("config", "sites.yaml")));
      if (!reg.ok) throw new Error(`registry invalid:\n${reg.errors.join("\n")}`);
      const only = opt("site");
      let sites = reg.registry!.sites;
      if (only) {
        sites = sites.filter((s) => s.id === only);
        if (!sites.length) throw new Error(`site "${only}" is not in the registry`);
      }
      if (flag("onboarded-only")) sites = sites.filter((s) => onboardedSites(reg.registry!).some((o) => o.id === s.id));

      const results = await assessPortfolio(
        sites.map((s) => ({
          id: s.id,
          domain: s.canonical_hostname && !["UNKNOWN", "NOT_CONNECTED"].includes(s.canonical_hostname) ? s.canonical_hostname : s.production_domain,
          onboardingStatus: s.onboarding_status,
          sitemaps: (s.sitemap_locations ?? []).filter((u) => typeof u === "string" && u.startsWith("http")),
          cadenceDays: typeof s.content_cadence_days === "number" ? s.content_cadence_days : null,
          contentSections: Array.isArray(s.content_sections) ? s.content_sections : [],
        })),
        { samplePages: Number(opt("sample", "6")), delayMs: Number(opt("delay", "800")) },
        (s) => process.stderr.write(s + "\n"),
      );

      const outDir = opt("out", join("reports", "runs"));
      mkdirSync(outDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const base = join(outDir, `portfolio_${stamp}`);
      writeFileSync(`${base}.cadence.json`, JSON.stringify(results, null, 2));
      const md = cadenceToMarkdown(results);
      writeFileSync(`${base}.cadence.md`, md);
      console.log(md);
      for (const r of results) {
        console.error(`CADENCE ${r.siteId} verdict=${r.verdict} days=${r.daysSincePublish ?? "null"} expected=${r.expectedCadenceDays}`
          + ` section=${r.contentSection?.pattern ?? "none"} source=${r.latestPublish?.source ?? "none"} status=${r.onboardingStatus}`);
      }
      // A site that could not be measured is not a passing site. Exit 4 keeps an
      // unreachable host from reading as "nothing to report" in a scheduled run.
      if (results.some((r) => r.error)) process.exitCode = 4;
      console.error(`\nwritten: ${base}.cadence.json / .cadence.md`);
      return;
    }
    case "llmstxt": {
      // Inventory only. This reads two public files per site and compares them to facts the
      // owner already confirmed; it derives no strategy, so like `portfolio` it may look at
      // every registered site (policies/portfolio-isolation.md).
      const reg = loadRegistry(opt("registry", join("config", "sites.yaml")));
      if (!reg.ok) throw new Error(`registry invalid:\n${reg.errors.join("\n")}`);
      const only = opt("site");
      let sites = reg.registry!.sites;
      if (only) {
        sites = sites.filter((s) => s.id === only);
        if (!sites.length) throw new Error(`site "${only}" is not in the registry`);
      }
      const results = await inspectPortfolio(
        sites.map((s) => ({
          id: s.id,
          domain: s.canonical_hostname && !["UNKNOWN", "NOT_CONNECTED"].includes(s.canonical_hostname) ? s.canonical_hostname : s.production_domain,
          onboardingStatus: s.onboarding_status,
          foundationYear: typeof s.foundation_year === "number" ? s.foundation_year : null,
          brandEntities: Array.isArray(s.brand_entities) ? s.brand_entities : [],
        })),
        {},
        (s) => process.stderr.write(s + "\n"),
      );
      const outDir = opt("out", join("reports", "runs"));
      mkdirSync(outDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const base = join(outDir, `llmstxt_${stamp}`);
      writeFileSync(`${base}.json`, JSON.stringify(results, null, 2));
      const md = llmsTxtToMarkdown(results);
      writeFileSync(`${base}.md`, md);
      console.log(md);
      for (const r of results) {
        console.error(`LLMSTXT ${r.siteId} present=${r.present} status=${r.status} tokens=${r.tokensLow}-${r.tokensHigh}`
          + ` links=${r.spec?.linkCount ?? 0} questions=${r.spec?.questionCount ?? 0} full=${r.full.present}`
          + ` contradictions=${r.contradictions.length}`);
      }
      // A contradiction is a real defect on a live site, so it must not exit green.
      if (results.some((r) => r.contradictions.some((c) => c.confidence === "CONFIRMED"))) process.exitCode = 5;
      console.error(`\nwritten: ${base}.json / ${base}.md`);
      return;
    }
    case "integrations": {
      for (const s of allStatuses()) console.log(`${s.state.padEnd(14)} ${s.name} — ${s.note}`);
      return;
    }
    // Olcum raporu. Credential yoksa NOT_CONNECTED yazar ve DURUR — sifir
    // uretmez, tahmin etmez. Amaci, neyin olculebildigini ve neyin hala
    // baglanmadigini tek bakista gostermek.
    case "measure": {
      const { periods, brandPatterns, splitByBrand } = await import("./measure.ts");
      const { searchConsole, ga4 } = await import("./adapters/index.ts");
      const reg = loadRegistry(args[1] ?? "config/sites.yaml");
      if (!reg.ok || !reg.registry) { console.error(reg.errors.join("\n")); process.exitCode = 1; return; }
      const p = periods(new Date());
      console.log(`dönemler  : ${p.current.label} ${p.current.start}..${p.current.end}`);
      console.log(`            ${p.previous.label} ${p.previous.start}..${p.previous.end}`);
      console.log(`            ${p.yearAgo.label} ${p.yearAgo.start}..${p.yearAgo.end}`);
      // Durum satirlari EN SONA yaziliyor. Onceki hali cagrilardan once
      // basiyordu, dolayisiyla 14 satir OK olcen bir kosuda bile "UNKNOWN"
      // diyordu — kendiyle celisen bir rapor. Site ciktisi tamponlanir.
      const buf: string[] = [];
      const say = (l: string) => buf.push(l);
      const gscPre = searchConsole.status();
      for (const site of reg.registry.sites) {
        const prop = String(site.google_search_console_property);
        const ga = String(site.ga4_property);
        say(`${site.id}`);
        say(`  GSC property : ${prop}`);
        say(`  GA4 property : ${ga}`);
        const patterns = brandPatterns(site);
        say(`  marka deseni : ${patterns.join(" · ") || "(yok — brand_entities boş)"}`);

        // Gercek olcum. Iki sebep ayri ayri raporlanir ve BIRBIRINE
        // karistirilmaz: kimligin olmamasi (portfoyun tamami icin tek bir
        // eksik) ile property'nin registry'de bilinmemesi (o siteye ozel)
        // farkli islerdir; ikisini "NOT_CONNECTED" diye tek torbaya koymak,
        // hangisini duzeltecegini gizler.
        if (gscPre.state === "NOT_CONNECTED") { say(`  veri         : NOT_CONNECTED — ${gscPre.envVar} yok`); continue; }
        if (!prop || prop === "NOT_CONNECTED" || prop === "UNKNOWN") { say(`  veri         : NOT_CONNECTED — registry'de google_search_console_property yok`); continue; }
        try {
          // "toplam" SORGU kirilimindan degil, BOYUTSUZ (site-genel) cagridan
          // alinir. Sebebi: GSC dusuk hacimli sorgulari sorgu boyutunda satir
          // olarak hic DONDURMUYOR (bir "diger" toplami da vermiyor) — ayni
          // esik sayfa boyutunda farkli calisiyor, o yuzden ikisinin toplami
          // TUTMUYOR. 22.09.2026'da olculdu: pamaistudio sorgu kirilimindan
          // toplam 319 gosterim cikiyordu, tek bir SAYFA 450 gosterim
          // tasiyordu — sorgu toplami boyle kucuk kalinca kendiyle celisen
          // bir rapor uretiyordu. Boyutsuz cagri GSC'nin kendi site-genel
          // toplamidir, satir anonimlestirmesinden etkilenmez.
          const [now, then, nowTotal, thenTotal] = await Promise.all([
            searchConsole.searchAnalytics(prop, p.current, ["query"]),
            searchConsole.searchAnalytics(prop, p.yearAgo, ["query"]),
            searchConsole.searchAnalytics(prop, p.current, []),
            searchConsole.searchAnalytics(prop, p.yearAgo, []),
          ]);
          if (now === null || nowTotal === null) { say(`  veri         : NOT_CONNECTED — kimlik okunamadı`); continue; }
          const a = splitByBrand(now, patterns);
          const b = then ? splitByBrand(then, patterns) : null;
          const totalRow = (rows: typeof nowTotal) => rows[0] ?? { clicks: 0, impressions: 0, ctr: 0, position: 0 };
          const siteTotal = { ...totalRow(nowTotal), queries: a.all.queries };
          const siteTotalPrev = thenTotal ? totalRow(thenTotal) : null;
          // Yuzde degisim yalnizca onceki donem SIFIR DEGILSE anlamlidir;
          // 0'dan buyumeyi "%∞" diye yazmak raporu gurultuye cevirir.
          const delta = (cur: number, prev: number) => (prev === undefined ? "" : prev === 0 ? (cur === 0 ? "  (=)" : "  (yeni)") : `  (${cur >= prev ? "+" : ""}${(((cur - prev) / prev) * 100).toFixed(0)}% YoY)`);
          const line = (label: string, t: { clicks: number; impressions: number; position: number; queries: number }, prev?: { clicks: number }) =>
            say(`  ${label.padEnd(13)}: ${t.clicks} tık · ${t.impressions} gösterim · ort. ${t.position.toFixed(1)} · ${t.queries} sorgu${prev ? delta(t.clicks, prev.clicks) : ""}`);
          line("toplam", siteTotal, siteTotalPrev ?? undefined);
          // Marka/marka-disi ayrimi sorgu kirilimina DAYANMAK ZORUNDA (siniflandirma
          // sorgu metnine bakiyor) ve bu yuzden dusuk hacimli kuyrugu az sayar;
          // ikisinin toplami "toplam" satirindan KUCUK kalabilir — bu bir hata
          // degil, GSC'nin anonimlestirme davranisinin dogal sonucu, o yuzden
          // not olarak yaziliyor.
          if (a.all.impressions < siteTotal.impressions) {
            const gap = siteTotal.impressions - a.all.impressions;
            say(`  (not: marka/marka-dışı ayrımı ${gap} gösterimlik düşük-hacimli kuyruğu kapsamıyor — GSC sorgu satırı üretmiyor)`);
          }
          line("marka", a.brand, b?.brand);
          line("marka dışı", a.nonBrand, b?.nonBrand);
        } catch (e) {
          // Yetki hatasi "veri yok" gibi gosterilmez: servis hesabi
          // property'ye eklenmemisse duzeltilecek sey budur.
          say(`  veri         : HATA — ${(e as Error).message}`);
        }
      }
      // Artik gercek: canli cagrilar yapildi, durum gozleme dayaniyor.
      const gsc = searchConsole.status(), an = ga4.status();
      console.log(`\nSearch Console : ${gsc.state} — ${gsc.note}`);
      console.log(`GA4            : ${an.state} — ${an.note}`);
      if (gscPre.state === "NOT_CONNECTED") console.log("(kimlik yok — asagidaki her satir NOT_CONNECTED'dir, sifir DEGIL)");
      console.log("");
      for (const l of buf) console.log(l);
      return;
    }
    /**
     * Kirilim — "cok gosterim, az tik" sorusunu ISIMLENDIRIR.
     *
     * Toplam bir sayi sorunun varligini gosterir, sebebini gostermez.
     * pamistanbul 2026-09-22'de 58.071 gosterim ve 204 tik olctu: agirlikli
     * ortalama sira 3,5 iken TO %0,35. O siradan %10-25 beklenir. Aradaki
     * farki ancak hangi SORGU ve hangi SAYFA'nin gosterimi tasidigini gorerek
     * anlarsin.
     *
     * En degerli bolum "sifir tikli agirlik": cok gosterim alip hic tiklanmayan
     * satirlar. Ortalamayi bozan, genelde birkac tanesidir.
     */
    case "detail": {
      const { periods } = await import("./measure.ts");
      const { searchConsole } = await import("./adapters/index.ts");
      const reg = loadRegistry(args.find((a, i) => i > 0 && !a.startsWith("--") && args[i - 1] !== "--site" && args[i - 1] !== "--top") ?? "config/sites.yaml");
      if (!reg.ok || !reg.registry) { console.error(reg.errors.join("\n")); process.exitCode = 1; return; }
      const siteId = args[args.indexOf("--site") + 1];
      const top = Number(args[args.indexOf("--top") + 1]) || 15;
      const sites = siteId && args.includes("--site")
        ? reg.registry.sites.filter((x) => x.id === siteId)
        : reg.registry.sites;
      if (!sites.length) { console.error(`site bulunamadi: ${siteId}`); process.exitCode = 1; return; }
      const p = periods(new Date());

      for (const site of sites) {
        const prop = String(site.google_search_console_property);
        console.log(`\n=== ${site.id} — ${p.current.start}..${p.current.end}`);
        if (!prop || prop === "NOT_CONNECTED" || prop === "UNKNOWN") { console.log("  NOT_CONNECTED — registry'de property yok"); continue; }
        try {
          const [byQuery, byPage] = await Promise.all([
            searchConsole.searchAnalytics(prop, p.current, ["query"]),
            searchConsole.searchAnalytics(prop, p.current, ["page"]),
          ]);
          if (!byQuery || !byPage) { console.log("  NOT_CONNECTED — kimlik yok"); continue; }

          const fmt = (label: string, r: { clicks: number; impressions: number; position: number }) =>
            `  ${String(r.impressions).padStart(7)} gos · ${String(r.clicks).padStart(5)} tik · TO ${(r.impressions ? (r.clicks / r.impressions) * 100 : 0).toFixed(2).padStart(5)}% · sira ${r.position.toFixed(1).padStart(5)}  ${label}`;

          const tot = byQuery.reduce((a, r) => ({ c: a.c + r.clicks, i: a.i + r.impressions }), { c: 0, i: 0 });
          console.log(`  toplam: ${tot.i} gosterim · ${tot.c} tik · TO ${(tot.i ? (tot.c / tot.i) * 100 : 0).toFixed(2)}%`);

          // Sifir tikli agirlik: ortalamayi bozan satirlar. Payda TUM gosterim.
          const zero = byQuery.filter((r) => r.clicks === 0).sort((a, b) => b.impressions - a.impressions);
          const zeroImp = zero.reduce((a, r) => a + r.impressions, 0);
          console.log(`\n  SIFIR TIKLI AGIRLIK: ${zeroImp} gosterim (${tot.i ? ((zeroImp / tot.i) * 100).toFixed(1) : "0"}%), ${zero.length} sorgu`);
          for (const r of zero.slice(0, top)) console.log(fmt(r.query ?? "(bos)", r));

          console.log(`\n  TIK GETIREN SORGULAR (ilk ${top})`);
          for (const r of [...byQuery].sort((a, b) => b.clicks - a.clicks).slice(0, top).filter((r) => r.clicks > 0)) console.log(fmt(r.query ?? "(bos)", r));

          console.log(`\n  GOSTERIME GORE SAYFALAR (ilk ${top})`);
          for (const r of [...byPage].sort((a, b) => b.impressions - a.impressions).slice(0, top)) console.log(fmt(r.page ?? "(bos)", r));
        } catch (e) {
          console.log(`  HATA — ${(e as Error).message}`);
        }
      }
      return;
    }
    /**
     * KONU FIRSATI — gercek talep, tahmin edilmis "trend" DEGIL.
     *
     * Google Trends, rakip analizi ya da baska bir dis "trend" kaynagi
     * kullanilmiyor — boyle bir baglanti yok. Once site kendi Search
     * Console verisinde, insanlarin ZATEN arayip siteyi ZATEN gordugu ama
     * tiklamadigi sorgulari arar (KANIT). GSC'de yeterli hacim yoksa (kucuk
     * ya da yeni siteler) registry'deki business_category'den turetilmis
     * ALICI SORUSU sekline sokulmus bir baslik onerir (EDITORYAL) — ikisi
     * HICBIR ZAMAN karistirilmiyor, her satir kaynagini tasiyor.
     *
     * Her site icin TAM 2 konu hedeflenir (--count ile degistirilebilir).
     * Ciktinin KENDISI icerik degil, "buraya bak" listesi: hangi taslak
     * yazilacagina, ne zaman yayinlanacagina insan karar verir. Bu komut
     * hicbir sey yayinlamaz, deploy etmez, indekslemez.
     *
     * Hafta hafta ayni sorgunun/basligin tekrar tekrar "yeni kesif" gibi
     * gosterilmesi listeyi gurultuye cevirir. Bunun icin --ledger dosyasi
     * her basligin ilk gorulme tarihini tutar; sonraki haftalarda YENI /
     * ACIK KALMIS ayrimi buradan gelir. Ledger yalniz --write-ledger
     * verildiginde guncellenir — aksi halde salt-okunur kalir.
     */
    case "topics": {
      const { periods, brandPatterns, topicOpportunities, weeklyTopics } = await import("./measure.ts");
      const { searchConsole } = await import("./adapters/index.ts");
      const reg = loadRegistry(args.find((a, i) => i > 0 && !a.startsWith("--") && args[i - 1] !== "--site" && args[i - 1] !== "--top" && args[i - 1] !== "--count" && args[i - 1] !== "--ledger") ?? "config/sites.yaml");
      if (!reg.ok || !reg.registry) { console.error(reg.errors.join("\n")); process.exitCode = 1; return; }
      const siteId = args[args.indexOf("--site") + 1];
      const top = Number(args[args.indexOf("--top") + 1]) || 10;
      const count = Number(args[args.indexOf("--count") + 1]) || 2;
      const ledgerPath = opt("ledger");
      const writeLedger = flag("write-ledger");
      const sites = siteId && args.includes("--site") ? reg.registry.sites.filter((x) => x.id === siteId) : reg.registry.sites;
      if (!sites.length) { console.error(`site bulunamadi: ${siteId}`); process.exitCode = 1; return; }
      const p = periods(new Date());
      const now = new Date();
      const weekIndex = Math.floor(now.getTime() / (7 * 86_400_000)); // haftadan haftaya AÇI şablonu döner

      type LedgerEntry = { firstSeen: string; lastSeen: string; weeksOpen: number };
      type Ledger = Record<string, Record<string, LedgerEntry>>; // site -> normalizedTitle -> entry
      let ledger: Ledger = {};
      if (ledgerPath) { try { ledger = JSON.parse(readFileSync(ledgerPath, "utf8")); } catch { /* ilk calisma — dosya yok, bos ledger */ } }
      const today = new Date().toISOString().slice(0, 10);

      for (const site of sites) {
        const prop = String(site.google_search_console_property);
        console.log(`\n=== ${site.id} — ${p.current.start}..${p.current.end}`);
        let opps: Awaited<ReturnType<typeof topicOpportunities>> = [];
        if (prop && prop !== "NOT_CONNECTED" && prop !== "UNKNOWN") {
          try {
            const rows = await searchConsole.searchAnalytics(prop, p.current, ["query"]);
            if (rows) opps = topicOpportunities(rows, brandPatterns(site), { top });
          } catch (e) {
            console.log(`  KANIT taraması başarısız — ${(e as Error).message} (yalnız editoryal önerilecek)`);
          }
        }

        const topics = weeklyTopics(site, opps, weekIndex, count);
        if (!topics.length) { console.log("  konu yok — registry'de business_category boş, KANIT de yok"); continue; }

        const siteLedger = (ledger[site.id] ??= {});
        for (const t of topics) {
          const key = t.title.toLocaleLowerCase("tr").trim();
          const existing = siteLedger[key];
          const isNew = !existing;
          const weeksOpen = existing ? existing.weeksOpen + (existing.lastSeen === today ? 0 : 1) : 1;
          const tag = isNew ? "YENİ" : `açık · ${weeksOpen}. hafta`;
          console.log(`  [${t.source.toUpperCase().padEnd(9)} · ${tag.padEnd(14)}] ${t.title}`);
          if (t.titleTr) console.log(`  ${" ".repeat(28)}TR: ${t.titleTr}`);
          console.log(`  ${" ".repeat(28)}${t.note}`);
          if (writeLedger) siteLedger[key] = { firstSeen: existing?.firstSeen ?? today, lastSeen: today, weeksOpen };
        }
      }
      if (ledgerPath && writeLedger) {
        mkdirSync(dirname(ledgerPath), { recursive: true });
        writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2) + "\n");
      }
      return;
    }
    // Clarity: token YALNIZCA ortam degiskeninden okunur. CLI argumani olarak asla kabul edilmez
    // (ps ciktisinda gorunur, shell gecmisine girer); reddedilirken degeri yankilanmaz.
    case "clarity-smoke":
    case "clarity-measure": {
      const cl = await import("./adapters/clarity.ts");
      if (args.some((a) => /^--?(clarity[-_]?)?tokens?\b/i.test(a))) {
        console.error(`Clarity token'i CLI argumani olarak kabul edilmez; ${cl.CLARITY_ENV} ortam degiskenini (GitHub Secret) kullan.`);
        process.exitCode = 1; return;
      }
      const reg = loadRegistry(args[1] && !args[1].startsWith("--") ? args[1] : "config/sites.yaml");
      if (!reg.ok || !reg.registry) { console.error(reg.errors.join("\n")); process.exitCode = 1; return; }
      const only = opt("site");
      const ids = reg.registry.sites.map((x) => x.id).filter((id) => !only || id === only);
      if (only && !ids.length) { console.error(`site bulunamadi: ${only}`); process.exitCode = 1; return; }
      const parsed = cl.parseClarityTokens(process.env[cl.CLARITY_ENV]);
      if (cmd === "clarity-smoke") {
        // Cagri YAPMAZ: Microsoft proje basina gunde 10 istege izin veriyor; "smoke" ile "measure"
        // ayri ayri API'ye gitseydi her kosu 6 istek yakardi.
        console.log(`Clarity (offline kontrol — API cagrisi YOK):`);
        for (const id of ids) console.log(`${parsed.tokens.has(id) ? "TOKEN_PRESENT " : "NOT_CONNECTED"} ${id}`);
        const ignored = [...parsed.tokens.keys()].filter((k) => !reg.registry!.sites.some((x) => x.id === k));
        for (const p of parsed.problems) console.log(`SORUN ${p}`);
        if (ignored.length) console.log(`UYARI registry'de olmayan site kimligi (kullanilmaz): ${ignored.join(", ")}`);
        const withToken = ids.filter((id) => parsed.tokens.has(id)).length;
        console.log(`butce: ${cl.PROFILE_REQUESTS_PER_SITE} istek/site/kosu (en fazla ${cl.MAX_HTTP_ATTEMPTS_PER_SITE} HTTP denemesi), resmi limit ${cl.OFFICIAL_DAILY_LIMIT_PER_PROJECT}/proje/gun; ${withToken} site token'li`);
        if (parsed.problems.length) process.exitCode = 1;
        return;
      }
      const { results, ignoredTokenSites } = await cl.measureSites(ids, parsed.tokens);
      console.log("Clarity:");
      for (const r of results) console.log(cl.summaryLine(r));
      for (const p of parsed.problems) console.log(`SORUN ${p}`);
      const outDir = opt("out", "clarity-out");
      mkdirSync(outDir, { recursive: true });
      for (const r of results) { cl.assertResultSite(r, r.site_id); writeFileSync(join(outDir, `clarity-${r.site_id}.json`), JSON.stringify(r, null, 2) + "\n"); }
      writeFileSync(join(outDir, "clarity-summary.md"), cl.resultsToMarkdown(results, ignoredTokenSites));
      // ERROR / PARTIAL gorunur kalsin (is kirmizi); NOT_CONNECTED degildir.
      if (results.some((r) => r.measurement_state === "ERROR" || r.measurement_state === "PARTIAL") || parsed.problems.length) process.exitCode = 1;
      return;
    }
    // Brain: bulut akil yuruten katman. Anahtar YALNIZCA ortam degiskeninden okunur; CLI argumani olarak
    // asla kabul edilmez ve reddedilirken degeri yankilanmaz.
    case "brain-evidence":
    case "brain-handoff":
    case "brain-validate":
    case "brain-run": {
      const br = await import("./brain/index.ts");
      if (args.some((a) => /^--?(api[-_]?)?(key|token|secret|anthropic[-_]?key)\b/i.test(a))) {
        console.error(`Anahtar CLI argumani olarak kabul edilmez; ${br.ANTHROPIC_KEY_ENV} ortam degiskenini (GitHub Secret) kullan.`);
        process.exitCode = 1; return;
      }
      const siteId = opt("site");
      if (!siteId) { console.error("--site zorunlu"); process.exitCode = 1; return; }
      const reg = loadRegistry(args[1] && !args[1].startsWith("--") ? args[1] : "config/sites.yaml");
      if (!reg.ok || !reg.registry) { console.error(reg.errors.join("\n")); process.exitCode = 1; return; }
      const site = reg.registry.sites.find((x) => x.id === siteId);
      if (!site) { console.error(`site bulunamadi: ${siteId}`); process.exitCode = 1; return; }
      // Tavsiye yalniz onboard edilmis site icin (policies/portfolio-isolation.md).
      if (!onboardedSites(reg.registry).some((x) => x.id === siteId)) { console.error(`site "${siteId}" onboard edilmemis (${site.onboarding_status}): Brain yalniz onboard edilmis site icin calisir`); process.exitCode = 1; return; }
      const nowIso = new Date().toISOString();

      if (cmd === "brain-evidence") {
        const clarityPath = opt("clarity");
        const items = [br.evidenceFromRegistry(site, nowIso)];
        if (clarityPath) {
          const c = JSON.parse(readFileSync(clarityPath, "utf8"));
          if (c.site_id !== siteId) { console.error(`SITE IZOLASYONU: ${clarityPath} baska bir siteye ait (${String(c.site_id)} != ${siteId}); kanit paketine ALINMADI`); process.exitCode = 1; return; }
          items.push(br.evidenceFromClarity(c));
        }
        const out = opt("out", `brain-evidence-${siteId}.json`);
        mkdirSync(dirname(out), { recursive: true });
        writeFileSync(out, JSON.stringify({ schema: br.EVIDENCE_BUNDLE_SCHEMA, site_id: siteId, evidence: items }, null, 2) + "\n");
        console.log(`Brain kanit paketi: ${items.length} kayit -> ${out}`);
        return;
      }

      if (cmd === "brain-handoff") {
        // Ag YOK: workflow GitHub'dan dosyalari indirir, bu komut onlari dogrular. Model cagrisi yok.
        const out = opt("out", "handoff-out");
        mkdirSync(out, { recursive: true });
        const res = br.runHandoff({
          siteId, site, runId: opt("run-id") ?? "", repo: opt("repo") ?? "", artifactDir: opt("artifact-dir", "handoff-work/artifact"),
          runMetaPath: opt("run-meta", "handoff-work/run.json"), artifactsMetaPath: opt("artifacts-meta", "handoff-work/artifacts.json"), handoffRunId: opt("handoff-run-id"),
        });
        const { bundle, provenance, ...status } = res;
        writeFileSync(join(out, "handoff-status.json"), JSON.stringify(status, null, 2) + "\n");
        if (bundle && provenance) {
          writeFileSync(join(out, "evidence.json"), JSON.stringify(bundle, null, 2) + "\n");
          writeFileSync(join(out, "provenance.json"), JSON.stringify(provenance, null, 2) + "\n");
        }
        console.log(`HANDOFF ${res.state} ${res.code ?? "-"} site=${siteId} run=${res.source_run_id}${res.detail.length ? ` detail=${res.detail.join(",")}` : ""}`);
        if (res.state === "OK" && res.usable === false) console.log("KANIT KULLANILAMAZ: Clarity olcumu MEASURED/PARTIAL degil — pakette sayi yok, hicbir uzman cagrilmaz");
        if (res.state !== "OK") process.exitCode = 1;
        return;
      }

      const cfg = br.loadAnthropicConfig();
      const secrets = cfg.state === "CONFIGURED" ? [cfg.apiKey] : [];
      const evPath = opt("evidence");
      let raw: unknown = { schema: br.EVIDENCE_BUNDLE_SCHEMA, site_id: siteId, evidence: [] };
      if (evPath) {
        try { raw = JSON.parse(readFileSync(evPath, "utf8")); } catch { console.error("kanit dosyasi okunamadi ya da JSON degil"); process.exitCode = 1; return; }
      }
      // Sitenin KENDI registry gercegi baglam olarak eklenir (paket zaten REGISTRY tasimiyorsa).
      const list: unknown[] = Array.isArray(raw) ? raw : ((raw as { evidence?: unknown[] }).evidence ?? []);
      const withReg = list.some((e) => (e as { source?: string })?.source === "REGISTRY") ? list : [br.evidenceFromRegistry(site, nowIso), ...list];
      const parsed = br.parseEvidenceBundle({ schema: br.EVIDENCE_BUNDLE_SCHEMA, site_id: siteId, evidence: withReg }, siteId, { secrets });
      const profiles = br.loadAgentProfiles("agents");

      if (cmd === "brain-validate") {
        // Workflow anahtari/modeli HIC gecmez; orada "YOK" yazmak yaniltici olurdu, o yuzden rapor kapatilabilir.
        if (flag("no-config-report")) console.log(`Brain (offline — API cagrisi YOK): ${profiles.size} ajan profili yuklendi`);
        else console.log(`Brain (offline — API cagrisi YOK): ${profiles.size} ajan profili yuklendi, ${br.ANTHROPIC_KEY_ENV}: ${cfg.state === "CONFIGURED" ? "VAR" : "YOK"}, ${br.ANTHROPIC_MODEL_ENV}: ${cfg.state === "CONFIGURED" ? "VAR" : (cfg.missing.includes(br.ANTHROPIC_MODEL_ENV) ? "YOK" : "VAR")}`);
        if (!parsed.ok || !parsed.bundle) { console.log(`KANIT REDDEDILDI: ${parsed.errors.join(", ")}`); process.exitCode = 1; return; }
        console.log(`kanit: ${parsed.bundle.evidence.length} kayit, ${parsed.evidence_bytes} bayt (sinir ${br.MAX_EVIDENCE_BYTES_PER_RUN}); sikistirilan: ${parsed.compaction.length}`);
        for (const c of br.routeAgents(parsed.bundle.evidence).considered) console.log(`${c.decision.padEnd(14)} ${c.agent_id} — ${c.reason}`);
        return;
      }

      const run = !parsed.ok || !parsed.bundle
        ? br.evidenceRejectedRun(siteId, parsed.errors)
        : await br.runBrain({ siteId, site, bundle: parsed.bundle, evidenceBytes: parsed.evidence_bytes, config: cfg, profiles });
      console.log(`Brain ${run.site_id}: ${run.status}${run.status_reason ? ` (${run.status_reason})` : ""} — API ${run.cost_guard.calls_used}/${run.cost_guard.max_calls}, ${run.findings.length} bulgu`);
      const outDir = opt("out", "brain-out");
      mkdirSync(outDir, { recursive: true });
      writeFileSync(join(outDir, `brain-run-${siteId}.json`), JSON.stringify(run, null, 2) + "\n");
      writeFileSync(join(outDir, `brain-report-${siteId}.md`), br.brainRunToMarkdown(run));
      const mem = br.memoryEntriesFromRun(run);
      // Bellek ADAYLARI artifact klasorune yazilir (kalici degil). Kalici yazim yalniz acik --write-memory ile.
      writeFileSync(join(outDir, `memory-candidates-${siteId}.jsonl`), mem.map((m) => JSON.stringify(m)).join("\n") + (mem.length ? "\n" : ""));
      if (flag("write-memory")) for (const m of mem) br.appendMemory(".", m, { write: true });
      if (run.status === "ERROR" || run.status === "PARTIAL") process.exitCode = 1;   // NOT_CONFIGURED yesil kalir (kimlik yok != hata)
      return;
    }
    // Snapshot importu: yerel DIZIN okur, ag ve token gerektirmez. Dizinin nereden
    // geldigi (git clone, artifact, elle kopya) bu komutun bilgisi degildir.
    case "import-health": {
      const { importSnapshot, importReportToMarkdown, mergeRecords, readSiteStore, writeSiteStore } = await import("./adapters/site-health-import.ts");
      const dir = args[1];
      if (!dir || dir.startsWith("--")) { console.error("kullanim: import-health <snapshotDir> [--registry path] [--site id] [--write]"); process.exitCode = 1; return; }
      if (!existsSync(dir)) { console.error(`snapshot dizini yok: ${dir}`); process.exitCode = 1; return; }
      const reg = loadRegistry(opt("registry", "config/sites.yaml"));
      if (!reg.ok || !reg.registry) { console.error(reg.errors.join("\n")); process.exitCode = 1; return; }
      const only = opt("site");
      if (only && !reg.registry.sites.some((x) => x.id === only)) { console.error(`site bulunamadi: ${only}`); process.exitCode = 1; return; }
      const res = importSnapshot(dir, reg.registry, only);
      const merges: Record<string, ReturnType<typeof mergeRecords>> = {};
      for (const [site, recs] of Object.entries(res.bySite)) {
        const m = mergeRecords(readSiteStore(".", site), recs);
        merges[site] = m;
        if (flag("write")) writeSiteStore(".", site, m.merged);
      }
      console.log(importReportToMarkdown(res, merges));
      if (!flag("write")) console.log("(--write verilmedi: hicbir dosya yazilmadi)");
      return;
    }
    // pamistanbul'a KILITLI, salt-okunur URL Inspection ORNEKLEMI. Tam coverage degildir.
    case "inspect-index": {
      const ip = await import("./index-probe.ts");
      const { searchConsole } = await import("./adapters/index.ts");
      const { periods } = await import("./measure.ts");
      const { buildInventory } = await import("./url-inventory.ts");
      const siteId = opt("site", ip.PROBE_SITE_ID);
      try { ip.assertProbeSite(siteId); } catch (e) { console.error((e as Error).message); process.exitCode = 1; return; }
      const regPath = args[1] && !args[1].startsWith("--") ? args[1] : "config/sites.yaml";
      const reg = loadRegistry(regPath);
      if (!reg.ok || !reg.registry) { console.error(reg.errors.join("\n")); process.exitCode = 1; return; }
      const site = reg.registry.sites.find((x) => x.id === siteId);
      if (!site) { console.error(`site bulunamadi: ${siteId}`); process.exitCode = 1; return; }
      if (site.onboarding_status === "registered_not_onboarded") { console.error(`${siteId} onboard edilmemis`); process.exitCode = 1; return; }
      const prop = String(site.google_search_console_property);
      const hasProp = !!prop && prop !== "NOT_CONNECTED" && prop !== "UNKNOWN";
      const connected = hasProp && searchConsole.status().state !== "NOT_CONNECTED";
      const today = new Date().toISOString().slice(0, 10);
      const dir = join("sites", siteId, "index-baseline");
      const ledgerFile = join(dir, "quota-ledger.json");
      let ledger: QuotaLedger = {};
      try { ledger = JSON.parse(readFileSync(ledgerFile, "utf8")); } catch { /* ilk calisma */ }
      const { limit, clampedFrom } = ip.resolveLimit(opt("limit") ? Number(opt("limit")) : undefined, ip.usedOn(ledger, today));
      if (clampedFrom !== undefined) console.error(`not: limit ${clampedFrom} -> ${limit} (sert tavan ${ip.HARD_LIMIT}/gun, bugun kullanilan ${ip.usedOn(ledger, today)})`);

      const strategy = opt("strategy", "gsc");
      if (strategy !== "gsc" && strategy !== "segmented") { console.error(`gecersiz --strategy: ${strategy} (gsc | segmented)`); process.exitCode = 1; return; }
      if (strategy === "segmented" && opt("urls")) { console.error("--strategy segmented ile --urls birlikte kullanilamaz"); process.exitCode = 1; return; }

      let urls: string[] = []; let source = "yok";
      const urlsFile = opt("urls");
      let candidates: { url: string; segment: import("./index-candidates.ts").Segment }[] | undefined;
      let segmentInfo: import("./index-probe.ts").SegmentInfo | undefined;
      let preSkipped: { url: string; reason: string }[] = [];
      let universeNotes: string[] = [];
      try {
        if (strategy === "gsc") {
          if (urlsFile) {
            urls = readFileSync(urlsFile, "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
            source = `dosya: ${urlsFile}`;
          } else if (connected) {
            const rows = await searchConsole.searchAnalytics(prop, periods(new Date()).current, ["page"]);
            urls = (rows ?? []).filter((r) => r.page).sort((a, b) => b.impressions - a.impressions).map((r) => r.page as string);
            source = "GSC sayfa listesi, son 28 gün, gösterime göre";
          }
        } else {
          const ic = await import("./index-candidates.ts");
          const { readSitemapUniverse, defaultFetchText } = await import("./sitemap-universe.ts");
          source = "sitemap + GSC sayfa listesi (son 28 gün), segmentli";
          let gsc: import("./index-candidates.ts").UrlSource = { state: "UNKNOWN", reason: "kimlik yok" };
          let sitemap: import("./index-candidates.ts").UrlSource = { state: "UNKNOWN", reason: "kimlik yok; ag cagrisi yapilmadi" };
          if (connected) {
            try {
              const rows = await searchConsole.searchAnalytics(prop, periods(new Date()).current, ["page"]);
              gsc = rows === null ? { state: "UNKNOWN", reason: "GSC yaniti yok" } : { state: "MEASURED", urls: rows.filter((r) => r.page).map((r) => r.page as string) };
            } catch (e) { gsc = { state: "UNKNOWN", reason: (e as Error).message.slice(0, 160) }; }
            // GSC okunamadiysa sitemap'i cekmenin anlami yok: hicbir segment hesaplanmayacak.
            if (gsc.state === "MEASURED") {
              const u = await readSitemapUniverse({
                locations: site.sitemap_locations, robotsUrl: `https://${site.canonical_hostname}/robots.txt`,
                productionDomain: site.production_domain, fetchText: defaultFetchText(),
              });
              universeNotes = u.notes;
              sitemap = u.state === "MEASURED" ? { state: "MEASURED", urls: u.urls } : { state: "UNKNOWN", reason: u.reason };
            } else sitemap = { state: "UNKNOWN", reason: "GSC okunamadigi icin cekilmedi" };
          }
          const built = ic.segmentCandidates({ sitemap, gsc, canonicalOrigin: `https://${site.canonical_hostname}`, productionDomain: site.production_domain });
          const sel = ic.selectSegmented({ pools: built.pools, limit, dayIndex: Math.floor(Date.now() / 86_400_000) });
          candidates = sel.order; segmentInfo = { segments: sel.segments, day_index: sel.day_index }; preSkipped = built.rejected;
          if (connected && gsc.state === "UNKNOWN") { console.error(`segmentli aday uretilemedi: ${gsc.reason}`); process.exitCode = 1; }
        }
      } catch (e) { console.error(`aday URL listesi alinamadi: ${(e as Error).message}`); process.exitCode = 1; return; }

      const probe = await ip.runProbe({
        site, urls, candidates, segmentInfo, skippedInput: preSkipped, candidateSource: source, limit, connected,
        delayMs: opt("delay") ? Number(opt("delay")) : ip.DEFAULT_DELAY_MS,
        inspect: (u) => searchConsole.urlInspection(prop, u),
      });
      let sitemaps: ReturnType<typeof ip.summarizeSitemaps> | { state: "ERROR"; error: string } = ip.summarizeSitemaps(null);
      if (connected) { try { sitemaps = ip.summarizeSitemaps(await searchConsole.sitemaps(prop)); } catch (e) { sitemaps = { state: "ERROR", error: (e as Error).message.slice(0, 160) }; } }

      const md = ip.probeToMarkdown(probe, sitemaps, today);
      console.log(md);
      if (flag("write")) {
        mkdirSync(dir, { recursive: true });
        const inventory = buildInventory({ site: siteId, sitemapEntries: null, inspections: Object.fromEntries(probe.results.map((r) => [r.url, r.summary])) });
        writeFileSync(join(dir, `${today}-index-probe.json`), JSON.stringify({ probe, sitemaps, url_inventory: inventory.records, ...(strategy === "segmented" ? { sitemap_universe_notes: universeNotes } : {}) }, null, 2) + "\n");
        writeFileSync(join(dir, `${today}-index-probe.md`), md);
        writeFileSync(ledgerFile, JSON.stringify(ip.recordUsage(ledger, today, probe.attempted), null, 2) + "\n");
      }
      if (probe.stopped === "rate_limited_429" || probe.stopped === "forbidden_403" || probe.stopped === "consecutive_errors") process.exitCode = 1;
      return;
    }
    // Salt-okunur duman testi. "Env dolu" ile "API cevap veriyor" ayri
    // seylerdir; servis hesabi property'ye eklenmemisse tek gorunen sey
    // budur ve sessizce sifir trafik gibi okunmamalidir.
    case "smoke": {
      const gscC = await import("./adapters/gsc.ts");
      const ga4C = await import("./adapters/ga4.ts");
      const reg = loadRegistry(args[1] ?? "config/sites.yaml");
      if (!reg.ok || !reg.registry) { console.error(reg.errors.join("\n")); process.exitCode = 1; return; }
      let bad = 0;
      for (const site of reg.registry.sites) {
        const prop = String(site.google_search_console_property);
        const ga = String(site.ga4_property);
        if (prop && prop !== "NOT_CONNECTED" && prop !== "UNKNOWN") {
          const r = await gscC.smokeTest(prop);
          console.log(`${r.ok ? "OK  " : "FAIL"} GSC ${site.id} ${prop} — ${r.reason}`);
          if (!r.ok) bad++;
        }
        if (ga && ga !== "NOT_CONNECTED" && ga !== "UNKNOWN") {
          const r = await ga4C.smokeTest(ga);
          console.log(`${r.ok ? "OK  " : "FAIL"} GA4 ${site.id} ${ga} — ${r.reason}`);
          if (!r.ok) bad++;
        }
      }
      if (bad) process.exitCode = 1;
      return;
    }
    default:
      console.error("commands: crawl | audit | compliance | registry | integrations | measure | detail | topics | smoke | portfolio | llmstxt | import-health | inspect-index | clarity-smoke | clarity-measure | brain-evidence | brain-handoff | brain-validate | brain-run");
      process.exitCode = 1;
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
