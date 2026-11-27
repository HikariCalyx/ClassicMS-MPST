// msclassic web Worker:載入 wasm、執行 RPC、OPFS 同步。
//
// 主執行緒送 { id, method, args }；本 Worker 回 { id, ok, result | error }。
// 長時間工作(OPFS 複製、catalog build)全部在這裡跑,進度用
// { type: "progress", progress } 訊息回報,避免凍結 UI。
//
// OPFS 的 FileSystemSyncAccessHandle 只在 Worker 可用,因此 bundle 複製、
// sync handle 開啟、catalog 快取讀寫全部集中在這支檔案。

import init, * as wasm from "../../web-wasm/pkg/msclassic_web.js";
import type { ImportProgress } from "../api";

const ctx = self as unknown as DedicatedWorkerGlobalScope;

const COPY_CHUNK = 16 * 1024 * 1024;
const MANIFEST_SIDECAR = "bundles-manifest.json";
const CATALOG_CACHE_FILE = "catalog-cache.json";

interface BundleMeta {
  name: string;
  size: number;
  lastModified: number;
}

const ready = init({ module_or_path: new URL("../../web-wasm/pkg/msclassic_web_bg.wasm", import.meta.url) });

// 目前開著的 sync handle(re-import 時先關掉)。
let bundleHandles: FileSystemSyncAccessHandle[] = [];
let cacheHandle: FileSystemSyncAccessHandle | null = null;

// 開啟流程互斥鎖:openCached / importBundles 同時間只允許一個。
// OPFS 的 sync handle 對同一檔案全站互斥,兩個 open 並發時
// createSyncAccessHandle 會互撞(啟動自動載入 + 手動重連、連點等)。
let openQueue: Promise<unknown> = Promise.resolve();

function enqueueOpen<T>(task: () => Promise<T>): Promise<T> {
  const run = openQueue.then(task, task);
  openQueue = run.catch(() => undefined);
  return run;
}

/** 需要給使用者看的錯誤代碼;訊息由主執行緒依介面語言組字(見 client.ts)。 */
export type WorkerErrorCode = "storageBusy" | "storageFull";

class WorkerError extends Error {
  readonly code: WorkerErrorCode;
  readonly params: Record<string, string>;

  constructor(code: WorkerErrorCode, params: Record<string, string> = {}) {
    super(code);
    this.code = code;
    this.params = params;
  }
}

/** createSyncAccessHandle 的互斥錯誤換成可操作的提示(最常見:另一個分頁也開著本機資料)。 */
async function createSyncHandle(
  fileHandle: FileSystemFileHandle,
): Promise<FileSystemSyncAccessHandle> {
  try {
    return await fileHandle.createSyncAccessHandle();
  } catch (error) {
    const name = error instanceof DOMException ? error.name : "";
    const message = error instanceof Error ? error.message : String(error);
    if (name === "NoModificationAllowedError" || /Access Handles? cannot be created/i.test(message)) {
      throw new WorkerError("storageBusy");
    }
    throw error;
  }
}

function report(progress: ImportProgress): void {
  ctx.postMessage({ type: "progress", progress });
}

function formatMiB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
}

function closeHandles(): void {
  for (const handle of bundleHandles) {
    try {
      handle.close();
    } catch {
      // 忽略:關閉失敗不影響重建
    }
  }
  bundleHandles = [];
  if (cacheHandle) {
    try {
      cacheHandle.close();
    } catch {
      // 同上
    }
    cacheHandle = null;
  }
}

/** 讀 OPFS 內已記錄的 bundle manifest(上次複製時寫入的 sidecar)。 */
async function readStoredManifest(
  root: FileSystemDirectoryHandle,
): Promise<Record<string, { size: number; lastModified: number }>> {
  try {
    const handle = await root.getFileHandle(MANIFEST_SIDECAR);
    const text = await (await handle.getFile()).text();
    return JSON.parse(text) as Record<string, { size: number; lastModified: number }>;
  } catch {
    return {};
  }
}

/** 讀 sidecar 並確認 OPFS 內的 bundle 完整(存在且大小一致);不完整回 null。 */
async function cachedManifest(): Promise<BundleMeta[] | null> {
  try {
    const root = await navigator.storage.getDirectory();
    const stored = await readStoredManifest(root);
    const names = Object.keys(stored).sort();
    if (names.length === 0) return null;
    const manifest: BundleMeta[] = [];
    for (const name of names) {
      const file = await (await root.getFileHandle(name)).getFile();
      if (file.size !== stored[name].size) return null;
      manifest.push({ name, size: file.size, lastModified: stored[name].lastModified });
    }
    return manifest;
  } catch {
    // OPFS 不可用或檔案被瀏覽器清掉:一律視為無快取。
    return null;
  }
}

