// SimPass Apple Wallet push relay.
// Receives { pushTokens: [...] } from playsimleague.com and sends an empty
// APNs push to each device so Wallet downloads the latest pass.
import http from "node:http";
import http2 from "node:http2";
import crypto from "node:crypto";

const decode = (v) => {
  const s = (v || "").trim();
  return s.includes("BEGIN") ? s : Buffer.from(s, "base64").toString("utf8");
};
const CERT = decode(process.env.APPLE_CERT_B64);
const KEY = decode(process.env.APPLE_KEY_B64);
const TOPIC = process.env.PASS_TYPE_ID || "pass.com.playsimleague.simpass";
const SECRET = process.env.RELAY_SECRET || "";
const PORT = Number(process.env.PORT || 3000);

function safeEqual(a, b) {
  const x = Buffer.from(a || ""), y = Buffer.from(b || "");
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function pushAll(tokens) {
  return new Promise((resolve) => {
    const client = http2.connect("https://api.push.apple.com", { cert: CERT, key: KEY });
    const results = [];
    let left = tokens.length;
    client.on("error", (e) => { client.close(); resolve(tokens.map((t) => ({ token: t.slice(0, 8), status: 0, error: e.message }))); });
    for (const t of tokens) {
      const req = client.request({ ":method": "POST", ":path": `/3/device/${t}`, "apns-topic": TOPIC, "apns-push-type": "background", "apns-priority": "5", "content-type": "application/json" });
      let status = 0, body = "";
      req.on("response", (h) => { status = Number(h[":status"]); });
      req.on("data", (c) => { body += c; });
      req.on("end", () => { results.push({ token: t.slice(0, 8), status, error: body || undefined }); if (--left === 0) { client.close(); resolve(results); } });
      req.end("{}");
    }
  });
}

http.createServer(async (req, res) => {
  if (req.method === "GET") { res.writeHead(200).end("ok"); return; }
  if (req.method !== "POST" || req.url !== "/push") { res.writeHead(404).end(); return; }
  if (!SECRET || !safeEqual(req.headers["x-relay-secret"], SECRET)) { res.writeHead(401).end("unauthorized"); return; }
  let raw = "";
  for await (const c of req) { raw += c; if (raw.length > 100000) { res.writeHead(413).end(); return; } }
  let tokens = [];
  try { tokens = (JSON.parse(raw).pushTokens || []).filter((t) => /^[A-Fa-f0-9]{32,200}$/.test(t)).slice(0, 500); } catch { res.writeHead(400).end("bad json"); return; }
  if (!tokens.length) { res.writeHead(200, { "content-type": "application/json" }).end('{"sent":0,"results":[]}'); return; }
  const results = await pushAll(tokens);
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ sent: results.filter((r) => r.status === 200).length, results }));
}).listen(PORT, () => console.log(`relay listening on ${PORT}`));
