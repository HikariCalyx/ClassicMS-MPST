// Hosted（靜態資料集）後端：與 src/api.ts / api.web.ts 相同的 export 介面，
// 內部走 HTTP fetch 預處理資料集（out/hosted/<版本>/，部署後為 R2/Workers）。
// 本檔由 src/api.hosted.ts 委派呼叫（雲端模式），不會被 alias 直接指到。
//
// 資料集結構與共用機制（fetch / catalog / tree / strings / 圖片 / UOL）見
// ./core.ts；本檔只保留 API 契約型別與契約函式本身。

import {
  CLASS_AUDIO_CLIP,
  CLASS_TEXT_ASSET,
  dataLabel,
  DATA_ROOT,
  fetchChecked,
  findNode,
  initCatalog,
  listDirChildren,
  loadTextAsset,
  loadTree,
  nodeChildren,
  requireCatalog,
  resolvedTrees,
  splitImgPrefix,
} from "./core";
import type { TreeNode } from "./core";
import { t } from "../i18n";

export { getImage } from "./core";

export type ChildEntry =
  | { kind: "Category"; name: string; path: string; img_count: number }
  | { kind: "Img"; name: string; path: string; class_id: number }
  | { kind: "Node"; name: string; path: string; type_tag: number; has_children: boolean };

export interface OpenInfo {
  from_cache: boolean;
  elapsed_ms: number;
  entry_count: number;
  bundle_count: number;
  /** 目前作用中的語系代碼（雲端資料集為單一語系）。 */
  locale: string;
  /** 偵測到的語系代碼清單（雲端資料集固定單一語系）。 */
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

/** 寵物清單項目（對齊 pet.rs 的 PetInfo serde 輸出）。 */
export interface PetInfo {
  /** img 名（7 碼，如 "5000000"）。 */
  id: string;
  name: string;
  /** icon 節點路徑（前端取圖失敗時自行 fallback iconRaw）。 */
  iconPath: string;
  /** 該寵物支援的動作清單（含表情類動作，分類由前端處理）。 */
  actions: string[];
}

/** 寵物裝備清單項目（對齊 pet.rs 的 PetEquipInfo serde 輸出）。 */
export interface PetEquipInfo {
  /** img 名（8 碼，如 "01802000"）。 */
  id: string;
  name: string;
  iconPath: string;
  /** 支援的寵物 id（img 內的數位子節點）。 */
  petIds: number[];
  /** 點裝：img 的 `info/cash` 數值非零。 */
  cash: boolean;
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

export interface SearchHit {
  path: string;
  name: string | null;
}

// ---------------------------------------------------------------------------
// export 契約：開啟 / 瀏覽
// ---------------------------------------------------------------------------

export const pickDataDirectory = (): Promise<string | null> => Promise.resolve(null);

export const openDataDir = async (_path?: string): Promise<OpenResult> => {
  const started = performance.now();
  const [indexResponse, catalogResponse] = await Promise.all([
    fetchChecked(`${DATA_ROOT}/index.json`, { reload: true }),
    fetchChecked(`${DATA_ROOT}/catalog.json`, { reload: true }),
  ]);
  const index = (await indexResponse.json()) as { version?: string };
  const catalog = (await catalogResponse.json()) as { entries: Record<string, number> };
  const state = initCatalog(catalog.entries);
  const label = dataLabel(index.version ?? __HOSTED_DATA_VERSION__);
  return {
    info: {
      from_cache: true,
      elapsed_ms: Math.round(performance.now() - started),
      entry_count: Object.keys(catalog.entries).length,
      bundle_count: 0,
      locale: "TW",
      locales: ["TW"],
    },
    top: listDirChildren(state, ""),
    data_dir: label,
  };
};

/** 雲端資料集為單一語系，切換為 no-op（契約相容用）。 */
export const setRegion = (_code: string): Promise<void> => Promise.resolve();

/** 歡迎頁「重新連線」按鈕用；hosted 模式沒有本機資料夾可記住，恆 null。 */
export const storedFolderLabel = (): Promise<string | null> => Promise.resolve(null);

export const reconnectDataDirectory = (): Promise<string | null> => Promise.resolve(null);

export const listChildren = async (path: string): Promise<ChildEntry[]> => {
  const state = requireCatalog();
  const classId = state.entries[path];
  // TextAsset / AudioClip 是葉子，沒有子節點。
  if (classId === CLASS_TEXT_ASSET || classId === CLASS_AUDIO_CLIP) return [];
  if (classId == null) {
    const split = splitImgPrefix(state.entries, path);
    if (!split) return listDirChildren(state, path);
    // 落在某個 TextAsset/AudioClip 內部：同樣沒有子節點。
    const innerClass = state.entries[split[0]];
    if (innerClass === CLASS_TEXT_ASSET || innerClass === CLASS_AUDIO_CLIP) return [];
    const [imgKey, inner] = split;
    const tree = await loadTree(imgKey);
    const node = findNode(tree, inner);
    if (!node) throw new Error(t("data.error.nodeNotFound", { path }));
    return nodeChildren(state, imgKey, inner, node);
  }
  // WZJS img 根：列出 tree 根節點的 children。
  const tree = await loadTree(path);
  return nodeChildren(state, path, "", tree);
};

export const getNode = async (path: string): Promise<NodeDetail> => {
  const state = requireCatalog();
  const split = splitImgPrefix(state.entries, path);
  if (!split) throw new Error(t("data.error.pathNotFound", { path }));
  const [imgKey, inner] = split;
  const classId = state.entries[imgKey];
  const name = imgKey.split("/").at(-1) ?? imgKey;

  // TextAsset：fetch strings/<path>.json 明文放 text_asset。
  if (classId === CLASS_TEXT_ASSET) {
    if (inner !== "") throw new Error(t("data.error.pathNotFound", { path }));
    return {
      path,
      name,
      type_tag: CLASS_TEXT_ASSET,
      value: { type: "SubTree" },
      node_path: null,
      children: [],
      text_asset: await loadTextAsset(imgKey),
    };
  }
  // AudioClip：只回基本資訊，聲音資料由 getAudio 懶載。
  if (classId === CLASS_AUDIO_CLIP) {
    if (inner !== "") throw new Error(t("data.error.pathNotFound", { path }));
    return {
      path,
      name,
      type_tag: CLASS_AUDIO_CLIP,
      value: { type: "SubTree" },
      node_path: null,
      children: [],
      text_asset: null,
    };
  }

  const tree = await loadTree(imgKey);
  const node = findNode(tree, inner);
  if (!node) throw new Error(t("data.error.nodeNotFound", { path }));
  return {
    path,
    name: node.name,
    type_tag: node.tag,
    value: node.value,
    node_path: null,
    children: (node.children ?? []).map((child) => [
      child.name,
      child.tag,
      (child.children?.length ?? 0) > 0,
    ]),
    text_asset: null,
  };
};

/** 音效：pipeline 已轉封裝成 Ogg Vorbis，直接抓 `audio/<path>.ogg` 回 base64。 */
export const getAudio = async (path: string): Promise<AudioResult> => {
  const response = await fetchChecked(`${DATA_ROOT}/audio/${path}.ogg`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  let binary = "";
  const CHUNK = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK));
  }
  return { base64: btoa(binary) };
};

