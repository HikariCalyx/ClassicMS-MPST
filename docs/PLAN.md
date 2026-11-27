# 楓之谷經典版 資料查看工具 — 實作計畫與進度

> 最後更新：2026-07-25
> 目標資料來源：`C:\Program Files\Gamania\maplestory_classic\Maplestory_Classic_Data`

## 狀態總覽

| Phase | 內容 | 狀態 |
|---|---|---|
| 0 | 格式偵查（bundle 結構、資料組成、WZJS 骨架） | ✅ 完成 |
| 1 | Unity 容器層（UnityFS / SerializedFile / 物件佈局） | ✅ 完成 |
| 2 | WZJS v5 解碼器 ← **核心 + 最大風險** | ✅ 完成 |
| 3 | Tauri GUI（樹狀瀏覽 / 值檢視 / 搜尋） | ✅ 完成 |
| 4 | 圖片管線（spriteset → spritesheet atlas） | ✅ 完成 |
| 5 | 匯出（子樹 → JSON + PNG 目錄樹） | ✅ 完成 |
| 6 | Hardening / DRY / 維護性收尾 | ✅ 完成 |

圖例：⬜ 未開始 ／ 🟡 進行中 ／ ✅ 完成 ／ ⛔ 卡住

---

## Context

前一輪討論的前提有一部分是錯的，Phase 0 已把檔案拆開實測驗證。修正如下：

| 前一輪的假設 | 實測結果 |
|---|---|
| `.wzjson` 是 IL2CPP 的 ScriptableObject，得先從 `global-metadata.dat` 挖欄位排列 | **不需要碰 IL2CPP。** metadata 的 magic 是 `FAB11BAF`、version **39**（非標準值，Nexon 有動過），但根本用不到它 |
| 類別名叫 `Msc.Core\|WzJsonNode` / `WzSpriteSo` | **不存在。** 全部 449 個 MonoScript 的 class name 都被雜湊成 62 字元 hex（`ef31c44ea589...`），命名空間為空。metadata 裡也找不到任何 `Wz*` 字串 |
| 要靠 type tree / AssetRipper 還原欄位 | SerializedFile 的 `enableTypeTree = false`，但資料本身是**自訂容器格式**，跟 type tree 無關 |

真正的結構：

```
StreamingAssets/aa/w/*.bundle   37 個，全部 UnityFS / LZ4HC / Unity 6000.3.16f1
├─ json_*.bundle (小)    → TextAsset(49)，內容是純 JSON 明文
├─ json_*.bundle (大)    → MonoBehaviour(114)，payload 是自訂 `WZJS` v5 二進位格式  ← 主體
├─ spriteset_*.bundle    → Texture2D(28) + Sprite(213) 成對，一圖一張
├─ spritesheet_*.bundle  → Texture2D atlas 頁 + MonoBehaviour 索引，像素在 .resS node
└─ atlas_*.bundle        → SpriteAtlas + Sprite（UI）
```

資料量：`json_c32a59ee` 解壓後 **381 MB / 7386 個節點**，`json_573635e1` **114 MB / 935 個節點**，spritesheet 合計約 1.5 GB。

### 現成工具能做什麼、不能做什麼

**能做**：AssetRipper / AssetStudio(Razviar fork) 讀得動這些 bundle——標準 UnityFS + LZ4，不是加密容器。可直接拿到小 json bundle 的明文 JSON（`ItemTable`、`ReactorTable`、`Commodity`、`SetItemInfo`、`GlobalMarketData*` …）與 spriteset / atlas 的 Texture2D → PNG。

**不能做**：大 json bundle 的 `WZJS` blob。沒有 type tree、class name 被雜湊、格式是 Nexon 自訂的——任何現成工具只會顯示成一團 raw bytes。而遊戲資料的 95% 在這裡。

**結論**：現成工具先拿去撈圖跟明文表；這個專案的價值全部集中在 WZJS 解碼器。

---

## WZJS 格式（Phase 2 定案 ✅）

payload = MonoBehaviour body 扣掉 Unity 標頭（PPtr×2 + enabled + m_Name）之後的全部 bytes。
全部 little-endian；所有 offset 以 magic 位置（144）為基準。

### 檔案佈局

```
[0..4)      u32 nodeCount
[4..8)      u32 常數 8（用途不明，11,284 筆全數為 8）
[8..144)    12 個 section 描述（各 count u32 + offset u32）：
            slot0  = child order table（u32 陣列）
            slot1  = type 3  值區（u8）
            slot3  = type 5  值區（u16）
            slot4  = type 6  值區（i32）
            slot6  = type 8  值區（8 bytes/筆 = 2 個 4-byte 數值；
                   通常 2×f32，少數是 2×i32 bits——解碼以「denormal 即 int」分流成 Int2）
            slot7  = type 14 值區（8 bytes/筆 = vector 2×f32）
            slot8  = type 9  值區（f64）
            slot 2/5/9/10/11 全部樣本皆為空（解碼器對非空會報錯）
[144..148)  magic "WZJS"
[148..152)  u32 version = 5
[152..)     節點記錄 nodeCount × 32 bytes，之後依序是各 section 資料、
            child order table、字串池 A/B/C
header idx26..28  字串池 A（節點名稱）：count / blobOffset / tableOffset
header idx29..31  字串池 B（節點路徑）：同上
header idx32..34  字串池 C（type 11/12 字串值）：同上
header idx35      payload 總長 - 144
```

字串池 = 「資料 blob + (count+1) 筆 u32 offset 表」，第 i 字串 = `blob[off[i]..off[i+1]]`。

### 節點記錄（32 bytes = 8 × i32）

| 欄位 | 語意 |
|---|---|
| f0 | type tag（2/3/5/6/8/9/11/12/14/18/19） |
| f1 | 名稱 index → 字串池 A |
| f2 | 值（依 type：section 陣列 index / pool C index / -1） |
| f3 | 子節點 node index 連續區間起點（子節點集合 = `[f3, f3+f4)`） |
| f4 | 子節點數量 |
| f5 | 父節點 node index（-1 = 根，根 = node 0） |
| f6 | 路徑 index → 字串池 B（根是資產路徑如 `Character/Face/00020116`，其餘是 img 內相對路徑） |
| f7 | child order table 起點：顯示順序 = `table[f7 .. f7+f4]` |

