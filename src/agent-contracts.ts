// Agent sözleşmeleri: iç link ve schema/entity önerileri.
//
// Bu dosya bir AJANIN ne söyleyebileceğini tanımlar, ne yapabileceğini değil. Sözleşme
// yalnızca tarif eder: `mutation: "none"` literal'i tip düzeyinde ve çalışma anında
// zorlanır, ve hiçbir yerde dosya/ağ/git işlemi yoktur. Uygulama her zaman insan merge'ü
// ile, ayrı bir draft PR olarak gelir (CLAUDE.md, policies/high-risk-changes.md).
//
// Doğrulayıcı üç şeyi engeller, çünkü bu depoda en pahalı hatalar bunlar:
//   1. Portföy sızıntısı: bir sitenin önerisi başka kayıtlı sitenin host'una değiyor
//      (pamistanbul.com -> pamaistudio.com gerçek bir vaka).
//   2. Uydurma olgu: kaynağı olmayan aggregateRating / foundingDate / review.
//   3. Kendini onaylayan ajan: OWNER_APPROVED bir insan adı olmadan geçmez.
import type { EvidenceLabel, Confidence } from "./types.ts";
import type { Registry, SiteEntry } from "./registry.ts";

// --- sabitler (JSON şemalarıyla aynı olmak ZORUNDA; test drift'i yakalar) ----------------

export const APPROVAL_STATES = ["PROPOSED", "REVIEW_REQUIRED", "OWNER_APPROVED", "REJECTED"] as const;
export type ApprovalState = (typeof APPROVAL_STATES)[number];
export const RISKS = ["low", "medium", "high"] as const;
export type Risk = (typeof RISKS)[number];
export const EVIDENCE_LABELS: readonly EvidenceLabel[] = ["FACT", "INFERENCE", "HYPOTHESIS", "RECOMMENDATION", "IMPLEMENTED_CHANGE", "VERIFIED_RESULT"];
export const CONFIDENCES: readonly Confidence[] = ["CONFIRMED", "CANDIDATE", "FALSE_POSITIVE", "UNKNOWN"];
/** Bir ÖNERİ, yapılmış bir değişiklik ya da ölçülmüş sonuç gibi etiketlenemez. */
export const PROPOSAL_LABELS: readonly EvidenceLabel[] = ["FACT", "INFERENCE", "HYPOTHESIS", "RECOMMENDATION"];

/** Allow-list bilerek dar: Product/Offer/Review gibi fiyat ve puan iddiası taşıyan tipler yok. */
export const SCHEMA_TYPE_ALLOWLIST = [
  "Organization", "LocalBusiness", "Person", "WebSite", "WebPage", "AboutPage", "ContactPage", "ProfilePage",
  "Article", "BlogPosting", "BreadcrumbList", "FAQPage", "Service", "ImageObject",
] as const;

/** Yalnız taslağın İÇİNDE (iç içe) geçebilen tipler. Üst düzey öneri tipi olamazlar ama meşru bir
 *  Organization taslağı PostalAddress/AggregateRating taşıyabilir; olgu içerenler yine fact_sources ister.
 *  Offer/Product bilerek yok: fiyat iddiası bu sözleşmenin kapsamı dışında. */
export const NESTED_ONLY_TYPES = ["PostalAddress", "ContactPoint", "ListItem", "Question", "Answer", "AggregateRating", "Rating", "Review"] as const;

/** Kaynaksız yazılırsa uydurma sayılan olgu alanları. */
export const FACT_BEARING_PROPERTIES = ["aggregateRating", "review", "reviews", "rating", "foundingDate", "award", "numberOfEmployees"] as const;

