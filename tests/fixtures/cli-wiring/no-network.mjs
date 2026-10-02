// Test-only preload (node --import). Amac: "ag yok" iddiasini KANITLAMAK. fetch ve ham soket baglantisi
// denenirse bir isaret dosyasina (NET_MARK) yazilir ve hata firlatilir; hicbir gercek istek cikmaz.
import { appendFileSync } from "node:fs";
import net from "node:net";
const mark = (what) => { try { appendFileSync(process.env.NET_MARK, `${what}\n`); } catch {} };
globalThis.fetch = async (url) => { mark(`fetch ${String(url).split("?")[0]}`); throw new Error("ag kapali (test)"); };
net.Socket.prototype.connect = function () { mark("socket.connect"); throw new Error("ag kapali (test)"); };