設計重點：子節點的 node index 佔連續區間 `[f3, f3+f4)`，child order table 只負責順序
（實測過亂序案例：`face` 的子節點集合 {28,29,30}，table 給出 [29,28,30]）。
另外所有子節點 index 恆大於父節點（BFS-ish 佈局），組樹可倒序一次完成。

### type tag → 值型別（全量 853 萬節點實測）

| type | 值 | 數量 | 備註 |
|---|---|---|---|
| 2 | SubTree（無值） | 1,976,906 | 階層節點 |
| 3 | u8（slot1） | 33 | bool 類（`acquire`） |
| 5 | u16（slot3） | 1,820 | hair 的 `face` |
| 6 | i32（slot4） | 1,671,637 | delay / cash / reqLevel 等 |
| 8 | 2×f32（slot6） | 2,003 | probability（0.1, 0.01）、fs（10.0, 0） |
| 9 | f64（slot8） | 41 | unitPrice = 0.3 |
| 11 | 字串（pool C） | 1,102,724 | **z / islot / vslot 的列舉字串**（z="face"、islot="Pn"） |
| 12 | uol 連結（pool C） | 1,697,823 | `../../alert/1/pants` |
| 14 | vector 2×f32（slot7） | 1,380,046 | origin / map 點（brow / navel …） |
| 18 | Canvas | 699,120 | 圖片節點（f2=-1），path 指向 spriteset/spritesheet |
| 19 | Canvas（變體） | 5,008 | 與 18 的差異未定（出現在 item 類 img 的 icon/iconRaw） |

舊版 WZ 用字串存的列舉（z 圖層名、islot）在 WZJS 收進 pool C 以 type 11 索引；
真正的整數一律 type 6。type 11（= 舊版 String property）與 type 12（= 舊版 Uol property）
都索引 pool C，差別只在語意。

### 驗證

- `blank`（768 bytes）逐欄位對照：10 節點結構完全吻合（fixture 測試寫死）。
- 擴大 `00020116`（260 節點）、`01062105`（530 節點）：section int / vector / uol / canvas 全數吻合。
- 全量：out/mono 11,284 筆 WZJS payload **11284/11284 解碼成功**，853 萬節點，嚴格模式
  （所有 index 邊界、child>parent 不變量、idx35 長度、空 slot 檢查）無一失敗，release 4.5s。
- 交叉比對（oracle = v83 `Character.wz`，用隔壁 `maple_lib` 開）：
  `Afterimage/blank` 9 子節點完全一致；`Face/00020116` 任選 19 筆逐項核對
  （名稱/階層/islot/vslot 字串/cash int/origin vector/delay int）全數一致，**20/20 通過**。
  交叉比對還順手修正了一個錯誤判讀：type 11 原本以為是 inline int，比對後確認是 pool C 字串。

**殘留小問號**（不影響解碼）：type 18 與 19 的差別、type 5 u16 的語意、
header idx1 常數 8 的意義、pool C 中未被引用的字串。

**type 8 已定案（2026-07-24 第二輪）**：8 bytes = 2 個 4-byte 數值，格式層無法區分
2×f32 與 2×i32（同一屬性名 swim/recovery 在不同 img 有兩種寫法——來源 JSON 的整數
字面量被原樣寫成 int bits）。全量普查 2,003 筆 type 8 僅 8 筆是 int（denormal 特徵），
解碼器以「任一半字為 denormal（指數全 0 且非零）→ `Value::Int2`」啟發式分流，
真實遊戲資料不會出現 denormal float。

---

## 架構

Tauri 2 + React 19 + TS + Vite，前端技術棧刻意跟隔壁 `Harepacker-MPST` 對齊（版型與元件寫法可直接搬）。Cargo workspace 納入 `../MapleLib-Rust`（`maple_lib`）供舊 WZ 對照與 `squish` DXT 解碼複用。

```
經典服查看工具/
├─ Cargo.toml                    workspace: ["src-tauri"]，members 含 ../MapleLib-Rust
├─ docs/PLAN.md                  ← 本檔
├─ src-tauri/
│  └─ src/
│     ├─ lib.rs                  tauri::Builder + #[tauri::command] 註冊
│     ├─ unity/
│     │  ├─ bundle.rs            UnityFS 解析 + LZ4 區塊隨機存取
│     │  ├─ serialized_file.rs   SerializedFile v22 header / types / objects / externals
│     │  ├─ objects.rs           Unity 6000.3 硬編佈局：TextAsset/Texture2D/Sprite/AssetBundle/MonoScript
│     │  └─ texture.rs           Texture2D + .resS → RGBA8 → PNG
│     ├─ wzjs/
│     │  ├─ format.rs            WZJS v5 解碼器（本案核心）
│     │  ├─ node.rs              解出的節點樹模型 + serde
│     │  └─ fixtures.rs          單元測試（blank 等小樣本）
│     ├─ index.rs                資產索引建置 / 快取
│     └─ export.rs               子樹 → JSON + PNG 匯出
└─ src/                          React 前端
```

### 關鍵技術點

**1. LZ4 區塊隨機存取（效能核心）**

blocksInfo 裡每個 block 的 uncompressed size 已知，做前綴和就能算出任一 byte offset 落在哪個 block，只解那幾塊。沒有這個，開一次 615 MB 的 spritesheet 就要全解。用 `lz4_flex::block::decompress_into`。

Phase 0 實測踩到的兩個坑，實作時務必處理：

- flags `0x243` 含 **`0x200` = BlockInfoNeedPaddingAtStart**：讀完 blocksInfo 後要 **align(16)** 才是資料區起點。漏掉會在第 2 個 block 解爆。
- SerializedFile v22 的擴充欄位（metadataSize u32 / fileSize i64 / dataOffset i64 / unknown i64）是 **big-endian**，之後才切換成 endianness byte 指定的位元序讀 metadata 本體。

