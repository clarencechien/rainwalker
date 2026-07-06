# HANDOFF — rainwalker 準度改造工單（給 Claude Code）

> 先讀同目錄 `CONTEXT_COMPACT.md`（系統現況+對話壓縮）。
> 語言：一律台灣正體中文（介面文案、註解、回覆）。
> 部署：使用者**只用 GitHub → Cloudflare Workers Builds（web UI）**，**禁止**要求 wrangler CLI。改完 code 交付即可，部署驗證由使用者操作。

---

## ⚡ 接手快照（2026-07-05 session 已完成本工單；下方§1–§7 為原工單，留供對照）

**Phase A–D＋兩個追加影子實驗已全部實作**（branch `claude/rainwalker-phases-impl-hquc7d`）。
離線測試：`node tests/offline.test.mjs`（72 案例，含 W27 情境回測）——改 worker/前端後必跑。

### 已完成（2026-07-05）
1. **Phase A**：`buildNowcast` 雙 horizon——主判語只由 1h 實證（now/趨勢/QPF）出，縣市 plan3+特報降為 `h3_hint` 副提示；可能性 gating（「高」須 QPF≥1mm 或正在下或 rising+地面有雨跡；特報/plan3 單獨最多「中」；門檻集中在 `GATE` 常數）；fc 行新增 `claim`(1h|3h)/`tier3`；`computeStats` 分 `scores_1h`/`scores_3h`（3h 主張對 T+60/120/180 最大值；舊資料無 claim 視為 1h 相容）；suggestion clamp（係數下限 ×0.30、比值≈0 改出「全空報」訊息）。
2. **Phase B**：`calibrationFromDays` QPF 分桶（0/0.5/1/2/5/10/20/+∞）→ 實際下雨頻率（rain02/rain1）；端點 `/shadow/calib?weeks=N`；週報加 `calibration` 節（近 4 週樣本）；前端桶樣本≥50 時可能性旁加註「過去經驗：約 X 成會下」。
3. **Phase C**：Open-Meteo 影子欄位 `om_mm`/`om_pop`（一次呼叫帶 8 點、hourly 重疊加權出未來 1h，cron 144 次/日）；週報 `source_duel` 節（CWA-QPF vs Open-Meteo，下雨=p1h≥0.2）。**使用者已拍板：Google 不綁卡、Apple 跳過。**
4. **Phase D**：精簡模式「換地點」；地點管理面板＝雙北 41 行政區快選 chips＋「把目前位置存成地點」＋進階摺疊手輸經緯度（名稱選填）；自訂點上限 8、存 `rw_custom_points`；自訂路徑存 `rw_custom_paths`；進階模式 tabs 尾端「＋ 路徑」直達編輯；點卡列/tabs 改橫向滑動防破版；h3_hint 顯示於精簡卡/路徑卡/detail 浮層；固定盤 A/B/C+S1–S5 未動。SW cache 現為 **rain-v12**。
   - **前景/後景修正（2026-07-05 晚，使用者截圖回報）**：燒杯水位 `.wfill` 疊在暗色小字（+1小時/+3小時、為什麼這樣判）後面吃掉對比。修法＝`.wfill` 明確 `z-index:0`、opacity **.42→.30**；`.bigcard .inner`/`.pp .inner` 文字加深色 text-shadow（.cbtn/.chip 例外）；`.evax` 字色 dim→muted。原則：**字永遠前景、水位永遠後景裝飾**，之後改卡片樣式勿破壞。
5. **影子實驗②鄰站領先訊號**：fc 行記 `nb_r10`（10km 內鄰站最大 10 分雨強，排除本站；`neighborMaxR10`）；週報 `neighbor_signal` 節——本站乾的筆，門檻 0.5/1/2/5 各算 precision/recall，對照 base_rate。
6. **影子實驗③QPF 取值半徑**：fc 行記 `qpf_w`（`qpfAt` gridFactor=4.5 ≈6km；fusion 現行 1.5 格不動）；週報 `qpf_radius` 節（窄/寬同筆對決 accuracy/誤報/漏報）。
7. 預設拍板均已確認：雙 horizon 文案 OK、gating OK、Open-Meteo 先上、自訂點 localStorage OK。

