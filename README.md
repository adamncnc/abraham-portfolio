# Abraham Portfolio Dashboard

Adam 的個人投資組合即時看板 — 自動抓取報價、配息資訊、資產配置分析。

## 架構

```
abraham-portfolio/
├── config/                  ← 編輯這裡增減追蹤項
│   ├── holdings.json        持倉（含成本、數量）
│   └── watchlist.json       觀察清單
├── scripts/
│   ├── fetch_prices.py      主抓資料程式
│   └── fetchers/
│       ├── tw_stock.py      台股 / 台股 ETF
│       ├── us_stock.py      美股 / 美 ETF
│       └── gold.py          黃金（GC=F 期貨）
├── docs/                    ← GitHub Pages root（GitHub UI 只支援 /(root) 或 /docs）
│   ├── index.html           Dashboard UI
│   └── js/app.js
├── data/
│   ├── latest.json          最新快照
│   └── snapshots/           歷史快照
└── .github/workflows/
    └── fetch.yml            GitHub Actions 排程
```

## 如何新增 / 移除追蹤項

編輯 `config/watchlist.json`：

```json
{
  "watchlist": [
    {
      "id": "your_unique_id",
      "type": "tw_etf",
      "symbol": "0050.TW",
      "name": "元大台灣 50",
      "notes": "台股核心"
    }
  ]
}
```

支援的 `type`：
- `tw_etf` — 台股 ETF（.TW 後綴）
- `tw_stock` — 台股個股
- `us_etf` — 美股 ETF
- `us_stock` — 美股個股
- `commodity` — 商品（黃金 GC=F 等）

Commit + push → GitHub Actions 下次執行時自動納入。

## 本地測試

```bash
pip install -r requirements.txt
python scripts/fetch_prices.py
# 打開 docs/index.html 查看
```

## 更新時程

- 週一至五 07:00 UTC（15:00 Taipei）台股收盤後
- 週二至六 22:00 UTC（06:00 Taipei）美股收盤後
- 可手動 `workflow_dispatch` 立即執行

## Reference

- yfinance: <https://github.com/ranaroussi/yfinance>
- Chart.js: <https://www.chartjs.org/>
- Abraham 財務顧問: 分析 / 監控 / 提醒，不代操、不下單
