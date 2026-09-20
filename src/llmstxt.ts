// llms.txt inventory: what each site actually serves, measured against the specification
// and against the registry's own facts.
//
// Why this is a measurement and not an optimisation: the published evidence says almost
// nobody reads these files. Ahrefs measured 137,210 domains and found 97% of llms.txt
// files received zero requests in May 2026, with AI search bots accounting for ~1.1% of
// the traffic the remaining 3% got. Google states it ignores the file. So this tool exists
// to answer "what is on our sites, and does it contradict us", not to grow the files.
// See policies/references/llms-txt.md for sources and retrieval dates.
//
// The contradiction check is the part that earns its keep. A file nothing reads still
// costs something the moment it disagrees with the site: it is an unvalidated second copy
// of the brand's facts, and the pilot's founding year had already drifted in exactly that
// way. Read-only throughout.
import { fetchPage, DEFAULT_OPTIONS } from "./crawler.ts";

/** Characters per token for mixed Turkish/English prose. A range, because a point estimate
 *  here would be false precision — the number is used to say "this is large", not to bill. */
export const CHARS_PER_TOKEN = { low: 3.3, high: 3.8 } as const;

export interface SpecShape {
  /** The one element the specification requires. */
  h1: string | null;
  /** Optional blockquote summary directly under the H1. */
  summary: boolean;
  /** H2 section headings, in order. */
  sections: string[];
  /** `- [name](url)` items: the format's actual payload. */
  linkCount: number;
  /** The reserved `## Optional` section a reader may skip for a shorter context. */
  optionalSection: boolean;
  /** Headings used as questions (`### ...?`) — not part of the spec, common in practice. */
  questionCount: number;
  /** Prose lines that are neither links nor headings: the bulk that makes a file heavy. */
  proseChars: number;
}

export interface LlmsTxtResult {
  siteId: string;
  domain: string;
  onboardingStatus: string;
  present: boolean;
  status: number;
  bytes: number;
  tokensLow: number;
  tokensHigh: number;
  spec: SpecShape | null;
  full: { present: boolean; status: number; bytes: number; tokensLow: number; tokensHigh: number };
  /** Statements in the file that disagree with the registry. CONFIRMED where the wording
   *  is unambiguously a founding claim; CANDIDATE where it merely could be. The file is a
   *  second copy of the brand's facts that nothing validates, so both are worth knowing. */
  contradictions: Contradiction[];
  /** Deviations from the specification, and size observations. */
  issues: string[];
  error?: string;
}

const tokens = (chars: number) => ({
  low: Math.round(chars / CHARS_PER_TOKEN.high),
  high: Math.round(chars / CHARS_PER_TOKEN.low),
});

/** Parse the CommonMark shape the specification defines. Deliberately structural: it
 *  reports what the file IS, and judgement about what it should be stays in the policy. */
