// Icerik hatti: her kural icin hem yanlis-pozitif (gecerli kayit reddedilmesin) hem yanlis-negatif
// (ihlal gecmesin) testi. Ag yok, Clarity yok.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadRegistry } from "../src/registry.ts";
import {
  STAGES, validateItem, validateTransition, attachRow, classifyFromEvidence, validateRow,
  type ContentItem, type GscRow, type SiteRef,
} from "../src/content-pipeline.ts";

const loaded = loadRegistry(new URL("../config/sites.yaml", import.meta.url).pathname);
const REG = loaded.registry!.sites as SiteRef[];
const A = "pamistanbul", B = "pamaistudio";
const dom = (id: string) => REG.find((s) => s.id === id)!.production_domain;

const row = (site = A, over: Partial<GscRow> = {}): GscRow => ({ site, query: "comfyui nedir", page: `https://${dom(site)}/x`, impressions: 162, clicks: 0, position: 7.8, source: "gsc", date_start: "2026-09-01", date_end: "2026-09-28", ...over });
const item = (over: Record<string, unknown> = {}): ContentItem => ({
  schema: "sgos.content-item.v1", site: A, id: "comfyui-refresh", opportunity_source: "gsc_evidence", gsc_rows: [row()],
  classification: "refresh", stage: "OPPORTUNITY", evidence_label: "INFERENCE", confidence: "CANDIDATE",
  approval: { state: "pending", approver: null }, risk: "low", ...over,
}) as ContentItem;
const errs = (i: unknown) => validateItem(i, REG).errors;

test("registry 7 siteyi yukler (test gercek config'e dayanir)", () => { assert.equal(REG.length, 7); });
test("gecerli kayit gecer (yanlis-pozitif yok)", () => { assert.deepEqual(errs(item()), []); });

test("gsc_evidence kaydi >=1 GSC satiri ister; satirsiz reddedilir", () => {
  assert.ok(errs(item({ gsc_rows: [] })).includes("GSC_ITEM_WITHOUT_GSC_ROW"));
});
test("editorial kayit satir ya da talep iddiasi tasiyamaz; temiz editorial gecer", () => {
  const ed = { opportunity_source: "editorial", gsc_rows: [], classification: "new_page", evidence_label: "HYPOTHESIS", confidence: "UNKNOWN" };
  const ok = item({ ...ed, expected_change: { text: "Konu sitenin kategorisine uyuyor", test: "28 gun sonra GSC'de sorgu goruldu mu" } });
  assert.deepEqual(errs(ok), []);
  assert.ok(errs(item({ ...ed, gsc_rows: [row()], expected_change: { text: "x", test: "y" } })).includes("EDITORIAL_CARRIES_GSC_ROWS"));
  for (const t of ["Aylık arama hacmi yüksek", "high search volume", "500 impressions bekleniyor", "trafik %40 artar", "talep var"]) {
    assert.ok(errs(item({ ...ed, expected_change: { text: t, test: "y" } })).includes("EDITORIAL_DEMAND_CLAIM"), t);
  }
  assert.ok(errs(item({ ...ed, evidence_label: "FACT", expected_change: { text: "a", test: "b" } })).includes("EDITORIAL_LABEL_TOO_STRONG"));
});

test("etiket ontolojisi: EDITORIAL etiket olamaz; cikarim CONFIRMED olamaz", () => {
  assert.ok(errs(item({ evidence_label: "EDITORIAL" })).includes("BAD_EVIDENCE_LABEL"));
  assert.ok(errs(item({ confidence: "CONFIRMED" })).includes("INFERENCE_REPORTED_AS_CONFIRMED"));
  assert.ok(!errs(item({ evidence_label: "FACT", confidence: "CONFIRMED" })).includes("INFERENCE_REPORTED_AS_CONFIRMED"));
  const schema = JSON.parse(readFileSync(new URL("../schemas/content-item.schema.json", import.meta.url), "utf8"));
  assert.equal(schema.properties.evidence_label.enum.length, 6);
  assert.deepEqual(schema.properties.stage.enum, [...STAGES]);
  assert.equal(schema.additionalProperties, false);
});

test("hypothesis test adi vermek zorunda; expected_change test'siz olamaz", () => {
  assert.ok(errs(item({ evidence_label: "HYPOTHESIS" })).includes("HYPOTHESIS_WITHOUT_TEST"));
  assert.ok(errs(item({ expected_change: { text: "tiklama artar", test: "" } })).includes("EXPECTED_CHANGE_NEEDS_TEXT_AND_TEST"));
  assert.deepEqual(errs(item({ evidence_label: "HYPOTHESIS", expected_change: { text: "t", test: "28g sonra GSC karsilastir" } })), []);
});