Phase 1 實作時補踩到的兩個坑（已修掉）：

- UnityFS **version >= 7 時 header 固定欄位結束後也要 align(16)**，blocksInfo 才開始。漏掉會讀到一段 0x00，LZ4 報「0 is not a valid match offset」。
- SerializedFile 的 **typeDependencies 只在 `enableTypeTree = true` 時才存在**（AssetStudio `SerializedFile.cs` 為證）；這批 bundle 全是 false，直接不讀。

**2. 索引不要全量掃描**

每個 bundle 的 `AssetBundle`(classID 142) 物件裡的 `m_Container` 就是「資產路徑 → PPtr」的完整對照表，且通常排在檔案最前面。只要解前幾個 block 讀到它，就能拿到全部 7386 筆的邏輯路徑，不必為了取 `m_Name` 而解壓 381 MB。`catalog.bin` 的二進位格式（Addressables 2.9.1）留到後面有需要再解。

**3. 圖片**

- `spriteset_*`：Texture2D 直接對應單張圖，`.resS` node 取像素。先做這條。
- `spritesheet_*`：atlas 頁 + MonoBehaviour 索引（樣本裡看到 `Morph/0007` + 一串 hex hash），要靠索引反查切回單張。排在後面。
- Texture2D 欄位偏移必須用 Unity 6000.3 的正確佈局（`m_ForcedFallbackFormat` / `m_DownscaleFallback` / `m_IsAlphaChannelOptional` / `m_MipsStripped` 這些版本差異欄位）。Phase 0 的探測就是差在這裡導致讀出 `256x524288` 這種不合理值，**以 AssetRipper 的 `Texture2D` 定義為準對齊**。

---

## 實作階段

### Phase 1 — Unity 容器層 ✅
- [x] `unity/bundle.rs`：UnityFS header、blocksInfo、LZ4 區塊隨機存取
- [x] `unity/serialized_file.rs`：v22 header / types / objects / scriptTypes / externals
- [x] `unity/objects.rs`：TextAsset / AssetBundle / MonoScript / Texture2D / Sprite 硬編佈局
- [x] 驗收：列出 37 個 bundle 的物件組成，並把小 json bundle 的 TextAsset 原樣輸出成 `.json`

### Phase 2 — WZJS 解碼器 ✅ ← 核心
- [x] 從 `blank`（768 bytes）反推 header 與 32-byte 節點記錄欄位
- [x] 擴大到 `00020116`（16 KB）、`01062105`（34 KB）驗證
- [x] 數值型別編碼（int / float / vector / canvas）
- [x] 用 `maple_lib` 開舊版 WZ 交叉比對節點名稱與階層
- [x] 驗收：任選 20 筆節點，解出的樹能跟舊版 WZ 對應路徑逐項核對

### Phase 3 — Tauri GUI ✅
- [x] 左側虛擬化樹（7386 筆頂層 + 深層子樹，一定要 virtualize）
- [x] 右側值檢視 + 圖片預覽（圖片管線是 Phase 4，此階段為佔位 + 顯示資產路徑字串）
- [x] 路徑搜尋（索引鍵子字串搜尋；img 內部深層路徑不進搜尋範圍，見下方說明）
- [x] 索引快取寫進 app data，二次啟動秒開

實作備註（Phase 3）：

- 後端邏輯在 `src-tauri/src/catalog.rs`（`Catalog` 可序列化索引 + `DataService` 懶解碼服務），
  GUI command（`gui.rs`）只是薄包裝，邏輯可用 `example catalog_demo` 獨立驗證。
- 索引鍵 = container 路徑去前綴 `Assets/WzAssets/Json/`、去副檔名（`.wzjson`/`.json`），
  共 **11,354** 筆（11,284 WZJS + 70 TextAsset）。頂層 21 個目錄（Character 7386 / Mob 1232 /
  Npc 953 / Map 935 / Reactor 338 / String 153 / Item 132 …）。
- 路徑搜尋只蓋索引鍵（img 層級），img 內部深層節點不進搜尋——853 萬節點全量建搜尋索引
  成本太高且收益低（值字串已可由 pool B 路徑在檢視器看到），有需要再開背景建索引。
- 快取：`catalog.json` 寫進 app data dir（約 1.3 MB），以 bundle size+mtime 驗證；
  實測**重建索引 41ms、快取命中載入 14ms**（catalog_demo 計時）。
- Bundle 改成 Mutex/Arc（原本 RefCell/Rc 不能進 tauri State）。
- UI 已套用 Harepacker-MPST design token 體系（`src/styles/theme.css` 核心 token 淺/深兩套、
  元件零 ad-hoc 色值、淺深色 toggle 跟隨系統 + localStorage，2026-07-24 截圖驗證）。

### Phase 4 — 圖片管線 ✅
- [x] spriteset Texture2D → PNG（含 `.resS` 讀取與格式解碼）
- [x] spritesheet atlas 反查切圖
- [x] 樹狀節點的字串值若是資產路徑（如 `Character/Afterimage/blank`），在檢視器裡直接渲染對應圖

實作備註（Phase 4）：

- `unity/texture.rs`：Texture2D → RGBA8 → PNG（自寫 PNG encoder，無 image crate 依賴）。
  **格式普查**：整批遊戲資料只有 `RGB24`（fmt 3，267 張）與 `RGBA32`（fmt 4，13,760 張）兩種，
  無 DXT/BC7/ETC；decoder 另備 ARGB32/BGRA32/Alpha8。像素來源：inline image data 或
  依 m_StreamData 從 `.resS` node 取（LZ4 區塊隨機存取，不全解）。
  **像素是 bottom-up**（OpenGL 慣例），atlas rect 也是同一座標系：先裁切、再對最終小圖 flip。
