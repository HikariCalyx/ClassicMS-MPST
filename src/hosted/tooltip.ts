// 裝備 tooltip 聚合（hosted 版）：語意對齊 src-tauri/src/item_tooltip.rs，
// id → 路徑映射對齊 commodity.rs 的 item_path_candidates。
// 差異：Rust 只從本機 catalog 查；hosted 版同樣以 catalog 判斷存在性，
// tree 透過 HTTP 懶載入（loadTree 內建快取與去重）。

import type { ItemTooltip, TooltipStat, Value } from "../api.hosted";
import {
  findNode,
  getImage,
  loadTextAsset,
  loadTree,
  requireCatalog,
  splitImgPrefix,
} from "./core";
import type { TreeNode } from "./core";

// ---------------------------------------------------------------------------
// 對齊 item_tooltip.rs 的常數表（只輸出代碼，顯示文字由前端依介面語言決定）
// ---------------------------------------------------------------------------

/** 對齊 MPST 的 GEAR_STAT_LABELS（順序即顯示順序）。 */
const GEAR_STAT_KEYS = [
  "incSTR",
  "incDEX",
  "incINT",
  "incLUK",
  "incMHP",
  "incMMP",
  "incPAD",
  "incMAD",
  "incPDD",
  "incMDD",
  "incACC",
  "incEVA",
  "incSpeed",
  "incJump",
  "tuc",
];

const ALL_JOBS = ["beginner", "warrior", "magician", "bowman", "thief", "pirate"];
const JOB_MASKS: [number, string][] = [
  [1, "warrior"],
  [2, "magician"],
  [4, "bowman"],
  [8, "thief"],
  [16, "pirate"],
];

// ---------------------------------------------------------------------------
// 節點屬性讀取（對齊 item_tooltip.rs 的 prop / prop_i64 / value_as_i64）
// ---------------------------------------------------------------------------

/** 直接子節點查找（不分大小寫，對齊 Rust prop）。 */
function prop(node: TreeNode, name: string): TreeNode | null {
  const lower = name.toLowerCase();
  return node.children?.find((child) => child.name.toLowerCase() === lower) ?? null;
}

function valueAsI64(value: Value): number | null {
  switch (value.type) {
    case "U8":
    case "U16":
    case "Int":
    case "Long":
      return value.value;
    case "Int2":
      return value.value[0];
    case "Double":
      return Math.trunc(value.value);
    default:
      return null;
  }
}

function propI64(node: TreeNode, name: string): number | null {
  const child = prop(node, name);
  return child ? valueAsI64(child.value) : null;
}

function propBool(node: TreeNode, name: string): boolean {
  const value = propI64(node, name);
  return value != null && value !== 0;
}

// ---------------------------------------------------------------------------
// String/TW/Item 名稱表（整份快取；monster.ts 也會用）
// ---------------------------------------------------------------------------

export interface ItemNameEntry {
  name: string;
  desc: string | null;
}

let itemNameTablePromise: Promise<Map<number, ItemNameEntry>> | null = null;

/** 懶載入 `String/TW/Item` 名稱表；資料集沒有此資產時視為空表（對齊 Rust）。 */
export function loadItemNameTable(): Promise<Map<number, ItemNameEntry>> {
  if (!itemNameTablePromise) {
    itemNameTablePromise = loadTextAsset("String/TW/Item")
      .then((text) => {
        const table = new Map<number, ItemNameEntry>();
        const raw = JSON.parse(text) as Record<string, { name?: unknown; desc?: unknown }>;
        for (const [key, value] of Object.entries(raw)) {
          const id = Number(key);
          if (!Number.isInteger(id) || typeof value?.name !== "string") continue;
          table.set(id, {
            name: value.name,
            desc: typeof value.desc === "string" ? value.desc : null,
          });
        }
        return table;
      })
      .catch(() => new Map<number, ItemNameEntry>());
  }
  return itemNameTablePromise;
}

