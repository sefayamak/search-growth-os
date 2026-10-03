// Test-only preload: mock-google.mjs'ten SONRA yuklenir; her GSC searchAnalytics istegini MOCK_GSC_LOG dosyasina
// "<property>\t<dimensions>" olarak ekler ve istegi sarmalanan mock'a iletir. Ag YOK. Amac: "GSC cagrisi sayisi" kaniti.
import { appendFileSync } from "node:fs";
const inner = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  const m = u.match(/sites\/([^/]+)\/searchAnalytics\/query/);
  if (m && process.env.MOCK_GSC_LOG) {
    const dims = JSON.parse(init.body).dimensions.join(",") || "(total)";
    appendFileSync(process.env.MOCK_GSC_LOG, `${decodeURIComponent(m[1])}\t${dims}\n`);
  }
  return inner(url, init);
};
