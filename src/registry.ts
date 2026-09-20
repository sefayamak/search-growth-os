// Site registry loader + validator. Accepts JSON, or the YAML subset used by
// config/sites.example.yaml (nested mappings, block lists, scalars, quoted strings,
// inline [a, b] lists). No YAML dependency on purpose. Unknown values must be the
// literal strings NOT_CONNECTED or UNKNOWN — the validator rejects invented data.
import { readFileSync } from "node:fs";

export type Sentinel = "NOT_CONNECTED" | "UNKNOWN";
/** Portfolio lifecycle. Only `pilot_onboarding` and `active` sites may be crawled or
 *  changed; `registered_not_onboarded` sites exist in the registry as placeholders and
 *  are explicitly out of scope for every skill until the owner onboards them. */
export type OnboardingStatus = "pilot_onboarding" | "active" | "registered_not_onboarded";
export interface SiteEntry {
  id: string; onboarding_status: OnboardingStatus; production_domain: string; canonical_hostname: string;
  repository: string | Sentinel; framework: string | Sentinel; deployment_provider: string | Sentinel;
  primary_language: string; secondary_languages: string[]; target_markets: string[];
  business_category: string;
  /** Owner-confirmed founding year, or UNKNOWN. This is the entity source of truth:
   *  when the live site disagrees, the site is wrong, not this field. */
  foundation_year: number | Sentinel;
  /** Days this site intends to leave between published pieces. Owner-set, never derived:
   *  the system measures the real gap, but only the owner decides which gap is too long.
   *  UNKNOWN makes every cadence verdict for this site fall back to a stated default. */
  content_cadence_days: number | Sentinel;
  /** Path segments that hold this site's editorial content, when they are not one of the
   *  generic words the cadence engine knows. PAM İstanbul publishes under `pamlab`, which
   *  no generic list would contain; leaving it undeclared reported the site as having no
   *  content line at all. Empty is fine for a site whose section is a generic word. */
  content_sections: string[];
  primary_business_objectives: string[]; primary_conversion_events: string[];
  google_search_console_property: string | Sentinel; ga4_property: string | Sentinel; bing_webmaster_property: string | Sentinel;
  cdn_log_source: string | Sentinel; indexnow_status: "enabled" | "disabled" | Sentinel;
  robots_policy: string | Sentinel; sitemap_locations: string[]; known_subdomains: string[];
  competitor_set: string[]; core_commercial_topics: string[]; core_informational_topics: string[];
  brand_entities: string[]; people_entities: string[]; social_identity_urls: string[];
  business_locations: string[]; risk_level: "low" | "medium" | "high";
  deployment_approval_policy: "pr_only" | "pr_plus_human_approval" | "manual_only";
}
export interface Registry { version: number; sites: SiteEntry[] }

// --- YAML subset parser -------------------------------------------------------
type Node = string | number | boolean | null | Node[] | { [k: string]: Node };

function scalar(raw: string): Node {
  const s = raw.trim();
  if (s === "" || s === "null" || s === "~") return null;
  if (s === "true") return true; if (s === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1);
  if (s.startsWith("[") && s.endsWith("]")) return s.slice(1, -1).split(",").map((x) => x.trim()).filter(Boolean).map(scalar);
  return s;
}

