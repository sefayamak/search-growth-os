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
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { crawl } from "./crawler.ts";
import { assessPortfolio, cadenceToMarkdown } from "./cadence.ts";
import { inspectPortfolio, llmsTxtToMarkdown } from "./llmstxt.ts";
import { runAudit } from "./audit.ts";
import { buildReport, reportToMarkdown } from "./report.ts";
import { checkCompliance, kindFromPath } from "./compliance.ts";
import { loadRegistry, onboardedSites } from "./registry.ts";
import { allStatuses } from "./adapters/index.ts";

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
      console.error("commands: crawl | audit | compliance | registry | integrations | measure | detail | smoke | portfolio | llmstxt");
      process.exitCode = 1;
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
