// Sitemap evreni: ya tam okunmus (MEASURED) ya UNKNOWN. Kismi liste "evren" olarak donmez.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readSitemapUniverse, type FetchText } from "../src/sitemap-universe.ts";

const urlset = (...locs: string[]) => `<?xml version="1.0"?><urlset>${locs.map((l) => `<url><loc>${l}</loc></url>`).join("")}</urlset>`;
const index = (...locs: string[]) => `<sitemapindex>${locs.map((l) => `<sitemap><loc>${l}</loc></sitemap>`).join("")}</sitemapindex>`;
const site = (map: Record<string, { status?: number; body?: string; error?: string }>): { fetch: FetchText; calls: string[] } => {
  const calls: string[] = [];
  return { calls, fetch: async (u) => { calls.push(u); const r = map[u]; return r ? { status: r.status ?? 200, body: r.body ?? "", error: r.error } : { status: 404, body: "" }; } };
};
const run = (fetchText: FetchText, extra: Partial<Parameters<typeof readSitemapUniverse>[0]> = {}) =>
  readSitemapUniverse({ locations: ["https://pamistanbul.com/sitemap.xml"], productionDomain: "pamistanbul.com", fetchText, ...extra });

test("duz sitemap okunur; URL'ler normalize ve siralidir", async () => {
  const s = site({ "https://pamistanbul.com/sitemap.xml": { body: urlset("https://pamistanbul.com/b", "https://pamistanbul.com/a#x", "https://pamistanbul.com/b") } });
  const r = await run(s.fetch);
  assert.equal(r.state, "MEASURED");
  assert.deepEqual((r as { urls: string[] }).urls, ["https://pamistanbul.com/a", "https://pamistanbul.com/b"]);
});

test("ic ice sitemap index mevcut parser uzerinden cozulur", async () => {
  const s = site({
    "https://pamistanbul.com/sitemap.xml": { body: index("https://pamistanbul.com/sm-1.xml", "https://pamistanbul.com/sm-2.xml") },
    "https://pamistanbul.com/sm-1.xml": { body: urlset("https://pamistanbul.com/a") },
    "https://pamistanbul.com/sm-2.xml": { body: index("https://pamistanbul.com/sm-3.xml") },
    "https://pamistanbul.com/sm-3.xml": { body: urlset("https://pamistanbul.com/c") },
  });
  const r = await run(s.fetch);
  assert.equal(r.state, "MEASURED");
  assert.deepEqual((r as { urls: string[] }).urls, ["https://pamistanbul.com/a", "https://pamistanbul.com/c"]);
});

test("kok sitemap okunamazsa UNKNOWN (bos evren degil)", async () => {
  for (const bad of [{ status: 404 }, { status: 500 }, { status: 0, error: "timeout" }]) {
    const r = await run(site({ "https://pamistanbul.com/sitemap.xml": bad }).fetch);
    assert.equal(r.state, "UNKNOWN", JSON.stringify(bad));
  }
});

test("alt sitemap okunamazsa KISMI liste donmez: UNKNOWN", async () => {
  const s = site({
    "https://pamistanbul.com/sitemap.xml": { body: index("https://pamistanbul.com/ok.xml", "https://pamistanbul.com/broken.xml") },
    "https://pamistanbul.com/ok.xml": { body: urlset("https://pamistanbul.com/a") },
    "https://pamistanbul.com/broken.xml": { status: 503 },
  });
  const r = await run(s.fetch);
  assert.equal(r.state, "UNKNOWN");
  assert.match((r as { reason: string }).reason, /broken\.xml/);
});

test("HTML hata sayfasi / gzip / giris icermeyen govde 'bos sitemap' diye okunmaz: UNKNOWN", async () => {
  for (const body of ["", "<html><body>Not found</body></html>", "\u001f\u008b binary"]) {
    const r = await run(site({ "https://pamistanbul.com/sitemap.xml": { status: 200, body } }).fetch);
    assert.equal(r.state, "UNKNOWN", JSON.stringify(body));
  }
});

