// Content cadence: how long a site has gone without publishing, measured rather than guessed.
//
// The question this answers is "when did this site last publish something new", and the
// honest answer is often UNKNOWN. Three traps are handled explicitly, because each one
// produces a confident wrong number:
//
//   1. `lastmod` in a sitemap is frequently the BUILD time, not the publish time. A
//      generator that stamps every URL with today's date makes a two-year-dead blog look
//      fresh. Uniform lastmod values are therefore rejected as evidence, not averaged in.
//   2. A site with no content section at all is not "overdue" — it is a different kind of
//      site. Saying "you have not blogged in 400 days" to a site that never blogged is noise.
//   3. A publish date pulled from the page (JSON-LD, article:published_time) outranks a
//      sitemap date, because the page states it and the sitemap infers it.
//
// Nothing here reads a keyword, a competitor or a strategy, so it is safe to run across
// the whole portfolio, including sites that are registered but not onboarded. See
// policies/portfolio-isolation.md.
import { fetchPage, DEFAULT_OPTIONS, ROBOTS_TOKEN } from "./crawler.ts";
import { parseHtml } from "./html.ts";
import { parseRobots, isAllowed } from "./robots.ts";
import { parseSitemap, type SitemapEntry } from "./sitemap.ts";
import type { Confidence, EvidenceLabel } from "./types.ts";

/** URL path segments that mark editorial content across TR and EN sites. Deliberately a
 *  closed list: guessing at arbitrary paths would classify service pages as blog posts. */
export const CONTENT_PATTERNS = [
  "blog", "makale", "makaleler", "yazi", "yazilar", "haber", "haberler", "gunluk",
  "journal", "insights", "article", "articles", "news", "post", "posts", "stories", "guides",
] as const;

export type CadenceVerdict = "OK" | "DUE" | "OVERDUE" | "NO_CONTENT_SECTION" | "UNKNOWN";
export type DateSource =
  | "jsonld_datePublished" | "jsonld_dateModified" | "meta_article_published"
  | "time_element" | "og_updated_time" | "sitemap_lastmod";

export interface PublishSignal {
  date: string;          // ISO yyyy-mm-dd
  url: string;
  source: DateSource;
  confidence: Confidence;
}

export interface CadenceResult {
  siteId: string;
  domain: string;
  onboardingStatus: string;
  /** null when the site has no recognisable editorial section. */
  contentSection: { pattern: string; urlCount: number } | null;
  sitemapUrls: number;
  latestPublish: PublishSignal | null;
  daysSincePublish: number | null;
  expectedCadenceDays: number;
  expectedSource: "registry" | "default";
  verdict: CadenceVerdict;
  label: EvidenceLabel;
  /** Human-readable reasons, including every reason a number is missing. */
  notes: string[];
  /** Newest content URLs actually inspected, newest first. Input for topic work. */
  recentContent: { url: string; date: string | null; title: string | null }[];
  error?: string;
}

/** Used when the registry does not state a cadence. Two weeks is a stated default, not a
 *  measured norm for this site, so any verdict derived from it is an INFERENCE. */
export const DEFAULT_CADENCE_DAYS = 14;

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** Parse a date defensively. Returns null for anything that is not a real, past-or-present
 *  date, so a malformed or future-dated stamp can never become a freshness claim. */
export function parseDate(raw: string | undefined | null, now = new Date()): string | null {
  if (!raw) return null;
  const t = Date.parse(raw.trim());
  if (Number.isNaN(t)) return null;
  const d = new Date(t);
  if (d.getUTCFullYear() < 1995) return null;
  // Allow one day of clock skew; beyond that a future date is a data error, not news.
  if (t > now.getTime() + 86_400_000) return null;
  return isoDay(d);
}

export function daysBetween(fromIso: string, now = new Date()): number {
  const t = Date.parse(fromIso + "T00:00:00Z");
  return Math.floor((now.getTime() - t) / 86_400_000);
}

