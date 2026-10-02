// Sözleşme testleri: her kontrol için yanlış-pozitif (haksız engel) VE yanlış-negatif
// (kaçan ihlal) testi. Yanlış negatif daha tehlikeli: "sorun yok" denen öneri uygulanır.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadRegistry, type Registry } from "../src/registry.ts";
import {
  validateInternalLink, validateSchemaEntity, renderReviewQueue, siteOfHost, summarize,
  APPROVAL_STATES, RISKS, SCHEMA_TYPE_ALLOWLIST, PROPOSAL_LABELS, type QueueItem,
} from "../src/agent-contracts.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const loaded = loadRegistry(join(root, "config", "sites.yaml"));
assert.ok(loaded.ok, loaded.errors.join("\n"));
const reg = loaded.registry as Registry;
const SITES = ["pamistanbul", "pamaistudio", "spryhand", "decideplan", "rightlisted", "untitledportraits", "myhappymade"];

const link = (o: Record<string, unknown> = {}) => ({
  id: "L1", kind: "internal_link", site: "pamistanbul",
  source_url: "https://pamistanbul.com/blog/a", target_url_or_entity: "https://pamistanbul.com/hizmetler/b",
  reason: "A sayfası B konusunu anlatıyor ama linklemiyor", evidence: { refs: ["crawl:run-1#/blog/a"], label: "FACT" },
  confidence: "CANDIDATE", risk: "low",
  expected_change: { hypothesis: "B sayfasına iç link sayısı artarsa GSC'de B için tıklama artar", test: "28 gün önce/sonra GSC karşılaştırması, kontrol sayfalarıyla" },
  approval_state: "PROPOSED", mutation: "none", ...o,
});
const schema = (o: Record<string, unknown> = {}) => ({
  id: "S1", kind: "schema_entity", site: "spryhand", source_url: "https://spryhand.com/about",
  target_url_or_entity: "Spryhand", reason: "About sayfasında Organization schema yok",
  evidence: { refs: ["crawl:run-2#/about"], label: "FACT" }, confidence: "CANDIDATE", risk: "medium",
  expected_change: { hypothesis: "Entity netliği AI cevaplarında marka adının doğru geçmesini sağlar", test: "Aynı 10 sorguyu önce/sonra elle işaretle" },
  approval_state: "REVIEW_REQUIRED", mutation: "none", schema_type: "Organization",
  jsonld_draft: { "@context": "https://schema.org", "@type": "Organization", name: "Spryhand", url: "https://spryhand.com" },
  fact_sources: [], ...o,
});
const codes = (r: { issues: { code: string }[] }) => r.issues.map((i) => i.code);

// --- host sahipliği ---
test("siteOfHost: tam eşitlik; benzer host başka sitenin ya da bizim sayılmaz", () => {
  assert.equal(siteOfHost(reg, "www.pamistanbul.com"), "pamistanbul");
  assert.equal(siteOfHost(reg, "pamaistudio.com"), "pamaistudio");
  assert.equal(siteOfHost(reg, "evilpamistanbul.com"), null, "endsWith olsaydı lookalike içeri girerdi");
  assert.equal(siteOfHost(reg, "pamistanbul.com.evil.net"), null);
  for (const id of SITES) assert.ok(reg.sites.some((s) => s.id === id));
});

