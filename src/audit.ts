// Deterministic audit checks over a CrawlResult. Each check emits Findings with
// evidence. Severity = expected business/search impact, not warning count.
// Everything here is FACT (measured) or INFERENCE (rule over facts); no HYPOTHESIS
// is produced by code — that is agent work with human review.
import type { CrawlResult, CrawlRecord, Finding, Severity } from "./types.ts";
import { isAllowed } from "./robots.ts";

type Check = (r: CrawlResult) => Finding[];

// A directly measured defect is CONFIRMED; anything a heuristic inferred is a
// CANDIDATE until someone looks. The default follows the evidence label, so a check
// cannot accidentally ship an inference as settled fact.
const f = (id: string, severity: Severity, message: string, evidence: Record<string, unknown>, businessImpact: string, extra: Partial<Finding> = {}): Finding => {
  const label = extra.label ?? "FACT";
  return { id, severity, confidence: extra.confidence ?? (label === "FACT" ? "CONFIRMED" : "CANDIDATE"), label, message, evidence, businessImpact, ...extra };
};

const htmlOk = (r: CrawlRecord) => r.html && r.page.status === 200;
const norm = (u: string) => { try { const x = new URL(u); x.hash = ""; return x.toString().replace(/\/$/, ""); } catch { return u; } };

/** True when the page declares a canonical pointing at a DIFFERENT URL — i.e. the page is
 *  a variant (?category=tote, ?type=calculator) whose indexing signals belong to that other
 *  URL. Google consolidates such variants, so counting them as separate pages invents
 *  duplicates that do not exist. */
const isVariant = (x: CrawlRecord) => !!x.html!.canonical && norm(x.html!.canonical) !== norm(x.page.finalUrl);

/** The URL set a duplicate-signal check may reason about: canonical pages only, and each
 *  final URL once. Two request URLs can resolve to one final URL (a sitemap entry and a
 *  redirect landing on it), which is normal crawling and not a duplicate page. Measured
 *  on the live portfolio, skipping this step invented 9 duplicate-title and 7
 *  duplicate-text findings against sites that had neither. */
const canonicalPages = (r: { records: CrawlRecord[] }) => {
  const byUrl = new Map<string, CrawlRecord>();
  for (const x of r.records.filter(htmlOk)) if (!isVariant(x)) byUrl.set(norm(x.page.finalUrl), x);
  return [...byUrl.values()];
};