export type Verdict = "ACCEPTED" | "BLOCKED_CROSS_SITE" | "BLOCKED_NOT_ONBOARDED" | "REJECTED_FABRICATED" | "INVALID";
// Öncelik: izolasyon ihlali her şeyden önce görünür olmalı.
const VERDICT_PRIORITY: Verdict[] = ["BLOCKED_CROSS_SITE", "BLOCKED_NOT_ONBOARDED", "REJECTED_FABRICATED", "INVALID"];

export interface Issue { code: string; verdict: Exclude<Verdict, "ACCEPTED">; message: string }
export interface Validation<T> { verdict: Verdict; issues: Issue[]; value?: T }

// --- tipler --------------------------------------------------------------------------

export interface EvidenceRef { refs: string[]; label: EvidenceLabel }
export interface ExpectedChange {
  /** Hipotez metni; sayısal kazanç iddiası içeremez (CLAUDE.md kural 4). */
  hypothesis: string;
  /** Hipotezi doğrulayacak/çürütecek test. Testsiz hipotez rapora giremez. */
  test: string;
}
interface ContractBase {
  id: string;
  site: string;
  source_url: string;
  target_url_or_entity: string;
  reason: string;
  evidence: EvidenceRef;
  confidence: Confidence;
  risk: Risk;
  expected_change: ExpectedChange;
  approval_state: ApprovalState;
  /** Yalnız OWNER_APPROVED ile birlikte; ASLA varsayılan atanmaz. */
  approver?: string;
  /** Sözleşme yalnızca tarif eder; uygulayamaz. */
  mutation: "none";
}
export interface InternalLinkRecommendation extends ContractBase { kind: "internal_link" }
export interface FactSource {
  /** Kaynaklanan özellik adı (ör. "aggregateRating", "foundingDate", "sameAs"). */
  property: string;
  /** Olgunun görünür olduğu sayfa; sitenin kendi domain'inde olmalı. */
  source_url: string;
  label: EvidenceLabel;
}
export interface SchemaEntityRecommendation extends ContractBase {
  kind: "schema_entity";
  schema_type: (typeof SCHEMA_TYPE_ALLOWLIST)[number];
  /** TASLAK. Yalnızca saklanır; hiçbir yere yazılmaz. Çıplak JSON-LD (script etiketi yok). */
  jsonld_draft: string | Record<string, unknown>;
  fact_sources: FactSource[];
}

// --- host sahipliği (izolasyonun çekirdeği) ------------------------------------------

const normHost = (h: string) => h.trim().toLowerCase().replace(/\.$/, "");
const bareHost = (h: string) => normHost(h).replace(/^www\./, "");

/** Bir sitenin sahip olduğu host'lar: apex, www, canonical, bildirilmiş subdomain'ler.
 *  Eşleşme TAM eşitliktir; `endsWith` kullanmak `evilpamistanbul.com` gibi benzerleri içeri alırdı. */
export function ownedHosts(site: SiteEntry): Set<string> {
  const hosts = new Set<string>();
  for (const d of [site.production_domain, site.canonical_hostname]) {
    if (typeof d !== "string" || d === "UNKNOWN" || d === "NOT_CONNECTED") continue;
    const b = bareHost(d); hosts.add(b); hosts.add(`www.${b}`);
  }
  for (const sub of site.known_subdomains ?? []) {
    const s = normHost(String(sub));
    hosts.add(s.includes(".") ? s : `${s}.${bareHost(site.production_domain)}`);
  }
  return hosts;
}

/** Host hangi kayıtlı siteye ait? Hiçbirine değilse null. */
export function siteOfHost(registry: Registry, host: string): string | null {
  const h = normHost(host);
  for (const s of registry.sites) if (ownedHosts(s).has(h)) return s.id;
  return null;
}

function hostOfUrl(u: string): string | null {
  try {
    const url = new URL(u);
    return url.protocol === "http:" || url.protocol === "https:" ? normHost(url.hostname) : null;
  } catch { return null; }
}
const looksLikeUrl = (s: string) => /^[a-z][a-z0-9+.-]*:\/\//i.test(s);

