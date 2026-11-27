// Hosted 資料集的共用核心：api.hosted.ts 與之後的功能模組（tooltip/怪物/技能/紙娃娃）
// 共用的資料根常數、fetch、catalog、tree、strings、圖片、UOL 機制。
// 只放內部機制；API 契約型別與契約函式本身留在 src/api.hosted.ts。
//
// 資料集結構（見 docs/HOSTED_DATA.md）：
//   index.json    版本與統計
//   catalog.json  {"entries": {"<img 邏輯路徑>": class_id}}（114=WZJS img、49=TextAsset、83=AudioClip）
//   tree/<img>.json   每 img 一棵 WZJS 節點樹，canvas 節點內嵌 rect/origin metadata
//   strings/<路徑>.json  TextAsset 明文
//   sheets/<sheet>_<page>.webp  atlas 頁（rect 的 y 是 Unity bottom-up 座標，切圖要換算）

import type { ChildEntry, ImagePreviewResult, Value } from "../api.hosted";
import { t } from "../i18n";

// ---------------------------------------------------------------------------
// 資料集常數（vite define 注入，見 vite.config.hosted.ts / src/vite-env.d.ts）
// ---------------------------------------------------------------------------

export const DATA_ROOT = `${__HOSTED_DATA_BASE__}/${__HOSTED_DATA_VERSION__}`;
/** 雲端資料集的顯示名稱（狀態列與歡迎頁用，跟隨介面語言）。 */
export const dataLabel = (version: string = __HOSTED_DATA_VERSION__) =>
  t("data.cloudLabel", { version });
const HOSTED_JSON_CACHE_REVISION = "20260805-1";

export const CLASS_WZJS_IMG = 114;
export const CLASS_TEXT_ASSET = 49;
export const CLASS_AUDIO_CLIP = 83;

// ---------------------------------------------------------------------------
// tree JSON 的節點形狀（pipeline 產物；value 的 JSON 與前端 Value 型別一致）
// ---------------------------------------------------------------------------

export interface TreeCanvas {
  sheet: string;
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
  ox: number;
  oy: number;
}

export interface TreeNode {
  name: string;
  tag: number;
  value: Value;
  canvas?: TreeCanvas;
  children?: TreeNode[];
}

// ---------------------------------------------------------------------------
// 記憶體狀態：catalog、目錄 trie、tree / strings / sheet / 切圖快取
// ---------------------------------------------------------------------------

export interface CatalogState {
  entries: Record<string, number>;
  root: DirEntry;
}

export interface DirEntry {
  /** 此節點本身是 catalog entry 時的 class_id；純目錄為 null。 */
  classId: number | null;
  children: Map<string, DirEntry>;
  /** 底下的 entry 總數（含 TextAsset/AudioClip，對齊 Rust list_index_children）。 */
  imgCount: number;
}

let catalogState: CatalogState | null = null;

/** img 路徑 → tree Promise（fetch 去重；失敗時清掉讓下次重試）。 */
const treeCache = new Map<string, Promise<TreeNode>>();
/** 已成功載入的 tree（搜尋節點名用）。 */
export const resolvedTrees = new Map<string, TreeNode>();
/** TextAsset 路徑 → 明文 Promise（strings/<path>.json，fetch 去重）。 */
const textAssetCache = new Map<string, Promise<string>>();
/** "<sheet>_<page>" → ImageBitmap（整張 sheet 只抓一次）。 */
const sheetCache = new Map<string, Promise<ImageBitmap>>();
/** 整頁 atlas 的 base64 PNG（atlas fallback 用，避免重複 encode）。 */
const sheetPagePngCache = new Map<string, Promise<string>>();
/** path → 切圖結果（資料集依版本不可變，整個 session 快取）。 */
const imageResultCache = new Map<string, Promise<ImagePreviewResult | null>>();

export async function fetchChecked(
  url: string,
  options: { reload?: boolean } = {},
): Promise<Response> {
  const requestUrl = new URL(url, window.location.href);
  if (requestUrl.pathname.endsWith(".json")) {
    // 繞過舊 Service Worker 以原 URL 留下的損壞回應。
    requestUrl.searchParams.set("data-revision", HOSTED_JSON_CACHE_REVISION);
  }
  const response = await fetch(requestUrl, {
    cache: options.reload ? "reload" : "default",
  });
  if (!response.ok) {
    throw new Error(t("data.error.fetchFailed", { status: response.status, url }));
  }
  return response;
}

/** openDataDir 載入 catalog.json 後呼叫，建立記憶體索引。 */
export function initCatalog(entries: Record<string, number>): CatalogState {
  catalogState = { entries, root: buildDirIndex(entries) };
  return catalogState;
}

export function requireCatalog(): CatalogState {
  if (!catalogState) throw new Error(t("data.error.notLoaded"));
  return catalogState;
}

