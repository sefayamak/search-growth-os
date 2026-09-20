// Read-only, polite, same-host crawler. GET only, identifies itself honestly,
// obeys robots.txt for its own token, fixed delay, hard page cap.
// It never POSTs, never submits forms, never follows off-host links.
import { createHash } from "node:crypto";
import { parseHtml, absolutize } from "./html.ts";
import { parseRobots, isAllowed, crawlerAccess } from "./robots.ts";
import { parseSitemap } from "./sitemap.ts";
import type { CrawlOptions, CrawlResult, CrawlRecord, FetchedPage } from "./types.ts";

export const DEFAULT_OPTIONS: Omit<CrawlOptions, "startUrl"> = {
  fromSitemap: false, maxPages: 50, maxDepth: 3, delayMs: 500, timeoutMs: 15000,
  userAgent: process.env.SEARCH_GROWTH_USER_AGENT ?? "SearchGrowthOS/0.1 (+https://pamistanbul.com; read-only site audit)",
  respectRobots: true, sameHostOnly: true,
};
export const ROBOTS_TOKEN = "SearchGrowthOS";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function fetchPage(url: string, opts: Pick<CrawlOptions, "userAgent" | "timeoutMs">): Promise<FetchedPage> {
  const chain: FetchedPage["redirectChain"] = [];
  let current = url;
  const t0 = performance.now();
  for (let hop = 0; hop < 10; hop++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs);
    try {
      const res = await fetch(current, {
        redirect: "manual", signal: ctrl.signal,
        headers: { "user-agent": opts.userAgent, accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.5" },
      });
      const headers: Record<string, string> = {};
      res.headers.forEach((v, k) => { headers[k] = v; });
      if (res.status >= 300 && res.status < 400 && headers.location) {
        chain.push({ url: current, status: res.status });
        const next = absolutize(headers.location, current);
        if (!next) break;
        current = next;
        continue;
      }
      const contentType = headers["content-type"] ?? "";
      const isText = /text\/|xml|json/.test(contentType);
      const buf = new Uint8Array(await res.arrayBuffer());
      const body = isText ? new TextDecoder().decode(buf) : "";
      return { url, finalUrl: current, status: res.status, redirectChain: chain, headers, contentType, body, bytes: buf.byteLength, fetchMs: Math.round(performance.now() - t0) };
    } catch (e) {
      return { url, finalUrl: current, status: 0, redirectChain: chain, headers: {}, contentType: "", body: "", bytes: 0, fetchMs: Math.round(performance.now() - t0), error: String((e as Error).message ?? e) };
    } finally { clearTimeout(timer); }
  }
  return { url, finalUrl: current, status: 0, redirectChain: chain, headers: {}, contentType: "", body: "", bytes: 0, fetchMs: Math.round(performance.now() - t0), error: "redirect loop or too many hops" };
}

