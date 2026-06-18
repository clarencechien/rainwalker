import CONFIG from "../points.json";

const CORS = { "Access-Control-Allow-Origin": "*", "content-type": "application/json; charset=utf-8" };
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: CORS });

export default {
  // cron：抓 CWA、算完寫進 R2
  async scheduled(event, env, ctx) {
    ctx.waitUntil(refresh(env));
  },
  // 提供 data.json 給前端讀（部署後把 index.html 的 DATA_URL 指到本 Worker 網址）
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    const url = new URL(request.url);
    if (url.pathname === "/refresh") { await refresh(env); return json({ ok: true }); } // 手動觸發測試
    const obj = await env.BUCKET.get("data.json");
    if (!obj) return json({ error: "no data yet — 先打 /refresh 或等 cron" }, 404);
    return new Response(obj.body, { headers: { ...CORS, "cache-control": "no-store" } });
  }
};

async function refresh(env) {
  const data = await buildData(env);
  await env.BUCKET.put("data.json", JSON.stringify(data), { httpMetadata: { contentType: "application/json" } });
  // 之後可在這裡 append 一列到 D1 當 shadow log（plan vs actual 對帳評分）
}

async function buildData(env) {
  const key = env.CWA_KEY;                                  // wrangler secret put CWA_KEY
  const now = new Date(Date.now() + 8 * 3600 * 1000);       // UTC+8
  const updated_local = now.toISOString().slice(0, 16).replace("T", " ");

  // ── TODO(邊寫邊驗) 真資料接這裡 ────────────────────────────────
  // 1. 現況：cwaFetch("O-A0002-001", key) → 每 point 最近測站 min_10 → mm/hr（缺值沿用前筆）
  // 2. 預報：cwaFetch("F-D0047-0xx", key) → 各 township 逐時段 Wx + PoP → plan.blocks
  // 3. 臨近(粗)：cwaFetch("F-B0046-001", key, {fileapi:true}) → 走廊未來1hr → paths[].status
  // 4. reconcile：plan vs 現況 → plan.state
  // ──────────────────────────────────────────────────────────────

  // 暫時：由 config 組出「現況皆乾」的合法骨架，讓 end-to-end 先通
  const points = CONFIG.points.map(p => ({ id: p.id, name: p.name, area: p.area, mm_hr: 0 }));
  const paths = CONFIG.paths.map(p => ({
    id: p.id, from: p.from, to: p.to, tag: p.tag,
    status: "clear",
    plan: { state: "forecast", note: "（尚未接真資料）", blocks: [] }
  }));

  return { updated_local, source_age_min: 0, mode: "shadow", day_window: CONFIG.day_window || [6, 24], points, paths };
}

// CWA 取用 helper：datastore（查詢型 JSON）或 fileapi（檔案型，如閃電 KMZ）
async function cwaFetch(dataId, key, { fileapi = false, format = "JSON", params = {} } = {}) {
  const base = fileapi
    ? `https://opendata.cwa.gov.tw/fileapi/v1/opendataapi/${dataId}`
    : `https://opendata.cwa.gov.tw/api/v1/rest/datastore/${dataId}`;
  const q = new URLSearchParams({ Authorization: key, format, ...params });
  const r = await fetch(`${base}?${q}`, { headers: { accept: "application/json", "user-agent": "rain-on-route" } });
  if (!r.ok) throw new Error(`CWA ${dataId} HTTP ${r.status}`);
  return format === "JSON" ? r.json() : r.text();
}
