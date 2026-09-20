// robots.txt parser following the REP semantics Google documents
// (longest-match wins, allow beats disallow on equal length, group per UA token).
// Source of truth: Google "How Google interprets the robots.txt specification"
// and RFC 9309. Retrieval date recorded in policies/references/official-sources.md.
import type { RobotsRules, CrawlerAccess } from "./types.ts";

export function parseRobots(raw: string, status: number, fetched: boolean): RobotsRules {
  const groups: RobotsRules["groups"] = [];
  const sitemaps: string[] = [];
  let current: RobotsRules["groups"][number] | null = null;
  let lastWasAgent = false;
  for (const lineRaw of raw.split(/\r?\n/)) {
    const line = lineRaw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (field === "user-agent") {
      if (!current || !lastWasAgent) { current = { agents: [], allow: [], disallow: [] }; groups.push(current); }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (field === "sitemap") { sitemaps.push(value); continue; }
    if (!current) continue;
    if (field === "allow") current.allow.push(value);
    else if (field === "disallow") current.disallow.push(value);
  }
  return { raw, fetched, status, groups, sitemaps };
}

function groupFor(rules: RobotsRules, token: string) {
  const t = token.toLowerCase();
  // Most specific match wins: exact token, then prefix, then "*".
  const exact = rules.groups.find((g) => g.agents.includes(t));
  if (exact) return exact;
  const prefix = rules.groups.find((g) => g.agents.some((a) => a !== "*" && t.startsWith(a)));
  if (prefix) return prefix;
  return rules.groups.find((g) => g.agents.includes("*")) ?? null;
}

function patternToRegex(p: string): RegExp {
  const esc = p.replace(/[.+?^{}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp("^" + (esc.endsWith("$") ? esc.slice(0, -1) + "$" : esc));
}

export function isAllowed(rules: RobotsRules, token: string, url: string): boolean {
  // Unreachable robots.txt (5xx) → Google treats as full disallow; 4xx → allow all.
  if (!rules.fetched) return true;
  if (rules.status >= 500) return false;
  if (rules.status >= 400) return true;
  const g = groupFor(rules, token);
  if (!g) return true;
  const path = (() => { const u = new URL(url); return u.pathname + u.search; })();
  let best: { allow: boolean; len: number } | null = null;
  for (const [allow, list] of [[true, g.allow], [false, g.disallow]] as const) {
    for (const p of list) {
      if (p === "") continue;
      if (patternToRegex(p).test(path)) {
        if (!best || p.length > best.len || (p.length === best.len && allow)) best = { allow, len: p.length };
      }
    }
  }
  return best ? best.allow : true;
}

// Crawler tokens whose access we report. Purposes from official docs (see policies/references).
export const CRAWLER_TOKENS: { token: string; purpose: string }[] = [
  { token: "Googlebot", purpose: "Google Search crawling (also the control for AI Overviews / AI Mode inclusion)" },
  { token: "Google-Extended", purpose: "Gemini apps / Vertex AI training control; does NOT affect Search inclusion" },
  { token: "Bingbot", purpose: "Bing Search and Copilot answers" },
  { token: "OAI-SearchBot", purpose: "ChatGPT search result inclusion / linking" },
  { token: "GPTBot", purpose: "OpenAI model training crawler (independent of OAI-SearchBot)" },
  { token: "ChatGPT-User", purpose: "User-triggered fetches from ChatGPT (not a crawler)" },
  { token: "PerplexityBot", purpose: "Perplexity search index" },
  { token: "ClaudeBot", purpose: "Anthropic crawler" },
];

export function crawlerAccess(rules: RobotsRules, rootUrl: string): CrawlerAccess[] {
  return CRAWLER_TOKENS.map(({ token, purpose }) => {
    if (!rules.fetched) return { token, purpose, rootAllowed: "UNKNOWN" as const, note: "robots.txt could not be fetched" };
    const explicit = rules.groups.some((g) => g.agents.includes(token.toLowerCase()));
    return {
      token, purpose,
      rootAllowed: isAllowed(rules, token, rootUrl),
      note: explicit ? "explicit group in robots.txt" : "falls back to '*' group or default allow",
    };
  });
}
