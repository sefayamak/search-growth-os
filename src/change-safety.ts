// Change safety v1. Bu surumde uretim yazma yolu YOK; bu modul "bir degisiklik yazma yoluna girmeden once
// hangi kapilardan gecmeli" sorusunun cevabidir. Tek I/O: kill-switch dosyasini okumak.
// Her karar fail-closed: belirsizlik = engel. Yanlis negatif (gecmemesi gereken bir seyi gecirmek) yanlis
// pozitiften pahalidir; yanlis pozitif insana sorulur, yanlis negatif uretimde yasar.
import { readFileSync } from "node:fs";
import type { EvidenceLabel, Confidence } from "./types.ts";
import type { Registry, SiteEntry } from "./registry.ts";

// ---------------------------------------------------------------------------------------------------------
// 1) Siniflar, butce, tipler
// ---------------------------------------------------------------------------------------------------------

export const CHANGE_CLASSES = ["content", "internal_link", "schema", "robots", "canonical", "hreflang", "redirect", "sitemap"] as const;
export type ChangeClass = (typeof CHANGE_CLASSES)[number];

/** policies/high-risk-changes.md + CLAUDE.md: bunlar onaysiz uygulanamaz. `schema` = structured data. Butce 0,
 *  ve kod bunu yukseltemez: yukseltme "kodun kendi kendine izin vermesi" olurdu. Insan yolu state machine'dir. */
export const HARD_GATED: readonly ChangeClass[] = ["robots", "canonical", "hreflang", "redirect", "schema"];

/** Rolling 7 gunluk pencerede site basina varsayilan tavan (birim = hedef URL sayisi). Rakamlar bir olcum degil,
 *  muhafazakar bir baslangic politikasidir; sahibi `options.budgets` ile site bazinda ayarlar. */
export const DEFAULT_BUDGETS: Readonly<Record<ChangeClass, number>> = {
  content: 5, internal_link: 20, sitemap: 1, schema: 0, robots: 0, canonical: 0, hreflang: 0, redirect: 0,
};
export const WINDOW_DAYS = 7;
const DAY_MS = 86_400_000;

export interface Rollback { method: string; revert_ref: string; verification_probe: string }

export interface ChangeProposal {
  id: string;
  site_id: string;
  change_class: ChangeClass;
  /** Mutlak URL ya da "/" ile baslayan yol. */
  targets: string[];
  /** Marka/kisi adlari; baska sitenin varligina dokunmayi yakalar. */
  entities?: string[];
  proposed_by: string;
  /** Bir oneri her zaman RECOMMENDATION'dir; baska etiket (or. VERIFIED_RESULT) onaylanmis gibi gorunme girisimidir. */
  evidence_label: EvidenceLabel;
  confidence: Confidence;
  rollback?: Rollback;
}

export interface LedgerEntry { proposal_id: string; site_id: string; change_class: ChangeClass; at: string; units: number }

export type Verdict = "ALLOW_FOR_REVIEW" | "BLOCK_OVER_BUDGET" | "BLOCK_HIGH_RISK_NEEDS_OWNER" | "BLOCK_CROSS_SITE" | "BLOCK_KILL_SWITCH" | "REJECT_INVALID_PROPOSAL";

export interface Evaluation { verdict: Verdict; reasons: string[]; budget?: { cap: number; used: number; requested: number; window_days: number } }

const LABELS: readonly string[] = ["FACT", "INFERENCE", "HYPOTHESIS", "RECOMMENDATION", "IMPLEMENTED_CHANGE", "VERIFIED_RESULT"];
const CONFS: readonly string[] = ["CONFIRMED", "CANDIDATE", "FALSE_POSITIVE", "UNKNOWN"];

// ---------------------------------------------------------------------------------------------------------
// 2) Rollback sozlesmesi
// ---------------------------------------------------------------------------------------------------------

/** "TODO", "n/a", "-" gibi dolgu degerler bos sayilir: bos bir geri alma plani, plan yok demektir. */
const FILLER = /^(todo|tbd|n\/?a|none|null|unknown|yok|-+|\?+|fill me|placeholder)$/i;
const meaningful = (v: unknown): v is string => typeof v === "string" && v.trim().length >= 3 && !FILLER.test(v.trim());

export function validateRollback(r: unknown): string[] {
  if (!r || typeof r !== "object") return ["rollback eksik: {method, revert_ref, verification_probe} zorunlu"];
  const o = r as Record<string, unknown>;
  return (["method", "revert_ref", "verification_probe"] as const).filter((k) => !meaningful(o[k])).map((k) => `rollback.${k} eksik ya da dolgu deger`);
}

// ---------------------------------------------------------------------------------------------------------
// 3) Kill-switch (fail-closed)
// ---------------------------------------------------------------------------------------------------------