### 事件記錄：2026-07-05 深夜起 cron 全滅（已定位＝CPU 超限，已做瘦身）
- 現象：23:10 起 data.json 不更新；後台 Cron events 每輪 **Exceeded Resources、CPU 10ms**＝免費方案每次呼叫 CPU 上限，cron 有觸發但跑到 10ms 被砍，到不了寫 data.json。手動 `/refresh`（HTTP）能過＝fetch 對突發較寬容、cron 強制較嚴。
- 起因：cron 路徑 CPU 本就貼線（QPF 2.66MB 整包 JSON.parse 實測 ≈18ms、預報大 JSON 每輪 parse 兩次、測站抓兩次），07-05 晚部署的 OM/鄰站/寬QPF 再加一點就全面超線。
- **已做 CPU 瘦身（行為不變）**：①`collectSources` 每輪各上游只抓/parse 一次，refresh 與 shadowAppend 共用；②QPF 改字串定向抽取＋只掃 box 列（`parseQpfRaw`/`extractQpfBox`，18.4→4.3ms，格式變化自動退回 JSON.parse）；③預報 F-D0047-089 存 R2 快取 `fc_cache.json` 25 分 TTL（跨日失效）。
- 常設診斷：cron 進場先寫心跳 `meta/cron.json`（fired_at/step/err），**`/health`** 一眼分辨「沒觸發」（cron_age_min>15）vs「觸發但掛在某步」（cron_last.step!=done / err）。
- **07-06 10:20 復活確認**：瘦身版部署後 `/health` step=done、data/qpf 皆新鮮。注意 `wall_ms`（~9.7s）是掛鐘時間＝等網路，與 CPU 上限無關（Workers 凍結時鐘，程式無法自量 CPU）。
- **重要認知（07-06 實證）：免費 10ms CPU 是「軟性執法」**。同帳號歷史 P99 51ms 跑了數週沒事；07-05 深夜起輪輪在 10ms 被砍（被砍時顯示的是配額值）；瘦身版首輪 **59.4ms 卻 Success**（含冷啟編譯，被放行時顯示實際用量）。結論＝執法是累犯制/機率性，**warm 輪實際 CPU 仍 >10ms 就隨時可能重演全滅**。
- **判讀標準**：看部署數小時後 warm 輪成功事件的 CPU 欄——多在 10ms 以下＝安全；仍 20–50ms＝剩餘大頭是全台測站 O-A0002 的 JSON.parse（瘦身後唯一未動的大解析），照下行二選一處理。
- **若再見 Exceeded Resources**：免費 10ms 就是不夠，二選一：(a) 升級 Workers Paid（$5/月，CPU 30s，一勞永逸）；(b) 再拆輪（QPF 與 shadow 分兩輪跑）＋固定雙北測站清單縮小 O-A0002 payload。屆時由使用者拍板。

### 部署後驗收（使用者 web UI 部署後打）
- `/health` → `cron_ok: true`、`cron_last.step: "done"`（部署後等 10 分讓 cron 跑一輪）。
- `/refresh` → 回傳 `shadow.om` 應為 `"ok"`。
- `/shadow/peek?day=YYYYMMDD` → fc 最新行應有 `claim`/`om_mm`/`nb_r10`/`qpf_w` 欄位。
- `/stats?weeks=1` → 應有 `scores_1h`/`scores_3h`/`source_duel`/`neighbor_signal`/`qpf_radius` 節。
- `/shadow/calib?weeks=4` → 回分桶表 JSON（初期樣本少屬正常）。
- 前端強刷（SW rain-v12）：精簡卡有黃色 h3_hint 小字；「換地點」開出行政區 chips；進階 tabs 尾端「＋ 路徑」；加 >4 個點時點卡列可橫向滑動；下雨時水位升高後「+1 小時/+3 小時/為什麼這樣判」等字仍清晰（字在前景）。

### 下次 session 的 TODO
1. **等樣本，約四週後（W31±）裁決**——全部 human-on-the-loop，看數據人工改常數，絕不自動：
   - `source_duel`：Open-Meteo 贏 → 討論進 fusion 方式（Type-I 偏向建議兩源 OR）；輸 → 維持現狀，Google 免議。
   - `neighbor_signal`：某門檻 precision 明顯高於 base_rate 且 recall 可觀 → 接進 gating 當「抬可能性」第四條件。
   - `qpf_radius`：寬半徑漏報降、誤報可接受 → 人工改 fusion 的 gridFactor。
   - `calibration`：桶樣本≥50 前端自動顯示，無需動作；可順手檢視桶界是否要調。