- **WZSS 索引格式（spritesheet 逆向定案）**：`.wzspritesheet` MonoBehaviour payload，
  header `u32 atlas 頁數` + 6 個 section triple（count/dataOff/tableOff），T2 = sprite rects
  （x/y/w/h 各 u32，16B/筆）；offset 80 起是 path 字串 +（對齊 4）count + 每頁「長度 u32(=32)
  + 32 hex GUID + 8 bytes 0」+ 剩餘長度，接著 `WZSS` magic + `u32 version(=4)`；
  magic 位置實務上直接搜 bytes，但**掃描窗要隨頁數放寬**（`Mob/8830000` 28 頁 → magic 在 1332）。
- **多頁 atlas 定案（2026-07-25，推翻「以頁高向下堆疊」）**：rect 座標是**單頁內**座標，
  頁號存在 frame 記錄的第 3 個 i32；而該頁號是 WZSS 自己的編號，與 atlas 檔名 `_N` 是兩套。
  換算表在 `magic + 8` 起、`頁數` 個 u32（`Skill/232` = [3,4,2,1,0]、`Effect/ItemEff` = [1,0]、
  `Effect/SetEff` = [0,1]）。GUID 清單本身是檔名順序（可用 Addressables `catalog.bin` 反查驗證），
  不是頁順序，不能拿來當對照。驗證方式：正確配對時貼圖上不透明像素應 100% 落在該頁 rect 聯集內
  ——186 個多頁 spritesheet 全數 0% 外溢。
- **WZSS frame 映射第二輪調查（2026-07-24，結論：不可由資料推導）**：
  - section2 = N 個 rect（x/y/w/h）+ N 組 UV float；section4 = canvas 數個 32-hex
    （推測 per-canvas sprite GUID）；section5 = rect 數個 64-hex（推測 packed sprite + atlas ID 對）。
  - **rects 是去重後的唯一 sprite**：Character/00002000 canvas=235 → rects=188；
    Face/00020116 canvas=35 → rects=34（oracle 尺寸指派顯示 blink/0 與 default 共用）。
  - rect 排列序經 v83 oracle 尺寸序列比對證實**不是** DFS / 字母序 / 記錄序 / GUID 排序（雜湊表迭代序）。
  - s4 與 s5 的 GUID 在任何位元組變換下零交集；路徑 ~500 種字串形式 × MD5/SHA 系 × UTF-8/16
    爆破零命中 → GUID 不透明，canvas→rect 連結無法從資料推導（很可能在 IL2CPP 程式碼，
    而 class name 全被雜湊、metadata 是非標準 FAB11BAF v39，暫不投入）。
  - 覆蓋率（`example sheet_coverage`，全 10,242 個 sheet）：rect==canvas 精準切圖 **2,601（25%）**、
    rect==1 單圖 80、整頁 fallback **7,559（74%）**。
- `image.rs`：`ImageIndex`（跟 Catalog 一起建/快取）把邏輯路徑映射到
  spritesheet（WZSS 索引 + atlas 頁）或 spriteset（.asset 清單 + Sprite + Texture2D）。
  `DataService::get_image(path) -> Option<Vec<u8>>`：per-img sheet 且 WZSS rect 數 == canvas 數時
  用 DFS canvas 序號切單幀；對不上就回退整頁輸出。
- GUI：`get_image` command（base64 PNG）+ NodeDetail 圖片預覽（棋盤格背景 token）。
- 驗證：14,027 張 PNG 全量輸出到 `out/sprites/`（spriteset 3,169 + spritesheet 切圖 10,857 + atlas 1），
  抽樣肉眼確認正確（Character 身體部件 atlas、Zakum 圖示、afterimage 揮砍特效）。
  `img_demo` example 走完整 service 路徑輸出 `out/imgdemo/*.png`。
  `cargo test` 26/26（新增格式解碼 / PNG roundtrip / crop / WZSS / set-asset payload 測試）。
- GUI 預覽已截圖驗證（`out/phase4_final.png`）：深連結 `#/Character/Afterimage/blank/axe`
  直接導航，右欄渲染出 axe 揮砍特效圖（棋盤格背景）。預覽觸發不限 canvas 節點
  （SubTree 節點若有對應 spritesheet 也會試取圖）。快取加 `version` 欄位（目前 2），
  舊快取（無圖片索引）自動作廢重建。

### Phase 5 — 匯出 ✅
- [x] 選取子樹 → 目錄樹形式的 JSON + PNG（`TamingMob/0004/info/speed` 這種可 grep、可 diff 的結構）
- [x] **明確不做** `.wz` 回轉——沒有需求支撐，而且是 lossy 的

實作備註（Phase 5）：

- `export.rs`：`DataService::export_subtree(path, out_dir)`。輸出 `<out>/<path>.json`
  （巢狀結構，葉值為純量、vector/Float2 攤成 `[x, y]`、canvas 節點帶 `"$type"/"$png"`）
  + `<out>/<path>/.../*.png`（canvas 圖，路徑與 JSON 的 `$png` 參照一致）。
  PNG 以 FNV-1a 內容雜湊去重（frame 映射未知的整頁輸出只會落盤一次）。
  TextAsset 節點直接輸出明文 JSON。兄弟同名自動加 `#2` 後綴。
- GUI：NodeDetail 標頭列「匯出 JSON+PNG」按鈕 → `export_subtree` command，
  輸出到 app data 的 `exports/` 目錄，完成後顯示路徑與統計。
- 驗收（`example export_demo`）：`TamingMob/0004` 7 節點（`info/speed: 80`、`fs: [10.0, 80.0]`）；
  `Character/Face/00020116` 260 節點 + PNG（去重後 1 張 atlas 頁）；
  `Mob/0100100`（藍蝸牛）`maxHP: 8`、`speed: -65` 與 v83 一致（負數整數，rg 可搜）；
  `MonsterBook` 12,623 節點大 img 正常。`cargo test` 27/27。
- 已知限制：spritesheet frame 映射未完全解出（WZSS rect 數 == canvas 數才切單幀），
  對不上時 PNG 是整頁 atlas——與 Phase 4 預覽同一行為。

---

## Phase 6 — Hardening / DRY / 維護性收尾 ✅

