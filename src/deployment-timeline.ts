/**
 * Deployment dogrulayici + site basina zaman cizelgesi (salt-okunur; hicbir deploy tetiklenmez).
 *
 * Neden var: "dususten once deploy oldu" hipotezi ancak deploy'un GERCEKTEN canli oldugu bilinirse anlamli.
 * Saglayicinin "deploy ettim" demesi FACT'tir (saglayici ne dedigi hakkinda); canli sitenin hangi commit'i
 * sundugu AYRI bir olcumdur. Bu modul ikisini ayri tutar: parser'lar UNVERIFIED uretir, yalniz verifyDeployment
 * VERIFIED verebilir.
 *
 * Tasarim kararlari:
 *  - Dogrulanamayan (erisilemeyen, SHA donmeyen, fetcher'in patladigi) durum UNKNOWN'dur; asla VERIFIED degil.
 *    Farkli SHA = MISMATCH (UNKNOWN degil: bir seyi olctuk ve beklenenle uyusmadi).
 *  - Parse fail-closed: bozuk satir sessizce atlanmaz; parser `rejected` listesinde nedeniyle bildirir,
 *    parseTimeline ise tek bozuk olayda tamamen reddeder (yarim zaman cizelgesi yanlis korelasyon uretir).
 *  - Korelasyon yalniz INFERENCE/CANDIDATE "temporal_coincidence"; nedensellik dili yok (test tarar).
 *  - Portfoy izolasyonu: olay ve metrik kaydi ayni site_id'yi tasimiyorsa korelasyon uretilmez.
 */
import type { Confidence, EvidenceLabel } from "./types.ts";

export const DEPLOYMENT_EVENT_SCHEMA = "sgos.deployment-event.v1" as const;
export const DEPLOYMENT_TIMELINE_SCHEMA = "sgos.deployment-timeline.v1" as const;
/** Sinirli buyume: site basina en fazla bu kadar olay; en eski olay duser. */
export const TIMELINE_MAX_EVENTS = 200;
/** Metrik degisimi deploy'dan sonra bu kadar saat icindeyse "zamansal ortusme" sayilir. */
export const DEFAULT_COINCIDENCE_WINDOW_HOURS = 72;

export type DeploymentEnvironment = "production" | "preview" | "unknown";
export type VerificationState = "VERIFIED" | "UNVERIFIED" | "MISMATCH" | "UNKNOWN";
export type DeploymentSource = "github_deployments" | "vercel" | "manual_fixture";

export interface DeploymentEvent {
  schema: typeof DEPLOYMENT_EVENT_SCHEMA;
  site: string;
  environment: DeploymentEnvironment;
  /** 40 haneli kucuk-harf hex. Kisa SHA kabul edilmez: onek eslesmesi yanlis VERIFIED uretebilir. */
  commit_sha: string;
  /** ISO-8601 UTC ("...Z"). */
  deployed_at: string;
  verification_state: VerificationState;
  provenance: { source: DeploymentSource; retrieved_at: string; ref: string };
  evidence: "FACT";
}

const SITE_ID = /^[a-z0-9][a-z0-9_-]*$/;
const SHA40 = /^[0-9a-f]{40}$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const STATES: readonly VerificationState[] = ["VERIFIED", "UNVERIFIED", "MISMATCH", "UNKNOWN"];
const ENVS: readonly DeploymentEnvironment[] = ["production", "preview", "unknown"];
const SOURCES: readonly DeploymentSource[] = ["github_deployments", "vercel", "manual_fixture"];

export class TimelineError extends Error {}

const isIsoUtc = (s: unknown): s is string => typeof s === "string" && ISO_UTC.test(s) && !Number.isNaN(Date.parse(s));
export const isSha40 = (s: unknown): s is string => typeof s === "string" && SHA40.test(s);

/** Tek olayi dogrular; sorun listesi doner (bos = gecerli). Bilinmeyen alan reddedilir (fail-closed). */
export function validateEvent(e: unknown): string[] {
  const errs: string[] = [];
  if (typeof e !== "object" || e === null || Array.isArray(e)) return ["olay nesne degil"];
  const o = e as Record<string, unknown>;
  const allowed = ["schema", "site", "environment", "commit_sha", "deployed_at", "verification_state", "provenance", "evidence"];
  for (const k of Object.keys(o)) if (!allowed.includes(k)) errs.push(`bilinmeyen alan: ${k}`);
  if (o.schema !== DEPLOYMENT_EVENT_SCHEMA) errs.push("schema hatali");
  if (typeof o.site !== "string" || !SITE_ID.test(o.site)) errs.push("site gecersiz");
  if (!ENVS.includes(o.environment as DeploymentEnvironment)) errs.push("environment gecersiz");
  if (!isSha40(o.commit_sha)) errs.push("commit_sha 40 haneli kucuk hex degil");
  if (!isIsoUtc(o.deployed_at)) errs.push("deployed_at ISO UTC degil");
  if (!STATES.includes(o.verification_state as VerificationState)) errs.push("verification_state gecersiz");
  if (o.evidence !== "FACT") errs.push("evidence FACT olmali");
  const p = o.provenance as Record<string, unknown> | undefined;
  if (typeof p !== "object" || p === null) errs.push("provenance yok");
  else {
    if (!SOURCES.includes(p.source as DeploymentSource)) errs.push("provenance.source gecersiz");
    if (!isIsoUtc(p.retrieved_at)) errs.push("provenance.retrieved_at ISO UTC degil");
    if (typeof p.ref !== "string" || p.ref === "") errs.push("provenance.ref bos");
  }
  return errs;
}

