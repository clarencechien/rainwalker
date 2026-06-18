import CONFIG from "./points.json";

const JSONH = { "content-type": "application/json; charset=utf-8" };
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: JSONH });

export default {
  async scheduled(event, env, ctx) { ctx.waitUntil(refresh(env)); },

  async fetch(request, env) {
    const url = new URL(request.url);

    // data.json：優先 R2，沒有就即時算
    if (url.pathname === "/data.json") {
      try {
        const obj = await env.BUCKET.get("data.json");
        if (obj) return new Response(obj.body, { headers: { ...JSONH, "cache-control": "no-store" } });
      } catch (e) {}
      return json(await buildData(env));
    }

    // 手動觸發寫 R2
    if (url.pathname === "/refresh") {
      try { await refresh(env); return json({ ok: true, at: new Date().toISOString() }); }
      catch (e) { return json({ ok: false, error: String(e) }, 500); }
    }

    // 除錯：每個點對到的最近雨量站 + 現在雨量 + 距離
    if (url.pathname === "/nearest") {
      try {
        const st = extractStations(await cwaFetch("O-A0002-001", env.CWA_KEY));
        return json({ station_count: st.length, points: CONFIG.points.map(p => {
          const n = nearestStation(st, p.lat, p.lng);
          return { point: p.id, area: p.area,
            station: n ? n.name : null, id: n ? n.id : null,
            mm_hr: n ? n.mm_hr : null,
            dist_km: n ? +haversine(p.lat, p.lng, n.lat, n.lng).toFixed(2) : null };
        })});
      } catch (e) { return json({ error: String(e) }, 500); }
    }

    // 除錯：原始結構（top keys + 站數 + 第一筆樣本）
    if (url.pathname === "/probe") {
      try {
        const raw = await cwaFetch("O-A0002-001", env.CWA_KEY);
        const recs = raw && raw.records || {};
        const arr = recs.Station || recs.station || recs.location || [];
        return json({ topKeys: Object.keys(recs), count: arr.length, sample: arr[0] || null });
      } catch (e) { return json({ error: String(e) }, 500); }
    }

    // 除錯：檢查 CWA_KEY 是否設對（不洩漏內容）
    if (url.pathname === "/keycheck") {
      const k = env.CWA_KEY || "";
      const t = k.trim();
      return json({
        set: !!k, raw_len: k.length, trimmed_len: t.length,
        has_outer_whitespace: k !== t,
        starts_with_CWA: t.startsWith("CWA-"),
        looks_valid_format: /^CWA-[0-9A-Fa-f-]{36}$/.test(t)
      });
    }

    // 除錯：探預報資料集結構（預設不過濾，挖第一鄉鎮 + PoP element）
    if (url.pathname === "/fc") {
      const ds = url.searchParams.get("ds") || "F-D0047-089";
      const loc = url.searchParams.get("loc");
      try {
        const params = loc ? { LocationName: loc } : {};
        const raw = await cwaFetch(ds, env.CWA_KEY, { params });
        const top = raw && raw.records && raw.records.Locations && raw.records.Locations[0] || {};
        const locs = top.Location || [];
        const first = locs[0] || null;
        const els = first ? (first.WeatherElement || []) : [];
        const pop = els.find(e => /降雨|機率|PoP|Probability/i.test(e.ElementName || "")) || els[0] || null;
        const trim = e => { if (!e) return null; const c = { ...e }; if (c.Time) c.Time = c.Time.slice(0, 3); return c; };
        return json({
          ds, desc: top.DatasetDescription, count: locs.length,
          names: locs.slice(0, 6).map(l => l.LocationName),
          elementNames: els.map(e => e.ElementName),
          popSample: trim(pop)
        });
      } catch (e) { return json({ ds, error: String(e) }, 500); }
    }

    // 其餘 → 靜態（index.html）
    return env.ASSETS.fetch(request);
  }
};

async function refresh(env) {
  const data = await buildData(env);
  await env.BUCKET.put("data.json", JSON.stringify(data), { httpMetadata: { contentType: "application/json" } });
}

async function buildData(env) {
  try { return await buildLive(env); }
  catch (e) { return { ...DEMO, _source: "demo-fallback: " + String(e) }; }
}

