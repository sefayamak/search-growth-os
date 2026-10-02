// Icerik firsati + editor hatti durum modeli (sgos.content-item.v1).
//
// Bu modul YAZMAZ, yayinlamaz, ag kullanmaz: yalniz bir icerik kaydinin gecerli olup olmadigini
// ve bir asamadan digerine gecisin izinli olup olmadigini soyler. Sistemin "olcer, insan merge eder"
// kuralini kod seviyesinde tutar: taslak govdesi kayitta YOKTUR (yalniz dosya referansi), onay
// insan adidir ve hicbir zaman varsayilmaz.
import type { Confidence, EvidenceLabel, OpportunitySource } from "./types.ts";
import type { SiteEntry } from "./registry.ts";

export const CONTENT_ITEM_SCHEMA = "sgos.content-item.v1";

/** Sira anlamlidir: gecis yalniz bir sonraki asamaya. Atlama yok, geri donus yok. */
export const STAGES = [
  "GSC_EVIDENCE", "OPPORTUNITY", "CLASSIFICATION", "DRAFT", "REVIEW", "PR",
  "HUMAN_APPROVAL", "MERGE", "DEPLOYMENT_VERIFICATION", "LATER_MEASUREMENT",
] as const;
export type Stage = (typeof STAGES)[number];
export const CLASSIFICATIONS = ["new_page", "refresh", "consolidate", "skip"] as const;
export type Classification = (typeof CLASSIFICATIONS)[number];

// Evidence ontolojisi tam alti etiket; EDITORIAL buraya GIRMEZ (kaynak ayri eksen).
const LABELS: readonly EvidenceLabel[] = ["FACT", "INFERENCE", "HYPOTHESIS", "RECOMMENDATION", "IMPLEMENTED_CHANGE", "VERIFIED_RESULT"];
const CONFIDENCES: readonly Confidence[] = ["CONFIRMED", "CANDIDATE", "FALSE_POSITIVE", "UNKNOWN"];
/** CONFIRMED yalniz olculmus/uygulanmis seyler icin: cikarim tekrarla onaylanmis olmaz. */
const CONFIRMABLE: readonly EvidenceLabel[] = ["FACT", "IMPLEMENTED_CHANGE", "VERIFIED_RESULT"];

export type Metric = number | "UNKNOWN";
export interface GscRow {
  /** Satirin hangi siteye ait oldugu. Kirlenme korumasi bunu item.site ile karsilastirir. */
  site: string;
  query?: string;
  page?: string;
  impressions: Metric; clicks: Metric; position: Metric;
  source: "gsc";
  date_start: string; date_end: string;
}
export interface ContentItem {
  schema: typeof CONTENT_ITEM_SCHEMA;
  site: string;
  id: string;
  opportunity_source: OpportunitySource;
  gsc_rows: GscRow[];
  classification: Classification;
  stage: Stage;
  evidence_label: EvidenceLabel;
  confidence: Confidence;
  /** Taslak GOVDESI degil, yalniz repo-ici dosya yolu: sites/<site>/drafts/... */
  draft_ref?: string;
  approval: { state: "pending" | "approved" | "rejected"; approver: string | null; approved_at?: string };
  risk: "low" | "medium" | "high";
  pr?: { url: string; draft: boolean; merged_at?: string; deployed_at?: string };
  expected_change?: { text: string; test: string };
}

export type SiteRef = Pick<SiteEntry, "id" | "onboarding_status" | "production_domain">;
export interface Check { ok: boolean; errors: string[] }

const KEYS = ["schema", "site", "id", "opportunity_source", "gsc_rows", "classification", "stage", "evidence_label", "confidence", "draft_ref", "approval", "risk", "pr", "expected_change"];
const ROW_KEYS = ["site", "query", "page", "impressions", "clicks", "position", "source", "date_start", "date_end"];
const idx = (s: string) => (STAGES as readonly string[]).indexOf(s);
const ISO = /^\d{4}-\d{2}-\d{2}$/;
// Bir bot/varsayilan ad "insan onayi" sayilmaz; onay alani bir otomasyonun doldurabilecegi bir deger olmamali.
const NON_HUMAN = /^(unknown|none|null|n\/a|default|auto|system|bot|claude|github-actions|dependabot|ci)\b|\[bot\]|claude|noreply/i;
// Editoryal fikir talep/hacim iddiasi tasiyamaz (iki dil).
const DEMAND_CLAIM = /impression|gösterim|search volume|arama hacm|monthly searches|aylık arama|\bdemand\b|\btalep\b|\bCTR\b|ranking #|\d+\s*%|%\s*\d+/i;

