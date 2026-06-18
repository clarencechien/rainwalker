import CONFIG from "./points.json";

const JSONH = { "content-type": "application/json; charset=utf-8" };
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: JSONH });

export default {
  async scheduled(event, env, ctx) { ctx.waitUntil(refresh(env)); },

  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/data.json") {
      try {
        const obj = await env.BUCKET.get("data.json");
        if (obj) return new Response(obj.body, { headers: { ...JSONH, "cache-control": "no-store" } });
      } catch (e) {}
      return json(await buildData(env));
    }

    if (url.pathname === "/refresh") {
      try { await refresh(env); return json({ ok: true, at: new Date().toISOString() }); }
      catch (e) { return json({ ok: false, error: String(e) }, 500); }
    }

    // 任意座標：最近站現況 + 縣市3小時預報 + 未來1小時QPF + 附近N站
    if (url.pathname === "/at") {
      const lat = +url.searchParams.get("lat"), lng = +url.searchParams.get("lng");
      const n = Math.min(10, +url.searchParams.get("n") || 6);
      if (!isFinite(lat) || !isFinite(lng)) return json({ error: "need lat,lng" }, 400);
      try {
        const stations = extractStations(await cwaFetch("O-A0002-001", env.CWA_KEY));
        const fc = await fetchForecastAll(env.CWA_KEY, CONFIG.day_window || [6, 24]);
        const qpf = await readQpf(env);
        const sorted = stations.map(s => ({ ...s, dist: haversine(lat, lng, s.lat, s.lng) })).sort((a, b) => a.dist - b.dist);
        const here = sorted[0] || null;
        const county = here ? here.county : null;
        return json({
          lat, lng, day_window: CONFIG.day_window || [6, 24], qpf_time: qpf ? qpf.datetime : null,
          here: here ? { name: here.name, mm_hr: here.mm_hr, county, qpf_1h: qpfAt(qpf, lat, lng) } : null,
          plan: county ? (fc[county] || []) : [],
          nearby: sorted.slice(0, n).map(s => ({ name: s.name, area: s.county, mm_hr: s.mm_hr, dist_km: +s.dist.toFixed(2) }))
        });
      } catch (e) { return json({ error: String(e) }, 500); }
    }

    return env.ASSETS.fetch(request);
  }
};

async function refresh(env) {
  let qpf = null;
  try { qpf = await refreshQpf(env); } catch (e) { qpf = null; }
  const data = await buildData(env, qpf);
  await env.BUCKET.put("data.json", JSON.stringify(data), { httpMetadata: { contentType: "application/json" } });
}

async function buildData(env, qpf) {
  try { return await buildLive(env, qpf); }
  catch (e) { return { ...DEMO, _source: "demo-fallback: " + String(e) }; }
}

// ── 現況 + 預報 + QPF ───────────────────────────────────────────
async function buildLive(env, qpf) {
  if (qpf === undefined) qpf = await readQpf(env);

  const ids = CONFIG.points.map(p => p.station).filter(s => s && s !== "TODO");
  const params = (ids.length === CONFIG.points.length) ? { StationId: ids.join(",") } : {};
  const stations = extractStations(await cwaFetch("O-A0002-001", env.CWA_KEY, { params }));
  if (!stations.length) throw new Error("no stations parsed");
  const byId = Object.fromEntries(stations.map(s => [s.id, s]));

  const points = CONFIG.points.map(p => {
    const st = (p.station && byId[p.station]) ? byId[p.station] : nearestStation(stations, p.lat, p.lng);
    return { id: p.id, name: p.name, area: p.area, lat: p.lat, lng: p.lng,
             mm_hr: st ? st.mm_hr : 0, qpf_1h: qpfAt(qpf, p.lat, p.lng) };
  });
  const mmOf = Object.fromEntries(points.map(p => [p.id, p.mm_hr]));
  const countyOf = Object.fromEntries(CONFIG.points.map(p => [p.id, p.county]));

  let fc = {};
  try { fc = await fetchForecastAll(env.CWA_KEY, CONFIG.day_window || [6, 24]); }
  catch (e) { fc = {}; }
  points.forEach(pt => { pt.plan = fc[countyOf[pt.id]] || []; });

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
    mode: "shadow", _source: "live", qpf_time: qpf ? qpf.datetime : null,
    day_window: CONFIG.day_window || [6, 24],
    points, paths
  };
}

