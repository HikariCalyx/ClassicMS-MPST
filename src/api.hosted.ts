// Hosted 版 api 委派層：與 src/api.ts / api.web.ts 完全相同的 export 介面，
// 內部依「資料來源」在兩個後端之間 runtime 切換——
//   cloud：./hosted/backend，純 HTTP fetch 預處理資料集（R2/Workers）
//   local（預設）：./api.web，WASM worker 讀使用者本機資料夾（與 dist-web 同源）
// vite.config.hosted.ts 用 alias 把所有 "./api" / "../api" import 換成本檔。
//
// 來源偏好存 localStorage（msclassic-data-source），缺省 local；
// 由 App.tsx 右上角的來源切換器透過 getDataSource / setDataSource 操作。

// 舊版曾以 Service Worker 永久快取 /data/，損壞的 JSON 也會被持續回放。
// 新版改用瀏覽器原生 HTTP 快取；啟動時清除所有舊 cache 並只註銷本站的舊 Worker。
const HOSTED_CACHE_PREFIX = "msclassic-hosted";
const HOSTED_SERVICE_WORKER_PATH = "/sw-hosted.js";

async function retireLegacyHostedCaching(): Promise<void> {
  if (import.meta.env.DEV) return;

  const tasks: Promise<unknown>[] = [];
  if ("caches" in window) {
    tasks.push(
      window.caches.keys().then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith(HOSTED_CACHE_PREFIX))
            .map((key) => window.caches.delete(key)),
        ),
      ),
    );
  }
  if ("serviceWorker" in navigator) {
    tasks.push(
      navigator.serviceWorker.getRegistrations().then((registrations) =>
        Promise.all(
          registrations
            .filter((registration) =>
              [registration.installing, registration.waiting, registration.active].some(
                (worker) =>
                  worker !== null &&
                  new URL(worker.scriptURL).pathname === HOSTED_SERVICE_WORKER_PATH,
              ),
            )
            .map((registration) => registration.unregister()),
        ),
      ),
    );
  }

  await Promise.allSettled(tasks);
}

import * as hosted from "./hosted/backend";
import * as web from "./api.web";
import { t } from "./i18n";

export type {
  AudioResult,
  AvatarFrame,
  AvatarFrames,
  AvatarLayer,
  AvatarMeta,
  BgmMapGroup,
  BgmMapRef,
  ChildEntry,
  CommodityItem,
  DropRef,
  EquipItem,
  ExportDialogOptions,
  ExportFormat,
  ExportStats,
  FileExportResult,
  ImagePreviewResult,
  ImportProgress,
  ItemTooltip,
  MapRef,
  MobDetail,
  MobDropItem,
  MobFrame,
  MonsterSummary,
  NodeDetail,
  OpenInfo,
  OpenResult,
  PartInput,
  PetEquipInfo,
  PetInfo,
  QuestDetail,
  QuestDialogueStage,
  QuestItemRef,
  QuestMobRef,
  QuestRef,
  QuestSummary,
  SearchHit,
  SkillCategory,
  SkillDetail,
  SkillJobGroup,
  SkillSummary,
  SkinInfo,
  TooltipStat,
  Value,
} from "./hosted/backend";

import type {
  AudioResult,
  AvatarFrames,
  AvatarMeta,
  BgmMapGroup,
  ChildEntry,
  CommodityItem,
  EquipItem,
  ExportDialogOptions,
  ExportFormat,
  ExportStats,
  FileExportResult,
  ImagePreviewResult,
  ImportProgress,
  ItemTooltip,
  MobDetail,
  MonsterSummary,
  NodeDetail,
  OpenResult,
  PartInput,
  PetEquipInfo,
  PetInfo,
  QuestDetail,
  QuestSummary,
  SearchHit,
  SkillDetail,
  SkillJobGroup,
  Value,
} from "./hosted/backend";

// ---------------------------------------------------------------------------
// 資料來源切換（App.tsx 右上角切換器用；桌面/web 版對應實作為單一來源）
// ---------------------------------------------------------------------------

export type DataSource = "cloud" | "local";

