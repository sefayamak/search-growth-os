// Icerik firsati + editor hatti durum modeli (sgos.content-item.v1).
//
// Bu modul YAZMAZ, yayinlamaz, ag kullanmaz: yalniz bir icerik kaydinin gecerli olup olmadigini
// ve bir asamadan digerine gecisin izinli olup olmadigini soyler. Sistemin "olcer, insan merge eder"
// kuralini kod seviyesinde tutar: taslak govdesi kayitta YOKTUR (yalniz dosya referansi), onay
// insan adidir ve hicbir zaman varsayilmaz.
import { readFileSync } from "node:fs";
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

/** Politika kaynagi KANIT etiketi degildir: ayri eksen. Alti kanit etiketi degismez; burada yeni etiket yok. */
export interface PolicyProvenance { origin: "policy"; status: "DEFAULT_ASSUMPTION" | "OWNER_SET"; set_by: string; note: string }
export interface ContentPolicyValues {
  min_impressions: number;
  refresh_position_min: number;
  refresh_position_max: number;
  /** Kanibalizasyon adayi icin ayni sorgunun gosterim aldigi en az sayfa sayisi. */
  consolidate_min_pages: number;
}
export interface ContentPolicy extends ContentPolicyValues { provenance: PolicyProvenance }
/** Disaridan gelen (kismi olabilir) politika girdisi. `require_policy`: varsayilana dusme, skip/UNKNOWN don. */
export interface ContentPolicyInput extends Partial<ContentPolicyValues> { provenance?: Partial<PolicyProvenance>; require_policy?: boolean }

// Bu sayilar olcum degil, baslangic VARSAYIMIDIR; sahibi degistirebilir. Kanit etiketi/guveni etkilemez.
export const DEFAULT_CONTENT_POLICY: Readonly<ContentPolicy> = Object.freeze({
  min_impressions: 50, refresh_position_min: 8, refresh_position_max: 20, consolidate_min_pages: 2,
  provenance: Object.freeze({ origin: "policy" as const, status: "DEFAULT_ASSUMPTION" as const, set_by: "unset", note: "Esikler (50 gosterim, pozisyon 8-20, >=2 sayfa) olculmus degil, baslangic varsayimi; sahibi belirlemedi." }),
});
export const MIN_IMPRESSIONS = DEFAULT_CONTENT_POLICY.min_impressions;

const VALUE_KEYS = ["min_impressions", "refresh_position_min", "refresh_position_max", "consolidate_min_pages"] as const;
const POLICY_KEYS = [...VALUE_KEYS, "provenance", "require_policy"];
const PROV_KEYS = ["origin", "status", "set_by", "note"];
const num = (v: unknown, min: number) => typeof v === "number" && Number.isFinite(v) && v >= min;

export type PolicyResolution =
  | { ok: true; policy: ContentPolicy; defaulted: boolean; require_policy: boolean }
  | { ok: false; errors: string[] };

/** Politikayi dogrular ve eksik alanlari varsayilanla tamamlar. Gecersiz deger SESSIZCE duzeltilmez: reddedilir. */
export function resolvePolicy(input?: unknown): PolicyResolution {
  if (input === undefined || input === null) return { ok: true, policy: { ...DEFAULT_CONTENT_POLICY }, defaulted: true, require_policy: false };
  if (typeof input !== "object" || Array.isArray(input)) return { ok: false, errors: ["POLICY_NOT_OBJECT"] };
  const p = input as Record<string, unknown>;
  const e: string[] = [];
  for (const k of Object.keys(p)) if (!POLICY_KEYS.includes(k)) e.push(`POLICY_UNKNOWN_KEY:${k}`);
  if (p.require_policy !== undefined && typeof p.require_policy !== "boolean") e.push("POLICY_BAD_REQUIRE_POLICY");
  if (p.min_impressions !== undefined && !num(p.min_impressions, 0)) e.push("POLICY_BAD_MIN_IMPRESSIONS");
  for (const k of ["refresh_position_min", "refresh_position_max"] as const) if (p[k] !== undefined && !num(p[k], 1)) e.push(`POLICY_BAD_${k.toUpperCase()}`);
  if (p.consolidate_min_pages !== undefined && !(num(p.consolidate_min_pages, 2) && Number.isInteger(p.consolidate_min_pages))) e.push("POLICY_BAD_CONSOLIDATE_MIN_PAGES");
  let prov: Record<string, unknown> | undefined;
  if (p.provenance !== undefined) {
    if (!p.provenance || typeof p.provenance !== "object" || Array.isArray(p.provenance)) e.push("POLICY_BAD_PROVENANCE");
    else {
      prov = p.provenance as Record<string, unknown>;
      for (const k of Object.keys(prov)) if (!PROV_KEYS.includes(k)) e.push(`POLICY_PROVENANCE_UNKNOWN_KEY:${k}`);
      if (prov.origin !== undefined && prov.origin !== "policy") e.push("POLICY_PROVENANCE_BAD_ORIGIN");
      if (prov.status !== undefined && prov.status !== "DEFAULT_ASSUMPTION" && prov.status !== "OWNER_SET") e.push("POLICY_PROVENANCE_BAD_STATUS");
      if (prov.set_by !== undefined && (typeof prov.set_by !== "string" || !prov.set_by.trim())) e.push("POLICY_PROVENANCE_BAD_SET_BY");
      if (prov.note !== undefined && typeof prov.note !== "string") e.push("POLICY_PROVENANCE_BAD_NOTE");
    }
  }
  const d = DEFAULT_CONTENT_POLICY;
  const v = { min_impressions: (p.min_impressions ?? d.min_impressions) as number, refresh_position_min: (p.refresh_position_min ?? d.refresh_position_min) as number, refresh_position_max: (p.refresh_position_max ?? d.refresh_position_max) as number, consolidate_min_pages: (p.consolidate_min_pages ?? d.consolidate_min_pages) as number };
  if (!e.length && v.refresh_position_min > v.refresh_position_max) e.push("POLICY_POSITION_MIN_GT_MAX");
  if (e.length) return { ok: false, errors: e };
  const missing = VALUE_KEYS.filter((k) => p[k] === undefined);
  const claimsOwner = prov?.status === "OWNER_SET" && typeof prov.set_by === "string" && !NON_HUMAN.test(prov.set_by);
  // OWNER_SET yalniz TUM alanlar acikca verilmis ve insan adi varsa; kismi/adsiz politika varsayim sayilir.
  const owner = claimsOwner && missing.length === 0;
  const provenance: PolicyProvenance = owner
    ? { origin: "policy", status: "OWNER_SET", set_by: (prov!.set_by as string).trim(), note: typeof prov!.note === "string" ? prov!.note : "" }
    : { origin: "policy", status: "DEFAULT_ASSUMPTION", set_by: "unset", note: missing.length ? `kismi politika; varsayilanla tamamlanan alanlar: ${missing.join(", ")}` : (prov?.status === "OWNER_SET" ? "OWNER_SET talebi insan adi olmadigi icin kabul edilmedi" : d.provenance.note) };
  const defaulted = missing.length === VALUE_KEYS.length;
  return { ok: true, policy: { ...v, provenance }, defaulted, require_policy: p.require_policy === true };
}