// ── QPF：cron 抓整包、抽 qpf_box 內有雨格寫 R2；公式 k=iy*NX+ix（ix=經 iy=緯由南）
async function refreshQpf(env) {
  const key = (env.CWA_KEY || "").trim();
  const raw = await (await fetch(`https://opendata.cwa.gov.tw/fileapi/v1/opendataapi/F-B0046-001?Authorization=${key}&format=JSON`,
    { headers: { accept: "*/*", "user-agent": "rainwalker" } })).json();
  const inf = raw.cwaopendata.dataset.datasetInfo.parameterSet;
  const lon0 = +inf.StartPointLongitude, lat0 = +inf.StartPointLatitude, res = +inf.GridResolution;
  const NX = +inf.GridDimensionX, NY = +inf.GridDimensionY;
  let body = raw.cwaopendata.dataset.contents.content;
  if (typeof body !== "string") body = body["#text"] || body._ || "";
  const vals = body.split(",");
  const box = CONFIG.qpf_box || { lon: [119.8, 122.1], lat: [21.8, 25.4] };
  const ix0 = Math.max(0, Math.floor((box.lon[0] - lon0) / res)), ix1 = Math.min(NX - 1, Math.ceil((box.lon[1] - lon0) / res));
  const iy0 = Math.max(0, Math.floor((box.lat[0] - lat0) / res)), iy1 = Math.min(NY - 1, Math.ceil((box.lat[1] - lat0) / res));
  const cells = [];
  for (let iy = iy0; iy <= iy1; iy++) for (let ix = ix0; ix <= ix1; ix++) {
    const v = +vals[iy * NX + ix];
    if (v > 0) cells.push({ lat: +(lat0 + iy * res).toFixed(4), lng: +(lon0 + ix * res).toFixed(4), mm: v });
  }
  const out = { datetime: inf.DateTime, res, box, cells };
  await env.BUCKET.put("qpf.json", JSON.stringify(out), { httpMetadata: { contentType: "application/json" } });
  return out;
}
async function readQpf(env) {
  try { const o = await env.BUCKET.get("qpf.json"); return o ? JSON.parse(await o.text()) : null; }
  catch (e) { return null; }
}
// 取某點未來1小時 QPF（mm）：取附近 ~1.5 格內最大雨格；qpf 載入但附近無雨格回 0；未載入回 null
function qpfAt(qpf, lat, lng) {
  if (!qpf || !qpf.cells) return null;
  const r = (qpf.res || 0.0125) * 1.5;
  let best = 0;
  for (const c of qpf.cells) {
    if (Math.abs(c.lat - lat) <= r && Math.abs(c.lng - lng) <= r && c.mm > best) best = c.mm;
  }
  return best;
}