test("taslak govdesi tasinamaz; draft_ref yalniz kendi sitesinin dizini", () => {
  assert.ok(errs({ ...item(), draft_body: "<h1>x</h1>" }).includes("UNKNOWN_KEY:draft_body"));
  const d = (p: string) => errs(item({ stage: "DRAFT", draft_ref: p }));
  assert.deepEqual(d(`sites/${A}/drafts/comfyui.md`), []);
  assert.ok(d(`sites/${B}/drafts/comfyui.md`).includes("BAD_DRAFT_REF"));
  assert.ok(d(`sites/${A}/drafts/../../x`).includes("BAD_DRAFT_REF"));
  assert.ok(d("<h1>govde</h1>").includes("BAD_DRAFT_REF"));
  assert.ok(errs(item({ stage: "DRAFT" })).includes("STAGE_REQUIRES_DRAFT_REF"));
});

const full = (stage: string, approval: any, over: Record<string, unknown> = {}) => item({
  stage, draft_ref: `sites/${A}/drafts/a.md`, approval,
  pr: { url: "https://github.com/x/y/pull/1", draft: true, merged_at: "2026-10-03", deployed_at: "2026-10-04" }, ...over,
});
const OK = { state: "approved", approver: "Sefa Yamak", approved_at: "2026-10-02" };

test("HUMAN_APPROVAL ve sonrasi insan onayi ister; varsayilan/bot ad onay degildir", () => {
  assert.deepEqual(errs(full("HUMAN_APPROVAL", OK)), []);
  for (const stage of ["HUMAN_APPROVAL", "MERGE", "DEPLOYMENT_VERIFICATION", "LATER_MEASUREMENT"]) {
    assert.ok(errs(full(stage, { state: "pending", approver: null })).includes("STAGE_REQUIRES_APPROVAL"), stage);
  }
  for (const who of [null, "", "  ", "claude", "github-actions[bot]", "default", "UNKNOWN", "auto"]) {
    assert.ok(errs(full("MERGE", { state: "approved", approver: who, approved_at: "2026-10-02" })).includes("APPROVAL_WITHOUT_HUMAN_APPROVER"), String(who));
  }
  assert.ok(errs(item({ approval: OK })).includes("APPROVED_BEFORE_APPROVAL_STAGE"));
});

test("gecis: yalniz ileri ve bir adim; MERGE onaysiz girilemez", () => {
  const at = (s: string, over: Record<string, unknown> = {}) => full(s, { state: "pending", approver: null }, over);
  const i = item({ stage: "GSC_EVIDENCE" });
  assert.ok(validateTransition(i, "OPPORTUNITY", REG).ok);
  assert.ok(validateTransition(i, "DRAFT", REG).errors.includes("SKIPPED_STAGE"));
  assert.ok(validateTransition(item({ stage: "CLASSIFICATION" }), "OPPORTUNITY", REG).errors.includes("BACKWARD_OR_SAME_TRANSITION"));
  assert.ok(validateTransition(item({ stage: "OPPORTUNITY" }), "OPPORTUNITY", REG).errors.includes("BACKWARD_OR_SAME_TRANSITION"));
  const pr = at("PR");
  assert.ok(validateTransition(pr, "HUMAN_APPROVAL", REG).errors.includes("TARGET:STAGE_REQUIRES_APPROVAL"));
  // onay alani doldurulmus kayit HUMAN_APPROVAL'a girebilir (insan onayi gecisten once yazilir)
  assert.ok(validateTransition({ ...pr, approval: OK as any }, "HUMAN_APPROVAL", REG).ok);
  assert.ok(!validateTransition(at("HUMAN_APPROVAL"), "MERGE", REG).ok);
  assert.ok(validateTransition(full("HUMAN_APPROVAL", OK), "MERGE", REG).ok);
  assert.ok(validateTransition(at("REVIEW"), "MERGE", REG).errors.includes("SKIPPED_STAGE"));
  assert.ok(!validateTransition(item({ stage: "CLASSIFICATION", classification: "skip" }), "DRAFT", REG).ok);
});

test("PR taslak (draft) olmak zorunda", () => {
  assert.ok(errs(full("PR", { state: "pending", approver: null }, { pr: { url: "u", draft: false } })).includes("PR_MUST_BE_DRAFT"));
});