// --- ortak doğrulama -----------------------------------------------------------------

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
// Ajan, kendi adına onay veremez. \b şart: "Roberto" içindeki "bot" yanlış alarm olmasın.
const NON_HUMAN_APPROVER = /\b(claude|agent|bot|gpt|llm|ai|auto|system)\b/i;
// Sayısal kazanç iddiası: ölçülmemiş rakam yazılamaz.
const NUMERIC_CLAIM = /\d\s*%|%\s*\d|\b\d+(?:[.,]\d+)?\s*(?:x|kat|times|fold)\b/i;

class Ctx {
  issues: Issue[] = [];
  add(code: string, verdict: Issue["verdict"], message: string) { this.issues.push({ code, verdict, message }); }
  result<T>(value: T | undefined): Validation<T> {
    const verdict = VERDICT_PRIORITY.find((v) => this.issues.some((i) => i.verdict === v)) ?? "ACCEPTED";
    return { verdict, issues: this.issues, value: verdict === "ACCEPTED" ? value : undefined };
  }
}

function checkBase(x: Record<string, unknown>, registry: Registry, c: Ctx, extraKeys: string[]): SiteEntry | null {
  const allowed = new Set(["id", "kind", "site", "source_url", "target_url_or_entity", "reason", "evidence", "confidence", "risk", "expected_change", "approval_state", "approver", "mutation", ...extraKeys]);
  // Bilinmeyen alan reddi: `apply`, `patch`, `deploy` gibi bir alanın sözleşmeye sızmasını önler.
  for (const k of Object.keys(x)) if (!allowed.has(k)) c.add("UNKNOWN_FIELD", "INVALID", `bilinmeyen alan: ${k}`);
  for (const k of ["id", "site", "source_url", "target_url_or_entity", "reason"]) if (!nonEmpty(x[k])) c.add("MISSING_FIELD", "INVALID", `${k} boş ya da eksik`);
  if (x.mutation !== "none") c.add("MUTATION_NOT_NONE", "INVALID", "mutation tam olarak 'none' olmalı: sözleşme yalnızca tarif eder");

  // evidence
  const ev = x.evidence;
  if (!isObj(ev)) c.add("EVIDENCE_MISSING", "INVALID", "evidence {refs,label} zorunlu");
  else {
    const refs = ev.refs;
    if (!Array.isArray(refs) || refs.length === 0 || !refs.every(nonEmpty)) c.add("EVIDENCE_REFS_EMPTY", "INVALID", "evidence.refs en az bir kaynak içermeli");
    if (!EVIDENCE_LABELS.includes(ev.label as EvidenceLabel)) c.add("EVIDENCE_LABEL_UNKNOWN", "INVALID", "evidence.label altı etiketten biri olmalı");
    else if (!PROPOSAL_LABELS.includes(ev.label as EvidenceLabel)) c.add("EVIDENCE_LABEL_NOT_PROPOSAL", "INVALID", `${ev.label} bir öneriye yakışmaz (yapılmış/ölçülmüş iddia)`);
  }
  if (!CONFIDENCES.includes(x.confidence as Confidence)) c.add("CONFIDENCE_UNKNOWN", "INVALID", "confidence geçersiz");
  else if (isObj(ev) && (ev.label === "INFERENCE" || ev.label === "HYPOTHESIS" || ev.label === "RECOMMENDATION") && x.confidence === "CONFIRMED")
    // Kural 2: çıkarım onaylanmış gibi raporlanamaz.
    c.add("CONFIRMED_WITHOUT_FACT", "INVALID", "FACT olmayan kanıt CONFIRMED olamaz");
  if (x.confidence === "FALSE_POSITIVE" && x.approval_state !== "REJECTED") c.add("FALSE_POSITIVE_NOT_REJECTED", "INVALID", "FALSE_POSITIVE öneri yalnız REJECTED olabilir");
  if (!RISKS.includes(x.risk as Risk)) c.add("RISK_INVALID", "INVALID", "risk low|medium|high olmalı");

  // expected_change
  const ec = x.expected_change;
  if (!isObj(ec) || !nonEmpty(ec.hypothesis) || !nonEmpty(ec.test)) c.add("EXPECTED_CHANGE_INCOMPLETE", "INVALID", "expected_change hem hipotez hem onu doğrulayacak test içermeli");
  else if (NUMERIC_CLAIM.test(ec.hypothesis)) c.add("EXPECTED_CHANGE_NUMERIC", "REJECTED_FABRICATED", "hipotezde ölçülmemiş sayısal kazanç iddiası var");

  // approval
  if (!APPROVAL_STATES.includes(x.approval_state as ApprovalState)) c.add("APPROVAL_STATE_INVALID", "INVALID", "approval_state zorunlu ve varsayılan atanmaz");
  if (x.approval_state === "OWNER_APPROVED") {
    if (!nonEmpty(x.approver)) c.add("APPROVER_MISSING", "INVALID", "OWNER_APPROVED için approver zorunlu");
    else if (NON_HUMAN_APPROVER.test(x.approver)) c.add("APPROVER_NOT_HUMAN", "INVALID", "approver bir insan olmalı; ajan kendini onaylayamaz");
  } else if (x.approver !== undefined) c.add("APPROVER_WITHOUT_APPROVAL", "INVALID", "approver yalnız OWNER_APPROVED ile birlikte olabilir");

  // site
  const site = registry.sites.find((s) => s.id === x.site);
  if (nonEmpty(x.site) && !site) { c.add("UNKNOWN_SITE", "INVALID", `kayıtlı olmayan site: ${x.site}`); return null; }
  if (site && site.onboarding_status === "registered_not_onboarded") {
    c.add("SITE_NOT_ONBOARDED", "BLOCKED_NOT_ONBOARDED", `${site.id} onboard edilmemiş: ölçüm olur, tavsiye olmaz`);
  }
  // Kanıt referansı başka sitenin URL'siyse, o sitenin verisi bu sitenin gerekçesi olmuş demektir.
  if (site && isObj(ev) && Array.isArray(ev.refs)) for (const r of ev.refs) if (typeof r === "string" && looksLikeUrl(r)) {
    const h = hostOfUrl(r); const owner = h ? siteOfHost(registry, h) : null;
    if (owner && owner !== site.id) c.add("EVIDENCE_CROSS_SITE", "BLOCKED_CROSS_SITE", `kanıt başka sitenin verisine işaret ediyor: ${owner}`);
  }
  return site ?? null;
}

