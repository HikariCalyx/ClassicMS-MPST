// Web 版 api:與 src/api.ts 完全相同的 export 介面,內部改走 Worker RPC。
// 型別宣告與 api.ts 保持一致(兩邊都是 wasm/gui.rs serde 輸出的契約);
// vite.config.web.ts 用 alias 把所有 "./api" / "../api" import 換成本檔。

import { zipSync } from "fflate";
import { t } from "./i18n";
import { clearProgress, rpc, subscribeProgress } from "./web/client";
import {
  pickFolder,
  reconnectStoredFolder,
  storedFolderState,
  type PickFolderOptions,
  type PickedFolder,
} from "./web/pickFolder";

export type ChildEntry =
  | { kind: "Category"; name: string; path: string; img_count: number }
  | { kind: "Img"; name: string; path: string; class_id: number }
  | { kind: "Node"; name: string; path: string; type_tag: number; has_children: boolean };

export interface OpenInfo {
  from_cache: boolean;
  elapsed_ms: number;
  entry_count: number;
  bundle_count: number;
  /** 目前作用中的語系代碼。 */
  locale: string;
  /** 資料集內偵測到的所有語系代碼（偏好順序；長度 > 1 時顯示切換器）。 */
  locales: string[];
}

export interface OpenResult {
  info: OpenInfo;
  top: ChildEntry[];
  data_dir: string;
}

export type Value =
  | { type: "SubTree" }
  | { type: "Canvas" }
  | { type: "U8"; value: number }
  | { type: "U16"; value: number }
  | { type: "Int"; value: number }
  | { type: "Long"; value: number }
  | { type: "Float2"; value: [number, number] }
  | { type: "Int2"; value: [number, number] }
  | { type: "Double"; value: number }
  | { type: "Vector"; value: [number, number] }
  | { type: "Str"; value: string }
  | { type: "Uol"; value: string };

export interface NodeDetail {
  path: string;
  name: string;
  type_tag: number;
  value: Value;
  node_path?: string | null;
  children: [string, number, boolean][];
  text_asset?: string | null;
}

export interface ImagePreviewResult {
  base64: string;
  mode: "exact" | "atlas";
  note?: string | null;
}

export interface AudioResult {
  base64: string;
}

/** 裝備能力值（`info` 的屬性名與原始數值；標籤由前端依介面語言決定）。 */
export interface TooltipStat {
  key: string;
  value: number;
}

/**
 * 裝備 tooltip（對齊 item_tooltip.rs 的 serde 輸出）。分類、職業、屬性等只回代碼，
 * 顯示文字由 ItemTooltip.tsx 依介面語言決定。
 */
export interface ItemTooltip {
  itemId: string;
  imgPath: string;
  /** 道具名稱（字串表缺名時為 itemId）。 */
  title: string;
  description: string | null;
  /** 性別限制：0 = 男、1 = 女；沒有限制為 null。 */
  reqGender: number | null;
  /** 裝備分類代碼（cap、coat、weapon、face…）。 */
  category: string;
  /** 武器種類代碼（oneHandedSword、bow…）；不是已知武器時為 null。 */
  weaponType: string | null;
  iconBase64: string | null;
  requiredLevel: number;
  requiredStr: number;
  requiredDex: number;
  requiredInt: number;
  requiredLuk: number;
  /** 可裝備的職業代碼（beginner、warrior、magician、bowman、thief、pirate）。 */
  requiredJobs: string[];
  /** 道具屬性代碼（only、cash、timeLimited、tradeBlock、accountSharable、onlyEquip）。 */
  attributes: string[];
  /** `info/attackSpeed` 原始值。 */
  attackSpeed: number | null;
  scrollCount: number | null;
  stats: TooltipStat[];
}

export interface ExportStats {
  out_dir: string;
  json_files: number;
  png_files: number;
  nodes: number;
}

export type ExportFormat = "json" | "png" | "xml";

export interface FileExportResult {
  out_path: string;
  nodes: number;
}

/** 匯入進度（OPFS 複製 / 索引建立）：只帶階段與數字，訊息文字由 App 依介面語言組字。 */
export interface ImportProgress {
  phase: "copy" | "catalog";
  percent: number;
  stage: "loadingIndex" | "unchanged" | "copying" | "buildingIndex";
  /** copying 階段：目前複製的檔名，以及第幾個 / 共幾個。 */
  file?: string;
  fileIndex?: number;
  fileCount?: number;
}
export interface ExportDialogOptions {
  title: string;
  defaultName: string;
  label: string;
  extension: ExportFormat;
}