// ── 現況 + 預報 ─────────────────────────────────────────────────
async function buildLive(env) {
  // 現況：雨量站（只抓設定好的站，CPU 安全）
  const ids = CONFIG.points.map(p => p.station).filter(s => s && s !== "TODO");
  const params = (ids.length === CONFIG.points.length) ? { StationId: ids.join(",") } : {};
  const stations = extractStations(await cwaFetch("O-A0002-001", env.CWA_KEY, { params }));
  if (!stations.length) throw new Error("no stations parsed");
  const byId = Object.fromEntries(stations.map(s => [s.id, s]));
  const points = CONFIG.points.map(p => {
    const st = (p.station && byId[p.station]) ? byId[p.station] : nearestStation(stations, p.lat, p.lng);
    return { id: p.id, name: p.name, area: p.area, mm_hr: st ? st.mm_hr : 0 };
  });
  const mmOf = Object.fromEntries(points.map(p => [p.id, p.mm_hr]));
  const countyOf = Object.fromEntries(CONFIG.points.map(p => [p.id, p.county]));

  // 預報：縣市逐3小時 PoP（失敗不影響現況）
  let fc = {};
  try { fc = await fetchForecast(env.CWA_KEY, CONFIG.day_window || [6, 24]); }
  catch (e) { fc = { _err: String(e) }; }

  const d8 = new Date(Date.now() + 8 * 3600 * 1000);
  const nowHr = d8.getHours() + d8.getMinutes() / 60;

  const paths = CONFIG.paths.map(p => {
    const peak = Math.max(mmOf[p.from] || 0, mmOf[p.to] || 0);
    const raining = peak >= 0.2;
    const blocks = mergeBlocks(fc[countyOf[p.from]], fc[countyOf[p.to]]);
    const futureRain = blocks.some(b => b.to > nowHr);
    const state = raining ? "confirmed" : (blocks.length ? (futureRain ? "forecast" : "cleared") : "cleared");
    return {
      id: p.id, from: p.from, to: p.to, tag: p.tag,
      status: raining ? "raining_now" : "clear",
      ...(raining ? { peak_mm_hr: peak, window_min: [0, 30] } : {}),
      plan: { state, blocks }
    };
  });

  const obs = stations.find(s => s.obsTime) ? stations.find(s => s.obsTime).obsTime : null;
  return {
    updated_local: d8.toISOString().slice(0, 16).replace("T", " "),
    source_age_min: obs ? Math.max(0, Math.round((Date.now() - Date.parse(obs)) / 60000)) : 0,
    mode: "shadow", _source: "live", _fc: Object.keys(fc),
    day_window: CONFIG.day_window || [6, 24],
    points, paths
  };
}

// 抓縣市逐3小時預報 → 每個縣市回 [{from,to,pop,mm_hr}]（只今天、day_window 內、PoP>=30）
async function fetchForecast(key, dayWin) {
  const [w0, w1] = dayWin;
  const raw = await cwaFetch("F-D0047-089", key, { params: {
    ElementName: "3小時降雨機率,天氣現象"
  }});
  const found = findLocations(raw, ["新北市", "臺北市", "台北市"]);
  const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  const out = {};
  for (const name in found) {
    const pops = {}, wxs = {};
    for (const el of (found[name].WeatherElement || [])) {
      const isPop = /降雨機率|Probability/i.test(el.ElementName);
      const isWx = /天氣現象/.test(el.ElementName);
      for (const t of (el.Time || [])) {
        const v = (t.ElementValue && t.ElementValue[0]) || {};
        if (isPop) pops[t.StartTime] = { start: t.StartTime, end: t.EndTime, pop: +(v.ProbabilityOfPrecipitation ?? v.Value ?? -1) };
        if (isWx) wxs[t.StartTime] = v.Weather || v.WeatherDescription || v.Value || "";
      }
    }
    const blocks = [];
    for (const k in pops) {
      const b = pops[k];
      if (!b.start.startsWith(today)) continue;
      const from = hourOf(b.start), to = hourOf(b.end) || 24;
      if (to <= w0 || from >= w1 || b.pop < 30) continue;
      blocks.push({ from, to, pop: b.pop, mm_hr: wxToMm(wxs[k] || "", b.pop) });
    }
    out[name] = blocks.sort((a, b) => a.from - b.from);
  }
  return out;
}

