// Deployment dogrulayici + zaman cizelgesi. Testlerin cogu NE YAPILMAMASI gerektigi hakkinda:
// erisilemeyeni VERIFIED saymak, kisa SHA ile eslestirmek, baska sitenin metrigiyle korele etmek, nedensellik dili.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { loadRegistry } from "../src/registry.ts";
import {
  TIMELINE_MAX_EVENTS, TimelineError, appendEvent, correlate, emptyTimeline, parseGithubDeployments, parseTimeline,
  parseVercelDeployments, validateEvent, verifyDeployment, type DeploymentEvent, type MetricChange,
} from "../src/deployment-timeline.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const SITES = loadRegistry(join(ROOT, "config/sites.yaml")).registry!.sites.map((s) => s.id);
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const RT = "2026-10-02T08:00:00Z";
const ev = (o: Partial<DeploymentEvent> = {}): DeploymentEvent => ({
  schema: "sgos.deployment-event.v1", site: "pamistanbul", environment: "production", commit_sha: SHA_A,
  deployed_at: "2026-09-20T10:00:00Z", verification_state: "UNVERIFIED",
  provenance: { source: "manual_fixture", retrieved_at: RT, ref: "fx-1" }, evidence: "FACT", ...o,
});
const chg = (o: Partial<MetricChange> = {}): MetricChange => ({ site: "pamistanbul", metric: "gsc_clicks", direction: "down", observed_at: "2026-09-21T10:00:00Z", record_ref: "reports/measure-latest.md", ...o });

// --- parser'lar ---------------------------------------------------------------------------------------
test("GitHub parser: production/preview/bilinmeyen ortam, UNVERIFIED, bozuk satir reddedilir", () => {
  const r = parseGithubDeployments([
    { id: 1, sha: SHA_A.toUpperCase(), environment: "Production", created_at: "2026-09-20T10:00:00Z" },
    { id: 2, sha: SHA_B, environment: "preview", created_at: "2026-09-20T11:00:00Z" },
    { id: 3, sha: SHA_B, environment: "staging-x", created_at: "2026-09-20T12:00:00Z" },
    { id: 4, sha: "abc123", environment: "production", created_at: "2026-09-20T12:00:00Z" },
    { id: 5, sha: SHA_A, environment: "production", created_at: "dun" },
    { sha: SHA_A, environment: "production", created_at: "2026-09-20T12:00:00Z" },
  ], "pamistanbul", RT);
  assert.deepEqual(r.events.map((e) => e.environment), ["production", "preview", "unknown"]);
  assert.equal(r.events[0].commit_sha, SHA_A);
  assert.ok(r.events.every((e) => e.verification_state === "UNVERIFIED" && validateEvent(e).length === 0));
  assert.deepEqual(r.rejected.map((x) => x.index), [3, 4, 5]);
  assert.throws(() => parseGithubDeployments({ not: "array" }, "pamistanbul", RT), TimelineError);
});
test("GitHub parser: tanimsiz ortam production sayilmaz (false-positive korumasi)", () => {
  const r = parseGithubDeployments([{ id: 9, sha: SHA_A, environment: "production-eu-test", created_at: "2026-09-20T10:00:00Z" }], "spryhand", RT);
  assert.equal(r.events[0].environment, "unknown");
});
test("Vercel parser: liste, tek nesne, target null=preview, SHA'siz reddedilir", () => {
  const dep = (o: object) => ({ uid: "dpl_1", created: Date.UTC(2026, 8, 20, 10), meta: { githubCommitSha: SHA_A }, target: "production", ...o });
  const r = parseVercelDeployments({ deployments: [dep({}), dep({ uid: "dpl_2", target: null, meta: { githubCommitSha: SHA_B } }), dep({ uid: "dpl_3", meta: {} })] }, "pamaistudio", RT);
  assert.deepEqual(r.events.map((e) => e.environment), ["production", "preview"]);
  assert.equal(r.events[0].deployed_at, "2026-09-20T10:00:00.000Z");
  assert.equal(r.rejected[0].index, 2);
  assert.equal(parseVercelDeployments(dep({}), "pamaistudio", RT).events.length, 1);
});
test("Vercel parser: taninmayan sekil throw (bos sonuc 'sorun yok' sanilmasin)", () => {
  assert.throws(() => parseVercelDeployments("x", "pamaistudio", RT), TimelineError);
  assert.throws(() => parseVercelDeployments({}, "pamaistudio", RT), TimelineError);
  assert.throws(() => parseVercelDeployments({ deployments: "x" }, "pamaistudio", RT), TimelineError);
});
test("parser: gecersiz site/retrievedAt throw", () => {
  assert.throws(() => parseGithubDeployments([], "Bad Site", RT), TimelineError);
  assert.throws(() => parseVercelDeployments({ deployments: [] }, "pamistanbul", "dun"), TimelineError);
});