// --- iç link ---
test("iç link: geçerli öneri kabul (yanlış pozitif yok), www varyantı sahip sayılır", () => {
  assert.equal(validateInternalLink(link(), reg).verdict, "ACCEPTED");
  assert.equal(validateInternalLink(link({ target_url_or_entity: "https://www.pamistanbul.com/x" }), reg).verdict, "ACCEPTED");
});
test("iç link: pamistanbul.com -> pamaistudio.com BLOCKED_CROSS_SITE (bilinen vaka)", () => {
  const r = validateInternalLink(link({ target_url_or_entity: "https://pamaistudio.com/blog/x" }), reg);
  assert.equal(r.verdict, "BLOCKED_CROSS_SITE");
  assert.equal(r.value, undefined, "engellenen öneri değer olarak dönmez");
});
test("iç link: her site çifti için çapraz link engellenir (7x6)", () => {
  for (const a of reg.sites) for (const b of reg.sites) if (a.id !== b.id) {
    const r = validateInternalLink(link({ site: a.id, source_url: `https://${a.canonical_hostname}/x`, target_url_or_entity: `https://${b.canonical_hostname}/y` }), reg);
    assert.equal(r.verdict, "BLOCKED_CROSS_SITE", `${a.id} -> ${b.id}`);
  }
});
test("iç link: kaynak başka sitede, kayıtsız dış host, lookalike ve userinfo hilesi engellenir", () => {
  assert.equal(validateInternalLink(link({ source_url: "https://spryhand.com/a" }), reg).verdict, "BLOCKED_CROSS_SITE");
  assert.equal(validateInternalLink(link({ target_url_or_entity: "https://example.org/x" }), reg).verdict, "BLOCKED_CROSS_SITE");
  assert.equal(validateInternalLink(link({ target_url_or_entity: "https://evilpamistanbul.com/x" }), reg).verdict, "BLOCKED_CROSS_SITE");
  assert.equal(validateInternalLink(link({ target_url_or_entity: "https://pamistanbul.com@pamaistudio.com/x" }), reg).verdict, "BLOCKED_CROSS_SITE");
});
test("iç link: kanıt referansı başka sitenin URL'si ise engellenir; düz ref kimliği engellenmez", () => {
  const bad = validateInternalLink(link({ evidence: { refs: ["https://spryhand.com/report"], label: "FACT" } }), reg);
  assert.equal(bad.verdict, "BLOCKED_CROSS_SITE");
  assert.ok(codes(bad).includes("EVIDENCE_CROSS_SITE"));
  assert.equal(validateInternalLink(link({ evidence: { refs: ["gsc:pamistanbul:2026-09"], label: "FACT" } }), reg).verdict, "ACCEPTED");
});
test("iç link: onboard edilmemiş site BLOCKED_NOT_ONBOARDED", () => {
  const copy: Registry = JSON.parse(JSON.stringify(reg));
  copy.sites.find((s) => s.id === "decideplan")!.onboarding_status = "registered_not_onboarded";
  const r = validateInternalLink(link({ site: "decideplan", source_url: "https://decideplan.com/a", target_url_or_entity: "https://decideplan.com/b" }), copy);
  assert.equal(r.verdict, "BLOCKED_NOT_ONBOARDED");
  // aynı öneri onboard edilmiş registry'de kabul: engel siteden geliyor, şekilden değil
  assert.equal(validateInternalLink(link({ site: "decideplan", source_url: "https://decideplan.com/a", target_url_or_entity: "https://decideplan.com/b" }), reg).verdict, "ACCEPTED");
});
test("iç link: bilinmeyen site, kendine link, entity adı hedef", () => {
  assert.ok(codes(validateInternalLink(link({ site: "nope" }), reg)).includes("UNKNOWN_SITE"));
  assert.ok(codes(validateInternalLink(link({ target_url_or_entity: "https://pamistanbul.com/blog/a" }), reg)).includes("SELF_LINK"));
  assert.ok(codes(validateInternalLink(link({ target_url_or_entity: "PAM İstanbul" }), reg)).includes("TARGET_NOT_URL"));
});

