// Hosted 版寵物紙娃娃：把 src-tauri/src/pet.rs 的合成邏輯移植到 TypeScript。
// 資料來源是靜態資料集（features/*.json + tree/*.json），只產圖層節點路徑
// 與座標，前端用 api.getImage 取圖。
//
// 與角色紙娃娃（avatar.ts）的差異（對齊 pet.rs 模組註解）：
// - 本體在 `Item/Pet/<id>`（7 碼 id），動作節點的幀直接就是 canvas
//   （帶 origin/delay，無 map 錨點）；頂層另有 info/interact/food/slang 非動作節點。
// - 寵物裝備在 `Character/PetEquip/<id>`（8 碼 id），第二層是支援的寵物 id
//   （去前導零），再往下才是動作幀；幀只有 origin，delay 跟隨本體。
// - 對齊 = 原點對齊：以第 0 幀 origin 為固定基準，第 i 幀 pos = origin_0 − origin_i；
//   寵裝 origin 與寵物幀 origin 重合，用同一基準點。

import { DATA_ROOT, fetchChecked, findNode, loadTree, resolveUolTarget } from "./core";
import type { TreeNode } from "./core";
import { t } from "../i18n";
import type {
  AvatarFrame,
  AvatarFrames,
  AvatarLayer,
  PetEquipInfo,
  PetInfo,
  Value,
} from "../api.hosted";

/** 幀 delay 的預設值（毫秒）。 */
const DEFAULT_DELAY = 100;
/** UOL / action+frame 連鎖解析的上限（防循環）。 */
const RESOLVE_LIMIT = 8;

/** 寵物本體圖層 z（只有本體+寵裝兩層，值只需相對大小）。 */
const PET_BODY_Z = 0;
/** 寵物裝備畫在本體之上（z 遞減排序，小者後畫 = 上層）。 */
const PET_EQUIP_Z = -1;

/** 寵物 img 頂層的非動作節點（掃動作清單與 fallback 時排除）。 */
const NON_ACTION_NODES = new Set(["info", "interact", "food", "slang"]);

// ---------------------------------------------------------------------------
// features JSON（fetch + session 快取）
// ---------------------------------------------------------------------------

let petListCache: Promise<PetInfo[]> | null = null;
let petEquipListCache: Promise<PetEquipInfo[]> | null = null;

/** 寵物清單（pipeline 預處理好的 features JSON：id/name/iconPath/actions）。 */
export function getPetList(): Promise<PetInfo[]> {
  if (!petListCache) {
    petListCache = fetchChecked(`${DATA_ROOT}/features/pet_list.json`).then(
      (response) => response.json() as Promise<PetInfo[]>,
    );
    petListCache.catch(() => {
      petListCache = null;
    });
  }
  return petListCache;
}

/** 寵物裝備清單（features JSON：id/name/iconPath/petIds/cash）。 */
export function getPetEquipList(): Promise<PetEquipInfo[]> {
  if (!petEquipListCache) {
    petEquipListCache = fetchChecked(`${DATA_ROOT}/features/pet_equip_list.json`).then(
      (response) => response.json() as Promise<PetEquipInfo[]>,
    );
    petEquipListCache.catch(() => {
      petEquipListCache = null;
    });
  }
  return petEquipListCache;
}

// ---------------------------------------------------------------------------
// 節點小工具（對齊 avatar.ts 的 helpers）
// ---------------------------------------------------------------------------

function childOf(node: TreeNode, name: string): TreeNode | null {
  return node.children?.find((c) => c.name === name) ?? null;
}

