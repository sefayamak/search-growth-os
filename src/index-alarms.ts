/**
 * index-alarms — URL Inspection ORNEKLEMINDEN turetilen indeks alarmlari + canonical backlog.
 *
 * Neden ayri modul: index-probe tek bir kosunun anlik goruntusudur; "ayni URL 24 saatten uzun
 * suredir indekste degil" bilgisi ancak iki kosu arasindaki fark ile bilinir. Bu modul o fark
 * icin yerel bir gecmis tutar. SAF mantik + ince dosya G/C; ag yok, Indexing API yok, uretim yazisi yok.
 *
 * Degismez kurallar:
 *  - Her cikti `coverage_basis: "sample"` tasir; ornek boyu ve (biliniyorsa) evren boyu yazilir.
 *    Hicbir yerde "site X yuzde indekslenmis" denmez: ornekten tum siteye yuzde cikarmak uydurma
 *    istatistiktir (CLAUDE.md kural 4).
 *  - Ornek yoksa sonuc UNKNOWN'dur, "ok" degil (kural 6: yanlis negatif daha tehlikeli).
 *  - Alarm INFERENCE/CANDIDATE'tir; onaylayan test elle URL Inspection'dir. Kod hicbir seyi onaylamaz.
 *  - Canonical backlog'unu yalniz sahip kapatir; kod ASLA RESOLVED_BY_OWNER yazmaz.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import type { ProbeResult } from "./index-probe.ts";
import { classifyCanonicalRelations, type CanonicalRelations, type CanonicalPattern } from "./canonical-relations.ts";

export const HISTORY_SCHEMA = "sgos.index-history.v1";
export const BACKLOG_SCHEMA = "sgos.canonical-backlog.v1";
export const MAX_SNAPSHOTS = 120;
export const ALARM_MIN_HOURS = 24;
export const CONFIRMING_TEST = "Manuel URL Inspection (Search Console arayuzunde canli test) + sayfanin gercek HTTP/robots/canonical durumunu elle dogrula";

type Tri = boolean | "UNKNOWN";
export type Verdict = "INDEXED" | "NOT_INDEXED" | "NEUTRAL" | "UNKNOWN";

export interface HistoryEntry {
  url: string;
  /** INSPECTED = Google cevap verdi; ERROR = cagri hatasi (indekslenmemis DEGIL, gozlem de DEGIL). */
  state: "INSPECTED" | "ERROR";
  verdict: Verdict;
  /** "Indekslenmeli" kosullari. Biri UNKNOWN ise URL degerlendirilemez; alarm uretilmez ama sayilir. */
  in_sitemap: Tri;
  /** Google'in sayfa fetch'i basarili mi (pageFetchState). Bizim kendi HTTP 200 olcumumuz DEGIL. */
  fetch_ok: Tri;
  canonical_self: Tri;
  indexable: Tri;
}

export interface Snapshot {
  taken_at: string;
  site: string;
  sample_size: number;
  universe_size: number | "UNKNOWN";
  stopped: string | null;
  entries: HistoryEntry[];
}

export interface IndexHistory { schema: typeof HISTORY_SCHEMA; site: string; snapshots: Snapshot[] }

const SITE_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;
const TRI = (v: unknown) => v === true || v === false || v === "UNKNOWN";
const VERDICTS = ["INDEXED", "NOT_INDEXED", "NEUTRAL", "UNKNOWN"];

export function emptyHistory(site: string): IndexHistory {
  if (!SITE_RE.test(site)) throw new Error(`gecersiz site kimligi: ${site}`);
  return { schema: HISTORY_SCHEMA, site, snapshots: [] };
}

const isTime = (v: unknown): v is string => typeof v === "string" && !Number.isNaN(Date.parse(v));