/** Which editorial section this site uses, by URL evidence. Picks the pattern carrying the
 *  most URLs so a stray `/news/` link cannot outvote a real `/blog/`. */
export function discoverContentSection(
  urls: string[],
  /** Site-declared section names from the registry. A brand is free to call its editorial
   *  section anything — PAM İstanbul calls its blog `pamlab` — and no global word list can
   *  contain every such name. Missing one produces a false NEGATIVE: the site is reported
   *  as having no content line while it publishes regularly, which is the quieter and more
   *  damaging error, so the registry gets to override the guess. */
  declared: string[] = [],
): { pattern: string; urlCount: number } | null {
  const patterns = [...new Set([...declared.map((d) => d.toLowerCase().replace(/^\/+|\/+$/g, "")), ...CONTENT_PATTERNS])];
  const counts = new Map<string, number>();
  for (const u of urls) {
    let segments: string[];
    try { segments = new URL(u).pathname.toLowerCase().split("/").filter(Boolean); } catch { continue; }
    // The section marker must be a path segment, never a substring: `/kurumsal-blogger/`
    // is not a blog, and `/haberler-hakkinda/` is not the news section.
    for (const p of patterns) {
      if (!segments.includes(p)) continue;
      // A bare section index (/blog/) is not an article; only deeper URLs are entries.
      if (segments[segments.length - 1] === p) continue;
      counts.set(p, (counts.get(p) ?? 0) + 1);
    }
  }
  let best: { pattern: string; urlCount: number } | null = null;
  for (const [pattern, urlCount] of counts) if (!best || urlCount > best.urlCount) best = { pattern, urlCount };
  return best;
}

/** The site's most common first path segments, for telling "this site has no editorial
 *  section" apart from "our pattern list is missing this site's word for one". */
