# 新楓之谷：經典版 資料查看工具

以 Tauri 2、React 19 與 Rust 製作的新楓之谷：經典版資料查看器。程式可索引遊戲的
UnityFS bundles、瀏覽 WZJS 節點、預覽圖片、顯示裝備 tooltip（名稱、需求、
屬性與 icon，對齊 Harepacker-MPST 的呈現），並將選取內容匯出成 JSON、PNG 或
不含圖片的 XML。

## 需求

- Windows 10/11 與 Microsoft Edge WebView2 Runtime
- Node.js 20 以上與 npm
- stable Rust（含 `rustfmt`、`clippy`）
- Tauri 在 Windows 上需要的
  [Microsoft C++ Build Tools](https://v2.tauri.app/start/prerequisites/#windows)

啟動 GUI 後，請使用資料夾選擇器指定遊戲資料位置。可直接選擇下列任一層級，
程式會自動找到實際包含 `*.bundle` 的 `StreamingAssets\aa\w`：

```text
maplestory_classic
Maplestory_Classic_Data
StreamingAssets
StreamingAssets\aa\w
```

資料載入後仍可由右上角的「更換資料夾」切換到其他磁碟或安裝位置。後端命令與
`catalog_demo`、`img_demo` 也可接受其他路徑；直接傳入的最末層目錄需包含
`*.bundle`。

## 開發

```powershell
npm ci
npm run tauri dev
```

只啟動 Vite 前端：

```powershell
npm run dev
```

建立前端與本機平台的安裝程式：

```powershell
npm run build
npm run tauri build
```

Windows 產出已驗證的 NSIS 安裝程式，位於 `target\release\bundle\nsis\`；macOS
則由 `src-tauri\tauri.macos.conf.json` 指定產出 `.app` 與 `.dmg`。

## 發佈安裝檔

推送 `vX.Y.Z` tag（需與 `src-tauri/tauri.conf.json` 的版本相同）會觸發
`.github/workflows/release.yml`，在 GitHub Actions 上分別建置
`msclassic-X.Y.Z-windows-x64-setup.exe` 與 `msclassic-X.Y.Z-macos-universal.dmg`
（Apple Silicon 與 Intel 通用），並附到同一個 Release。也可以在 Actions 頁面
手動執行，只保留 artifact 不發佈。

安裝檔沒有程式碼簽章：Windows 首次執行會出現 SmartScreen 提示，macOS 首次
開啟需右鍵「打開」，或先移除隔離屬性（`xattr -cr`）。

## 網頁版

同一套 Rust 核心可編成 WebAssembly,以純靜態網站形式發佈:使用者開啟網頁、
選擇自己電腦裡的遊戲資料夾,所有解析都在本機瀏覽器內完成,檔案不會上傳。
沒有遊戲資料的使用者無法使用(與桌面版相同)。

```powershell
npm run dev:web    # 開發伺服器(預設 http://localhost:1421/)
npm run build:web  # 產出靜態網站到 dist-web/,可部屬任意靜態空間
```

運作方式:選擇資料夾後,bundle 會一次性複製進瀏覽器的 OPFS 沙盒(顯示進度,
再次造訪時以 size+mtime 比對、未變動即跳過),之後由 Web Worker 內的 WASM
核心透過 `FileSystemSyncAccessHandle` 同步隨機讀取,catalog 快取也存在 OPFS。

瀏覽器需求:Chrome / Edge 102+、Firefox 111+、Safari 15.2+(OPFS 同步存取)。
資料夾選擇統一使用目錄上傳控制項(webkitdirectory),檔案僅在本機讀取、
不會上傳;刻意不用 `showDirectoryPicker`,以避開 Chromium 對 AppData、
Downloads、磁碟根目錄等位置的系統目錄封鎖。首次匯入需要與 bundle 等量
暫存空間,會以 `navigator.storage.estimate()` 事先檢查。部署需要 HTTPS
(localhost 開發不受限),不需任何特殊 HTTP header。

## 驗證

一次執行日常檢查：

```powershell
npm run check
```

等同依序執行：

```powershell
cargo fmt --all -- --check
cargo clippy -p msclassic --all-targets -- -D warnings
cargo test -p msclassic --all-targets
npm run build
npm audit --audit-level=high
```

三個正式驗收工具預設可用：

```powershell
cargo run -p msclassic --example catalog_demo -- <bundle 目錄>
cargo run -p msclassic --example img_demo -- <bundle 目錄>
cargo run -p msclassic --example export_demo -- <資產路徑> <輸出目錄>
```

`src-tauri\examples` 內其餘程式與 `src-tauri\src\bin\index.rs` 的 bundle 掃描工具
都是格式逆向工具，不參與預設 build、test 或 Clippy，也不會被打包進安裝檔。
需要時以 `research-tools` feature 執行：

```powershell
cargo run -p msclassic --features research-tools --example wzss_hash -- <參數>
cargo run -p msclassic --features research-tools --bin index -- <bundle 目錄>
```

可用 `npm run check:research` 額外以 Clippy `-D warnings` 確認全部研究工具。

舊版 WZ 交叉驗證工具則完全拆在 workspace 外。需要使用時，先把相容的
`maple_lib` 專案放在根目錄的 `MapleLib-Rust`，再執行：

```powershell
npm run check:oracle
cargo run --manifest-path tools/maple-oracle/Cargo.toml --bin wzjs_xcheck -- <參數>
```

`MapleLib-Rust` 不是日常 workspace member，也已排除版本控制；乾淨 checkout
即使沒有它，正式 build、test、Clippy 與 CI 仍可執行。

## 快取與匯出

資產 catalog 快取放在作業系統提供給 `com.msclassic.viewer` 的應用程式資料目錄。
GUI 的「匯出」選單會讓使用者自行選擇單一 JSON、PNG 或 XML 檔案的儲存位置；
`target`、`dist`、`out` 與本機 cache 均為可重建產物，不應提交版本控制。

## 已知資料限制

- WZJS v5 與目前遊戲使用的 Unity 6000.3 資料佈局已驗證；其他版本不保證相容。
- spritesheet 的 canvas-to-rect 映射已解出（節點鍵 =
  `Guid(MD5("<img 路徑>/<節點相對路徑>")).ToString("N")`），全量 703,698 個 canvas
  節點中 703,542（99.98%）可精準切出單幀；其餘 156 個在 WZSS 索引裡沒有對應鍵，
  預覽與匯出會安全地回退到整張 atlas。
- UOL（連結）節點在 WZSS 節點鍵池裡也有自己的槽，同樣可預覽與匯出圖片：全量
  1,697,823 個 UOL 節點中 1,689,813（99.53%）可精準切幀，其餘回退整張 atlas。
- 本工具只讀取遊戲資料，不會修改原始 bundles，也不提供 `.wz` 回轉。

每次更新加了什麼請見 [CHANGELOG.md](CHANGELOG.md)；詳細格式研究、架構與各階段
驗收記錄請見 [docs/PLAN.md](docs/PLAN.md)。