// --- dogrulayici --------------------------------------------------------------------------------------
test("verify: tam eslesme VERIFIED (buyuk/kucuk harf fark etmez)", async () => {
  const v = await verifyDeployment(ev(), async () => ({ reachable: true, live_sha: SHA_A.toUpperCase() }));
  assert.equal(v.verification_state, "VERIFIED");
});
test("verify: farkli SHA MISMATCH; VERIFIED degil", async () => {
  const v = await verifyDeployment(ev(), async () => ({ reachable: true, live_sha: SHA_B }));
  assert.equal(v.verification_state, "MISMATCH");
});
test("verify: erisilemez / SHA yok / kisa SHA / probe throw => UNKNOWN (VERIFIED degil)", async () => {
  const probes = [
    async () => ({ reachable: false }),
    async () => ({ reachable: false, live_sha: SHA_A }), // erisilemez iken gelen SHA'ya guvenilmez
    async () => ({ reachable: true }),
    async () => ({ reachable: true, live_sha: SHA_A.slice(0, 7) }),
    async (): Promise<{ reachable: boolean }> => { throw new Error("ag"); },
  ];
  for (const probe of probes) assert.equal((await verifyDeployment(ev(), probe)).verification_state, "UNKNOWN");
});
test("verify: girdiyi degistirmez, probe yalniz kendi sitesini gorur", async () => {
  const input = ev({ site: "rightlisted" });
  const seen: string[] = [];
  const out = await verifyDeployment(input, async (s, e) => { seen.push(`${s}:${e}`); return { reachable: true, live_sha: SHA_A }; });
  assert.equal(input.verification_state, "UNVERIFIED");
  assert.deepEqual(seen, ["rightlisted:production"]);
  assert.equal(out.site, "rightlisted");
});
test("verify: gecersiz olay throw", async () => {
  await assert.rejects(verifyDeployment(ev({ commit_sha: "zz" }), async () => ({ reachable: true, live_sha: SHA_A })), TimelineError);
});

// --- zaman cizelgesi ----------------------------------------------------------------------------------
test("timeline: sirali, tekrarsiz, append-only (ilk kayit korunur)", () => {
  let t = emptyTimeline("pamistanbul");
  t = appendEvent(t, ev({ deployed_at: "2026-09-22T10:00:00Z", commit_sha: SHA_B })).timeline;
  t = appendEvent(t, ev()).timeline;
  assert.deepEqual(t.events.map((e) => e.commit_sha), [SHA_A, SHA_B]);
  const dup = appendEvent(t, ev({ verification_state: "VERIFIED" }));
  assert.equal(dup.added, false);
  assert.equal(dup.timeline.events.length, 2);
  assert.equal(dup.timeline.events[0].verification_state, "UNVERIFIED");
  // ayni sha farkli ortam tekrar DEGIL
  assert.equal(appendEvent(t, ev({ environment: "preview" })).added, true);
});
test("timeline: baska sitenin olayi reddedilir", () => {
  assert.throws(() => appendEvent(emptyTimeline("pamistanbul"), ev({ site: "spryhand" })), TimelineError);
});
test("timeline: 200 siniri, en eski duser", () => {
  let t = emptyTimeline("pamistanbul");
  for (let i = 0; i < TIMELINE_MAX_EVENTS + 5; i++) {
    t = appendEvent(t, ev({ commit_sha: i.toString(16).padStart(40, "0"), deployed_at: new Date(Date.UTC(2026, 0, 1) + i * 3600_000).toISOString().replace(/\.\d+Z$/, "Z") })).timeline;
  }
  assert.equal(t.events.length, TIMELINE_MAX_EVENTS);
  assert.equal(t.events[0].commit_sha, (5).toString(16).padStart(40, "0"));
});
test("parseTimeline: gecerli cizelge gecer (roundtrip)", () => {
  const t = appendEvent(emptyTimeline("pamistanbul"), ev()).timeline;
  assert.deepEqual(parseTimeline(JSON.stringify(t)), t);
});
test("parseTimeline fail-closed: her bozukluk throw", () => {
  const good = appendEvent(emptyTimeline("pamistanbul"), ev()).timeline;
  const bad: unknown[] = [
    "{", null, [], { ...good, schema: "x" }, { ...good, site: "A B" }, { ...good, events: "x" },
    { ...good, events: [{ ...ev(), commit_sha: "abc" }] },
    { ...good, events: [ev({ site: "spryhand" })] },
    { ...good, events: [ev(), ev()] },
    { ...good, events: [ev({ deployed_at: "2026-09-22T10:00:00Z" }), ev({ commit_sha: SHA_B })] },
    { ...good, events: [{ ...ev(), extra: 1 }] },
    { ...good, events: [{ ...ev(), evidence: "INFERENCE" }] },
    { ...good, events: Array.from({ length: TIMELINE_MAX_EVENTS + 1 }, (_, i) => ev({ commit_sha: i.toString(16).padStart(40, "0") })) },
  ];
  for (const b of bad) assert.throws(() => parseTimeline(b), TimelineError);
});

