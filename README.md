# rainwalker 雨縫 — 雙北通勤降雨決策 PWA

CWA 多源融合（雨量站現況/趨勢＋**鄰站訊號**＋雷達 QPF＋縣市 3h 預報＋特報）→
**一句有立場、可行動的判語**，Type-I 偏向（寧可誤報、最怕漏報），並以 shadow log
自動對答案、公開自己的準度。單一 Cloudflare Worker（UI + `/data.json` + cron），
全 web UI 操作、無需 CLI。線上：https://rainwalker.ai-apps.work/

## 文件地圖（接手先讀）
| 文件 | 內容 |
|---|---|
| **`docs/HANDOFF.md`** | **接手規格**：架構/資料源/fusion/前端現狀＋工程紀律＋**下一動驗證清單** |
| `docs/SHADOWLOG_SPEC.md` | shadow log 規格（schema/打分/裁決原則）——改 shadow 程式**先改 spec** |
| `docs/archive/` | 封存：原始工單與情境（07-05）、逐日 session 記錄、PATCH-2026-07 決策書（鄰站進 fusion 的信度效度與 18k 筆回測） |

## 現狀速覽（2026-07-22）
- **Fusion**：正在下 → QPF → **鄰站訊號**（07-22 進 fusion：nb≥5「鄰區在下」/nb2–5「留意移入」，
  claim=1h 進帳）→ h3 副提示 → 無雨。門檻集中 `GATE` 常數，人工調參、絕不自動改。
- **成績**（n≈15k）：方向命中 0.91／誤報 0.49／漏報 0.02／「高」實際下雨率 0.46
  （W27 起點 0.45／0.99／0／0.02）。
- **畫面全 CWA**；Open-Meteo/JMA 降級幕後（健康監測/備援候選，影子欄位續記）。
- **Workers Paid $5/月**（免費 10ms CPU 曾致 cron 全滅）；cron 每 10 分，週報 03:0x、
  housekeeping 03:3x（35 天保留）。SW cache **rain-v18**。

## 開發驗證（改完必跑）
```bash
node tests/offline.test.mjs      # 98 個離線合成案例（fusion/打分/校準/回測），必須全綠
# worker 語法：sed 's/^import CONFIG.*/const CONFIG={};/' src/index.js > /tmp/w.mjs && node --check /tmp/w.mjs
# 前端：抽出 <script> 做 node --check，並 bump public/sw.js 的 CACHE 版本
```
**紀律**：一次一針；cron 路徑禁止重複 parse 大 JSON；影子欄位先行＋增量回測＋人工拍板
（絕不自動改門檻、不做 ML）；`.wfill` 永遠後景、文字永遠前景。

## 主要路由
`/`（UI）、`/data.json`、`/at?lat=&lng=&n=`、`/refresh`、`/health`（cron 心跳+資料鮮度）、
`/stats?weeks=`、`/shadow/latest`、`/shadow/gen?week=`、`/shadow/file?week=`、
`/shadow/calib?weeks=`、`/shadow/peek?day=&slot=&pid=`（常設取證）

## 資料卡住怎麼查
`/health`：`cron_age_min>15`＝cron 沒在跑；`cron_last.step!="done"` 或 `err`＝掛在該步。
後台 Cron events 見 **Exceeded Resources＝CPU 超限**（07-05 事件，已升付費＋瘦身）。
逐時取證：`/shadow/peek?day=YYYYMMDD&slot=YYYYMMDDHH&pid=A` 看 now_mm/p10（觀測層）、
qpf（雷達）、nb_r10（鄰站）、om_*（外部對照）。

## 部署（Cloudflare Workers Builds，web UI）
1. repo 根目錄需含 `wrangler.toml`（assets/cron/R2/observability 由它套用）。
2. R2 bucket 名稱=`rainwalker`；Secret `CWA_KEY`（值要無尾端換行）。
3. push → 自動 build；若 Bindings/Cron 沒出現，後台手動補（Worker → Settings）。

## 下一動
見 `docs/HANDOFF.md` §8：部署驗收鄰站判語 → 下份週報驗證升級代價（miss 不升、誤報 ≤0.55、
中桶升到 ~0.1–0.25）→ 移入型雨實戰 → 每週幕後看門狗（QPF vs OM/JMA 落差=CWA 劣化警報）。