/** 啟動自動載入:資料已在 OPFS,直接開啟,不重選資料夾。無快取時回 null。 */
async function openCached(): Promise<unknown | null> {
  const manifest = await cachedManifest();
  if (!manifest) return null;
  await openSyncHandles(manifest);
  report({ phase: "catalog", percent: 100, stage: "loadingIndex" });
  return wasm.open(manifest);
}

/** 把異動的 bundle 複製進 OPFS(逐檔分塊 + 進度回報),回傳排序後的 manifest。 */
async function syncBundlesToOpfs(files: File[]): Promise<BundleMeta[]> {
  // 同一檔案同時間只能有一個 sync handle:已開啟資料再重新匯入時,
  // 這裡要覆寫的 bundle 仍被 bundleHandles 握著,必須先關掉才能
  // createSyncAccessHandle / removeEntry。匯入成功後 openSyncHandles 會重開。
  closeHandles();
  const sorted = [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const manifest: BundleMeta[] = sorted.map((f) => ({
    name: f.name,
    size: f.size,
    lastModified: f.lastModified,
  }));

  const root = await navigator.storage.getDirectory();
  try {
    // 失敗(不支援或被拒)不擋流程,只是快取可能被瀏覽器清掉。
    await navigator.storage.persist();
  } catch {
    // 忽略
  }

  const stored = await readStoredManifest(root);
  const changed = sorted.filter(
    (f) => stored[f.name]?.size !== f.size || stored[f.name]?.lastModified !== f.lastModified,
  );

  // 刪掉 OPFS 中不再需要的舊 bundle。
  const wanted = new Set(manifest.map((m) => m.name));
  for await (const name of root.keys()) {
    if (name.endsWith(".bundle") && !wanted.has(name)) {
      await root.removeEntry(name);
    }
  }

  if (changed.length === 0) {
    report({ phase: "copy", percent: 100, stage: "unchanged" });
    return manifest;
  }

  // 空間檢查:只看需要新寫入的量。
  const needed = changed.reduce((sum, f) => sum + f.size, 0);
  const estimate = await navigator.storage.estimate();
  if (estimate.quota != null && estimate.usage != null) {
    const available = estimate.quota - estimate.usage;
    if (needed > available) {
      throw new WorkerError("storageFull", {
        needed: formatMiB(needed),
        available: formatMiB(available),
      });
    }
  }

  const totalBytes = changed.reduce((sum, f) => sum + f.size, 0);
  let copiedBytes = 0;
  let fileIndex = 0;
  for (const file of changed) {
    fileIndex += 1;
    const fileHandle = await root.getFileHandle(file.name, { create: true });
    const sync = await createSyncHandle(fileHandle);
    try {
      sync.truncate(0);
      let offset = 0;
      while (offset < file.size) {
        const buffer = await file.slice(offset, offset + COPY_CHUNK).arrayBuffer();
        sync.write(new Uint8Array(buffer), { at: offset });
        offset += buffer.byteLength;
        const percent = ((copiedBytes + offset) / totalBytes) * 100;
        report({
          phase: "copy",
          percent,
          stage: "copying",
          file: file.name,
          fileIndex,
          fileCount: changed.length,
        });
      }
      sync.flush();
    } finally {
      sync.close();
    }
    copiedBytes += file.size;
  }

  // 寫入 manifest sidecar,下次比對用。
  // 注意:Safari/Firefox 不支援 createWritable,這裡與 bundle 複製一樣
  // 走 Worker 專用的 createSyncAccessHandle。
  const sidecar = await root.getFileHandle(MANIFEST_SIDECAR, { create: true });
  const sync = await createSyncHandle(sidecar);
  try {
    const record: Record<string, { size: number; lastModified: number }> = {};
    for (const m of manifest) record[m.name] = { size: m.size, lastModified: m.lastModified };
    const bytes = new TextEncoder().encode(JSON.stringify(record));
    sync.truncate(0);
    sync.write(bytes, { at: 0 });
    sync.flush();
  } finally {
    sync.close();
  }

  return manifest;
}

/** 依 manifest 開啟所有 bundle 與 catalog 快取的 sync handle 並注入 shim。 */
async function openSyncHandles(manifest: BundleMeta[]): Promise<void> {
  closeHandles();
  const root = await navigator.storage.getDirectory();
  const handles: FileSystemSyncAccessHandle[] = [];
  let cache: FileSystemSyncAccessHandle | null = null;
  try {
    for (const meta of manifest) {
      const fileHandle = await root.getFileHandle(meta.name);
      handles.push(await createSyncHandle(fileHandle));
    }
    const cacheFile = await root.getFileHandle(CATALOG_CACHE_FILE, { create: true });
    cache = await createSyncHandle(cacheFile);
  } catch (error) {
    // 中途失敗時已開的 handle 還不會被 closeHandles 追蹤(bundleHandles 尚未賦值),
    // 必須就地關掉,否則這些孤兒 handle 會讓之後每次重試都撞到自己。
    for (const handle of handles) {
      try {
        handle.close();
      } catch {
        // 忽略:關閉失敗不影響錯誤回報
      }
    }
    try {
      cache?.close();
    } catch {
      // 同上
    }
    throw error;
  }
  bundleHandles = handles;
  cacheHandle = cache;
  wasm.set_sync_handles(handles, cache);
}

async function importBundles(files: File[]): Promise<unknown> {
  const manifest = await syncBundlesToOpfs(files);
  await openSyncHandles(manifest);
  report({ phase: "catalog", percent: 100, stage: "buildingIndex" });
  // wasm open 是同步的(catalog build 可能數十秒),在 Worker 跑不會凍結 UI。
  return wasm.open(manifest);
}

function exportSubtree(path: string) {
  const count = wasm.export_subtree(path) as number;
  return { count, files: wasm.take_exported_files() };
}

async function dispatch(method: string, args: unknown[]): Promise<unknown> {
  // checkCached 只看 OPFS 中繼資料,不需等 wasm 初始化(啟動探測用)。
  if (method === "checkCached") return (await cachedManifest()) !== null;
  await ready;
  switch (method) {
    case "openCached":
      return enqueueOpen(openCached);
    case "importBundles":
      return enqueueOpen(() => importBundles(args[0] as File[]));
    case "listChildren":
      return wasm.list_children(args[0] as string);
    case "getNode":
      return wasm.get_node(args[0] as string);
    case "getImage":
      return wasm.get_image(args[0] as string);
    case "getAudio":
      return wasm.get_audio(args[0] as string);
    case "getItemTooltip":
      return wasm.get_item_tooltip(args[0] as string);
    case "getItemTooltipById":
      return wasm.get_item_tooltip_by_id(args[0] as number);
    case "getCommodityItems":
      return wasm.get_commodity_items();
    case "getMonsterBook":
      return wasm.get_monster_book();
    case "getMobDetail":
      return wasm.get_mob_detail(args[0] as number);
    case "getMapBgmIndex":
      return wasm.get_map_bgm_index();
    case "getSkillBook":
      return wasm.get_skill_book();
    case "getSkillDetail":
      return wasm.get_skill_detail(args[0] as string, args[1] as string);
    case "getQuestBook":
      return wasm.get_quest_book();
    case "getQuestDetail":
      return wasm.get_quest_detail(args[0] as string);
    case "getAvatarMeta":
      return wasm.get_avatar_meta();
    case "getAvatarEmotions":
      return wasm.get_avatar_emotions(args[0] as string);
    case "getAvatarEquipment":
      return wasm.get_avatar_equipment();
    case "getAvatarFrames":
      return wasm.get_avatar_frames(
        args[0],
        args[1] as string,
        args[2] as string,
        args[3] as boolean,
        args[4] as boolean,
      );
    case "getPetList":
      return wasm.get_pet_list();
    case "getPetEquipList":
      return wasm.get_pet_equip_list();
    case "getPetFrames":
      return wasm.get_pet_frames(
        args[0] as string,
        (args[1] as string | null | undefined) ?? null,
        args[2] as string,
      );
    case "setRegion":
      return wasm.set_region(args[0] as string);
    case "searchNodes":
      return wasm.search_nodes(
        args[0] as string,
        (args[1] as string | null | undefined) ?? null,
        (args[2] as number | undefined) ?? null,
      );
    case "exportFile":
      return wasm.export_file(args[0] as string, args[1] as string);
    case "exportSubtree":
      return exportSubtree(args[0] as string);
    default:
      throw new Error(`未知 RPC method: ${method}`);
  }
}

interface RpcRequest {
  id: number;
  method: string;
  args: unknown[];
}

ctx.onmessage = (event: MessageEvent<RpcRequest>) => {
  const { id, method, args } = event.data;
  dispatch(method, args).then(
    (result) => ctx.postMessage({ id, ok: true, result }),
    (error: unknown) =>
      ctx.postMessage({
        id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        ...(error instanceof WorkerError ? { code: error.code, params: error.params } : {}),
      }),
  );
};