/** 由 catalog entries 建目錄 trie；imgCount 計算對齊 Rust list_index_children。 */
export function buildDirIndex(entries: Record<string, number>): DirEntry {
  const root: DirEntry = { classId: null, children: new Map(), imgCount: 0 };
  for (const [path, classId] of Object.entries(entries)) {
    const segments = path.split("/");
    let node = root;
    node.imgCount += 1;
    for (const segment of segments) {
      let child = node.children.get(segment);
      if (!child) {
        child = { classId: null, children: new Map(), imgCount: 0 };
        node.children.set(segment, child);
      }
      child.imgCount += 1;
      node = child;
    }
    node.classId = classId;
  }
  return root;
}

export function walkDir(root: DirEntry, path: string): DirEntry | null {
  let node = root;
  if (path === "") return node;
  for (const segment of path.split("/")) {
    const child = node.children.get(segment);
    if (!child) return null;
    node = child;
  }
  return node;
}

/** 目錄層的 ChildEntry 清單（對齊 Rust list_index_children：BTreeMap 依路徑排序）。 */
export function listDirChildren(state: CatalogState, path: string): ChildEntry[] {
  const dir = walkDir(state.root, path);
  if (!dir) throw new Error(t("data.error.dirNotFound", { path: path || t("data.error.rootDir") }));
  const prefix = path === "" ? "" : `${path}/`;
  return [...dir.children.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, child]) =>
      child.classId != null
        ? { kind: "Img", name, path: `${prefix}${name}`, class_id: child.classId }
        : { kind: "Category", name, path: `${prefix}${name}`, img_count: child.imgCount },
    );
}