const DATA_SOURCE_KEY = "msclassic-data-source";

/** 目前的資料來源；localStorage 沒記錄時預設本機資料夾。 */
export const getDataSource = (): DataSource =>
  window.localStorage.getItem(DATA_SOURCE_KEY) === "cloud" ? "cloud" : "local";

export const setDataSource = (source: DataSource): void => {
  window.localStorage.setItem(DATA_SOURCE_KEY, source);
};

/** hosted 版支援雙來源切換（桌面/web 版恆 false，不出現切換器）。 */
export const supportsDataSourceSwitch = (): boolean => true;

// 委派在呼叫當下讀 mode：切換來源後的新呼叫直接打到新後端；
// 切換前已在進行中的舊請求由 App 的 datasetGenerationRef 丟棄結果。
const backend = () => (getDataSource() === "local" ? web : hosted);

// ---------------------------------------------------------------------------
// export 契約：開啟 / 瀏覽（依來源委派）
// ---------------------------------------------------------------------------

export const pickDataDirectory = (): Promise<string | null> => {
  // hosted 的本機模式直接用相容選擇器，避開 Chromium 對系統目錄的封鎖。
  if (getDataSource() === "local") {
    return web.pickDataDirectory({ preferCompatibility: true });
  }
  return hosted.pickDataDirectory();
};

export const openDataDir = async (path?: string): Promise<OpenResult> => {
  // 每次連線（包含「重試」）都清一次，避免仍控制當前分頁的舊 Worker
  // 在第一次清除後又建立同名 cache。
  if (getDataSource() === "cloud") await retireLegacyHostedCaching();
  return backend().openDataDir(path);
};

export const storedFolderLabel = (): Promise<string | null> => backend().storedFolderLabel();

export const reconnectDataDirectory = (): Promise<string | null> =>
  backend().reconnectDataDirectory();

export const listChildren = (path: string): Promise<ChildEntry[]> => backend().listChildren(path);

export const getNode = (path: string): Promise<NodeDetail> => backend().getNode(path);

export const getImage = (path: string): Promise<ImagePreviewResult | null> =>
  backend().getImage(path);

export const getAudio = (path: string): Promise<AudioResult> => backend().getAudio(path);

export const searchNodes = (query: string, scope?: string | null, limit = 200): Promise<SearchHit[]> =>
  backend().searchNodes(query, scope, limit);

/** 切換作用中的語系代碼（本機模式委派 wasm；雲端為單一語系 no-op）。 */
export const setRegion = (code: string): Promise<void> => backend().setRegion(code);

// ---------------------------------------------------------------------------
// export 契約：功能頁（依來源委派）
// ---------------------------------------------------------------------------

export const getItemTooltip = (path: string): Promise<ItemTooltip | null> =>
  backend().getItemTooltip(path);

export const getItemTooltipById = (itemId: number): Promise<ItemTooltip | null> =>
  backend().getItemTooltipById(itemId);

export const getCommodityItems = (): Promise<CommodityItem[]> => backend().getCommodityItems();

export const getMonsterBook = (): Promise<MonsterSummary[]> => backend().getMonsterBook();

export const getMobDetail = (mobId: number): Promise<MobDetail> => backend().getMobDetail(mobId);

export const getMobDropIcon = (itemId: number): Promise<string | null> =>
  backend().getMobDropIcon(itemId);

export const getSkillBook = (): Promise<SkillJobGroup[]> => backend().getSkillBook();

export const getSkillDetail = (job: string, skillId: string): Promise<SkillDetail> =>
  backend().getSkillDetail(job, skillId);

export const getQuestBook = (): Promise<QuestSummary[]> => backend().getQuestBook();
export const getQuestDetail = (questId: string): Promise<QuestDetail> =>
  backend().getQuestDetail(questId);

export const getMapBgmIndex = (): Promise<BgmMapGroup[]> => backend().getMapBgmIndex();

export const getAvatarMeta = (): Promise<AvatarMeta> => backend().getAvatarMeta();

export const getAvatarEmotions = (faceId: string): Promise<string[]> =>
  backend().getAvatarEmotions(faceId);

