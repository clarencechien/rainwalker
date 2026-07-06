import CONFIG from "./points.json";

const JSONH = { "content-type": "application/json; charset=utf-8" };
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: JSONH });

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      // 心跳：一進來就寫，證明 cron 有被觸發（診斷「資料卡住是 cron 沒跑還是跑掛」用，/health 讀）
      const t0 = Date.now(), fired = new Date().toISOString();
      let step = "start", err = null, shadowErr = null;
      try { await env.BUCKET.put("meta/cron.json", JSON.stringify({ fired_at: fired, step: "running" }), { httpMetadata: { contentType: "application/json" } }); } catch (e) {}
      try {
        step = "sources"; const src = await collectSources(env);   // 各上游每輪只抓一次、只 parse 一次
        step = "refresh"; await refresh(env, src);
        step = "shadow"; try { await shadowAppend(env, src); } catch (e) { shadowErr = String(e); /* 不擋主流程，但記進心跳 */ }
        const tw = new Date(Date.now() + 8 * 3600 * 1000);
        step = "report";
        try {
          if (tw.getUTCHours() === 3 && tw.getUTCMinutes() < 30) await weeklyReport(env);   // 03:00–03:2x 三次機會（冪等覆寫），單輪失敗不再整天沒報告
        } catch (e) {}
        step = "housekeep";
        try {
          if (tw.getUTCHours() === 3 && tw.getUTCMinutes() >= 30 && tw.getUTCMinutes() < 40) await housekeeping(env);   // 每天 03:3x 清 35 天前 shadow 日誌
        } catch (e) {}
        step = "done";
      } catch (e) { err = String(e); }
      // wall_ms=掛鐘時間（含等網路），非 CPU；Workers 凍結時鐘無法自量 CPU，CPU 用量只能看後台 Cron events/Metrics
      try { await env.BUCKET.put("meta/cron.json", JSON.stringify({ fired_at: fired, wall_ms: Date.now() - t0, step, err, shadow_err: shadowErr }), { httpMetadata: { contentType: "application/json" } }); } catch (e) {}
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

    // 健康檢查（常設診斷）：cron 心跳 + 各資料鮮度，一眼判斷「cron 沒跑」vs「跑了但掛在哪一步」
    if (url.pathname === "/health") {
      const rd = async k => { try { const o = await env.BUCKET.get(k); return o ? JSON.parse(await o.text()) : null; } catch (e) { return null; } };
      const cron = await rd("meta/cron.json");
      const data = await rd("data.json");
      const qpf = await rd("qpf.json");
      const now = Date.now();
      const cronAge = cron && cron.fired_at ? Math.round((now - Date.parse(cron.fired_at)) / 60000) : null;
      return json({
        now_tw: new Date(now + 8 * 3600 * 1000).toISOString().slice(0, 16).replace("T", " "),
        cron_last: cron,                       // fired_at/wall_ms/step/err；step!=done 或 err 有值＝跑了但掛在該步
                                               // wall_ms 是掛鐘時間（大多在等網路），與免費方案 10ms「CPU」上限無關
        cron_age_min: cronAge,                 // >15 分＝cron 沒在跑（排程是每 10 分）
        cron_ok: cronAge != null && cronAge <= 15,
        data_updated_local: data ? data.updated_local : null,
        data_source: data ? data._source : null,
        qpf_time: qpf ? qpf.datetime : null
      });
    }

    if (url.pathname === "/refresh") {
      try {
        const src = await collectSources(env);
        await refresh(env, src);
        let shadow;
        try { shadow = await shadowAppend(env, src); } catch (e) { shadow = { error: String(e) }; }
        return json({ ok: true, at: new Date().toISOString(), shadow });
      } catch (e) { return json({ ok: false, error: String(e) }, 500); }
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
        let nc = null;
        if (here) {
          nc = buildNowcast(here.mm_hr, here.r10, here.r1h, qv, plan, warnings[county], nowHr);
          nc.nb_hint = nearbyHint(here.mm_hr, qv,
            neighborMaxR10(stations, lat, lng, here.id, 10), qpfAt(qpf, lat, lng, 4.5));
        }
        return json({
          lat, lng, day_window: CONFIG.day_window || [6, 24], qpf_time: qpf ? qpf.datetime : null,
          here: here ? { name: here.name, mm_hr: here.mm_hr, county, qpf_1h: qv, nowcast: nc } : null,
          plan,
          nearby: sorted.slice(0, n).map(s => ({ name: s.name, area: s.county, mm_hr: s.mm_hr, dist_km: +s.dist.toFixed(2) }))
        });
      } catch (e) { return json({ error: String(e) }, 500); }
    }

    // Shadow log 探針（常設）：預設回最後 8 行；&slot=（前綴，如 2026070614）&pid= 可回溯任意時段做事後取證
    if (url.pathname === "/shadow/peek") {
      const day = url.searchParams.get("day") || "";
      if (day.length !== 8) return json({ error: "need day=YYYYMMDD" }, 400);
      const dp = `${day.slice(0,4)}/${day.slice(4,6)}/${day.slice(6,8)}`;
      const slotQ = url.searchParams.get("slot") || "", pidQ = url.searchParams.get("pid") || "";
      const n = (CONFIG.shadow_points || []).length || 8;
      async function rd(k) {
        try {
          const o = await env.BUCKET.get(k); if (!o) return { lines: 0 };
          const ls = (await o.text()).trim().split("\n").filter(Boolean).map(x => { try { return JSON.parse(x); } catch { return null; } }).filter(Boolean);
          const sel = (slotQ || pidQ)
            ? ls.filter(x => (!slotQ || String(x.slot).startsWith(slotQ)) && (!pidQ || x.pid === pidQ)).slice(-240)
            : ls.slice(-n);
          return { lines: ls.length, last: sel };
        } catch (e) { return { error: String(e) }; }
      }
      return json({ day, points: n, fc: await rd(`shadow/fc/${dp}.ndjson`), ob: await rd(`shadow/ob/${dp}.ndjson`) });
    }

    // 即時統計（不凍結，除錯用）：近 N 週
    if (url.pathname === "/stats") {
      const weeks = Math.min(8, +url.searchParams.get("weeks") || 1);
      const d = new Date(Date.now() + 8 * 3600 * 1000), z = n => String(n).padStart(2, "0"), days = [];
      for (let i = 0; i < weeks * 7; i++) { const x = new Date(d); x.setUTCDate(d.getUTCDate() - i); days.push(`${x.getUTCFullYear()}/${z(x.getUTCMonth()+1)}/${z(x.getUTCDate())}`); }
      return json(await computeStats(env, days));
    }
    // 校準表（Phase B）：近 N 週，QPF 分桶 → 實際下雨頻率
    if (url.pathname === "/shadow/calib") {
      const weeks = Math.min(8, +url.searchParams.get("weeks") || 4);
      const d = new Date(Date.now() + 8 * 3600 * 1000), z = n => String(n).padStart(2, "0"), days = [];
      for (let i = 0; i < weeks * 7; i++) { const x = new Date(d); x.setUTCDate(d.getUTCDate() - i); days.push(`${x.getUTCFullYear()}/${z(x.getUTCMonth()+1)}/${z(x.getUTCDate())}`); }
      return json({ weeks, table: await calibrationFromDays(env, days) });
    }
    // 生成+凍結週報（手動/補算）：?week=YYYY-Www，省略=當週
    if (url.pathname === "/shadow/gen") {
      return json(await weeklyReport(env, url.searchParams.get("week") || undefined));
    }
    // 讀當週凍結週報（app 用，不重算）
    if (url.pathname === "/shadow/latest") {
      const w = isoWeekOf(new Date(Date.now() + 8 * 3600 * 1000)), wk = `${w.year}-W${String(w.week).padStart(2, "0")}`;
      try { const o = await env.BUCKET.get(`shadow/report/${wk}.json`); if (o) return new Response(o.body, { headers: JSONH }); } catch (e) {}
      return json({ error: "no report yet", week: wk }, 404);
    }
    // 下載指定週凍結週報
    if (url.pathname === "/shadow/file") {
      const wk = url.searchParams.get("week"); if (!wk) return json({ error: "need week=YYYY-Www" }, 400);
      try { const o = await env.BUCKET.get(`shadow/report/${wk}.json`); if (o)
        return new Response(o.body, { headers: { ...JSONH, "content-disposition": `attachment; filename="rainwalker-${wk}.json"` } }); } catch (e) {}
      return json({ error: "not found", week: wk }, 404);
    }

    return env.ASSETS.fetch(request);
  }
};