本階段不增加新的資料功能，目標是把 Phase 0–5 的成果整理成可長期維護、
能安全處理損壞輸入、且不會因大型圖片或匯出工作阻塞其他操作的正式版本。

### 正確性與安全

- [x] 自訂資料目錄開啟後，後續 command 沿用同一份 `DataService`
- [x] 匯出路徑逐段安全編碼，禁止 path traversal、Windows 保留名稱與同名 PNG 覆蓋
- [x] 所有 Unity/WZJS count、offset、size 使用合理上限與 checked arithmetic
- [x] 損壞 WZJS（含 nodeCount=0）、SerializedFile、Bundle、Texture2D 回傳錯誤而非 panic/OOM
- [x] spriteset 依 Sprite rect 裁切；inline Texture2D 使用精確 image-data offset
- [x] 非 Canvas 深層節點不錯誤顯示整頁 atlas
- [x] WZSS 索引不依賴 AssetBundle container 順序

### 快取、並行與效能

- [x] catalog cache 驗證完整 bundle manifest，能偵測新增、刪除與替換
- [x] catalog cache 原子寫入；損壞 cache 自動隔離並重建
- [x] cache 載入後驗證所有 `EntryLocation` invariant
- [x] `DataService` immutable 資料可跨 command 共用，tree cache 採細粒度鎖與真正 LRU
- [x] 開檔、圖片解碼、匯出移到 blocking worker，不長時間持有全域 service lock
- [x] 前端節點、圖片、搜尋請求防止舊回應覆蓋新狀態
- [x] 深連結與樹載入去除重複請求

### DRY 與模組邊界

- [x] MonoBehaviour / TextAsset 共用 canonical object parser，不再手刻多套 header
- [x] Catalog 與 ImageIndex 共用 SerializedFile 掃描結果，避免重複解析 metadata
- [x] `image.rs` 依 index / WZSS / render 責任拆分
- [x] `catalog.rs` 分離持久化索引與 runtime service（若不影響可讀性）
- [x] 集中 Canvas/SubTree type tag 與錯誤分類，移除明顯重複分支

### 工程化與發行

- [x] 加入 `.gitignore`、README、CI、fmt / Clippy / test / frontend build 指令
- [x] 研究用 examples 與正式驗收工具分流，預設測試不編譯 MapleLib oracle 工具
- [x] 修正 Cargo metadata、workspace profile 警告與 Clippy/fmt
- [x] Tauri bundle target 與實際可成功產出的安裝格式一致
- [x] 更新本文件已過時的 Phase 2 風險與最終驗收結果

### Phase 6 驗收

1. `cargo fmt --all -- --check`
2. `cargo clippy -p msclassic --all-targets -- -D warnings`
3. `cargo test -p msclassic --all-targets`
4. `npm run build`
5. malformed-input 與 export-path 單元測試不 panic，輸出不得離開測試暫存目錄
6. 快速切換節點／搜尋時，畫面只接受最後一次請求結果
7. 大型匯出期間，搜尋與節點讀取不被全域 service mutex 鎖住

驗收結果（2026-07-25）：上述項目全部完成。`cargo fmt`、正式與研究工具
Clippy（`-D warnings`）、43 個 Rust tests、研究 examples check、frontend production
build、`npm audit` 與 Tauri release/NSIS 打包全數通過；Cargo metadata 僅含正式
`msclassic` workspace member。

---

## WZSS canvas→rect 映射（第三輪逆向定案 ✅ 2026-07-25）

前兩輪的結論「映射不可由資料推導、只能在 IL2CPP 程式碼裡」是**錯的**。本輪解出全貌。

### header 真正的佈局

不是「6 個 section triple」。20 個 u32，offset 全部以 magic 為基準：

```text
[0] version   [1] 常數 8
[2..5)   UOL 字串池（count / blobOff / tableOff）
[5..7)   sprite pivot（count / off；8B/筆 = 正規化 2×f32，frame 記錄第 5 欄索引它）
[7..9)   sprite rect（count / off；16B/筆 = u32 x,y,w,h）
[9..11)  frame（count / off；20B/筆，第 4 個 i32 = rect index）
[11..13) link（count / off；16B/筆 = 槽號 / UOL 字串 index(-1 為重複圖) / ? / frame index）
[13..16) 節點鍵池（count / blobOff / tableOff）：每筆 32 hex
[16..19) 每個 frame 的 64 hex 池（count / blobOff / tableOff）
[19]     path 長度
```

### 突破點：節點鍵

**節點鍵 = `Guid(MD5(UTF8("<img 路徑>/<節點相對路徑>"))).ToString("N")`。**

前兩輪爆破 MD5/SHA 全數落空，是因為少了 .NET `Guid(byte[16])` 的位元組序——
前 4 bytes、次 2 bytes、再 2 bytes 各自反轉（little-endian 欄位），其餘 8 bytes 原序。
確認過程：

1. `hash32` 池的筆數恆等於該 img 的 **canvas + uol 節點數**（前兩輪誤判成 canvas 數）。
2. 池是**排序過的**（供二分搜尋），且分成兩段：前段 item 槽、後段別名槽。
3. 用「canvas 只有 1 個」的 img 蒐集 659 組確定的「路徑 → 鍵」樣本當字典爆破。
4. 命中後與 UOL 反推出的 ground truth 交叉驗證：`Character/Cap/01000003` 的
   `default/default`→rect 0（44×42）、`backDefault/default`→rect 2（41×42）完全一致。

il2cpp `global-metadata.dat` 也佐證了語意：類別名 `Msc.Core|WzSpriteSheetItem`、
`WzSpriteSheetLink`、`WzSpriteSheetHash` 與 section 分工一一對應（先前「class name
全被雜湊」的判讀只對 bundle 內的 MonoScript 成立，metadata 裡是明文）。
WZJS 的 pool B 另外留有每個 canvas 一筆、未被任何節點引用的
`<canvas 路徑>/$spritesheetitem` 字串，是轉檔器留下的 sprite 項目命名痕跡。

### 查表規則