export const checks: Record<string, Check> = {
  "http.errors": (r) => r.records.filter((x) => x.page.status >= 400 || x.page.status === 0).map((x) =>
    f("http.error", x.page.status >= 500 || x.page.status === 0 ? "high" : "medium",
      `${x.page.status || "FETCH_FAIL"} for ${x.page.url}`,
      { status: x.page.status, error: x.page.error, discoveredFrom: x.discoveredFrom },
      "Internally linked URL that fails: wasted crawl budget, lost link equity, poor UX.",
      { url: x.page.url, fixHint: "Fix or remove the internal link; 301 if the page moved." })),

  "http.redirect_chains": (r) => r.records.filter((x) => x.page.redirectChain.length >= 2).map((x) =>
    f("http.redirect_chain", "medium", `${x.page.redirectChain.length}-hop redirect chain from ${x.page.url}`,
      { chain: x.page.redirectChain, finalUrl: x.page.finalUrl },
      "Each hop costs crawl time and can dilute signals; Google follows up to 10 but chains delay indexing.",
      { url: x.page.url, fixHint: "Point the internal link and the first redirect straight at the final URL." })),

  "http.internal_redirects": (r) => r.records.filter((x) => x.page.redirectChain.length === 1 && x.discoveredFrom).map((x) =>
    f("http.internal_link_redirects", "low", `Internal link to ${x.page.url} redirects to ${x.page.finalUrl}`,
      { from: x.discoveredFrom, chain: x.page.redirectChain },
      "Avoidable redirect on an internal link.", { url: x.page.url })),

  "indexability.noindex": (r) => r.records.filter(htmlOk).flatMap((x) => {
    const directives = [...x.html!.metaRobots, ...x.html!.metaGooglebot, ...x.xRobots];
    if (!directives.includes("noindex") && !directives.includes("none")) return [];
    const inSitemap = r.sitemapEntries.map(norm).includes(norm(x.page.finalUrl));
    const isStart = x.depth === 0;
    return [f("indexability.noindex", inSitemap || isStart ? "critical" : "medium",
      `${x.page.finalUrl} is noindex (${inSitemap ? "but listed in sitemap" : isStart ? "start page!" : "not in sitemap"})`,
      { metaRobots: x.html!.metaRobots, metaGooglebot: x.html!.metaGooglebot, xRobotsTag: x.xRobots, inSitemap },
      inSitemap || isStart ? "Likely ACCIDENTAL noindex on a page you want indexed: page will drop from Search." : "Deliberate noindex needs no action; verify intent.",
      { url: x.page.finalUrl, label: inSitemap || isStart ? "INFERENCE" : "FACT", fixHint: "Confirm intent. If accidental, remove the directive and request re-indexing via Search Console URL Inspection (NOT the Indexing API).", policyRef: "policies/compliance.md#indexing-api" })];
  }),

  "indexability.conflicting_signals": (r) => r.records.filter(htmlOk).flatMap((x) => {
    const out: Finding[] = [];
    const noindex = [...x.html!.metaRobots, ...x.xRobots].includes("noindex");
    if (noindex && x.html!.canonical && norm(x.html!.canonical) !== norm(x.page.finalUrl))
      out.push(f("indexability.noindex_plus_canonical", "medium", `${x.page.finalUrl}: noindex AND canonical to another URL`,
        { canonical: x.html!.canonical }, "Mixed signals: Google may ignore the canonical hint. Pick one mechanism.", { url: x.page.finalUrl }));
    if (x.html!.canonicalCount > 1)
      out.push(f("indexability.multiple_canonicals", "high", `${x.page.finalUrl} declares ${x.html!.canonicalCount} canonical tags`,
        { count: x.html!.canonicalCount }, "Google ignores all canonicals when multiple conflict; canonical selection becomes unpredictable.", { url: x.page.finalUrl }));
    return out;
  }),

  "canonical.broken": (r) => {
    const statusByUrl = new Map(r.records.map((x) => [norm(x.page.finalUrl), x.page.status]));
    return r.records.filter(htmlOk).flatMap((x) => {
      const c = x.html!.canonical;
      if (!c) return [f("canonical.missing", "low", `${x.page.finalUrl} has no canonical tag`, {}, "Not an error; self-referencing canonical guards against parameter/duplicate variants.", { url: x.page.finalUrl })];
      const out: Finding[] = [];
      let canonHost = ""; try { canonHost = new URL(c).host; } catch { out.push(f("canonical.invalid", "high", `${x.page.finalUrl} canonical is not a valid absolute URL`, { canonical: c }, "Invalid canonical is ignored; duplicates may be indexed.", { url: x.page.finalUrl })); return out; }
      if (canonHost !== new URL(x.page.finalUrl).host)
        out.push(f("canonical.cross_host", "high", `${x.page.finalUrl} canonicalizes to another host ${canonHost}`, { canonical: c }, "Cross-domain canonical hands indexing to another site; if unintended, this page will not rank.", { url: x.page.finalUrl, label: "INFERENCE" }));
      const target = statusByUrl.get(norm(c));
      if (target !== undefined && target !== 200)
        out.push(f("canonical.target_not_200", "high", `${x.page.finalUrl} canonical → ${c} returns ${target}`, { canonical: c, targetStatus: target }, "Canonical pointing at an error/redirect is ignored or mis-consolidates.", { url: x.page.finalUrl }));
      if (x.page.url !== x.page.finalUrl && norm(c) === norm(x.page.url))
        out.push(f("canonical.points_to_redirecting_url", "medium", `${x.page.finalUrl} canonical points back to the redirecting URL ${x.page.url}`, { canonical: c }, "Canonical/redirect loop: signals bounce between two URLs.", { url: x.page.finalUrl }));
      return out;
    });
  },

  "sitemap.consistency": (r) => {
    const out: Finding[] = [];
    if (r.sitemapEntries.length === 0)
      out.push(f("sitemap.none_found", "medium", "No sitemap entries found (robots.txt Sitemap: or /sitemap.xml)", { checked: r.sitemapUrls }, "Sitemaps are the cheapest way to tell crawlers what you consider canonical and fresh.", { fixHint: "Publish an XML sitemap of canonical, indexable 200 URLs and reference it in robots.txt." }));
    const crawledOk = new Set(r.records.filter((x) => x.page.status === 200).map((x) => norm(x.page.finalUrl)));
    const inSitemapNotCrawled = r.sitemapEntries.filter((e) => !crawledOk.has(norm(e)));
    if (r.sitemapEntries.length && inSitemapNotCrawled.length && r.records.length < r.options.maxPages)
      out.push(f("sitemap.orphan_candidates", "medium", `${inSitemapNotCrawled.length} sitemap URLs not reached by link crawl`, { sample: inSitemapNotCrawled.slice(0, 20) }, "Pages only discoverable via sitemap are weakly linked; internal links carry the ranking signal.", { label: "INFERENCE", fixHint: "Verify each is linked from a crawlable page; if a page is unlinked, decide whether it should exist." }));
    for (const x of r.records) {
      if (r.sitemapEntries.map(norm).includes(norm(x.page.url)) && (x.page.status !== 200 || x.page.redirectChain.length))
        out.push(f("sitemap.non_canonical_entry", "medium", `Sitemap lists ${x.page.url} which returns ${x.page.status}${x.page.redirectChain.length ? " via redirect" : ""}`, { status: x.page.status, finalUrl: x.page.finalUrl }, "Sitemaps should only list final, 200, indexable URLs.", { url: x.page.url }));
    }
    return out;
  },

  "robots.access": (r) => {
    const out: Finding[] = [];
    if (!r.robots.fetched) out.push(f("robots.unreachable", "high", "robots.txt could not be fetched", { status: r.robots.status }, "A 5xx robots.txt makes Google stop crawling the site entirely.", { fixHint: "Serve a 200 (or 404) robots.txt." }));
    for (const a of r.crawlerAccess) if (a.rootAllowed === false)
      out.push(f("robots.crawler_blocked", a.token === "Googlebot" || a.token === "Bingbot" ? "critical" : "medium", `${a.token} is disallowed at root`, { token: a.token, purpose: a.purpose }, `Blocking ${a.token}: ${a.purpose}. Confirm this is a deliberate policy decision.`, { policyRef: "policies/compliance.md#crawler-access" }));
    const blockedInternal = r.skippedByRobots.length;
    if (blockedInternal) out.push(f("robots.internal_links_blocked", "low", `${blockedInternal} internally linked URLs disallowed for this crawler token`, { sample: r.skippedByRobots.slice(0, 10) }, "May be intentional (admin, search pages). Verify none are commercially important.", { label: "INFERENCE" }));
    if (r.robots.fetched && r.robots.status === 200) {
      const blockedAssets = r.robots.groups.filter((g) => g.agents.includes("*") || g.agents.includes("googlebot")).flatMap((g) => g.disallow).filter((d) => /\.(css|js)$|\/_next\/static|\/static\//.test(d));
      if (blockedAssets.length) out.push(f("robots.blocks_rendering_assets", "high", "robots.txt disallows CSS/JS paths", { rules: blockedAssets }, "Googlebot must fetch CSS/JS to render; blocking them can hide content and break mobile evaluation.", { fixHint: "Remove disallow rules for static assets." }));
    }
    // Sitemap URLs disallowed for Googlebot
    for (const e of r.sitemapEntries) if (r.robots.fetched && !isAllowed(r.robots, "Googlebot", e))
      out.push(f("robots.sitemap_url_disallowed", "high", `Sitemap URL ${e} is disallowed for Googlebot`, { url: e }, "Contradiction: you ask for indexing and forbid crawling.", { url: e }));
    return out;
  },

  "meta.titles": (r) => {
    const seen = new Map<string, string[]>();
    const out: Finding[] = [];
    for (const x of canonicalPages(r)) {
      const t = x.html!.title;
      if (!t) { out.push(f("meta.title_missing", "high", `${x.page.finalUrl} has no <title>`, {}, "Title is the primary snippet/ranking text signal.", { url: x.page.finalUrl })); continue; }
      if (t.length > 70) out.push(f("meta.title_long", "low", `${x.page.finalUrl} title is ${t.length} chars`, { title: t }, "Likely truncated in SERP; Google may rewrite it.", { url: x.page.finalUrl }));
      if (t.length < 15) out.push(f("meta.title_short", "low", `${x.page.finalUrl} title is ${t.length} chars`, { title: t }, "Too little context for users and rewriting.", { url: x.page.finalUrl }));
      seen.set(t, [...(seen.get(t) ?? []), x.page.finalUrl]);
      if (!x.html!.metaDescription) out.push(f("meta.description_missing", "low", `${x.page.finalUrl} has no meta description`, {}, "Google generates snippets anyway; a good description improves CTR on commercial pages.", { url: x.page.finalUrl }));
    }
    for (const [t, urls] of seen) if (urls.length > 1) out.push(f("meta.title_duplicate", "medium", `${urls.length} pages share the title "${t}"`, { urls }, "Duplicate titles signal duplicate/thin pages and confuse users in SERP.", { label: "INFERENCE" }));
    return out;
  },

  "content.headings": (r) => r.records.filter(htmlOk).flatMap((x) => {
    const h1 = x.html!.headings.filter((h) => h.level === 1);
    const out: Finding[] = [];
    if (h1.length === 0) out.push(f("content.h1_missing", "low", `${x.page.finalUrl} has no H1`, { headings: x.html!.headings.slice(0, 6) }, "Weak document outline; not a ranking factor but hurts clarity for users and retrieval.", { url: x.page.finalUrl }));
    if (h1.length > 1) out.push(f("content.h1_multiple", "info", `${x.page.finalUrl} has ${h1.length} H1s`, { h1: h1.map((h) => h.text) }, "Allowed by HTML5; check that the outline is intentional.", { url: x.page.finalUrl }));
    return out;
  }),

  "content.thin_or_js_only": (r) => r.records.filter(htmlOk).flatMap((x) => {
    const out: Finding[] = [];
    const noindex = [...x.html!.metaRobots, ...x.xRobots].includes("noindex");
    if (noindex) return out;
    if (x.html!.hasNoscriptOnly || (x.html!.wordCount < 30 && x.html!.externalScripts > 0))
      out.push(f("content.js_dependent", "high", `${x.page.finalUrl} has ~${x.html!.wordCount} words in server HTML`, { wordCount: x.html!.wordCount, externalScripts: x.html!.externalScripts, noscriptOnly: x.html!.hasNoscriptOnly }, "Content only exists after JS execution: Google renders but with delay; other crawlers (Bing, OAI-SearchBot) may see an empty page.", { url: x.page.finalUrl, label: "INFERENCE", fixHint: "Server-render primary content; verify with a rendered-DOM comparison before concluding." }));
    else if (x.html!.wordCount < 120)
      out.push(f("content.thin", "medium", `${x.page.finalUrl} has only ${x.html!.wordCount} words`, { wordCount: x.html!.wordCount, title: x.html!.title }, "Thin pages compete with your own stronger pages and are candidates for consolidation, not expansion with filler.", { url: x.page.finalUrl, label: "INFERENCE" }));
    return out;
  }),

  "content.near_duplicates": (r) => {
    const byHash = new Map<string, string[]>();
    for (const x of canonicalPages(r)) byHash.set(x.contentHash, [...(byHash.get(x.contentHash) ?? []), x.page.finalUrl]);
    return [...byHash.values()].filter((u) => u.length > 1).map((urls) =>
      f("content.duplicate_text", "medium", `${urls.length} URLs serve identical visible text`, { urls }, "Duplicate URLs split signals; only one should be canonical.", { label: "INFERENCE", fixHint: "Canonicalize or 301 the duplicates to one URL." }));
  },

  "content.hidden_text": (r) => r.records.filter(htmlOk).filter((x) => x.html!.hiddenTextSuspects.length).map((x) =>
    f("content.hidden_text_suspect", "high", `${x.page.finalUrl}: ${x.html!.hiddenTextSuspects.length} hidden block(s) contain text`, { samples: x.html!.hiddenTextSuspects.slice(0, 3) }, "Hidden text is a Google spam policy violation when used to manipulate ranking. Legitimate cases (accordions, a11y) must be verified.", { url: x.page.finalUrl, label: "INFERENCE", policyRef: "policies/compliance.md#hidden-text" })),

  "links.internal": (r) => {
    const out: Finding[] = [];
    const inbound = new Map<string, number>();
    for (const x of r.records) for (const l of x.html?.links ?? []) if (l.internal) inbound.set(norm(l.href), (inbound.get(norm(l.href)) ?? 0) + 1);
    for (const x of r.records.filter(htmlOk)) {
      if (x.depth >= 3) out.push(f("links.deep_page", "low", `${x.page.finalUrl} is ${x.depth} clicks from start`, { depth: x.depth }, "Deep pages get crawled less often and inherit less authority.", { url: x.page.finalUrl }));
      const empty = x.html!.links.filter((l) => l.internal && !l.text).length;
      if (empty > 3) out.push(f("links.empty_anchor_text", "low", `${x.page.finalUrl} has ${empty} internal links with no anchor text`, { count: empty }, "Anchor text tells crawlers and screen readers what the target is about.", { url: x.page.finalUrl }));
      const nofollowInternal = x.html!.links.filter((l) => l.internal && l.rel.includes("nofollow")).length;
      if (nofollowInternal) out.push(f("links.internal_nofollow", "low", `${x.page.finalUrl} nofollows ${nofollowInternal} internal links`, { count: nofollowInternal }, "Nofollow on internal links throws away crawl paths for no benefit.", { url: x.page.finalUrl }));
    }
    return out;
  },

  "media.images": (r) => r.records.filter(htmlOk).flatMap((x) => {
    const imgs = x.html!.images;
    const missingAlt = imgs.filter((i) => i.alt === null).length;
    const noDims = imgs.filter((i) => !i.width || !i.height).length;
    const out: Finding[] = [];
    if (missingAlt) out.push(f("media.alt_missing", "medium", `${x.page.finalUrl}: ${missingAlt}/${imgs.length} images lack an alt attribute`, { missingAlt, total: imgs.length }, "Images are first-class search assets for a photo/film studio; missing alt loses image search and accessibility.", { url: x.page.finalUrl, fixHint: "Describe the actual visual meaning; empty alt only for decorative images." }));
    if (noDims && imgs.length) out.push(f("media.dimensions_missing", "low", `${x.page.finalUrl}: ${noDims}/${imgs.length} images without width/height`, { noDims }, "Missing dimensions cause layout shift (CLS).", { url: x.page.finalUrl }));
    return out;
  }),

  "structured_data": (r) => r.records.filter(htmlOk).flatMap((x) => {
    const out: Finding[] = [];
    for (const b of x.html!.jsonLd) {
      if (b.parseError) out.push(f("schema.invalid_json", "medium", `${x.page.finalUrl}: JSON-LD parse error`, { error: b.parseError, raw: b.raw.slice(0, 200) }, "Invalid JSON-LD is ignored entirely.", { url: x.page.finalUrl }));
      if (b.types.includes("FAQPage")) out.push(f("schema.faqpage_present", "info", `${x.page.finalUrl} uses FAQPage`, { types: b.types }, "FAQ rich results are limited to authoritative government/health sites (Google, Aug 2023). Keep only if content is genuinely FAQ; never treat it as a rich-result objective.", { url: x.page.finalUrl, policyRef: "policies/compliance.md#faq-schema" }));
      // Semantic consistency: schema name/headline should appear in visible text.
      const p = b.parsed as Record<string, unknown> | null;
      const name = p && typeof p["name"] === "string" ? (p["name"] as string) : p && typeof p["headline"] === "string" ? (p["headline"] as string) : null;
      // A schema `name` is normally the page title, which legitimately carries a brand
      // suffix ("Alpet · Kurumsal Çekim | PAM İstanbul") that never appears verbatim in
      // body copy. Comparing the whole string flagged 95 innocent pages on a real site.
      // Compare the SUBJECT instead: drop the brand suffix and the qualifier, then ask
      // whether any distinctive word of it appears on the page at all.
      // ...and only for types that MARK UP THE PAGE'S CONTENT. Google's "don't mark up
      // content that is not visible" rule governs those. It does not govern the entity
      // graph: an Organization, its founder Person, the WebSite node or a BreadcrumbList
      // describe the publisher and are correct on every page whether or not that page
      // names them. Measured on a live 804-page site, treating the founder's Person node
      // as an unmet page subject produced 842 high findings against correct markup — and
      // "remove it" would have been the exact wrong fix, since that node is what ties the
      // brand to a named human for entity resolution.
      const CONTENT_TYPES = new Set(["Product", "Review", "Recipe", "Event", "Course", "JobPosting", "SoftwareApplication", "Book", "Movie", "Article", "NewsArticle", "BlogPosting", "HowTo", "VideoObject", "Offer", "Service"]);
      if (name && b.types.some((t) => CONTENT_TYPES.has(t))) {
        const subject = name.split("|")[0].split("·")[0].split("—")[0].trim();
        const tokens = subject.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 4);
        const text = x.html!.textContent.toLowerCase();
        const absent = tokens.length > 0 && !tokens.some((t) => text.includes(t));
        if (absent)
          out.push(f("schema.not_in_visible_content", "high", `${x.page.finalUrl}: schema subject "${subject}" appears nowhere in the visible text`, { name, subject, checkedTokens: tokens, types: b.types }, "Structured data must represent visible content; a subject the page never mentions is a misleading-schema risk.", { url: x.page.finalUrl, label: "INFERENCE", policyRef: "policies/compliance.md#structured-data" }));
      }
      const rating = JSON.stringify(b.parsed ?? {}).includes('"aggregateRating"');
      if (rating && !/\b(review|değerlendirme|yorum|rating|puan)\b/i.test(x.html!.textContent))
        out.push(f("schema.rating_without_visible_reviews", "high", `${x.page.finalUrl}: aggregateRating without visible reviews`, { types: b.types }, "Self-serving or invisible ratings violate Google's review snippet guidelines.", { url: x.page.finalUrl, label: "INFERENCE", policyRef: "policies/compliance.md#structured-data" }));
    }
    return out;
  }),

  "i18n.hreflang": (r) => r.records.filter(htmlOk).flatMap((x) => {
    const h = x.html!.hreflang;
    if (!h.length) return [];
    const out: Finding[] = [];
    // hreflang is read on the CANONICAL URL, so the set is judged there and not on
    // whichever variant the crawler happened to fetch. A parameter variant is not a member
    // of the set and must not list itself — on two live bilingual sites that single
    // confusion produced 256 "missing self-reference" findings against correct markup.
    if (isVariant(x)) return out;   // the canonical target is crawled on its own and carries the verdict
    const self = h.some((e) => norm(e.href) === norm(x.page.finalUrl));
    if (!self) out.push(f("i18n.hreflang_no_self", "medium", `${x.page.finalUrl} hreflang set lacks a self-reference`, { hreflang: h }, "Google requires each page in the set to list itself; otherwise the annotations are ignored.", { url: x.page.finalUrl }));
    if (!h.some((e) => e.lang.toLowerCase() === "x-default")) out.push(f("i18n.hreflang_no_xdefault", "low", `${x.page.finalUrl} hreflang has no x-default`, {}, "x-default governs unmatched locales; optional but recommended.", { url: x.page.finalUrl }));
    return out;
  }),

  "mobile.viewport": (r) => r.records.filter(htmlOk).filter((x) => !x.html!.viewport).map((x) =>
    f("mobile.viewport_missing", "medium", `${x.page.finalUrl} has no viewport meta`, {}, "Mobile-first indexing: pages without a viewport render as desktop on phones.", { url: x.page.finalUrl })),

  "performance.weight": (r) => r.records.filter((x) => x.page.status === 200 && x.page.bytes > 300_000).map((x) =>
    f("performance.html_weight", "low", `${x.page.finalUrl} HTML is ${Math.round(x.page.bytes / 1024)} KB`, { bytes: x.page.bytes, fetchMs: x.page.fetchMs }, "Heavy HTML delays LCP; Core Web Vitals need field data (CrUX/GSC) for a real verdict — this is a lab hint only.", { url: x.page.finalUrl, label: "INFERENCE" })),

  // A title is never enough on its own: "404 Magni" is the name of a real photographic
  // series, and matching the bare token flagged two fully-built portfolio pages as soft
  // 404s. A genuine soft 404 is a near-empty page, so the body has to corroborate the
  // title before anything is reported.
  "soft404": (r) => r.records.filter(htmlOk).filter((x) =>
    (/\b(404|not found|sayfa bulunamadı|bulunamadı)\b/i.test(x.html!.title ?? "") && x.html!.wordCount < 150)
    || (x.html!.wordCount < 40 && /\b(not found|bulunamadı)\b/i.test(x.html!.textContent))).map((x) =>
    f("indexability.soft_404", "medium", `${x.page.finalUrl} looks like a 404 page but returns 200`, { title: x.html!.title }, "Soft 404s waste crawl budget and can be indexed as junk.", { url: x.page.finalUrl, label: "INFERENCE", fixHint: "Return a real 404/410 status." })),
};

export function runAudit(result: CrawlResult, only?: string[]): Finding[] {
  const findings: Finding[] = [];
  for (const [name, check] of Object.entries(checks)) {
    if (only && !only.includes(name)) continue;
    try { findings.push(...check(result)); }
    catch (e) { findings.push(f("engine.check_failed", "info", `check ${name} threw`, { error: String(e) }, "Engine defect; result for this check is unknown, not clean.")); }
  }
  const order: Severity[] = ["critical", "high", "medium", "low", "info"];
  return findings.sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity));
}
