# HANDOFF — 雨縫 rainwalker 接手規格（2026-07-22 版，反映當前 code）

> 給下一個 Claude Code session 的完整接手文件。歷史脈絡在 `docs/archive/`（工單原文、
> 逐日 session 記錄、PATCH 決策書），**本文只描述現狀與下一動**。
> 語言：一律台灣正體中文。部署：使用者**只用 GitHub → Cloudflare Workers Builds（web UI）**，
> 禁止要求 wrangler CLI；改完 code 交付即可，部署由使用者操作。

## 0. 產品一句話
雙北通勤降雨決策 PWA：CWA 多源融合（雨量站現況/趨勢＋鄰站訊號＋雷達 QPF＋縣市 3h 預報＋特報）
→ **一句有立場、可行動的判語**，Type-I 偏向（寧可誤報、最怕漏報），敢公開自己的準度。
不跟 Google 拚預測力；護城河=融合＋判語＋自報準度。線上：https://rainwalker.ai-apps.work/

## 1. 架構現狀
- **單一 Cloudflare Worker + static assets**（`wrangler.toml` 在 repo 根）：main=`src/index.js`、
  assets=`./public`、cron `*/10 * * * *`、R2 bucket `rainwalker`（binding BUCKET）、
  `[observability]` 開啟。**Workers Paid $5/月**（免費 10ms CPU 軟性執法曾致 cron 全滅，
  已升級；CPU 瘦身仍保留：來源共用一次 parse、QPF 定向掃描、預報 R2 快取 25 分）。
- `CWA_KEY` 為 Worker Secret（**必 .trim()**，尾端換行=401）。
- 檔案：`src/index.js`（全邏輯）、`src/points.json`（config）、`public/index.html`（單檔 UI）、
  `public/sw.js`（cache 版本現為 **rain-v18**，改前端必 bump）、`tests/offline.test.mjs`（98 案例）。

## 2. 資料源（全 CWA 免費；外部源僅幕後）
| 源 | 用途 | 狀態 |
|---|---|---|
| O-A0002-001 雨量站 | 現況 mm/hr、r10/r1h 趨勢、**鄰站訊號**（10km 內最大 r10） | 進 fusion |
| F-B0046-001 QPF | 未來 1h 雷達定量降雨（窄半徑 1.5 格；>70 分視同無） | 進 fusion |
| F-D0047-089 | 縣市 3h PoP（R2 快取 25 分、跨日失效） | 只出 h3_hint |
| W-C0033-001 特報 | 縣市級（分層顯示，不抬可能性超過「中」） | 只出 h3/warnline |
| Open-Meteo best_match | om_mm/om_pop 影子欄位 | **僅幕後**：CWA 健康監測（對決輸 QPF，z=24.6） |
| Open-Meteo jma_seamless | om_jma 影子欄位 | **僅幕後**：備援候選（acc 0.85≈QPF 0.86） |
| 已否決 | Google Weather（不綁卡）、Apple（無帳號）、ECMWF（25km/3h 太鈍）、寬 QPF（z=16.2 淨損）、雷達回波外推（拚預測力，不打） | — |

## 3. Fusion 現狀（`buildNowcast(now, r10, r1h, qpf, plan, warn, nowHr, nb)`）
優先序：**正在下 → QPF 喊雨 → 鄰站訊號 → h3（僅長視野）→ 全無**。
- 雙 horizon：主判語只由 1h 實證出；縣市 plan3+特報降為 `h3_hint` 副提示（claim="3h"，記兩本帳）。
- 可能性 gating：「高」須 QPF≥1 或正在下或 rising+地面有雨跡；特報/plan3 單獨最多「中」。
- **鄰站分支（2026-07-22 進 fusion，PATCH-2026-07）**：乾站且 QPF 無訊號時，
  nb≥5 → tier2「鄰區在下，可能移入」可能性**中**；nb 2–5 → tier1「鄰區有雨，留意移入」可能性**低**；
  claim=1h 進帳受考。可能性對映依 18,352 筆增量回測校準（增量下雨率 .255/.084；
  **邊際關聯≠增量預測力**——教訓已入 SPEC §8）。
- 門檻集中在 `GATE = { Q_HI:1, PLAN_HEAVY:8, NB_MID:2, NB_HIGH:5 }`（人工調參區，絕不自動改）。
- 可能性階梯實測：高 ≈0.46 ＞ 中 ≈0.2+ ＞ 低 ≈0.0x（單調、誠實）。

## 4. Shadow log 與準度（規格見 `docs/SHADOWLOG_SPEC.md`，改 shadow 先改 spec）
- 8 固定點每 10 分記 fc/ob，join 對答案；1h/3h 分帳；週報每日 03:00–03:2x 凍結、03:3x housekeeping
  （刪 35 天前日檔、週報永存）。
- 目前成績（07-22，n≈15k）：direction_hit 0.91／false_alarm 0.49／miss 0.02／「高」實際下雨率 0.46
  （W27 起點：0.45／0.99／0／0.02——Phase A 修復已由資料蓋章）。
- 裁決原則：樣本足（關鍵指標 95%CI 半寬<0.03）即可人工裁，不綁週數；升級前必做**增量回測**。