// --- ortak alanlar: mutation, onay, kanıt, hipotez ---
test("mutation yalnız 'none'; bilinmeyen alan (apply/patch) reddedilir", () => {
  for (const m of ["write", "apply", undefined, true]) assert.equal(validateInternalLink(link({ mutation: m }), reg).verdict, "INVALID");
  assert.ok(codes(validateInternalLink(link({ apply: true }), reg)).includes("UNKNOWN_FIELD"));
});
test("approval_state: varsayılan yok, OWNER_APPROVED approver ister, ajan kendini onaylayamaz", () => {
  assert.equal(validateInternalLink(link({ approval_state: undefined }), reg).verdict, "INVALID");
  assert.ok(codes(validateInternalLink(link({ approval_state: "OWNER_APPROVED" }), reg)).includes("APPROVER_MISSING"));
  assert.ok(codes(validateInternalLink(link({ approval_state: "OWNER_APPROVED", approver: "claude" }), reg)).includes("APPROVER_NOT_HUMAN"));
  assert.ok(codes(validateInternalLink(link({ approval_state: "OWNER_APPROVED", approver: "Claude Agent" }), reg)).includes("APPROVER_NOT_HUMAN"));
  // FP: "Roberto" içindeki "bot" kelime sınırı olmadan alarm verirdi
  assert.equal(validateInternalLink(link({ approval_state: "OWNER_APPROVED", approver: "Roberto Sefa" }), reg).verdict, "ACCEPTED");
  assert.equal(validateInternalLink(link({ approval_state: "OWNER_APPROVED", approver: "Sefa Yamak" }), reg).verdict, "ACCEPTED");
  // onay smuggling: approver, onaysız durumda yazılamaz
  assert.ok(codes(validateInternalLink(link({ approval_state: "PROPOSED", approver: "Sefa Yamak" }), reg)).includes("APPROVER_WITHOUT_APPROVAL"));
  for (const s of APPROVAL_STATES) if (s !== "OWNER_APPROVED") assert.notEqual(validateInternalLink(link({ approval_state: s, confidence: "CANDIDATE" }), reg).verdict, "BLOCKED_CROSS_SITE");
});
test("kanıt: refs boş/etiket bilinmeyen/IMPLEMENTED_CHANGE reddedilir; INFERENCE CONFIRMED olamaz", () => {
  assert.equal(validateInternalLink(link({ evidence: { refs: [], label: "FACT" } }), reg).verdict, "INVALID");
  assert.equal(validateInternalLink(link({ evidence: { refs: ["x"], label: "EDITORIAL" } }), reg).verdict, "INVALID");
  assert.ok(codes(validateInternalLink(link({ evidence: { refs: ["x"], label: "VERIFIED_RESULT" } }), reg)).includes("EVIDENCE_LABEL_NOT_PROPOSAL"));
  assert.ok(codes(validateInternalLink(link({ evidence: { refs: ["x"], label: "INFERENCE" }, confidence: "CONFIRMED" }), reg)).includes("CONFIRMED_WITHOUT_FACT"));
  assert.equal(validateInternalLink(link({ evidence: { refs: ["x"], label: "FACT" }, confidence: "CONFIRMED" }), reg).verdict, "ACCEPTED");
  assert.ok(codes(validateInternalLink(link({ confidence: "FALSE_POSITIVE" }), reg)).includes("FALSE_POSITIVE_NOT_REJECTED"));
  assert.equal(validateInternalLink(link({ confidence: "FALSE_POSITIVE", approval_state: "REJECTED" }), reg).verdict, "ACCEPTED");
});
test("expected_change: testsiz hipotez ve sayısal kazanç reddedilir; rakamsız hipotez geçer", () => {
  assert.equal(validateInternalLink(link({ expected_change: { hypothesis: "tıklama artar", test: "" } }), reg).verdict, "INVALID");
  assert.equal(validateInternalLink(link({ expected_change: { hypothesis: "tıklama %20 artar", test: "GSC" } }), reg).verdict, "REJECTED_FABRICATED");
  assert.equal(validateInternalLink(link({ expected_change: { hypothesis: "trafik 3x olur", test: "GSC" } }), reg).verdict, "REJECTED_FABRICATED");
  // FP: sayı içeren ama kazanç olmayan metin ("28 gün", "10 sorgu") engellenmez
  assert.equal(validateInternalLink(link({ expected_change: { hypothesis: "10 sayfa arasında B daha sık taranır", test: "28 gün log karşılaştırması" } }), reg).verdict, "ACCEPTED");
});
test("risk ve sabitler JSON şemalarıyla aynı (drift testi)", () => {
  for (const f of ["agent-internal-link", "agent-schema-entity"]) {
    const s = JSON.parse(readFileSync(join(root, "schemas", `${f}.schema.json`), "utf8"));
    assert.deepEqual(s.properties.risk.enum, [...RISKS]);
    assert.deepEqual(s.properties.approval_state.enum, [...APPROVAL_STATES]);
    assert.deepEqual(s.properties.evidence.properties.label.enum, [...PROPOSAL_LABELS]);
    assert.equal(s.properties.mutation.const, "none");
    assert.equal(s.additionalProperties, false);
  }
  const se = JSON.parse(readFileSync(join(root, "schemas", "agent-schema-entity.schema.json"), "utf8"));
  assert.deepEqual(se.properties.schema_type.enum, [...SCHEMA_TYPE_ALLOWLIST]);
  assert.deepEqual(se.required.filter((k: string) => k !== "kind"), Object.keys(schema()).filter((k) => k !== "kind" && k !== "approver"));
});

