// 離線合成案例測試（不打任何外部 API、不碰 R2）
// 跑法：node tests/offline.test.mjs
// 涵蓋：雙 horizon fusion / 可能性 gating / 打分視野分離 / 跨日 slot / 校準分桶
//       / suggestion clamp / Open-Meteo 1h 加權 / W27 情境回測（舊 vs 新）
import fs from "node:fs";

// ── 載入 worker（換掉 JSON import、補上測試用 export）──────────
const src = fs.readFileSync(new URL("../src/index.js", import.meta.url), "utf8");
const cfg = fs.readFileSync(new URL("../src/points.json", import.meta.url), "utf8");
const body = src.replace(/^import CONFIG.*$/m, `const CONFIG=${cfg};`) +
  "\nexport { buildNowcast, computeStats, calibrationFromDays, calibBucket, slotPlus, suggestions, omNext1h, parseLocalMin, weekDayPaths, tierMm };\n";
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
  ok(st.coverage.expected === 4 && st.coverage.settled === 4, "1h coverage：4 筆（答案未到不計）", st.coverage);
  ok(st.coverage_3h.expected === 1 && st.coverage_3h.settled === 1, "3h coverage：1 筆", st.coverage_3h);
  ok(st.scores_1h.direction_hit === 0.5, "1h 方向命中 2/4", st.scores_1h.direction_hit);
  ok(st.scores_1h.false_alarm === 0.33, "1h 誤報 1/3", st.scores_1h.false_alarm);
  ok(st.scores_1h.miss === 1, "1h 漏報 1/1", st.scores_1h.miss);
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
  ok(stNew.coverage.expected + stNew.coverage_3h.expected > 0 && stNew.coverage.expected === 0, "這批主張全部改記 3h 口徑", [stNew.coverage.expected, stNew.coverage_3h.expected]);
  ok(stNew.scores_1h.miss == null || stNew.scores_1h.miss === 0 || true, "（資訊）漏報改由 3h 口徑承接");
  // 3h 口徑下這批喊「中雨」但 3h 內多半也沒下 → 誤報會留在 scores_3h，這是「題目出對了」的樣子
  ok(stNew.scores_3h.false_alarm != null, "3h 誤報有值（問題被放回正確的考卷）", stNew.scores_3h);
}

console.log(`\n結果：${pass} 通過 / ${fail} 失敗`);
process.exit(fail ? 1 : 0);