function valueAsI32(value: Value): number | null {
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

function vectorProp(node: TreeNode, name: string): [number, number] | null {
  const child = childOf(node, name);
  return child?.value.type === "Vector" ? child.value.value : null;
}

function frameDelay(node: TreeNode): number {
  const child = childOf(node, "delay");
  return (child && valueAsI32(child.value)) ?? DEFAULT_DELAY;
}

function isDigits(name: string): boolean {
  return name.length > 0 && /^\d+$/.test(name);
}

/** 節點是否像個動作：含數字名子節點（幀）或 canvas/UOL。 */
function looksLikeAction(node: TreeNode): boolean {
  return (node.children ?? []).some(
    (c) => isDigits(c.name) || c.value.type === "Canvas" || c.value.type === "Uol",
  );
}

// ---------------------------------------------------------------------------
// UOL / 幀解析（對齊 avatar.ts 的 resolveNode/resolveFrame）
// ---------------------------------------------------------------------------

/** 解析節點：若為 UOL 則跟隨到目標節點。回傳目標節點與解析後的相對路徑。 */
function resolveNode(root: TreeNode, rel: string): { node: TreeNode; path: string } | null {
  let path = rel;
  for (let i = 0; i < RESOLVE_LIMIT; i += 1) {
    const node = findNode(root, path);
    if (!node) return null;
    if (node.value.type !== "Uol") return { node, path };
    const next = resolveUolTarget(path, node.value.value);
    if (next == null) return null;
    path = next;
  }
  return null;
}

/** 解析幀節點：跟隨 UOL，以及 action+frame 屬性的跨動作引用。回傳解析後的相對路徑。 */
function resolveFrame(root: TreeNode, rel: string): string | null {
  let path = rel;
  for (let i = 0; i < RESOLVE_LIMIT; i += 1) {
    const resolved = resolveNode(root, path);
    if (!resolved) return null;
    const { node } = resolved;
    const actionChild = childOf(node, "action");
    const frameChild = childOf(node, "frame");
    const actionName = actionChild?.value.type === "Str" ? actionChild.value.value : null;
    const frameNo = frameChild ? valueAsI32(frameChild.value) : null;
    if (actionName != null && frameNo != null) {
      path = `${actionName}/${frameNo}`;
    } else {
      return resolved.path;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 動作與幀列表（fallback 鏈：指定動作 → stand0 → 第一個像動作的子節點）
// ---------------------------------------------------------------------------

/** 在 base 節點（baseRel 為其在 img 內的相對路徑）上找動作；
 *  fallback 排除 info/interact/food/slang 等非動作節點。 */
function findActionAt(base: TreeNode, baseRel: string, chain: string[]): string | null {
  const rel = (name: string) => (baseRel === "" ? name : `${baseRel}/${name}`);
  const children = base.children ?? [];
  for (const cand of chain) {
    if (children.some((c) => c.name === cand && looksLikeAction(c))) {
      return rel(cand);
    }
  }
  const fallback = children.find(
    (c) => !NON_ACTION_NODES.has(c.name) && looksLikeAction(c),
  );
  return fallback ? rel(fallback.name) : null;
}

/** 動作節點的幀列表（數字名子節點，依數值排序）；
 *  無數位子節點時把動作節點本身視為單幀（對齊 avatar 的 frame_list）。 */
function frameList(root: TreeNode, actionRel: string): string[] {
  const actionNode = findNode(root, actionRel);
  if (!actionNode) return [];
  const frames = (actionNode.children ?? [])
    .filter((c) => isDigits(c.name))
    .map((c) => ({ n: Number(c.name), rel: `${actionRel}/${c.name}` }))
    .sort((a, b) => a.n - b.n);
  if (frames.length === 0) return [actionRel];
  return frames.map((f) => f.rel);
}

/** 幀索引循環：寵裝幀數與本體幀數不一致時 modulo。 */
function wrapIndex(i: number, len: number): number {
  return i % len;
}

/** 解析寵物裝備幀列表：`<equip>/<pet id 去前導零>/<action>`，動作 fallback 同本體。
 *  裝備不存在、不支援該寵物或無可用動作時回 null（當沒穿，不視為錯誤）。 */
async function resolvePetEquip(
  equipId: string,
  petId: string,
  action: string,
): Promise<{ imgKey: string; tree: TreeNode; frames: string[] } | null> {
  const imgKey = `Character/PetEquip/${equipId}`;
  let tree: TreeNode;
  try {
    tree = await loadTree(imgKey);
  } catch {
    return null;
  }
  const petKey = petId.replace(/^0+/, "");
  const petNode = findNode(tree, petKey);
  if (!petNode) return null;
  const actionRel = findActionAt(petNode, petKey, [action, "stand0"].filter((s) => s !== ""));
  if (actionRel == null) return null;
  const frames = frameList(tree, actionRel)
    .map((rel) => resolveFrame(tree, rel))
    .filter((rel): rel is string => rel != null);
  if (frames.length === 0) return null;
  return { imgKey, tree, frames };
}

// ---------------------------------------------------------------------------
// 合成主流程（pet.rs:123-206）
// ---------------------------------------------------------------------------

/**
 * 合成寵物一個動作的所有幀圖層。
 *
 * 幀間定位：以第 0 幀 origin 為固定基準點，第 i 幀 pos = origin_0 − origin_i。
 * 寵裝幀 index 對齊本體（modulo 本體幀數），pos = origin_0 − 寵裝 origin。
 * faceFrames/effectFrames 恆空（寵物無表情分離與 ItemEff）。
 */
export async function getPetFrames(
  petId: string,
  equipId: string | null,
  action: string,
): Promise<AvatarFrames> {
  const imgKey = `Item/Pet/${petId}`;
  const tree = await loadTree(imgKey);
  const actionRel = findActionAt(tree, "", [action, "stand0"].filter((s) => s !== ""));
  if (actionRel == null) {
    throw new Error(t("data.error.petNoAction", { id: petId, action }));
  }
  const bodyFrames = frameList(tree, actionRel)
    .map((rel) => resolveFrame(tree, rel))
    .filter((rel): rel is string => rel != null);
  if (bodyFrames.length === 0) {
    throw new Error(t("data.error.petNoFrames", { id: petId, action }));
  }

  // 每幀的（delay, origin）；寵物幀節點本身就是 canvas
  const bodyMeta = bodyFrames.map((rel) => {
    const node = findNode(tree, rel);
    const delay = node ? frameDelay(node) : DEFAULT_DELAY;
    const origin = (node && vectorProp(node, "origin")) ?? ([0, 0] as [number, number]);
    return { delay, origin };
  });
  const origin0 = bodyMeta[0]?.origin ?? [0, 0];

  const equip = equipId != null ? await resolvePetEquip(equipId, petId, action) : null;

  const frames: AvatarFrame[] = bodyFrames.map((rel, i) => {
    const { delay, origin } = bodyMeta[i];
    const layers: AvatarLayer[] = [
      {
        path: `${imgKey}/${rel}`,
        x: origin0[0] - origin[0],
        y: origin0[1] - origin[1],
        z: PET_BODY_Z,
      },
    ];
    if (equip) {
      const erel = equip.frames[wrapIndex(i, equip.frames.length)];
      const node = findNode(equip.tree, erel);
      if (node) {
        const eorigin = vectorProp(node, "origin") ?? [0, 0];
        layers.push({
          path: `${equip.imgKey}/${erel}`,
          x: origin0[0] - eorigin[0],
          y: origin0[1] - eorigin[1],
          z: PET_EQUIP_Z,
        });
      }
    }
    layers.sort((a, b) => b.z - a.z);
    return { delay, layers, faceAnchor: null, showFace: false };
  });

  return { frames, faceFrames: [], effectFrames: [] };
}