/** Politika dosyasini (JSON) okur; ag yok. Bozuk dosya/JSON/deger fail-closed: firlatir, varsayilana dusmez. */
export function loadContentPolicy(path: string): ContentPolicyInput {
  let raw: string;
  try { raw = readFileSync(path, "utf8"); } catch { throw new Error(`POLICY_FILE_UNREADABLE:${path}`); }
  let j: unknown;
  try { j = JSON.parse(raw); } catch { throw new Error(`POLICY_FILE_BAD_JSON:${path}`); }
  const r = resolvePolicy(j);
  if (!r.ok) throw new Error(`POLICY_REJECTED:${r.errors.join(",")}`);
  return j as ContentPolicyInput;
}

export interface Classified { classification: Classification; evidence_label: EvidenceLabel; confidence: Confidence; reason: string; rows_used: number; rows_unknown: number; policy: ContentPolicy }

/** Kanittan siniflandirma. Cikti her zaman INFERENCE'tir ve CONFIRMED OLAMAZ: esikler bir kural, olcum degil.
 *  `policy` yoksa DEFAULT_CONTENT_POLICY (DEFAULT_ASSUMPTION) kullanilir; gecersizse POLICY_REJECTED firlatir.
 *  Cikti hangi politikanin (deger + kaynak) urettigini `policy` alaninda tasir. */
export function classifyFromEvidence(rows: readonly GscRow[], policyInput?: ContentPolicyInput | null): Classified {
  const res = resolvePolicy(policyInput);
  if (!res.ok) throw new Error(`POLICY_REJECTED:${res.errors.join(",")}`);
  const policy = res.policy;
  const base0 = { evidence_label: "INFERENCE" as const, policy };
  if (res.require_policy && policy.provenance.status !== "OWNER_SET") {
    return { ...base0, rows_used: 0, rows_unknown: rows.length, classification: "skip", confidence: "UNKNOWN", reason: "require_policy: sahibi tarafindan tam belirlenmis politika yok; varsayilan esiklerle siniflandirma yapilmadi" };
  }
  const usable = rows.filter((r) => typeof r.impressions === "number" && typeof r.position === "number" && r.impressions >= policy.min_impressions);
  const base = { ...base0, rows_used: usable.length, rows_unknown: rows.length - usable.length };
  if (!usable.length) return { ...base, classification: "skip", confidence: "UNKNOWN", reason: rows.length ? `${rows.length} satir var ama hicbiri yeterli olculmus gosterim tasimiyor (esik ${policy.min_impressions}; UNKNOWN sayilir)` : "kanit satiri yok" };
  // Ayni sorgu birden fazla sayfada gosterim aliyorsa: kanibalizasyon adayi.
  const byQuery = new Map<string, Set<string>>();
  for (const r of usable) {
    if (!r.query || !r.page) continue;
    const k = r.query.toLowerCase();
    if (!byQuery.has(k)) byQuery.set(k, new Set());
    byQuery.get(k)!.add(r.page);
  }
  if ([...byQuery.values()].some((s) => s.size >= policy.consolidate_min_pages)) return { ...base, classification: "consolidate", confidence: "CANDIDATE", reason: `ayni sorgu >=${policy.consolidate_min_pages} sayfada gosterim aliyor (kanibalizasyon adayi)` };
  const best = Math.min(...usable.map((r) => r.position as number));
  const { refresh_position_min: lo, refresh_position_max: hi } = policy;
  if (best >= lo && best <= hi) return { ...base, classification: "refresh", confidence: "CANDIDATE", reason: `en iyi pozisyon ${best} (${lo}-${hi}) ve gosterim var: yenileme adayi` };
  if (best < lo) return { ...base, classification: "skip", confidence: "CANDIDATE", reason: `pozisyon ${best} < ${lo}: zaten ust sirada, bu hat icin acik firsat yok` };
  return { ...base, classification: "new_page", confidence: "CANDIDATE", reason: `en iyi pozisyon ${best} > ${hi}: mevcut sayfa karsilamiyor olabilir, yeni sayfa adayi` };
}