export interface ParseResult { events: DeploymentEvent[]; rejected: { index: number; reason: string }[] }

function mkEvent(site: string, env: DeploymentEnvironment, sha: unknown, at: unknown, source: DeploymentSource, retrievedAt: string, ref: unknown): DeploymentEvent | string {
  const sha40 = typeof sha === "string" ? sha.toLowerCase() : sha;
  if (!isSha40(sha40)) return "commit_sha 40 haneli hex degil";
  if (!isIsoUtc(at)) return "zaman damgasi ISO UTC degil";
  if (typeof ref !== "string" || ref === "") return "kaynak kimligi (ref) yok";
  // Saglayici yalniz "deploy ettim" der: canli dogrulama ayri adim -> UNVERIFIED.
  return {
    schema: DEPLOYMENT_EVENT_SCHEMA, site, environment: env, commit_sha: sha40, deployed_at: at,
    verification_state: "UNVERIFIED", provenance: { source, retrieved_at: retrievedAt, ref }, evidence: "FACT",
  };
}

function assertParseArgs(site: string, retrievedAt: string): void {
  if (!SITE_ID.test(site)) throw new TimelineError(`site gecersiz: ${site}`);
  if (!isIsoUtc(retrievedAt)) throw new TimelineError("retrievedAt ISO UTC degil");
}

/** GitHub ortam adi -> ortam. Tanimsiz ad "unknown": production varsaymak yanlis zaman cizelgesi uretir. */
function githubEnv(name: unknown): DeploymentEnvironment {
  if (typeof name !== "string") return "unknown";
  const n = name.toLowerCase();
  if (n === "production" || n === "prod") return "production";
  if (n.startsWith("preview") || n.startsWith("pr-")) return "preview";
  return "unknown";
}

/** GitHub Deployments API (GET /repos/{o}/{r}/deployments) JSON'u. Satir bazinda fail-closed. */
export function parseGithubDeployments(json: unknown, site: string, retrievedAt: string): ParseResult {
  assertParseArgs(site, retrievedAt);
  if (!Array.isArray(json)) throw new TimelineError("GitHub Deployments yaniti dizi degil");
  const res: ParseResult = { events: [], rejected: [] };
  json.forEach((d, index) => {
    const o = (typeof d === "object" && d !== null ? d : {}) as Record<string, unknown>;
    const r = mkEvent(site, githubEnv(o.environment), o.sha, o.created_at, "github_deployments", retrievedAt,
      o.id === undefined || o.id === null ? undefined : `github-deployment-${String(o.id)}`);
    if (typeof r === "string") res.rejected.push({ index, reason: r }); else res.events.push(r);
  });
  return res;
}

/** Vercel deployment JSON'u: {deployments:[...]} (liste) veya tek deployment nesnesi. Baska sekil throw. */
export function parseVercelDeployments(json: unknown, site: string, retrievedAt: string): ParseResult {
  assertParseArgs(site, retrievedAt);
  if (typeof json !== "object" || json === null || Array.isArray(json)) throw new TimelineError("Vercel yaniti taninmadi");
  const root = json as Record<string, unknown>;
  let list: unknown[];
  if ("deployments" in root) {
    if (!Array.isArray(root.deployments)) throw new TimelineError("Vercel deployments dizi degil");
    list = root.deployments;
  } else if ("uid" in root || "id" in root) list = [root];
  else throw new TimelineError("Vercel yaniti taninmadi");
  const res: ParseResult = { events: [], rejected: [] };
  list.forEach((d, index) => {
    const v = (typeof d === "object" && d !== null ? d : {}) as Record<string, any>;
    // Vercel'de target yoksa/null ise deploy preview'dur; yalniz acik "production" production sayilir.
    const target = v.target;
    const env: DeploymentEnvironment = target === "production" ? "production" : target === null || target === undefined || target === "preview" ? "preview" : "unknown";
    const created = typeof v.created === "number" && Number.isFinite(v.created) ? new Date(v.created).toISOString() : v.createdAt;
    const sha = v.meta?.githubCommitSha ?? v.meta?.gitlabCommitSha ?? v.meta?.bitbucketCommitSha;
    const r = mkEvent(site, env, sha, created, "vercel", retrievedAt, v.uid ?? v.id);
    if (typeof r === "string") res.rejected.push({ index, reason: r }); else res.events.push(r);
  });
  return res;
}