test("host disi giris ve host disi alt sitemap yok sayilir ve not dusulur", async () => {
  const s = site({
    "https://pamistanbul.com/sitemap.xml": { body: urlset("https://pamistanbul.com/a", "https://evil.example/x") },
  });
  const r = await run(s.fetch);
  assert.equal(r.state, "MEASURED");
  assert.deepEqual((r as { urls: string[] }).urls, ["https://pamistanbul.com/a"]);
  assert.ok((r as { notes: string[] }).notes.some((n) => /evil\.example/.test(n)));
  const idx = site({ "https://pamistanbul.com/sitemap.xml": { body: index("https://evil.example/sm.xml", "https://pamistanbul.com/ok.xml") }, "https://pamistanbul.com/ok.xml": { body: urlset("https://pamistanbul.com/a") } });
  await run(idx.fetch);
  assert.ok(!idx.calls.some((c) => c.includes("evil.example")), "host disi sitemap fetch EDILMEZ");
});

test("robots.txt Sitemap: satirlari eklenir; robots okunamazsa yalniz not, evren registry'den kurulur", async () => {
  const s = site({
    "https://pamistanbul.com/robots.txt": { body: "User-agent: *\nAllow: /\nSitemap: https://pamistanbul.com/extra.xml\n" },
    "https://pamistanbul.com/sitemap.xml": { body: urlset("https://pamistanbul.com/a") },
    "https://pamistanbul.com/extra.xml": { body: urlset("https://pamistanbul.com/b") },
  });
  const r = await run(s.fetch, { robotsUrl: "https://pamistanbul.com/robots.txt" });
  assert.deepEqual((r as { urls: string[] }).urls, ["https://pamistanbul.com/a", "https://pamistanbul.com/b"]);
  const noRobots = site({ "https://pamistanbul.com/sitemap.xml": { body: urlset("https://pamistanbul.com/a") } });
  const r2 = await run(noRobots.fetch, { robotsUrl: "https://pamistanbul.com/robots.txt" });
  assert.equal(r2.state, "MEASURED");
  assert.ok(r2.notes.some((n) => /robots\.txt okunamadi/.test(n)));
});

test("ayni sitemap iki yoldan gelirse bir kez okunur; dongu sonsuza gitmez", async () => {
  const s = site({
    "https://pamistanbul.com/sitemap.xml": { body: index("https://pamistanbul.com/sitemap.xml", "https://pamistanbul.com/a.xml") },
    "https://pamistanbul.com/a.xml": { body: urlset("https://pamistanbul.com/a") },
  });
  const r = await run(s.fetch, { locations: ["https://pamistanbul.com/sitemap.xml", "https://pamistanbul.com/sitemap.xml"] });
  assert.equal(r.state, "MEASURED");
  assert.equal(s.calls.filter((c) => c.endsWith("/sitemap.xml")).length, 1);
});

test("derinlik ve evren siniri asilirsa UNKNOWN; konum yoksa UNKNOWN", async () => {
  const deep = site({
    "https://pamistanbul.com/sitemap.xml": { body: index("https://pamistanbul.com/1.xml") },
    "https://pamistanbul.com/1.xml": { body: index("https://pamistanbul.com/2.xml") },
    "https://pamistanbul.com/2.xml": { body: index("https://pamistanbul.com/3.xml") },
    "https://pamistanbul.com/3.xml": { body: index("https://pamistanbul.com/4.xml") },
    "https://pamistanbul.com/4.xml": { body: urlset("https://pamistanbul.com/x") },
  });
  assert.equal((await run(deep.fetch)).state, "UNKNOWN");
  const big = site({ "https://pamistanbul.com/sitemap.xml": { body: urlset("https://pamistanbul.com/1", "https://pamistanbul.com/2", "https://pamistanbul.com/3") } });
  assert.equal((await run(big.fetch, { maxUrls: 2 })).state, "UNKNOWN");
  assert.equal((await run(big.fetch, { locations: [] })).state, "UNKNOWN");
  assert.equal((await run(big.fetch, { locations: ["https://evil.example/sitemap.xml"] })).state, "UNKNOWN");
});

test("yeni parser YOK: orkestrasyon mevcut parseSitemap/parseRobots'u kullanir", () => {
  const src = readFileSync(new URL("../src/sitemap-universe.ts", import.meta.url), "utf8");
  assert.match(src, /from "\.\/sitemap\.ts"/);
  assert.match(src, /from "\.\/robots\.ts"/);
  assert.ok(!/matchAll|<loc>|\.match\(\s*\//.test(src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")), "kendi regex ayristiricisi yok");
});
