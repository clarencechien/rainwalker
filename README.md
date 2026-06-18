# rain-on-route

通勤遇雨 dashboard（雙北固定 3 點 / 4 路徑）。Cloudflare Pages（UI）+ Worker（cron 抓 CWA 寫 R2）。

## 結構
- `index.html` — UI（讀 `DATA_URL`，預設 `data.json`，找不到時 fallback 內嵌示範資料）
- `data.json` — 種子資料；Pages 先靜態服務這個，Worker 上線後切換 `DATA_URL`
- `worker/` — cron Worker：抓 CWA → 算 → 寫 R2 的 `data.json`
  - `wrangler.toml` — cron `*/10`、R2 binding
  - `points.json` — A/B/C 座標、最近雨量站 id、鄉鎮代碼、路徑（config-driven）
  - `src/index.js` — 骨架，真資料位置標 TODO

## 1. 先上 UI（Cloudflare Pages）
1. push 這個 repo 到 GitHub。
2. Cloudflare 後台 → Workers & Pages → Create → Pages → 連這個 repo。
3. Build 設定：無 build command、輸出目錄填 `/`（根目錄即靜態網站）。Deploy。
4. 拿到 `https://rain-on-route.pages.dev`，此時讀的是 repo 裡的種子 `data.json`。

## 2. 再上 Worker（cron + R2）
```bash
cd worker
npm i -g wrangler
wrangler r2 bucket create rain-on-route
wrangler secret put CWA_KEY          # 貼新的 CWA 授權碼（舊的記得作廢）
wrangler deploy
# 測試：開 https://rain-on-route.<子網域>.workers.dev/refresh 觸發一次，再開根路徑看 data.json
```

## 3. 把 UI 接到 Worker
編輯 `index.html` 頂端：
```js
const DATA_URL = "https://rain-on-route.<你的子網域>.workers.dev/";
```
重新 deploy Pages。前端就改讀 Worker 即時產的 `data.json`。

## 4. 邊寫邊驗：填真資料
在 `worker/src/index.js` 的 `buildData()` 把四個 TODO 補上（雨量站現況 → 鄉鎮預報 plan → QPF 臨近 → 對帳 state）。`cwaFetch()` 已封裝好 datastore / fileapi 兩條路徑。
