import { test } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadRegistry, validateRegistry, parseYamlSubset, onboardedSites } from "../src/registry.ts";

const cfg = (n: string) => join(dirname(fileURLToPath(import.meta.url)), "..", "config", n);
const example = cfg("sites.example.yaml");

test("sites.example.yaml parses and validates", () => {
  const r = loadRegistry(example);
  assert.ok(r.ok, r.errors.join("\n"));
  assert.equal(r.registry!.sites[0].id, "pamistanbul");
  assert.equal(r.registry!.sites[0].google_search_console_property, "NOT_CONNECTED");
  assert.ok(Array.isArray(r.registry!.sites[0].competitor_set));
});

test("rejects placeholders and blanks instead of sentinels", () => {
  const r = loadRegistry(example);
  const site = { ...r.registry!.sites[0], ga4_property: "TODO", cdn_log_source: "" };
  const v = validateRegistry({ version: 1, sites: [site] });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /placeholder/.test(e)));
  assert.ok(v.errors.some((e) => /empty/.test(e)));
});

test("yaml subset handles nested maps, block lists, inline lists, quotes", () => {
  const y = parseYamlSubset(`version: 1\nsites:\n  - id: a\n    tags: [x, y]\n    list:\n      - "one"\n      - two\n    nested:\n      k: "v: with colon"\n`) as any;
  assert.equal(y.version, 1);
  assert.deepEqual(y.sites[0].tags, ["x", "y"]);
  assert.deepEqual(y.sites[0].list, ["one", "two"]);
  assert.equal(y.sites[0].nested.k, "v: with colon");
});

test("live registry holds the whole portfolio, and every site states how it was onboarded", () => {
  const r = loadRegistry(cfg("sites.yaml"));
  assert.ok(r.ok, r.errors.join("\n"));
  const sites = r.registry!.sites;
  assert.equal(sites.length, 7);
  const pilots = sites.filter((s) => s.onboarding_status === "pilot_onboarding");
  assert.deepEqual(pilots.map((s) => s.id), ["pamistanbul"]);
  // The whole portfolio was onboarded 2026-09-21 at the owner's instruction. The gate
  // still exists and still means something — a status outside this set is rejected —
  // but "only one site" is no longer the fact it encodes.
  for (const s of sites) {
    assert.ok(["pilot_onboarding", "active", "registered_not_onboarded"].includes(s.onboarding_status), `${s.id}: ${s.onboarding_status}`);
  }
  assert.equal(onboardedSites(r.registry!).length, 7, "every onboarded site is crawlable");
  // An onboarded site must name its repository and framework: without those, a finding
  // cannot be traced to the code that produced it and nothing can be fixed.
  for (const s of sites) {
    for (const key of ["repository", "framework", "canonical_hostname"] as const) {
      assert.ok(s[key] && !["UNKNOWN", "NOT_CONNECTED"].includes(String(s[key]).split("#")[0].trim()),
        `${s.id}: onboarded but ${key} is ${s[key]}`);
    }
  }
  // A property identifier may be known before credentials exist, but it is either a
  // sentinel or a real GA4 numeric id — never a guess, and never a measurement ID.
  for (const s of sites) {
    const ga4 = String(s.ga4_property);
    assert.ok(ga4 === "NOT_CONNECTED" || ga4 === "UNKNOWN" || /^\d{9,12}$/.test(ga4), `${s.id}: ga4_property "${ga4}"`);
    assert.doesNotMatch(ga4, /^G-/, `${s.id}: measurement ID is not a property ID`);
  }
  // The pilot's GA4 property was confirmed 2026-09-22 against the G-EYY9Z20XJ4 data
  // stream, so it must now be that real numeric id, not the UNKNOWN sentinel.
  const pilot = sites.find((s) => s.id === "pamistanbul")!;
  assert.equal(pilot.ga4_property, "426911036");
  // A Search Console property is either a sentinel or a real property string in one of
  // Google's two forms. A bare hostname is not a property and would silently return nothing.
  for (const s of sites) {
    const p = String(s.google_search_console_property);
    assert.ok(["NOT_CONNECTED", "UNKNOWN"].includes(p) || /^sc-domain:[a-z0-9.-]+$/.test(p) || /^https?:\/\/.+\/$/.test(p), `${s.id}: "${p}"`);
  }
  for (const s of sites) assert.ok(["NOT_CONNECTED", "UNKNOWN"].includes(String(s.bing_webmaster_property)), s.id);
});