/** 對齊 Rust split_img_prefix：從完整路徑逐層截尾，找最長的 catalog entry 前綴。 */
export function splitImgPrefix(
  entries: Record<string, number>,
  path: string,
): [string, string] | null {
  let p = path;
  for (;;) {
    if (Object.prototype.hasOwnProperty.call(entries, p)) {
      const inner = path.slice(p.length).replace(/^\//, "");
      return [p, inner];
    }
    const index = p.lastIndexOf("/");
    if (index === -1) return null;
    p = p.slice(0, index);
  }
}

/** 懶載入並快取一個 img 的 tree JSON（以 img 路徑為鍵，fetch 去重）。 */
export function loadTree(imgPath: string): Promise<TreeNode> {
  let cached = treeCache.get(imgPath);
  if (!cached) {
    cached = fetchChecked(`${DATA_ROOT}/tree/${imgPath}.json`)
      .then((response) => response.json() as Promise<TreeNode>)
      .then((tree) => {
        resolvedTrees.set(imgPath, tree);
        return tree;
      });
    cached.catch(() => {
      treeCache.delete(imgPath);
    });
    treeCache.set(imgPath, cached);
  }
  return cached;
}

/** 在 tree 內走訪內部路徑（inner 不含 img 根名稱，從根的 children 開始）。 */
export function findNode(root: TreeNode, inner: string): TreeNode | null {
  if (inner === "") return root;
  let node = root;
  for (const segment of inner.split("/")) {
    const child = node.children?.find((c) => c.name === segment);
    if (!child) return null;
    node = child;
  }
  return node;
}

/** 節點名排序：對齊 Rust cmp_node_names（純數字依數值排最前，其餘不分大小寫字母序）。 */
export function cmpNodeNames(a: string, b: string): number {
  const numA = /^\d+$/.test(a) ? Number(a) : null;
  const numB = /^\d+$/.test(b) ? Number(b) : null;
  if (numA != null && numB != null) return numA - numB || (a < b ? -1 : a > b ? 1 : 0);
  if (numA != null) return -1;
  if (numB != null) return 1;
  const lowerA = a.toLowerCase();
  const lowerB = b.toLowerCase();
  if (lowerA !== lowerB) return lowerA < lowerB ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** tree 節點的 ChildEntry 清單（對齊 cmpNodeNames 排序）。 */
export function nodeChildren(
  _state: CatalogState,
  imgKey: string,
  inner: string,
  node: TreeNode,
): ChildEntry[] {
  const base = inner === "" ? imgKey : `${imgKey}/${inner}`;
  return [...(node.children ?? [])]
    .sort((a, b) => cmpNodeNames(a.name, b.name))
    .map((child) => ({
      kind: "Node",
      name: child.name,
      path: `${base}/${child.name}`,
      type_tag: child.tag,
      has_children: (child.children?.length ?? 0) > 0,
    }));
}

/**
 * UOL 解析：對齊 image/render.rs 的 resolve_uol_target。
 * UOL 相對於該 UOL property 的父節點；source 是 UOL 節點在 img 內的相對路徑
 * （不含 img 根名稱）。解析失敗（跳出根）回 null。
 */
export function resolveUolTarget(source: string, uol: string): string | null {
  const segments = source.split("/").filter((part) => part !== "");
  if (segments.length === 0) return null;
  segments.pop();
  for (const part of uol.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (segments.length === 0) return null;
      segments.pop();
    } else {
      segments.push(part);
    }
  }
  return segments.join("/");
}

export const UOL_RESOLVE_LIMIT = 8;

/** 解析 UOL 鏈（目標本身可能又是 UOL），回最終非 UOL 節點；解析失敗回 null。 */
export function resolveUolChain(root: TreeNode, inner: string): TreeNode | null {
  let path = inner;
  for (let i = 0; i < UOL_RESOLVE_LIMIT; i += 1) {
    const node = findNode(root, path);
    if (!node) return null;
    if (node.value.type !== "Uol") return node;
    const next = resolveUolTarget(path, node.value.value);
    if (next == null) return null;
    path = next;
  }
  return null;
}

// ---------------------------------------------------------------------------
// strings：TextAsset 明文
// ---------------------------------------------------------------------------

/** 懶載入並快取一個 TextAsset 的明文（strings/<path>.json，fetch 去重）。 */
export function loadTextAsset(path: string): Promise<string> {
  let cached = textAssetCache.get(path);
  if (!cached) {
    cached = fetchChecked(`${DATA_ROOT}/strings/${path}.json`).then((response) =>
      response.text(),
    );
    cached.catch(() => {
      textAssetCache.delete(path);
    });
    textAssetCache.set(path, cached);
  }
  return cached;
}

// ---------------------------------------------------------------------------
// 圖片：sheet 載入 + canvas 切圖
// ---------------------------------------------------------------------------

export function loadSheet(sheet: string, page: number): Promise<ImageBitmap> {
  const key = `${sheet}_${page}`;
  let cached = sheetCache.get(key);
  if (!cached) {
    cached = fetchChecked(`${DATA_ROOT}/sheets/${key}.webp`)
      .then((response) => response.blob())
      .then((blob) => createImageBitmap(blob));
    cached.catch(() => {
      sheetCache.delete(key);
    });
    sheetCache.set(key, cached);
  }
  return cached;
}

export function canvasToBase64(canvas: HTMLCanvasElement): string {
  const dataUrl = canvas.toDataURL("image/png");
  return dataUrl.slice(dataUrl.indexOf(",") + 1);
}

/** 依 canvas metadata 從 sheet 切出單幀 PNG（rect 的 y 是 bottom-up，要換算）。 */
export async function cutSprite(meta: TreeCanvas): Promise<string> {
  const bitmap = await loadSheet(meta.sheet, meta.page);
  // Unity bottom-up → canvas top-down。
  const yTop = bitmap.height - meta.y - meta.h;
  const canvas = document.createElement("canvas");
  canvas.width = meta.w;
  canvas.height = meta.h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error(t("data.error.canvasContext"));
  ctx.drawImage(bitmap, meta.x, yTop, meta.w, meta.h, 0, 0, meta.w, meta.h);
  return canvasToBase64(canvas);
}

/** 整頁 atlas 轉 base64 PNG（canvas 節點缺切圖索引時的 fallback）。 */
export function sheetPagePng(sheet: string, page: number): Promise<string> {
  const key = `${sheet}_${page}`;
  let cached = sheetPagePngCache.get(key);
  if (!cached) {
    cached = loadSheet(sheet, page).then((bitmap) => {
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error(t("data.error.canvasContext"));
      ctx.drawImage(bitmap, 0, 0);
      return canvasToBase64(canvas);
    });
    cached.catch(() => {
      sheetPagePngCache.delete(key);
    });
    sheetPagePngCache.set(key, cached);
  }
  return cached;
}

export async function getImageUncached(path: string): Promise<ImagePreviewResult | null> {
  const state = requireCatalog();
  const split = splitImgPrefix(state.entries, path);
  if (!split) return null;
  const [imgKey, inner] = split;
  if (state.entries[imgKey] !== CLASS_WZJS_IMG) return null;
  const tree = await loadTree(imgKey);

  // img 根：桌面版會輸出整張 atlas 第一頁；hosted 比照（sheet 不存在就回 null）。
  if (inner === "") {
    try {
      const base64 = await sheetPagePng(imgKey, 0);
      return { base64, mode: "atlas", note: t("data.note.imgRootAtlas") };
    } catch {
      return null;
    }
  }

  let node = findNode(tree, inner);
  // UOL 節點：前端自行解析連結（同一 img tree 內），目標是 canvas 就切。
  if (node?.value.type === "Uol") {
    node = resolveUolChain(tree, inner);
  }
  if (!node) return null;
  // 桌面版圖片只屬於 Canvas(18/19) 與 UOL(12)；UOL 已解析，這裡只看 canvas 家族。
  if (node.tag !== 18 && node.tag !== 19) return null;

  if (node.canvas) {
    const base64 = await cutSprite(node.canvas);
    return { base64, mode: "exact", note: null };
  }
  // canvas 節點但 pipeline 沒解出 rect（約 0.06%）：退回整張 atlas 頁。
  try {
    const base64 = await sheetPagePng(imgKey, 0);
    return { base64, mode: "atlas", note: t("data.note.noFrameIndex") };
  } catch {
    return null;
  }
}

/** 切圖結果快取版的 getImage（API 契約由 api.hosted.ts re-export）。 */
export function getImage(path: string): Promise<ImagePreviewResult | null> {
  let cached = imageResultCache.get(path);
  if (!cached) {
    cached = getImageUncached(path);
    cached.catch(() => {
      imageResultCache.delete(path);
    });
    imageResultCache.set(path, cached);
  }
  return cached;
}