/** Fail-closed: bozuk dosya sessizce bos gecmise donusmez; atar. Bos gecmis "sorun yok" gibi okunurdu. */
export function parseHistory(raw: unknown, expectedSite: string): IndexHistory {
  const bad = (m: string): never => { throw new Error(`index-history gecersiz: ${m}`); };
  if (!raw || typeof raw !== "object") return bad("kok nesne degil");
  const h = raw as Record<string, unknown>;
  if (h.schema !== HISTORY_SCHEMA) bad(`schema ${String(h.schema)} != ${HISTORY_SCHEMA}`);
  // Portfoy izolasyonu: baska sitenin dosyasi bu siteye okunamaz.
  if (h.site !== expectedSite) bad(`site '${String(h.site)}' beklenen '${expectedSite}' ile uyusmuyor`);
  if (!Array.isArray(h.snapshots)) return bad("snapshots dizi degil");
  if (h.snapshots.length > MAX_SNAPSHOTS) bad(`${h.snapshots.length} snapshot > ${MAX_SNAPSHOTS}`);
  let prev = -Infinity;
  for (const [i, s0] of (h.snapshots as unknown[]).entries()) {
    const s = s0 as Record<string, unknown>;
    if (!s || typeof s !== "object") return bad(`snapshot[${i}] nesne degil`);
    if (!isTime(s.taken_at)) bad(`snapshot[${i}].taken_at`);
    const t = Date.parse(s.taken_at as string);
    if (t <= prev) bad(`snapshot[${i}] zaman sirasi artmiyor`);
    prev = t;
    if (s.site !== expectedSite) bad(`snapshot[${i}].site`);
    if (!Number.isInteger(s.sample_size) || (s.sample_size as number) < 0) bad(`snapshot[${i}].sample_size`);
    if (!(s.universe_size === "UNKNOWN" || (Number.isInteger(s.universe_size) && (s.universe_size as number) >= 0))) bad(`snapshot[${i}].universe_size`);
    if (!Array.isArray(s.entries)) return bad(`snapshot[${i}].entries`);
    for (const [j, e0] of (s.entries as unknown[]).entries()) {
      const e = e0 as Record<string, unknown>;
      if (!e || typeof e.url !== "string" || !e.url) return bad(`snapshot[${i}].entries[${j}].url`);
      if (e.state !== "INSPECTED" && e.state !== "ERROR") bad(`snapshot[${i}].entries[${j}].state`);
      if (!VERDICTS.includes(e.verdict as string)) bad(`snapshot[${i}].entries[${j}].verdict`);
      for (const k of ["in_sitemap", "fetch_ok", "canonical_self", "indexable"]) if (!TRI(e[k])) bad(`snapshot[${i}].entries[${j}].${k}`);
    }
  }
  return h as unknown as IndexHistory;
}

/** Probe sonucu -> snapshot. Uygunluk alanlari yalniz probe'un FACT alanlarindan; eksik = UNKNOWN. */
export function snapshotFromProbe(p: ProbeResult, takenAt: string, universeSize: number | "UNKNOWN" = "UNKNOWN"): Snapshot {
  const entries: HistoryEntry[] = p.results.map((r) => {
    const s = r.summary;
    const known = (v: string) => v !== "UNKNOWN";
    // HOST_VARIANT_RISK ve segmentsiz (gsc) kosu: sitemap uyeligi bilinmiyor.
    const in_sitemap: Tri = r.segment === "SITEMAP_NOT_OBSERVED_IN_GSC_WINDOW" || r.segment === "SITEMAP_AND_GSC" ? true
      : r.segment === "GSC_NOT_IN_SITEMAP" ? false : "UNKNOWN";
    const fetch_ok: Tri = known(s.page_fetch_state) ? s.page_fetch_state === "SUCCESSFUL" : "UNKNOWN";
    const pat = r.canonical_relations?.canonical_pattern;
    const canonical_self: Tri = !pat || pat === "INCOMPLETE" ? "UNKNOWN" : pat === "INSPECTED_USER_GOOGLE_ALIGNED";
    const indexable: Tri = known(s.indexing_state) && known(s.robots_txt_state)
      ? s.indexing_state === "INDEXING_ALLOWED" && s.robots_txt_state === "ALLOWED" : "UNKNOWN";
    return { url: r.url, state: s.state === "INSPECTED" ? "INSPECTED" : "ERROR", verdict: s.index_verdict as Verdict, in_sitemap, fetch_ok, canonical_self, indexable };
  });
  return { taken_at: takenAt, site: p.site, sample_size: entries.filter((e) => e.state === "INSPECTED").length, universe_size: universeSize, stopped: p.stopped, entries };
}

