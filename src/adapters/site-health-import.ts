/**
 * Site-health snapshot importer — okuma-only, yerel dizin.
 *
 * Bu adapter bir GitHub reposuna, token'a ya da agi gerektirmez: verilen bir
 * DIZINI okur ve dogrular. Dizinin nereden geldigi (git clone, artifact, elle
 * kopya) bu katmanin bilgisi degildir; boylece izleme rutini (site-health-monitor)
 * calismaya devam eder ve burada ona hicbir runtime bagimliligi dogmaz.
 *
 * Beklenen yerlesim (izleme rutininin urettigi hal):
 *   history/clarity/<domain>.jsonl      gunluk ozet satirlari
 *   history/gsc/<domain>.jsonl
 *   cache/clarity/<domain>/<tarih>/*.json   ham yanit: {status, params, data}
 *   cache/gsc/<domain>/<tarih>/pages.json   ham yanit: {status, data:{rows}}
 *
 * Bu modulun var olma sebebi tek cumle: "veri yok" ile "sifir" ayri seylerdir.
 * Rutin, Clarity ag hatasi aldiginda history'ye `real_sessions: 0` yazmisti
 * (2026-09-28, 7 sitenin 7'si). Dogrulanmadan iceri alinsa o sifir, ertesi gunun
 * baseline'i olurdu. Burada ham yanit (cache) o sifirin gercek mi yoksa hata mi
 * oldugunu soyler; kanit yoksa sonuc UNKNOWN'dir.
 */
import { existsSync, readdirSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Confidence } from "../types.ts";
import type { Registry } from "../registry.ts";

export type HealthSource = "clarity" | "gsc";
export type MeasureState = "MEASURED" | "UNKNOWN";

export interface HealthRecord {
  site: string;                 // registry id
  domain: string;
  source: HealthSource;
  date: string;                 // YYYY-MM-DD, snapshot satirinin tarihi
  state: MeasureState;
  /** Ham satirin kendisi bir olcumdur (FACT). Bir sonuc "ne anlama geliyor" cikarimi
   *  burada yapilmaz; o yuzden bu modul INFERENCE uretmez. */
  label: "FACT";
  /** CONFIRMED yalnizca ham yanit (cache) olcumu destekliyorsa. History satiri tek basina
   *  CANDIDATE: kimin urettigi belli, ama kanitlayan ikinci bir kayit yok. */
  confidence: Confidence;
  /** state=UNKNOWN ise neden olcemedigimiz. */
  reason?: string;
  /** Ayni tarih icin kac ayni satir tek kayda indirildi. */
  duplicates_collapsed: number;
  /** state=UNKNOWN ise null — sifir bile degil. */
  metrics: Record<string, unknown> | null;
  notes: string[];
}

export interface ImportRejection { where: string; reason: string }

export interface ImportResult {
  bySite: Record<string, HealthRecord[]>;
  rejected: ImportRejection[];
  /** Registry'de olmayan ve bu yuzden HIC ACILMAYAN domain'ler. */
  rejectedDomains: string[];
}

/** Izleme rutininin GSC sorgusundaki satir siniri. Ayni sayiya ulasan bir yanit
 *  kesilmis olabilir; o durumda toplam, gercek toplamin ALT SINIRIDIR. */
export const GSC_ROW_LIMIT = 200;