test("site izolasyonu: baska siteye ait sorgu/satir/sayfa eklenemez", () => {
  const foreign = row(B, { query: "pamaistudio sorgusu" });
  assert.throws(() => attachRow(item(), foreign, REG), /CROSS_SITE_ROW/);
  assert.ok(errs(item({ gsc_rows: [foreign] })).some((x) => x.includes("CROSS_SITE_ROW")));
  assert.throws(() => attachRow(item(), row(A, { page: `https://${dom(B)}/y` }), REG), /ROW_PAGE_FOREIGN_DOMAIN/);
  assert.equal(attachRow(item(), row(A, { query: "ikinci", page: `https://www.${dom(A)}/z` }), REG).gsc_rows.length, 2);
  for (const s of REG) for (const o of REG) {
    if (s.id === o.id) continue;
    assert.ok(validateRow(row(o.id), s).some((x) => x.startsWith("CROSS_SITE_ROW")), `${o.id}->${s.id}`);
  }
  // domain son-ek tuzagi: evil<domain> bizim degil
  assert.ok(validateRow(row(A, { page: `https://evil${dom(A)}/` }), REG[0]).includes("ROW_PAGE_FOREIGN_DOMAIN"));
});

test("kayitsiz ve onboard edilmemis site: kayit uretilmez", () => {
  assert.ok(errs(item({ site: "yok" })).includes("SITE_NOT_IN_REGISTRY:yok"));
  const reg2 = REG.map((s) => (s.id === B ? { ...s, onboarding_status: "registered_not_onboarded" as const } : s));
  assert.ok(validateItem(item({ site: B, gsc_rows: [row(B)] }), reg2).errors.includes("SITE_NOT_ONBOARDED"));
  assert.ok(!errs(item({ site: B, gsc_rows: [row(B)] })).includes("SITE_NOT_ONBOARDED"));
});

test("satir: UNKNOWN metrik gecerli, uydurma/negatif/tarih bozuk reddedilir", () => {
  assert.deepEqual(validateRow(row(A, { impressions: "UNKNOWN", clicks: "UNKNOWN", position: "UNKNOWN" }), REG[0]), []);
  assert.ok(validateRow(row(A, { impressions: -1 }), REG[0]).includes("ROW_BAD_IMPRESSIONS"));
  assert.ok(validateRow(row(A, { clicks: 500 }), REG[0]).includes("ROW_CLICKS_GT_IMPRESSIONS"));
  assert.ok(validateRow(row(A, { date_end: "dun" }), REG[0]).includes("ROW_BAD_DATE_END"));
  assert.ok(validateRow(row(A, { date_start: "2026-10-01", date_end: "2026-09-01" }), REG[0]).includes("ROW_DATE_ORDER"));
  assert.ok(validateRow({ ...row(), source: "ahrefs" }, REG[0]).includes("ROW_SOURCE_NOT_GSC"));
  assert.ok(errs(item({ gsc_rows: [row(A, { impressions: "UNKNOWN" })] })).includes("CLASSIFIED_WITHOUT_MEASURED_IMPRESSIONS"));
});

test("siniflandirma: 8-20 + gosterim => refresh INFERENCE/CANDIDATE, asla CONFIRMED", () => {
  const c = classifyFromEvidence([row(A, { position: 11.2, impressions: 300 })]);
  assert.deepEqual([c.classification, c.evidence_label, c.confidence], ["refresh", "INFERENCE", "CANDIDATE"]);
  assert.equal(classifyFromEvidence([row(A, { position: 8 })]).classification, "refresh");
  assert.equal(classifyFromEvidence([row(A, { position: 20 })]).classification, "refresh");
});
test("siniflandirma: kanit yok/UNKNOWN/dusuk gosterim => skip UNKNOWN (yanlis-negatif: sessiz gecme)", () => {
  const none = classifyFromEvidence([]);
  assert.deepEqual([none.classification, none.confidence], ["skip", "UNKNOWN"]);
  assert.match(none.reason, /kanit satiri yok/);
  const unk = classifyFromEvidence([row(A, { impressions: "UNKNOWN", position: "UNKNOWN" })]);
  assert.equal(unk.confidence, "UNKNOWN"); assert.equal(unk.rows_unknown, 1); assert.match(unk.reason, /UNKNOWN/);
  assert.equal(classifyFromEvidence([row(A, { impressions: 3, position: 10 })]).classification, "skip");
});
test("siniflandirma: ust sira, >20 ve kanibalizasyon", () => {
  assert.equal(classifyFromEvidence([row(A, { position: 3 })]).classification, "skip");
  assert.equal(classifyFromEvidence([row(A, { position: 35 })]).classification, "new_page");
  const two = classifyFromEvidence([row(A, { position: 9, page: `https://${dom(A)}/a` }), row(A, { position: 12, page: `https://${dom(A)}/b` })]);
  assert.equal(two.classification, "consolidate");
});