/** Yeni snapshot ekler; eskileri kirpar (<=120). Girdiyi degistirmez. */
export function appendSnapshot(h: IndexHistory, s: Snapshot): IndexHistory {
  if (s.site !== h.site) throw new Error(`portfoy izolasyonu: snapshot sitesi '${s.site}' gecmis sitesi '${h.site}' ile ayni degil`);
  const snaps = [...h.snapshots, s];
  return parseHistory({ ...h, snapshots: snaps.slice(-MAX_SNAPSHOTS) }, h.site);
}

// ---------------------------------------------------------------------------
// (2) Indeks alarmlari
// ---------------------------------------------------------------------------

export interface Coverage { coverage_basis: "sample"; sample_size: number; universe_size: number | "UNKNOWN"; note: string }

export interface IndexAlarm {
  url: string;
  evidence_label: "INFERENCE";
  confidence: "CANDIDATE";
  review_status: "REVIEW_REQUIRED";
  first_observed_not_indexed: string;
  last_observed_not_indexed: string;
  hours_between: number;
  observations: number;
  latest_verdict: Verdict;
  confirming_test: string;
  statement: string;
}

export interface IndexAlarmReport {
  site: string;
  generated_at: string;
  status: "ALARMS" | "NO_ALARM_IN_SAMPLE" | "UNKNOWN";
  unknown_reason?: string;
  coverage: Coverage;
  /** Son snapshot'ta uygunlugu degerlendirilemeyen (bir kosul UNKNOWN) URL sayisi: "alarm yok" bunlar hakkinda bir sey demez. */
  unassessed_in_latest: number;
  checked: string;
  alarms: IndexAlarm[];
}

const eligible = (e: HistoryEntry) => e.in_sitemap === true && e.fetch_ok === true && e.canonical_self === true && e.indexable === true;
const assessed = (e: HistoryEntry) => [e.in_sitemap, e.fetch_ok, e.canonical_self, e.indexable].every((v) => v !== "UNKNOWN");

function coverageOf(h: IndexHistory): Coverage {
  const last = h.snapshots[h.snapshots.length - 1];
  return {
    coverage_basis: "sample",
    sample_size: last?.sample_size ?? 0,
    universe_size: last?.universe_size ?? "UNKNOWN",
    note: "URL Inspection ORNEKLEMI; sitenin tamamini temsil etmez. Ornekten tum site icin oran cikarilmaz.",
  };
}