const isMetric = (v: unknown) => v === "UNKNOWN" || (typeof v === "number" && Number.isFinite(v) && v >= 0);

/** Sayfa URL'sinin hostu bu sitenin domain'i mi (apex ya da subdomain)? */
export function pageBelongsToSite(page: string, site: SiteRef): boolean {
  let host: string;
  try { host = new URL(page).hostname.toLowerCase(); } catch { return false; }
  const d = site.production_domain.toLowerCase();
  return host === d || host.endsWith(`.${d}`);
}

export function validateRow(row: unknown, site: SiteRef): string[] {
  if (!row || typeof row !== "object" || Array.isArray(row)) return ["ROW_NOT_OBJECT"];
  const r = row as Record<string, unknown>;
  const e: string[] = [];
  for (const k of Object.keys(r)) if (!ROW_KEYS.includes(k)) e.push(`ROW_UNKNOWN_KEY:${k}`);
  if (r.site !== site.id) e.push(`CROSS_SITE_ROW:${String(r.site)}!=${site.id}`);
  if (r.source !== "gsc") e.push("ROW_SOURCE_NOT_GSC");
  if (!(typeof r.query === "string" && r.query.trim()) && !(typeof r.page === "string" && r.page)) e.push("ROW_NEEDS_QUERY_OR_PAGE");
  if (typeof r.page === "string" && !pageBelongsToSite(r.page, site)) e.push("ROW_PAGE_FOREIGN_DOMAIN");
  for (const m of ["impressions", "clicks", "position"]) if (!isMetric(r[m])) e.push(`ROW_BAD_${m.toUpperCase()}`);
  if (typeof r.position === "number" && r.position < 1) e.push("ROW_POSITION_BELOW_1");
  if (typeof r.clicks === "number" && typeof r.impressions === "number" && r.clicks > r.impressions) e.push("ROW_CLICKS_GT_IMPRESSIONS");
  for (const d of ["date_start", "date_end"]) if (typeof r[d] !== "string" || !ISO.test(r[d] as string)) e.push(`ROW_BAD_${d.toUpperCase()}`);
  if (typeof r.date_start === "string" && typeof r.date_end === "string" && ISO.test(r.date_start) && ISO.test(r.date_end) && r.date_start > r.date_end) e.push("ROW_DATE_ORDER");
  return e;
}