// ---------------------------------------------------------------------------
// 道具 id → 候選路徑（對齊 commodity.rs 的 item_path_candidates）
// ---------------------------------------------------------------------------

/** 依道具 id 推出可能的（img 或 img 內節點）路徑，按優先順序。 */
export function itemPathCandidates(itemId: number, hasPath: (path: string) => boolean): string[] {
  const bases: string[] = [];
  const id8 = String(itemId).padStart(8, "0");
  const id7 = String(itemId).padStart(7, "0");
  const dir4 = String(Math.floor(itemId / 10000)).padStart(4, "0");
  switch (Math.floor(itemId / 1_000_000)) {
    // 裝備：Character/<分類目錄>/<8 碼 id>。
    case 1: {
      const prefix = Math.floor(itemId / 10000);
      const dir =
        prefix === 100
          ? "Cap"
          : prefix >= 101 && prefix <= 103
            ? "Accessory"
            : prefix === 104
              ? "Coat"
              : prefix === 105
                ? "Longcoat"
                : prefix === 106
                  ? "Pants"
                  : prefix === 107
                    ? "Shoes"
                    : prefix === 108
                      ? "Glove"
                      : prefix === 109
                        ? "Shield"
                        : prefix === 110
                          ? "Cape"
                          : prefix === 111
                            ? "Ring"
                            : prefix >= 112 && prefix <= 115
                              ? "Accessory"
                              : prefix >= 121 && prefix <= 179
                                ? "Weapon"
                                : prefix === 180
                                  ? "PetEquip"
                                  : null;
      if (dir) bases.push(`Character/${dir}/${id8}`);
      break;
    }
    case 2:
      bases.push(`Item/Consume/${dir4}/${id8}`);
      break;
    case 3:
      bases.push(`Item/Install/${dir4}/${id8}`);
      break;
    case 4:
      bases.push(`Item/Etc/${dir4}/${id8}`);
      break;
    // 5 開頭：寵物是一 id 一 img，其餘落在 Cash 分區 img。
    case 5: {
      const pet = `Item/Pet/${itemId}`;
      if (hasPath(pet)) bases.push(pet);
      bases.push(`Item/Cash/${dir4}/${id8}`);
      break;
    }
    // 9 開頭（套裝組、欄位擴充等）：Special img 內的節點是 7 碼 id。
    case 9:
      bases.push(`Item/Special/0${Math.floor(itemId / 10000)}/${id7}`);
      break;
    default:
      break;
  }
  return bases;
}

// ---------------------------------------------------------------------------
// tooltip 組裝（對齊 item_tooltip.rs 的 build_tooltip / tooltip_icon）
// ---------------------------------------------------------------------------

const isIdSegment = (segment: string) => /^\d{8}$/.test(segment);

/** 由道具根節點（Character img 根或 Item img 內的道具節點）聚合 tooltip 內容。 */
async function buildTooltip(
  rootPath: string,
  rootNode: TreeNode,
  categoryHint: string,
): Promise<ItemTooltip | null> {
  const info = rootNode.children?.find((child) => child.name === "info") ?? null;
  if (!info) return null;
  const itemId = rootPath.split("/").at(-1) ?? "";
  const numericId = Number.parseInt(itemId, 10) || 0;

  const names = await loadItemNameTable();
  const entry = names.get(numericId);
  const title = entry?.name ?? itemId;
  const gender = propI64(info, "reqGender");

  const description = entry?.desc?.trim() ? entry.desc : null;
  const iconBase64 = await tooltipIcon(rootPath, itemId, categoryHint);

  return {
    itemId,
    imgPath: rootPath,
    title,
    description,
    reqGender: gender === 0 || gender === 1 ? gender : null,
    category: gearCategory(itemId, categoryHint),
    weaponType: weaponType(itemId),
    iconBase64,
    requiredLevel: propI64(info, "reqLevel") ?? 0,
    requiredStr: propI64(info, "reqSTR") ?? 0,
    requiredDex: propI64(info, "reqDEX") ?? 0,
    requiredInt: propI64(info, "reqINT") ?? 0,
    requiredLuk: propI64(info, "reqLUK") ?? 0,
    requiredJobs: requiredJobs(propI64(info, "reqJob")),
    attributes: gearAttributes(info),
    attackSpeed: propI64(info, "attackSpeed"),
    scrollCount: propI64(info, "tuc"),
    stats: gearStats(info),
  };
}

