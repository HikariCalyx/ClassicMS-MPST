# 專案指引

## Commit 慣例（使用者要求，每次 commit 都要做）

1. **更新版本號**：依變更幅度遞增 semver，四個位置要同步：
   - `package.json` 的 `version`
   - `package-lock.json` 的兩處 `version`（根層與 `packages[""]`）
   - `src-tauri/Cargo.toml` 的 `version`（改完跑一次 `cargo check` 讓 `Cargo.lock` 同步）
   - `src-tauri/tauri.conf.json` 的 `version`
   - （`web-wasm/Cargo.toml` 的版本號不參與發布，不用動）
2. **更新 `CHANGELOG.md`（僅限使用者有感的變更）**：若本次有新增功能、操作流程或
   明顯介面變更、使用者會遇到的問題修正，才在 `## [未發布]` 之下新增
   `## vX.Y.Z（YYYY-MM-DD）`。純技術性 commit 不新增版本段落或條目。
   - 每版以 1～3 點為原則；一點一句，相關調整合併成一點。
   - 只寫「使用者得到什麼／什麼問題被修正」，不要解釋原因、程式如何實作或驗收數據。
   - 不記錄建置、部署、CI、工具鏈、相依套件、重構、快取或資料管線等內部維護事項。
   - 不寫檔名、函式、套件／框架名稱、指令、內部格式、精確資料筆數或效能倍率。
   - 相容性或效能調整只有在使用者能明顯感受到，或需要採取行動時才記錄。
   - 例如寫「修正雲端資料偶爾無法載入」，不要寫壓縮方式、HTTP 標頭或快取清除流程。
   應用內的「更新日誌」彈窗（`src/components/ChangelogDialog.tsx`）會直接解析
   `## ` 標題與 `- ` 條目，格式不要偏離。
3. **commit 訊息**：用中文、簡述本次加了什麼／修了什麼（參考 git log 既有風格）。

## 驗證

提交前至少跑過：

- `cargo fmt --all -- --check && cargo clippy -p msclassic --all-targets -- -D warnings && cargo test -p msclassic --all-targets`
- `npm run build`（桌面前端）；動到 wasm 或 web 版時加跑 `npm run build:web`

## 部署（使用者要求）

- 線上版（hosted）只要 push 到 GitHub 就會自動重新佈署，**不需要**手動跑
  `npm run deploy:hosted`。
- hosted 資料集（R2）不在自動佈署範圍內：資料有變動時仍需手動跑
  `node scripts/upload_hosted.mjs <version>` 上傳。
- 桌面安裝檔由 `.github/workflows/release.yml` 產生：推送與 `tauri.conf.json`
  版本相符的 `vX.Y.Z` tag 會建置 Windows NSIS 與 macOS 通用版 DMG 並附到
  同一個 Release；手動 dispatch 只留 artifact。macOS 的 bundle target 由
  `src-tauri/tauri.macos.conf.json` 覆寫。

## 測試分工（使用者要求）

- build / type-check / lint / 單元測試等**不動滑鼠鍵盤的自動檢查**照跑沒關係。
- **UI 操作驗證一律交給使用者手動測**：不要用 PowerShell 腳本、SendKeys、mouse_event
  等方式操控視窗或搶滑鼠（會把使用者的鼠標拉走）。需要實機操作時，列出測試步驟請
  使用者執行並回報結果。