export function parseLlmsTxt(text: string): SpecShape {
  const lines = text.split(/\r?\n/);
  const h1 = lines.find((l) => /^#\s+\S/.test(l))?.replace(/^#\s+/, "").trim() ?? null;

  // The summary must be a blockquote directly under the H1, blank lines aside.
  let summary = false;
  const h1Index = lines.findIndex((l) => /^#\s+\S/.test(l));
  if (h1Index >= 0) {
    for (let i = h1Index + 1; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      summary = lines[i].trimStart().startsWith(">");
      break;
    }
  }

  const sections = lines.filter((l) => /^##\s+\S/.test(l)).map((l) => l.replace(/^##\s+/, "").trim());
  const linkCount = lines.filter((l) => /^\s*[-*]\s*\[[^\]]+\]\([^)]+\)/.test(l)).length;
  const questionCount = lines.filter((l) => /^#{3,6}\s+.*\?\s*$/.test(l)).length;
  const proseChars = lines
    .filter((l) => l.trim() && !/^#{1,6}\s/.test(l) && !/^\s*[-*]\s*\[/.test(l) && !l.trimStart().startsWith(">"))
    .reduce((n, l) => n + l.length, 0);

  return {
    h1, summary, sections, linkCount, questionCount, proseChars,
    optionalSection: sections.some((s) => /^optional$/i.test(s)),
  };
}

export interface Contradiction {
  message: string;
  confidence: "CONFIRMED" | "CANDIDATE";
}

export interface RegistryFacts {
  /** null when the owner has not confirmed a year: nothing can then be checked. */
  foundationYear: number | null;
  brandEntities: string[];
}

/** Compare the file's claims against facts the owner has confirmed. Only checks that can
 *  be made without guessing are performed; a missing registry fact is skipped, never
 *  assumed. */
export function findContradictions(text: string, facts: RegistryFacts): Contradiction[] {
  const out: Contradiction[] = [];
  if (!facts.foundationYear || !facts.brandEntities.length) return out;

  // Scope is the whole problem. A first attempt matched any "founded|since + year" anywhere
  // in the file and reported five contradictions on llms-full.txt that were nothing of the
  // kind: article bodies saying when OTHER companies were founded ("founded in Germany in
  // 2024"). Proximity to the brand name does not separate them either — the brand appears
  // 883 times in that file, so everything is near it.
  //
  // A claim therefore counts only when it is about THIS brand, by one of two structural
  // tests: a field label at the start of a line, or a founding phrase in the same SENTENCE
  // as a brand name.
  //
  // Strength is then a second, separate question. `founded` and `kuruldu` state a founding.
  // `since` does not: "integrating AI into the workflow since 2023" is a real sentence in
  // this very file and has nothing to do with when the company started. So `since`/`beri`
  // is reported as CANDIDATE for a human to read, never as a confirmed defect.
  const brands = facts.brandEntities.map((b) => b.toLowerCase());
  const YEAR = String.raw`(19\d{2}|20\d{2})`;
  const STRONG = String.raw`\b(?:founded|established|est\.|kurul\w*)\b`;
  const WEAK = String.raw`\b(?:since|beri)\b`;

  const strong = [
    new RegExp(String.raw`${STRONG}\D{0,20}${YEAR}`, "i"),
    new RegExp(String.raw`${YEAR}\s*(?:yılında|yilinda)\s*\W{0,3}${STRONG}`, "i"),
    // "2017'de kuruldu" — the locative suffix, not the ablative. Missing this let
    // pamaistudio.com state the wrong founding year in its own llms.txt undetected.
    new RegExp(String.raw`${YEAR}['’]?d[ae]\s+kurul\w*`, "i"),
  ];
  const weak = [
    new RegExp(String.raw`${WEAK}\D{0,20}${YEAR}`, "i"),
    new RegExp(String.raw`${YEAR}['’]?d[ae]n?\s+beri`, "i"),
  ];

  const counts = { CONFIRMED: new Map<string, number>(), CANDIDATE: new Map<string, number>() };
  const record = (unit: string) => {
    for (const [level, res] of [["CONFIRMED", strong], ["CANDIDATE", weak]] as const) {
      for (const re of res) {
        const m = unit.match(re);
        if (!m) continue;
        if (Number(m[1]) !== facts.foundationYear) {
          const bucket = counts[level];
          bucket.set(m[1], (bucket.get(m[1]) ?? 0) + 1);
        }
        return;  // strongest match wins; one claim per unit of text
      }
    }
  };

  const isLabel = (l: string) => /^\s*[-*]?\s*(founded|established|kuruluş|kurulus)\s*:/i.test(l);
  for (const line of text.split(/\r?\n/)) if (isLabel(line)) record(line);
  for (const sentence of text.split(/(?<=[.!?])\s+|\n{2,}/)) {
    if (isLabel(sentence)) continue;  // already counted above
    const lower = sentence.toLowerCase();
    if (brands.some((b) => lower.includes(b))) record(sentence);
  }

  for (const [confidence, bucket] of [["CONFIRMED", counts.CONFIRMED], ["CANDIDATE", counts.CANDIDATE]] as const) {
    for (const [year, n] of bucket) {
      out.push({
        confidence,
        message: confidence === "CONFIRMED"
          ? `states founding year ${year} in ${n} place(s); the registry's owner-confirmed year is ${facts.foundationYear}`
          : `says "since ${year}" about the brand in ${n} place(s) — read these: a "since" date can be a genuine founding claim or an unrelated milestone, and the confirmed founding year is ${facts.foundationYear}`,
      });
    }
  }
  return out;
}

export interface LlmsTxtSite {
  id: string; domain: string; onboardingStatus: string;
  foundationYear: number | null; brandEntities: string[];
}

export async function inspectLlmsTxt(
  site: LlmsTxtSite,
  opts: { timeoutMs?: number; userAgent?: string } = {},
): Promise<LlmsTxtResult> {
  const o = { timeoutMs: opts.timeoutMs ?? 15000, userAgent: opts.userAgent ?? DEFAULT_OPTIONS.userAgent };
  const origin = /^https?:\/\//.test(site.domain) ? site.domain.replace(/\/$/, "") : `https://${site.domain}`;

  const base: LlmsTxtResult = {
    siteId: site.id, domain: site.domain, onboardingStatus: site.onboardingStatus,
    present: false, status: 0, bytes: 0, tokensLow: 0, tokensHigh: 0, spec: null,
    full: { present: false, status: 0, bytes: 0, tokensLow: 0, tokensHigh: 0 },
    contradictions: [], issues: [],
  };

  const page = await fetchPage(`${origin}/llms.txt`, o);
  if (page.status === 0) return { ...base, error: page.error ?? "unreachable" };
  base.status = page.status;

  const fullPage = await fetchPage(`${origin}/llms-full.txt`, o);
  base.full.status = fullPage.status;
  if (fullPage.status === 200 && fullPage.body) {
    const t = tokens(fullPage.body.length);
    base.full = { present: true, status: 200, bytes: fullPage.body.length, tokensLow: t.low, tokensHigh: t.high };
  }

  if (page.status !== 200 || !page.body) {
    // Absence is a finding, not a failure: on the published evidence it costs nothing.
    base.issues.push(`no llms.txt served (HTTP ${page.status}) — on the published evidence this costs nothing in Google Search or AI citation`);
    if (base.full.present) base.issues.push(`but llms-full.txt IS served (${base.full.bytes.toLocaleString()} chars) with no llms.txt indexing it`);
    return base;
  }

  const text = page.body;
  const t = tokens(text.length);
  base.present = true; base.bytes = text.length; base.tokensLow = t.low; base.tokensHigh = t.high;
  const spec = parseLlmsTxt(text);
  base.spec = spec;
  base.contradictions = findContradictions(text, { foundationYear: site.foundationYear, brandEntities: site.brandEntities });

  if (!spec.h1) base.issues.push("no H1 — the only element the specification requires");
  if (!spec.summary) base.issues.push("no blockquote summary directly under the H1 (optional, but it is the one place a reader gets oriented)");
  if (!spec.linkCount) base.issues.push("no markdown links — the file's actual payload is a link index, and this one indexes nothing");

  // Size is the real constraint, because the file competes for a context window.
  if (t.high > 10000) {
    const prosePct = Math.round((spec.proseChars / text.length) * 100);
    base.issues.push(`large for an index: ~${t.low.toLocaleString()}–${t.high.toLocaleString()} tokens, ${prosePct}% of it prose rather than links`);
  }
  if (spec.questionCount >= 20) {
    base.issues.push(`${spec.questionCount} question headings — this has stopped being an index and become a second website that no tool validates`);
  }
  if (base.full.present && base.full.tokensHigh > 100000) {
    base.issues.push(`llms-full.txt is ~${base.full.tokensLow.toLocaleString()}–${base.full.tokensHigh.toLocaleString()} tokens: no assistant loads that whole, so its real behaviour is "an unpredictable prefix gets read"`);
  }

  return base;
}

export async function inspectPortfolio(
  sites: LlmsTxtSite[],
  opts: { timeoutMs?: number; userAgent?: string } = {},
  log: (s: string) => void = () => {},
): Promise<LlmsTxtResult[]> {
  const out: LlmsTxtResult[] = [];
  for (const s of sites) {
    log(`— ${s.id} (${s.domain})`);
    try { out.push(await inspectLlmsTxt(s, opts)); }
    catch (e) {
      out.push({
        siteId: s.id, domain: s.domain, onboardingStatus: s.onboardingStatus,
        present: false, status: 0, bytes: 0, tokensLow: 0, tokensHigh: 0, spec: null,
        full: { present: false, status: 0, bytes: 0, tokensLow: 0, tokensHigh: 0 },
        contradictions: [], issues: [], error: String((e as Error).message ?? e),
      });
    }
  }
  return out;
}

export function llmsTxtToMarkdown(results: LlmsTxtResult[], now = new Date()): string {
  const L: string[] = [
    `# llms.txt inventory — ${now.toISOString().slice(0, 10)}`,
    "",
    "Read-only. Each site's `/llms.txt` and `/llms-full.txt` were fetched and parsed against",
    "the specification. Nothing was changed.",
    "",
    "Context for reading this: the published evidence says these files are almost never",
    "requested, and Google states it ignores them. See `policies/references/llms-txt.md`.",
    "A contradiction below is therefore the finding that matters — an unvalidated second copy",
    "of the brand's facts that has drifted from the site.",
    "",
    "| Site | llms.txt | Tokens | Links | Questions | llms-full.txt | Contradictions |",
    "|---|---|---|---|---|---|---|",
  ];
  for (const r of results) {
    const size = r.present ? `~${r.tokensLow.toLocaleString()}–${r.tokensHigh.toLocaleString()}` : "—";
    const full = r.full.present ? `~${r.full.tokensLow.toLocaleString()}–${r.full.tokensHigh.toLocaleString()}` : r.full.status === 404 ? "no" : `HTTP ${r.full.status}`;
    L.push(`| ${r.siteId} | ${r.present ? "yes" : `no (HTTP ${r.status})`} | ${size} | ${r.spec?.linkCount ?? "—"} `
      + `| ${r.spec?.questionCount ?? "—"} | ${full} | ${r.contradictions.filter((c) => c.confidence === "CONFIRMED").length || "—"}${r.contradictions.some((c) => c.confidence === "CANDIDATE") ? ` (+${r.contradictions.filter((c) => c.confidence === "CANDIDATE").length} review)` : ""} |`);
  }
  for (const r of results) {
    if (!r.issues.length && !r.contradictions.length && !r.error) continue;
    L.push("", `### ${r.siteId}`);
    if (r.error) L.push(`- ERROR: ${r.error}`);
    for (const c of r.contradictions) L.push(`- **${c.confidence === "CONFIRMED" ? "CONTRADICTION" : "REVIEW"}** — ${c.message}`);
    for (const i of r.issues) L.push(`- ${i}`);
    if (r.spec?.sections.length) L.push(`- sections: ${r.spec.sections.join(" · ")}`);
  }
  return L.join("\n");
}