// 遞迴找指定 LocationName 的節點（防多層巢狀）
function findLocations(node, want, out = {}) {
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node)) { node.forEach(n => findLocations(n, want, out)); return out; }
  if (node.LocationName && want.includes(node.LocationName) && node.WeatherElement) out[node.LocationName] = node;
  for (const k in node) { const v = node[k]; if (v && typeof v === "object") findLocations(v, want, out); }
  return out;
}
function hourOf(iso) { const m = /T(\d{2}):/.exec(iso || ""); return m ? +m[1] : 0; }
function wxToMm(wx, pop) {
  if (/豪雨/.test(wx)) return 30;
  if (/大雨/.test(wx)) return 15;
  if (/雷/.test(wx)) return 8;
  if (/陣雨|短暫雨|雨/.test(wx)) return 3;
  if (pop >= 70) return 8; if (pop >= 50) return 4; if (pop >= 30) return 2; return 0;
}
// 合併兩端縣市的雨窗：同時段取較大者
function mergeBlocks(a, b) {
  const m = {};
  for (const blk of [...(a || []), ...(b || [])]) {
    const k = blk.from;
    if (!m[k] || blk.pop > m[k].pop) m[k] = { ...blk };
    else if (blk.mm_hr > m[k].mm_hr) m[k].mm_hr = blk.mm_hr;
  }
  return Object.values(m).sort((x, y) => x.from - y.from);
}

// ── 解析 O-A0002-001（防多版 schema）────────────────────────────
function extractStations(raw) {
  const recs = raw && raw.records || {};
  const arr = recs.Station || recs.station || recs.location || [];
  const out = [];
  for (const s of arr) {
    const c = getWGS84(s);
    if (!c) continue;
    out.push({ name: s.StationName || s.locationName || s.StationId, id: s.StationId,
               lat: c.lat, lng: c.lng, mm_hr: getRainRate(s), obsTime: getObsTime(s) });
  }
  return out;
}
function getWGS84(s) {
  const gi = s.GeoInfo;
  if (gi && gi.Coordinates) {
    const c = gi.Coordinates.find(x => x.CoordinateName === "WGS84") || gi.Coordinates[0];
    const lat = +c.StationLatitude, lng = +c.StationLongitude;
    if (isFinite(lat) && isFinite(lng)) return { lat, lng };
  }
  const lat = +(s.StationLatitude ?? s.lat), lng = +(s.StationLongitude ?? s.lon);
  if (isFinite(lat) && isFinite(lng)) return { lat, lng };
  return null;
}
function vnum(v) { const n = +v; return isFinite(n) && n >= 0 ? n : null; } // -99/-990/T/X → null
function getRainRate(s) {
  const re = s.RainfallElement || s.rainfallElement;
  if (re) {
    const p1 = vnum(re.Past1hr && re.Past1hr.Precipitation);
    if (p1 != null) return p1;                                   // 過去1小時 mm ≈ mm/hr
    const p10 = vnum((re.Past10Min || re.Past10min || {}).Precipitation);
    if (p10 != null) return +(p10 * 6).toFixed(1);               // 10分 × 6
    const now = vnum(re.Now && re.Now.Precipitation);
    if (now != null) return now;
  }
  return 0;
}
function getObsTime(s) { return (s.ObsTime && s.ObsTime.DateTime) || s.obsTime || null; }

function nearestStation(stations, lat, lng) {
  let best = null, bd = Infinity;
  for (const s of stations) { const d = haversine(lat, lng, s.lat, s.lng); if (d < bd) { bd = d; best = s; } }
  return best;
}
function haversine(la1, lo1, la2, lo2) {
  const R = 6371, dLa = (la2 - la1) * Math.PI / 180, dLo = (lo2 - lo1) * Math.PI / 180;
  const a = Math.sin(dLa / 2) ** 2 + Math.cos(la1 * Math.PI / 180) * Math.cos(la2 * Math.PI / 180) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

async function cwaFetch(dataId, key, { fileapi = false, format = "JSON", params = {} } = {}) {
  const k = (key || "").trim();
  if (!k) throw new Error("CWA_KEY not set");
  const base = fileapi
    ? `https://opendata.cwa.gov.tw/fileapi/v1/opendataapi/${dataId}`
    : `https://opendata.cwa.gov.tw/api/v1/rest/datastore/${dataId}`;
  const q = new URLSearchParams({ Authorization: k, format, ...params });
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
