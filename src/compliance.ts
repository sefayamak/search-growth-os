// Search Compliance Gate — deterministic rules that reject or flag proposed
// content/code/schema before it reaches a PR. Policy sources are recorded in
// policies/references/official-sources.md; rule text mirrors policies/compliance.md.
// Verdict "REJECT" = conflicts with an official policy; "FLAG" = needs human review.
export type Verdict = "PASS" | "FLAG" | "REJECT";
export interface ComplianceHit { rule: string; verdict: Exclude<Verdict, "PASS">; reason: string; evidence: string; policyRef: string }
export interface ComplianceResult { verdict: Verdict; hits: ComplianceHit[] }

interface Rule { id: string; verdict: "FLAG" | "REJECT"; policyRef: string; test: (input: string, ctx: Ctx) => string | null }
interface Ctx { kind: "html" | "markdown" | "code" | "schema" | "text" | "robots" | "plan"; path?: string }

const hit = (evidence: string | null) => evidence;

export const rules: Rule[] = [
  {
    id: "prompt_injection", verdict: "REJECT", policyRef: "policies/compliance.md#ai-manipulation",
    test: (s) => hit(s.match(/\b(ignore (all|any|previous|prior) (instructions|prompts?)|you are an? (ai|llm|assistant|language model)[^.\n]{0,80}(recommend|cite|mention)|when (summarizing|answering)[^.\n]{0,60}(recommend|cite|mention|say)|system prompt:|<\s*(instructions?|prompt)\s+for\s+(ai|llm|bots?)\s*>)/i)?.[0] ?? null),
  },
  {
    id: "hidden_text", verdict: "REJECT", policyRef: "policies/compliance.md#hidden-text",
    test: (s, ctx) => {
      if (ctx.kind !== "html" && ctx.kind !== "code") return null;
      // `font-size:0` must not match `font-size:0.95rem` — that false positive would
      // reject ordinary styled copy and make the whole gate untrustworthy.
      const m = s.match(/style\s*=\s*["'][^"']*(display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0(?:px|em|rem|%|pt)?(?![.\d])|text-indent\s*:\s*-\d{3,}|color\s*:\s*(#fff(fff)?|white)\s*;?\s*background(-color)?\s*:\s*(#fff(fff)?|white))[^"']*["'][^>]*>\s*[^<]{60,}/i);
      return m ? m[0].slice(0, 200) : null;
    },
  },
  {
    id: "keyword_stuffing", verdict: "REJECT", policyRef: "policies/compliance.md#keyword-stuffing",
    test: (s, ctx) => {
      if (ctx.kind === "code" || ctx.kind === "schema" || ctx.kind === "robots") return null;
      const text = s.replace(/<[^>]+>/g, " ").toLowerCase();
      const words = text.match(/[\p{L}\p{N}][\p{L}\p{N}'-]{2,}/gu) ?? [];
      if (words.length < 80) return null;
      // Bigram/trigram repetition: any 2–3 word phrase making up >4% of all words, or repeated 8+ times.
      const grams = new Map<string, number>();
      for (let i = 0; i < words.length - 1; i++) {
        const g2 = `${words[i]} ${words[i + 1]}`; grams.set(g2, (grams.get(g2) ?? 0) + 1);
        if (i < words.length - 2) { const g3 = `${g2} ${words[i + 2]}`; grams.set(g3, (grams.get(g3) ?? 0) + 1); }
      }
      for (const [g, n] of grams) {
        const stop = /^(and the|of the|in the|to the|ve bu|bir de|for the|on the|is a|it is)$/.test(g);
        if (!stop && g.split(" ").length >= 2 && (n >= 8 && n / words.length > 0.03)) return `"${g}" ×${n} in ${words.length} words`;
      }
      // Comma-separated keyword lists: 6+ short comma items in a row with no verbs.
      const lists = text.match(/(?:[\p{L}]+(?: [\p{L}]+){0,3},\s*){6,}/gu);
      if (lists) return `keyword list: ${lists[0].slice(0, 120)}`;
      return null;
    },
  },
  {
    id: "doorway_pages", verdict: "REJECT", policyRef: "policies/compliance.md#doorway-pages",
    test: (s, ctx) => {
      if (ctx.kind !== "plan" && ctx.kind !== "markdown" && ctx.kind !== "code") return null;
      const m = s.match(/(generate|create|build|produce|üret|oluştur)\s+(\d{2,}|hundreds|thousands|many|yüzlerce|binlerce)\s+[^\n]{0,40}(page|landing|url|sayfa)s?/i)
        ?? s.match(/\b(one|a|bir)\s+(page|landing page|sayfa)\s+(for|per)\s+(each|every|her)\s+[^\n]{0,30}(city|cities|location|district|neighbou?rhood|ilçe|şehir|semt|keyword|query|variation|variant|kelime|sorgu)/i)
        ?? s.match(/\{\{\s*(city|location|keyword|şehir|ilçe)\s*\}\}[^\n]{0,200}(services?|hizmet|fotoğraf|photography)/i);
      return m ? m[0].slice(0, 200) : null;
    },
  },
  {
    id: "indexing_api_misuse", verdict: "REJECT", policyRef: "policies/compliance.md#indexing-api",
    test: (s) => {
      const usesApi = /indexing\.googleapis\.com|urlNotifications:publish|google\s+indexing\s+api/i.test(s);
      if (!usesApi) return null;
      const allowed = /JobPosting|BroadcastEvent/.test(s);
      return allowed ? null : "Indexing API referenced without JobPosting/BroadcastEvent scope";
    },
  },
  {
    id: "llms_txt_claim", verdict: "REJECT", policyRef: "policies/compliance.md#llms-txt",
    test: (s) => hit(s.match(/llms?\.txt[^.\n]{0,120}(google|ai overviews?|ai mode|rank|ranking|sıralama)|(google|ai overviews?|ai mode|rank|ranking)[^.\n]{0,120}llms?\.txt/i)?.[0] ?? null),
  },
  {
    id: "faq_rich_result_objective", verdict: "FLAG", policyRef: "policies/compliance.md#faq-schema",
    test: (s) => hit(s.match(/faq(page)?\s*(schema|markup|structured data)[^.\n]{0,100}(rich (result|snippet)|serp feature|zengin sonuç)/i)?.[0] ?? null),
  },
  {
    id: "fake_evidence", verdict: "REJECT", policyRef: "policies/compliance.md#fabricated-evidence",
    test: (s) => hit(s.match(/\b(fake|invent|fabricate|make up|placeholder|uydur)[^.\n]{0,40}\b(review|testimonial|case stud|statistic|citation|author|credential|award|client logo|yorum|referans)/i)?.[0] ?? null),
  },
  {
    id: "fake_freshness", verdict: "REJECT", policyRef: "policies/compliance.md#fake-freshness",
    test: (s) => hit(s.match(/\b(bump|update|refresh|set|change)\s+(the\s+)?(datePublished|dateModified|last[- ]?updated|publish(ed)? date)[^.\n]{0,80}\b(without|no)\s+(content\s+)?change/i)?.[0] ?? s.match(/dateModified[^.\n]{0,40}(new Date\(\)|now\(\)|Date\.now)/)?.[0] ?? null),
  },
  {
    id: "cloaking_ua_branch", verdict: "REJECT", policyRef: "policies/compliance.md#cloaking",
    test: (s, ctx) => {
      if (ctx.kind !== "code") return null;
      const m = s.match(/(user[-_ ]?agent|userAgent|ua)\s*[^\n]{0,80}\b(googlebot|bingbot|oai-searchbot|gptbot|perplexitybot|claudebot)\b[\s\S]{0,300}?(return|render|res\.(send|end|write)|innerHTML|content\s*=)/i);
      return m ? m[0].slice(0, 200) : null;
    },
  },
  {
    id: "link_scheme", verdict: "REJECT", policyRef: "policies/compliance.md#link-schemes",
    test: (s) => hit(s.match(/\b(buy|purchase|paid|satın al)[^.\n]{0,30}\b(backlinks?|links?)\b|\bPBN\b|private blog network|link exchange|link (farm|wheel)|guest post[^.\n]{0,40}(dofollow|paid)/i)?.[0] ?? null),
  },
  {
    id: "scraped_or_spun_content", verdict: "REJECT", policyRef: "policies/compliance.md#scaled-content-abuse",
    test: (s) => hit(s.match(/\b(scrape|copy|spin|rewrite|paraphrase)\s+(the\s+)?(competitor'?s?|their|rival)[^.\n]{0,40}(content|page|article|text)/i)?.[0] ?? null),
  },
  {
    id: "serp_scraping", verdict: "REJECT", policyRef: "policies/compliance.md#automated-queries",
    test: (s) => hit(s.match(/(fetch|scrape|curl|request|axios|http\.get)[^\n]{0,80}google\.[a-z.]{2,6}\/search\?/i)?.[0] ?? null),
  },
  {
    id: "crawler_specific_content", verdict: "REJECT", policyRef: "policies/compliance.md#cloaking",
    test: (s) => hit(s.match(/(only|just)\s+for\s+(ai|llm|bots?|crawlers?)[^.\n]{0,40}(hidden|invisible|not (shown|visible))|(hidden|invisible)[^.\n]{0,40}(for|to)\s+(ai|llm|bots?|crawlers?)/i)?.[0] ?? null),
  },
  {
    id: "sitewide_high_risk", verdict: "FLAG", policyRef: "policies/high-risk-changes.md",
    test: (s, ctx) => {
      const p = ctx.path ?? "";
      if (/(^|\/)robots\.txt$|(^|\/)robots\.(ts|js)$|(^|\/)sitemap\.(ts|js|xml)$|next\.config|vercel\.json|_redirects|middleware|proxy\.ts|(^|\/)layout\.(tsx|jsx)$/.test(p)) return `high-risk path: ${p}`;
      if (/noindex|nofollow/i.test(s) && /layout|template|_app|root/i.test(p)) return "noindex in a shared template";
      return null;
    },
  },
];

export function checkCompliance(input: string, ctx: Ctx): ComplianceResult {
  const hits: ComplianceHit[] = [];
  for (const r of rules) {
    const ev = r.test(input, ctx);
    if (ev) hits.push({ rule: r.id, verdict: r.verdict, reason: `Rule ${r.id} matched`, evidence: ev, policyRef: r.policyRef });
  }
  const verdict: Verdict = hits.some((h) => h.verdict === "REJECT") ? "REJECT" : hits.length ? "FLAG" : "PASS";
  return { verdict, hits };
}

export function kindFromPath(path: string): Ctx["kind"] {
  if (/robots\.txt$/.test(path)) return "robots";
  if (/\.(html?|tsx|jsx|vue|svelte|astro)$/.test(path)) return "html";
  if (/\.(md|mdx|txt)$/.test(path)) return "markdown";
  if (/\.(jsonld|json)$/.test(path)) return "schema";
  if (/\.(ts|js|mjs|cjs|py|go|rb|php)$/.test(path)) return "code";
  return "text";
}
