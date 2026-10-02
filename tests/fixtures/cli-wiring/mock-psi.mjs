// Test-only preload (node --import): sahte PageSpeed Insights. GERCEK ag YOK.
// MOCK_MODE=ok   -> 200 + kirpilmis gercek-sekilli govde
// MOCK_MODE=fail -> hata firlatir; mesaj anahtar iceren TAM URL'yi tasir (sizinti testi)
// Her cagri NET_MARK dosyasina yazilir; ANAHTARIN KENDISI degil, yalniz "key dogru mu" bilgisi.
import { appendFileSync } from "node:fs";
import net from "node:net";
net.Socket.prototype.connect = function () { throw new Error("ham soket yasak (test)"); };
globalThis.fetch = async (url) => {
  const u = new URL(String(url));
  const keyOk = u.searchParams.get("key") === process.env.EXPECT_KEY;
  appendFileSync(process.env.NET_MARK, `${u.origin}${u.pathname} strategy=${u.searchParams.get("strategy")} keyOk=${keyOk}\n`);
  if (u.origin !== "https://www.googleapis.com") throw new Error("beklenmeyen host");
  if (process.env.MOCK_MODE === "fail") throw new Error(`connect ECONNRESET ${String(url)}`);
  const body = {
    loadingExperience: { metrics: { LARGEST_CONTENTFUL_PAINT_MS: { percentile: 2100 }, INTERACTION_TO_NEXT_PAINT: { percentile: 180 }, CUMULATIVE_LAYOUT_SHIFT_SCORE: { percentile: 5 }, EXPERIMENTAL_TIME_TO_FIRST_BYTE: { percentile: 600 } } },
    lighthouseResult: { categories: { performance: { score: 0.82 } }, audits: {} },
  };
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
};
