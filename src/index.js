import CONFIG from "./points.json";

const JSONH = { "content-type": "application/json; charset=utf-8" };
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: JSONH });

export default {
  // cron：抓 CWA、算完寫進 R2
  async scheduled(event, env, ctx) {
    ctx.waitUntil(refresh(env));
  },
  async fetch(request, env) {
    const url = new URL(request.url);

    // 1) data.json：優先 R2，沒有就回即時算的（避免 R2 還沒綁/還沒寫時前端開天窗）
    if (url.pathname === "/data.json") {
      try {
        const obj = await env.BUCKET.get("data.json");
        if (obj) return new Response(obj.body, { headers: { ...JSONH, "cache-control": "no-store" } });
      } catch (e) { /* R2 未綁定或讀取失敗 → 落到下面回 DEMO */ }
      return json(await buildData(env));
    }

    // 2) 手動觸發一次（測試 R2 寫入）
    if (url.pathname === "/refresh") {
      try { await refresh(env); return json({ ok: true, at: new Date().toISOString() }); }
      catch (e) { return json({ ok: false, error: String(e) }, 500); }
    }

    // 3) 其餘 → 靜態資源（index.html 等）
    return env.ASSETS.fetch(request);
  }
};

async function refresh(env) {
  const data = await buildData(env);
  await env.BUCKET.put("data.json", JSON.stringify(data), { httpMetadata: { contentType: "application/json" } });
  // 之後可在這 append 一列到 D1 當 shadow log
}

async function buildData(env) {
  // ── TODO(邊寫邊驗) 用 env.CWA_KEY 接真資料 ──────────────────────
  // 1. 現況：cwaFetch("O-A0002-001", env.CWA_KEY) → 各 point 最近站 min_10 → mm/hr
  // 2. 預報：cwaFetch("F-D0047-0xx", env.CWA_KEY) → 各 township Wx+PoP → plan.blocks
  // 3. 臨近(粗)：cwaFetch("F-B0046-001", env.CWA_KEY, {fileapi:true}) → paths[].status
  // 4. reconcile：plan vs 現況 → plan.state
  // 現在先回 DEMO，讓整條鏈先通：
  return DEMO;
}

// CWA 取用 helper：datastore（查詢型 JSON）/ fileapi（檔案型，如閃電 KMZ）
async function cwaFetch(dataId, key, { fileapi = false, format = "JSON", params = {} } = {}) {
  const base = fileapi
    ? `https://opendata.cwa.gov.tw/fileapi/v1/opendataapi/${dataId}`
    : `https://opendata.cwa.gov.tw/api/v1/rest/datastore/${dataId}`;
  const q = new URLSearchParams({ Authorization: key, format, ...params });
  const r = await fetch(`${base}?${q}`, { headers: { accept: "application/json", "user-agent": "rainwalker" } });
  if (!r.ok) throw new Error(`CWA ${dataId} HTTP ${r.status}`);
  return format === "JSON" ? r.json() : r.text();
}

const DEMO = {
  updated_local: "2026-06-17 11:48", source_age_min: 2, mode: "shadow", day_window: [6, 24],
  points: [
    { id: "A", name: "遠東世紀廣場", area: "中和", mm_hr: 0 },
    { id: "B", name: "頂溪站", area: "永和", mm_hr: 1.2 },
    { id: "C", name: "瑞光智慧社區", area: "內湖", mm_hr: 14 }
  ],
  paths: [
    { id: "B-A", from: "B", to: "A", tag: "上班", status: "clear",
      plan: { state: "forecast", note: "預報 15–18 時有雨 · 實況尚早", blocks: [{ from: 15, to: 18, mm_hr: 5, pop: 60 }] } },
    { id: "B-C", from: "B", to: "C", tag: "上班", status: "rain_ahead",
      eta_min: 18, segment: "內湖段", peak_mm_hr: 6, window_min: [18, 38], confidence: "中",
      plan: { state: "forming", note: "預報 12–15 時 · 實況成形中", blocks: [{ from: 12, to: 15, mm_hr: 8, pop: 70 }] } },
    { id: "A-B", from: "A", to: "B", tag: "下班", status: "clear",
      plan: { state: "cleared", note: "今日無明顯降雨預報", blocks: [] } },
    { id: "C-B", from: "C", to: "B", tag: "下班", status: "raining_now",
      segment: "內科起點", peak_mm_hr: 14, window_min: [0, 25], confidence: "高",
      plan: { state: "confirmed", note: "預報 12:00 · 實況提前 12 分（11:48 已下）", blocks: [{ from: 12, to: 15, mm_hr: 12, pop: 80 }] } }
  ]
};
