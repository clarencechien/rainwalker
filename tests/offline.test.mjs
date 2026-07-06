// 離線合成案例測試（不打任何外部 API、不碰 R2）
// 跑法：node tests/offline.test.mjs
// 涵蓋：雙 horizon fusion / 可能性 gating / 打分視野分離 / 跨日 slot / 校準分桶
//       / suggestion clamp / Open-Meteo 1h 加權 / W27 情境回測（舊 vs 新）
import fs from "node:fs";

// ── 載入 worker（換掉 JSON import、補上測試用 export）──────────
const src = fs.readFileSync(new URL("../src/index.js", import.meta.url), "utf8");
const cfg = fs.readFileSync(new URL("../src/points.json", import.meta.url), "utf8");
const body = src.replace(/^import CONFIG.*$/m, `const CONFIG=${cfg};`) +
  "\nexport { buildNowcast, computeStats, calibrationFromDays, calibBucket, slotPlus, suggestions, omNext1h, parseLocalMin, weekDayPaths, tierMm, qpfAt, neighborMaxR10, parseQpfRaw, extractQpfBox, qpfIsFresh, housekeeping, nearbyHint, omHint };\n";
const W = await import("data:text/javascript;base64," + Buffer.from(body).toString("base64"));

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}${extra !== undefined ? " → 實際: " + JSON.stringify(extra) : ""}`); }
}
const ndjson = rows => rows.map(r => JSON.stringify(r)).join("\n") + "\n";
const fakeEnv = files => ({ BUCKET: { get: async k => files[k] == null ? null : { text: async () => files[k] } } });

// ── 1. buildNowcast：雙 horizon + 可能性 gating ────────────────
console.log("\n[1] buildNowcast 雙 horizon / gating");
{
  const plan8 = [{ from: 15, to: 18, pop: 80, mm_hr: 8 }];
  // W27 病灶情境：無雨、無 QPF、縣市 plan3=8 + 特報 → 主判語必須是 1h 誠實句，不再喊「稍後可能下」當主張
  let n = W.buildNowcast(0, 0, 0, null, plan8, ["豪雨"], 12);
  ok(n.tier === 0, "plan3+特報：h1 tier=0（不被長視野抬高）", n.tier);
  ok(n.claim === "3h", "plan3+特報：claim=3h", n.claim);
  ok(n.possibility === "中", "plan3+特報：可能性最多「中」（gating）", n.possibility);
  ok(!!n.h3_hint && /稍後/.test(n.h3_hint), "plan3+特報：h3_hint 帶「稍後」", n.h3_hint);
  ok(n.h3_tier === 3, "plan3=8 → h3_tier=3", n.h3_tier);
  ok(/不會下/.test(n.verdict), "主判語為 1h 口徑", n.verdict);

  // 輕 plan3、無特報 → 低
  n = W.buildNowcast(0, 0, 0, null, [{ from: 15, to: 18, pop: 40, mm_hr: 2 }], null, 12);
  ok(n.possibility === "低" && n.claim === "3h", "輕 plan3 無特報：可能性=低", n.possibility);

  // QPF 驅動：q=5 ≥ 門檻 → 高；q=0.5 → 中
  n = W.buildNowcast(0, 0, 0, 5, [], null, 12);
  ok(n.tier === 3 && n.possibility === "高" && n.claim === "1h", "QPF=5：tier3/高/claim=1h", [n.tier, n.possibility, n.claim]);
  n = W.buildNowcast(0, 0, 0, 0.5, [], null, 12);
  ok(n.possibility === "中", "QPF=0.5（低於門檻）：可能性=中", n.possibility);
  // rising + 地面有雨跡 + 小 QPF → 高
  n = W.buildNowcast(0.1, 1, 0.1, 0.5, [], null, 12);
  ok(n.trend === "rising" && n.possibility === "高", "rising+now>0+小QPF：可能性=高", [n.trend, n.possibility]);

  // 正在下：poss=高、tier 只由 1h 實證決定（不被 plan3 抬）
  n = W.buildNowcast(3, 3, 3, null, plan8, ["豪雨"], 12);
  ok(n.tier === 2 && n.possibility === "高", "正在下 3mm+plan8：tier=2（不抬）", n.tier);
  ok(!!n.h3_hint, "正在下時 h3_hint 仍提示稍後", n.h3_hint);

  // 什麼都沒有 → 低、無 h3
  n = W.buildNowcast(0, 0, 0, null, [], null, 12);
  ok(n.possibility === "低" && n.tier === 0 && n.h3_hint == null && n.claim === "1h", "全無訊號：低/tier0/無h3", n);

  // 特報單獨在場 → claim 3h、可能性中、h3_tier=3
  n = W.buildNowcast(0, 0, 0, null, [], ["大雨"], 12);
  ok(n.claim === "3h" && n.possibility === "中" && n.h3_tier === 3 && /特報/.test(n.h3_hint), "特報單獨：3h/中/hint 帶特報", n);

  // 相容性：既有欄位都在
  for (const k of ["verdict", "sub", "possibility", "tier", "trend", "evidence", "why", "warn"])
    ok(k in n, `相容欄位存在：${k}`);
}

// ── 2. slotPlus 跨日/跨月/跨年 ────────────────────────────────
console.log("\n[2] slotPlus 邊界");
{
  ok(W.slotPlus("202607052350", 60) === "202607060050", "跨日", W.slotPlus("202607052350", 60));
  ok(W.slotPlus("202606302330", 60) === "202607010030", "跨月", W.slotPlus("202606302330", 60));
  ok(W.slotPlus("202512312320", 60) === "202601010020", "跨年", W.slotPlus("202512312320", 60));
  ok(W.slotPlus("202607051000", 180) === "202607051300", "+180", W.slotPlus("202607051000", 180));
}

// ── 3. computeStats：1h/3h 視野分離 + 源對決 + 可能性桶 ────────
console.log("\n[3] computeStats 視野分離");
{
  const fcRows = [
    // 1h 命中（有 om：QPF 對、OM 漏）
    { slot: "202607011000", pid: "A", tier: 2, claim: "1h", poss: "高", qpf: 2, om_mm: 0, now_mm: 0 },
    // 1h 誤報（有 om：QPF 錯、OM 對）
    { slot: "202607011000", pid: "B", tier: 3, claim: "1h", poss: "高", qpf: 3, om_mm: 0, now_mm: 0 },
    // 1h 漏報
    { slot: "202607011000", pid: "C", tier: 0, claim: "1h", poss: "低", qpf: null, now_mm: 0 },
    // 舊資料（無 claim 欄位）→ 視為 1h
    { slot: "202607011000", pid: "D", tier: 2, poss: "中", qpf: null, now_mm: 3 },
    // 3h 主張：+2h 才下 → 3h 口徑命中；1h 口徑不再揹這筆
    { slot: "202607011000", pid: "E", tier: 0, claim: "3h", tier3: 3, poss: "中", qpf: null, now_mm: 0 },
    // 答案未到：1h（ans 1500 > maxSlot 1300）與 3h（ans 1500 > maxSlot）都不計
    { slot: "202607011400", pid: "A", tier: 2, claim: "1h", poss: "高", qpf: 1, now_mm: 0 },
    { slot: "202607011200", pid: "E", tier: 0, claim: "3h", tier3: 2, poss: "低", qpf: null, now_mm: 0 },
  ];
  const obRows = [
    { slot: "202607011100", pid: "A", p1h: 2, valid: true },
    { slot: "202607011100", pid: "B", p1h: 0, valid: true },
    { slot: "202607011100", pid: "C", p1h: 5, valid: true },
    { slot: "202607011100", pid: "D", p1h: 1.5, valid: true },
    { slot: "202607011100", pid: "E", p1h: 0, valid: true },
    { slot: "202607011200", pid: "E", p1h: 6, valid: true },
    { slot: "202607011300", pid: "E", p1h: 0, valid: true },
  ];
  const env = fakeEnv({ "shadow/fc/2026/07/01.ndjson": ndjson(fcRows), "shadow/ob/2026/07/01.ndjson": ndjson(obRows) });
  const st = await W.computeStats(env, ["2026/07/01"]);
  // 3h 列（E1@1000、E2@1200）的 h1 斷言（tier0）也記入 1h 帳（07-06 事件修正）：
  // A hit、B fa、C miss、D hit、E1 hit(0vs0)、E2 hit(0vs0) → expected 6
  ok(st.coverage.expected === 6 && st.coverage.settled === 6, "1h coverage：6 筆（含 3h 列的 h1 斷言）", st.coverage);
  ok(st.coverage_3h.expected === 1 && st.coverage_3h.settled === 1, "3h coverage：1 筆", st.coverage_3h);
  ok(st.scores_1h.direction_hit === 0.67, "1h 方向命中 4/6", st.scores_1h.direction_hit);
  ok(st.scores_1h.false_alarm === 0.33, "1h 誤報 1/3", st.scores_1h.false_alarm);
  ok(st.scores_1h.miss === 0.33, "1h 漏報 1/3（C 漏；E1/E2 沒喊也沒下）", st.scores_1h.miss);
  ok(st.scores_3h.direction_hit === 1 && st.scores_3h.false_alarm === 0, "3h 主張對 3 筆 max 命中", st.scores_3h);
  ok(st.scores.direction_hit === st.scores_1h.direction_hit, "scores 舊欄位=scores_1h（相容）");
  // 可能性桶（對 1h 實際）：高=A(下),B(沒下)→0.5；中=D(下),E(+60沒下)→0.5；低=C(下)→1
  ok(st.scores_1h.possibility["高"] === 0.5, "可能性高桶 0.5", st.scores_1h.possibility);
  ok(st.scores_1h.possibility["中"] === 0.5, "可能性中桶 0.5", st.scores_1h.possibility);
  // 低=C(下)+尾筆E(其+60 ob 存在、沒下；可能性是 1h 語意，不受 3h 答案未到影響)→ 0.5
  ok(st.scores_1h.possibility["低"] === 0.5, "可能性低桶 0.5", st.scores_1h.possibility);
  // QPF 比值：A(2→2)=1、B(3→0)=0 → 中位 0.5
  ok(st.scores_1h.qpf_bias_median === 0.5, "qpf_bias 中位 0.5", st.scores_1h.qpf_bias_median);
  // 源對決：A、B 兩筆
  ok(st.source_duel && st.source_duel.samples === 2, "源對決樣本 2", st.source_duel);
  ok(st.source_duel.qpf.accuracy === 0.5 && st.source_duel.open_meteo.accuracy === 0.5, "兩源各對一半", st.source_duel);
  ok(st.source_duel.open_meteo.miss === 0.5, "OM 漏報 1/2", st.source_duel.open_meteo);
  ok(st.source_duel.qpf.false_alarm === 0.5, "QPF 誤報 1/2", st.source_duel.qpf);
}

// ── 4. 校準表分桶 ─────────────────────────────────────────────
console.log("\n[4] calibration 分桶");
{
  ok(W.calibBucket(0) === "0" && W.calibBucket(0.3) === "0-0.5" && W.calibBucket(0.5) === "0-0.5"
     && W.calibBucket(3) === "2-5" && W.calibBucket(25) === "20+", "桶界");
  const fcRows = [], obRows = [];
  const add = (pid, qpf, p1h) => {
    fcRows.push({ slot: "202607011000", pid, tier: 0, qpf, now_mm: 0 });
    obRows.push({ slot: "202607011100", pid, p1h, valid: true });
  };
  add("a", 0, 0); add("b", 0, 1.5); add("c", 0.3, 0); add("d", 3, 0.5); add("e", 3, 2); add("f", 25, 30);
  add("g", null, 5);          // qpf null → 不進表
  fcRows.push({ slot: "202607011000", pid: "h", tier: 2, qpf: 5, now_mm: 4 });  // 當下有雨 → 不進表
  obRows.push({ slot: "202607011100", pid: "h", p1h: 5, valid: true });
  const env = fakeEnv({ "shadow/fc/2026/07/01.ndjson": ndjson(fcRows), "shadow/ob/2026/07/01.ndjson": ndjson(obRows) });
  const tab = await W.calibrationFromDays(env, ["2026/07/01"]);
  const by = Object.fromEntries(tab.map(r => [r.bucket, r]));
  ok(by["0"] && by["0"].n === 2 && by["0"].rain02 === 0.5 && by["0"].rain1 === 0.5, "桶0：n2 rain02 .5", by["0"]);
  ok(by["0-0.5"] && by["0-0.5"].n === 1 && by["0-0.5"].rain02 === 0, "桶0-0.5", by["0-0.5"]);
  ok(by["2-5"] && by["2-5"].n === 2 && by["2-5"].rain02 === 1 && by["2-5"].rain1 === 0.5, "桶2-5", by["2-5"]);
  ok(by["20+"] && by["20+"].n === 1 && by["20+"].rain1 === 1, "桶20+", by["20+"]);
  ok(!("undefined" in by) && tab.length === 4, "無雜桶、qpf null/當下有雨不進表", tab);
}

// ── 5. suggestion clamp ──────────────────────────────────────
console.log("\n[5] suggestion formatter clamp");
{
  const mk = q => W.suggestions({ scores: { qpf_bias_median: q, miss: 0, possibility: { "高": 0.5, "中": 0.1, "低": 0 } } });
  const s0 = mk(0).join("|");
  ok(/全空報/.test(s0) && !/×0\.00/.test(s0), "比值 0 → 全空報訊息、無 ×0.00", s0);
  ok(/×0\.30/.test(mk(0.1).join("|")), "比值 0.1 → 下限 clamp ×0.30", mk(0.1));
  ok(/×0\.50/.test(mk(0.5).join("|")), "比值 0.5 → ×0.50", mk(0.5));
}

// ── 6. Open-Meteo 未來 1h 加權 ────────────────────────────────
console.log("\n[6] omNext1h 重疊加權");
{
  const one = { hourly: {
    time: ["2026-07-05T14:00", "2026-07-05T15:00", "2026-07-05T16:00", "2026-07-05T17:00"],
    precipitation: [0, 6, 3, 0],
    precipitation_probability: [0, 80, 40, 0]
  } };
  const t = W.parseLocalMin("2026-07-05T14:20");
  const r = W.omNext1h(one, t);
  // [14:20,15:20)＝15 時桶 40 分（6×40/60=4）+16 時桶 20 分（3×20/60=1）→ 5
  ok(Math.abs(r.om_mm - 5) < 0.01, "om_mm 加權 5.0", r.om_mm);
  ok(r.om_pop === 80, "om_pop 取重疊桶最大 80", r.om_pop);
  ok(W.omNext1h(null, t).om_mm === null, "來源掛掉 → null 不炸");
  const t2 = W.parseLocalMin("2026-07-05T14:00");
  const r2 = W.omNext1h(one, t2);
  ok(Math.abs(r2.om_mm - 6) < 0.01, "整點對齊：恰好一桶 6.0", r2.om_mm);
}

// ── 6b. 影子實驗②③：qpfAt 半徑 / 鄰站訊號 / 週報評分節 ───────
console.log("\n[6b] 影子實驗：QPF 半徑與鄰站領先訊號");
{
  // qpfAt 半徑：雨格離點 3 格遠 → 窄(1.5格)漏接、寬(4.5格)接到
  const res = 0.0125, lat0 = 25.0, lng0 = 121.5;
  const qpf = { res, cells: [{ lat: lat0 + 3 * res, lng: lng0, mm: 5 }] };
  ok(W.qpfAt(qpf, lat0, lng0) === 0, "窄半徑：3 格外雨格接不到", W.qpfAt(qpf, lat0, lng0));
  ok(W.qpfAt(qpf, lat0, lng0, 4.5) === 5, "寬半徑：接到 5mm", W.qpfAt(qpf, lat0, lng0, 4.5));
  ok(W.qpfAt(null, lat0, lng0, 4.5) === null, "QPF 未載入 → null");

  // neighborMaxR10：排除本站、10km 截斷、全乾回 0、無有效值回 null
  const stns = [
    { id: "SELF", lat: lat0, lng: lng0, r10: 8 },                 // 本站，要排除
    { id: "N1", lat: lat0 + 0.045, lng: lng0, r10: 2 },           // ~5km
    { id: "N2", lat: lat0 + 0.27, lng: lng0, r10: 9 },            // ~30km，出界
    { id: "N3", lat: lat0, lng: lng0 + 0.05, r10: null },         // 無效值
  ];
  ok(W.neighborMaxR10(stns, lat0, lng0, "SELF") === 2, "取 10km 內鄰站最大 r10=2（排除本站與出界站）", W.neighborMaxR10(stns, lat0, lng0, "SELF"));
  ok(W.neighborMaxR10([stns[0], stns[3]], lat0, lng0, "SELF") === null, "無有效鄰站 → null");
  ok(W.neighborMaxR10([{ id: "N4", lat: lat0 + 0.01, lng: lng0, r10: 0 }], lat0, lng0, "SELF") === 0, "鄰站全乾 → 0");

  // computeStats 兩個評分節：4 筆乾點位，鄰站訊號與窄/寬 QPF 各自對答案
  const fcRows = [
    { slot: "202607011000", pid: "A", tier: 0, poss: "低", qpf: 0, qpf_w: 3, nb_r10: 3, now_mm: 0 },  // 下了：窄漏、寬中、鄰站有叫
    { slot: "202607011000", pid: "B", tier: 0, poss: "低", qpf: 0, qpf_w: 2, nb_r10: 0, now_mm: 0 },  // 沒下：窄對、寬誤報
    { slot: "202607011000", pid: "C", tier: 0, poss: "低", qpf: 0, qpf_w: 0, nb_r10: 2, now_mm: 0 },  // 沒下：鄰站白叫
    { slot: "202607011000", pid: "D", tier: 0, poss: "低", qpf: 0, qpf_w: 0, nb_r10: 0, now_mm: 0 },  // 下了：兩者都漏
    { slot: "202607011000", pid: "E", tier: 2, poss: "高", qpf: 5, qpf_w: 5, nb_r10: 6, now_mm: 4 },  // 當下有雨 → 不進實驗樣本
  ];
  const obRows = [
    { slot: "202607011100", pid: "A", p1h: 2, valid: true },
    { slot: "202607011100", pid: "B", p1h: 0, valid: true },
    { slot: "202607011100", pid: "C", p1h: 0, valid: true },
    { slot: "202607011100", pid: "D", p1h: 1, valid: true },
    { slot: "202607011100", pid: "E", p1h: 5, valid: true },
  ];
  const env = fakeEnv({ "shadow/fc/2026/07/01.ndjson": ndjson(fcRows), "shadow/ob/2026/07/01.ndjson": ndjson(obRows) });
  const st = await W.computeStats(env, ["2026/07/01"]);
  ok(st.neighbor_signal && st.neighbor_signal.samples === 4 && st.neighbor_signal.base_rate === 0.5, "鄰站節：樣本4、基準率0.5", st.neighbor_signal);
  const th2 = st.neighbor_signal.thresholds.find(x => x.th === 2);
  ok(th2.n === 2 && th2.precision === 0.5 && th2.recall === 0.5, "th=2：A,C 觸發 → precision .5 / recall .5", th2);
  ok(st.qpf_radius && st.qpf_radius.samples === 4, "QPF 半徑節：樣本4（當下有雨不算）", st.qpf_radius);
  // 窄：全沒喊（fa 分母 0→null），漏掉 A,D → miss 2/4；寬：喊了 A,B（A 中 B 誤報），漏 D → miss 1/2
  ok(st.qpf_radius.narrow.accuracy === 0.5 && st.qpf_radius.narrow.miss === 0.5 && st.qpf_radius.narrow.false_alarm === null, "窄：對2錯2、沒喊過雨、漏 2/4", st.qpf_radius.narrow);
  ok(st.qpf_radius.wide.accuracy === 0.5 && st.qpf_radius.wide.miss === 0.5 && st.qpf_radius.wide.false_alarm === 0.5, "寬：接到 A、換來 B 誤報", st.qpf_radius.wide);
}

// ── 6c. QPF 瘦身解析：字串快路徑 / 退路 / box 掃描 ────────────
console.log("\n[6c] QPF 解析 CPU 瘦身");
{
  // 快路徑：metadata regex + content indexOf 抽取（不整包 JSON.parse）
  const meta = { StartPointLongitude: "120.00", StartPointLatitude: "24.00", GridResolution: "0.5",
    GridDimensionX: "6", GridDimensionY: "5", DateTime: "2026-07-06T10:00:00+08:00" };
  // 值 = k（k=iy*6+ix），k=14 改 -99 驗過濾
  const vals = Array.from({ length: 30 }, (_, k) => k === 14 ? -99 : k).join(",");
  const fastTxt = JSON.stringify({ cwaopendata: { dataset: { datasetInfo: { parameterSet: meta }, contents: { content: vals } } } });
  const p = W.parseQpfRaw(fastTxt);
  ok(p.lon0 === 120 && p.lat0 === 24 && p.res === 0.5 && p.NX === 6 && p.NY === 5, "快路徑 metadata", p);
  ok(p.datetime === "2026-07-06T10:00:00+08:00", "快路徑 DateTime", p.datetime);
  ok(p.body === vals, "快路徑 content 抽取正確");
  // 退路：content 是物件（#text 變體）→ 快路徑放棄、JSON.parse 接手
  const objTxt = JSON.stringify({ cwaopendata: { dataset: { datasetInfo: { parameterSet: meta }, contents: { content: { "#text": "1,2,3" } } } } });
  ok(W.parseQpfRaw(objTxt).body === "1,2,3", "退路：#text 變體仍可解", W.parseQpfRaw(objTxt).body);

  // box 掃描：box lon[121,122]→ix 2..4、lat[24.5,25.5]→iy 1..3；期望 9 格、k=14 被 -99 濾掉
  const cells = W.extractQpfBox(p.body, p.lon0, p.lat0, p.res, p.NX, p.NY, { lon: [121, 122], lat: [24.5, 25.5] });
  ok(cells.length === 8, "box 內 9 格、-99 濾 1 → 8 格", cells.length);
  const c20 = cells.find(c => c.mm === 20);
  ok(c20 && c20.lat === 25.5 && c20.lng === 121, "k=20（iy3,ix2）座標正確", c20);
  ok(!cells.some(c => c.mm === 14 || c.mm < 0), "-99 不進 cells");
  // 與舊法（split 全部再索引）等價性抽查
  const old = [];
  const va = p.body.split(",");
  for (let iy = 1; iy <= 3; iy++) for (let ix = 2; ix <= 4; ix++) { const v = +va[iy * 6 + ix]; if (v > 0) old.push(v); }
  ok(JSON.stringify(cells.map(c => c.mm)) === JSON.stringify(old), "新舊解析結果等價", { new: cells.map(c => c.mm), old });
}

// ── 6d. QPF 時效守衛 + housekeeping ──────────────────────────
console.log("\n[6d] QPF 時效守衛 / housekeeping");
{
  const now = Date.parse("2026-07-06T12:00:00+08:00");
  ok(W.qpfIsFresh({ datetime: "2026-07-06T11:10:00+08:00" }, now) === true, "50 分前 QPF＝新鮮");
  ok(W.qpfIsFresh({ datetime: "2026-07-06T10:30:00+08:00" }, now) === false, "90 分前 QPF＝過期");
  ok(W.qpfIsFresh({ datetime: null }, now) === false && W.qpfIsFresh(null, now) === false, "無 datetime/null＝不新鮮");

  // housekeeping：35 天前的 fc/ob 刪、近的留、report 不碰
  const z = n => String(n).padStart(2, "0");
  const dayKey = back => { const d = new Date(Date.now() + 8 * 3600 * 1000); d.setUTCDate(d.getUTCDate() - back);
    return `${d.getUTCFullYear()}/${z(d.getUTCMonth() + 1)}/${z(d.getUTCDate())}`; };
  const oldK = dayKey(40), newK = dayKey(10);
  const keys = [`shadow/fc/${oldK}.ndjson`, `shadow/fc/${newK}.ndjson`, `shadow/ob/${oldK}.ndjson`, `shadow/ob/${newK}.ndjson`];
  const deleted = [];
  const env = { BUCKET: {
    list: async ({ prefix }) => ({ objects: keys.filter(k => k.startsWith(prefix)).map(k => ({ key: k })), truncated: false }),
    delete: async k => { deleted.push(k); }
  } };
  const r = await W.housekeeping(env);
  ok(r.deleted === 2 && deleted.length === 2, "刪 2 檔（fc+ob 各 1）", r);
  ok(deleted.every(k => k.includes(oldK)) && !deleted.some(k => k.includes(newK)), "只刪 35 天前", deleted);
}

// ── 6e. 鄰區提示層（advisory-only，不動判語/帳本）─────────────
console.log("\n[6e] nearbyHint 提示層");
{
  // 07-06 14:20 永和實錄：本站乾、窄 QPF=0、鄰站 nb=3 → 提示觸發
  ok(/鄰區正在下雨/.test(W.nearbyHint(0, 0, 3, 1.9) || ""), "永和 14:20 情境：鄰站 3mm/h 觸發提示", W.nearbyHint(0, 0, 3, 1.9));
  // 07-06 14:20 北投實錄：nb=0、寬 QPF=16 → 雷達提示
  ok(/雨胞/.test(W.nearbyHint(0, 0, 0, 16) || ""), "北投 14:20 情境：寬 QPF 16 觸發雷達提示", W.nearbyHint(0, 0, 0, 16));
  // 14:10 全盲情境：什麼都沒有 → 無提示（不亂叫）
  ok(W.nearbyHint(0, 0, 0, 0) === null, "全零 → 不提示");
  // 已在下 → 主判語自己講，不疊提示
  ok(W.nearbyHint(0.5, 0, 3, 5) === null, "本站已在下 → null");
  // 主判語已喊「等一下會下」（q>0）→ 不疊提示
  ok(W.nearbyHint(0, 2, 3, 5) === null, "QPF 已喊雨 → null");
  // 門檻以下不叫
  ok(W.nearbyHint(0, 0, 1, 0.5) === null, "nb<2 且 qw<1 → null");
  // 提示不影響 buildNowcast 輸出（帳本欄位不變）
  const nc = W.buildNowcast(0, 0, 0, 0, [], null, 12);
  ok(nc.tier === 0 && nc.possibility === "低" && !("nb_hint" in nc), "buildNowcast 本體不含提示層（外掛欄位，A/B 不污染）", nc.tier);

  // 挑戰者參考行 omHint：07-06 13:xx–14:10 情境（乾、無 QPF、OM 89%）→ 事前就給機率
  ok(/約 9 成/.test(W.omHint(0, 0, 89) || ""), "OM 89% → 約 9 成參考行", W.omHint(0, 0, 89));
  ok(/極高/.test(W.omHint(0, null, 100) || ""), "OM 100% → 極高", W.omHint(0, null, 100));
  ok(W.omHint(0, 0, 44) === null, "OM 44%（低於 70 門檻）→ 不顯示");
  ok(W.omHint(3, 0, 89) === null && W.omHint(0, 2, 89) === null && W.omHint(0, 0, null) === null, "已在下/QPF 已喊/無值 → null");
}

// ── 7. W27 情境回測：同一批輸入，舊邏輯 vs 新邏輯 ─────────────
console.log("\n[7] W27 情境回測（整週掛特報+plan3=8、實際幾乎沒下）");
{
  // 模擬 W27：144 輪 × 無雨、無 QPF、plan3=8、豪雨特報；實際 1h 後 95% 沒下
  const N = 144, plan8 = [{ from: 0, to: 24, pop: 80, mm_hr: 8 }];
  const fcOld = [], fcNew = [], obRows = [];
  for (let i = 0; i < N; i++) {
    const slot = W.slotPlus("202606290000", i * 10);
    const rained = i % 20 === 0;                          // 5% 的時段其實有下
    // 舊邏輯（W27 上線版）：plan3+特報 → tier3「稍後可能下」+可能性高，無 claim 欄位
    fcOld.push({ slot, pid: "A", tier: 3, poss: "高", qpf: null, now_mm: 0 });
    // 新邏輯：跑實際的 buildNowcast
    const nc = W.buildNowcast(0, 0, 0, null, plan8, ["豪雨"], 12);
    fcNew.push({ slot, pid: "A", tier: nc.tier, claim: nc.claim, tier3: nc.h3_tier, poss: nc.possibility, qpf: null, now_mm: 0 });
    obRows.push({ slot: W.slotPlus(slot, 60), pid: "A", p1h: rained ? 2 : 0, valid: true });
  }
  // 補尾巴 ob，讓 3h 主張的答案也到齊
  for (let m = 70; m <= 240; m += 10) obRows.push({ slot: W.slotPlus("202606290000", (N - 1) * 10 + m), pid: "A", p1h: 0, valid: true });
  const day = rows => {
    const map = {};
    for (const r of rows) { const k = `2026/${r.slot.slice(4, 6)}/${r.slot.slice(6, 8)}`; (map[k] = map[k] || []).push(r); }
    return map;
  };
  const fold = (fcRows) => {
    const files = {};
    for (const [k, v] of Object.entries(day(fcRows))) files[`shadow/fc/${k}.ndjson`] = ndjson(v);
    for (const [k, v] of Object.entries(day(obRows))) files[`shadow/ob/${k}.ndjson`] = ndjson(v);
    return fakeEnv(files);
  };
  const days = ["2026/06/29", "2026/06/30"];
  const stOld = await W.computeStats(fold(fcOld), days);
  const stNew = await W.computeStats(fold(fcNew), days);
  console.log("    舊邏輯 scores_1h:", JSON.stringify(stOld.scores_1h));
  console.log("    新邏輯 scores_1h:", JSON.stringify(stNew.scores_1h), "| scores_3h:", JSON.stringify(stNew.scores_3h), "| 3h coverage:", JSON.stringify(stNew.coverage_3h));
  ok(stOld.scores_1h.false_alarm >= 0.9, "舊邏輯 1h 誤報 ≥0.9（重現 W27）", stOld.scores_1h.false_alarm);
  ok(stOld.scores_1h.possibility["高"] <= 0.1, "舊邏輯「高」實際下雨率 ≤0.1（重現 W27 放水）", stOld.scores_1h.possibility);
  ok(stNew.scores_1h.false_alarm == null, "新邏輯 1h 不再喊沒把握的雨（誤報分母=0）", stNew.scores_1h.false_alarm);
  ok(stNew.scores_1h.possibility["高"] == null && stNew.scores_1h.possibility["中"] != null, "新邏輯不再亂發「高」，長視野歸「中」", stNew.scores_1h.possibility);
  // 07-06 事件修正後：3h 列的 h1「不會下」斷言同時記 1h 帳 → 兩本帳都有 144 筆
  ok(stNew.coverage.expected === 144 && stNew.coverage_3h.expected === 144, "1h/3h 兩本帳都記滿（h1 斷言可追責）", [stNew.coverage.expected, stNew.coverage_3h.expected]);
  ok(stNew.scores_1h.miss === 0.06, "「不會下」斷言的漏報 8/144 誠實入帳", stNew.scores_1h.miss);
  // 3h 口徑下這批喊「中雨」但 3h 內多半也沒下 → 誤報會留在 scores_3h，這是「題目出對了」的樣子
  ok(stNew.scores_3h.false_alarm != null, "3h 誤報有值（問題被放回正確的考卷）", stNew.scores_3h);
}

console.log(`\n結果：${pass} 通過 / ${fail} 失敗`);
process.exit(fail ? 1 : 0);