// ── O-A0002-001 雨量站 ──────────────────────────────────────────
function extractStations(raw) {
  const recs = raw && raw.records || {};
  const arr = recs.Station || recs.station || recs.location || [];
  const out = [];
  for (const s of arr) {
    const c = getWGS84(s);
    if (!c) continue;
    out.push({ name: s.StationName || s.locationName || s.StationId, id: s.StationId,
               lat: c.lat, lng: c.lng, mm_hr: getRainRate(s), obsTime: getObsTime(s),
               county: (s.GeoInfo && s.GeoInfo.CountyName) || s.CountyName || null });
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
function vnum(v) { const n = +v; return isFinite(n) && n >= 0 ? n : null; }
function getRainRate(s) {
  const re = s.RainfallElement || s.rainfallElement;
  if (re) {
    const p1 = vnum(re.Past1hr && re.Past1hr.Precipitation);
    if (p1 != null) return p1;
    const p10 = vnum((re.Past10Min || re.Past10min || {}).Precipitation);
    if (p10 != null) return +(p10 * 6).toFixed(1);
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

// ── F-D0047-089 全台縣市逐3小時預報 ─────────────────────────────
async function fetchForecastAll(key, dayWin) {
  const [w0, w1] = dayWin;
  const raw = await cwaFetch("F-D0047-089", key, { params: { ElementName: "3小時降雨機率,天氣現象" } });
  const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  const out = {};
  for (const loc of collectLocations(raw)) out[loc.LocationName] = locBlocks(loc, w0, w1, today);
  return out;
}
function collectLocations(node, out = []) {
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node)) { node.forEach(n => collectLocations(n, out)); return out; }
  if (node.LocationName && node.WeatherElement) out.push(node);
  for (const k in node) { const v = node[k]; if (v && typeof v === "object") collectLocations(v, out); }
  return out;
}
function locBlocks(loc, w0, w1, today) {
  const pops = {}, wxs = {};
  for (const el of (loc.WeatherElement || [])) {
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
  return blocks.sort((a, b) => a.from - b.from);
}
function hourOf(iso) { const m = /T(\d{2}):/.exec(iso || ""); return m ? +m[1] : 0; }
function wxToMm(wx, pop) {
  if (/豪雨/.test(wx)) return 30;
  if (/大雨/.test(wx)) return 15;
  if (/雷/.test(wx)) return 8;
  if (/陣雨|短暫雨|雨/.test(wx)) return 3;
  if (pop >= 70) return 8; if (pop >= 50) return 4; if (pop >= 30) return 2; return 0;
}
function mergeBlocks(a, b) {
  const m = {};
  for (const blk of [...(a || []), ...(b || [])]) {
    const k = blk.from;
    if (!m[k] || blk.pop > m[k].pop) m[k] = { ...blk };
    else if (blk.mm_hr > m[k].mm_hr) m[k].mm_hr = blk.mm_hr;
  }
  return Object.values(m).sort((x, y) => x.from - y.from);
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
  updated_local: "2026-06-18 13:40", source_age_min: 3, mode: "shadow", day_window: [6, 24],
  points: [
    { id: "A", name: "中和", area: "中和", lat: 24.9977, lng: 121.4855, mm_hr: 0, qpf_1h: null, plan: [{ from: 15, to: 18, pop: 80, mm_hr: 8 }] },
    { id: "B", name: "永和", area: "永和", lat: 25.0138, lng: 121.5155, mm_hr: 0, qpf_1h: null, plan: [{ from: 15, to: 18, pop: 80, mm_hr: 8 }] },
    { id: "C", name: "內湖", area: "內湖", lat: 25.0732, lng: 121.5789, mm_hr: 6.5, qpf_1h: null, plan: [{ from: 12, to: 15, pop: 90, mm_hr: 12 }] }
  ],
  paths: [
    { id: "B-A", from: "B", to: "A", tag: "上班", status: "clear", plan: { state: "forecast", blocks: [{ from: 15, to: 18, mm_hr: 8, pop: 80 }] } },
    { id: "B-C", from: "B", to: "C", tag: "上班", status: "raining_now", peak_mm_hr: 6.5, plan: { state: "confirmed", blocks: [{ from: 12, to: 15, mm_hr: 12, pop: 90 }] } },
    { id: "A-B", from: "A", to: "B", tag: "下班", status: "clear", plan: { state: "cleared", blocks: [] } },
    { id: "C-B", from: "C", to: "B", tag: "下班", status: "raining_now", peak_mm_hr: 6.5, plan: { state: "confirmed", blocks: [{ from: 12, to: 15, mm_hr: 12, pop: 90 }] } }
  ]
};