// 每輪 cron 的共用來源：QPF/全站/預報/特報 各抓一次、各 parse 一次（免費方案 CPU 上限 10ms，重複 parse 會被砍）
async function collectSources(env) {
  let qpf = null;
  try { qpf = await refreshQpf(env); } catch (e) { try { qpf = await readQpf(env); } catch (e2) { qpf = null; } }
  let stations = [];
  try { stations = extractStations(await cwaFetch("O-A0002-001", env.CWA_KEY)); } catch (e) {}
  const fc = await forecastCached(env);
  let warnings = {};
  try { warnings = await fetchWarnings(env.CWA_KEY); } catch (e) {}
  return { qpf, stations, fc, warnings };
}
// F-D0047-089 為逐 3 小時預報，25 分內走 R2 快取（跨日失效），省掉每輪的大 JSON parse
async function forecastCached(env) {
  const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  try {
    const o = await env.BUCKET.get("fc_cache.json");
    if (o) { const c = JSON.parse(await o.text()); if (c.day === today && Date.now() - c.at < 25 * 60 * 1000) return c.fc; }
  } catch (e) {}
  try {
    const fc = await fetchForecastAll(env.CWA_KEY, CONFIG.day_window || [6, 24]);
    await env.BUCKET.put("fc_cache.json", JSON.stringify({ at: Date.now(), day: today, fc }), { httpMetadata: { contentType: "application/json" } });
    return fc;
  } catch (e) {
    try { const o = await env.BUCKET.get("fc_cache.json"); if (o) return JSON.parse(await o.text()).fc; } catch (e2) {}
    return {};
  }
}

async function refresh(env, src) {
  if (!src) src = await collectSources(env);
  const data = await buildData(env, src.qpf, src);
  await env.BUCKET.put("data.json", JSON.stringify(data), { httpMetadata: { contentType: "application/json" } });
}

async function buildData(env, qpf, src) {
  try { return await buildLive(env, qpf, src); }
  catch (e) { return { ...DEMO, _source: "demo-fallback: " + String(e) }; }
}

