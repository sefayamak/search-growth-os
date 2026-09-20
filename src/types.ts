// Shared types for the read-only audit engine.
// Evidence labels are a first-class type: nothing leaves the engine without one.

export type EvidenceLabel =
  | "FACT"            // measured directly from a fetch/parse
  | "INFERENCE"       // derived from facts by a deterministic rule
  | "HYPOTHESIS"      // plausible cause, not yet verified
  | "RECOMMENDATION"  // proposed action
  | "IMPLEMENTED_CHANGE"
  | "VERIFIED_RESULT";

export type Severity = "critical" | "high" | "medium" | "low" | "info";

/** Trust state of a finding. Detectors emit CANDIDATE or CONFIRMED only; a human or a
 *  verification step moves a finding to FALSE_POSITIVE. Nothing is promoted without
 *  evidence, because a report is only worth as much as its weakest claim. */
export type Confidence = "CONFIRMED" | "CANDIDATE" | "FALSE_POSITIVE" | "UNKNOWN";

export type IntegrationState = "CONNECTED" | "NOT_CONNECTED" | "UNKNOWN" | "ERROR";

export interface Finding {
  id: string;             // stable check id, e.g. "indexability.accidental_noindex"
  severity: Severity;
  /** CONFIRMED = the measurement is the defect (a 500 is a 500). CANDIDATE = a heuristic
   *  fired and a human must look before anything is changed. */
  confidence: Confidence;
  label: EvidenceLabel;   // FACT for what was measured; INFERENCE for what it implies
  url?: string;
  message: string;
  evidence: Record<string, unknown>; // raw values that justify the finding
  businessImpact: string;  // why this matters for search/business, not just "warning"
  fixHint?: string;
  policyRef?: string;      // path into policies/ when the finding is policy-related
}

export interface FetchedPage {
  url: string;
  finalUrl: string;
  status: number;
  redirectChain: { url: string; status: number }[];
  headers: Record<string, string>;
  contentType: string;
  body: string;            // text body (HTML) or "" for non-HTML
  bytes: number;
  fetchMs: number;
  error?: string;
}

export interface Link {
  href: string;      // absolute
  raw: string;
  text: string;
  rel: string[];
  internal: boolean;
}

export interface ImageRef {
  src: string;
  alt: string | null;   // null = attribute absent; "" = present but empty
  width?: string;
  height?: string;
  loading?: string;
}

export interface JsonLdBlock {
  raw: string;
  parsed: unknown | null;
  parseError?: string;
  types: string[];
}

export interface ParsedHtml {
  title: string | null;
  metaDescription: string | null;
  metaRobots: string[];       // lowercased directives from <meta name="robots">
  metaGooglebot: string[];
  canonical: string | null;   // absolute, first <link rel=canonical>
  canonicalCount: number;
  hreflang: { lang: string; href: string }[];
  headings: { level: number; text: string }[];
  links: Link[];
  images: ImageRef[];
  jsonLd: JsonLdBlock[];
  openGraph: Record<string, string>;
  lang: string | null;
  viewport: string | null;
  textContent: string;        // visible text approximation
  wordCount: number;
  hasNoscriptOnly: boolean;   // body text almost entirely inside <noscript>
  hiddenTextSuspects: string[];
  externalScripts: number;
  inlineStyleHidden: number;
}

export interface CrawlRecord {
  page: FetchedPage;
  html: ParsedHtml | null;
  xRobots: string[];          // from X-Robots-Tag header
  depth: number;
  discoveredFrom: string | null;
  contentHash: string;
}

export interface RobotsRules {
  raw: string;
  fetched: boolean;
  status: number;
  groups: { agents: string[]; allow: string[]; disallow: string[] }[];
  sitemaps: string[];
}

export interface CrawlOptions {
  startUrl: string;
  /** Full-baseline mode: seed the queue from every sitemap URL and account for each one
   *  individually, instead of sampling by following links out from the start page. */
  fromSitemap: boolean;
  maxPages: number;
  maxDepth: number;
  delayMs: number;
  userAgent: string;
  respectRobots: boolean;
  timeoutMs: number;
  sameHostOnly: boolean;
}

export interface CrawlResult {
  site: string;
  startedAt: string;
  finishedAt: string;
  options: CrawlOptions;
  robots: RobotsRules;
  sitemapUrls: string[];
  sitemapEntries: string[];
  records: CrawlRecord[];
  skippedByRobots: string[];
  crawlerAccess: CrawlerAccess[];
  /** Per-URL accounting for the sitemap universe. A full baseline is complete only when
   *  every eligible sitemap URL is either processed or carries an explicit failure reason. */
  coverage?: SitemapCoverage;
}

export interface SitemapCoverage {
  mode: "full" | "sample";
  sitemapTotal: number;
  attempted: number;
  processed: number;          // fetched and parsed, any status
  notAttempted: { url: string; reason: string }[];
  discoveredOutsideSitemap: string[];
  complete: boolean;          // attempted + notAttempted accounts for every sitemap URL
}

export interface CrawlerAccess {
  token: string;       // e.g. Googlebot, Bingbot, OAI-SearchBot, GPTBot, Google-Extended
  purpose: string;
  rootAllowed: boolean | "UNKNOWN";
  note: string;
}