export function computeIndexAlarms(h: IndexHistory, nowIso: string): IndexAlarmReport {
  const coverage = coverageOf(h);
  const base = { site: h.site, generated_at: nowIso, coverage, alarms: [] as IndexAlarm[] };
  const last = h.snapshots[h.snapshots.length - 1];
  const checked = "Kosul: sitemap'te + Google fetch basarili + canonical kendisi + indekslenebilir; ardisik >=2 gozlemde INDEXED degil (NOT_INDEXED/NEUTRAL/UNKNOWN) ve ilk-son fark >24 saat.";
  if (!last || last.sample_size === 0) {
    return { ...base, status: "UNKNOWN", unknown_reason: !last ? "hic snapshot yok" : "son snapshot'ta denetlenen URL yok (ornek bos / NOT_CONNECTED / erken durdu)", unassessed_in_latest: 0, checked };
  }
  const unassessed = last.entries.filter((e) => e.state === "INSPECTED" && !assessed(e)).length;
  if (h.snapshots.length < 2) {
    return { ...base, status: "UNKNOWN", unknown_reason: "tek snapshot var; sure karsilastirmasi icin en az iki gozlem gerekir", unassessed_in_latest: unassessed, checked };
  }
  const alarms: IndexAlarm[] = [];
  for (const url of new Set(last.entries.map((e) => e.url))) {
    // Sondan geriye: yalniz o URL'nin GOZLENDIGI snapshot'lar. ERROR gozlem sayilmaz (ne uzatir ne keser);
    // INDEXED ya da uygunluk kaybi seriyi keser.
    const run: { at: string; e: HistoryEntry }[] = [];
    for (let i = h.snapshots.length - 1; i >= 0; i--) {
      const e = h.snapshots[i].entries.find((x) => x.url === url);
      if (!e || e.state === "ERROR") continue;
      if (e.verdict === "INDEXED" || !eligible(e)) break;
      run.push({ at: h.snapshots[i].taken_at, e });
    }
    if (run.length < 2) continue;
    // Seri son snapshot'ta bitmiyorsa (son gozlem ERROR/uygunsuz) guncel degil.
    if (run[0].at !== last.taken_at) continue;
    const first = run[run.length - 1], newest = run[0];
    const hours = (Date.parse(newest.at) - Date.parse(first.at)) / 3_600_000;
    if (!(hours > ALARM_MIN_HOURS)) continue;
    alarms.push({
      url, evidence_label: "INFERENCE", confidence: "CANDIDATE", review_status: "REVIEW_REQUIRED",
      first_observed_not_indexed: first.at, last_observed_not_indexed: newest.at, hours_between: Math.round(hours * 10) / 10,
      observations: run.length, latest_verdict: newest.e.verdict, confirming_test: CONFIRMING_TEST,
      statement: `Indekslenmesi beklenen URL, ${run.length} ornek gozleminde indekste dogrulanmadi (son karar ${newest.e.verdict}). Bu bir cikarimdir: URL Inspection ornekleme gecikmesi veya Google tarafi gecici durum olabilir.`,
    });
  }
  alarms.sort((a, b) => b.hours_between - a.hours_between || a.url.localeCompare(b.url));
  return { ...base, status: alarms.length ? "ALARMS" : "NO_ALARM_IN_SAMPLE", unassessed_in_latest: unassessed, checked, alarms };
}

// ---------------------------------------------------------------------------
// (3) Canonical conflict backlog
// ---------------------------------------------------------------------------

export type BacklogStatus = "OPEN" | "ACKNOWLEDGED" | "RESOLVED_BY_OWNER";
export type TrackedPattern = Extract<CanonicalPattern, "DECLARED_GOOGLE_CONFLICT" | "GOOGLE_USER_CONVERGE_ON_OTHER_URL">;

export interface BacklogEntry {
  url: string;
  pattern: TrackedPattern;
  cross_domain: Tri;
  first_seen: string;
  last_seen: string;
  /** Kodun yazdigi tek durum alani OBSERVED/NOT_OBSERVED'dir; `owner_status`'a kod DOKUNMAZ. */
  observation: "OBSERVED" | "NOT_OBSERVED";
  not_observed_reason?: "INSPECTED_NO_LONGER_MATCHING" | "NOT_INSPECTED_IN_SAMPLE";
  /** YALNIZ sahip elle yazar (dosyada). null => OPEN. */
  owner_status: null | "ACKNOWLEDGED" | "RESOLVED_BY_OWNER";
  owner_by?: string;
  owner_at?: string;
  owner_note?: string;
  /** Sahip RESOLVED yazdiktan sonra yeniden gozlendi: kapanis dogrulanamadi. */
  reobserved_after_resolution?: boolean;
}

export interface CanonicalBacklog { schema: typeof BACKLOG_SCHEMA; site: string; entries: BacklogEntry[] }

export function emptyBacklog(site: string): CanonicalBacklog {
  if (!SITE_RE.test(site)) throw new Error(`gecersiz site kimligi: ${site}`);
  return { schema: BACKLOG_SCHEMA, site, entries: [] };
}