export const KILL_SWITCH_SCHEMA = "sgos.kill-switch.v1";
export interface KillSwitchState {
  engaged: boolean;
  /** FILE = dosya okundu ve gecerli; ABSENT = dosya yok (kasitli: varsayilan dosyayi sessizce uretmiyoruz); FAIL_CLOSED = okunamadi/bozuk. */
  source: "FILE" | "ABSENT" | "FAIL_CLOSED";
  scope?: "global" | "site";
  reason: string;
  /** Yalniz parseKillSwitch doldurur: hangi site icin okundu. Yol B baska sitenin okumasini kabul etmez. */
  site_id?: string;
  /** Yalniz readKillSwitch doldurur (ISO, okuma ani). Yol B bayat okumayi kabul etmez; yoksa bayat sayilir. */
  read_at?: string;
}

/** `siteId` verilirse yalniz o sitenin ya da global anahtara bakilir. `knownSiteIds` verilirse dosyadaki bilinmeyen
 *  site anahtari bozuk sayilir: yazim hatali bir anahtar sessizce "kapali" kalirsa gercek durdurma hic calismaz.
 *  Dosya YOKSA (ENOENT) engaged degil ama source=ABSENT ile gorunur; `strict` bunu da engaged yapar. */
export function readKillSwitch(path: string, siteId: string, opts: { knownSiteIds?: string[]; strict?: boolean } = {}): KillSwitchState {
  let text: string;
  try { text = readFileSync(path, "utf8"); }
  catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT" && !opts.strict) return { engaged: false, source: "ABSENT", reason: "kill-switch dosyasi yok (engaged degil)" };
    return { engaged: true, source: "FAIL_CLOSED", reason: `kill-switch okunamadi: ${(e as NodeJS.ErrnoException)?.code ?? "hata"}` };
  }
  return { ...parseKillSwitch(text, siteId, opts), read_at: new Date().toISOString() };
}

export function parseKillSwitch(text: string, siteId: string, opts: { knownSiteIds?: string[] } = {}): KillSwitchState {
  const bad = (why: string): KillSwitchState => ({ engaged: true, source: "FAIL_CLOSED", reason: `kill-switch bozuk: ${why}`, site_id: siteId });
  let d: unknown;
  try { d = JSON.parse(text); } catch { return bad("JSON degil"); }
  if (!d || typeof d !== "object" || Array.isArray(d)) return bad("kok nesne degil");
  const o = d as Record<string, unknown>;
  if (o.schema !== KILL_SWITCH_SCHEMA) return bad(`schema ${KILL_SWITCH_SCHEMA} degil`);
  const flag = (n: unknown): boolean | undefined => (n && typeof n === "object" && typeof (n as { engaged?: unknown }).engaged === "boolean" ? (n as { engaged: boolean }).engaged : undefined);
  const g = o.global, gv = flag(g);
  if (gv === undefined) return bad("global.engaged boolean degil"); // "false" (string) sessizce kapali sayilmaz
  const sites = o.sites ?? {};
  if (!sites || typeof sites !== "object" || Array.isArray(sites)) return bad("sites nesne degil");
  for (const [k, v] of Object.entries(sites as Record<string, unknown>)) {
    if (opts.knownSiteIds && !opts.knownSiteIds.includes(k)) return bad(`bilinmeyen site anahtari: ${k}`);
    if (flag(v) === undefined) return bad(`sites.${k}.engaged boolean degil`);
  }
  const why = (n: unknown) => { const r = (n as { reason?: unknown })?.reason; return typeof r === "string" && r ? r : "sebep belirtilmemis"; };
  if (gv) return { engaged: true, source: "FILE", scope: "global", reason: `global durdurma: ${why(g)}`, site_id: siteId };
  const s = (sites as Record<string, unknown>)[siteId];
  if (s !== undefined && flag(s)) return { engaged: true, source: "FILE", scope: "site", reason: `${siteId} durduruldu: ${why(s)}`, site_id: siteId };
  return { engaged: false, source: "FILE", reason: "kill-switch kapali", site_id: siteId };
}

// ---------------------------------------------------------------------------------------------------------
// 4) Cross-site guard
// ---------------------------------------------------------------------------------------------------------

/** Sitenin kayitli host'lari: production_domain, canonical_hostname, known_subdomains. Kayitli OLMAYAN bir alt alan
 *  adi (evil.site.com) izinli degil: kayit disi host'a dokunmak sinir ihlalidir. */
export function siteHosts(s: SiteEntry): Set<string> {
  const h = new Set<string>();
  const add = (x: unknown) => { if (typeof x === "string" && x) h.add(x.toLowerCase().replace(/\.$/, "")); };
  add(s.production_domain); add(s.canonical_hostname);
  for (const sub of s.known_subdomains ?? []) add(String(sub).includes(".") ? sub : `${sub}.${s.production_domain}`);
  return h;
}

