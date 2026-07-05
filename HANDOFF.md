# HANDOFF — rainwalker 準度改造工單（給 Claude Code）

> 先讀同目錄 `CONTEXT_COMPACT.md`（系統現況+對話壓縮）與 `SHADOWLOG_SPEC.md`（shadow log 規格）。
> 語言：一律台灣正體中文（介面文案、註解、回覆）。
> 部署：使用者**只用 GitHub → Cloudflare Workers Builds（web UI）**，**禁止**要求 wrangler CLI。改完 code 交付即可，部署驗證由使用者操作。

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