```text
槽 = 二分搜尋(節點鍵池, 節點鍵)
槽 < frame 數        → frame[槽]（item 槽與 frame 一一對應）
槽 >= frame 數       → link 表中 [0]==槽 的記錄 → frame[link[3]]
                       （link[3] == frame 數是「空圖」sentinel）
frame[..][3]          → sprite rect index
```

### 覆蓋率（`example sheet_coverage`，走正式 API 全量實測）

| 指標 | 第二輪 | 第三輪 |
|---|---|---|
| canvas 精準切幀 | 25%（以 sheet 計） | **703,542 / 703,698 = 99.98%** |
| 整頁 atlas 回退 | 7,559 / 10,242 sheet（74%） | 156 個節點（23 個 sheet） |

殘留的 156 個節點在 WZSS 索引裡確實沒有鍵（其中 30 個是巢狀在 `map` 節點下的
異常 canvas，其餘如 `Effect/BasicEff/MainNotice/*`）——已確認不是路徑寫法問題
（WZJS pool B 存的路徑與 DFS 組出來的一致），遊戲自身的索引就沒收錄，維持回退整頁。

驗證工具：`example wzss_pool`（攤開單一 sheet 的所有 section 與雜湊池）、
`example wzss_verify`（全量比對節點鍵、槽位與 frame 恆等性）。

---

## 驗證方式

1. `cargo test` — WZJS fixture 測試（`blank` 等樣本硬編在 `wzjs/fixtures.rs`，不依賴遊戲安裝路徑）
2. `cargo run --features research-tools --bin index -- <game data path>` — 掃出 37 個 bundle 的組成表，跟本文件記錄的數字對得上（7386 / 935 / 1341 …）
3. `npm run tauri dev` — 開 GUI，導到 `Character/Afterimage/blank`，確認子節點是 `axe / crossBow / mace / …` 九項
4. 交叉驗證 — 用 Harepacker-MPST 開舊版 WZ 的同一路徑並排比對
5. 匯出一個子樹，用 `rg` 搜尋確認欄位值合理（例如怪物 `info/speed` 是負數整數）

---

## 風險

Phase 2 的格式風險已由 11,284/11,284 WZJS 全量解碼、fixture 與 v83 交叉比對消除。
目前只保留兩項明確的相容性限制：

- 僅保證目前驗證過的 WZJS v5 / Unity 6000.3 資料佈局；遊戲升版後會由嚴格
  count、offset、size 與 catalog version 檢查安全失敗並要求重建索引。
- spritesheet 的 canvas-to-rect 映射已於第三輪逆向解出（見下節），全量 canvas
  99.98% 可精準切幀；剩下 156 個節點在 WZSS 索引中沒有對應鍵，仍回退整張 atlas。

---

## 進度日誌