async function cutImageBase64(path: string): Promise<string | null> {
  try {
    const result = await getImage(path);
    return result?.base64 ?? null;
  } catch {
    return null;
  }
}

/** 取 tooltip 圖示：一般裝備用 `info/icon`；髮型/臉型改用預設外觀圖。 */
async function tooltipIcon(
  rootPath: string,
  itemId: string,
  categoryHint: string,
): Promise<string | null> {
  const icon = await cutImageBase64(`${rootPath}/info/icon`);
  if (icon) return icon;
  const hint = categoryHint.toLowerCase();
  let inner: string | null = null;
  if (hint === "hair") inner = "default/hairOverHead";
  else if (hint === "face") inner = "default/face";
  else {
    // Character 直屬的 0002xxxx（臉型）/0003~0005（髮型）。
    const prefix = Math.floor((Number.parseInt(itemId, 10) || 0) / 10000);
    if (prefix === 2) inner = "default/face";
    else if (prefix >= 3 && prefix <= 5) inner = "default/hairOverHead";
  }
  return inner ? cutImageBase64(`${rootPath}/${inner}`) : null;
}

function gearAttributes(info: TreeNode): string[] {
  const attributes: string[] = [];
  if (propBool(info, "only")) attributes.push("only");
  if (propBool(info, "cash")) attributes.push("cash");
  if (propBool(info, "timeLimited")) attributes.push("timeLimited");
  if (propBool(info, "tradeBlock")) attributes.push("tradeBlock");
  else if (propBool(info, "accountSharable")) attributes.push("accountSharable");
  if (propBool(info, "onlyEquip")) attributes.push("onlyEquip");
  return attributes;
}

function gearStats(info: TreeNode): TooltipStat[] {
  const stats: TooltipStat[] = [];
  for (const key of GEAR_STAT_KEYS) {
    const value = propI64(info, key);
    if (value == null || value === 0) continue;
    stats.push({ key, value });
  }
  return stats;
}

function requiredJobs(reqJob: number | null): string[] {
  if (reqJob == null || reqJob === 0) return [...ALL_JOBS];
  const jobs = JOB_MASKS.filter(([mask]) => reqJob & mask).map(([, code]) => code);
  return jobs.length > 0 ? jobs : [...ALL_JOBS];
}

/** 8 碼裝備 id 的前 3 位分類碼（id 開頭必為 0，例如 01302000 → 130）。 */
function idPrefix3(itemId: string): number {
  return Math.floor((Number.parseInt(itemId, 10) || 0) / 10000);
}

/** 裝備分類代碼（對齊 item_tooltip.rs 的 gear_category）：先看 id 分類碼，再看目錄名。 */
function gearCategory(itemId: string, categoryHint: string): string {
  const prefix = idPrefix3(itemId);
  const byPrefix: Record<number, string> = {
    100: "cap",
    101: "faceAccessory",
    102: "eyeAccessory",
    103: "earrings",
    104: "coat",
    105: "longcoat",
    106: "pants",
    107: "shoes",
    108: "glove",
    109: "shield",
    110: "cape",
    111: "ring",
    112: "pendant",
    113: "belt",
    114: "medal",
    115: "shoulder",
  };
  if (byPrefix[prefix]) return byPrefix[prefix];
  if (prefix >= 121 && prefix <= 159) return "weapon";
  switch (categoryHint.toLowerCase()) {
    case "accessory":
    case "cap":
    case "coat":
    case "longcoat":
    case "pants":
    case "shoes":
    case "glove":
    case "shield":
    case "cape":
    case "weapon":
    case "ring":
    case "face":
    case "hair":
      return categoryHint.toLowerCase();
    case "petequip":
      return "petEquip";
    case "tamingmob":
      return "tamingMob";
    default: {
      // Character 直屬的 0002xxxx（臉型）/0003~0005（髮型）。
      if (prefix === 2) return "face";
      if (prefix >= 3 && prefix <= 5) return "hair";
      return "equip";
    }
  }
}