2. **W28 新週報第一週檢查**：`scores_1h.false_alarm` 應大幅低於 W27 的 0.99；可能性「高」實際下雨率應回升；`scores_3h` 開始有值。新舊資料混跑（舊行無 claim）屬正常。
3. **housekeeping 未實作**（spec 已寫）：刪舊 shadow 日誌只留週報，等週報穩定幾輪再做。
4. `SHADOWLOG_SPEC.md` 不在 repo（CONTEXT 有引用但未上傳）——下次請使用者提供，或依 `CONTEXT_COMPACT.md` §6 補寫入庫。
5. 前端校準註記依賴 `/shadow/latest` 凍結週報的 `calibration` 節——W28 起產出的週報才有此節。

### 工程紀律（不變，細節見§7）
一次一針；改 worker 或前端後 `node --check`＋`node tests/offline.test.mjs`；改前端必 bump `public/sw.js` CACHE；純函式先離線合成案例再交付；臨時探針用完即刪（現存僅 `/shadow/peek`）；**絕不自動改融合門檻**。

---

## 0. 背景一句話
雨縫 = 雙北通勤降雨決策 PWA（五源融合→一句判語）。已上線含 shadow log 自動對答案系統。**第一週成績卷（W27）暴露結構性問題：誤報率 99%、「可能性高」實際下雨率 2%**。本工單 = 修判斷邏輯 + 建校準表 + 引入挑戰者資料源 + UI 個人化。

## 1. 診斷（W27 報告，repo 外部佐證見 CONTEXT_COMPACT §7）
- `false_alarm 0.99 / miss 0 / direction_hit 0.45 / possibility高→實際0.02 / qpf_bias_median 0`
- **病因一（打分視野錯配）**：「稍後可能下」是 3 小時主張（來自縣市 plan3/特報），卻被拿 1 小時後的 p1h 對答案。題目出錯，答錯不冤。
- **病因二（可能性放水）**：特報+縣市預報（縣市級、長視野）可直接把可能性抬到「高」。資料證明它們對 1h 幾乎無預測力。
- **病因三（QPF 空報+formatter bug）**：`qpf_bias_median 0` → 該週 QPF>0 的點位 1h 實測多為 0；且 suggestion 產出「門檻 ×0.00」——formatter 未設下限。

## 2. Phase A — 修 fusion 與打分（立即做，不需新資料）

### A1. 雙 horizon 輸出
`buildNowcast` 改為輸出兩層：
- `h1`（1 小時主張）：只由 **1h 內實證**驅動 = 現況 mm、趨勢 r10/r1h、QPF。主判語從這層出。
- `h3`（稍後提示）：由縣市 plan3 + W-C0033 特報驅動。輸出一行副提示（如「稍後 18 時前後全區可能有中雨」），**不主導主判語、不抬可能性**。
- 相容性：保留現有欄位（verdict/sub/possibility/tier/evidence/why/warn），新增 `h3_hint` 字串欄位；前端精簡卡主判語=h1、下方小字=h3_hint。避免破壞現有 UI。

### A2. 可能性 gating（預設規則，使用者未反對即採用）
- 「高」：**必須** QPF>閾值 或 正在下(now≥0.2) 或 趨勢 rising 且 now>0。
- 特報/plan3 單獨在場：最多「中」。
- 什麼都沒有：「低」。

### A3. 打分視野分離（`computeStats`）
- fc 行新增 `claim: "1h" | "3h"`（由 h1/h3 何者主導決定；既有舊資料無此欄位→視為 "1h" 以相容）。
- `1h` 主張：對 `ob[T+60].p1h`（現行邏輯）。
- `3h` 主張：對 T+60/T+120/T+180 三筆 ob 的 p1h **最大值**（近似未來 3h 內是否下過）。
- 週報 scores 分兩節：`scores_1h`、`scores_3h`；`public.*` 以 1h 為主口徑。