## 5. 前端現狀（`public/index.html` 單檔）
- 雙模式 localStorage `rw_mode`：精簡（預設，長輩）＝主卡一句大字＋一句行動＋可能性膠囊＋
  三格「接下來的雨勢」（現在/+1h/+3h，`ev3html()` 全 UI 共同時間軸）＋「為什麼這樣判」收合。
- `speak()` 顯示合成：僅剩「只有 h3 訊號」時把稍後吸收成一句（鄰站已是真判語、OM 參考行已下架）。
- 進階：點卡（副標=地標/測站名防同名混淆；橫向滑動）＋路徑 tabs（尾端「＋路徑」）＋ detail 浮層＋
  「今日整天（縣市級·每 3 小時）」條。自訂點/路徑存 `rw_custom_points`/`rw_custom_paths`/`rw_loc`
 （上限 8 點、不入 shadow 統計；主卡選自訂點時 HERE 卡不重複渲染）。
- 換地點＝雙北 41 行政區快選 chips＋目前定位＋進階摺疊手輸經緯度。
- **UI 鐵律**：`.wfill` 永遠後景（z-index:0、opacity .3）、文字永遠前景（text-shadow）；
  `.detail[hidden]{display:none}` 歷史坑勿破壞；校準註記＝桶 n≥50 顯「約 X 成會下」。

## 6. 路由
`/`、`/data.json`、`/at?lat=&lng=&n=`、`/refresh`、`/health`（cron 心跳+鮮度）、`/stats?weeks=`、
`/shadow/latest|gen|file|calib`、`/shadow/peek?day=&slot=&pid=`（常設取證：slot 前綴過濾）。

## 7. 工程紀律（必守）
1. 一次一針、每針可驗收（交付附「打哪個 URL、看哪欄、期望值」）。
2. 改 worker/前端後：`node --check`（worker 用 sed 換掉 JSON import）＋ `node tests/offline.test.mjs` 全綠。
3. 改前端必 bump `public/sw.js` CACHE；純函式先加離線合成案例。
4. human-on-the-loop：絕不自動改融合門檻；不做 ML/DL；影子欄位先行、增量回測、人工拍板。
5. cron 路徑禁止重複 parse 大 JSON（CPU 紀律，付費後仍守）。
6. 出事取證 SOP：`/health` 分辨「cron 沒觸發 vs 掛在哪步」；`/shadow/peek?day=&slot=` 逐時還原
   看 now_mm/p10（觀測）、qpf（雷達）、nb_r10（鄰站）、om_*（外部對照）。

## 8. 下一動（依序，接手先做這些）
1. **部署驗收 rain-v18／鄰站判語**（使用者 web UI 部署後）：
   - `/health` → `cron_ok:true`、`step:"done"`。
   - 找「乾站但 10km 內鄰站在下」的點打 `/at` → 主判語應為「鄰區在下/有雨」而非「這 1 小時應不會下」。
   - 前端強刷：OM 藍色參考行應消失；畫面資訊=判語＋h3 小字＋特報行。
2. **下份週報驗證升級代價**（03:0x 凍結後看 `/shadow/latest`）：
   - `scores_1h.miss` ≤ 0.02 不升；`false_alarm` ≤ 0.55（回測預估 +0.018）；
   - `possibility.中` 應從 0.01 升到 ~0.1–0.25（鄰站筆進中桶）——這是升級生效的指紋。
3. **實戰驗收**：下一場移入型午後雨，主卡應在雨到前 10–20 分出現「鄰區在下，可能移入」。
4. **幕後看門狗 SOP（每週順手）**：`source_duel` 若 QPF accuracy 掉 <0.80 而 OM/JMA 穩 → 查 CWA 管線
   （格點對位/檔案時效），這是 CWA 劣化警報，不是換源訊號。
5. **校準表前端**：`/shadow/latest` 的 calibration 桶 n≥50 時精簡卡可能性旁應自動加註——驗一次。
6. **housekeeping 驗證**（上線滿 35 天後，約 08-10）：`/shadow/peek?day=<35 天前>` 應 lines:0。
7. **待拍板：校準表 gating QPF 喊雨**——W32 對答案後定案的下一針，決策書
   `docs/PATCH-2026-08-calibration-gate.md`（含 28 天樣本外回測：乾週誤報 93% 為 QPF 驅動、
   校準表 regime 漂移發現、三案比較，建議案 A `Q_SHOUT=10`）。**等使用者選案後才動工。**
8. **Backlog（未拍板，勿自行啟動）**：原始雷達回波當影子欄位（1km 解析度，唯一可能補
   「站間小雨胞」的免費資料；要做也是影子先行＋增量回測）；準度面板加源對決/校準摘要；
   看門狗規則修訂（乾週沉默者 accuracy 虛高——比 accuracy 之外要比喊雨頻率+誤報率，
   W31 QPF 0.80 vs JMA 0.95 實為 regime 效應非 CWA 劣化）。

## 9. Git / 部署
- 開發 branch：`claude/rainwalker-phases-impl-hquc7d`（PR #10 流程，使用者自行 merge + web UI 部署）。
- commit 台灣正體中文、結尾附 Co-Authored-By；不建 PR 除非使用者要求。