/** 商城商品（對齊 commodity.rs 的 serde 輸出）。 */
export interface CommodityItem {
  sn: number;
  itemId: number;
  count: number;
  price: number;
  name: string | null;
  iconBase64: string | null;
}

/** 圖鑑清單中的掉落物參照（對齊 monster.rs 的 serde 輸出）。 */
export interface DropRef {
  itemId: number;
  name: string | null;
}

/** 怪物圖鑑清單項目。 */
export interface MonsterSummary {
  mobId: number;
  name: string | null;
  level: number | null;
  drops: DropRef[];
}

/** 怪物出沒地圖。 */
export interface MapRef {
  mapId: number;
  name: string | null;
}

/** 怪物掉落物（含 icon）。 */
export interface MobDropItem {
  itemId: number;
  name: string | null;
  /** undefined 表示圖示可延後載入；null 表示已確認沒有圖示。 */
  iconBase64?: string | null;
}

/** Mob 動畫的一幀（base64 PNG + 播放資訊）。 */
export interface MobFrame {
  base64: string;
  delay: number;
  origin: [number, number];
  width: number;
  height: number;
}

/** 單一怪物的完整明細。 */
export interface MobDetail {
  mobId: number;
  name: string | null;
  level: number | null;
  category: string | null;
  description: string | null;
  maxHp: number;
  maxMp: number;
  exp: number;
  pad: number;
  pdd: number;
  mad: number;
  mdd: number;
  acc: number;
  eva: number;
  speed: number;
  pushed: number;
  bodyAttack: boolean;
  undead: boolean;
  maps: MapRef[];
  drops: MobDropItem[];
  frames: MobFrame[];
}

/** 技能分類（對齊 skill.rs 的 SkillCategory serde 輸出）。 */
export type SkillCategory = "passive" | "support" | "active";

/** 技能清單項目（對齊 skill.rs 的 serde 輸出）。 */
export interface SkillSummary {
  id: string;
  job: string;
  name: string | null;
  maxLevel: number;
  skillType: number | null;
  category: SkillCategory;
}

/** 單一職業的技能群組。 */
export interface SkillJobGroup {
  job: string;
  skills: SkillSummary[];
}

/** 單一技能完整明細。levels 的葉值可能是數字、字串或 [x,y] 向量。 */
export interface SkillDetail {
  id: string;
  job: string;
  name: string | null;
  desc: string | null;
  h: string | null;
  levelDesc: Record<string, string>;
  maxLevel: number;
  skillType: number | null;
  actions: string[];
  actionDelays: Record<string, number>;
  levels: Record<string, Record<string, number | string | [number, number]>>;
}

/** 任務清單項目（對齊 quest.rs 的 serde 輸出）。 */
export interface QuestSummary {
  id: string;
  name: string | null;
  parent: string | null;
  area: number | null;
  levelMin: number | null;
  levelMax: number | null;
  startNpcId: number | null;
  startNpcName: string | null;
  nextQuestId: string | null;
}

/** 任務相關的道具參照（count 負值表示交付/消耗）。
 *  prop 是抽取標記：正值＝隨機獲得（值為權重），-1＝自選一項，null＝固定給予。 */
export interface QuestItemRef {
  id: number;
  count: number;
  name: string | null;
  prop: number | null;
}

/** 任務需求怪物參照。 */
export interface QuestMobRef {
  id: number;
  count: number;
  name: string | null;
}

/** 任務參照（前置任務 / 下個任務）。 */
export interface QuestRef {
  id: string;
  name: string | null;
}

/** 單一任務階段（開始 / 完成）的 NPC 對話腳本。 */
export interface QuestDialogueStage {
  npcId: number | null;
  npcName: string | null;
  lines: string[];
  ask: string[];
  yes: string[];
  no: string[];
  stopNpc: string[];
  stopItem: string[];
  lost: string[];
}

/** 單一任務完整明細。 */
export interface QuestDetail {
  id: string;
  name: string | null;
  parent: string | null;
  area: number | null;
  levelMin: number | null;
  levelMax: number | null;
  jobs: number[];
  info: Record<string, string>;
  start: QuestDialogueStage | null;
  end: QuestDialogueStage | null;
  startRequirements: { items: QuestItemRef[]; preQuests: QuestRef[] };
  requirements: { items: QuestItemRef[]; mobs: QuestMobRef[]; preQuests: QuestRef[] };
  rewards: {
    exp: number | null;
    mesos: number | null;
    popularity: number | null;
    items: QuestItemRef[];
    nextQuest: QuestRef | null;
  };
  interval: number | null;
}