/** 武器種類代碼（對齊 item_tooltip.rs 的 weapon_type）；不是已知武器回 null。 */
function weaponType(itemId: string): string | null {
  const types: Record<number, string> = {
    130: "oneHandedSword",
    131: "oneHandedAxe",
    132: "oneHandedBlunt",
    133: "dagger",
    134: "katara",
    136: "cane",
    137: "wand",
    138: "staff",
    140: "twoHandedSword",
    141: "twoHandedAxe",
    142: "twoHandedBlunt",
    143: "spear",
    144: "polearm",
    145: "bow",
    146: "crossbow",
    147: "claw",
    148: "knuckle",
    149: "gun",
  };
  return types[idPrefix3(itemId)] ?? null;
}

// ---------------------------------------------------------------------------
// export 契約
// ---------------------------------------------------------------------------

/**
 * 路徑指向裝備（Character 下 8 碼數字 img 或其內部節點）時回傳 tooltip；
 * 非裝備路徑回 null（對齊 item_tooltip.rs 的 get_item_tooltip）。
 */
export async function getItemTooltip(path: string): Promise<ItemTooltip | null> {
  const segments = path.split("/");
  if (segments[0] !== "Character") return null;
  let imgPath: string;
  let hint: string;
  if (segments.length >= 2 && isIdSegment(segments[1])) {
    imgPath = `Character/${segments[1]}`;
    hint = "";
  } else if (segments.length >= 3 && isIdSegment(segments[2])) {
    imgPath = `Character/${segments[1]}/${segments[2]}`;
    hint = segments[1];
  } else {
    return null;
  }
  const state = requireCatalog();
  if (!Object.prototype.hasOwnProperty.call(state.entries, imgPath)) return null;
  const tree = await loadTree(imgPath);
  return buildTooltip(imgPath, tree, hint);
}

/**
 * 以道具 id 取 tooltip（怪物圖鑑戰利品 hover 用）；支援所有類別
 * （Character / Item 各分區），候選路徑逐一嘗試，找不到回 null。
 */
export async function getItemTooltipById(itemId: number): Promise<ItemTooltip | null> {
  const state = requireCatalog();
  const hasPath = (path: string) =>
    Object.prototype.hasOwnProperty.call(state.entries, path);
  // Character 直屬 img（0002xxxx 臉型、0003~0005 髮型等）優先。
  const candidates = [
    `Character/${String(itemId).padStart(8, "0")}`,
    ...itemPathCandidates(itemId, hasPath),
  ];
  for (const candidate of candidates) {
    const split = splitImgPrefix(state.entries, candidate);
    if (!split) continue;
    const [imgKey, inner] = split;
    let tree: TreeNode;
    try {
      tree = await loadTree(imgKey);
    } catch {
      continue;
    }
    const node = inner === "" ? tree : findNode(tree, inner);
    if (!node) continue;
    const categoryHint =
      segments2Hint(candidate);
    const tooltip = await buildTooltip(candidate, node, categoryHint);
    if (tooltip) return tooltip;
  }
  return null;
}

/** Character/<分類>/<id> 的分類提示；其餘路徑沒有提示。 */
function segments2Hint(path: string): string {
  const segments = path.split("/");
  return segments[0] === "Character" && segments.length === 3 ? segments[1] : "";
}
