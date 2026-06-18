# rainwalker — 單一 Worker（UI + data.json + cron）

全部手動 web 操作、無需 CLI。一個 Worker 同時：服務 UI、用 R2 出 `/data.json`、跑 cron 寫 R2。

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

## 下一步：邊寫邊驗
把 `src/index.js` 的 `buildData()` 四個 TODO 補上真資料。`cwaFetch()` 已封好 datastore/fileapi。