/** Kaydi dogrular. `registry` kayitli siteler: kayit yalniz KENDI sitesinin girdisine karsi kontrol edilir. */
export function validateItem(item: unknown, registry: readonly SiteRef[]): Check {
  if (!item || typeof item !== "object" || Array.isArray(item)) return { ok: false, errors: ["NOT_OBJECT"] };
  const it = item as Record<string, any>;
  const e: string[] = [];
  // Bilinmeyen anahtar reddedilir: "draft_body" gibi bir alan sessizce tasinamaz (taslak asla yayinlanmaz).
  for (const k of Object.keys(it)) if (!KEYS.includes(k)) e.push(`UNKNOWN_KEY:${k}`);
  if (it.schema !== CONTENT_ITEM_SCHEMA) e.push("BAD_SCHEMA");
  if (typeof it.id !== "string" || !/^[a-z0-9][a-z0-9._-]{2,95}$/.test(it.id)) e.push("BAD_ID");
  const site = registry.find((s) => s.id === it.site);
  if (!site) return { ok: false, errors: [...e, `SITE_NOT_IN_REGISTRY:${String(it.site)}`] };
  // Olcum her kayitli site icin olur, tavsiye/icerik hatti yalniz onboard edilmis site icin.
  if (site.onboarding_status === "registered_not_onboarded") e.push("SITE_NOT_ONBOARDED");
  if (it.opportunity_source !== "gsc_evidence" && it.opportunity_source !== "editorial") e.push("BAD_OPPORTUNITY_SOURCE");
  if (idx(it.stage) < 0) e.push("BAD_STAGE");
  if (!(CLASSIFICATIONS as readonly string[]).includes(it.classification)) e.push("BAD_CLASSIFICATION");
  if (!LABELS.includes(it.evidence_label)) e.push("BAD_EVIDENCE_LABEL");
  if (!CONFIDENCES.includes(it.confidence)) e.push("BAD_CONFIDENCE");
  if (!["low", "medium", "high"].includes(it.risk)) e.push("BAD_RISK");
  if (it.confidence === "CONFIRMED" && !CONFIRMABLE.includes(it.evidence_label)) e.push("INFERENCE_REPORTED_AS_CONFIRMED");

  const rows: unknown[] = Array.isArray(it.gsc_rows) ? it.gsc_rows : (e.push("GSC_ROWS_NOT_ARRAY"), []);
  rows.forEach((r, i) => validateRow(r, site).forEach((x) => e.push(`gsc_rows[${i}]:${x}`)));
  if (it.opportunity_source === "gsc_evidence" && rows.length < 1) e.push("GSC_ITEM_WITHOUT_GSC_ROW");
  if (it.opportunity_source === "editorial") {
    // Editoryal fikir arama sinyali OLMADIGINI soyler; satir ya da talep dili tasirsa kanitli gibi okunur.
    if (rows.length) e.push("EDITORIAL_CARRIES_GSC_ROWS");
    if (it.expected_change && DEMAND_CLAIM.test(String(it.expected_change.text))) e.push("EDITORIAL_DEMAND_CLAIM");
    if (it.evidence_label === "FACT" || it.evidence_label === "VERIFIED_RESULT") e.push("EDITORIAL_LABEL_TOO_STRONG");
  }
  // Olculmus gosterimi olmayan kanittan refresh/consolidate/new_page iddiasi tasinamaz.
  if (it.opportunity_source === "gsc_evidence" && rows.length && rows.every((r: any) => r?.impressions === "UNKNOWN") && it.classification !== "skip") e.push("CLASSIFIED_WITHOUT_MEASURED_IMPRESSIONS");

  const ec = it.expected_change;
  if (ec !== undefined && (typeof ec?.text !== "string" || !ec.text.trim() || typeof ec?.test !== "string" || !ec.test.trim())) e.push("EXPECTED_CHANGE_NEEDS_TEXT_AND_TEST");
  if (it.evidence_label === "HYPOTHESIS" && ec === undefined) e.push("HYPOTHESIS_WITHOUT_TEST");

  const a = it.approval;
  if (!a || !["pending", "approved", "rejected"].includes(a.state)) e.push("BAD_APPROVAL");
  else {
    const si = idx(it.stage);
    const approved = a.state === "approved";
    if (approved && (typeof a.approver !== "string" || !a.approver.trim() || NON_HUMAN.test(a.approver) || typeof a.approved_at !== "string")) e.push("APPROVAL_WITHOUT_HUMAN_APPROVER");
    if (!approved && a.approver) e.push("APPROVER_SET_WITHOUT_APPROVAL");
    if (si >= idx("HUMAN_APPROVAL") && !approved) e.push("STAGE_REQUIRES_APPROVAL");
    if (si >= 0 && si < idx("HUMAN_APPROVAL") && approved) e.push("APPROVED_BEFORE_APPROVAL_STAGE");
  }

  if (it.draft_ref !== undefined) {
    const d = it.draft_ref;
    // Yalniz bu sitenin taslak dizini; govde/HTML tasimaz, baska sitenin dizinine isaret edemez.
    if (typeof d !== "string" || d.length > 300 || /[\n<>]/.test(d) || d.includes("..") || !d.startsWith(`sites/${site.id}/drafts/`)) e.push("BAD_DRAFT_REF");
  }
  if (it.classification === "skip" && idx(it.stage) > idx("CLASSIFICATION")) e.push("SKIP_ITEM_PAST_CLASSIFICATION");
  if (idx(it.stage) >= idx("DRAFT") && it.draft_ref === undefined) e.push("STAGE_REQUIRES_DRAFT_REF");
  if (it.pr !== undefined && (typeof it.pr.url !== "string" || it.pr.draft !== true)) e.push("PR_MUST_BE_DRAFT");
  if (idx(it.stage) >= idx("PR") && !it.pr) e.push("STAGE_REQUIRES_PR");
  if (idx(it.stage) >= idx("DEPLOYMENT_VERIFICATION") && !it.pr?.merged_at) e.push("STAGE_REQUIRES_MERGED_AT");
  if (idx(it.stage) >= idx("LATER_MEASUREMENT") && !it.pr?.deployed_at) e.push("STAGE_REQUIRES_DEPLOYED_AT");
  return { ok: e.length === 0, errors: e };
}

