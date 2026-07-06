# SHADOWLOG_SPEC v2 — 雨縫 shadow log 規格（2026-07-06 依現行實作重寫）

> 原 v1 未入庫（僅存於 CONTEXT_COMPACT §6 摘要）；本版為對照 `src/index.js` 現行程式重寫，
> 之後改 shadow 相關程式**先改這份 spec 再改 code**。

## 1. 目的
自動對答案：每 10 分鐘記錄「系統當下的判斷」與「雨量站實測」，事後 join 打分，
公開自己的準度（爛週照登），並用同一套管線裁決影子實驗（新資料源/新參數先記錄、不進 fusion，
四週後看數據人工拍板）。

## 2. 抽樣點（校準盤，與使用者盤分離）
`src/points.json` 的 `shadow_points`：A中和/B永和/C內湖 + S1北投/S2板橋/S3信義/S4汐止/S5淡水。
站號執行時 `nearestStation` 動態綁。**自訂點（localStorage）不寫入 shadow log。**

## 3. 儲存（R2，純 append）
- `shadow/fc/YYYY/MM/DD.ndjson`（預報行）、`shadow/ob/YYYY/MM/DD.ndjson`（實測行）。
- R2 無原生 append → 讀日檔接行寫回（單 cron 無併發問題；手動 /refresh 與 cron 撞時有極小機率重複/丟行，可接受）。
- `slot` = 10 分鐘鍵 `YYYYMMDDHHmm`（台灣時間，分鐘無條件捨去到 10 分）。

### fc 行 schema（現行）
```
{ slot, pid, ts,
  qpf,          // 窄半徑（1.5 格）QPF mm；null=QPF 未載入/過期
  qpf_w,        // 影子實驗③：寬半徑（4.5 格 ≈6km）QPF
  nb_r10,       // 影子實驗②：10km 內鄰站最大 10 分雨強（排除本站；null=無有效鄰站）
  tier, claim,  // claim="1h"|"3h"：主張視野（h1 有實證=1h；僅長視野訊號=3h）
  tier3,        // h3（縣市 plan3/特報）之 tier；claim=3h 時打分用
  poss, trend, verdict, warn, plan3, now_mm,
  om_mm, om_pop,// 影子實驗（Phase C）：Open-Meteo 未來 1h 降水/機率（重疊加權）
  station, county }
```
舊資料無 claim/tier3/om_*/nb_r10/qpf_w 欄位 → 打分時 claim 視為 "1h"、其餘節跳過該行。

### ob 行 schema
```
{ slot, pid, ts, p1h, p10, valid }   // p1h=Past1hr、p10=Past10Min×6；valid=p1h 非 null
```

## 4. 對答案（join 與打分，`computeStats`）
- **1h 主張**：fc[T] join ob[T+60]（`slotPlus` 處理跨日/月/年）。
- **3h 主張**：fc[T] join ob[T+60/120/180] 的 p1h **最大值**（近似「3h 內是否下過」）；tier 用 `tier3`。
- 答案未到（ans slot > 觀測最大 slot）不計入 coverage。
- 分級 `tierMm`：<0.2/1/4/10/30 → 0–5。「喊雨」= tier≥2；「下雨」（對決/校準/可能性）= p1h≥0.2。
- 指標：`direction_hit`（|tier差|≤1）、`false_alarm`（喊了沒下/喊雨數）、`miss`（沒喊卻下/沒喊數）、
  `qpf_bias_median`（當下無雨且 qpf>0 之實測/預報比值中位）、`possibility` 三桶實際下雨率（1h 語意，對 ob[T+60]）。
- 週報分節：`scores_1h`、`scores_3h`（`scores` = scores_1h 舊欄位相容）；`public.*` 以 1h 為口徑。

## 5. 影子實驗評分節（皆不進 fusion；樣本=「本站當下乾」的筆）
- `source_duel`：CWA-QPF vs Open-Meteo（accuracy／false_alarm／miss，下雨=0.2）。
- `neighbor_signal`：nb_r10 ≥ 門檻（0.5/1/2/5）之 precision/recall，對照 base_rate。
- `qpf_radius`：窄（qpf）vs 寬（qpf_w）同筆對決。
- `calibration`（Phase B）：QPF 分桶 0 / 0–0.5 / 0.5–1 / 1–2 / 2–5 / 5–10 / 10–20 / 20+，
  各桶 n、rain02（p1h≥0.2 率）、rain1（p1h≥1 率）；近 4 週窗。前端桶 n≥50 才顯示「約 X 成會下」。

## 6. 週報
- cron 每日 03:00–03:2x 凍結當週 `shadow/report/YYYY-Www.json`（冪等覆寫，三次機會）。
- 內容：coverage / coverage_3h / scores_1h / scores_3h / source_duel / neighbor_signal /
  qpf_radius / calibration / suggestions / public / points。
- `public.*` 口徑：定性為主、漏報露出、不丟裸小數（「約 X 成」）；樣本 <20 顯「資料不足」。

## 7. 路由
`/stats?weeks=`（即時算）、`/shadow/gen?week=`（手動凍結）、`/shadow/latest`、`/shadow/file?week=`、
`/shadow/calib?weeks=`、`/shadow/peek?day=`（探針）、`/health`（cron 心跳+資料鮮度）。

## 8. 原則（不可退讓）
1. **human-on-the-loop**：自動對答案/打分 OK；**絕不自動改融合門檻**。上限=人工調常數/查表，不做 ML/DL。
2. 影子實驗一律「先記錄、不進 fusion、四週對答案、人工拍板」。
3. 資料源去留是實驗問題，不是信仰問題。
4. QPF 時效守衛：`qpf.json` 超過 70 分鐘視同無 QPF（避免舊雨帶冒充「未來 1h」）。

## 9. housekeeping（已實作，2026-07-06）
cron 每日 03:3x：刪除 **35 天前**的 `shadow/fc|ob` 日檔（= 校準 4 週窗 + 1 週緩衝）；
`shadow/report/` 週報**永久保留**。

## 10. 純函式測試紀律
join/打分/分桶/解析等純函式改動，先在 `tests/offline.test.mjs` 加合成案例（跨日 slot、
誤報/漏報邊界、雙 horizon、-99 過濾…）驗過再交付；`node tests/offline.test.mjs` 必須全綠。