/** URL'nin site'ye ait olduğunu doğrular. Dışarıdaki host: başka kayıtlı site ya da tanımsız dış host. */
function requireOwnUrl(field: string, value: unknown, site: SiteEntry, registry: Registry, c: Ctx): void {
  if (!nonEmpty(value)) return;
  const h = hostOfUrl(value);
  if (!h) { c.add("URL_INVALID", "INVALID", `${field} mutlak http(s) URL olmalı`); return; }
  if (ownedHosts(site).has(h)) return;
  const owner = siteOfHost(registry, h);
  c.add("BLOCKED_CROSS_SITE", "BLOCKED_CROSS_SITE",
    owner ? `${field} başka kayıtlı siteye (${owner}) işaret ediyor: ${h}` : `${field} sitenin registry domain'leri dışında: ${h}`);
}

// --- (1) iç link ---------------------------------------------------------------------

export function validateInternalLink(input: unknown, registry: Registry): Validation<InternalLinkRecommendation> {
  const c = new Ctx();
  if (!isObj(input)) { c.add("NOT_AN_OBJECT", "INVALID", "öneri bir nesne olmalı"); return c.result<InternalLinkRecommendation>(undefined); }
  const site = checkBase(input, registry, c, []);
  if (input.kind !== "internal_link") c.add("KIND_MISMATCH", "INVALID", "kind 'internal_link' olmalı");
  if (site) {
    requireOwnUrl("source_url", input.source_url, site, registry, c);
    // İç linkte hedef bir URL olmak zorunda; "entity adı" yalnız schema sözleşmesinde geçerli.
    if (nonEmpty(input.target_url_or_entity) && !looksLikeUrl(input.target_url_or_entity)) c.add("TARGET_NOT_URL", "INVALID", "iç link hedefi mutlak URL olmalı");
    else requireOwnUrl("target_url_or_entity", input.target_url_or_entity, site, registry, c);
    if (input.source_url === input.target_url_or_entity && nonEmpty(input.source_url)) c.add("SELF_LINK", "INVALID", "kaynak ve hedef aynı sayfa");
  }
  return c.result(input as unknown as InternalLinkRecommendation);
}