// --- schema / entity ---
test("schema: temiz Organization taslağı kabul; taslak string olarak da saklanabilir", () => {
  assert.equal(validateSchemaEntity(schema(), reg).verdict, "ACCEPTED");
  const asString = schema({ jsonld_draft: JSON.stringify((schema() as any).jsonld_draft) });
  assert.equal(validateSchemaEntity(asString, reg).verdict, "ACCEPTED");
});
test("schema: kaynaksız aggregateRating / review / foundingDate uydurma sayılır", () => {
  for (const [prop, val] of [["aggregateRating", { "@type": "AggregateRating", ratingValue: 4.9, reviewCount: 120 }], ["review", { "@type": "Review", reviewBody: "harika" }], ["foundingDate", "2015"]] as const) {
    const draft = { "@context": "https://schema.org", "@type": "Organization", name: "Spryhand", [prop]: val };
    const r = validateSchemaEntity(schema({ jsonld_draft: draft }), reg);
    assert.equal(r.verdict, "REJECTED_FABRICATED", prop);
    assert.ok(codes(r).includes(`FABRICATED_${prop}`));
  }
});
test("schema: kaynaklı olgu geçer; kaynak başka sitenin sayfasıysa ya da FACT değilse geçmez", () => {
  const draft = { "@context": "https://schema.org", "@type": "Organization", name: "Spryhand", aggregateRating: { "@type": "AggregateRating", ratingValue: 4.8, reviewCount: 12 } };
  const good = [{ property: "aggregateRating", source_url: "https://spryhand.com/reviews", label: "FACT" }];
  assert.equal(validateSchemaEntity(schema({ jsonld_draft: draft, fact_sources: good, risk: "medium" }), reg).verdict, "ACCEPTED");
  assert.equal(validateSchemaEntity(schema({ jsonld_draft: draft, fact_sources: [{ ...good[0], label: "INFERENCE" }] }), reg).verdict, "REJECTED_FABRICATED");
  assert.equal(validateSchemaEntity(schema({ jsonld_draft: draft, fact_sources: [{ ...good[0], source_url: "https://example.org/reviews" }] }), reg).verdict, "REJECTED_FABRICATED");
  assert.equal(validateSchemaEntity(schema({ jsonld_draft: draft, fact_sources: [{ ...good[0], source_url: "https://decideplan.com/reviews" }] }), reg).verdict, "BLOCKED_CROSS_SITE");
  // başka property'nin kaynağı bu property'yi aklamaz
  assert.equal(validateSchemaEntity(schema({ jsonld_draft: draft, fact_sources: [{ ...good[0], property: "foundingDate" }] }), reg).verdict, "REJECTED_FABRICATED");
});
test("schema: @graph içine gömülü uydurma da yakalanır", () => {
  const draft = { "@context": "https://schema.org", "@graph": [{ "@type": "WebSite", name: "x" }, { "@type": "Organization", name: "x", foundingDate: "2010" }] };
  assert.equal(validateSchemaEntity(schema({ jsonld_draft: draft }), reg).verdict, "REJECTED_FABRICATED");
});
test("schema: foundingDate registry'deki yılla çelişirse reddedilir, uyuşursa (kaynakla) geçer", () => {
  const withYear = reg.sites.find((s) => typeof s.foundation_year === "number");
  if (!withYear) return; // registry'de doğrulanmış yıl yoksa bu dal anlamsız
  const d = (y: number) => ({ "@context": "https://schema.org", "@type": "Organization", name: "x", foundingDate: String(y) });
  const src = [{ property: "foundingDate", source_url: `https://${withYear.canonical_hostname}/about`, label: "FACT" }];
  const base = { site: withYear.id, source_url: `https://${withYear.canonical_hostname}/about`, fact_sources: src };
  assert.ok(codes(validateSchemaEntity(schema({ ...base, jsonld_draft: d(Number(withYear.foundation_year) + 3) }), reg)).includes("FOUNDING_YEAR_MISMATCH"));
  assert.equal(validateSchemaEntity(schema({ ...base, jsonld_draft: d(Number(withYear.foundation_year)) }), reg).verdict, "ACCEPTED");
});
test("schema: Organization sameAs başka kayıtlı sitenin domain'ine -> BLOCKED_CROSS_SITE", () => {
  for (const other of ["https://pamaistudio.com", "https://www.rightlisted.com/about"]) {
    const draft = { "@context": "https://schema.org", "@type": "Organization", name: "Spryhand", sameAs: [other] };
    assert.equal(validateSchemaEntity(schema({ jsonld_draft: draft }), reg).verdict, "BLOCKED_CROSS_SITE", other);
  }
  // Person için de, ve url/@id alanı için de
  const person = { "@type": "Person", name: "Sefa", "@id": "https://pamaistudio.com/#sefa" };
  assert.equal(validateSchemaEntity(schema({ schema_type: "Person", jsonld_draft: person }), reg).verdict, "BLOCKED_CROSS_SITE");
});
test("schema: sameAs sosyal profil registry'de ya da kaynaklıysa geçer, uydurmaysa reddedilir", () => {
  const draft = { "@context": "https://schema.org", "@type": "Organization", name: "Spryhand", sameAs: ["https://www.linkedin.com/company/spryhand-not-real"] };
  assert.equal(validateSchemaEntity(schema({ jsonld_draft: draft }), reg).verdict, "REJECTED_FABRICATED");
  const copy: Registry = JSON.parse(JSON.stringify(reg));
  copy.sites.find((s) => s.id === "spryhand")!.social_identity_urls = ["https://www.linkedin.com/company/spryhand-not-real"];
  assert.equal(validateSchemaEntity(schema({ jsonld_draft: draft }), copy).verdict, "ACCEPTED");
  const sourced = [{ property: "sameAs", source_url: "https://spryhand.com/about", label: "FACT" }];
  assert.equal(validateSchemaEntity(schema({ jsonld_draft: draft, fact_sources: sourced }), reg).verdict, "ACCEPTED");
});
test("schema: type allow-list (üst düzey ve gömülü), bozuk JSON, script sarmalı, düşük riskli Organization", () => {
  assert.ok(codes(validateSchemaEntity(schema({ schema_type: "Product" }), reg)).includes("TYPE_NOT_ALLOWED"));
  const nested = { "@context": "https://schema.org", "@type": "Organization", name: "x", makesOffer: { "@type": "Offer", price: "10" } };
  assert.ok(codes(validateSchemaEntity(schema({ jsonld_draft: nested }), reg)).includes("DRAFT_TYPE_NOT_ALLOWED"));
  assert.ok(codes(validateSchemaEntity(schema({ jsonld_draft: "{not json" }), reg)).includes("DRAFT_NOT_JSON"));
  assert.ok(codes(validateSchemaEntity(schema({ jsonld_draft: '<script type="application/ld+json">{}</script>' }), reg)).includes("DRAFT_NOT_JSON"));
  assert.ok(codes(validateSchemaEntity(schema({ risk: "low" }), reg)).includes("ENTITY_RISK_TOO_LOW"));
  // FP: BreadcrumbList düşük risk olabilir
  const bc = { "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: [] };
  assert.equal(validateSchemaEntity(schema({ schema_type: "BreadcrumbList", jsonld_draft: bc, risk: "low" }), reg).verdict, "ACCEPTED");
});
test("schema: source_url ve hedef URL başka siteye gidemez; entity adı hedef olabilir", () => {
  assert.equal(validateSchemaEntity(schema({ source_url: "https://pamaistudio.com/about" }), reg).verdict, "BLOCKED_CROSS_SITE");
  assert.equal(validateSchemaEntity(schema({ target_url_or_entity: "https://pamaistudio.com/#org" }), reg).verdict, "BLOCKED_CROSS_SITE");
  assert.equal(validateSchemaEntity(schema({ target_url_or_entity: "https://spryhand.com/#org" }), reg).verdict, "ACCEPTED");
});
test("öncelik: hem cross-site hem uydurma varsa cross-site raporlanır, ikisi de issue olarak kalır", () => {
  const draft = { "@context": "https://schema.org", "@type": "Organization", name: "x", sameAs: ["https://pamaistudio.com"], aggregateRating: { ratingValue: 5 } };
  const r = validateSchemaEntity(schema({ jsonld_draft: draft }), reg);
  assert.equal(r.verdict, "BLOCKED_CROSS_SITE");
  assert.ok(codes(r).includes("FABRICATED_aggregateRating"));
});
test("girdi nesne değilse çökmeden INVALID", () => {
  for (const bad of [null, "x", 5, []]) {
    assert.equal(validateInternalLink(bad, reg).verdict, "INVALID");
    assert.equal(validateSchemaEntity(bad, reg).verdict, "INVALID");
  }
});

// --- markdown kuyruğu ---
test("kuyruk: site başına gruplanır, engellenenler nedeniyle listelenir, taslak 'uygulanmadı' der", () => {
  const items: QueueItem[] = [
    { kind: "internal_link", input: link(), result: validateInternalLink(link(), reg) },
    { kind: "internal_link", input: link({ id: "L2", target_url_or_entity: "https://pamaistudio.com/x" }), result: validateInternalLink(link({ target_url_or_entity: "https://pamaistudio.com/x" }), reg) },
    { kind: "schema_entity", input: schema(), result: validateSchemaEntity(schema(), reg) },
  ];
  const md = renderReviewQueue(items, "2026-10-02");
  assert.match(md, /## pamistanbul/); assert.match(md, /## spryhand/);
  assert.match(md, /BLOCKED_CROSS_SITE\*\* L2/);
  assert.match(md, /JSON-LD TASLAK \(uygulanmadı\)/);
  // izolasyon: spryhand bölümü pamistanbul verisini içermez
  const spry = md.split("## spryhand")[1];
  assert.ok(!spry.includes("pamistanbul.com"));
  assert.deepEqual(summarize(items), { ACCEPTED: 2, BLOCKED_CROSS_SITE: 1, BLOCKED_NOT_ONBOARDED: 0, REJECTED_FABRICATED: 0, INVALID: 0 });
});
test("kuyruk: boş girdi sessiz kalmaz; tablo ve code-fence kırılmaz", () => {
  assert.match(renderReviewQueue([], "2026-10-02"), /Kuyruk boş/);
  const nasty = schema({ reason: "a | b\nc", jsonld_draft: JSON.stringify({ "@context": "https://schema.org", "@type": "Organization", name: "``` kır" }) });
  const md = renderReviewQueue([{ kind: "schema_entity", input: nasty, result: validateSchemaEntity(nasty, reg) }], "2026-10-02");
  assert.match(md, /a \\\| b c/);
  assert.match(md, /````json/, "içerikteki ``` den uzun fence kullanılır");
});
