// First-party data adapters. Contract: every adapter reports its connection
// state honestly and returns `null` data when NOT_CONNECTED. No adapter ever
// synthesizes numbers. Real API clients are added only when credentials exist;
// the interfaces below are the stable surface the skills and agents rely on.
import type { IntegrationState } from "../types.ts";

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

// Phase 1 stubs: honest NOT_CONNECTED / UNKNOWN. Implementations land per integration
// after credentials exist and a read-only smoke test proves the scope.
export const searchConsole: SearchConsoleAdapter = {
  status: () => status("Google Search Console", "SEARCH_GROWTH_GSC_CREDENTIALS_JSON"),
  searchAnalytics: async () => null, urlInspection: async () => null, sitemaps: async () => null,
};
export const ga4: Ga4Adapter = {
  status: () => status("Google Analytics 4", "SEARCH_GROWTH_GA4_CREDENTIALS_JSON"),
  landingPages: async () => null, organicAcquisition: async () => null, aiReferrals: async () => null, conversions: async () => null,
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