// ---------------------------------------------------------------------------
// Dogrulayici
// ---------------------------------------------------------------------------

export interface LiveProbeResult {
  reachable: boolean;
  /** Canli sitenin bildirdigi commit (meta/header/deployment-id probe'u). Yoksa bilinmiyor. */
  live_sha?: string;
}
/** Enjekte edilir: test ag kullanmaz. Yalniz site + ortam alir; baska sitenin verisi sizamaz. */
export type LiveProbe = (site: string, environment: DeploymentEnvironment) => Promise<LiveProbeResult>;

/**
 * Beklenen SHA'yi canli SHA ile karsilastirir. Yeni olay doner (girdi degismez).
 * Probe patlarsa/erisilemezse UNKNOWN; SHA donmezse/gecersizse UNKNOWN; eslesmezse MISMATCH; yalniz tam eslesme VERIFIED.
 */
export async function verifyDeployment(event: DeploymentEvent, probe: LiveProbe, now: Date = new Date()): Promise<DeploymentEvent> {
  const errs = validateEvent(event);
  if (errs.length) throw new TimelineError(`olay gecersiz: ${errs.join("; ")}`);
  let state: VerificationState;
  try {
    const r = await probe(event.site, event.environment);
    if (!r || r.reachable !== true || typeof r.live_sha !== "string") state = "UNKNOWN";
    else {
      const live = r.live_sha.toLowerCase();
      if (!isSha40(live)) state = "UNKNOWN"; // kisa/bozuk SHA ne eslesme ne uyusmazlik kanitidir
      else state = live === event.commit_sha ? "VERIFIED" : "MISMATCH";
    }
  } catch {
    state = "UNKNOWN";
  }
  return { ...event, verification_state: state, provenance: { ...event.provenance, retrieved_at: now.toISOString() } };
}

// ---------------------------------------------------------------------------
// Zaman cizelgesi (append-only, sirali, tekrarsiz, sinirli)
// ---------------------------------------------------------------------------

export interface DeploymentTimeline {
  schema: typeof DEPLOYMENT_TIMELINE_SCHEMA;
  site: string;
  events: DeploymentEvent[];
}

export const emptyTimeline = (site: string): DeploymentTimeline => {
  if (!SITE_ID.test(site)) throw new TimelineError(`site gecersiz: ${site}`);
  return { schema: DEPLOYMENT_TIMELINE_SCHEMA, site, events: [] };
};

const keyOf = (e: DeploymentEvent) => `${e.site}|${e.commit_sha}|${e.environment}`;

/**
 * Olay ekler; yeni cizelge doner. Baska sitenin olayi reddedilir (throw). Ayni site+sha+ortam ikinci kez
 * eklenmez: ilk kayit korunur (append-only; VERIFIED'a yukseltme ekleme ONCESI verifyDeployment ile yapilir).
 */
export function appendEvent(t: DeploymentTimeline, e: DeploymentEvent): { timeline: DeploymentTimeline; added: boolean } {
  const errs = validateEvent(e);
  if (errs.length) throw new TimelineError(`olay gecersiz: ${errs.join("; ")}`);
  if (e.site !== t.site) throw new TimelineError(`site uyusmuyor: cizelge ${t.site}, olay ${e.site}`);
  if (t.events.some((x) => keyOf(x) === keyOf(e))) return { timeline: t, added: false };
  // Kararli sira: deployed_at, esitlikte ekleme sirasi (sort kararli).
  const events = [...t.events, e].sort((a, b) => Date.parse(a.deployed_at) - Date.parse(b.deployed_at)).slice(-TIMELINE_MAX_EVENTS);
  return { timeline: { ...t, events }, added: events.includes(e) };
}