export async function crawl(partial: Partial<CrawlOptions> & { startUrl: string }, log: (s: string) => void = () => {}): Promise<CrawlResult> {
  const options: CrawlOptions = { ...DEFAULT_OPTIONS, ...partial };
  const start = new URL(options.startUrl);
  const origin = start.origin;
  const startedAt = new Date().toISOString();

  const robotsPage = await fetchPage(`${origin}/robots.txt`, options);
  const robots = parseRobots(robotsPage.status === 200 ? robotsPage.body : "", robotsPage.status, !robotsPage.error);
  log(`robots.txt ${robotsPage.status} groups=${robots.groups.length} sitemaps=${robots.sitemaps.length}`);

  // Sitemaps: declared ones plus the conventional /sitemap.xml.
  const sitemapUrls = Array.from(new Set([...robots.sitemaps.map((s) => absolutize(s, origin) ?? s), `${origin}/sitemap.xml`]));
  const sitemapEntries: string[] = [];
  const seenMaps = new Set<string>();
  const mapQueue = [...sitemapUrls];
  while (mapQueue.length && seenMaps.size < 20) {
    const sm = mapQueue.shift()!;
    if (seenMaps.has(sm)) continue;
    seenMaps.add(sm);
    const p = await fetchPage(sm, options);
    if (p.status !== 200) continue;
    const parsed = parseSitemap(p.body);
    sitemapEntries.push(...parsed.entries.map((e) => e.loc));
    mapQueue.push(...parsed.children);
    await sleep(options.delayMs);
  }

  const queue: { url: string; depth: number; from: string | null }[] = [{ url: start.toString(), depth: 0, from: null }];
  const seen = new Set<string>([start.toString()]);
  const records: CrawlRecord[] = [];
  const skippedByRobots: string[] = [];

  // Full-baseline mode: the sitemap is the URL universe, so every entry is queued up
  // front rather than being reached by chance through link following. Link discovery
  // still runs on top, which is what surfaces URLs the sitemap omits.
  const sitemapSeeded: string[] = [];
  if (options.fromSitemap) {
    for (const loc of sitemapEntries) {
      let key: string;
      try { const u = new URL(loc); u.hash = ""; key = u.toString(); } catch { continue; }
      if (options.sameHostOnly && new URL(key).host !== start.host) continue;
      sitemapSeeded.push(key);
      if (seen.has(key)) continue;
      seen.add(key);
      queue.push({ url: key, depth: 0, from: "sitemap" });
    }
    log(`full mode: seeded ${sitemapSeeded.length} sitemap URLs`);
  }

  while (queue.length && records.length < options.maxPages) {
    const item = queue.shift()!;
    if (options.respectRobots && !isAllowed(robots, ROBOTS_TOKEN, item.url)) { skippedByRobots.push(item.url); continue; }
    const page = await fetchPage(item.url, options);
    const isHtml = /text\/html|application\/xhtml/.test(page.contentType);
    const html = isHtml && page.body ? parseHtml(page.body, page.finalUrl) : null;
    const xRobots = (page.headers["x-robots-tag"] ?? "").split(",").map((d) => d.trim().toLowerCase()).filter(Boolean);
    records.push({ page, html, xRobots, depth: item.depth, discoveredFrom: item.from, contentHash: createHash("sha256").update(html?.textContent ?? page.body).digest("hex").slice(0, 16) });
    log(`${page.status} d${item.depth} ${item.url}${page.redirectChain.length ? ` (→ ${page.finalUrl})` : ""}`);

    if (html && item.depth < options.maxDepth) {
      for (const l of html.links) {
        if (options.sameHostOnly && !l.internal) continue;
        if (l.rel.includes("nofollow")) continue;
        const u = new URL(l.href); u.hash = "";
        const key = u.toString();
        if (seen.has(key)) continue;
        seen.add(key);
        queue.push({ url: key, depth: item.depth + 1, from: item.url });
      }
    }
    if (queue.length) await sleep(options.delayMs);
  }

  // Account for every sitemap URL. A full baseline that silently dropped URLs when it
  // hit the page cap would overstate its own coverage, so the leftovers are named.
  const norm = (u: string) => { try { const x = new URL(u); x.hash = ""; return x.toString().replace(/\/$/, ""); } catch { return u; } };
  const fetched = new Set(records.flatMap((r) => [norm(r.page.url), norm(r.page.finalUrl)]));
  const blocked = new Set(skippedByRobots.map(norm));
  const stillQueued = new Set(queue.map((q) => norm(q.url)));
  const notAttempted = sitemapSeeded
    .filter((u) => !fetched.has(norm(u)))
    .map((url) => ({
      url,
      reason: blocked.has(norm(url)) ? "disallowed by robots.txt for our token"
        : stillQueued.has(norm(url)) ? `not reached: page cap ${options.maxPages} exhausted`
        : "not reached",
    }));
  const crawledOrigins = new Set(sitemapSeeded.map(norm));
  const coverage = {
    mode: (options.fromSitemap ? "full" : "sample") as "full" | "sample",
    sitemapTotal: sitemapEntries.length,
    attempted: sitemapSeeded.length - notAttempted.length,
    processed: records.length,
    notAttempted,
    discoveredOutsideSitemap: records.map((r) => norm(r.page.url)).filter((u) => !crawledOrigins.has(u) && u !== norm(start.toString())),
    complete: options.fromSitemap && notAttempted.length === 0,
  };

  return {
    site: origin, startedAt, finishedAt: new Date().toISOString(), options, robots,
    sitemapUrls: Array.from(seenMaps), sitemapEntries, records, skippedByRobots, coverage,
    crawlerAccess: crawlerAccess(robots, `${origin}/`),
  };
}