export function parseYamlSubset(text: string): Node {
  const lines = text.split(/\r?\n/).map((l) => l.replace(/\s+#.*$/, "")).filter((l) => l.trim() && !l.trim().startsWith("#"));
  let i = 0;
  const indentOf = (l: string) => l.match(/^ */)![0].length;
  function block(indent: number): Node {
    if (i >= lines.length) return null;
    const isList = lines[i].trim().startsWith("- ");
    if (isList) {
      const arr: Node[] = [];
      while (i < lines.length && indentOf(lines[i]) === indent && lines[i].trim().startsWith("- ")) {
        const body = lines[i].trim().slice(2);
        if (/^[\w-]+:\s*(.*)$/.test(body) && !body.startsWith('"')) {
          // list of mappings: rewrite "- key: v" as a mapping line at indent+2
          lines[i] = " ".repeat(indent + 2) + body;
          arr.push(block(indent + 2));
        } else { i++; arr.push(scalar(body)); }
      }
      return arr;
    }
    const obj: { [k: string]: Node } = {};
    while (i < lines.length && indentOf(lines[i]) === indent && !lines[i].trim().startsWith("- ")) {
      const m = lines[i].match(/^\s*([^:]+):\s*(.*)$/);
      if (!m) throw new Error(`YAML subset: cannot parse line ${i + 1}: ${lines[i]}`);
      const key = m[1].trim(); const rest = m[2];
      i++;
      if (rest.trim() === "") {
        if (i < lines.length && indentOf(lines[i]) > indent) obj[key] = block(indentOf(lines[i]));
        else if (i < lines.length && indentOf(lines[i]) === indent && lines[i].trim().startsWith("- ")) obj[key] = block(indent);
        else obj[key] = null;
      } else obj[key] = scalar(rest);
    }
    return obj;
  }
  return block(indentOf(lines[0] ?? ""));
}

// --- validation ---------------------------------------------------------------
const REQUIRED: (keyof SiteEntry)[] = ["id", "onboarding_status", "production_domain", "canonical_hostname", "repository", "framework", "deployment_provider", "primary_language", "secondary_languages", "target_markets", "business_category", "foundation_year", "content_cadence_days", "content_sections", "primary_business_objectives", "primary_conversion_events", "google_search_console_property", "ga4_property", "bing_webmaster_property", "cdn_log_source", "indexnow_status", "robots_policy", "sitemap_locations", "known_subdomains", "competitor_set", "core_commercial_topics", "core_informational_topics", "brand_entities", "people_entities", "social_identity_urls", "business_locations", "risk_level", "deployment_approval_policy"];
const LISTS: (keyof SiteEntry)[] = ["content_sections", "secondary_languages", "target_markets", "primary_business_objectives", "primary_conversion_events", "sitemap_locations", "known_subdomains", "competitor_set", "core_commercial_topics", "core_informational_topics", "brand_entities", "people_entities", "social_identity_urls", "business_locations"];
const SENTINEL_OK: (keyof SiteEntry)[] = ["repository", "framework", "deployment_provider", "google_search_console_property", "ga4_property", "bing_webmaster_property", "cdn_log_source", "indexnow_status", "robots_policy"];
const PLACEHOLDER = /\b(todo|tbd|example\.com|lorem|xxx|placeholder|fill me)\b/i;

export function validateRegistry(data: unknown): { ok: boolean; errors: string[]; registry?: Registry } {
  const errors: string[] = [];
  const d = data as Partial<Registry> | null;
  if (!d || typeof d !== "object" || !Array.isArray(d.sites)) return { ok: false, errors: ["registry must be an object with a `sites` list"] };
  const ids = new Set<string>();
  d.sites.forEach((s, n) => {
    const site = s as unknown as Record<string, unknown>;
    const where = `sites[${n}]${site.id ? ` (${site.id})` : ""}`;
    for (const k of REQUIRED) if (!(k in site)) errors.push(`${where}: missing field ${k}`);
    for (const k of LISTS) if (k in site && !Array.isArray(site[k])) errors.push(`${where}: ${k} must be a list`);
    for (const k of SENTINEL_OK) { const v = site[k]; if (typeof v === "string" && PLACEHOLDER.test(v)) errors.push(`${where}: ${k} looks like a placeholder — use NOT_CONNECTED or UNKNOWN`); }
    for (const [k, v] of Object.entries(site)) if ((v === null || v === "") && !LISTS.includes(k as keyof SiteEntry)) errors.push(`${where}: ${k} is empty — use NOT_CONNECTED or UNKNOWN, never blank`);
    if (typeof site.id === "string") { if (ids.has(site.id)) errors.push(`${where}: duplicate id`); ids.add(site.id); if (!/^[a-z0-9-]+$/.test(site.id)) errors.push(`${where}: id must be kebab-case`); }
    if (!["low", "medium", "high"].includes(String(site.risk_level))) errors.push(`${where}: risk_level must be low|medium|high`);
    if (!["pr_only", "pr_plus_human_approval", "manual_only"].includes(String(site.deployment_approval_policy))) errors.push(`${where}: invalid deployment_approval_policy`);
    if (!["enabled", "disabled", "NOT_CONNECTED", "UNKNOWN"].includes(String(site.indexnow_status))) errors.push(`${where}: indexnow_status must be enabled|disabled|NOT_CONNECTED|UNKNOWN`);
    if (typeof site.production_domain === "string" && /^https?:\/\//.test(site.production_domain)) errors.push(`${where}: production_domain is a hostname, not a URL`);
    if (!["pilot_onboarding", "active", "registered_not_onboarded"].includes(String(site.onboarding_status))) errors.push(`${where}: onboarding_status must be pilot_onboarding|active|registered_not_onboarded`);
    const fy = site.foundation_year;
    const fyOk = fy === "UNKNOWN" || fy === "NOT_CONNECTED" || (typeof fy === "number" && fy >= 1900 && fy <= new Date().getUTCFullYear());
    if (!fyOk) errors.push(`${where}: foundation_year must be a plausible year or UNKNOWN — never a guess`);
    const cd = site.content_cadence_days;
    // A cadence is a commitment, so an absurd one is rejected rather than silently honoured:
    // sub-daily publishing is not a cadence, and a yearly one is not a schedule worth alerting on.
    const cdOk = cd === "UNKNOWN" || cd === "NOT_CONNECTED" || (typeof cd === "number" && cd >= 1 && cd <= 365);
    if (!cdOk) errors.push(`${where}: content_cadence_days must be 1-365 or UNKNOWN — it is an owner decision, never inferred`);
  });
  // A site that is only registered must not carry commercial assumptions: those are
  // per-site work products, and copying them between sites is the failure this guards.
  for (const s of d.sites as SiteEntry[]) {
    if (s?.onboarding_status !== "registered_not_onboarded") continue;
    for (const k of ["competitor_set", "core_commercial_topics", "core_informational_topics"] as const) {
      if (Array.isArray(s[k]) && s[k].length) errors.push(`sites (${s.id}): ${k} must stay empty until the site is onboarded — never inherit it from another site`);
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, errors, registry: d as Registry };
}

/** Sites a crawl/audit skill is allowed to touch. Registered-but-not-onboarded sites are excluded. */
export function onboardedSites(r: Registry): SiteEntry[] {
  return r.sites.filter((s) => s.onboarding_status !== "registered_not_onboarded");
}

export function loadRegistry(path: string) {
  const text = readFileSync(path, "utf8");
  const data = path.endsWith(".json") ? JSON.parse(text) : parseYamlSubset(text);
  return validateRegistry(data);
}