/** Yalniz bir sonraki asamaya gecis; hedef asamanin on kosullari ayni dogrulayicidan gecer. */
export function validateTransition(item: ContentItem, to: Stage, registry: readonly SiteRef[]): Check {
  const from = idx(item.stage), target = idx(to);
  const e: string[] = [];
  if (target < 0) return { ok: false, errors: ["BAD_TARGET_STAGE"] };
  if (target <= from) e.push("BACKWARD_OR_SAME_TRANSITION");
  else if (target > from + 1) e.push("SKIPPED_STAGE");
  const v = validateItem({ ...item, stage: to }, registry);
  for (const x of v.errors) if (x.startsWith("STAGE_REQUIRES") || x.includes("APPROV") || x.startsWith("SKIP_ITEM")) e.push(`TARGET:${x}`);
  return { ok: e.length === 0, errors: e };
}

/** Bir satiri bir kayda ekler; baska siteye ait satiri REDDEDER (atar). Kayit degismez, yenisi doner. */
export function attachRow(item: ContentItem, row: GscRow, registry: readonly SiteRef[]): ContentItem {
  const site = registry.find((s) => s.id === item.site);
  if (!site) throw new Error(`SITE_NOT_IN_REGISTRY:${item.site}`);
  const errs = validateRow(row, site);
  if (errs.length) throw new Error(`ROW_REJECTED:${errs.join(",")}`);
  if (item.opportunity_source === "editorial") throw new Error("EDITORIAL_CARRIES_GSC_ROWS");
  return { ...item, gsc_rows: [...item.gsc_rows, row] };
}

export interface Classified { classification: Classification; evidence_label: EvidenceLabel; confidence: Confidence; reason: string; rows_used: number; rows_unknown: number }
export const MIN_IMPRESSIONS = 50;

/** Kanittan siniflandirma. Cikti her zaman INFERENCE'tir ve CONFIRMED OLAMAZ: esikler bir kural, olcum degil. */
export function classifyFromEvidence(rows: readonly GscRow[]): Classified {
  const usable = rows.filter((r) => typeof r.impressions === "number" && typeof r.position === "number" && r.impressions >= MIN_IMPRESSIONS);
  const base = { evidence_label: "INFERENCE" as const, rows_used: usable.length, rows_unknown: rows.length - usable.length };
  if (!usable.length) return { ...base, classification: "skip", confidence: "UNKNOWN", reason: rows.length ? `${rows.length} satir var ama hicbiri yeterli olculmus gosterim tasimiyor (esik ${MIN_IMPRESSIONS}; UNKNOWN sayilir)` : "kanit satiri yok" };
  // Ayni sorgu birden fazla sayfada gosterim aliyorsa: kanibalizasyon adayi.
  const byQuery = new Map<string, Set<string>>();
  for (const r of usable) {
    if (!r.query || !r.page) continue;
    const k = r.query.toLowerCase();
    if (!byQuery.has(k)) byQuery.set(k, new Set());
    byQuery.get(k)!.add(r.page);
  }
  if ([...byQuery.values()].some((s) => s.size >= 2)) return { ...base, classification: "consolidate", confidence: "CANDIDATE", reason: "ayni sorgu >=2 sayfada gosterim aliyor (kanibalizasyon adayi)" };
  const best = Math.min(...usable.map((r) => r.position as number));
  if (best >= 8 && best <= 20) return { ...base, classification: "refresh", confidence: "CANDIDATE", reason: `en iyi pozisyon ${best} (8-20) ve gosterim var: yenileme adayi` };
  if (best < 8) return { ...base, classification: "skip", confidence: "CANDIDATE", reason: `pozisyon ${best} < 8: zaten ust sirada, bu hat icin acik firsat yok` };
  return { ...base, classification: "new_page", confidence: "CANDIDATE", reason: `en iyi pozisyon ${best} > 20: mevcut sayfa karsilamiyor olabilir, yeni sayfa adayi` };
}
