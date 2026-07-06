# rainwalker 雨縫 — 單一 Worker（UI + data.json + cron）

雙北通勤降雨決策 PWA：五源融合（雨量站現況/趨勢、雷達 QPF、縣市 3h 預報、特報）→ 一句有立場、可行動、敢公開準度的判語。全部手動 web 操作、無需 CLI。一個 Worker 同時：服務 UI、用 R2 出 `/data.json`、跑 cron 寫 R2 + shadow log 自動對答案。

## 系統現況（2026-07-05）
- **接手開發前必讀：`HANDOFF.md` 開頭「接手快照」**（已完成事項＋TODO＋驗收清單），背景見 `CONTEXT_COMPACT.md`。
- 判語為雙 horizon：主判語只由 1h 實證出（現況/趨勢/QPF），縣市預報+特報降為「稍後…」副提示（`h3_hint`），可能性有 gating。
- shadow log 每 10 分對 8 個固定點記錄預報與實測、自動對答案；週報含 `scores_1h`/`scores_3h`/`calibration`（QPF 校準表）/`source_duel`（vs Open-Meteo）/`neighbor_signal`（鄰站領先訊號實驗）/`qpf_radius`（取值半徑實驗）。影子實驗一律不進 fusion，四週看數據人工拍板。
- UI：精簡（預設）/進階雙模式；換地點＝雙北行政區快選或目前定位；自訂點/路徑存 localStorage（上限 8 點，不進 shadow 統計）。

## 開發驗證（改完必跑）
```
node tests/offline.test.mjs      # 72 個離線合成案例（fusion/打分/校準/回測）
```
改 worker：`sed 's/^import CONFIG.*/const CONFIG={};/' src/index.js > /tmp/w.mjs && node --check /tmp/w.mjs`
改前端：抽出 `<script>` 做 `node --check`，並 **bump `public/sw.js` 的 CACHE 版本**（現為 rain-v12）。
UI 鐵律：燒杯水位 `.wfill` 永遠後景（z-index:0、opacity .30），卡片文字永遠前景（`.inner` z-index:2＋text-shadow）——改卡片樣式前先看 HANDOFF「前景/後景修正」。

## 主要路由
`/`（UI）、`/data.json`、`/at?lat=&lng=&n=`、`/refresh`、`/health`（cron 心跳+資料鮮度）、`/stats?weeks=`、`/shadow/latest`、`/shadow/gen?week=`、`/shadow/file?week=`、`/shadow/calib?weeks=`、`/shadow/peek?day=`（探針）

## 資料卡住怎麼查
先打 `/health`：`cron_age_min > 15`＝cron 沒在跑；`cron_last.step != "done"` 或 `err` 有值＝cron 有跑但掛在該步。再看後台 Cron events：**Exceeded Resources（CPU 10ms）＝免費方案 CPU 超限**（2026-07-05 事件，已做瘦身：來源共用一次 parse、QPF 定向掃描、預報 R2 快取；若復發見 HANDOFF 事件記錄的兩個選項）。`/refresh` 能成功＝程式與金鑰正常。
**CPU 紀律**：cron 路徑上禁止重複 parse 大 JSON；新增資料源先估 CPU（免費上限 10ms/次）。
**判讀餘裕**：`/health` 的 `wall_ms` 是掛鐘時間（大多在等網路），與 CPU 上限無關；真實 CPU 用量只能看後台 Cron events 成功事件的 CPU 欄或 Metrics 的 CPU P50/P99——成功事件普遍 ≥7ms 才算貼線。

## 重點
- `wrangler.toml` 必須在 **repo 根目錄**（Cloudflare 連動 build 才會套用 assets / cron / R2）。
- R2 bucket 名稱必須等於 `wrangler.toml` 裡的 `bucket_name`（預設 `rainwalker`）。

## 步驟（接續你現有的 rainwalker Worker）
1. 把這包檔案放到 GitHub repo **根目錄**（`wrangler.toml`、`public/`、`src/` 都在最上層），push。
2. R2：後台 → R2 → 確認有一個 bucket 叫 `rainwalker`（沒有就 Create bucket，名稱填 `rainwalker`）。
3. 你的 rainwalker Worker 連著這個 repo，push 後會自動 rebuild。build 完成後到
   Worker → Settings 確認：
   - **Bindings** 出現 R2：變數名 `BUCKET` → bucket `rainwalker`
   - **Triggers / Cron** 出現 `*/10 * * * *`
   （這些由 `wrangler.toml` 自動設定；若沒出現，見下方「手動補」）
4. 開 `https://rainwalker.sw-tech.workers.dev/` → UI 載入、抓同源 `/data.json` → 看到示範資料。
5. 開一次 `https://rainwalker.sw-tech.workers.dev/refresh` → 把 data.json 寫進 R2；之後 `/data.json` 就從 R2 來。
6. `DATA_URL` 已是同源 `/data.json`，不用再改。

## CWA 授權碼（之後接真資料要用，先設好）
Worker → Settings → Variables and Secrets → Add：
- 名稱 `CWA_KEY`、值=你的新授權碼、類型 **Secret(加密)**。

## 若 build 後 Bindings/Cron 沒自動出現（手動補）
- R2：Worker → Settings → Bindings → Add → R2 bucket → 變數名 `BUCKET` → 選 `rainwalker`。
- Cron：Worker → Settings → Triggers → Cron Triggers → Add → `*/10 * * * *`。

## 下一步
見 `HANDOFF.md`「接手快照」的 TODO：等 shadow 樣本累積約四週（W31±）後，依 `source_duel`/`neighbor_signal`/`qpf_radius`/`calibration` 數據人工裁決各實驗去留；housekeeping（刪舊 log 留週報）尚未實作。
