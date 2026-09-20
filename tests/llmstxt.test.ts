// The contradiction check is the load-bearing part of this inventory: a file nothing reads
// still costs something the moment it disagrees with the site it describes. Its failure mode
// is noise, so most of these tests are about what must NOT be reported.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLlmsTxt, findContradictions, llmsTxtToMarkdown, type LlmsTxtResult, type RegistryFacts } from "../src/llmstxt.ts";

test("parses the shape the specification defines", () => {
  const f = [
    "# PAM Istanbul",
    "",
    "> A production company in Istanbul.",
    "",
    "## Main pages",
    "",
    "- [Home](https://x.com/): the homepage",
    "- [Services](https://x.com/services): what we do",
    "",
    "## Frequently asked questions",
    "",
    "### Telif kime aittir?",
    "",
    "Cevap.",
    "",
    "### Ticari kullanım mümkün mü?",
    "",
    "Cevap.",
    "",
    "## Optional",
    "",
    "- [Archive](https://x.com/archive)",
  ].join("\n");
  const s = parseLlmsTxt(f);
  assert.equal(s.h1, "PAM Istanbul");
  assert.equal(s.summary, true);
  assert.deepEqual(s.sections, ["Main pages", "Frequently asked questions", "Optional"]);
  assert.equal(s.linkCount, 3);
  assert.equal(s.questionCount, 2);
  assert.equal(s.optionalSection, true);
});

test("a missing H1 and a non-blockquote opener are both detected", () => {
  const s = parseLlmsTxt("Some text\n\n## Links\n\n- [a](https://x.com/a)\n");
  assert.equal(s.h1, null, "the H1 is the only required element");
  assert.equal(s.summary, false);

  // A paragraph under the H1 is not the spec's blockquote summary.
  assert.equal(parseLlmsTxt("# Name\n\nPlain paragraph.\n").summary, false);
});

test("a heading is only a question when it ends in a question mark", () => {
  const s = parseLlmsTxt("# N\n\n### Telif kime aittir?\n\n### Hizmetlerimiz\n\n### What is AEO?\n");
  assert.equal(s.questionCount, 2);
});

const FACTS: RegistryFacts = { foundationYear: 2018, brandEntities: ["PAM İstanbul", "PAM Istanbul"] };
const msgs = (t: string, f: RegistryFacts = FACTS) =>
  findContradictions(t, f).map((c) => `${c.confidence}: ${c.message}`);

test("a wrong founding year is caught in both word orders", () => {
  // English puts the verb first, Turkish puts the year first. Matching one direction only
  // silently passes half of a bilingual site.
  const en = msgs("PAM Istanbul, founded in 2017, produces films.");
  assert.equal(en.length, 1);
  assert.match(en[0], /^CONFIRMED/);
  assert.match(en[0], /2017/);
  assert.match(en[0], /2018/);

  assert.match(msgs("PAM İstanbul 2017 yılında kuruldu.")[0], /^CONFIRMED/);

  // A field label needs no brand name on the line: it is about the file's own subject.
  assert.match(msgs("- Founded: 2017")[0], /^CONFIRMED/);
});

test("`since` is a CANDIDATE, because it is often not a founding claim at all", () => {
  // Real sentence from the pilot's own llms-full.txt. Reporting it as a founding-year defect
  // would be wrong: it says when AI entered the workflow, not when the company started.
  const ai = msgs("The PAM Istanbul approach: we have been integrating AI into the production workflow since 2023.");
  assert.equal(ai.length, 1);
  assert.match(ai[0], /^CANDIDATE/);

  assert.match(msgs("PAM Istanbul has produced work since 2017.")[0], /^CANDIDATE/);
  assert.match(msgs("PAM İstanbul 2017'den beri üretiyor.")[0], /^CANDIDATE/);
});

test("another company's founding year is not ours", () => {
  // llms-full.txt carries article bodies about other companies, and a first version of this
  // check reported five of them as contradictions.
  assert.deepEqual(msgs("Photoroom was founded in Germany in 2024."), []);
  // The claim must share a sentence with a brand name, so a neighbouring sentence cannot leak.
  assert.deepEqual(msgs("PAM Istanbul shoots in Istanbul.\n\nMidjourney has been available since 2022."), []);
});

test("the correct year, unrelated years, and missing facts produce nothing", () => {
  assert.deepEqual(msgs("PAM Istanbul, founded in 2018."), []);
  assert.deepEqual(
    msgs("PAM Istanbul · AI Görsel Üretim Rehberi 2026 · ai-rehberi-2026"), [],
    "`beri` inside `rehberi` is not a founding claim — this produced 7 false positives on the real file",
  );
  assert.deepEqual(
    msgs("PAM Istanbul, founded in 2017.", { foundationYear: null, brandEntities: ["PAM Istanbul"] }), [],
    "no confirmed year means nothing can be checked",
  );
  assert.deepEqual(
    msgs("PAM Istanbul, founded in 2017.", { foundationYear: 2018, brandEntities: [] }), [],
    "no brand name means no way to tell whose founding is described",
  );
});

test("repeated wrong claims are counted, not listed one by one", () => {
  const out = msgs("PAM Istanbul, founded in 2017.\n\n- Founded: 2017\n\nPAM İstanbul 2017 yılında kuruldu.");
  assert.equal(out.length, 1);
  assert.match(out[0], /3 place/);
});

const r = (over: Partial<LlmsTxtResult>): LlmsTxtResult => ({
  siteId: "s", domain: "s.com", onboardingStatus: "active", present: false, status: 404,
  bytes: 0, tokensLow: 0, tokensHigh: 0, spec: null,
  full: { present: false, status: 404, bytes: 0, tokensLow: 0, tokensHigh: 0 },
  contradictions: [], issues: [], ...over,
});

test("the report separates a confirmed defect from something to read", () => {
  const md = llmsTxtToMarkdown([
    r({ siteId: "a", contradictions: [
      { confidence: "CONFIRMED", message: "states founding year 2017 in 3 place(s); the registry's owner-confirmed year is 2018" },
      { confidence: "CANDIDATE", message: 'says "since 2023" about the brand in 1 place(s)' },
    ] }),
    r({ siteId: "b" }),
  ], new Date("2026-09-20T00:00:00Z"));
  assert.match(md, /\*\*CONTRADICTION\*\*/);
  assert.match(md, /\*\*REVIEW\*\*/, "a CANDIDATE must not be presented as a confirmed defect");
  assert.match(md, /Google states it ignores them/);
});
