# CONTEXT_COMPACT — 雨縫 rainwalker 系統現況與對話壓縮（給 Claude Code）

## 1. 產品與使用者
- **雨縫 rainwalker**（英 rainwalker，tagline 見隙而行）：雙北通勤降雨決策 PWA。目標用戶=機車族/最後一哩/曬衣等「會因雨改變行動」的人，含長輩（精簡模式預設）。
- 定位（已定調）：**不跟 Google 拚預測力**（Google MetNet 分鐘級 nowcast 贏不了）。贏的點=**五源融合→一句有立場、可行動、講得出原因、敢公開自己準度的判語**，Type-I 偏向（寧可誤報、最怕漏報）。
- 使用者 Clarence：台灣板橋，正體中文，直接技術風格，「逐層驗證、沒有邊緣就不參與」，**只用 GitHub→Cloudflare web UI 部署（無 CLI）**。repo: https://github.com/clarencechien/rainwalker ，線上 https://rainwalker.sw-tech.workers.dev/

## 2. 架構
- **單一 Cloudflare Worker + static assets**。`wrangler.toml`（repo 根）：main=src/index.js、[assets] dir=./public binding=ASSETS、cron `*/10 * * * *`、R2 bucket `rainwalker`（binding BUCKET）。CWA_KEY 為 Worker Secret（**注意 .trim()，尾端換行=401**）。免費額度實測 OK（CPU P99 51ms、mem 21MB）。
- 檔案：`src/index.js`（worker 全邏輯）、`src/points.json`（config）、`public/index.html`（單檔 UI）、`public/sw.js`（cache 版本現為 rain-v9）、`SHADOWLOG_SPEC.md`。

## 3. 資料源（CWA 開放資料，全免費，已逆向驗證）
- **O-A0002-001 雨量站**（datastore，10分更新）：現況 mm/hr + `Past10Min`(×6→r10) + `Past1hr`(r1h) + CountyName；-99→null；StationId 過濾參數可用。
- **F-D0047-089 預報**：實為**縣市級**逐3小時 PoP；`ElementName=3小時降雨機率`；LocationName 過濾不可靠→抓全部遞迴解析。PoP≥30 → plan blocks。
- **F-B0046-001 QPF**（fileapi，2.66MB/247401格）：未來1小時雷達定量降雨。格點公式（已驗證）：`ix=round((lon-118)/0.0125), iy=round((lat-20)/0.0125), k=iy*441+ix`（south-based）。-99=無雨。cron 只抽雙北 box `lon[121.30,122.05] lat[24.60,25.35]` 的有雨格→存 R2 `qpf.json`。
- **W-C0033-001 特報**（datastore，縣市級 22 縣市）：`records.location[].hazardConditions.hazards[].info.phenomena`（豪雨/大雨/雷雨）+ validTime。**只有縣市級，無鄉鎮版**。
- 已評估暫不接：鄉鎮級預報 F-D0047-093（對 1h 決策邊際價值低；若做「機率」可重評）、雷達回波外推（$5 付費線，=跟 Google 拚預測力，不打）、溫濕度氣壓風（對 1h 降雨不正交，噪音）。

## 4. Fusion（worker `buildNowcast`）
- 輸入：now(站mm) / r10 vs r1h(趨勢 rising/falling/steady) / QPF(格點1h) / plan(縣市3h blocks) / warn(特報) / nowHr。
- 輸出 `nowcast`：`{verdict, sub(含行動建議), possibility(高/中/低), tier(0-5), trend, evidence:[now,+1h,+3h], why[], warn}`。
- `TIER_WORD=["雨","毛毛雨","小雨","中雨","大雨","豪雨"]`；tierOf: <0.2/1/4/10/30 分界；`actionHint`: tier5→改捷運別騎車、tier4→穿雨衣…
- 判語按 tier 帶強度詞（「馬上有豪雨」「等下會下大雨」「稍後可能下中雨」…）。**已知問題見 §7（本工單主因）**。
- 路由：`/data.json`（R2 快取）、`/refresh`（手動，含 shadow 摘要）、`/at?lat=&lng=&n=`（任意點：最近站+county 預報+QPF+nowcast+nearby——**UI 個人化的現成基礎**）、shadow 系列見 §6。

## 5. UI（public/index.html，單檔）
- 雙模式 localStorage：**精簡（預設，長輩）**=hero 大卡：nowcast 大字判語(tier色)+sub+「可能性 高/中/低」膠囊+「⚠ {縣市}{特報}特報（全區）」獨立行（**縣市級特報與在地判語分層，避免『毛毛雨 vs 豪雨特報』矛盾**）+3 格證據 bar（現在/+1h/+3h）+「▸ 為什麼這樣判？」收合 chips。
- **進階**：4 點卡（燒杯水位=當下實測、**label=fusion tier**：當下≥tier→強度詞、否則「轉X」）+ 路徑 tab（判語含時間感「出發就遇X/出發後不久遇X」+特報行）+ detail 浮層（/at nowcast）+ 頂部特報橫幅（兩模式共用）。
- 燒杯 `.wfill` **半透明 opacity .30＋z-index:0**（2026-07-05 由 .42 調降：水位升高會吃掉暗色小字對比；字必須永遠前景＝`.inner` z-index:2＋text-shadow）+圓潤水面+封頂；`.detail[hidden]{display:none}` 是歷史坑（display:flex 蓋掉 hidden 會凍結頁面）勿破壞。
- 右上「準度」按鈕→面板：讀 `/shadow/latest` 的 `public.*`（定性結論/約X成/漏報詞/樣本數/下載週報鈕）。樣本<20 顯「資料不足」。
- 改前端後 **sw.js CACHE 版本必 bump**（現 rain-v9）。

