import CONFIG from "./points.json";

const JSONH = { "content-type": "application/json; charset=utf-8" };
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: JSONH });

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      await refresh(env);
      try { await shadowAppend(env); } catch (e) { /* shadow 失敗不影響主流程 */ }
    })());
  },

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
        const warnings = await fetchWarnings(env.CWA_KEY);
        const sorted = stations.map(s => ({ ...s, dist: haversine(lat, lng, s.lat, s.lng) })).sort((a, b) => a.dist - b.dist);
        const here = sorted[0] || null;
        const county = here ? here.county : null;
        const plan = county ? (fc[county] || []) : [];
        const d8 = new Date(Date.now() + 8 * 3600 * 1000), nowHr = d8.getHours() + d8.getMinutes() / 60;
        const qv = qpfAt(qpf, lat, lng);
        return json({
          lat, lng, day_window: CONFIG.day_window || [6, 24], qpf_time: qpf ? qpf.datetime : null,
          here: here ? { name: here.name, mm_hr: here.mm_hr, county, qpf_1h: qv,
            nowcast: buildNowcast(here.mm_hr, here.r10, here.r1h, qv, plan, warnings[county], nowHr) } : null,
          plan,
          nearby: sorted.slice(0, n).map(s => ({ name: s.name, area: s.county, mm_hr: s.mm_hr, dist_km: +s.dist.toFixed(2) }))
        });
      } catch (e) { return json({ error: String(e) }, 500); }
    }

    // Shadow log 探針：驗 R2 累積（驗完移除）
    if (url.pathname === "/shadow/peek") {
      const day = url.searchParams.get("day") || "";
      if (day.length !== 8) return json({ error: "need day=YYYYMMDD" }, 400);
      const dp = `${day.slice(0,4)}/${day.slice(4,6)}/${day.slice(6,8)}`;
      const n = (CONFIG.shadow_points || []).length || 8;
      async function rd(k) {
        try {
          const o = await env.BUCKET.get(k); if (!o) return { lines: 0 };
          const ls = (await o.text()).trim().split("\n").filter(Boolean);
          return { lines: ls.length, last: ls.slice(-n).map(x => JSON.parse(x)) };
        } catch (e) { return { error: String(e) }; }
      }
      return json({ day, points: n, fc: await rd(`shadow/fc/${dp}.ndjson`), ob: await rd(`shadow/ob/${dp}.ndjson`) });
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
  const countyOf = Object.fromEntries(CONFIG.points.map(p => [p.id, p.county]));

  let fc = {};
  try { fc = await fetchForecastAll(env.CWA_KEY, CONFIG.day_window || [6, 24]); } catch (e) { fc = {}; }
  const warnings = await fetchWarnings(env.CWA_KEY);

  const d8 = new Date(Date.now() + 8 * 3600 * 1000);
  const nowHr = d8.getHours() + d8.getMinutes() / 60;

  const points = CONFIG.points.map(p => {
    const st = (p.station && byId[p.station]) ? byId[p.station] : nearestStation(stations, p.lat, p.lng);
    const mm = st ? st.mm_hr : 0, qv = qpfAt(qpf, p.lat, p.lng), plan = fc[p.county] || [];
    return { id: p.id, name: p.name, area: p.area, lat: p.lat, lng: p.lng,
             mm_hr: mm, qpf_1h: qv, plan,
             nowcast: buildNowcast(mm, st ? st.r10 : null, st ? st.r1h : null, qv, plan, warnings[p.county], nowHr) };
  });
  const mmOf = Object.fromEntries(points.map(p => [p.id, p.mm_hr]));

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
// ── Shadow log（雙 log 純 append；R2 無原生 append → 讀日檔接行寫回）──
function shadowSlot() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);   // 位移成台灣時間，用 UTC getter 取值
  const fl = Math.floor(d.getUTCMinutes() / 10) * 10;
  const Y = d.getUTCFullYear(), M = String(d.getUTCMonth() + 1).padStart(2, "0"), D = String(d.getUTCDate()).padStart(2, "0");
  const H = String(d.getUTCHours()).padStart(2, "0"), mm = String(fl).padStart(2, "0");
  return { slot: `${Y}${M}${D}${H}${mm}`, datePath: `${Y}/${M}/${D}`,
           ts: `${Y}-${M}-${D}T${H}:${mm}:00+08:00`, nowHr: d.getUTCHours() + d.getUTCMinutes() / 60 };
}
async function r2AppendLines(env, key, lines) {
  if (!lines.length) return;
  let prev = "";
  try { const o = await env.BUCKET.get(key); if (o) prev = await o.text(); } catch (e) {}
  const body = prev + lines.map(l => JSON.stringify(l)).join("\n") + "\n";
  await env.BUCKET.put(key, body, { httpMetadata: { contentType: "application/x-ndjson" } });
}
async function shadowAppend(env) {
  const pts = CONFIG.shadow_points || [];
  if (!pts.length) return;
  const { slot, datePath, ts, nowHr } = shadowSlot();
  const stations = extractStations(await cwaFetch("O-A0002-001", env.CWA_KEY));   // 全站，供 8 點綁最近站
  if (!stations.length) return;
  const qpf = await readQpf(env);
  let fc = {}, warnings = {};
  try { fc = await fetchForecastAll(env.CWA_KEY, CONFIG.day_window || [6, 24]); } catch (e) {}
  try { warnings = await fetchWarnings(env.CWA_KEY); } catch (e) {}
  const fcLines = [], obLines = [];
  for (const p of pts) {
    const st = nearestStation(stations, p.lat, p.lng); if (!st) continue;
    const county = st.county, qv = qpfAt(qpf, p.lat, p.lng), plan = fc[county] || [];
    const nc = buildNowcast(st.mm_hr, st.r10, st.r1h, qv, plan, warnings[county], nowHr);
    fcLines.push({ slot, pid: p.id, ts, qpf: qv, tier: nc.tier, poss: nc.possibility,
      trend: nc.trend, verdict: nc.verdict, warn: nc.warn, plan3: nc.evidence[2],
      now_mm: st.mm_hr, station: st.id, county });
    obLines.push({ slot, pid: p.id, ts, p1h: st.r1h, p10: st.r10, valid: st.r1h != null });
  }
  await r2AppendLines(env, `shadow/fc/${datePath}.ndjson`, fcLines);
  await r2AppendLines(env, `shadow/ob/${datePath}.ndjson`, obLines);
}

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
    const rt = getRates(s);
    out.push({ name: s.StationName || s.locationName || s.StationId, id: s.StationId,
               lat: c.lat, lng: c.lng, mm_hr: getRainRate(s), r10: rt.r10, r1h: rt.r1h,
               obsTime: getObsTime(s),
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
function getRates(s) {
  const re = s.RainfallElement || s.rainfallElement || {};
  const r1h = vnum(re.Past1hr && re.Past1hr.Precipitation);
  const p10 = vnum((re.Past10Min || re.Past10min || {}).Precipitation);
  return { r10: p10 != null ? +(p10 * 6).toFixed(1) : null, r1h: r1h };
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

// ── W-C0033 天氣特報 → { 縣市: [現象...] } ─────────────────────
async function fetchWarnings(key) {
  try {
    const raw = await cwaFetch("W-C0033-001", key);
    const locs = (raw && raw.records && raw.records.location) || [];
    const out = {};
    for (const l of locs) {
      const nm = l.locationName;
      const hz = (l.hazardConditions && l.hazardConditions.hazards) || [];
      const phen = hz.map(h => h.info && h.info.phenomena).filter(Boolean);
      if (phen.length) out[nm] = [...new Set(phen)];
    }
    return out;
  } catch (e) { return {}; }
}

// ── 融合：現況 + 趨勢 + QPF + 3hr預報 + 特報 → 一句判語 ──────────
function tierOf(mm) { return mm < 0.2 ? 0 : mm < 1 ? 1 : mm < 4 ? 2 : mm < 10 ? 3 : mm < 30 ? 4 : 5; }
// 強度詞：依 tier
const TIER_WORD = ["雨", "毛毛雨", "小雨", "中雨", "大雨", "豪雨"];
// 行動建議：依 tier（致災級才強烈）
function actionHint(tier, wp) {
  if (tier >= 5) return "建議改捷運、別騎車";
  if (tier >= 4) return wp ? `留意${wp}特報，騎車穿雨衣` : "帶傘，騎車穿雨衣";
  if (tier >= 3) return "記得帶傘";
  if (tier >= 1) return "影響不大，帶把傘保險";
  return "放心出門";
}
function buildNowcast(now, r10, r1h, qpf, plan, warn, nowHr) {
  now = +now || 0;
  const trend = (r10 != null && r1h != null)
    ? (r10 > r1h * 1.3 + 0.2 ? "rising" : (r10 < r1h * 0.7 - 0.05 ? "falling" : "steady")) : "steady";
  const fut = (plan || []).filter(b => b.to > nowHr);
  const nb = fut[0] || null;
  const plan3 = nb ? nb.mm_hr : 0;
  const wp = (warn && warn.length) ? warn[0] : null;
  const q = (qpf == null) ? null : +qpf;
  const raining = now >= 0.2;
  let verdict, sub, poss, tier;
  const W = t => TIER_WORD[Math.max(1, Math.min(5, t))];   // 強度詞（至少「雨」）

  if (raining) {
    if (now < 1 && trend !== "falling" && (plan3 >= 8 || wp)) {
      tier = tierOf(Math.max(plan3, q || 0)) || 4; poss = "中";
      verdict = "還好，但要注意";
      sub = wp ? `現在很小，但發布${wp}特報，恐轉${W(tier)}` : `現在很小，但預報轉${W(tier)}`;
    } else if (trend === "rising" || (q != null && q > now + 1)) {
      tier = tierOf(Math.max(now, q || now)); poss = "高";
      verdict = `正在下，還會更大`;
      sub = `雨勢增強中，逼近${W(tier)}${wp ? "（已發布" + wp + "特報）" : ""} · ${actionHint(tier, wp)}`;
    } else if (trend === "falling" && (q == null || q < now)) {
      tier = tierOf(now); poss = "高";
      verdict = `正在下${W(tier)}，快停了`; sub = "再等一下就趨緩，先別急著淋雨";
    } else {
      tier = tierOf(now); poss = "高";
      verdict = `正在下${W(tier)}`; sub = `${wp ? "留意" + wp + "特報 · " : ""}${actionHint(tier, wp)}`;
    }
  } else {
    if (q != null && q > 0) {
      tier = tierOf(q); poss = "高";
      verdict = tier >= 5 ? "馬上有豪雨" : tier >= 4 ? `等下會下${W(tier)}` : `等一下會下${W(tier)}`;
      sub = `約半小時內報到，會下一陣子 · ${actionHint(tier, wp)}`;
    } else if (plan3 > 0) {
      tier = tierOf(plan3); poss = wp ? "高" : "中";
      verdict = `稍後可能下${W(tier)}`;
      sub = (nb ? `預報 ${nb.from} 時前後` : "今日稍後") + `有${W(tier)}${wp ? "，已發布" + wp + "特報" : ""}`;
    } else if (wp) {
      tier = 3; poss = "中";
      verdict = "目前無雨，但要注意"; sub = `全區發布${wp}特報，留意天氣變化`;
    } else {
      tier = 0; poss = "低";
      verdict = "接下來不會下"; sub = "未來1小時無雨勢移入，放心出門";
    }
  }

  const ev = [now, q != null ? q : 0, plan3];
  const why = [`雨量站 ${now} mm`];
  if (trend === "rising") why.push("趨勢↑"); else if (trend === "falling") why.push("趨勢↓");
  if (q != null) why.push(`未來1時 QPF ${q} mm`);
  if (nb) why.push(`預報 ${nb.from}時${nb.pop ? " " + nb.pop + "%" : ""}`);
  if (wp) why.push(`⚠ ${wp}特報`);
  return { verdict, sub, possibility: poss, tier, trend, evidence: ev, why, warn: wp };
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