export function parseBacklog(raw: unknown, expectedSite: string): CanonicalBacklog {
  const bad = (m: string): never => { throw new Error(`canonical-backlog gecersiz: ${m}`); };
  if (!raw || typeof raw !== "object") return bad("kok nesne degil");
  const b = raw as Record<string, unknown>;
  if (b.schema !== BACKLOG_SCHEMA) bad("schema");
  if (b.site !== expectedSite) bad(`site '${String(b.site)}' beklenen '${expectedSite}' degil`);
  if (!Array.isArray(b.entries)) return bad("entries");
  const seen = new Set<string>();
  for (const [i, e0] of (b.entries as unknown[]).entries()) {
    const e = e0 as Record<string, unknown>;
    if (!e || typeof e.url !== "string") return bad(`entries[${i}].url`);
    if (seen.has(e.url)) bad(`entries[${i}] tekrar: ${e.url}`);
    seen.add(e.url);
    if (e.pattern !== "DECLARED_GOOGLE_CONFLICT" && e.pattern !== "GOOGLE_USER_CONVERGE_ON_OTHER_URL") bad(`entries[${i}].pattern`);
    if (!isTime(e.first_seen) || !isTime(e.last_seen)) bad(`entries[${i}] zaman`);
    if (e.observation !== "OBSERVED" && e.observation !== "NOT_OBSERVED") bad(`entries[${i}].observation`);
    if (!(e.owner_status === null || e.owner_status === "ACKNOWLEDGED" || e.owner_status === "RESOLVED_BY_OWNER")) bad(`entries[${i}].owner_status`);
    if (!TRI(e.cross_domain)) bad(`entries[${i}].cross_domain`);
  }
  return b as unknown as CanonicalBacklog;
}

export const statusOf = (e: BacklogEntry): BacklogStatus => e.owner_status ?? "OPEN";

export interface ScanItem { url: string; canonical_relations?: CanonicalRelations; summary?: { google_canonical: string; user_canonical: string } }

/**
 * Backlog'u tarama sonucuyla guncelle. canonical-relations ciktisi YALNIZ OKUNUR: yeniden siniflandirma yok
 * (relations eksikse mevcut siniflandiriciyi cagiririz, kendi kuralimizi yazmayiz).
 *
 * Kasit: owner_* alanlari birebir korunur; kod status'u asla RESOLVED yapmaz; kaybolan kayit NOT_OBSERVED olur
 * (cunku ornekleme dondugu icin "bu turda denetlenmedi" ile "duzeldi" ayirt edilemez).
 */
export function updateBacklog(b: CanonicalBacklog, scan: ScanItem[], nowIso: string): CanonicalBacklog {
  const rel = (s: ScanItem): CanonicalRelations | null => s.canonical_relations ?? (s.summary ? classifyCanonicalRelations(s.url, s.summary.google_canonical, s.summary.user_canonical) : null);
  const inspected = new Map<string, CanonicalRelations | null>();
  for (const s of scan) inspected.set(s.url, rel(s));
  // Tarama bos ise (NOT_CONNECTED / erken durma) hicbir sey gozlenmedi: kayitlari NOT_OBSERVED'a cevirmek de yanlis olur.
  if (inspected.size === 0) return structuredClone(b);

  const out = new Map<string, BacklogEntry>(b.entries.map((e) => [e.url, structuredClone(e)]));
  const seenNow = new Set<string>();
  for (const [url, r] of inspected) {
    const p = r?.canonical_pattern;
    if (!r || (p !== "DECLARED_GOOGLE_CONFLICT" && p !== "GOOGLE_USER_CONVERGE_ON_OTHER_URL")) continue;
    seenNow.add(url);
    const cross: Tri = r.user_cross_domain === true || r.google_cross_domain === true ? true : r.user_cross_domain === false && r.google_cross_domain === false ? false : "UNKNOWN";
    const prev = out.get(url);
    if (!prev) { out.set(url, { url, pattern: p, cross_domain: cross, first_seen: nowIso, last_seen: nowIso, observation: "OBSERVED", owner_status: null }); continue; }
    prev.pattern = p; prev.cross_domain = cross; prev.last_seen = nowIso; prev.observation = "OBSERVED";
    delete prev.not_observed_reason;
    if (prev.owner_status === "RESOLVED_BY_OWNER") prev.reobserved_after_resolution = true;
  }
  for (const e of out.values()) {
    if (seenNow.has(e.url)) continue;
    // Denetlendi ama artik eslesmiyor: guclu sinyal (yine de cozum kaniti degil). Denetlenmediyse: hicbir sey bilinmiyor.
    // Eksik alanli (INCOMPLETE) denetim de "duzeldi" sayilmaz: relations null degil ama desen INCOMPLETE ise NOT_INSPECTED gibi davranilir.
    const r = inspected.get(e.url);
    e.observation = "NOT_OBSERVED";
    e.not_observed_reason = r && r.canonical_pattern !== "INCOMPLETE" ? "INSPECTED_NO_LONGER_MATCHING" : "NOT_INSPECTED_IN_SAMPLE";
  }
  const entries = [...out.values()].sort((a, c) => a.url.localeCompare(c.url));
  return parseBacklog({ ...b, entries }, b.site);
}