// --- (2) schema / entity -------------------------------------------------------------

function parseDraft(d: unknown, c: Ctx): Record<string, unknown> | null {
  let obj: unknown = d;
  if (typeof d === "string") {
    try { obj = JSON.parse(d); } catch { c.add("DRAFT_NOT_JSON", "INVALID", "jsonld_draft geçerli JSON olmalı (<script> sarmalı olmadan)"); return null; }
  }
  if (!isObj(obj)) { c.add("DRAFT_NOT_OBJECT", "INVALID", "jsonld_draft bir JSON nesnesi olmalı"); return null; }
  return obj;
}
/** @graph dahil tüm düğümleri düzleştirir. */
function nodesOf(o: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(o)) { o.forEach((x) => nodesOf(x, out)); return out; }
  if (isObj(o)) { out.push(o); for (const v of Object.values(o)) nodesOf(v, out); }
  return out;
}
const asList = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined ? [] : [v]);

export function validateSchemaEntity(input: unknown, registry: Registry): Validation<SchemaEntityRecommendation> {
  const c = new Ctx();
  if (!isObj(input)) { c.add("NOT_AN_OBJECT", "INVALID", "öneri bir nesne olmalı"); return c.result<SchemaEntityRecommendation>(undefined); }
  const site = checkBase(input, registry, c, ["schema_type", "jsonld_draft", "fact_sources"]);
  if (input.kind !== "schema_entity") c.add("KIND_MISMATCH", "INVALID", "kind 'schema_entity' olmalı");
  if (!(SCHEMA_TYPE_ALLOWLIST as readonly string[]).includes(String(input.schema_type))) c.add("TYPE_NOT_ALLOWED", "INVALID", `schema_type allow-list dışında: ${String(input.schema_type)}`);
  const sourcesRaw = input.fact_sources;
  if (!Array.isArray(sourcesRaw)) c.add("FACT_SOURCES_MISSING", "INVALID", "fact_sources bir liste olmalı (boş olabilir)");
  const sources = (Array.isArray(sourcesRaw) ? sourcesRaw : []).filter(isObj) as unknown as FactSource[];
  const draft = parseDraft(input.jsonld_draft, c);
  if (!site) return c.result<SchemaEntityRecommendation>(undefined);

  requireOwnUrl("source_url", input.source_url, site, registry, c);
  if (nonEmpty(input.target_url_or_entity) && looksLikeUrl(input.target_url_or_entity)) requireOwnUrl("target_url_or_entity", input.target_url_or_entity, site, registry, c);

  // Bir olgu kaynağı yalnız FACT etiketli ve sitenin KENDİ sayfasında görünür olmalı:
  // schema, görünür içeriği yansıtır; içeriğin yerine geçmez.
  const validSource = (prop: string) => sources.some((s) => {
    if (s.property !== prop || s.label !== "FACT" || !nonEmpty(s.source_url)) return false;
    const h = hostOfUrl(s.source_url); return !!h && ownedHosts(site).has(h);
  });
  for (const s of sources) if (nonEmpty(s.source_url)) {
    const h = hostOfUrl(s.source_url); const owner = h ? siteOfHost(registry, h) : null;
    if (owner && owner !== site.id) c.add("FACT_SOURCE_CROSS_SITE", "BLOCKED_CROSS_SITE", `olgu kaynağı başka sitenin sayfası: ${owner}`);
  }

  if (draft) {
    const nodes = nodesOf(draft);
    // @type allow-list: taslağın içindeki HER tip denetlenir, yalnız üst düzey değil.
    for (const n of nodes) for (const t of asList(n["@type"])) if (typeof t === "string" && !(SCHEMA_TYPE_ALLOWLIST as readonly string[]).includes(t) && !(NESTED_ONLY_TYPES as readonly string[]).includes(t))
      c.add("DRAFT_TYPE_NOT_ALLOWED", "INVALID", `taslakta allow-list dışı tip: ${t}`);

    // Uydurma olgu: kaynaksız aggregateRating / review / foundingDate / ...
    for (const prop of FACT_BEARING_PROPERTIES) if (nodes.some((n) => prop in n) && !validSource(prop))
      c.add(`FABRICATED_${prop}`, "REJECTED_FABRICATED", `${prop} için sitenin kendi sayfasında FACT kaynağı yok`);
    // Registry, kuruluş yılının tek doğruluk kaynağıdır; site/ajan farklı diyorsa yanlış olan onlardır.
    if (typeof site.foundation_year === "number") for (const n of nodes) if ("foundingDate" in n) {
      const y = String(n.foundingDate).match(/\d{4}/)?.[0];
      if (y && Number(y) !== site.foundation_year) c.add("FOUNDING_YEAR_MISMATCH", "REJECTED_FABRICATED", `foundingDate ${y}, registry ${site.foundation_year}`);
    }

    // sameAs / url / @id: başka kayıtlı sitenin domain'ine işaret edemez (entity kimliği sızıntısı).
    const owned = ownedHosts(site);
    for (const n of nodes) for (const key of ["sameAs", "url", "@id", "mainEntityOfPage"]) for (const v of asList(n[key])) {
      if (typeof v !== "string" || !looksLikeUrl(v)) continue;
      const h = hostOfUrl(v); if (!h) continue;
      const owner = siteOfHost(registry, h);
      if (owner && owner !== site.id) { c.add("ENTITY_CROSS_SITE", "BLOCKED_CROSS_SITE", `${key} başka kayıtlı sitenin domain'ine işaret ediyor (${owner}): ${v}`); continue; }
      // Sosyal profil uydurma: sameAs yalnız owner'ın registry'de bildirdiği ya da kaynaklı profil olabilir.
      if (key === "sameAs" && !owned.has(h) && !site.social_identity_urls.includes(v) && !validSource("sameAs"))
        c.add("FABRICATED_sameAs", "REJECTED_FABRICATED", `sameAs profili registry social_identity_urls içinde değil ve kaynaksız: ${v}`);
    }
    // Organization/Person kimliği sitewide etkilidir (high-risk: toplu structured data); düşük risk etiketi yanıltır.
    const entityNode = nodes.some((n) => asList(n["@type"]).some((t) => t === "Organization" || t === "Person" || t === "LocalBusiness"));
    if (entityNode && input.risk === "low") c.add("ENTITY_RISK_TOO_LOW", "INVALID", "Organization/Person/LocalBusiness önerisi en az medium risk taşır");
  }
  return c.result(input as unknown as SchemaEntityRecommendation);
}