### A4. 小修
- suggestion formatter：qpf 係數下限 clamp（如 min 0.3），比值 0 時改輸出「QPF 本週近乎全空報，建議檢視 QPF 觸發閾值」而非 ×0.00。
- 驗證：離線合成案例測試（參考先前 /tmp/test.mjs 模式：跨日 slot、誤報/漏報/雙 horizon 各給案例），`node --check` 必過。

## 3. Phase B — 校準表（個人化機率的核心）
- 新函式 `calibrationTable(env, weeks)`：掃近 N 週 fc/ob join 結果，對「預報當下無雨」的筆，按 QPF 分桶（建議桶界：0, 0.5, 1, 2, 5, 10, 20, +∞ mm），各桶算實際下雨(p1h≥0.2 與 ≥1 兩檔)頻率與樣本數。
- 週報加 `calibration` 節；另開 `/shadow/calib?weeks=N` 端點回 JSON。
- **前端（簡易版）**：當校準表某桶樣本數 ≥ 50 時，「可能性 高/中/低」旁加註經驗機率（如「約 7 成會下」）。樣本不足只顯示定性詞。口徑規則沿用：不丟裸小數、用「約 X 成」。
- 不做 ML。就是查表（spec §6 上限）。

## 4. Phase C — 挑戰者資料源（A/B 審源，用 shadow log 裁決）
- **先接 Open-Meteo**（免費、無 key）：`https://api.open-meteo.com/v1/forecast?latitude=..&longitude=..&hourly=precipitation,precipitation_probability&forecast_hours=3&timezone=Asia%2FTaipei`（實作時以官方文件為準）。
- `shadowAppend` 對 8 個固定點多記：`om_mm`（未來1h降水）、`om_pop`（未來1h機率）。**不進 fusion、不影響判語**——純影子記錄。
- 週報加「源對決」節：同點同 slot，CWA-QPF vs Open-Meteo 各自的 1h 命中/誤報/漏報。**四週後**由使用者決定誰進 fusion。
- Google Weather API（10k 免費/月、需綁卡 GCP）：**等使用者確認要不要綁卡**才做；若做，降頻抽樣（3 點 × 30 分 ≈ 4.3k/月）。
- Apple WeatherKit（需 $99/年開發者帳號 + JWT）：**除非使用者說有帳號，否則跳過**。

## 5. Phase D — UI 個人化（與準度正交，可並行）
- 簡易版：定位之外加「換地點」（輸入地名→ nominatim 或直接讓使用者長按地圖選點皆可；最簡=手輸經緯度/預設點清單，避免引入重依賴）。選定後打 `/at?lat=&lng=` 渲染（`/at` 已回完整 nowcast，免改 worker）。
- 進階版：自訂點 CRUD 存 **localStorage**（鍵名建議 `rw_custom_points`），自訂路徑=任兩點配對；「現在定位」升為一等公民點。渲染沿用 ppCard/renderCard 模組（吃 point 物件即可）。
- **固定盤不動**：A/B/C + S1–S5 是校準基線（校準盤 vs 使用者盤分離），自訂點不寫入 shadow log。
- SW cache 版本記得 bump；沿用現有 CSS 變數與卡片樣式，不重設計。

## 6. 待使用者拍板（動工前確認；未回覆時 Phase A 可先做，其餘暫停）
1. 雙 horizon 文案結構（主判語=1h、小字=稍後）OK？→ 預設 OK，做。
2. 可能性 gating 新規則同意？→ 預設同意，做。
3. 挑戰者：Open-Meteo 先上（預設做）；Google 綁卡與否？Apple 有無開發者帳號？→ **等答案**。
4. 自訂點存 localStorage（換機不同步）可接受？→ **等答案**（預設 localStorage）。

## 7. 工程紀律（必守）
- 每步改完：抽出 `<script>` 或 worker 做 `node --check`；點卡/週報等純函式先離線合成案例驗證再交付。
- 一次一針、每針可驗收：交付時附「部署後打哪個 URL、看哪個欄位、期望值是什麼」。
- 臨時探針路由用完即刪；R2 append-only 慣例不變；**絕不**自動改融合門檻（human-on-the-loop，spec §6）。
- 免費額度守恆：新增外部呼叫先算月請求量（cron 144 輪/日 × 點數）。
- 正體中文文案；燒杯半透明、判語+可能性+證據+為什麼 tips 的既有 UI 語言不推翻。