interface CacheEvidence {
  present: boolean;
  /** present && hicbir basarisiz yanit yok */
  allOk: boolean;
  failures: string[];
  rowCount?: number;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function readJson(path: string): { ok: true; value: unknown } | { ok: false; reason: string } {
  try { return { ok: true, value: JSON.parse(readFileSync(path, "utf8")) }; }
  catch (e) { return { ok: false, reason: `okunamadi/ayristirilamadi (${(e as Error).name})` }; }
}

/** Sabit anahtar sirali stringify: ayni icerigin farkli anahtar sirasiyla gelmesi
 *  "cakisan satir" sayilmasin. */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stable(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

export function readCacheEvidence(snapshotDir: string, source: HealthSource, domain: string, date: string): CacheEvidence {
  const dir = join(snapshotDir, "cache", source, domain, date);
  if (!existsSync(dir)) return { present: false, allOk: false, failures: [] };
  let files: string[];
  try { files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort(); } catch { return { present: false, allOk: false, failures: [] }; }
  if (!files.length) return { present: false, allOk: false, failures: [] };
  const failures: string[] = [];
  let rowCount: number | undefined;
  for (const f of files) {
    const r = readJson(join(dir, f));
    if (!r.ok) { failures.push(`${f}: ${r.reason}`); continue; }
    const body = r.value as { status?: unknown; data?: { error?: unknown; rows?: unknown } } | null;
    const status = body?.status;
    if (status !== 200) {
      const err = typeof body?.data?.error === "string" ? ` — ${body.data.error.slice(0, 120)}` : "";
      failures.push(`${f}: status ${status === null || status === undefined ? "yok" : String(status)}${err}`);
      continue;
    }
    if (source === "gsc" && Array.isArray(body?.data?.rows)) rowCount = body!.data!.rows.length;
  }
  return { present: true, allOk: failures.length === 0, failures, rowCount };
}

/** Bir satir tek basina bir olcum mu, yoksa "olcemedim"in sifir gibi gorunen hali mi? */
export function classifyClarityRow(row: Record<string, unknown>, cache: CacheEvidence): Pick<HealthRecord, "state" | "confidence" | "reason" | "metrics" | "notes"> {
  const friction = (row.friction && typeof row.friction === "object" ? row.friction : {}) as Record<string, unknown>;
  if (!isNum(row.real_sessions) || !isNum(row.bot_sessions)) {
    return { state: "UNKNOWN", confidence: "UNKNOWN", reason: "real_sessions/bot_sessions sayi degil", metrics: null, notes: [] };
  }
  if (cache.failures.length) {
    return { state: "UNKNOWN", confidence: "UNKNOWN", reason: `Clarity ham yaniti basarisiz (${cache.failures.length} cagri): ${cache.failures[0]}`, metrics: null, notes: ["history satiri sifir olsa da bu bir 'temiz gun' degildir"] };
  }
  const allZero = row.real_sessions === 0 && row.bot_sessions === 0 && Object.keys(friction).length === 0;
  if (allZero && !cache.present) {
    return { state: "UNKNOWN", confidence: "UNKNOWN", reason: "tamami sifir satir ve bunun gercek oldugunu kanitlayan ham yanit (cache) yok", metrics: null, notes: [] };
  }
  const metrics: Record<string, unknown> = {
    real_sessions: row.real_sessions, bot_sessions: row.bot_sessions,
    bot_pct: isNum(row.bot_pct) ? row.bot_pct : null, friction,
  };
  return { state: "MEASURED", confidence: cache.present && cache.allOk ? "CONFIRMED" : "CANDIDATE", metrics, notes: cache.present ? [] : ["ham yanit (cache) yok: yalnizca history satirina dayaniyor"] };
}

export function classifyGscRow(row: Record<string, unknown>, cache: CacheEvidence): Pick<HealthRecord, "state" | "confidence" | "reason" | "metrics" | "notes"> {
  if (!isNum(row.total_clicks) || !isNum(row.total_impressions)) {
    return { state: "UNKNOWN", confidence: "UNKNOWN", reason: "total_clicks/total_impressions sayi degil", metrics: null, notes: [] };
  }
  if (cache.failures.length) {
    return { state: "UNKNOWN", confidence: "UNKNOWN", reason: `GSC ham yaniti basarisiz: ${cache.failures[0]}`, metrics: null, notes: [] };
  }
  if (row.total_clicks === 0 && row.total_impressions === 0 && !cache.present) {
    return { state: "UNKNOWN", confidence: "UNKNOWN", reason: "tamami sifir satir ve bunun gercek oldugunu kanitlayan ham yanit (cache) yok", metrics: null, notes: [] };
  }
  const truncated = cache.rowCount !== undefined && cache.rowCount >= GSC_ROW_LIMIT;
  const notes: string[] = [];
  let totalsComplete: boolean | "UNKNOWN" = "UNKNOWN";
  if (cache.rowCount !== undefined) {
    totalsComplete = !truncated;
    if (truncated) notes.push(`ham yanit ${cache.rowCount} satir (sinir ${GSC_ROW_LIMIT}): toplamlar gercek toplamin ALT SINIRIDIR`);
  } else notes.push("ham yanit yok: toplamin eksiksiz olup olmadigi bilinmiyor");
  return {
    state: "MEASURED",
    // Kesilmis toplam CONFIRMED olamaz: dogru sayi ama eksik evren.
    confidence: cache.present && cache.allOk && !truncated ? "CONFIRMED" : "CANDIDATE",
    metrics: {
      window_start: row.window_start ?? "UNKNOWN", window_end: row.window_end ?? "UNKNOWN",
      total_clicks: row.total_clicks, total_impressions: row.total_impressions,
      zero_click_suspect_count: isNum(row.zero_click_suspect_count) ? row.zero_click_suspect_count : "UNKNOWN",
      totals_complete: totalsComplete,
    },
    notes,
  };
}

function readJsonl(path: string): { rows: Record<string, unknown>[]; bad: number } {
  const rows: Record<string, unknown>[] = [];
  let bad = 0;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line);
      if (v && typeof v === "object" && !Array.isArray(v)) rows.push(v as Record<string, unknown>); else bad++;
    } catch { bad++; }
  }
  return { rows, bad };
}