// --- inceleme kuyruğu (markdown) -----------------------------------------------------

export interface QueueItem { kind: "internal_link" | "schema_entity"; input: unknown; result: Validation<unknown> }

const cell = (s: unknown) => String(s ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
const fenceFor = (s: string) => "`".repeat(Math.max(3, ...(s.match(/`+/g) ?? []).map((m) => m.length + 1)));

/** Kuyruk, site başına gruplanır (izolasyon: bir site bölümü diğerinin verisini içermez).
 *  Engellenen öneriler gizlenmez ama "uygulanamaz" bölümünde nedeniyle görünür:
 *  sessizce atılan bir öneri, kontrolün neye baktığını söylemeyen bir kontroldür. */
export function renderReviewQueue(items: QueueItem[], now: string = new Date().toISOString().slice(0, 10)): string {
  const out: string[] = [`# Öneri inceleme kuyruğu — ${now}`, "",
    "Bu kuyruk yalnızca TASLAK içerir. Hiçbir madde uygulanmadı; uygulama draft PR ve insan onayı ile yapılır.", ""];
  const bySite = new Map<string, QueueItem[]>();
  for (const it of items) {
    const s = isObj(it.input) && typeof it.input.site === "string" ? it.input.site : "(site belirtilmemiş)";
    bySite.set(s, [...(bySite.get(s) ?? []), it]);
  }
  if (items.length === 0) out.push("Kuyruk boş: incelenecek öneri verilmedi.", "");
  for (const [site, list] of [...bySite].sort(([a], [b]) => a.localeCompare(b))) {
    out.push(`## ${site}`, "");
    const ok = list.filter((i) => i.result.verdict === "ACCEPTED");
    const bad = list.filter((i) => i.result.verdict !== "ACCEPTED");
    out.push(`İncelemeye hazır: ${ok.length} · Engellenen/geçersiz: ${bad.length}`, "");
    if (ok.length) {
      out.push("| id | tür | kaynak | hedef | risk | kanıt | güven | durum |", "|---|---|---|---|---|---|---|---|");
      for (const i of ok) {
        const x = i.input as Record<string, any>;
        out.push(`| ${cell(x.id)} | ${i.kind} | ${cell(x.source_url)} | ${cell(x.target_url_or_entity)} | ${cell(x.risk)} | ${cell(x.evidence.label)} | ${cell(x.confidence)} | ${cell(x.approval_state)}${x.approver ? ` (${cell(x.approver)})` : ""} |`);
      }
      out.push("");
      for (const i of ok) {
        const x = i.input as Record<string, any>;
        out.push(`### ${cell(x.id)}`, `- Neden: ${cell(x.reason)}`, `- Kanıt: ${x.evidence.refs.map(cell).join(", ")}`,
          `- Hipotez: ${cell(x.expected_change.hypothesis)}`, `- Test: ${cell(x.expected_change.test)}`);
        if (i.kind === "schema_entity") {
          const body = typeof x.jsonld_draft === "string" ? x.jsonld_draft : JSON.stringify(x.jsonld_draft, null, 2);
          const f = fenceFor(body);
          out.push("- JSON-LD TASLAK (uygulanmadı):", "", `${f}json`, body, f);
        }
        out.push("");
      }
    }
    if (bad.length) {
      out.push("### Uygulanamaz", "");
      for (const i of bad) {
        const x = isObj(i.input) ? i.input : {};
        out.push(`- **${i.result.verdict}** ${cell(x.id ?? "(id yok)")}: ${i.result.issues.map((s) => `${s.code} (${cell(s.message)})`).join("; ")}`);
      }
      out.push("");
    }
  }
  return out.join("\n");
}

/** Gözden geçiren için tek satırlık özet; kuyruk dosyasının başlığında kullanılabilir. */
export function summarize(items: QueueItem[]): Record<Verdict, number> {
  const s: Record<Verdict, number> = { ACCEPTED: 0, BLOCKED_CROSS_SITE: 0, BLOCKED_NOT_ONBOARDED: 0, REJECTED_FABRICATED: 0, INVALID: 0 };
  for (const i of items) s[i.result.verdict]++;
  return s;
}