/** Fail-closed: tek hata tum cizelgeyi reddeder (throw). */
export function parseTimeline(input: unknown): DeploymentTimeline {
  const o = (typeof input === "string" ? safeJson(input) : input) as Record<string, unknown> | null;
  if (typeof o !== "object" || o === null || Array.isArray(o)) throw new TimelineError("cizelge nesne degil");
  if (o.schema !== DEPLOYMENT_TIMELINE_SCHEMA) throw new TimelineError("cizelge schema hatali");
  if (typeof o.site !== "string" || !SITE_ID.test(o.site)) throw new TimelineError("cizelge site gecersiz");
  if (!Array.isArray(o.events)) throw new TimelineError("events dizi degil");
  if (o.events.length > TIMELINE_MAX_EVENTS) throw new TimelineError(`${TIMELINE_MAX_EVENTS} olay siniri asildi`);
  const seen = new Set<string>();
  let prev = -Infinity;
  for (const [i, e] of o.events.entries()) {
    const errs = validateEvent(e);
    if (errs.length) throw new TimelineError(`olay ${i}: ${errs.join("; ")}`);
    const ev = e as DeploymentEvent;
    if (ev.site !== o.site) throw new TimelineError(`olay ${i}: baska siteye ait (${ev.site})`);
    if (seen.has(keyOf(ev))) throw new TimelineError(`olay ${i}: tekrar (site+sha+ortam)`);
    seen.add(keyOf(ev));
    const t = Date.parse(ev.deployed_at);
    if (t < prev) throw new TimelineError(`olay ${i}: sira bozuk`);
    prev = t;
  }
  return o as unknown as DeploymentTimeline;
}
function safeJson(s: string): unknown { try { return JSON.parse(s); } catch { throw new TimelineError("JSON ayristirilamadi"); } }

// ---------------------------------------------------------------------------
// Korelasyon: yalniz zamansal ortusme (INFERENCE/CANDIDATE), nedensellik YOK
// ---------------------------------------------------------------------------

export interface MetricChange {
  site: string;
  metric: string;
  direction: "up" | "down";
  /** Degisimin gozlendigi an (ISO UTC). */
  observed_at: string;
  /** Olcumun kaynagi (rapor/dosya referansi). Rakam uydurmamak icin buyukluk alani KASITLI yok. */
  record_ref: string;
}

export interface TemporalCoincidence {
  kind: "temporal_coincidence";
  evidence: Extract<EvidenceLabel, "INFERENCE">;
  confidence: Extract<Confidence, "CANDIDATE">;
  site: string;
  deployment: { commit_sha: string; deployed_at: string; environment: DeploymentEnvironment; verification_state: VerificationState };
  metric: { name: string; direction: "up" | "down"; observed_at: string; record_ref: string };
  hours_after_deploy: number;
  statement: string;
  /** Aday onaylanmadan once kosulacak test (kanitsiz hipotez rapora giremez). */
  confirming_test: string;
}
export type CorrelationResult =
  | { correlated: true; finding: TemporalCoincidence }
  | { correlated: false; reason: "site_mismatch" | "deployment_not_production" | "deployment_mismatch" | "metric_before_deployment" | "outside_window" | "invalid_input" };

export function correlate(event: DeploymentEvent, change: MetricChange, windowHours = DEFAULT_COINCIDENCE_WINDOW_HOURS): CorrelationResult {
  if (validateEvent(event).length || !isIsoUtc(change?.observed_at) || !SITE_ID.test(String(change?.site)) || !(windowHours > 0)) {
    return { correlated: false, reason: "invalid_input" };
  }
  // Izolasyon: bir sitenin deploy'u baska sitenin metrigiyle asla eslesmez.
  if (event.site !== change.site) return { correlated: false, reason: "site_mismatch" };
  // Preview aramada gorunmez; yalniz production anlamli aday olur.
  if (event.environment !== "production") return { correlated: false, reason: "deployment_not_production" };
  // Canli SHA beklenenle uyusmuyorsa bu deploy'un canli oldugunu bilmiyoruz.
  if (event.verification_state === "MISMATCH") return { correlated: false, reason: "deployment_mismatch" };
  const hours = (Date.parse(change.observed_at) - Date.parse(event.deployed_at)) / 3_600_000;
  if (hours < 0) return { correlated: false, reason: "metric_before_deployment" };
  if (hours > windowHours) return { correlated: false, reason: "outside_window" };
  const short = event.commit_sha.slice(0, 7);
  const h = Math.round(hours * 10) / 10;
  return {
    correlated: true,
    finding: {
      kind: "temporal_coincidence", evidence: "INFERENCE", confidence: "CANDIDATE", site: event.site,
      deployment: { commit_sha: event.commit_sha, deployed_at: event.deployed_at, environment: event.environment, verification_state: event.verification_state },
      metric: { name: change.metric, direction: change.direction, observed_at: change.observed_at, record_ref: change.record_ref },
      hours_after_deploy: h,
      statement: `${event.site}: "${change.metric}" ${change.direction === "up" ? "artisi" : "dususu"} deploy ${short} sonrasi ${h} saat icinde gozlendi; yalniz zamansal ortusme, iliski kanitlanmadi.`,
      confirming_test: `Commit ${short}'in dokundugu sayfalari dokunmadiklariyla ayni pencerede karsilastir; fark yalniz dokunulan sayfalarda ise aday guclenir, her ikisinde de varsa elenir.`,
    },
  };
}
