// Deterministik yonlendirici. Model SECMEZ: hangi uzmanin cagrilacagi kanitin kaynak/kategorisinden
// ve kullanilabilir olup olmadigindan cikar. Sonuc hep ayni girdi icin ayni.
//
// Kurallar:
//   * Yalniz KULLANILABILIR kanit (MEASURED/PARTIAL/RECORDED) bir ajani tetikler. NOT_CONNECTED /
//     ERROR / NOT_AVAILABLE kanit ajan cagirmaz: veri yokken "analiz" uydurulmaz.
//   * REGISTRY kanit baglamdir, hicbir uzmani tetiklemez. Registry'deki competitor_set ADLARI
//     rakip KANITI degildir: competitor ajani yalniz source/category COMPETITOR olcumu varsa calisir.
//   * En fazla MAX_SPECIALISTS uzman; fazlasi SPECIALIST_CAP olarak kaydedilir, sessizce atilmaz.
import { MAX_SPECIALISTS, type AgentConsidered, type EvidenceEnvelope, type SpecialistId } from "./contracts.ts";
import { isUsable } from "./evidence.ts";

/** Sabit oncelik: kota dolarsa hangisinin kesilecegi tartisma konusu degil. */
const PRIORITY: SpecialistId[] = [
  "technical-search-auditor",
  "search-measurement-scientist",
  "content-evidence-strategist",
  "search-performance-engineer",
  "aeo-geo-strategist",
  "entity-structured-data-specialist",
  "competitor-intelligence-analyst",
];

function specialistsFor(e: EvidenceEnvelope): { agent: SpecialistId; reason: string }[] {
  const r: { agent: SpecialistId; reason: string }[] = [];
  const add = (agent: SpecialistId, reason: string) => r.push({ agent, reason });
  if (e.source === "GSC" || e.source === "GA4" || e.category === "SEARCH_PERFORMANCE") add("search-measurement-scientist", `${e.source} olcumu`);
  if (e.category === "CONTENT_OPPORTUNITY") add("content-evidence-strategist", `${e.source} icerik firsati`);
  // Clarity yalniz davranis/performans uzmanini tetikler; olcum bilimcisi GSC/GA4 ile zaten gelir.
  if (e.source === "CLARITY") add("search-performance-engineer", "Clarity davranis kanıtı");
  // Schema/entity kaniti CRAWL'dan gelse de teknik denetciye degil entity uzmanina gider; ikisini birden tetiklemek kotayi bosa yer.
  if (e.source === "INDEX" || e.category === "TECHNICAL" || e.category === "INDEXING" || (e.source === "CRAWL" && e.category !== "STRUCTURED_DATA")) add("technical-search-auditor", `${e.source} teknik/indeks kanıtı`);
  if (e.category === "STRUCTURED_DATA") add("entity-structured-data-specialist", "yapilandirilmis veri/entity kanıtı");
  if (e.source === "AI_VISIBILITY" || e.category === "AI_VISIBILITY") add("aeo-geo-strategist", "AI gorunurluk kanıtı");
  if (e.source === "COMPETITOR" || e.category === "COMPETITOR") add("competitor-intelligence-analyst", "rakip olcum kanıtı");
  return r;
}

export interface RoutePlan {
  specialists: SpecialistId[];
  /** Her uzmanin gorecegi kanit kimlikleri (yalniz ilgili kanit). */
  evidence_for: Map<SpecialistId, string[]>;
  considered: AgentConsidered[];
}

export function routeAgents(evidence: readonly EvidenceEnvelope[]): RoutePlan {
  const wanted = new Map<SpecialistId, { ids: string[]; reason: string }>();
  for (const e of evidence) {
    if (!isUsable(e)) continue;
    for (const { agent, reason } of specialistsFor(e)) {
      const w = wanted.get(agent) ?? { ids: [], reason };
      w.ids.push(e.evidence_id);
      wanted.set(agent, w);
    }
  }
  const ordered = PRIORITY.filter((a) => wanted.has(a));
  const chosen = ordered.slice(0, MAX_SPECIALISTS);
  const considered: AgentConsidered[] = [];
  for (const a of PRIORITY) {
    if (chosen.includes(a)) considered.push({ agent_id: a, decision: "CALLED", reason: wanted.get(a)!.reason });
    else if (wanted.has(a)) considered.push({ agent_id: a, decision: "SPECIALIST_CAP", reason: `en fazla ${MAX_SPECIALISTS} uzman; kanit vardi (${wanted.get(a)!.reason})` });
    else considered.push({ agent_id: a, decision: "NOT_ROUTED", reason: "bu ajani tetikleyecek kullanilabilir kanit yok" });
  }
  const evidence_for = new Map<SpecialistId, string[]>();
  for (const a of chosen) evidence_for.set(a, [...new Set(wanted.get(a)!.ids)]);
  return { specialists: chosen, evidence_for, considered };
}