export function topSegments(urls: string[], limit = 12): string {
  const counts = new Map<string, number>();
  for (const u of urls) {
    let segs: string[];
    try { segs = new URL(u).pathname.toLowerCase().split("/").filter(Boolean); } catch { continue; }
    const key = segs.length ? segs[0] : "(root)";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const sorted = [...counts].sort((a, b) => b[1] - a[1]);
  const shown = sorted.slice(0, limit).map(([k, n]) => `${k} (${n})`).join(", ");
  return sorted.length > limit ? `${shown}, +${sorted.length - limit} more` : shown;
}

/** True when sitemap lastmod values carry real per-URL information. A generator that stamps
 *  every entry identically tells us when the site was BUILT, which is not when it published. */
export function lastmodIsInformative(entries: SitemapEntry[]): boolean {
  const withMod = entries.filter((e) => e.lastmod);
  if (withMod.length < 3) return false;
  const distinct = new Set(withMod.map((e) => parseDate(e.lastmod) ?? e.lastmod!));
  // Fewer than three distinct days across the section means the dates move together.
  return distinct.size >= 3;
}

/** Strongest publish signal a single page states about itself, in descending trust order. */
export function publishSignalFromHtml(html: string, url: string, now = new Date()): PublishSignal | null {
  const parsed = parseHtml(html, url);

  for (const block of parsed.jsonLd) {
    const nodes: unknown[] = [];
    const push = (n: unknown) => {
      if (Array.isArray(n)) n.forEach(push);
      else if (n && typeof n === "object") {
        nodes.push(n);
        const graph = (n as Record<string, unknown>)["@graph"];
        if (graph) push(graph);
      }
    };
    push(block.parsed);
    for (const key of ["datePublished", "dateCreated"] as const) {
      for (const n of nodes) {
        const d = parseDate((n as Record<string, unknown>)[key] as string, now);
        if (d) return { date: d, url, source: "jsonld_datePublished", confidence: "CONFIRMED" };
      }
    }
    for (const n of nodes) {
      const d = parseDate((n as Record<string, unknown>).dateModified as string, now);
      // A modification date proves the page changed, not that anything new was published.
      if (d) return { date: d, url, source: "jsonld_dateModified", confidence: "CANDIDATE" };
    }
  }

  const meta = html.match(/<meta[^>]+property=["']article:published_time["'][^>]*content=["']([^"']+)["']/i)
    ?? html.match(/<meta[^>]+content=["']([^"']+)["'][^>]*property=["']article:published_time["']/i);
  const metaDate = parseDate(meta?.[1], now);
  if (metaDate) return { date: metaDate, url, source: "meta_article_published", confidence: "CONFIRMED" };

  const time = html.match(/<time[^>]+datetime=["']([^"']+)["']/i);
  const timeDate = parseDate(time?.[1], now);
  if (timeDate) return { date: timeDate, url, source: "time_element", confidence: "CANDIDATE" };

  const og = parseDate(parsed.openGraph["og:updated_time"], now);
  if (og) return { date: og, url, source: "og_updated_time", confidence: "CANDIDATE" };

  return null;
}

async function readSitemaps(origin: string, declared: string[], ua: string, timeoutMs: number, log: (s: string) => void) {
  const seen = new Set<string>();
  const entries: SitemapEntry[] = [];
  const queue = [...declared];
  // Depth is bounded: a sitemap index of indexes is legal but two levels is enough, and an
  // unbounded follow would let a malformed sitemap loop us.
  for (let guard = 0; queue.length && guard < 25; guard++) {
    const url = queue.shift()!;
    if (seen.has(url) || !url.startsWith(origin)) continue;
    seen.add(url);
    const page = await fetchPage(url, { userAgent: ua, timeoutMs });
    if (page.status !== 200 || !page.body) { log(`sitemap ${page.status} ${url}`); continue; }
    const { entries: e, children } = parseSitemap(page.body);
    entries.push(...e);
    queue.push(...children);
  }
  return entries;
}

export interface CadenceOptions {
  /** How many recent content pages to open to read their stated publish date. */
  samplePages: number;
  delayMs: number;
  timeoutMs: number;
  userAgent: string;
  now: Date;
}

const CADENCE_DEFAULTS: CadenceOptions = {
  samplePages: 6, delayMs: 800, timeoutMs: 15000,
  userAgent: DEFAULT_OPTIONS.userAgent, now: new Date(),
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Measure one site's publishing cadence. Read-only: sitemap plus a handful of GETs. */
export async function assessCadence(
  site: { id: string; domain: string; onboardingStatus: string; sitemaps: string[]; cadenceDays?: number | null; contentSections?: string[] },
  partial: Partial<CadenceOptions> = {},
  log: (s: string) => void = () => {},
): Promise<CadenceResult> {
  const o: CadenceOptions = { ...CADENCE_DEFAULTS, ...partial };
  const notes: string[] = [];
  // A registry holds a hostname, so https is the right default; an explicit scheme is
  // honoured so the engine can be exercised against a local fixture over http.
  const origin = /^https?:\/\//.test(site.domain) ? site.domain.replace(/\/$/, "") : `https://${site.domain}`;
  const expectedCadenceDays = site.cadenceDays ?? DEFAULT_CADENCE_DAYS;
  const expectedSource = site.cadenceDays ? "registry" : "default";
  if (expectedSource === "default") notes.push(`no cadence in the registry — using the ${DEFAULT_CADENCE_DAYS}-day default, so the verdict is an inference, not this site's own norm`);

  const base: CadenceResult = {
    siteId: site.id, domain: site.domain, onboardingStatus: site.onboardingStatus,
    contentSection: null, sitemapUrls: 0, latestPublish: null, daysSincePublish: null,
    expectedCadenceDays, expectedSource, verdict: "UNKNOWN", label: "FACT", notes, recentContent: [],
  };

  const robotsPage = await fetchPage(`${origin}/robots.txt`, o);
  if (robotsPage.status === 0) {
    return { ...base, verdict: "UNKNOWN", error: robotsPage.error ?? "host unreachable", notes: [...notes, `host unreachable: ${robotsPage.error ?? "no response"}`] };
  }
  const robots = parseRobots(robotsPage.status === 200 ? robotsPage.body : "", robotsPage.status, !robotsPage.error);

  const declared = robots.sitemaps.length ? robots.sitemaps : site.sitemaps.length ? site.sitemaps : [`${origin}/sitemap.xml`];
  const entries = await readSitemaps(origin, declared, o.userAgent, o.timeoutMs, log);
  if (!entries.length) {
    return { ...base, verdict: "UNKNOWN", notes: [...notes, "no sitemap entries could be read — publishing cadence cannot be measured this way"] };
  }
  base.sitemapUrls = entries.length;

  const section = discoverContentSection(entries.map((e) => e.loc), site.contentSections ?? []);
  if (!section) {
    // "No editorial section" is a claim about the site, but it could equally be a gap in
    // the pattern list. Printing the site's actual top-level structure lets that be told
    // apart at a glance instead of trusted.
    return { ...base, verdict: "NO_CONTENT_SECTION", label: "FACT",
      notes: [...notes,
        `no editorial section found among ${entries.length} sitemap URLs (looked for: ${[...(site.contentSections ?? []), ...CONTENT_PATTERNS].join(", ")})`,
        `the site's own top-level structure: ${topSegments(entries.map((e) => e.loc))}`,
        "if one of those IS this site's editorial section, declare it as content_sections in the registry rather than leaving it undetected",
      ] };
  }
  base.contentSection = section;

  const inSection = entries.filter((e) => {
    try { return new URL(e.loc).pathname.toLowerCase().split("/").filter(Boolean).includes(section.pattern); }
    catch { return false; }
  });

  // Order candidates newest-first. Trustworthy lastmod gives a real ordering; otherwise fall
  // back to sitemap order, which is commonly newest-first but is only a guess — recorded as one.
  const trust = lastmodIsInformative(inSection);
  if (!trust) notes.push("sitemap lastmod values are absent or move together (a build stamp, not publish dates) — ignored as evidence");
  const ordered = trust
    ? [...inSection].sort((a, b) => (parseDate(b.lastmod) ?? "").localeCompare(parseDate(a.lastmod) ?? ""))
    : [...inSection].reverse();

  const candidates = ordered.filter((e) => isAllowed(robots, ROBOTS_TOKEN, e.loc)).slice(0, o.samplePages);
  if (candidates.length < ordered.length && ordered.length) {
    const blocked = ordered.length - ordered.filter((e) => isAllowed(robots, ROBOTS_TOKEN, e.loc)).length;
    if (blocked) notes.push(`${blocked} content URLs are disallowed for our crawler token and were not opened`);
  }

  let best: PublishSignal | null = null;
  for (const entry of candidates) {
    await sleep(o.delayMs);
    const page = await fetchPage(entry.loc, o);
    if (page.status !== 200 || !page.body) { log(`content ${page.status} ${entry.loc}`); continue; }
    const signal = publishSignalFromHtml(page.body, entry.loc, o.now);
    const title = parseHtml(page.body, entry.loc).title;
    base.recentContent.push({ url: entry.loc, date: signal?.date ?? null, title });
    if (signal && (!best || signal.date > best.date)) best = signal;
  }

  // Only now, and only if the pages themselves said nothing, does a trustworthy lastmod
  // become the answer — always as a CANDIDATE, because it is the sitemap's claim.
  if (!best && trust) {
    const newest = ordered.map((e) => parseDate(e.lastmod)).filter(Boolean).sort().at(-1);
    if (newest) {
      best = { date: newest, url: ordered[0].loc, source: "sitemap_lastmod", confidence: "CANDIDATE" };
      notes.push("no page stated its own publish date; falling back to sitemap lastmod");
    }
  }

  if (!best) {
    return { ...base, verdict: "UNKNOWN",
      notes: [...notes, `${section.urlCount} pages found under /${section.pattern}/ but none state a publish date (no JSON-LD datePublished, no article:published_time, no <time datetime>) — add one and this becomes measurable`] };
  }

  const days = daysBetween(best.date, o.now);
  const verdict: CadenceVerdict = days >= expectedCadenceDays * 2 ? "OVERDUE" : days >= expectedCadenceDays ? "DUE" : "OK";
  base.recentContent.sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
  return {
    ...base, latestPublish: best, daysSincePublish: days, verdict,
    // The date is measured; "you are overdue" is what that date implies against a threshold.
    label: "INFERENCE",
    notes,
  };
}

export interface PortfolioCadenceSite {
  id: string; domain: string; onboardingStatus: string; sitemaps: string[];
  cadenceDays?: number | null; contentSections?: string[];
}

/** Sequential on purpose: one site at a time keeps the request rate obviously polite and
 *  makes the log readable when a run is being audited afterwards. */
export async function assessPortfolio(
  sites: PortfolioCadenceSite[],
  partial: Partial<CadenceOptions> = {},
  log: (s: string) => void = () => {},
): Promise<CadenceResult[]> {
  const out: CadenceResult[] = [];
  for (const site of sites) {
    log(`— ${site.id} (${site.domain})`);
    try { out.push(await assessCadence(site, partial, log)); }
    catch (e) {
      out.push({
        siteId: site.id, domain: site.domain, onboardingStatus: site.onboardingStatus,
        contentSection: null, sitemapUrls: 0, latestPublish: null, daysSincePublish: null,
        expectedCadenceDays: site.cadenceDays ?? DEFAULT_CADENCE_DAYS,
        expectedSource: site.cadenceDays ? "registry" : "default",
        verdict: "UNKNOWN", label: "FACT", notes: ["check failed"], recentContent: [],
        error: String((e as Error).message ?? e),
      });
    }
  }
  return out;
}

const VERDICT_ORDER: Record<CadenceVerdict, number> = { OVERDUE: 0, DUE: 1, UNKNOWN: 2, NO_CONTENT_SECTION: 3, OK: 4 };

export function cadenceToMarkdown(results: CadenceResult[], now = new Date()): string {
  const rows = [...results].sort((a, b) =>
    VERDICT_ORDER[a.verdict] - VERDICT_ORDER[b.verdict] || (b.daysSincePublish ?? -1) - (a.daysSincePublish ?? -1));
  const L: string[] = [
    `# Portfolio content check — ${isoDay(now)}`,
    "",
    "Read-only. Sitemaps and a small sample of content pages were fetched; nothing was changed.",
    "`daysSincePublish` is measured. The verdict is an INFERENCE: it compares that measurement",
    "against an expected cadence, and where the cadence came from is stated per row.",
    "",
    "| Site | Status | Section | Last publish | Days | Expected | Verdict | Date source |",
    "|---|---|---|---|---|---|---|---|",
  ];
  for (const r of rows) {
    L.push(`| ${r.siteId} | ${r.onboardingStatus} | ${r.contentSection ? `/${r.contentSection.pattern}/ (${r.contentSection.urlCount})` : "—"} `
      + `| ${r.latestPublish?.date ?? "UNKNOWN"} | ${r.daysSincePublish ?? "—"} | ${r.expectedCadenceDays}d (${r.expectedSource}) `
      + `| **${r.verdict}** | ${r.latestPublish ? `${r.latestPublish.source} · ${r.latestPublish.confidence}` : "—"} |`);
  }
  for (const r of rows) {
    if (!r.notes.length && !r.error) continue;
    L.push("", `### ${r.siteId}`);
    if (r.error) L.push(`- ERROR: ${r.error}`);
    for (const n of r.notes) L.push(`- ${n}`);
  }
  L.push("", "## What this does not say", "",
    "Nothing here measures whether the published content ranks, is cited by AI assistants, or",
    "converts. Those need Search Console and GA4, which are reported separately by",
    "`integrations` and are not estimated when missing.");
  return L.join("\n");
}