export type AgeBucket = "0-7d" | "8-30d" | "31-90d" | ">90d";
export const ageBucket = (firstSeen: string, nowIso: string): AgeBucket => {
  const d = (Date.parse(nowIso) - Date.parse(firstSeen)) / 86_400_000;
  return d <= 7 ? "0-7d" : d <= 30 ? "8-30d" : d <= 90 ? "31-90d" : ">90d";
};

export interface BacklogReport {
  site: string;
  generated_at: string;
  evidence_label: "INFERENCE";
  confidence: "CANDIDATE" | "UNKNOWN";
  review_status: "REVIEW_REQUIRED";
  coverage_basis: "sample";
  total: number;
  by_status: Record<BacklogStatus, number>;
  aging_open: Record<AgeBucket, number>;
  items: (BacklogEntry & { status: BacklogStatus; age_bucket: AgeBucket })[];
  note: string;
}

export function buildBacklogReport(b: CanonicalBacklog, nowIso: string): BacklogReport {
  const by_status: Record<BacklogStatus, number> = { OPEN: 0, ACKNOWLEDGED: 0, RESOLVED_BY_OWNER: 0 };
  const aging_open: Record<AgeBucket, number> = { "0-7d": 0, "8-30d": 0, "31-90d": 0, ">90d": 0 };
  const items = b.entries.map((e) => {
    const status = statusOf(e), age_bucket = ageBucket(e.first_seen, nowIso);
    by_status[status]++;
    if (status !== "RESOLVED_BY_OWNER") aging_open[age_bucket]++;
    return { ...e, status, age_bucket };
  });
  return {
    site: b.site, generated_at: nowIso, evidence_label: "INFERENCE", confidence: items.length ? "CANDIDATE" : "UNKNOWN", review_status: "REVIEW_REQUIRED",
    coverage_basis: "sample", total: items.length, by_status, aging_open, items,
    note: "Kayitlar ornekleme ile gozlenir; NOT_OBSERVED = bu turda gorulmedi, COZULDU degil. Yalniz sahip owner_status ile RESOLVED_BY_OWNER yazar.",
  };
}

// ---------------------------------------------------------------------------
// (4) Cikti
// ---------------------------------------------------------------------------

export interface CombinedReport { site: string; generated_at: string; index_alarms: IndexAlarmReport; canonical_backlog: BacklogReport }

export function buildReport(h: IndexHistory, b: CanonicalBacklog, nowIso: string): CombinedReport {
  if (h.site !== b.site) throw new Error(`portfoy izolasyonu: gecmis '${h.site}' ve backlog '${b.site}' ayni site degil`);
  return { site: h.site, generated_at: nowIso, index_alarms: computeIndexAlarms(h, nowIso), canonical_backlog: buildBacklogReport(b, nowIso) };
}