export const getAvatarEquipment = (): Promise<EquipItem[]> => backend().getAvatarEquipment();

export const getAvatarFrames = (
  parts: PartInput[],
  action: string,
  emotion: string,
  hairCover: boolean,
  hairShade: boolean,
): Promise<AvatarFrames> =>
  backend().getAvatarFrames(parts, action, emotion, hairCover, hairShade);

export const getPetList = (): Promise<PetInfo[]> => backend().getPetList();

export const getPetEquipList = (): Promise<PetEquipInfo[]> => backend().getPetEquipList();

export const getPetFrames = (
  petId: string,
  equipId: string | null,
  action: string,
): Promise<AvatarFrames> => backend().getPetFrames(petId, equipId, action);

// ---------------------------------------------------------------------------
// export 契約：匯出（依來源委派；雲端模式會 reject「尚未支援匯出」）
// ---------------------------------------------------------------------------

export const exportFile = (
  path: string,
  format: ExportFormat,
  outputPath: string,
): Promise<FileExportResult> => backend().exportFile(path, format, outputPath);

export const exportSubtree = (path: string): Promise<ExportStats> => backend().exportSubtree(path);

export const pickExportPath = (options: ExportDialogOptions): Promise<string | null> =>
  backend().pickExportPath(options);

export const saveBinaryFile = (
  defaultName: string,
  label: string,
  extension: string,
  base64: string,
): Promise<boolean> => backend().saveBinaryFile(defaultName, label, extension, base64);

// ---------------------------------------------------------------------------
// export 契約：啟動 / 雜項
// ---------------------------------------------------------------------------

/**
 * 啟動自動載入：雲端模式回雲端標籤（App 啟動即載入）；
 * 本機模式走 web 版語意（OPFS 快取 / 記住的 FSA 資料夾）。
 */
export const initialDataDir = (): Promise<string | null> => backend().initialDataDir();

export const initialPath = (): Promise<string | null> => Promise.resolve(null);

/** 支援 `?view=tree|avatar|pet|monster|skill|quest|sound` 深連結（兩種來源通用）。 */
export const initialView = (): Promise<string | null> => {
  const view = new URLSearchParams(window.location.search).get("view");
  return Promise.resolve(
    view === "tree" ||
      view === "avatar" ||
      view === "pet" ||
      view === "monster" ||
      view === "skill" ||
      view === "quest" ||
      view === "sound"
      ? view
      : null,
  );
};

/** 匯入進度：本機模式（OPFS 複製 / 索引建立）才有；雲端模式不會觸發。 */
export const onProgress = (listener: (progress: ImportProgress | null) => void): (() => void) =>
  backend().onProgress(listener);

/** 只有 document.title（由 i18n 模組跟隨介面語言更新），沒有原生視窗標題。 */
export const setWindowTitle = (_title: string): Promise<void> => Promise.resolve();

/** 直接開新分頁。 */
export const openExternal = (url: string): Promise<void> => {
  window.open(url, "_blank", "noopener,noreferrer");
  return Promise.resolve();
};

/** type tag → 顯示標籤（對齊 wzjs/node.rs）。 */
export function typeLabel(tag: number): string {
  switch (tag) {
    case 2: return "SubTree";
    case 3: return "u8";
    case 5: return "u16";
    case 6: return "int";
    case 7: return "long";
    case 8: return "float2";
    case 9: return "double";
    case 11: return "string";
    case 12: return "uol";
    case 14: return "vector";
    case 18: case 19: return "canvas";
    case 49: return "TextAsset";
    case 83: return "AudioClip";
    default: return `type${tag}`;
  }
}

export function formatValue(v: Value): string {
  switch (v.type) {
    case "SubTree": return t("data.value.subtree");
    case "Canvas": return t("data.value.canvas");
    case "U8": case "U16": case "Int": case "Long": return String(v.value);
    case "Double": return String(v.value);
    case "Float2": case "Vector": case "Int2": return `(${v.value[0]}, ${v.value[1]})`;
    case "Str": return v.value;
    case "Uol": return `→ ${v.value}`;
  }
}
