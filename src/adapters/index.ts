// First-party data adapters. Contract: every adapter reports its connection
// state honestly and returns `null` data when NOT_CONNECTED. No adapter ever
// synthesizes numbers. Real API clients are added only when credentials exist;
// the interfaces below are the stable surface the skills and agents rely on.
import type { IntegrationState } from "../types.ts";
import * as gscClient from "./gsc.ts";
import * as ga4Client from "./ga4.ts";

export interface AdapterStatus { name: string; state: IntegrationState; note: string; envVar: string }

export interface DateRange { start: string; end: string } // YYYY-MM-DD

export interface SearchAnalyticsRow { date?: string; page?: string; query?: string; country?: string; device?: string; searchAppearance?: string; clicks: number; impressions: number; ctr: number; position: number }
export interface SearchConsoleAdapter {
  status(): AdapterStatus;
  searchAnalytics(property: string, range: DateRange, dimensions: ("date" | "page" | "query" | "country" | "device" | "searchAppearance")[]): Promise<SearchAnalyticsRow[] | null>;
  urlInspection(property: string, url: string): Promise<Record<string, unknown> | null>;
  sitemaps(property: string): Promise<Record<string, unknown>[] | null>;
}

export interface Ga4Row { date?: string; landingPage?: string; source?: string; medium?: string; sessions: number; engagedSessions: number; conversions: number; eventName?: string; revenue?: number }
export interface Ga4Adapter {
  status(): AdapterStatus;
  landingPages(property: string, range: DateRange): Promise<Ga4Row[] | null>;
  organicAcquisition(property: string, range: DateRange): Promise<Ga4Row[] | null>;
  aiReferrals(property: string, range: DateRange): Promise<Ga4Row[] | null>; // sources matching known AI referrers (chatgpt.com, perplexity.ai, copilot.microsoft.com, gemini.google.com, claude.ai)
  conversions(property: string, range: DateRange, events: string[]): Promise<Ga4Row[] | null>;
}

export interface BingAdapter {
  status(): AdapterStatus;
  queryStats(site: string, range: DateRange): Promise<Record<string, unknown>[] | null>;
  crawlStats(site: string): Promise<Record<string, unknown> | null>;
}

export interface IndexNowAdapter {
  status(): AdapterStatus;
  keyHosted(host: string): Promise<boolean | "UNKNOWN">;  // GET https://host/<key>.txt — read-only check
  // submit() is intentionally absent in Phase 1: submission is a production-facing action and requires the change-management path.
}

export interface LogAdapter {
  status(): AdapterStatus;
  crawlerHits(range: DateRange): Promise<{ token: string; verified: boolean | "UNKNOWN"; hits: number }[] | null>;
}

export interface GitHubAdapter {
  status(): AdapterStatus;
  deployHistory(repo: string, range: DateRange): Promise<{ sha: string; date: string; message: string }[] | null>;
}

export interface ThirdPartyAdapter {
  status(): AdapterStatus;
  provider: string;   // every row must carry provider + retrieval date
}

const status = (name: string, envVar: string, extra = ""): AdapterStatus => {
  const present = !!process.env[envVar];
  return { name, envVar, state: present ? "UNKNOWN" : "NOT_CONNECTED", note: present ? `credential present; client not implemented in Phase 1 (no live call attempted)${extra}` : `set ${envVar} (see docs/integrations/)${extra}` };
};

// Istemcisi YAZILMIS adapterler icin ayri bir durum uretici. Fark onemli:
// yukaridaki "UNKNOWN" not'u "client not implemented" diyor ve artik GSC/GA4
// icin DOGRU DEGIL. Burada UNKNOWN'in anlami "kimlik var, canli cagri henuz
// denenmedi" — denemenin yolu smokeTest(). Kimlik yoksa yine NOT_CONNECTED.
const liveStatus = (name: string, envVar: string): AdapterStatus => {
  const present = !!process.env[envVar];
  return {
    name, envVar,
    state: present ? "UNKNOWN" : "NOT_CONNECTED",
    note: present
      ? "credential present; client implemented — run smokeTest() to confirm the property grant"
      : `set ${envVar} (see docs/integrations/)`,
  };
};

// GSC ve GA4 artik gercek istemci; digerleri hala durust stub. Sozlesme ikisinde
// de ayni: kimlik yoksa null, sayi uydurma yok.
export const searchConsole: SearchConsoleAdapter = {
  status: () => liveStatus("Google Search Console", gscClient.GSC_ENV),
  searchAnalytics: gscClient.searchAnalytics,
  urlInspection: gscClient.urlInspection,
  sitemaps: gscClient.sitemaps,
};
export const ga4: Ga4Adapter = {
  status: () => liveStatus("Google Analytics 4", ga4Client.GA4_ENV),
  landingPages: ga4Client.landingPages,
  organicAcquisition: ga4Client.organicAcquisition,
  aiReferrals: ga4Client.aiReferrals,
  conversions: ga4Client.conversions,
};
export const bing: BingAdapter = {
  status: () => status("Bing Webmaster Tools", "SEARCH_GROWTH_BING_API_KEY"),
  queryStats: async () => null, crawlStats: async () => null,
};
export const indexNow: IndexNowAdapter = {
  status: () => status("IndexNow", "SEARCH_GROWTH_INDEXNOW_KEY", "; submission disabled in Phase 1"),
  keyHosted: async (host) => {
    const key = process.env.SEARCH_GROWTH_INDEXNOW_KEY;
    if (!key) return "UNKNOWN";
    try { const r = await fetch(`https://${host}/${key}.txt`, { headers: { "user-agent": process.env.SEARCH_GROWTH_USER_AGENT ?? "SearchGrowthOS/0.1" } }); return r.status === 200 && (await r.text()).trim() === key; } catch { return "UNKNOWN"; }
  },
};
export const logs: LogAdapter = { status: () => status("Server/CDN logs", "SEARCH_GROWTH_LOG_SOURCE"), crawlerHits: async () => null };
export const github: GitHubAdapter = { status: () => status("GitHub deploy history", "SEARCH_GROWTH_GITHUB_TOKEN"), deployHistory: async () => null };
export const thirdParty: ThirdPartyAdapter = { status: () => status("Third-party SEO data", "SEARCH_GROWTH_THIRD_PARTY_API_KEY"), provider: process.env.SEARCH_GROWTH_THIRD_PARTY_PROVIDER ?? "NOT_CONNECTED" };

export function allStatuses(): AdapterStatus[] {
  return [searchConsole, ga4, bing, indexNow, logs, github, thirdParty].map((a) => a.status());
}