export function reportToMarkdown(r: CombinedReport): string {
  const a = r.index_alarms, c = r.canonical_backlog, cov = a.coverage;
  const L = [
    `# index-alarms — ${r.site} — ${r.generated_at.slice(0, 10)}`, "",
    `> **ÖRNEKLEM (coverage_basis: sample) — TAM KAPSAM DEĞİL.** Örnek boyu ${cov.sample_size}; site evreni: ${cov.universe_size}. ${cov.note}`, "",
    "## İndeks alarmları", "", `Durum: **${a.status}**${a.unknown_reason ? ` — ${a.unknown_reason}` : ""}`, "",
    `Bakılan: ${a.checked}`, "", `Son snapshot'ta değerlendirilemeyen (koşul UNKNOWN) URL: ${a.unassessed_in_latest}. "Alarm yok" bunlar hakkında bir şey söylemez.`, "",
  ];
  if (a.alarms.length) {
    L.push("**INFERENCE / CANDIDATE / REVIEW_REQUIRED**", "", "| URL | ilk gözlem | son gözlem | saat | gözlem | karar |", "|---|---|---|---|---|---|");
    for (const x of a.alarms) L.push(`| ${x.url} | ${x.first_observed_not_indexed} | ${x.last_observed_not_indexed} | ${x.hours_between} | ${x.observations} | ${x.latest_verdict} |`);
    L.push("", `Onaylayan test: ${CONFIRMING_TEST}.`, "");
  }
  L.push("## Canonical conflict backlog", "", `**INFERENCE / ${c.confidence} / REVIEW_REQUIRED** — toplam ${c.total}; OPEN ${c.by_status.OPEN}, ACKNOWLEDGED ${c.by_status.ACKNOWLEDGED}, RESOLVED_BY_OWNER ${c.by_status.RESOLVED_BY_OWNER}.`, "",
    `Yaşlanma (kapanmamış): ${(Object.entries(c.aging_open) as [string, number][]).map(([k, v]) => `${k}: ${v}`).join(", ")}`, "", c.note, "");
  if (c.items.length) {
    L.push("| URL | desen | cross-domain | durum | gözlem | ilk | son | yaş |", "|---|---|---|---|---|---|---|---|");
    for (const e of c.items) L.push(`| ${e.url} | ${e.pattern} | ${e.cross_domain} | ${e.status}${e.reobserved_after_resolution ? " (yeniden gözlendi)" : ""} | ${e.observation}${e.not_observed_reason ? ` (${e.not_observed_reason})` : ""} | ${e.first_seen.slice(0, 10)} | ${e.last_seen.slice(0, 10)} | ${e.age_bucket} |`);
  }
  return L.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Dosya G/C (yalniz yerel; data/index-history/<site>.json, data/canonical-backlog/<site>.json)
// ---------------------------------------------------------------------------

export const historyPath = (site: string, root = "data") => `${root}/index-history/${site}.json`;
export const backlogPath = (site: string, root = "data") => `${root}/canonical-backlog/${site}.json`;

/** Dosya YOKSA bos baslar; VARSA ve bozuksa atar (fail-closed). */
export function loadHistory(site: string, root = "data"): IndexHistory {
  const p = historyPath(site, root);
  return existsSync(p) ? parseHistory(JSON.parse(readFileSync(p, "utf8")), site) : emptyHistory(site);
}
export function loadBacklog(site: string, root = "data"): CanonicalBacklog {
  const p = backlogPath(site, root);
  return existsSync(p) ? parseBacklog(JSON.parse(readFileSync(p, "utf8")), site) : emptyBacklog(site);
}
const write = (p: string, v: unknown) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, JSON.stringify(v, null, 2) + "\n"); };
export const saveHistory = (h: IndexHistory, root = "data") => write(historyPath(h.site, root), h);
export const saveBacklog = (b: CanonicalBacklog, root = "data") => write(backlogPath(b.site, root), b);