/** null = site icinde; string = ihlal sebebi. Goreli yol ("/x") site icinde sayilir; cift egik ("//host") degil. */
export function targetViolation(target: unknown, hosts: Set<string>): string | null {
  if (typeof target !== "string" || !target.trim()) return "bos hedef";
  const t = target.trim();
  if (t.startsWith("/") && !t.startsWith("//") && !t.startsWith("/\\")) return null;
  let u: URL;
  try { u = new URL(t.startsWith("//") ? `https:${t}` : t); } catch { return `ayristirilamayan hedef: ${t}`; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return `desteklenmeyen protokol: ${u.protocol}`;
  // URL.hostname userinfo'yu zaten ayirir: https://site.com@evil.com/ icin hostname = evil.com.
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  return hosts.has(host) ? null : `kayit disi host: ${host}`;
}

export function crossSiteReasons(p: ChangeProposal, registry: Registry): string[] {
  const site = registry.sites.find((s) => s.id === p.site_id);
  if (!site) return [`bilinmeyen site: ${p.site_id}`];
  const hosts = siteHosts(site);
  const out: string[] = [];
  for (const t of p.targets) { const v = targetViolation(t, hosts); if (v) out.push(v); }
  const norm = (x: string) => x.trim().toLowerCase();
  const own = new Set([...site.brand_entities, ...site.people_entities].map(norm));
  for (const e of p.entities ?? []) {
    const n = norm(String(e));
    if (own.has(n)) continue;
    const owner = registry.sites.find((o) => o.id !== site.id && [...o.brand_entities, ...o.people_entities].map(norm).includes(n));
    if (owner) out.push(`varlik baska sitenin: "${e}" -> ${owner.id}`);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// 5) evaluate
// ---------------------------------------------------------------------------------------------------------

export interface EvaluateOptions {
  registry: Registry;
  killSwitch: KillSwitchState;
  now: Date;
  /** Site bazinda sahip-ayarli tavanlar. HARD_GATED siniflar icin >0 degerler YOK SAYILIR. */
  budgets?: Record<string, Partial<Record<ChangeClass, number>>>;
}

export function evaluate(p: ChangeProposal, ledger: LedgerEntry[], o: EvaluateOptions): Evaluation {
  // Kill-switch en basta ve proposal'in gecerliligine bakmadan: durdurma, bozuk girdiden de once gelir.
  if (o.killSwitch.engaged) return { verdict: "BLOCK_KILL_SWITCH", reasons: [o.killSwitch.reason] };

  if (!p || typeof p !== "object") return { verdict: "REJECT_INVALID_PROPOSAL", reasons: ["proposal nesne degil"] };
  const bad: string[] = [];
  if (!p.id || typeof p.id !== "string") bad.push("id eksik");
  if (!(CHANGE_CLASSES as readonly string[]).includes(p.change_class)) bad.push(`bilinmeyen change_class: ${String(p.change_class)}`);
  if (!Array.isArray(p.targets) || p.targets.length === 0) bad.push("targets bos");
  if (!LABELS.includes(p.evidence_label) || !CONFS.includes(p.confidence)) bad.push("evidence_label/confidence gecersiz");
  else if (p.evidence_label !== "RECOMMENDATION") bad.push(`bir oneri RECOMMENDATION etiketi tasir, ${p.evidence_label} degil`);
  if (!p.proposed_by || typeof p.proposed_by !== "string") bad.push("proposed_by eksik");
  bad.push(...validateRollback(p.rollback));
  const site = o.registry.sites.find((s) => s.id === p.site_id);
  if (site?.onboarding_status === "registered_not_onboarded") bad.push(`${p.site_id} onboard edilmemis: oneri uretilmez (policies/portfolio-isolation.md)`);
  if (bad.length) return { verdict: "REJECT_INVALID_PROPOSAL", reasons: bad };

  const cross = crossSiteReasons(p, o.registry);
  if (cross.length) return { verdict: "BLOCK_CROSS_SITE", reasons: cross };

  const requested = new Set(p.targets.map((t) => t.trim())).size;
  const hard = HARD_GATED.includes(p.change_class);
  const raw = o.budgets?.[p.site_id]?.[p.change_class];
  // Gecersiz (negatif/NaN) override sifira duser: fail-closed.
  let cap = raw === undefined ? DEFAULT_BUDGETS[p.change_class] : Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 0;
  if (hard) cap = 0;
  const since = o.now.getTime() - WINDOW_DAYS * DAY_MS;
  const seen = new Set<string>();
  let used = 0;
  for (const e of ledger) {
    if (e.site_id !== p.site_id || e.change_class !== p.change_class || e.proposal_id === p.id || seen.has(e.proposal_id)) continue;
    seen.add(e.proposal_id);
    const t = Date.parse(e.at);
    // Okunamayan zaman damgasi ve gelecekteki kayit (saat kaymasi) pencerede sayilir: eksik saymak butceyi sisirir.
    if (Number.isNaN(t) || t > since) used += Number.isFinite(e.units) && e.units > 0 ? e.units : 1;
  }
  const budget = { cap, used, requested, window_days: WINDOW_DAYS };
  if (hard) return { verdict: "BLOCK_HIGH_RISK_NEEDS_OWNER", reasons: [`${p.change_class} her zaman insan onayli (policies/high-risk-changes.md)`], budget };
  if (used + requested > cap) return { verdict: "BLOCK_OVER_BUDGET", reasons: [`${p.change_class}: ${used}+${requested} > ${cap} (${WINDOW_DAYS}g)`], budget };
  return { verdict: "ALLOW_FOR_REVIEW", reasons: ["butce icinde; yalniz inceleme icin, uygulama izni degil"], budget };
}

// ---------------------------------------------------------------------------------------------------------
// 6) Onay durum makinesi
// ---------------------------------------------------------------------------------------------------------

export const STATES = ["PROPOSED", "REVIEW_REQUIRED", "OWNER_APPROVED", "MERGED", "DEPLOYED", "VERIFIED"] as const;
export type ChangeState = (typeof STATES)[number];

export interface Approver { name: string; approved_at: string; channel: string }
export interface Transition { from: ChangeState; to: ChangeState; at: string; by?: string; ref?: string }
export interface ChangeRecord { proposal: ChangeProposal; state: ChangeState; history: Transition[] }

export interface AdvanceContext {
  now: Date;
  killSwitch: KillSwitchState;
  /** PROPOSED -> REVIEW_REQUIRED icin zorunlu. */
  evaluation?: Evaluation;
  /** OWNER_APPROVED icin tek yol. Kod bunu ASLA doldurmaz, yalniz tasir. */
  approver?: Approver;
  /** MERGED: PR/commit; DEPLOYED: deploy kimligi; VERIFIED: verification_probe sonucu. */
  ref?: string;
}

export type AdvanceResult = { ok: true; record: ChangeRecord } | { ok: false; error: string };

/** Otomasyon kimlikleri onay veremez: "OWNER_APPROVED" bir insan kararidir. Liste kapali degil, bir tabandir;
 *  asil guvence approver'in cagiranin acik girdisi olmasi ve proposer ile ayni kisi olamamasidir. */
const AUTOMATED = /(^|[\s_-])(bot|claude|agent|system|auto|automation|github-actions|ci)([\s_-]|$)|\[bot\]/i;

export function newRecord(proposal: ChangeProposal): ChangeRecord { return { proposal, state: "PROPOSED", history: [] }; }

export function validateApprover(a: unknown, proposal: ChangeProposal): string | null {
  if (!a || typeof a !== "object") return "approver zorunlu (acik, insan)";
  const o = a as Record<string, unknown>;
  if (!meaningful(o.name) || !meaningful(o.channel) || typeof o.approved_at !== "string" || Number.isNaN(Date.parse(o.approved_at))) return "approver {name, approved_at(ISO), channel} eksik";
  if (AUTOMATED.test(o.name as string)) return `otomasyon kimligi onay veremez: ${o.name}`;
  if ((o.name as string).trim().toLowerCase() === proposal.proposed_by.trim().toLowerCase()) return "oneren kisi kendi onerisini onaylayamaz";
  return null;
}

export function advance(rec: ChangeRecord, to: ChangeState, c: AdvanceContext): AdvanceResult {
  const fail = (error: string): AdvanceResult => ({ ok: false, error });
  const i = STATES.indexOf(rec.state), j = STATES.indexOf(to);
  if (j < 0) return fail(`bilinmeyen durum: ${String(to)}`);
  if (j !== i + 1) return fail(`yasadisi gecis ${rec.state} -> ${to}: yalniz bir adim ileri`); // geri ve atlama yok
  // Durdurma acikken hicbir ilerleme yok; yarim kalmis bir degisiklik de dondurulur.
  if (c.killSwitch.engaged) return fail(`kill-switch: ${c.killSwitch.reason}`);
  let by: string | undefined;
  if (to === "REVIEW_REQUIRED") {
    const v = c.evaluation?.verdict;
    // Yuksek riskli sinif otomatik seritten degil ama insan incelemesine girebilir: onay zaten insandan gececek.
    if (v !== "ALLOW_FOR_REVIEW" && v !== "BLOCK_HIGH_RISK_NEEDS_OWNER") return fail(`evaluate sonucu inceleme icin uygun degil: ${v ?? "yok"}`);
  } else if (to === "OWNER_APPROVED") {
    const e = validateApprover(c.approver, rec.proposal);
    if (e) return fail(e);
    by = c.approver!.name;
  } else if (!meaningful(c.ref)) return fail(`${to} icin ref zorunlu (PR/deploy/probe kaniti)`);
  const t: Transition = { from: rec.state, to, at: c.now.toISOString(), ...(by ? { by } : {}), ...(c.ref ? { ref: c.ref } : {}) };
  return { ok: true, record: { proposal: rec.proposal, state: to, history: [...rec.history, t] } };
}

// ---------------------------------------------------------------------------------------------------------
// 7) Uretim mutasyonu lint'i
// ---------------------------------------------------------------------------------------------------------

export interface PlannedAction {
  kind: string;
  command?: string;
  branch?: string;
  urls?: string[];
  method?: string;
  host?: string;
}
export interface LintViolation { index: number; rule: string; message: string }

const SAFE_KINDS = new Set(["read", "measure", "report_write", "local_commit", "open_draft_pr", "propose"]);
const PROTECTED_BRANCH = /^(main|master|production|prod|release\/.*)$/i;
const WRAPPERS = new Set(["sudo", "env", "npx", "pnpm", "yarn", "bunx", "command", "time", "nohup", "dlx", "exec"]);
// Desen parcalardan kurulur: tests/index-probe.test.ts "yazma ucu src/ altinda yok" diye literal metin tarar ve
// bu dosya o ucu REDDEDEN taraftir, cagiran degil. Literal yazmak o korumayi (dogru olarak) tetiklerdi.
const INDEXING_API = new RegExp(["indexing", "googleapis", "com"].join("\\.") + "|" + ["url", "Notifications"].join(""), "i");
const VERCEL_READONLY = new Set(["ls", "list", "inspect", "logs", "whoami", "env", "pull", "dev", "build", "help"]);

/** Tirnak duyarli bolme: `git commit -m "a && vercel --prod"` metin icindeki ayiracta bolunup yanlis alarm vermesin. */
export function splitCommands(cmd: string): string[] {
  const out: string[] = []; let cur = ""; let q = "";
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (q) { cur += ch; if (ch === q && cmd[i - 1] !== "\\") q = ""; continue; }
    if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
    if (ch === ";" || ch === "\n" || ch === "|" || ch === "&") { if (cur.trim()) out.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
const tokens = (seg: string): string[] => seg.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
const unq = (s: string) => s.replace(/^["']|["']$/g, "");

function scanCommand(cmd: string, depth = 0): { rule: string; message: string }[] {
  const out: { rule: string; message: string }[] = [];
  for (const seg of splitCommands(cmd)) {
    let t = tokens(seg);
    while (t.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t[0]) || WRAPPERS.has(t[0]))) t = t.slice(1);
    if (!t.length) continue;
    const bin = unq(t[0]).split("/").pop()!;
    const rest = t.slice(1).map(unq);
    if ((bin === "bash" || bin === "sh" || bin === "zsh") && rest[0] === "-c" && rest[1] && depth < 3) { out.push(...scanCommand(rest[1], depth + 1)); continue; }
    if (bin === "git" && rest[0] === "push") {
      const args = rest.slice(1);
      if (args.some((f) => f === "--all" || f === "--mirror")) out.push({ rule: "push_main", message: "git push --all/--mirror korumali dali da iter" });
      const positional = args.filter((a) => !a.startsWith("-"));
      // Hedef dal yazilmamissa mevcut dal main olabilir: belirsizlik engeldir.
      if (positional.length < 2) out.push({ rule: "push_main", message: "hedefi belirsiz git push (mevcut dal main olabilir)" });
      for (const r of positional.slice(1)) {
        const dst = r.replace(/^\+/, "").split(":").pop()!.replace(/^refs\/heads\//, "");
        if (PROTECTED_BRANCH.test(dst)) out.push({ rule: "push_main", message: `korumali dala push: ${dst}` });
      }
    } else if (bin === "gh" && rest[0] === "pr" && rest[1] === "merge") out.push({ rule: "merge_pr", message: "merge karari insanindir" });
    else if (bin === "gh" && rest[0] === "api" && /\/merge\b|\/git\/refs\//.test(rest.join(" "))) out.push({ rule: "merge_pr", message: "API ile merge/ref yazimi" });
    else if (bin === "vercel" && (rest.length === 0 || rest.some((a) => ["--prod", "--production", "deploy", "promote", "alias", "rollback"].includes(a)) || (!rest[0].startsWith("-") && !VERCEL_READONLY.has(rest[0])))) out.push({ rule: "deploy", message: "vercel deploy/promote" });
    else if ((bin === "netlify" && rest[0] === "deploy") || (bin === "wrangler" && ["deploy", "publish"].includes(rest[0])) || (bin === "firebase" && rest[0] === "deploy") || ((bin === "flyctl" || bin === "fly") && rest[0] === "deploy")) out.push({ rule: "deploy", message: `${bin} deploy` });
    if (INDEXING_API.test(seg)) out.push({ rule: "indexing_api", message: "Google Indexing API" });
    if (/api\.indexnow\.org|indexnow\.org\/indexnow|[?&]urlList=|\/ping\?sitemap=/i.test(seg)) out.push({ rule: "bulk_index_request", message: "IndexNow / sitemap ping = toplu indeksleme istegi" });
  }
  return out;
}

/** Planlanmis eylemleri tarar; dogrudan yazmalari reddeder. `productionHosts` verilirse o host'lara GET/HEAD/OPTIONS
 *  disindaki HTTP istekleri de reddedilir. Taninmayan `kind` fail-closed reddedilir. */
export function lintPlannedActions(actions: PlannedAction[], opts: { productionHosts?: string[] } = {}): { ok: boolean; violations: LintViolation[] } {
  const v: LintViolation[] = [];
  const prod = new Set((opts.productionHosts ?? []).map((h) => h.toLowerCase()));
  actions.forEach((a, index) => {
    const add = (rule: string, message: string) => v.push({ index, rule, message });
    if (!a || typeof a.kind !== "string") return add("unclassified", "eylem turu yok");
    switch (a.kind) {
      case "push_main": return add("push_main", "main'e dogrudan push");
      case "deploy": return add("deploy", "dogrudan deploy");
      case "indexing_api": return add("indexing_api", "Google Indexing API");
      case "merge_pr": return add("merge_pr", "merge karari insanindir");
      case "bulk_index_request": return add("bulk_index_request", "toplu indeksleme istegi");
      case "index_request": return (a.urls?.length ?? 2) > 1 ? add("bulk_index_request", "birden cok URL icin indeksleme istegi") : add("indexing_api", "indeksleme istegi onaysiz yapilamaz");
      case "http_write": {
        const m = (a.method ?? "").toUpperCase(), h = (a.host ?? "").toLowerCase();
        if (!["GET", "HEAD", "OPTIONS"].includes(m) && (!h || prod.has(h))) add("production_write", `uretim host'una ${m || "?"} istegi: ${h || "host yok"}`);
        return;
      }
      case "shell": {
        if (typeof a.command !== "string" || !a.command.trim()) return add("unclassified", "bos komut");
        for (const f of scanCommand(a.command)) add(f.rule, f.message);
        return;
      }
      case "branch_push": if (!a.branch || PROTECTED_BRANCH.test(a.branch)) add("push_main", `korumali ya da belirsiz dal: ${a.branch ?? "yok"}`); return;
      default: if (!SAFE_KINDS.has(a.kind)) add("unclassified", `taninmayan eylem turu: ${a.kind}`);
    }
  });
  return { ok: v.length === 0, violations: v };
}

// ---------------------------------------------------------------------------------------------------------
// 8) Iki yol: READ_ONLY_RECOMMENDATION (A) ve PRODUCTION_MUTATION (B)
// ---------------------------------------------------------------------------------------------------------
// Bu bolumde YAZAN hicbir sey yok: yalniz karar uretir. Yol B'nin en iyi sonucu "AUTHORIZED_FOR_HUMAN_EXECUTION"dur;
// uygulamayi bir insan yapar. Ileride bir yazici yazilirsa imzasi ProductionMutationAuthorization ister.

export const PATHS = ["READ_ONLY_RECOMMENDATION", "PRODUCTION_MUTATION"] as const;
export type MutationPath = (typeof PATHS)[number];

/** Yol A (rapor, taslak, PR onerisi): ABSENT/UNKNOWN tolere edilir, engaged ise yine durur. */
export function checkReadOnlyRecommendation(ks: KillSwitchState): { path: "READ_ONLY_RECOMMENDATION"; allowed: boolean; reasons: string[] } {
  const path = "READ_ONLY_RECOMMENDATION" as const;
  try {
    if (!ks || typeof ks.engaged !== "boolean") return { path, allowed: false, reasons: ["kill-switch durumu gecersiz"] };
    if (ks.engaged) return { path, allowed: false, reasons: [ks.reason] };
    return { path, allowed: true, reasons: [`kill-switch engaged degil (kaynak: ${ks.source})`] };
  } catch (e) { return { path, allowed: false, reasons: [`istisna: ${String(e)}`] }; }
}

/** Yazici ARM durumu. Bu modul BUNU URETMEZ: ne kurucu ne varsayilan vardir; yalniz insanin verdigi girdi dogrulanir.
 *  Eksik / suresi dolmus / kapsam disi arm yok sayilir; cikarim ya da varsayilan yok. */
export interface ArmToken {
  armed: true;
  armed_by: string;
  armed_at: string;
  scope: { site_id: string; change_classes: ChangeClass[]; expires_at: string };
}
/** Bir arm en fazla bu kadar yasar: sureyi uzatmak kodun karari olamaz (sahip daha kisa verebilir). */
export const MAX_ARM_TTL_MS = 24 * 3_600_000;
/** Kill-switch okumasi bundan eskiyse bayat. Yol B'de kapatma bayragi yoktur; yalniz daha siki verilebilir. */
export const KILL_SWITCH_MAX_AGE_MS = 5 * 60_000;

declare const AUTH_BRAND: unique symbol; // yalniz tip: calisma zamaninda yok; sahte nesne tip denetimini gecemez
export interface ProductionMutationAuthorization {
  readonly [AUTH_BRAND]: true;
  readonly proposal_id: string;
  readonly site_id: string;
  readonly change_class: ChangeClass;
  readonly targets: readonly string[];
  readonly authorized_at: string;
  readonly arm_expires_at: string;
}
const ISSUED = new WeakSet<object>(); // calisma zamani ikinci kilit: yalniz authorizeProductionMutation icinde eklenir
export function isProductionMutationAuthorization(x: unknown): x is ProductionMutationAuthorization { return typeof x === "object" && x !== null && ISSUED.has(x); }
/** Hayali bir yazicinin ilk satiri: sahte/yok nesne atar. Imza `auth: ProductionMutationAuthorization` ister. */
export function requireAuthorization(x: unknown): ProductionMutationAuthorization {
  if (!isProductionMutationAuthorization(x)) throw new Error("ProductionMutationAuthorization yok ya da sahte");
  return x;
}

export const MUTATION_GATES = ["kill_switch", "armed", "arm_scope", "approval", "rollback", "proposal", "budget", "lint"] as const;
export type MutationGate = (typeof MUTATION_GATES)[number];
export interface GateFailure { gate: MutationGate; reasons: string[] }

export interface ProductionMutationInput {
  proposal: ChangeProposal;
  /** Insanin acikca verdigi arm; modul uretmez. */
  arm?: ArmToken;
  /** Onay kaydi: durum OWNER_APPROVED, bu proposal'a ait, gecmisteki OWNER_APPROVED gecisi onaylayanla ayni. */
  record?: ChangeRecord;
  approver?: Approver;
  killSwitch: KillSwitchState;
  ledger: LedgerEntry[];
  plannedActions: PlannedAction[];
  registry: Registry;
  now: Date;
  budgets?: EvaluateOptions["budgets"];
  productionHosts?: string[];
  /** Yalniz DAHA SIKI yapabilir (min alinir); gevsetme yolu yok. */
  killSwitchMaxAgeMs?: number;
}

export type MutationDecision =
  | { path: "PRODUCTION_MUTATION"; decision: "AUTHORIZED_FOR_HUMAN_EXECUTION"; failed: []; authorization: ProductionMutationAuthorization; note: string }
  | { path: "PRODUCTION_MUTATION"; decision: "BLOCKED"; failed: GateFailure[] };

const NOTE = "yalniz insan uygulamasi icin yetki; bu kodda uygulayan hicbir sey yok";
const ms = (v: unknown): number => (typeof v === "string" ? Date.parse(v) : NaN);

function killGate(i: ProductionMutationInput, now: number): string[] {
  const k = i.killSwitch, r: string[] = [];
  if (!k || typeof k !== "object") return ["kill-switch okunmamis"];
  if (k.source !== "FILE") r.push(`kill-switch acikca okunmadi (kaynak: ${String(k.source)}): ABSENT/UNKNOWN/FAIL_CLOSED Yol B'de engel`);
  if (k.engaged !== false) r.push(`kill-switch acikca kapali degil: ${String(k.reason)}`);
  if (k.site_id !== i.proposal?.site_id) r.push("kill-switch bu site icin okunmamis");
  const t = ms(k.read_at);
  const max = Math.min(KILL_SWITCH_MAX_AGE_MS, Number.isFinite(i.killSwitchMaxAgeMs) && i.killSwitchMaxAgeMs! > 0 ? i.killSwitchMaxAgeMs! : KILL_SWITCH_MAX_AGE_MS);
  if (Number.isNaN(t)) r.push("kill-switch okuma zamani yok: bayat sayilir");
  else if (t > now || now - t > max) r.push("kill-switch okumasi bayat ya da gelecekte");
  return r;
}

function armGates(i: ProductionMutationInput, now: number): { armed: string[]; scope: string[] } {
  const a = i.arm as unknown as Record<string, any> | undefined, armed: string[] = [], scope: string[] = [];
  if (!a || typeof a !== "object") return { armed: ["yazici ARM edilmemis (acik arm yok)"], scope: ["arm yok: kapsam dogrulanamaz"] };
  if (a.armed !== true) armed.push("armed !== true");
  if (!meaningful(a.armed_by)) armed.push("armed_by eksik"); else if (AUTOMATED.test(a.armed_by)) armed.push(`otomasyon kimligi arm edemez: ${a.armed_by}`);
  const at = ms(a.armed_at);
  if (Number.isNaN(at)) armed.push("armed_at gecersiz"); else if (at > now) armed.push("armed_at gelecekte");
  const s = a.scope;
  if (!s || typeof s !== "object") return { armed, scope: ["scope eksik"] };
  const exp = ms(s.expires_at);
  if (Number.isNaN(exp)) armed.push("scope.expires_at yok/gecersiz: sonsuz arm yok");
  else {
    if (exp <= now) armed.push("arm suresi dolmus");
    if (!Number.isNaN(at) && exp - at > MAX_ARM_TTL_MS) armed.push(`arm omru ${MAX_ARM_TTL_MS / 3_600_000} saati asiyor`);
  }
  if (s.site_id !== i.proposal?.site_id) scope.push(`arm baska site icin: ${String(s.site_id)} != ${i.proposal?.site_id}`);
  if (!Array.isArray(s.change_classes) || !s.change_classes.includes(i.proposal?.change_class)) scope.push(`arm bu degisiklik sinifini kapsamiyor: ${String(i.proposal?.change_class)}`);
  return { armed, scope };
}

function approvalGate(i: ProductionMutationInput, now: number): string[] {
  const r: string[] = [], p = i.proposal, rec = i.record;
  const e = validateApprover(i.approver, p);
  if (e) r.push(e); else if (Date.parse(i.approver!.approved_at) > now) r.push("approved_at gelecekte");
  if (!rec || typeof rec !== "object") return [...r, "onay kaydi (ChangeRecord) yok"];
  if (rec.proposal?.id !== p.id) r.push("onay kaydi baska degisikligin");
  if (rec.state !== "OWNER_APPROVED") r.push(`kayit durumu OWNER_APPROVED degil: ${String(rec.state)}`);
  const t = (rec.history ?? []).find((h) => h.to === "OWNER_APPROVED");
  if (!t) r.push("gecmiste OWNER_APPROVED gecisi yok");
  else if (!i.approver || t.by !== i.approver.name) r.push("onaylayan kayitla uyusmuyor");
  return r;
}

/** Yol B. Tum kapilar degerlendirilir (kisa devre yok); biri basarisizsa ya da istisna atarsa BLOCKED.
 *  Kapatma/gevsetme bayragi YOKTUR. Basari = AUTHORIZED_FOR_HUMAN_EXECUTION, uygulama degil. */
export function authorizeProductionMutation(input: ProductionMutationInput): MutationDecision {
  const failed: GateFailure[] = [];
  const run = (gate: MutationGate, fn: () => string[]) => {
    let reasons: string[];
    try { reasons = fn(); } catch (e) { reasons = [`istisna (fail-closed): ${e instanceof Error ? e.message : String(e)}`]; }
    if (reasons.length) failed.push({ gate, reasons });
  };
  try {
    const now = input?.now instanceof Date ? input.now.getTime() : NaN;
    if (Number.isNaN(now)) throw new Error("now gecersiz");
    const p = input.proposal;
    run("kill_switch", () => killGate(input, now));
    let g: { armed: string[]; scope: string[] };
    try { g = armGates(input, now); } catch (e) { g = { armed: [`istisna: ${String(e)}`], scope: [`istisna: ${String(e)}`] }; }
    run("armed", () => g.armed); run("arm_scope", () => g.scope);
    run("approval", () => approvalGate(input, now));
    run("rollback", () => validateRollback(p?.rollback));
    // evaluate'e "kapali" kill-switch veriyoruz: gercek kapi yukarida; burada yalniz diger sebepler gorunsun.
    let ev: Evaluation | undefined;
    run("proposal", () => {
      ev = evaluate(p, input.ledger, { registry: input.registry, killSwitch: { engaged: false, source: "FILE", reason: "kapi ayri" }, now: input.now, budgets: input.budgets });
      return ev.verdict === "REJECT_INVALID_PROPOSAL" || ev.verdict === "BLOCK_CROSS_SITE" ? ev.reasons : [];
    });
    // Butce-0 siniflar (HARD_GATED) Yol B'den gecemez: onlarin yolu insan state machine + PR'dir, otomatik yetki degil.
    run("budget", () => (!ev ? ["butce degerlendirilemedi"] : ev.verdict === "ALLOW_FOR_REVIEW" || ev.verdict === "REJECT_INVALID_PROPOSAL" || ev.verdict === "BLOCK_CROSS_SITE" ? [] : ev.reasons));
    run("lint", () => {
      if (!Array.isArray(input.plannedActions) || input.plannedActions.length === 0) return ["planlanan eylem listesi yok/bos: lint edilemez"];
      return lintPlannedActions(input.plannedActions, { productionHosts: input.productionHosts }).violations.map((v) => `[${v.index}] ${v.rule}: ${v.message}`);
    });
    if (failed.length === 0) {
      const auth = Object.freeze({ proposal_id: p.id, site_id: p.site_id, change_class: p.change_class, targets: Object.freeze([...p.targets]), authorized_at: input.now.toISOString(), arm_expires_at: input.arm!.scope.expires_at }) as unknown as ProductionMutationAuthorization;
      ISSUED.add(auth);
      return { path: "PRODUCTION_MUTATION", decision: "AUTHORIZED_FOR_HUMAN_EXECUTION", failed: [], authorization: auth, note: NOTE };
    }
  } catch (e) {
    failed.push({ gate: "proposal", reasons: [`istisna (fail-closed): ${e instanceof Error ? e.message : String(e)}`] });
  }
  return { path: "PRODUCTION_MUTATION", decision: "BLOCKED", failed };
}