// ── 現況 + 預報 + QPF ───────────────────────────────────────────
async function buildLive(env, qpf, src) {
  if (qpf === undefined) qpf = src ? src.qpf : await readQpf(env);

  let stations = (src && src.stations && src.stations.length) ? src.stations : null;
  if (!stations) {
    const ids = CONFIG.points.map(p => p.station).filter(s => s && s !== "TODO");
    const params = (ids.length === CONFIG.points.length) ? { StationId: ids.join(",") } : {};
    stations = extractStations(await cwaFetch("O-A0002-001", env.CWA_KEY, { params }));
  }
  if (!stations.length) throw new Error("no stations parsed");
  const byId = Object.fromEntries(stations.map(s => [s.id, s]));
  const countyOf = Object.fromEntries(CONFIG.points.map(p => [p.id, p.county]));

  let fc = src ? src.fc : {};
  if (!src) { try { fc = await fetchForecastAll(env.CWA_KEY, CONFIG.day_window || [6, 24]); } catch (e) { fc = {}; } }
  const warnings = src ? src.warnings : await fetchWarnings(env.CWA_KEY);

  const d8 = new Date(Date.now() + 8 * 3600 * 1000);
  const nowHr = d8.getHours() + d8.getMinutes() / 60;

  const fullNet = stations.length > 50;   // 只有全站清單才算鄰站訊號（子集抓法算出來會失真）
  const points = CONFIG.points.map(p => {
    const st = (p.station && byId[p.station]) ? byId[p.station] : nearestStation(stations, p.lat, p.lng);
    const mm = st ? st.mm_hr : 0, qv = qpfAt(qpf, p.lat, p.lng), plan = fc[p.county] || [];
    const nc = buildNowcast(mm, st ? st.r10 : null, st ? st.r1h : null, qv, plan, warnings[p.county], nowHr);
    nc.nb_hint = nearbyHint(mm, qv,
      fullNet && st ? neighborMaxR10(stations, p.lat, p.lng, st.id, 10) : null,
      qpfAt(qpf, p.lat, p.lng, 4.5));
    return { id: p.id, name: p.name, area: p.area, lat: p.lat, lng: p.lng,
             mm_hr: mm, qpf_1h: qv, plan, nowcast: nc };
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
async function shadowAppend(env, src) {
  const pts = CONFIG.shadow_points || [];
  if (!pts.length) return;
  const { slot, datePath, ts, nowHr } = shadowSlot();
  const stations = (src && src.stations && src.stations.length)
    ? src.stations
    : extractStations(await cwaFetch("O-A0002-001", env.CWA_KEY));   // 全站，供 8 點綁最近站
  if (!stations.length) return;
  const qpf = src ? src.qpf : await readQpf(env);
  let fc = {}, warnings = {}, om = null;
  if (src) { fc = src.fc || {}; warnings = src.warnings || {}; }
  else {
    try { fc = await fetchForecastAll(env.CWA_KEY, CONFIG.day_window || [6, 24]); } catch (e) {}
    try { warnings = await fetchWarnings(env.CWA_KEY); } catch (e) {}
  }
  try { om = await fetchOpenMeteo(pts); } catch (e) { om = null; }   // 挑戰者純影子欄位，失敗不擋主流程
  const tsMin = parseLocalMin(ts);
  const fcLines = [], obLines = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const st = nearestStation(stations, p.lat, p.lng); if (!st) continue;
    const county = st.county, qv = qpfAt(qpf, p.lat, p.lng), plan = fc[county] || [];
    const nc = buildNowcast(st.mm_hr, st.r10, st.r1h, qv, plan, warnings[county], nowHr);
    const omv = omNext1h(om && om[i], tsMin);
    // 影子實驗欄位（不進 fusion）：qpf_w=寬半徑 QPF、nb_r10=10km 鄰站最大 10 分雨強
    const qw = qpfAt(qpf, p.lat, p.lng, 4.5);
    const nb = neighborMaxR10(stations, p.lat, p.lng, st.id, 10);
    fcLines.push({ slot, pid: p.id, ts, qpf: qv, qpf_w: qw, nb_r10: nb, tier: nc.tier, claim: nc.claim, tier3: nc.h3_tier,
      poss: nc.possibility, trend: nc.trend, verdict: nc.verdict, warn: nc.warn, plan3: nc.evidence[2],
      now_mm: st.mm_hr, om_mm: omv.om_mm, om_pop: omv.om_pop, station: st.id, county });
    obLines.push({ slot, pid: p.id, ts, p1h: st.r1h, p10: st.r10, valid: st.r1h != null });
  }
  await r2AppendLines(env, `shadow/fc/${datePath}.ndjson`, fcLines);
  await r2AppendLines(env, `shadow/ob/${datePath}.ndjson`, obLines);
  return { slot, wrote: fcLines.length, om: om ? "ok" : "none", bound: fcLines.map(l => `${l.pid}:${l.station}`) };
}

// ── Phase C 挑戰者：Open-Meteo（免費、無 key）── 純影子記錄，不進 fusion、不影響判語
async function fetchOpenMeteo(pts) {
  const lat = pts.map(p => p.lat).join(","), lon = pts.map(p => p.lng).join(",");
  const u = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&hourly=precipitation,precipitation_probability&forecast_hours=4&timezone=Asia%2FTaipei`;
  const r = await fetch(u, { headers: { accept: "application/json", "user-agent": "rainwalker" } });
  if (!r.ok) throw new Error(`open-meteo HTTP ${r.status}`);
  const j = await r.json();
  return Array.isArray(j) ? j : [j];
}
// "2026-07-05T14:00" → 掛鐘分鐘數（兩邊都用台灣本地時間，不做時區換算）
function parseLocalMin(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(s || "");
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) / 60000 : null;
}
// Open-Meteo hourly 值＝該時刻「往前 1 小時」累積 → 用重疊比例加權出 [T, T+60min) 的降水
function omNext1h(one, tsMin) {
  const H = one && one.hourly;
  if (!H || !H.time || tsMin == null) return { om_mm: null, om_pop: null };
  let mm = 0, got = false, pop = null;
  for (let i = 0; i < H.time.length; i++) {
    const e = parseLocalMin(H.time[i]);          // 該桶覆蓋 (e-60, e]
    if (e == null) continue;
    const ovl = Math.min(e, tsMin + 60) - Math.max(e - 60, tsMin);
    if (ovl <= 0) continue;
    const p = H.precipitation ? +H.precipitation[i] : NaN;
    if (isFinite(p)) { mm += p * ovl / 60; got = true; }
    const pr = H.precipitation_probability ? +H.precipitation_probability[i] : NaN;
    if (isFinite(pr)) pop = pop == null ? pr : Math.max(pop, pr);
  }
  return { om_mm: got ? +mm.toFixed(2) : null, om_pop: pop };
}

// ── 對答案 + 打分（join fc[T] ↔ ob[T+60min]）──────────────────
function tierMm(mm) { mm = +mm || 0; return mm < 0.2 ? 0 : mm < 1 ? 1 : mm < 4 ? 2 : mm < 10 ? 3 : mm < 30 ? 4 : 5; }
function slotPlus(slot, min) {
  const d = new Date(Date.UTC(+slot.slice(0,4), +slot.slice(4,6)-1, +slot.slice(6,8), +slot.slice(8,10), +slot.slice(10,12) + min));
  const z = n => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${z(d.getUTCMonth()+1)}${z(d.getUTCDate())}${z(d.getUTCHours())}${z(d.getUTCMinutes())}`;
}
async function loadNdjson(env, key) {
  try {
    const o = await env.BUCKET.get(key); if (!o) return [];
    return (await o.text()).trim().split("\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch (e) { return []; }
}
async function loadShadowDays(env, dayPaths) {
  const fc = [], ob = [];
  for (const dp of dayPaths) { fc.push(...await loadNdjson(env, `shadow/fc/${dp}.ndjson`)); ob.push(...await loadNdjson(env, `shadow/ob/${dp}.ndjson`)); }
  const obMap = new Map(); let maxSlot = "";
  for (const o of ob) { obMap.set(`${o.pid}|${o.slot}`, o); if (o.slot > maxSlot) maxSlot = o.slot; }
  return { fc, obMap, maxSlot };
}
// A3 打分視野分離：1h 主張對 ob[T+60]；3h 主張對 T+60/120/180 三筆的最大值（近似「3h 內是否下過」）
async function computeStats(env, dayPaths) {
  const { fc, obMap, maxSlot } = await loadShadowDays(env, dayPaths);
  const mkS = () => ({ expected: 0, settled: 0, gap: 0, invalid: 0, dirHit: 0, dirTot: 0, fa: 0, faDen: 0, ms: 0, msDen: 0 });
  const S1 = mkS(), S3 = mkS();
  const score = (S, pt, at) => {
    S.dirTot++; if (Math.abs(pt - at) <= 1) S.dirHit++;
    const pr = pt >= 2, ar = at >= 2;
    if (pr) { S.faDen++; if (!ar) S.fa++; } else { S.msDen++; if (ar) S.ms++; }
  };
  const poss = { "高": [0,0], "中": [0,0], "低": [0,0] }; const qr = [];
  const mkD = () => ({ acc: 0, fa: 0, faDen: 0, ms: 0, msDen: 0 });
  const duel = { n: 0, qpf: mkD(), om: mkD() };
  // 影子實驗②：鄰站領先訊號（本站乾時，nb_r10≥門檻 對 1h 後下雨的 precision/recall）
  const NB_TH = [0.5, 1, 2, 5];
  const nbs = { n: 0, rain: 0, th: NB_TH.map(t => ({ t, pred: 0, predRain: 0 })) };
  // 影子實驗③：QPF 取值半徑 窄(現行 1.5 格) vs 寬(4.5 格) 同筆對決
  const qra = { n: 0, narrow: mkD(), wide: mkD() };
  for (const f of fc) {
    const claim = f.claim === "3h" ? "3h" : "1h";   // 舊資料無 claim 欄位 → 視為 1h 相容
    const o1raw = obMap.get(`${f.pid}|${slotPlus(f.slot, 60)}`);
    const o1 = (o1raw && o1raw.valid && o1raw.p1h != null) ? o1raw : null;
    // 可能性三桶：可能性是 1h 語意，一律對 1h 實際
    if (o1 && poss[f.poss]) { poss[f.poss][1]++; if (tierMm(o1.p1h) >= 2) poss[f.poss][0]++; }
    if (o1 && (+f.now_mm || 0) < 0.2 && +f.qpf > 0) qr.push(o1.p1h / f.qpf);
    // 源對決（Phase C）：同點同 slot，CWA-QPF vs Open-Meteo 各對 1h 實際（下雨=p1h≥0.2）
    const mark = (d, v, ar) => {
      const pr = v >= 0.2;
      if (pr === ar) d.acc++;
      if (pr) { d.faDen++; if (!ar) d.fa++; } else { d.msDen++; if (ar) d.ms++; }
    };
    if (o1 && f.om_mm != null && f.qpf != null) {
      duel.n++;
      const ar = (+o1.p1h || 0) >= 0.2;
      mark(duel.qpf, +f.qpf, ar); mark(duel.om, +f.om_mm, ar);
    }
    // 影子實驗②③只看「本站當下乾」的筆（要驗的就是無雨→有雨的轉折）
    if (o1 && (+f.now_mm || 0) < 0.2) {
      const ar = (+o1.p1h || 0) >= 0.2;
      if (f.nb_r10 != null) {
        nbs.n++; if (ar) nbs.rain++;
        for (const b of nbs.th) if (+f.nb_r10 >= b.t) { b.pred++; if (ar) b.predRain++; }
      }
      if (f.qpf != null && f.qpf_w != null) {
        qra.n++;
        mark(qra.narrow, +f.qpf, ar); mark(qra.wide, +f.qpf_w, ar);
      }
    }
    if (claim === "1h") {
      const ans = slotPlus(f.slot, 60);
      if (ans > maxSlot) continue;               // 答案還沒到，不計入
      S1.expected++;
      const o = obMap.get(`${f.pid}|${ans}`);
      if (!o) { S1.gap++; continue; }
      if (!o.valid || o.p1h == null) { S1.invalid++; continue; }
      S1.settled++;
      score(S1, f.tier, tierMm(o.p1h));
    } else {
      // 3h 列的 h1 也是可證偽主張（「這 1 小時應不會下」）→ 一併記入 1h 帳，漏報才追得到責
      // （2026-07-06 中和 14:05 事件修正：漏報當時不進 1h 帳＝考卷漏題）
      const ans1 = slotPlus(f.slot, 60);
      if (ans1 <= maxSlot) {
        S1.expected++;
        const o = obMap.get(`${f.pid}|${ans1}`);
        if (!o) S1.gap++;
        else if (!o.valid || o.p1h == null) S1.invalid++;
        else { S1.settled++; score(S1, f.tier, tierMm(o.p1h)); }
      }
      if (slotPlus(f.slot, 180) > maxSlot) continue;
      S3.expected++;
      const os = [60, 120, 180].map(m => obMap.get(`${f.pid}|${slotPlus(f.slot, m)}`));
      if (os.every(o => !o)) { S3.gap++; continue; }
      const vals = os.filter(o => o && o.valid && o.p1h != null).map(o => +o.p1h || 0);
      if (!vals.length) { S3.invalid++; continue; }
      S3.settled++;
      score(S3, f.tier3 != null ? f.tier3 : f.tier, tierMm(Math.max(...vals)));
    }
  }
  const med = a => { if (!a.length) return null; const x = [...a].sort((m,n)=>m-n), k = x.length >> 1; return x.length % 2 ? x[k] : (x[k-1]+x[k]) / 2; };
  const r2 = v => v == null ? null : +v.toFixed(2);
  const rate = ab => ab[1] ? r2(ab[0]/ab[1]) : null;
  const covOf = S => ({ expected: S.expected, settled: S.settled, missing: S.expected - S.settled, reasons: { cron_gap: S.gap, cwa_no_value: S.invalid } });
  const scoresOf = S => ({
    direction_hit: S.dirTot ? r2(S.dirHit/S.dirTot) : null,
    false_alarm: S.faDen ? r2(S.fa/S.faDen) : null,
    miss: S.msDen ? r2(S.ms/S.msDen) : null
  });
  const duelOf = (d, n) => ({ accuracy: n ? r2(d.acc/n) : null,
    false_alarm: d.faDen ? r2(d.fa/d.faDen) : null, miss: d.msDen ? r2(d.ms/d.msDen) : null });
  const scores_1h = { ...scoresOf(S1), qpf_bias_median: r2(med(qr)),
    possibility: { "高": rate(poss["高"]), "中": rate(poss["中"]), "低": rate(poss["低"]) } };
  return {
    coverage: covOf(S1), coverage_3h: covOf(S3),
    scores_1h, scores_3h: scoresOf(S3),
    scores: scores_1h,   // 舊欄位相容（= scores_1h）
    source_duel: duel.n ? { samples: duel.n, qpf: duelOf(duel.qpf, duel.n), open_meteo: duelOf(duel.om, duel.n) } : null,
    // 影子實驗②：乾→雨轉折上，鄰站訊號有多少預測力（precision=喊了多準、recall=漏報接住多少）
    neighbor_signal: nbs.n ? { samples: nbs.n, base_rate: r2(nbs.rain / nbs.n),
      thresholds: nbs.th.map(b => ({ th: b.t, n: b.pred,
        precision: b.pred ? r2(b.predRain / b.pred) : null,
        recall: nbs.rain ? r2(b.predRain / nbs.rain) : null })) } : null,
    // 影子實驗③：QPF 窄/寬半徑誰的誤報/漏報曲線好
    qpf_radius: qra.n ? { samples: qra.n, narrow: duelOf(qra.narrow, qra.n), wide: duelOf(qra.wide, qra.n) } : null
  };
}
// ── Phase B 校準表：預報當下無雨的筆，按 QPF 分桶算實際下雨頻率（查表，不做 ML）──
const CALIB_EDGES = [0.5, 1, 2, 5, 10, 20];
function calibBucket(q) {
  if (!(q > 0)) return "0";
  let lo = 0;
  for (const e of CALIB_EDGES) { if (q <= e) return `${lo}-${e}`; lo = e; }
  return "20+";
}
async function calibrationFromDays(env, dayPaths) {
  const { fc, obMap } = await loadShadowDays(env, dayPaths);
  const acc = {};
  for (const f of fc) {
    if (f.qpf == null || (+f.now_mm || 0) >= 0.2) continue;
    const o = obMap.get(`${f.pid}|${slotPlus(f.slot, 60)}`);
    if (!o || !o.valid || o.p1h == null) continue;
    const b = calibBucket(+f.qpf);
    const a = acc[b] || (acc[b] = { n: 0, r02: 0, r1: 0 });
    a.n++; if (+o.p1h >= 0.2) a.r02++; if (+o.p1h >= 1) a.r1++;
  }
  const order = ["0", "0-0.5", "0.5-1", "1-2", "2-5", "5-10", "10-20", "20+"];
  return order.filter(b => acc[b]).map(b => ({ bucket: b, n: acc[b].n,
    rain02: +(acc[b].r02 / acc[b].n).toFixed(2), rain1: +(acc[b].r1 / acc[b].n).toFixed(2) }));
}
// 對外口徑（§8.1）：定性為主、漏報露出、不丟裸 %
function publicView(st) {
  const s = st.scores, cov = st.coverage;
  if (cov.settled < 20) return { verdict: "資料不足", hit_phrase: "—", miss_phrase: "—", note: "本週樣本太少，僅供參考", settled: cov.settled };
  const hit = s.direction_hit, miss = s.miss;
  return {
    verdict: hit == null ? "資料不足" : hit >= 0.7 ? "大致可靠" : hit >= 0.5 ? "普通" : "偏弱",
    hit_phrase: hit == null ? "—" : `約 ${Math.round(hit*10)} 成`,
    miss_phrase: miss == null ? "—" : miss <= 0.05 ? "極少漏報" : miss <= 0.15 ? "偶有漏報" : "漏報偏多",
    note: "", settled: cov.settled
  };
}
function suggestions(st) {
  const out = [], q = st.scores.qpf_bias_median, m = st.scores.miss, P = st.scores.possibility;
  // A4：qpf 係數下限 clamp（min 0.3）；比值≈0 不再輸出「×0.00」
  if (q != null && q < 0.05) out.push("QPF 本週近乎全空報（實測/預報比值 ≈ 0）→ 建議檢視 QPF 觸發閾值與格點對位（待人工批准）");
  else if (q != null && q < 0.8) out.push(`QPF 中位高估 ${Math.round((1-q)*100)}% → 建議 tier 門檻 ×${Math.max(0.3, q).toFixed(2)}（待人工批准）`);
  if (q != null && q > 1.25) out.push(`QPF 中位低估 ${Math.round((q-1)*100)}% → 建議 tier 門檻 ×${q.toFixed(2)}（待人工批准）`);
  if (m != null && m > 0.15) out.push(`漏報率 ${Math.round(m*100)}% 偏高 → 考慮放寬「有雨」判定或調高可能性靈敏度`);
  if (P["高"] != null && P["中"] != null && Math.abs(P["高"]-P["中"]) < 0.1) out.push("可能性「高」「中」實際下雨率接近 → 區分力不足，考慮重定義");
  return out;
}
// ISO 週 / 該週 7 天路徑
function isoWeekOf(d) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = (t.getUTCDay() + 6) % 7; t.setUTCDate(t.getUTCDate() - day + 3);
  const firstThu = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
  const fday = (firstThu.getUTCDay() + 6) % 7; firstThu.setUTCDate(firstThu.getUTCDate() - fday + 3);
  return { year: t.getUTCFullYear(), week: 1 + Math.round((t - firstThu) / (7 * 864e5)) };
}
function weekDayPaths(year, week, backWeeks = 0) {   // backWeeks>0：往前多含 N 週（給校準表拉長樣本）
  const jan4 = new Date(Date.UTC(year, 0, 4)); const j = (jan4.getUTCDay() + 6) % 7;
  const mon = new Date(jan4); mon.setUTCDate(jan4.getUTCDate() - j + (week - 1) * 7 - backWeeks * 7);
  const z = n => String(n).padStart(2, "0"); const out = [];
  for (let i = 0; i < 7 * (backWeeks + 1); i++) { const d = new Date(mon); d.setUTCDate(mon.getUTCDate() + i);
    out.push(`${d.getUTCFullYear()}/${z(d.getUTCMonth()+1)}/${z(d.getUTCDate())}`); }
  return out;
}
async function weeklyReport(env, weekStr) {
  let year, week;
  if (weekStr) { const m = /^(\d{4})-W(\d{2})$/.exec(weekStr); if (!m) return { error: "week format YYYY-Www" }; year = +m[1]; week = +m[2]; }
  else { const w = isoWeekOf(new Date(Date.now() + 8 * 3600 * 1000)); year = w.year; week = w.week; }
  const wk = `${year}-W${String(week).padStart(2, "0")}`;
  const st = await computeStats(env, weekDayPaths(year, week));
  let calibration = [];
  try { calibration = await calibrationFromDays(env, weekDayPaths(year, week, 3)); } catch (e) {}   // 近 4 週樣本
  const st1 = { coverage: st.coverage, scores: st.scores_1h };   // public/suggestions 以 1h 為主口徑
  const report = {
    week: wk, generated: new Date(Date.now() + 8 * 3600 * 1000).toISOString().replace("Z", "+08:00"),
    coverage: st.coverage, coverage_3h: st.coverage_3h,
    scores: st.scores_1h, scores_1h: st.scores_1h, scores_3h: st.scores_3h,
    source_duel: st.source_duel, neighbor_signal: st.neighbor_signal, qpf_radius: st.qpf_radius, calibration,
    suggestions: suggestions(st1),
    "public": publicView(st1), points: (CONFIG.shadow_points || []).map(p => p.id)
  };
  await env.BUCKET.put(`shadow/report/${wk}.json`, JSON.stringify(report), { httpMetadata: { contentType: "application/json" } });
  return report;
}

async function refreshQpf(env) {
  const key = (env.CWA_KEY || "").trim();
  const txt = await (await fetch(`https://opendata.cwa.gov.tw/fileapi/v1/opendataapi/F-B0046-001?Authorization=${key}&format=JSON`,
    { headers: { accept: "*/*", "user-agent": "rainwalker" } })).text();
  const p = parseQpfRaw(txt);
  const box = CONFIG.qpf_box || { lon: [119.8, 122.1], lat: [21.8, 25.4] };
  const cells = extractQpfBox(p.body, p.lon0, p.lat0, p.res, p.NX, p.NY, box);
  const out = { datetime: p.datetime, res: p.res, box, cells };
  await env.BUCKET.put("qpf.json", JSON.stringify(out), { httpMetadata: { contentType: "application/json" } });
  return out;
}
// CPU 瘦身：2.66MB 檔不做整包 JSON.parse——metadata 用 regex 撈頭部、content 用 indexOf 定位抽字串；
// 格式對不上時退回完整 JSON.parse（貴但保命）
function parseQpfRaw(txt) {
  try {
    const head = txt.slice(0, 6000);
    const num = k => { const m = new RegExp('"' + k + '"\\s*:\\s*"?(-?[\\d.]+)"?').exec(head); return m ? +m[1] : NaN; };
    const lon0 = num("StartPointLongitude"), lat0 = num("StartPointLatitude"), res = num("GridResolution");
    const NX = num("GridDimensionX"), NY = num("GridDimensionY");
    const dm = /"DateTime"\s*:\s*"([^"]+)"/.exec(head);
    const ci = txt.indexOf('"content"');
    if (ci >= 0 && [lon0, lat0, res, NX, NY].every(isFinite)) {
      let q = txt.indexOf(":", ci + 9) + 1;
      while (q < txt.length && (txt[q] === " " || txt[q] === "\n" || txt[q] === "\r" || txt[q] === "\t")) q++;
      if (txt[q] === '"') {
        const q2 = txt.indexOf('"', q + 1);
        if (q2 > q) return { lon0, lat0, res, NX, NY, datetime: dm ? dm[1] : null, body: txt.slice(q + 1, q2) };
      }
    }
  } catch (e) {}
  const raw = JSON.parse(txt);
  const inf = raw.cwaopendata.dataset.datasetInfo.parameterSet;
  let body = raw.cwaopendata.dataset.contents.content;
  if (typeof body !== "string") body = body["#text"] || body._ || "";
  return { lon0: +inf.StartPointLongitude, lat0: +inf.StartPointLatitude, res: +inf.GridResolution,
           NX: +inf.GridDimensionX, NY: +inf.GridDimensionY, datetime: inf.DateTime, body };
}
// 不 split 整串 24.7 萬值：先跳到 box 起始列，再逐值掃到 box 結束列（值序 k=iy*NX+ix，南起）
function extractQpfBox(body, lon0, lat0, res, NX, NY, box) {
  const ix0 = Math.max(0, Math.floor((box.lon[0] - lon0) / res)), ix1 = Math.min(NX - 1, Math.ceil((box.lon[1] - lon0) / res));
  const iy0 = Math.max(0, Math.floor((box.lat[0] - lat0) / res)), iy1 = Math.min(NY - 1, Math.ceil((box.lat[1] - lat0) / res));
  const cells = [];
  const kStart = iy0 * NX, kEnd = (iy1 + 1) * NX;
  let pos = 0, k = 0;
  while (k < kStart) { const c = body.indexOf(",", pos); if (c < 0) return cells; pos = c + 1; k++; }
  while (k < kEnd && pos <= body.length) {
    let e = body.indexOf(",", pos); if (e < 0) e = body.length;
    const ix = k % NX;
    if (ix >= ix0 && ix <= ix1) {
      const v = +body.slice(pos, e);
      if (v > 0) { const iy = (k / NX) | 0; cells.push({ lat: +(lat0 + iy * res).toFixed(4), lng: +(lon0 + ix * res).toFixed(4), mm: v }); }
    }
    pos = e + 1; k++;
  }
  return cells;
}
// QPF 是「未來 1 小時」產品：太舊（>70 分）等於沒有，回 null 讓 fusion 走無 QPF 路徑，
// 避免上游斷線時拿三小時前的雨帶冒充「等一下會下」
const QPF_MAX_AGE_MIN = 70;
function qpfIsFresh(q, nowMs) {
  if (!q || !q.datetime) return false;
  const t = Date.parse(q.datetime);
  return isFinite(t) && nowMs - t <= QPF_MAX_AGE_MIN * 60000;
}
async function readQpf(env) {
  try {
    const o = await env.BUCKET.get("qpf.json");
    if (!o) return null;
    const q = JSON.parse(await o.text());
    return qpfIsFresh(q, Date.now()) ? q : null;
  }
  catch (e) { return null; }
}
// housekeeping（spec §housekeeping）：刪 35 天前的 shadow 日誌（fc/ob），週報 shadow/report/ 永久保留。
// 35 天 = 校準表 4 週窗 + 一週緩衝。
async function housekeeping(env) {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  d.setUTCDate(d.getUTCDate() - 35);
  const z = n => String(n).padStart(2, "0");
  const cut = `${d.getUTCFullYear()}${z(d.getUTCMonth() + 1)}${z(d.getUTCDate())}`;
  let deleted = 0;
  for (const prefix of ["shadow/fc/", "shadow/ob/"]) {
    let cursor;
    do {
      const l = await env.BUCKET.list({ prefix, cursor, limit: 500 });
      for (const o of l.objects || []) {
        const m = /(\d{4})\/(\d{2})\/(\d{2})\.ndjson$/.exec(o.key);
        if (m && `${m[1]}${m[2]}${m[3]}` < cut) { await env.BUCKET.delete(o.key); deleted++; }
      }
      cursor = l.truncated ? l.cursor : undefined;
    } while (cursor);
  }
  return { cut, deleted };
}
// 取某點未來1小時 QPF（mm）：取附近 gridFactor 格內最大雨格；qpf 載入但附近無雨格回 0；未載入回 null
// gridFactor 預設 1.5（≈2km，現行 fusion 用）；影子實驗另以 4.5（≈6km）記 qpf_w，容忍雷達格點位移誤差
function qpfAt(qpf, lat, lng, gridFactor = 1.5) {
  if (!qpf || !qpf.cells) return null;
  const r = (qpf.res || 0.0125) * gridFactor;
  let best = 0;
  for (const c of qpf.cells) {
    if (Math.abs(c.lat - lat) <= r && Math.abs(c.lng - lng) <= r && c.mm > best) best = c.mm;
  }
  return best;
}
// 鄰站領先訊號（影子實驗）：radiusKm 內（排除本站）r10 最大值；雨帶移入時鄰站先跳
// 回 null=範圍內無有效 r10；回 0=鄰站全乾
function neighborMaxR10(stations, lat, lng, excludeId, radiusKm = 10) {
  let best = null;
  for (const s of stations) {
    if (s.id === excludeId || s.r10 == null) continue;
    if (haversine(lat, lng, s.lat, s.lng) > radiusKm) continue;
    if (best == null || s.r10 > best) best = s.r10;
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
// A2 可能性 gating 門檻（人工調參區；依 spec §6 絕不自動改）
const GATE = { Q_HI: 1, PLAN_HEAVY: 8 };
// 鄰區提示層（2026-07-06 中和案例後新增）：純提示、不動主判語/tier/可能性/shadow 帳本，
// 影子實驗 A/B 不受污染；四週後 neighbor_signal/qpf_radius 數據好→升級進 gating、爛→下架。門檻人工調。
const NEAR = { NB_R10: 2, QPF_W: 1 };
function nearbyHint(now, q, nb, qw) {
  if ((+now || 0) >= 0.2) return null;                 // 已在下，主判語自己會講
  if (q != null && q > 0) return null;                 // 主判語已喊「等一下會下」
  if (nb != null && nb >= NEAR.NB_R10) return `鄰區正在下雨（10 公里內約 ${Math.round(nb)} mm/h），可能移入`;
  if (qw != null && qw >= NEAR.QPF_W) return `雷達顯示附近有雨胞（約 ${Math.round(qw)} mm），留意移入`;
  return null;
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
  const W = t => TIER_WORD[Math.max(1, Math.min(5, t))];   // 強度詞（至少「雨」）

  // h3（稍後提示）：縣市 plan3 + 特報（縣市級、長視野）→ 只做副提示，不主導主判語、不抬可能性
  let h3_tier = null, h3_hint = null;
  if (nb) {
    h3_tier = tierOf(plan3) || 1;
    h3_hint = `稍後 ${nb.from} 時前後全區可能有${W(h3_tier)}${wp ? "（" + wp + "特報生效中）" : ""}`;
  } else if (wp) {
    h3_tier = 3;
    h3_hint = `${wp}特報生效中，稍後留意天氣變化`;
  }

  // h1（1 小時主張）：只由 1h 內實證驅動＝現況 mm、趨勢 r10/r1h、QPF。主判語從這層出。
  let verdict, sub, poss, tier, claim = "1h";
  if (raining) {
    if (trend === "rising" || (q != null && q > now + 1)) {
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
  } else if (q != null && q > 0) {
    // 可能性 gating：「高」必須 QPF≥門檻，或趨勢 rising 且地面已有雨跡
    tier = tierOf(q);
    poss = (q >= GATE.Q_HI || (trend === "rising" && now > 0)) ? "高" : "中";
    verdict = tier >= 5 ? "馬上有豪雨" : tier >= 4 ? `等下會下${W(tier)}` : `等一下會下${W(tier)}`;
    sub = `雷達估計約 1 小時內報到 · ${actionHint(tier, wp)}`;
  } else if (h3_tier != null) {
    // 1h 內無實證、只有縣市級長視野訊號：主判語誠實說「這 1 小時不會下」，稍後資訊放 h3_hint
    tier = 0; claim = "3h";
    poss = (plan3 >= GATE.PLAN_HEAVY || wp) ? "中" : "低";   // 特報/plan3 單獨在場：最多「中」
    verdict = "這 1 小時應不會下";
    sub = "未來 1 小時無雨勢移入，出門 OK，稍後再留意";
  } else {
    tier = 0; poss = "低";
    verdict = "接下來不會下"; sub = "未來1小時無雨勢移入，放心出門";
  }

  const ev = [now, q != null ? q : 0, plan3];
  const why = [`雨量站 ${now} mm`];
  if (trend === "rising") why.push("趨勢↑"); else if (trend === "falling") why.push("趨勢↓");
  if (q != null) why.push(`未來1時 QPF ${q} mm`);
  if (nb) why.push(`預報 ${nb.from}時${nb.pop ? " " + nb.pop + "%" : ""}`);
  if (wp) why.push(`⚠ ${wp}特報`);
  return { verdict, sub, possibility: poss, tier, trend, evidence: ev, why, warn: wp,
           h3_hint, h3_tier, claim };
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