## 6. Shadow log（已上線，spec 見 SHADOWLOG_SPEC.md）
- **雙 log 純 append**（R2 無原生 append→讀日檔接行寫回；單 cron 無併發安全）：`shadow/fc|ob/YYYY/MM/DD.ndjson`。
- 8 固定抽樣點（config `shadow_points`）：A中和/B永和/C內湖 + S1北投/S2板橋/S3信義/S4汐止/S5淡水；站號執行時 nearestStation 動態綁（已驗證 county 全對）。
- fc 行：`{slot,pid,ts,qpf,tier,poss,trend,verdict,warn,plan3,now_mm,station,county}`；ob 行：`{slot,pid,ts,p1h,p10,valid}`。slot=10分鐘鍵 YYYYMMDDHHmm（台灣時間）。
- **對答案**：fc[T] join ob[T+60min]（`slotPlus` 已處理跨日/跨月，離線測試通過）。判定：方向命中=|tier差|≤1；誤報=喊雨(tier≥2)沒下；漏報=沒喊卻下；可能性三桶各算實際下雨率；QPF 偏差=（預報當下無雨且 qpf>0 的筆）實際/預報比值中位。
- 週報：cron 每日 03:0x 凍結 `shadow/report/YYYY-Www.json`（含 coverage/scores/suggestions/public 口語欄位）。路由：`/stats?weeks=`（即時算）、`/shadow/gen?week=`（手動凍結）、`/shadow/latest`、`/shadow/file?week=`（下載）、`/shadow/peek?day=`（探針）。
- 原則（spec §6）：**human-on-the-loop**——自動對答案/打分 OK，**絕不自動改融合門檻**；上限=人工調常數/binning 查表，**不做 ML/DL**。housekeeping（刪舊 log 留週報）spec 已寫、**尚未實作**（等週報穩定幾輪）。

## 7. W27 第一張答案卷（本工單起因）
`{settled:4584, coverage 97.6%, direction_hit:0.45, false_alarm:0.99, miss:0, qpf_bias_median:0, possibility:{高:0.02,中:0,低:0}}`
- 診斷：①**視野錯配**——「稍後可能下」是 3h 主張被當 1h 打分（W27 整週掛豪雨特報+plan3=8→幾乎每輪喊雨）；②特報/縣市預報能單獨抬「可能性高」=放水（高→實際 2%）；③ QPF 該週在點位上近乎全空報；④ suggestion「×0.00」formatter 無下限 bug。
- 結論：**先修邏輯（Phase A）再加資料（Phase C）**；shadow log 第一週就完成任務（用數據抓出結構性問題）。

## 8. 外部資料源查證（2026-07 現況）
- **Open-Meteo**：免費、無 key、非商用、多模型、有逐時降雨機率+15分鐘級降水→**首選挑戰者**。
- **Google Weather API**：免費 10k 呼叫/月（超過 $0.15/千），**需 GCP 綁卡**；240h 逐時；ML 機率模型。cron 全量 8點×10分≈3.5萬/月會爆→需降頻抽樣（3點×30分≈4.3k）。
- **Apple WeatherKit**：50 萬/月但需 **$99/年開發者帳號**+JWT 簽名→非免費，除非已有帳號。
- 方法論（已定調）：新源**先進 shadow log 當影子欄位**（不進 fusion），同 ob 對答案 A/B 四週，**誰準用誰**——資料源去留=實驗問題非信仰問題。

## 9. 工程慣例（歷史坑與紀律）
- 部署=使用者上傳 GitHub→Cloudflare 自動 build；**單 Worker+assets**（勿拆 Pages）；wrangler.toml 管 bindings/cron。
- CWA key 要 trim；fileapi content-type 標 octet-stream 但實為 JSON；QPF 2.66MB JSON.parse 在 Worker 實測 CPU 安全。
- 改 worker：`sed 's/^import CONFIG.*/const CONFIG={...};/' | node --check`；改前端：抽 `<script>` node --check + bump SW。
- 純函式（打分/join）先寫離線合成案例驗證（跨日、誤報漏報邊界）再交付。
- 臨時探針路由（/warn /qpf* 等）驗完即刪，現存探針只有 `/shadow/peek`。
- 交付格式：附「部署後打哪個 URL、看哪欄、期望值」。一次一針。