| 日期 | 內容 |
|---|---|
| 2026-07-24 | Phase 0 完成：37 個 bundle 全部解析、確認資料分成 TextAsset(明文 JSON) 與 MonoBehaviour(WZJS v5) 兩類、解出 WZJS 骨架與字串池結構、推翻前一輪的 IL2CPP 前提。計畫定案。 |
| 2026-07-24 | Phase 1 完成：Rust workspace 建立（`src-tauri` crate `msclassic`，`MapleLib-Rust` 以 junction 納入 member）。37/37 bundle 全掃成功（release 全掃 2.5s）；`json_c32a59ee` m_Container **7386** 筆 / 381.7 MB、`json_573635e1` **935** 筆 / 114.7 MB、`spriteset_b70292fe` Texture2D+Sprite 各 **1341** 個，全部對得上。dump 74 個 TextAsset JSON 全數合法（ItemTable / ReactorTable / Commodity / SetItemInfo / GlobalMarketData*）；`blank.bin` 768 bytes，offset 144 = `WZJS` + version 5。Texture2D 佈局以 AssetRipper/TypeTreeDumps 的 6000.3.16f1 dump 為準（無 m_ForcedFallbackFormat/m_DownscaleFallback，m_IsAlphaChannelOptional 緊接 m_Name），實測 completeImageSize = w×h×4 正確。`cargo test` 11 個單元測試全過。產出在 `out/text`、`out/mono`。dump 檔名對重名（含 Windows 大小寫不敏感，如 `wedding`/`Wedding`）自動加 path_id 後綴，json_* 的 MonoBehaviour payload 全數為 WZJS v5（offset 144 magic 全量掃描 0 miss，共 11,284 筆）。 |
| 2026-07-24 | Phase 2 完成：WZJS v5 解碼器定案（格式細節見上節）。關鍵突破：節點記錄其實從 offset 152 開始（Phase 0 以為的「2 個 u32」是 rec0 的前兩欄），欄位 = (type, nameA, value, childRangeStart, childCount, parent, pathB, childTableOff)；子節點佔連續 index 區間、order table 管順序。type 11 一度誤判為 inline int，交叉比對 v83 後確認是 pool C 字串（z/islot 列舉）。全量 11,284/11,284 解碼成功（853 萬節點，嚴格模式，4.5s）；v83 `Character.wz` 交叉比對 20/20 通過（blank 9 子節點 + Face/00020116 逐項 19 筆）。`cargo test` 14 個測試全過（3 個 WZJS fixture 精確比對）。oracle 來源：`E:\_原始資料\MS主程式\[v83] Full Custom Wz + CustomHD localhost.zip` 解出的 Character.wz（暫存 `E:\tmp\wzoracle\`）。 |
| 2026-07-24 | Phase 3 完成：Tauri 2 + React 19 + TS + Vite GUI 上線。後端 `catalog.rs`（索引 11,354 筆 / 快取 / 懶解碼，重建 41ms、快取命中 14ms），前端虛擬化樹（@tanstack/react-virtual）+ 搜尋列 + 右欄值檢視（canvas 留 Phase 4 佔位）。`npm run tauri dev` 實際啟動成功並截圖驗證（`out/phase3_shot*.png`）：搜尋 `Afterimage/blank` 自動展開並顯示 9 個子節點、`00020116` 顯示 25 個表情子節點。`cargo test` 14/14、`npm run build` 通過。坑：`cargo run` 需 `default-run = "msclassic"`（與 bin index 衝突）；Bundle 改 Mutex/Arc 才能進 tauri State。`npm run tauri build`：release exe 與 NSIS 安裝包成功（`target/release/bundle/nsis/經典服查看工具_0.1.0_x64-setup.exe`），MSI（WiX light.exe）失敗未追查（productName 非 ASCII 之嫌）；release exe 單獨啟動驗證過，快取命中即開。 |
| 2026-07-24 | UI 換裝：套用 Harepacker-MPST design system。新增 `src/styles/theme.css`（核心 token：app-bg/surface/panel/border/text/muted/subtle/accent/selection/focus-ring/radius/shadow/button-bg/menu-bg/disabled/backdrop-scrim/type-media/type-numeric/warning/danger/canvas-checkerboard，淺色+深色兩套 + 全域 140ms transition）；`src/styles.css` 全量 token 化（零 ad-hoc 色值，grep 驗證）；主題 toggle 跟隨 prefers-color-scheme + localStorage（`src/useTheme.ts`）。`npm run build` 通過、`cargo test` 14/14。tauri dev 截圖驗證淺（`out/theme_light.png`）深（`out/theme_a.png`）兩主題無破版。坑：PrintWindow 對 WebView2 偶發回傳舊 frame；點擊注入要先設 topmost 且注意雙螢幕座標（視窗曾被移出螢幕外）。 |
| 2026-07-24 | Phase 4 完成：圖片管線全通。`unity/texture.rs`（Texture2D→RGBA8→PNG 自寫 encoder；格式普查只有 RGB24 267 張 + RGBA32 13,760 張；bottom-up 像素先裁切再 flip）+ `image.rs`（ImageIndex 路徑映射 + WZSS 索引逆向定案 + `DataService::get_image`）。14,027 張 PNG 全量輸出 `out/sprites/` 抽樣肉眼正確；GUI `get_image` command + NodeDetail 預覽接上（棋盤格背景）。`cargo test` 26/26。本次 session 由主線接手完成（subagent 配額耗盡）；GUI 內預覽截圖驗證因使用者全螢幕遊戲中暫緩，service 路徑以 `img_demo` 驗證。 |
| 2026-07-24 | Phase 5 完成：匯出管線。`export.rs`（`DataService::export_subtree`：巢狀 JSON + canvas PNG 目錄樹、FNV-1a 去重、TextAsset 明文輸出）+ GUI 匯出按鈕（輸出到 app data `exports/`）。驗收（`export_demo`）：`TamingMob/0004`（speed 80 / fs [10,80]）、`Character/Face/00020116`（260 節點 + PNG）、`Mob/0100100` 藍蝸牛 `maxHP 8 / speed -65` 與 v83 一致、`MonsterBook` 12,623 節點。`cargo test` 27/27、`npm run build` 通過。**全部 Phase 0–5 完成。** 已知殘留：type 8 欄位語意依節點而定（`swim` 出現 int bits 當 f32 讀的 denormal，格式層無法區分）；spritesheet frame 映射僅 rect 數 == canvas 數時切單幀，否則整頁輸出。 |
| 2026-07-24 | Phase 4 GUI 驗收補完：深連結（`#/path` 自動導航）+ 預覽觸發放寬（SubTree 也試取圖）+ 快取加 version 欄位（舊快取自動作廢）後，`out/phase4_final.png` 截圖確認 app 內 `Character/Afterimage/blank/axe` 右欄直接渲染出揮砍特效圖。期間坑：vite port 佔用、游標被全螢幕遊戲限制在副螢幕無法注入點擊（最後用深連結繞過）、舊快取無 image index 導致 get_image 全 null。`cargo test` 27/27、`npm run build` 通過。 |
| 2026-07-24 | 第二輪收尾（double check + 殘留處理）：① **type 8 定案**——全量普查 2,003 筆中僅 8 筆（swim×6、recovery×2）是 int bits，新增 `Value::Int2` 以「denormal 即 int」啟發式分流，匯出/前端同步支援（swim 從 7e-45 變 [5,4]）。② **WZSS frame 映射深入逆向**——確認 section4=canvas 數個 32-hex GUID、section5=rect 數個 64-hex、rects 是去重唯一 sprite（235→188）、rect 序為雜湊表迭代序（非 DFS/字母/GUID 序）；~500 種路徑雜湊組合爆破零命中、s4/s5 GUID 零交集，結論：映射不可由資料推導（在 IL2CPP 程式碼裡），維持 rect==canvas 精準切圖（覆蓋 25%，2,601/10,242 sheet）+ 整頁 fallback。③ **GUI 預覽截圖驗證完成**——新增 `MSCLASSIC_INITIAL_PATH` 環境變數 + `initial_path` command 免鍵鼠導航，`out/phase4_gui_preview.png`（Afterimage 單幀切圖）與 `out/phase4_gui_face.png`（Face 整頁 fallback）確認渲染正確，預覽不限 canvas 節點。`cargo test` 27/27、`npm run build` 通過。 |
| 2026-07-25 | **WZSS canvas→rect 映射解出**（第三輪，推翻前兩輪「不可由資料推導」的結論）：節點鍵 = `Guid(MD5("<img 路徑>/<節點相對路徑>")).ToString("N")`，鍵池排序後供二分搜尋、item 槽對 frame、其餘走 link 表。關鍵在補上 .NET Guid 的位元組序（前 4/2/2 bytes 各自反轉），以及發現鍵池筆數 = canvas + uol 節點數而非 canvas 數。以「單 canvas img」蒐集 659 組確定樣本爆破命中，再與 UOL 反推的 ground truth 交叉驗證。全量覆蓋率從 25% 提升到 **703,542/703,698 = 99.98%**，整頁 atlas 回退從 7,559 個 sheet 降到 156 個節點。`image/wzss.rs` 新增節點鍵查表（`md5` 轉正式依賴），`render.rs` 以它為主線、UOL 反推降為備援；`sheet_coverage` 改走正式 API 量測，新增 `wzss_pool`／`wzss_verify` 研究工具。`cargo test` 49/49。 |
| 2026-07-25 | **UOL 節點開放圖片預覽/匯出**：先前只有 Canvas tag（18/19）能觸發 `get_image`；但 WZSS 節點鍵池本就收錄 UOL 節點（鍵池筆數 = canvas + uol），`rect_index_for_node` 對 UOL 自身相對路徑一樣能查到別名槽指回的 frame，不需額外邏輯。新增 `wzjs::node::is_image_capable_tag`（Canvas 或 UOL）取代三處 `is_canvas_tag` 守門（`image/render.rs` 的 `get_image_uncached`／`get_canvas_atlas_fallback`、`export.rs` 單檔 PNG 匯出），前端 `NodeDetail.tsx`／`App.tsx` 同步放行 `Uol` 型別。新增 `example uol_coverage` 走與 GUI 相同的 `get_image`→`get_canvas_atlas_fallback` 路徑做全量驗證：1,697,823 個 UOL 節點中 1,689,813（99.53%）精準切幀、8,010 回退整頁 atlas、零 panic／零硬錯誤。`cargo test` 49/49、`npm run build` 通過。 |
| 2026-07-25 | Phase 6 完成：解析器全面加入 count/offset/size 上限與 checked arithmetic；修正 Texture2D inline offset、Sprite rect 裁切、WZSS container 順序與非 Canvas fallback。Catalog 改為完整 manifest 驗證、原子寫入／備份／損壞隔離、EntryLocation 驗證與 per-root cache；DataService 採可共用 immutable service、真正 LRU tree/image cache，Tauri 重工作業移至 blocking worker。前端加入節點／圖片／搜尋 generation guard，去除深連結與樹重複請求。共用 canonical Unity object parser 與單次 SerializedFile 掃描，圖片拆為 index/WZSS/render、catalog 快取持久化分模組。工程面補齊 README、`.gitignore`、CI、NSIS/CSP、workspace 與研究／oracle 工具分流。最終 `cargo fmt`、正式及研究 Clippy `-D warnings`、43 tests、frontend build、`npm audit` 與 Tauri release/NSIS 打包全數通過。 |
| 2026-07-25 | **網頁版（WASM + OPFS）**：核心不動解析邏輯移植瀏覽器。① `unity/bundle.rs` 抽出 `RangeRead` trait（`Bundle::open_reader`），桌面 `File` 實作與 wasm 的 `JsRangeRead`（經 JS shim `syncReadAt` 走 `FileSystemSyncAccessHandle`）並存；Tauri 依賴收進 `desktop` feature（預設開），`--no-default-features` 可編 wasm32。② 新增 `web-wasm` crate（`msclassic-web`,cdylib）：manifest 驅動的 `Catalog::build_manifest`／`DataService::open_wasm`（size+mtime 驗證、快取走 OPFS 單檔）、7 個 wasm-bindgen 匯出對齊桌面 command 語意（`get_image` 直接回 PNG bytes、`export_file` 回 bytes、`export_subtree` 走 JS 收集器）；回傳走 serde_json→`JSON.parse`（u128 不相容 serde-wasm-bindgen）。③ 前端：`src/web/`（Worker + 手寫 RPC + OPFS 同步：16MB 分塊、quota 檢查、`storage.persist()`、manifest 比對跳過未變動檔）、`pickFolder.ts`（`showDirectoryPicker` 優先、`webkitdirectory` fallback，候選層級複刻 `resolve_data_root`）、`api.web.ts`（介面與 `api.ts` 完全一致，圖片轉 base64 讓 App 零改動、匯出走 Blob 下載、subtree 以 fflate 打包 zip）、`vite.config.web.ts`（alias 替換 api 層，outDir `dist-web/`）。Tauri 對話框集中進 api 層（`pickDataDirectory`/`pickExportPath`）。驗證：wasm32 clippy `-D warnings`、`npm run build:wasm` + `build:web` 產出完整、`npm run check` 全綠（桌面零回歸）、Node 層驗證 wasm→glue→shim 接線可呼叫。瀏覽器實機互動驗收待人工執行（步驟見 README「網頁版」）。 |
| 2026-07-25 | **多頁 atlas 切圖修正（`Skill/232/skill/2321008/icon` 這類「圖完全不對」與 `Effect/BasicEff/NoRed1/1` 這類「空白」的根因）**：舊 `cut_sprite` 假設多頁 atlas 是「以頁高向下堆疊」，用 `rect.y` 逐頁減頁高找頁——但 rect 座標其實是**單頁內**座標（全量實測 max(y+h) 恆 < 頁高），所以永遠切在第 0 頁，只有剛好在第 0 頁的 sprite 是對的。修正：① frame 記錄 20B 的第 3 個 i32 是 atlas 頁號（全量 10,242 個 sheet 驗證：max+1 == 頁數且每頁都被用到）；② 該頁號是 WZSS 自己的編號，需經 `magic + 8` 起的 `頁數` 個 u32 換算成檔名 `_N`（`Skill/232` = [3,4,2,1,0]）；③ `WzssIndex` 改回傳 `WzssSprite { page, rect }`（`rect_index_for_node` → `frame_index_for_node` + `sprite_for_frame`），`cut_sprite` 依頁號取頁、缺頁明確報錯；④ `render_sheet` 只解碼需要的那一頁（原本每次都解全部頁）。順手修好 `parse_wzss` 的 magic 掃描窗（固定 1024 → 依頁數放寬），`Mob/8830000`／`Mob/8830007`（28 頁）從整張 sheet 解析失敗變正常。驗證：像素級覆蓋率檢查（正確配對時貼圖不透明像素應 100% 落在該頁 rect 聯集內）186/186 個多頁 sheet 全數 0% 外溢；`sheet_coverage` 703,972/704,128 = 99.978%（前 703,542/703,698，增量來自新修好的兩個 sheet）；`uol_coverage` 800 sheet／53,723 個 UOL 節點 99.989% 精準切幀、零錯誤。`cargo test` 51/51、clippy `-D warnings` 全綠。 |