/**
 * Snapshot dizinini oku, dogrula, site bazinda grupla.
 *
 * Izolasyon yapi geregi: yalnizca REGISTRY'DE KAYITLI domain'lerin dosyalari acilir.
 * Kayitsiz bir domain ya da `../` iceren bir dosya adi hicbir yere yazilmaz, hicbir
 * kayda karismaz — ve `rejectedDomains` icinde gorunur kalir (sessizce atlanmaz).
 */
export function importSnapshot(snapshotDir: string, registry: Registry, only?: string): ImportResult {
  const domainToSite = new Map(registry.sites.map((s) => [s.production_domain, s.id]));
  const out: ImportResult = { bySite: {}, rejected: [], rejectedDomains: [] };
  const seenRejected = new Set<string>();

  for (const source of ["clarity", "gsc"] as const) {
    const histDir = join(snapshotDir, "history", source);
    if (!existsSync(histDir)) { out.rejected.push({ where: `history/${source}`, reason: "dizin yok" }); continue; }
    for (const file of readdirSync(histDir).filter((f) => f.endsWith(".jsonl")).sort()) {
      const domain = file.slice(0, -".jsonl".length);
      const site = domainToSite.get(domain);
      if (!site) {
        if (!seenRejected.has(domain)) { seenRejected.add(domain); out.rejectedDomains.push(domain); }
        continue;
      }
      if (only && site !== only) continue;

      const { rows, bad } = readJsonl(join(histDir, file));
      if (bad) out.rejected.push({ where: `history/${source}/${file}`, reason: `${bad} satir JSON degil, atlandi` });

      // Ayni (site, kaynak, tarih) icin satirlari grupla.
      const byDate = new Map<string, Record<string, unknown>[]>();
      for (const r of rows) {
        const d = r.date;
        if (typeof d !== "string" || !DATE_RE.test(d)) { out.rejected.push({ where: `history/${source}/${file}`, reason: "date alani yok/gecersiz, satir atlandi" }); continue; }
        (byDate.get(d) ?? byDate.set(d, []).get(d)!).push(r);
      }

      for (const date of [...byDate.keys()].sort()) {
        const group = byDate.get(date)!;
        const distinct = new Set(group.map(stable));
        const base = { site, domain, source, date, label: "FACT" as const, duplicates_collapsed: group.length - distinct.size };
        let rec: HealthRecord;
        if (distinct.size > 1) {
          // Hangisinin dogru oldugunu bilmiyoruz; birini secmek uydurmaktir.
          rec = { ...base, duplicates_collapsed: 0, state: "UNKNOWN", confidence: "UNKNOWN", reason: `ayni tarih icin ${distinct.size} FARKLI satir (cakisma); hicbiri secilmedi`, metrics: null, notes: [] };
        } else {
          const cache = readCacheEvidence(snapshotDir, source, domain, date);
          const c = source === "clarity" ? classifyClarityRow(group[0], cache) : classifyGscRow(group[0], cache);
          rec = { ...base, ...c };
        }
        (out.bySite[site] ??= []).push(rec);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Idempotent birlestirme + site basina kalici dosya
// ---------------------------------------------------------------------------

export interface MergeOutcome {
  merged: HealthRecord[];
  added: string[];
  unchanged: string[];
  upgraded: string[];            // UNKNOWN -> MEASURED
  refusedDowngrade: string[];    // MEASURED varken UNKNOWN gelen: eski olcum korunur
  conflicts: string[];           // iki MEASURED farkli: eskisi korunur, insan bakar
}

const keyOf = (r: HealthRecord) => `${r.site}|${r.source}|${r.date}`;

/** Ayni snapshot'i iki kez iceri almak dosyayi DEGISTIRMEMELI. Olcum asla
 *  "olcemedim"e dusurulmez; iki farkli olcum sessizce birbirinin ustune yazilmaz. */
export function mergeRecords(existing: HealthRecord[], incoming: HealthRecord[]): MergeOutcome {
  const map = new Map(existing.map((r) => [keyOf(r), r]));
  const o: MergeOutcome = { merged: [], added: [], unchanged: [], upgraded: [], refusedDowngrade: [], conflicts: [] };
  for (const inc of incoming) {
    const k = keyOf(inc);
    const cur = map.get(k);
    if (!cur) { map.set(k, inc); o.added.push(k); continue; }
    if (stable(cur) === stable(inc)) { o.unchanged.push(k); continue; }
    if (cur.state === "UNKNOWN" && inc.state === "MEASURED") { map.set(k, inc); o.upgraded.push(k); continue; }
    if (cur.state === "MEASURED" && inc.state === "UNKNOWN") { o.refusedDowngrade.push(k); continue; }
    if (cur.state === "MEASURED" && inc.state === "MEASURED") { o.conflicts.push(k); continue; }
    o.unchanged.push(k); // ikisi de UNKNOWN: eskisi kalir, dosya titremez
  }
  o.merged = [...map.values()].sort((a, b) => keyOf(a).localeCompare(keyOf(b)));
  return o;
}

export const storePath = (root: string, site: string) => join(root, "sites", site, "health-import.json");

export function readSiteStore(root: string, site: string): HealthRecord[] {
  const p = storePath(root, site);
  if (!existsSync(p)) return [];
  const parsed = JSON.parse(readFileSync(p, "utf8")) as { site?: string; records?: HealthRecord[] };
  if (parsed.site !== site) throw new Error(`${p}: dosya baska bir site icin (${parsed.site})`);
  return parsed.records ?? [];
}

/** Bir sitenin dosyasina YALNIZCA o sitenin kaydi yazilabilir. */
export function writeSiteStore(root: string, site: string, records: HealthRecord[]): string {
  const foreign = records.find((r) => r.site !== site);
  if (foreign) throw new Error(`izolasyon ihlali: ${site} dosyasina ${foreign.site} kaydi yazilamaz`);
  const p = storePath(root, site);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({ site, records }, null, 2) + "\n");
  return p;
}

export function importReportToMarkdown(res: ImportResult, merges?: Record<string, MergeOutcome>): string {
  const L: string[] = ["# Site-health snapshot importu", "", "Salt-okunur. `UNKNOWN` = olculemedi, sifir DEGIL.", ""];
  for (const site of Object.keys(res.bySite).sort()) {
    const recs = res.bySite[site];
    const m = recs.filter((r) => r.state === "MEASURED").length;
    L.push(`## ${site}: ${recs.length} kayit — ${m} MEASURED, ${recs.length - m} UNKNOWN`);
    for (const r of recs.filter((x) => x.state === "UNKNOWN")) L.push(`- ${r.source} ${r.date}: UNKNOWN — ${r.reason}`);
    const mo = merges?.[site];
    if (mo) L.push(`- birlestirme: +${mo.added.length} yeni, ${mo.unchanged.length} ayni, ${mo.upgraded.length} yukseltildi, ${mo.refusedDowngrade.length} dusurme reddedildi, ${mo.conflicts.length} CAKISMA`);
    L.push("");
  }
  if (res.rejectedDomains.length) L.push(`Kayitsiz domain (hic acilmadi): ${res.rejectedDomains.join(", ")}`, "");
  for (const r of res.rejected) L.push(`- reddedildi: ${r.where} — ${r.reason}`);
  return L.join("\n") + "\n";
}