/** 紙娃娃膚色（對齊 avatar.rs 的 serde 輸出）。 */
export interface SkinInfo {
  bodyId: string;
  headId: string;
  name: string;
}

/** 紙娃娃基本資料：body 動作清單 + 膚色清單。 */
export interface AvatarMeta {
  actions: string[];
  skins: SkinInfo[];
}

/** 紙娃娃裝備項目。 */
export interface EquipItem {
  id: string;
  name: string;
  slot: string;
  iconPath: string;
  cash: boolean;
}

/** 紙娃娃部位輸入（"body"/"head" 必有，其餘為裝備 slot）。 */
export interface PartInput {
  slot: string;
  id: string;
  visible: boolean;
}

/** 紙娃娃幀內的一個圖層（path 用 getImage 取圖，x/y 為 canvas 左上角）。 */
export interface AvatarLayer {
  path: string;
  x: number;
  y: number;
  z: number;
}

/** 紙娃娃動畫幀（layers 已按繪製順序排好，z 遞減）。 */
export interface AvatarFrame {
  delay: number;
  layers: AvatarLayer[];
  /** 身體幀專用：當幀 brow 錨點的絕對位置（表情層以此即時配對）；表情幀恆 null。 */
  faceAnchor: [number, number] | null;
  /** 身體幀專用：當幀是否要畫臉（背面動作不畫）；表情幀恆 true。 */
  showFace: boolean;
}

/** 紙娃娃合成結果：身體動畫幀 + 表情動畫幀 + ItemEff 特效動畫幀。 */
export interface AvatarFrames {
  frames: AvatarFrame[];
  faceFrames: AvatarFrame[];
  /** ItemEff 特效動畫幀（幀數獨立，絕對座標；沒有特效裝備時為空）。 */
  effectFrames: AvatarFrame[];
}

/** 寵物項目（對齊 pet.rs 的 serde 輸出）。 */
export interface PetInfo {
  id: string;
  name: string;
  iconPath: string;
  actions: string[];
}

/** 寵物裝備項目（對齊 pet.rs 的 serde 輸出）。 */
export interface PetEquipInfo {
  id: string;
  name: string;
  iconPath: string;
  petIds: number[];
  cash: boolean;
}

// pickDataDirectory 與 openDataDir 之間的暫存:File 物件無法走字串路徑往返,
// 所以選完資料夾先存在這裡,openDataDir 時餵給 Worker。
let pendingPick: PickedFolder | null = null;

// 上次成功開啟的資料夾標籤(顯示用);搭配 OPFS 快取做啟動自動載入。
const CACHED_DIR_LABEL_KEY = "msclassic-data-dir-label";

export const pickDataDirectory = async (
  options: PickFolderOptions = {},
): Promise<string | null> => {
  const picked = await pickFolder(options);
  if (!picked) return null;
  pendingPick = picked;
  return picked.label;
};

export const openDataDir = async (path?: string): Promise<OpenResult> => {
  let picked = pendingPick;
  // 啟動自動載入(initialDataDir 回傳的 path):OPFS 已有上次複製的資料,
  // 直接從快取開啟;快取被瀏覽器清掉才回退到手動選擇。
  if (!picked && path != null) {
    let cached: OpenResult | null = null;
    try {
      cached = await rpc<OpenResult | null>("openCached");
    } finally {
      // 與下方 importBundles 路徑一致:結束時清掉進度列,否則
      // 「正在載入資產索引…」會一直留著。
      clearProgress();
    }
    if (cached) return { ...cached, data_dir: path };
  }
  if (!picked) {
    picked = await pickFolder();
    if (!picked) throw new Error(t("data.error.pickCancelled"));
    pendingPick = picked;
  }
  try {
    const result = await rpc<OpenResult>("importBundles", picked.files);
    localStorage.setItem(CACHED_DIR_LABEL_KEY, picked.label);
    return { ...result, data_dir: picked.label };
  } finally {
    clearProgress();
  }
};

