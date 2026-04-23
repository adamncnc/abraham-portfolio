# Deploy to GitHub Pages — 步驟

Phase 2：把 abraham-portfolio 推上雲，讓手機 / 任何裝置都能看。

## 前置

- GitHub 帳號：`adamncnc`（已確認）
- 本機此 repo 已完整建置（Phase 1 完成）

## Step 1 — 在 GitHub 建 repo

1. 登入 <https://github.com/adamncnc>
2. 右上角 `+` → **New repository**
3. 設定：
   - Repository name：`abraham-portfolio`
   - Public（GitHub Pages 免費版要 Public，但此 repo 只含行情資料無敏感資訊）
   - 不要勾選 "Add a README"（我們本地已有）
4. **Create repository**

## Step 2 — 推本地 repo 到 GitHub

在本地 terminal：

```bash
cd /c/Users/Adam/Abraham/abraham-portfolio
git init
git add .
git commit -m "Initial commit — Abraham portfolio dashboard"
git branch -M main
git remote add origin https://github.com/adamncnc/abraham-portfolio.git
git push -u origin main
```

## Step 3 — 啟用 GitHub Pages

1. GitHub repo 頁面 → **Settings** → **Pages**（左側選單）
2. **Source**：**Deploy from a branch**
3. **Branch**：`main` / **folder**：`/docs`
4. **Save**
5. 等 1-2 分鐘，頁面會顯示：
   > Your site is live at `https://adamncnc.github.io/abraham-portfolio/`

## Step 4 — 驗證 Actions 會自動跑

1. GitHub repo → **Actions** tab
2. 應該看到 `Fetch Portfolio Prices` workflow
3. 點 **Run workflow** 手動觸發一次，確認成功（綠勾）
4. 第一次跑完後，repo 會有新 commit「chore: auto-update prices …」
5. Pages 網址自動更新

## Step 5 — 手機驗證

用手機瀏覽器打開：
```
https://adamncnc.github.io/abraham-portfolio/
```

應該看到完整 dashboard。加入主畫面像 App 一樣用。

## 之後的維護

### 新增追蹤項

```bash
# 編輯 config/watchlist.json，加一筆
git add config/watchlist.json
git commit -m "add: 新增 0056 元大高股息"
git push
```

Actions 會被 push 觸發，自動抓新資料。

### 移除追蹤項

刪掉 `config/watchlist.json` 對應的 block，commit push 即可。

### 手動觸發更新

Actions tab → Run workflow → Run。

### 查歷史快照

`data/snapshots/YYYY-MM-DD.json` 保留最近 90 天。

## Troubleshooting

### Actions 失敗

- 檢查 Actions log，通常是 yfinance 偶爾 rate-limit
- 重試：Re-run failed jobs

### Pages 404

- 確認 Pages 設定的 folder 是 `/docs`
- 確認 `docs/index.html` 存在（大小寫敏感）

### 手機 fetch 資料失敗

- 開瀏覽器 DevTools 看 Console
- 通常是 `data/latest.json` 還沒 commit（等第一次 Actions 跑完）