export const searchNodes = async (
  query: string,
  scope?: string | null,
  limit = 200,
): Promise<SearchHit[]> => {
  const state = requireCatalog();
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const inScope = (path: string) =>
    !scope || path === scope || path.startsWith(`${scope}/`);

  const hits: SearchHit[] = [];
  // 1. catalog entry（img / TextAsset / AudioClip）的路徑子串比對。
  for (const path of Object.keys(state.entries)) {
    if (hits.length >= limit) return hits;
    if (!inScope(path)) continue;
    if (path.toLowerCase().includes(needle)) hits.push({ path, name: null });
  }
  // 2. 已載入 tree 的節點名比對（不主動抓新 tree，避免搜一次爆量下載）。
  //    inner 路徑不含 img 根名稱（與 findNode / UOL 解析同基準），從根的 children 起算。
  for (const [imgPath, tree] of resolvedTrees) {
    if (hits.length >= limit) return hits;
    if (!inScope(imgPath)) continue;
    const stack: [TreeNode, string][] = (tree.children ?? []).map((child) => [child, ""]);
    while (stack.length > 0 && hits.length < limit) {
      const [node, parentInner] = stack.pop() as [TreeNode, string];
      const inner = parentInner === "" ? node.name : `${parentInner}/${node.name}`;
      if (node.name.toLowerCase().includes(needle)) {
        const path = `${imgPath}/${inner}`;
        if (inScope(path)) hits.push({ path, name: null });
      }
      for (const child of node.children ?? []) stack.push([child, inner]);
    }
  }
  return hits;
};

// ---------------------------------------------------------------------------
// export 契約：功能頁（實作在 ./tooltip / ./monster / ./skill / ./avatar）
// ---------------------------------------------------------------------------

export { getItemTooltip, getItemTooltipById } from "./tooltip";

export { getCommodityItems, getMonsterBook, getMobDetail, getMobDropIcon } from "./monster";

export { getSkillBook, getSkillDetail } from "./skill";

export { getQuestBook, getQuestDetail } from "./quest";

export { getMapBgmIndex } from "./sound";

export {
  getAvatarMeta,
  getAvatarEmotions,
  getAvatarEquipment,
  getAvatarFrames,
} from "./avatar";

export { getPetList, getPetEquipList, getPetFrames } from "./pet";

// ---------------------------------------------------------------------------
// export 契約：匯出（hosted 模式不支援；ExportMenu 會用 toast 顯示錯誤）
// ---------------------------------------------------------------------------

const exportUnsupported = () => new Error(t("data.error.exportUnsupported"));

export const exportFile = (
  _path: string,
  _format: ExportFormat,
  _outputPath: string,
): Promise<FileExportResult> => Promise.reject(exportUnsupported());

export const exportSubtree = (_path: string): Promise<ExportStats> =>
  Promise.reject(exportUnsupported());

export const pickExportPath = (
  _options: ExportDialogOptions,
): Promise<string | null> => Promise.reject(exportUnsupported());

export const saveBinaryFile = (
  _defaultName: string,
  _label: string,
  _extension: string,
  _base64: string,
): Promise<boolean> => Promise.reject(exportUnsupported());

// ---------------------------------------------------------------------------
// export 契約：啟動 / 雜項
// ---------------------------------------------------------------------------

/** hosted 模式不用選資料夾：直接回標籤，App 啟動即自動載入。 */
export const initialDataDir = (): Promise<string | null> => Promise.resolve(dataLabel());

/** hosted 模式沒有匯入進度；回傳 no-op 取消函式。 */
export const onProgress = (_listener: (progress: ImportProgress | null) => void): (() => void) =>
  () => undefined;