// --- korelasyon ---------------------------------------------------------------------------------------
test("correlate: pencere icinde INFERENCE/CANDIDATE temporal_coincidence + dogrulama testi", () => {
  const r = correlate(ev(), chg());
  assert.ok(r.correlated);
  if (!r.correlated) return;
  assert.equal(r.finding.evidence, "INFERENCE");
  assert.equal(r.finding.confidence, "CANDIDATE");
  assert.equal(r.finding.kind, "temporal_coincidence");
  assert.ok(r.finding.confirming_test.length > 20);
  assert.equal(r.finding.hours_after_deploy, 24);
});
test("correlate: false-negative korumasi - UNVERIFIED/UNKNOWN deploy yine aday uretir, durumu gorunur", () => {
  for (const s of ["UNVERIFIED", "UNKNOWN", "VERIFIED"] as const) {
    const r = correlate(ev({ verification_state: s }), chg());
    assert.ok(r.correlated && r.finding.deployment.verification_state === s);
  }
});
test("correlate: false-positive korumasi - MISMATCH, preview, once, pencere disi, gecersiz girdi", () => {
  const reason = (r: ReturnType<typeof correlate>) => (r.correlated ? "ok" : r.reason);
  assert.equal(reason(correlate(ev({ verification_state: "MISMATCH" }), chg())), "deployment_mismatch");
  assert.equal(reason(correlate(ev({ environment: "preview" }), chg())), "deployment_not_production");
  assert.equal(reason(correlate(ev({ environment: "unknown" }), chg())), "deployment_not_production");
  assert.equal(reason(correlate(ev(), chg({ observed_at: "2026-09-19T10:00:00Z" }))), "metric_before_deployment");
  assert.equal(reason(correlate(ev(), chg({ observed_at: "2026-10-01T10:00:00Z" }))), "outside_window");
  assert.equal(reason(correlate(ev(), chg({ observed_at: "dun" }))), "invalid_input");
  assert.equal(reason(correlate(ev(), chg(), 0)), "invalid_input");
});
test("izolasyon: A sitesinin olayi B sitesinin metrigiyle hicbir kombinasyonda korele edilmez", () => {
  assert.equal(SITES.length, 7);
  for (const a of SITES) for (const b of SITES) {
    const r = correlate(ev({ site: a }), chg({ site: b }));
    assert.equal(r.correlated, a === b, `${a} x ${b}`);
    if (a !== b && !r.correlated) assert.equal(r.reason, "site_mismatch");
  }
});
test("nedensellik dili yok: tum cikti metinleri yasakli ifadeleri icermez", () => {
  const r = correlate(ev(), chg());
  assert.ok(r.correlated);
  if (!r.correlated) return;
  const strings: string[] = [];
  const walk = (v: unknown) => { if (typeof v === "string") strings.push(v); else if (v && typeof v === "object") Object.values(v).forEach(walk); };
  walk(r.finding);
  const forbidden = ["caused by", "because of", "due to", "neden oldu", "yuzunden", "yüzünden", "sebep oldu", "kaynaklan", "resulted in", "led to", "root cause", "nedeniyle"];
  for (const s of strings) for (const f of forbidden) assert.ok(!s.toLowerCase().includes(f), `"${f}" bulundu: ${s}`);
  assert.match(r.finding.statement, /zamansal ortusme/);
});