/** 歡迎頁「重新連線」按鈕用:回傳記住的資料夾標籤,沒有回 null(桌面版恆 null)。 */
export const storedFolderLabel = async (): Promise<string | null> =>
  (await storedFolderState())?.label ?? null;

/** 重新連線記住的資料夾;需由使用者點擊觸發(requestPermission 要手勢)。 */
export const reconnectDataDirectory = async (): Promise<string | null> => {
  const picked = await reconnectStoredFolder();
  if (!picked) return null;
  pendingPick = picked;
  return picked.label;
};

// 資料來源切換(hosted 版 api.hosted.ts 才有雙來源);web 版固定本機資料夾。
export type DataSource = "cloud" | "local";
export const getDataSource = (): DataSource => "local";
export const setDataSource = (_source: DataSource): void => undefined;
export const supportsDataSourceSwitch = (): boolean => false;

export const listChildren = (path: string) => rpc<ChildEntry[]>("listChildren", path);
export const getNode = (path: string) => rpc<NodeDetail>("getNode", path);

interface WasmImageResult {
  png: Uint8Array;
  mode: "exact" | "atlas";
  note: string | null;
}

export const getImage = async (path: string): Promise<ImagePreviewResult | null> => {
  const result = await rpc<WasmImageResult | null>("getImage", path);
  if (!result) return null;
  return { base64: uint8ToBase64(result.png), mode: result.mode, note: result.note };
};

export const getAudio = async (path: string): Promise<AudioResult> => {
  const bytes = await rpc<Uint8Array>("getAudio", path);
  return { base64: uint8ToBase64(bytes) };
};

export interface SearchHit {
  path: string;
  name: string | null;
}

export const searchNodes = (query: string, scope?: string | null, limit = 200) =>
  rpc<SearchHit[]>("searchNodes", query, scope ?? null, limit);
/** 切換作用中的語系代碼（資料集含多個語系時用）。 */
export const setRegion = (code: string) => rpc<void>("setRegion", code);

export const getItemTooltip = (path: string) =>
  rpc<ItemTooltip | null>("getItemTooltip", path);

export const getItemTooltipById = (itemId: number) =>
  rpc<ItemTooltip | null>("getItemTooltipById", itemId);

export const getCommodityItems = () => rpc<CommodityItem[]>("getCommodityItems");

/** 使用某首 BGM 的一張地圖（對齊 sound.rs 的 serde 輸出）。 */
export interface BgmMapRef {
  mapId: number;
  name: string | null;
  /** 地圖 img 路徑（如 `Map/Map/Map0/000010000`），組 miniMap 縮圖路徑用。 */
  imgPath: string;
}

/** 一首 BGM 與使用它的地圖清單（對齊 sound.rs 的 serde 輸出）。 */
export interface BgmMapGroup {
  /** BGM 路徑（`Sound/` 前綴之後的部分，如 `Bgm00/FloralLife`）。 */
  bgm: string;
  maps: BgmMapRef[];
}

export const getMonsterBook = () => rpc<MonsterSummary[]>("getMonsterBook");

export const getMapBgmIndex = () => rpc<BgmMapGroup[]>("getMapBgmIndex");

export const getMobDetail = (mobId: number) => rpc<MobDetail>("getMobDetail", mobId);

export const getMobDropIcon = async (itemId: number): Promise<string | null> =>
  (await getItemTooltipById(itemId))?.iconBase64 ?? null;

export const getSkillBook = () => rpc<SkillJobGroup[]>("getSkillBook");

export const getSkillDetail = (job: string, skillId: string) =>
  rpc<SkillDetail>("getSkillDetail", job, skillId);
export const getQuestBook = () => rpc<QuestSummary[]>("getQuestBook");

export const getQuestDetail = (questId: string) =>
  rpc<QuestDetail>("getQuestDetail", questId);

export const getAvatarMeta = () => rpc<AvatarMeta>("getAvatarMeta");

export const getAvatarEmotions = (faceId: string) =>
  rpc<string[]>("getAvatarEmotions", faceId);

export const getAvatarEquipment = () => rpc<EquipItem[]>("getAvatarEquipment");

export const getAvatarFrames = (
  parts: PartInput[],
  action: string,
  emotion: string,
  hairCover: boolean,
  hairShade: boolean,
) => rpc<AvatarFrames>("getAvatarFrames", parts, action, emotion, hairCover, hairShade);

export const getPetList = () => rpc<PetInfo[]>("getPetList");