test("portfolio isolation: a registered site cannot carry inherited strategy", () => {
  const r = loadRegistry(cfg("sites.yaml"));
  const pilot = r.registry!.sites.find((s) => s.id === "pamistanbul")!;
  // The test builds its own subject rather than borrowing a site from the live
  // registry: every site is onboarded now, and a test that depends on which ones
  // are not would stop proving anything the moment the portfolio changes again.
  const registered = { ...pilot, id: "a-newly-registered-site", onboarding_status: "registered_not_onboarded" };
  assert.equal(validateRegistry({ version: 1, sites: [{ ...registered, competitor_set: [], core_commercial_topics: [], core_informational_topics: [] }] }).ok, true);
  // Simulate the failure this guards: copying one site's commercial context onto another.
  const leaked = { ...registered, competitor_set: ["example-competitor.com"], core_commercial_topics: ["ürün fotoğrafı"] };
  const v = validateRegistry({ version: 1, sites: [leaked] });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /never inherit it from another site/.test(e)), v.errors.join("\n"));
});

test("onboarding did not hand any site another site's commercial context", () => {
  // Onboarding made these sites measurable; it decided nothing about their markets.
  // An empty list here means nobody has chosen yet — never that the answer is none.
  const r = loadRegistry(cfg("sites.yaml"));
  for (const s of r.registry!.sites) {
    for (const k of ["competitor_set", "core_commercial_topics", "core_informational_topics"] as const) {
      assert.deepEqual(s[k], [], `${s.id}: ${k} was filled in without an owner decision`);
    }
  }
});

test("onboarding_status is required and validated", () => {
  const r = loadRegistry(cfg("sites.yaml"));
  const s = r.registry!.sites[0];
  assert.equal(validateRegistry({ version: 1, sites: [{ ...s, onboarding_status: "live" }] }).ok, false);
  const { onboarding_status: _drop, ...without } = s;
  const v = validateRegistry({ version: 1, sites: [without] });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /missing field onboarding_status/.test(e)));
});

test("foundation year is owner-confirmed truth, and never a guess", () => {
  const r = loadRegistry(cfg("sites.yaml"));
  assert.ok(r.ok, r.errors.join("\n"));
  const pilot = r.registry!.sites.find((s) => s.id === "pamistanbul")!;
  assert.equal(pilot.foundation_year, 2018);
  assert.equal(pilot.google_search_console_property, "sc-domain:pamistanbul.com");
  // Sites nobody has confirmed stay UNKNOWN rather than inheriting the pilot's year.
  //
  // pamaistudio is the one named exception, and it is an exception by confirmation rather
  // than by convenience: PAM AI Studio is PAM İstanbul's own AI unit, its pages state the
  // parent's founding year as a fact about themselves, and the owner confirmed 2018 for it
  // on 2026-09-20. Without that year recorded the contradiction check has nothing to
  // compare against — which is precisely why that site served the wrong year undetected
  // through two scans. Any site added to this map must earn it the same way: a written
  // owner confirmation, never a copy of the pilot's value because it was convenient.
  const CONFIRMED_YEARS: Record<string, number> = { pamistanbul: 2018, pamaistudio: 2018 };
  for (const s of r.registry!.sites) {
    assert.equal(s.foundation_year, CONFIRMED_YEARS[s.id] ?? "UNKNOWN", s.id);
  }
  // Implausible or fabricated years are rejected.
  for (const bad of [1700, 3000, "2018" as unknown as number]) {
    assert.equal(validateRegistry({ version: 1, sites: [{ ...pilot, foundation_year: bad }] }).ok, false, String(bad));
  }
});