export const getPetEquipList = () => rpc<PetEquipInfo[]>("getPetEquipList");

export const getPetFrames = (petId: string, equipId: string | null, action: string) =>
  rpc<AvatarFrames>("getPetFrames", petId, equipId, action);

interface WasmFileExport {
  filename: string;
  bytes: Uint8Array;
}

export const exportFile = async (
  path: string,
  format: ExportFormat,
  _outputPath: string,
): Promise<FileExportResult> => {
  const result = await rpc<WasmFileExport>("exportFile", path, format);
  downloadBytes(result.filename, result.bytes);
  // wasm 單檔匯出沒有回節點數,桌面版才有;web 版以 0 帶過。
  return { out_path: result.filename, nodes: 0 };
};

interface WasmSubtreeExport {
  count: number;
  files: { path: string; bytes: Uint8Array }[];
}

export const exportSubtree = async (path: string): Promise<ExportStats> => {
  const result = await rpc<WasmSubtreeExport>("exportSubtree", path);
  const entries: Record<string, Uint8Array> = {};
  let jsonFiles = 0;
  let pngFiles = 0;
  for (const file of result.files) {
    entries[file.path] = file.bytes;
    if (file.path.toLowerCase().endsWith(".json")) jsonFiles += 1;
    else if (file.path.toLowerCase().endsWith(".png")) pngFiles += 1;
  }
  const zipped = zipSync(entries);
  const rootName = sanitizeFileName(path.split("/").at(-1) ?? "export");
  const zipName = `export-${rootName}.zip`;
  downloadBytes(zipName, zipped, "application/zip");
  return { out_dir: zipName, json_files: jsonFiles, png_files: pngFiles, nodes: result.count };
};

export const initialPath = (): Promise<string | null> => Promise.resolve(null);
export const initialView = (): Promise<string | null> => Promise.resolve(null);

/**
 * 啟動自動載入(對齊桌面版 MSCLASSIC_DATA_DIR 的掛點,App.tsx 啟動時呼叫):
 * 1. OPFS 快取完整 → 直接回標籤,openDataDir 會從快取開啟,完全免操作。
 * 2. 否則若有記住的 FSA 資料夾且權限仍在(Chrome 122+ 持久授權)→ 免手勢
 *    重新連線,走增量同步把遊戲更新補進 OPFS。
 * 3. 都不行 → null,由使用者手動選擇或按「重新連線」。
 */
export const initialDataDir = async (): Promise<string | null> => {
  const label = localStorage.getItem(CACHED_DIR_LABEL_KEY);
  if (label && (await rpc<boolean>("checkCached"))) return label;
  const stored = await storedFolderState();
  if (stored?.granted) {
    const picked = await reconnectStoredFolder();
    if (picked) {
      pendingPick = picked;
      return picked.label;
    }
  }
  return null;
};

/** web 版只有 document.title（由 i18n 模組跟隨介面語言更新），沒有原生視窗標題。 */
export const setWindowTitle = (_title: string): Promise<void> => Promise.resolve();

/** web 版直接開新分頁。 */
export const openExternal = (url: string): Promise<void> => {
  window.open(url, "_blank", "noopener,noreferrer");
  return Promise.resolve();
};

/** web 沒有原生儲存對話框,直接回預設檔名(實際下載由 exportFile 觸發)。 */
export const pickExportPath = (options: ExportDialogOptions): Promise<string | null> =>
  Promise.resolve(options.defaultName);

/** web 版：無另存對話框，base64 內容直接觸發瀏覽器下載，一律視為已存。 */
export const saveBinaryFile = (
  defaultName: string,
  _label: string,
  extension: string,
  base64: string,
): Promise<boolean> => {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  downloadBytes(defaultName, bytes, `image/${extension}`);
  return Promise.resolve(true);
};

/** 訂閱 OPFS 複製 / 索引建立進度;回傳取消訂閱函式。 */
export const onProgress = (listener: (progress: ImportProgress | null) => void): (() => void) =>
  subscribeProgress(listener);

function sanitizeFileName(value: string): string {
  const sanitized = value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim();
  return sanitized || "export";
}

function downloadBytes(filename: string, bytes: Uint8Array, type = "application/octet-stream"): void {
  const blob = new Blob([bytes as BlobPart], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** 分塊 btoa,避免大圖 String.fromCharCode(...bytes) 爆 call stack。 */
function uint8ToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK));
  }
  return btoa(binary);
}

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
