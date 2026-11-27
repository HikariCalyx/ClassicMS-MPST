// Hosted 版紙娃娃：把 src-tauri/src/avatar.rs 的合成演算法移植到 TypeScript。
// 資料來源是靜態資料集（features/*.json + tree/*.json），不切圖；
// 只產圖層的節點路徑與座標，前端用 api.getImage 取圖。
//
// 演算法概念（對齊 avatar.rs 的模組註解）：維護一張全域錨點絕對位置表，
// 每張 canvas 用 `map` 中第一個已知錨點對齊（pos = anchor_abs - origin - map），
// 放置後把自己的錨點登錄進表（先放者為準，不覆蓋同名）。
// 圖層順序對齊 WzComparerR2 的 zmap 規則（index 0 最上層，繪製順序 = z 遞減）。

import { DATA_ROOT, fetchChecked, findNode, loadTree, resolveUolTarget } from "./core";
import type { TreeNode } from "./core";
import { t } from "../i18n";
import type {
  AvatarFrame,
  AvatarFrames,
  AvatarLayer,
  AvatarMeta,
  EquipItem,
  PartInput,
  Value,
} from "../api.hosted";

// ---------------------------------------------------------------------------
// ZMAP：zmap 圖層順序表（avatar.rs:22-172 照抄，共 149 層，index 0 最上層）
// ---------------------------------------------------------------------------

const ZMAP: readonly string[] = [
  "mobEquipFront",
  "tamingMobFront",
  "mobEquipMid",
  "saddleFront",
  "mobEquipUnderSaddle",
  "tamingMobMid",
  "characterStart",
  "emotionOverBody",
  "weaponWristOverGlove",
  "capeOverHead",
  "weaponOverGlove",
  "gloveWristOverHair",
  "gloveOverHair",
  "handOverHair",
  "weaponOverHand",
  "shieldOverHair",
  "gloveWristBelowWeapon",
  "gloveBelowWeapon",
  "handBelowWeapon",
  "weaponOverArm",
  "gloveWristBelowMailArm",
  "mailArmOverHair",
  "gloveBelowMailArm",
  "armOverHair",
  "mailArmOverHairBelowWeapon",
  "armOverHairBelowWeapon",
  "weaponBelowArm",
  "capOverHair",
  "hairOverHead",
  "accessoryEyeOverCap",
  "capAccessory",
  "cap",
  "hair",
  "accessoryEye",
  "accessoryEyeShadow",
  "accessoryFace",
  "capAccessoryBelowAccFace",
  "accessoryEar",
  "capBelowAccessory",
  "accessoryFaceOverFaceBelowCap",
  "face",
  "accessoryFaceBelowFace",
  "hairShade",
  "head",
  "cape",
  "gloveWrist",
  "mailArm",
  "glove",
  "hand",
  "arm",
  "weapon",
  "shield",
  "weaponOverArmBelowHead",
  "gloveWristBelowHead",
  "mailArmBelowHeadOverMailChest",
  "gloveBelowHead",
  "armBelowHeadOverMailChest",
  "mailArmBelowHead",
  "armBelowHead",
  "weaponOverBody",
  "mailChestTop",
  "gloveWristOverBody",
  "mailChestOverHighest",
  "pantsOverMailChest",
  "mailChest",
  "shoesTop",
  "pantsOverShoesBelowMailChest",
  "shoesOverPants",
  "mailChestOverPants",
  "pants",
  "shoes",
  "pantsBelowShoes",
  "mailChestBelowPants",
  "gloveOverBody",
  "body",
  "gloveWristBelowBody",
  "gloveBelowBody",
  "capAccessoryBelowBody",
  "shieldBelowBody",
  "capeBelowBody",
  "hairBelowBody",
  "weaponBelowBody",
  "backHairOverCape",
  "backWing",
  "backWeaponOverShield",
  "backShield",
  "backCapOverHair",
  "backHair",
  "backCap",
  "backWeaponOverHead",
  "backHairBelowCapWide",
  "backHairBelowCapNarrow",
  "backHairBelowCap",
  "backCape",
  "backAccessoryFaceOverHead",
  "backHead",
  "backMailChestOverPants",
  "backPantsOverMailChest",
  "backMailChest",
  "backPantsOverShoesBelowMailChest",
  "backShoes",
  "backPants",
  "backShoesBelowPants",
  "backPantsBelowShoes",
  "backMailChestBelowPants",
  "backWeaponOverGlove",
  "backGloveWrist",
  "backGlove",
  "backBody",
  "backAccessoryEar",
  "backAccessoryFace",
  "backCapAccessory",
  "backMailChestAccessory",
  "backShieldBelowBody",
  "backHairBelowHead",
  "backWeapon",
  "characterEnd",
  "saddleRear",
  "tamingMobRear",
  "mobEquipRear",
  "backMobEquipFront",
  "backTamingMobFront",
  "backMobEquipMid",
  "backSaddle",
  "backMobEquipUnderSaddle",
  "backTamingMobMid",
  "Sd",
  "Tm",
  "Sr",
  "Wg",
  "Ma",
  "Ws",
  "Pn",
  "So",
  "Si",
  "Wp",
  "Gv",
  "Ri",
  "Cp",
  "Ay",
  "As",
  "Ae",
  "Am",
  "Af",
  "At",
  "Fc",
  "Hr",
  "Hd",
  "Bd",
];

/** 幀 delay 的預設值（毫秒）。 */
const DEFAULT_DELAY = 100;
/** UOL / action+frame 連鎖解析的上限（防循環）。 */
const RESOLVE_LIMIT = 8;

// ---------------------------------------------------------------------------
// features JSON（fetch + session 快取）
// ---------------------------------------------------------------------------

let metaCache: Promise<AvatarMeta> | null = null;
let equipmentCache: Promise<EquipItem[]> | null = null;

/** 紙娃娃基本資料：body 動作清單 + 膚色清單（pipeline 預處理好的 features JSON）。 */
export function getAvatarMeta(): Promise<AvatarMeta> {
  if (!metaCache) {
    metaCache = fetchChecked(`${DATA_ROOT}/features/avatar_meta.json`).then(
      (response) => response.json() as Promise<AvatarMeta>,
    );
    metaCache.catch(() => {
      metaCache = null;
    });
  }
  return metaCache;
}

/** 全裝備清單（pipeline 預處理好的 features JSON，含 slot 與 cash 旗標）。 */
export function getAvatarEquipment(): Promise<EquipItem[]> {
  if (!equipmentCache) {
    equipmentCache = fetchChecked(`${DATA_ROOT}/features/avatar_equipment.json`).then(
      (response) => response.json() as Promise<EquipItem[]>,
    );
    equipmentCache.catch(() => {
      equipmentCache = null;
    });
  }
  return equipmentCache;
}

/** 指定臉型的表情清單（face img 的非 info 子節點名；avatar.rs:296）。 */
export async function getAvatarEmotions(faceId: string): Promise<string[]> {
  const tree = await loadTree(`Character/Face/${faceId}`);
  return (tree.children ?? []).filter((c) => c.name !== "info").map((c) => c.name);
}

// ---------------------------------------------------------------------------
// 節點小工具（對齊 avatar.rs 的 helpers；tree JSON 的 inner 路徑不含 img 根名）
// ---------------------------------------------------------------------------

/** 直接子節點查詢（對齊 Rust WzNode::find 的單層用法）。 */
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

function zStr(node: TreeNode): string | null {
  const child = childOf(node, "z");
  return child?.value.type === "Str" ? child.value.value : null;
}

function frameDelay(node: TreeNode): number {
  const child = childOf(node, "delay");
  return (child && valueAsI32(child.value)) ?? DEFAULT_DELAY;
}

/** 幀屬性 face=0 → 該幀不畫臉。 */
function frameFaceVisible(node: TreeNode): boolean {
  const child = childOf(node, "face");
  return (child ? valueAsI32(child.value) : null) !== 0;
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

/** canvas 的 z 圖層值 → zIndex（規則對齊 WzComparerR2；avatar.rs:904）。 */
function zIndex(node: TreeNode): number {
  const child = childOf(node, "z");
  if (!child) return ZMAP.length;
  const value = child.value;
  if (value.type === "Str") {
    const index = ZMAP.indexOf(value.value);
    return index === -1 ? ZMAP.length : index;
  }
  if (value.type === "U16" || value.type === "Int" || value.type === "Long") return intZIndex(value.value);
  return ZMAP.length;
}

/** 整數 z：n<0 時排到 `len-n`，n≥0 時 `-(1+n)`（排最上）。 */
function intZIndex(n: number): number {
  return n < 0 ? ZMAP.length - n : -(1 + n);
}

/** 幀索引循環：部位幀數與主幀數不一致時 modulo。 */
function wrapIndex(i: number, len: number): number {
  return i % len;
}

// ---------------------------------------------------------------------------
// UOL / 幀解析（avatar.rs:713-760）
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
    const action = actionChild?.value.type === "Str" ? actionChild.value.value : null;
    const frameNo = frameChild ? valueAsI32(frameChild.value) : null;
    if (action != null && frameNo != null) {
      path = `${action}/${frameNo}`;
    } else {
      return resolved.path;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 部位解析（avatar.rs:582-709）
// ---------------------------------------------------------------------------

/** 一個部位在某動作下解析出的幀列表（路徑皆為 UOL/action+frame 解析後的目標）。 */
interface ResolvedPart {
  slot: string;
  imgKey: string;
  tree: TreeNode;
  /** 每幀在 img 內的相對路徑（已解析）。 */
  frames: string[];
  canvases: CollectedCanvas[][];
  sourceCanvases: CollectedCanvas[];
}

/** slot + id → img 路徑（avatar.rs:632）。 */
function imgKeyOf(slot: string, id: string): string | null {
  switch (slot) {
    case "body":
    case "head":
      return `Character/${id}`;
    case "hair":
      return `Character/Hair/${id}`;
    case "face":
      return `Character/Face/${id}`;
    case "cap":
      return `Character/Cap/${id}`;
    case "coat":
      return `Character/Coat/${id}`;
    case "longcoat":
      return `Character/Longcoat/${id}`;
    case "pants":
      return `Character/Pants/${id}`;
    case "shoes":
      return `Character/Shoes/${id}`;
    case "glove":
      return `Character/Glove/${id}`;
    case "shield":
      return `Character/Shield/${id}`;
    case "cape":
      return `Character/Cape/${id}`;
    case "weapon":
      return `Character/Weapon/${id}`;
    case "earrings":
    case "faceAcc":
    case "eyeAcc":
      return `Character/Accessory/${id}`;
    default:
      return null;
  }
}

/** 在 img 樹上找動作節點；找不到時往數字名子節點裡找（cash 武器多一層武器類型節點）。 */
function findAction(root: TreeNode, chain: string[]): string | null {
  const direct = findActionAt(root, "", chain);
  if (direct != null) return direct;
  for (const child of root.children ?? []) {
    if (!isDigits(child.name)) continue;
    const nested = findActionAt(child, child.name, chain);
    if (nested != null) return nested;
  }
  return null;
}

function findActionAt(base: TreeNode, baseRel: string, chain: string[]): string | null {
  const rel = (name: string) => (baseRel === "" ? name : `${baseRel}/${name}`);
  const children = base.children ?? [];
  for (const cand of chain) {
    if (children.some((c) => c.name === cand && looksLikeAction(c))) {
      return rel(cand);
    }
  }
  // fallback：第一個非 info 且含幀/canvas 的子節點
  const fallback = children.find((c) => c.name !== "info" && looksLikeAction(c));
  return fallback ? rel(fallback.name) : null;
}

/** 動作節點的幀列表（數字名子節點，依數值排序）；
 *  動作節點直接含 canvas 時（hair/face 的 default、head 的 front）視為單幀。 */
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

async function resolvePart(
  part: PartInput,
  action: string,
  emotion: string,
): Promise<ResolvedPart | null> {
  const imgKey = imgKeyOf(part.slot, part.id);
  if (imgKey == null) return null;
  let tree: TreeNode;
  try {
    tree = await loadTree(imgKey);
  } catch {
    return null;
  }
  // fallback 鏈：指定動作 → stand1 → default → 第一個像動作的子節點；
  // 臉用 表情 → default（表情集沒有 stand1）
  const chain = (part.slot === "face" ? [emotion, "default"] : [action, "stand1", "default"]).filter(
    (s) => s !== "",
  );
  const actionRel = findAction(tree, chain);
  if (actionRel == null) return null;
  const frames = frameList(tree, actionRel)
    .map((rel) => resolveFrame(tree, rel))
    .filter((rel): rel is string => rel != null);
  if (frames.length === 0) return null;
  const canvases = frames.map((rel) => {
    const frame = findNode(tree, rel);
    return frame ? collectCanvases(tree, rel, frame) : [];
  });
  const sourceCanvases = ["body", "head", "face"].includes(part.slot) ? [] : collectExactCanvases(tree);
  return { slot: part.slot, imgKey, tree, frames, canvases, sourceCanvases };
}

// ---------------------------------------------------------------------------
// canvas 收集與對齊（avatar.rs:762-901）
// ---------------------------------------------------------------------------

interface CollectedCanvas {
  node: TreeNode;
  /** 解析後的相對路徑（layer.path = `${imgKey}/${rel}`）。 */
  rel: string;
}

/** 從幀節點收集 canvas（解析 UOL；SubTree 子節點如 hairShade/0..N 再往內收一層）。
 *  同一解析後路徑只收一次（hairShade 的 1..N 是指向 "0" 的 UOL 染髮別名）。 */
function collectCanvases(root: TreeNode, frameRel: string, frame: TreeNode): CollectedCanvas[] {
  const out: CollectedCanvas[] = [];
  const push = (node: TreeNode, rel: string) => {
    if (node.value.type === "Canvas" && !out.some((c) => c.rel === rel)) {
      out.push({ node, rel });
    }
  };
  for (const child of frame.children ?? []) {
    const childRel = `${frameRel}/${child.name}`;
    const resolved = resolveNode(root, childRel);
    if (!resolved) continue;
    const { node, path } = resolved;
    if (node.value.type === "Canvas") {
      push(node, path);
    } else if (node.value.type === "SubTree") {
      for (const groupChild of node.children ?? []) {
        // hairShade 群組只收編號 canvas（0 本體 + 1..N 的 UOL 染髮別名）：
        // 實機資料混有殘留的命名節點（如 00033200 的 그림자，z=Int(0)
        // 會被排到最頂層、整片蓋住帽子），WzComparerR2 也只取 hairShade/0。
        if (child.name === "hairShade" && !isDigits(groupChild.name)) continue;
        const groupRel = `${path}/${groupChild.name}`;
        const groupResolved = resolveNode(root, groupRel);
        if (groupResolved) push(groupResolved.node, groupResolved.path);
      }
    }
  }
  return out;
}

/** 同一裝備內可精確切出的圖片，供整個動作都缺某圖層時取近似畫面。 */
function collectExactCanvases(root: TreeNode): CollectedCanvas[] {
  const out: CollectedCanvas[] = [];
  const walk = (node: TreeNode, rel: string) => {
    if (node.value.type === "Canvas" && node.canvas && !rel.startsWith("info/")) {
      out.push({ node, rel });
    }
    for (const child of node.children ?? []) {
      walk(child, rel ? `${rel}/${child.name}` : child.name);
    }
  };
  walk(root, "");
  return out;
}

/** 動作幀沒有單圖索引時，找圖層與原點都相近的圖片。 */
function canvasImage(part: ResolvedPart, frameIndex: number, canvas: CollectedCanvas): CollectedCanvas | null {
  if (canvas.node.canvas) return canvas;
  // 表情不能借其他幀，否則會變成錯誤表情。身體缺圖時仍須保留當幀的錨點與位置。
  if (part.slot === "face") return null;
  const targetOrigin = vectorProp(canvas.node, "origin") ?? [0, 0];
  const sameLayer = ({ node }: CollectedCanvas) =>
    node.canvas && node.name === canvas.node.name && zIndex(node) === zIndex(canvas.node);
  const nearOrigin = ({ node }: CollectedCanvas) => {
    const origin = vectorProp(node, "origin") ?? [0, 0];
    return (targetOrigin[0] - origin[0]) ** 2 + (targetOrigin[1] - origin[1]) ** 2 <= 12 ** 2;
  };
  for (let distance = 1; distance < part.canvases.length; distance += 1) {
    for (const candidate of [frameIndex - distance, frameIndex + distance]) {
      const match = part.canvases[candidate]?.find((source) => sameLayer(source) && nearOrigin(source));
      if (match) return match;
    }
  }
  // 本體及頭部只借同一動作的幀，避免把不同姿勢的身體拼在一起。
  if (part.slot === "body" || part.slot === "head") return null;
  // 整個動作都沒有該圖層時，只借同圖層且原點接近的貼圖。
  // 不同 z 或差距過大的貼圖往往是完全不同的武器姿勢／特效。
  const targetAction = part.frames[frameIndex].replace(/\/[^/]+$/, "");
  let best: { canvas: CollectedCanvas; prefix: number; distance: number } | null = null;
  for (const source of part.sourceCanvases.filter(sameLayer)) {
    const sourceFrame = source.rel.replace(/\/[^/]+$/, "");
    let prefix = 0;
    while (prefix < targetAction.length && targetAction[prefix] === sourceFrame[prefix]) prefix += 1;
    const sourceOrigin = vectorProp(source.node, "origin") ?? [0, 0];
    const distance = (targetOrigin[0] - sourceOrigin[0]) ** 2 +
      (targetOrigin[1] - sourceOrigin[1]) ** 2;
    if (distance > 12 ** 2) continue;
    if (!best || distance < best.distance || (distance === best.distance && prefix > best.prefix)) {
      best = { canvas: source, prefix, distance };
    }
  }
  return best?.canvas ?? null;
}

/** 借圖時按兩張 canvas 共同的骨骼錨點對齊實際像素。 */
function borrowedImagePosition(
  pos: [number, number],
  target: TreeNode,
  source: TreeNode,
): [number, number] {
  if (target === source) return pos;
  const targetOrigin = vectorProp(target, "origin") ?? [0, 0];
  const sourceOrigin = vectorProp(source, "origin") ?? [0, 0];
  const targetMap = childOf(target, "map");
  const sourceMap = childOf(source, "map");
  for (const name of ["hand", "neck", "brow", "navel"]) {
    const targetPoint = targetMap?.children?.find((node) => node.name === name);
    const sourcePoint = sourceMap?.children?.find((node) => node.name === name);
    if (targetPoint?.value.type === "Vector" && sourcePoint?.value.type === "Vector") {
      return [
        pos[0] + targetOrigin[0] + targetPoint.value.value[0] - sourceOrigin[0] - sourcePoint.value.value[0],
        pos[1] + targetOrigin[1] + targetPoint.value.value[1] - sourceOrigin[1] - sourcePoint.value.value[1],
      ];
    }
  }
  return [pos[0] + targetOrigin[0] - sourceOrigin[0], pos[1] + targetOrigin[1] - sourceOrigin[1]];
}

type Anchors = Map<string, [number, number]>;

/** 用全域錨點表對齊：pos = anchor_abs - origin - map_point
 *  （找 map 中第一個已知錨點，忽略 muzzle；找不到放 (0,0)）。 */
function alignToAnchors(node: TreeNode, anchors: Anchors): [number, number] {
  const origin = vectorProp(node, "origin") ?? [0, 0];
  const map = childOf(node, "map");
  for (const m of map?.children ?? []) {
    if (m.name === "muzzle") continue;
    if (m.value.type !== "Vector") continue;
    const abs = anchors.get(m.name);
    if (abs) {
      return [abs[0] - origin[0] - m.value.value[0], abs[1] - origin[1] - m.value.value[1]];
    }
  }
  return [0, 0];
}

/** 對齊一張 canvas 並把自己的錨點登錄到全域表。
 *  body 部位的 body canvas 用 `rootPos`（該幀的 shift）；其餘用錨點對齊。
 *  錨點先放者為準，不覆蓋同名。回傳 canvas 左上角位置。 */
function placeCanvas(
  rootPos: [number, number] | null,
  node: TreeNode,
  anchors: Anchors,
): [number, number] {
  const origin = vectorProp(node, "origin") ?? [0, 0];
  const pos = rootPos ?? alignToAnchors(node, anchors);
  const map = childOf(node, "map");
  for (const m of map?.children ?? []) {
    if (m.value.type !== "Vector") continue;
    if (!anchors.has(m.name)) {
      anchors.set(m.name, [pos[0] + origin[0] + m.value.value[0], pos[1] + origin[1] + m.value.value[1]]);
    }
  }
  return pos;
}

/** 幀位移（楓之谷 client 的做法）：以第 0 幀 body origin 為固定基準點，
 *  第 i 幀 shift = origin_0 - origin_i + move；無 body canvas 的幀不位移。 */
function frameShift(
  origin0: [number, number],
  bodyOrigin: [number, number] | null,
  moveVec: [number, number] | null,
): [number, number] {
  if (!bodyOrigin) return [0, 0];
  const [mx, my] = moveVec ?? [0, 0];
  return [origin0[0] - bodyOrigin[0] + mx, origin0[1] - bodyOrigin[1] + my];
}

/** canvas 的 map 中指定錨點。 */
function mapPoint(node: TreeNode, name: string): [number, number] | null {
  const map = childOf(node, "map");
  const point = map?.children?.find((c) => c.name === name);
  return point?.value.type === "Vector" ? point.value.value : null;
}

/** face canvas 相對於 brow 錨點的相對座標：`-(origin + map_brow)`；
 *  map 沒有 brow 時為 null（呼叫端 fallback 到絕對位置）。 */
function faceRelativePos(node: TreeNode): [number, number] | null {
  const origin = vectorProp(node, "origin") ?? [0, 0];
  const brow = mapPoint(node, "brow");
  if (!brow) return null;
  return [-(origin[0] + brow[0]), -(origin[1] + brow[1])];
}

/** HairCover 規則（對齊 WzComparerR2）：遮髮時藏蓋頭髮層，不遮時藏帽下髮層。 */
function hairCanvasHidden(z: string | null, hairCover: boolean): boolean {
  if (z == null) return false;
  const WITH_CAP = ["hairOverHead", "backHairOverCape", "backHair"];
  const NO_CAP = ["hair", "backHairBelowCap", "backHairBelowCapWide", "backHairBelowCapNarrow"];
  return hairCover ? WITH_CAP.includes(z) : NO_CAP.includes(z);
}

// ---------------------------------------------------------------------------
// ItemEff 特效（avatar.rs 的 item_effect_frames / item_effect_anchor）
// ---------------------------------------------------------------------------

/** ItemEff 特效錨點（動作層 pos 決定）：pos=1 → 頭頂（x 沿用角色定位點）；
 *  pos=0/缺省 → 角色定位點（body 第 0 幀 origin，即腳底）。 */
function itemEffectAnchor(
  posMode: number,
  origin0: [number, number],
  headTopY: number | null,
): [number, number] {
  if (posMode === 1 && headTopY != null) return [origin0[0], headTopY];
  return origin0;
}

let itemEffTreeCache: Promise<TreeNode | null> | null = null;

/** Effect/ItemEff 整張 img（session 快取；資料集沒有就當無特效）。 */
function loadItemEffTree(): Promise<TreeNode | null> {
  if (!itemEffTreeCache) {
    itemEffTreeCache = loadTree("Effect/ItemEff").catch(() => null);
  }
  return itemEffTreeCache;
}

interface ItemEffect {
  /** 每幀在 img 內的相對路徑（已解析）。 */
  frames: string[];
  z: number;
  anchor: [number, number];
}

/** 掃描已穿裝備的 ItemEff 特效，組成獨立播放的特效幀序列（絕對座標）。
 *  這類裝備的本體貼圖多半是 1x1 空圖，外觀全靠特效（如披風 01103617 仲夏夜蝴蝶）。
 *  z 取動作層整數 z（canvas 上統一的 z=Int(0) 是無資訊預設值，忽略）；
 *  多個部位都有特效時共用一條時間軸，幀數以第一個為準、其餘 modulo 循環。 */
async function itemEffectFrames(
  resolved: ResolvedPart[],
  action: string,
  origin0: [number, number],
  headTopY: number | null,
): Promise<AvatarFrame[]> {
  const tree = await loadItemEffTree();
  if (!tree) return [];
  const effects: ItemEffect[] = [];
  for (const part of resolved) {
    // body/head/face 是紙娃娃本體，不可能有 ItemEff
    if (part.slot === "body" || part.slot === "head" || part.slot === "face") continue;
    // imgKey 尾段即裝備 id；ItemEff 的 key 是去掉前導零的 id（01103617 → "1103617"）
    const id = (part.imgKey.split("/").pop() ?? "").replace(/^0+/, "");
    if (id === "") continue;
    const effectRel = `${id}/effect`;
    const effectNode = findNode(tree, effectRel);
    if (!effectNode) continue;
    // 特效動作鏈：目前動作 → default → 第一個像動作的子節點
    const chain = [action, "default"].filter((s) => s !== "");
    const actionRel = findActionAt(effectNode, effectRel, chain);
    if (actionRel == null) continue;
    const actionNode = findNode(tree, actionRel);
    if (!actionNode) continue;
    const actionZ = childOf(actionNode, "z");
    const effectZ = childOf(effectNode, "z");
    const zRaw =
      (actionZ && valueAsI32(actionZ.value)) ?? (effectZ && valueAsI32(effectZ.value));
    const z = zRaw != null ? intZIndex(zRaw) : ZMAP.length;
    const posNode = childOf(actionNode, "pos");
    const posMode = (posNode && valueAsI32(posNode.value)) ?? 0;
    const frames = frameList(tree, actionRel)
      .map((rel) => resolveFrame(tree, rel))
      .filter((rel): rel is string => rel != null);
    if (frames.length === 0) continue;
    effects.push({ frames, z, anchor: itemEffectAnchor(posMode, origin0, headTopY) });
  }
  const first = effects[0];
  if (!first) return [];
  const out: AvatarFrame[] = [];
  for (let j = 0; j < first.frames.length; j += 1) {
    let delay = DEFAULT_DELAY;
    const layers: AvatarLayer[] = [];
    effects.forEach((eff, k) => {
      const rel = eff.frames[wrapIndex(j, eff.frames.length)];
      const node = findNode(tree, rel);
      if (!node) return;
      // 幀 delay 標在特效 canvas 自己身上
      if (k === 0) delay = frameDelay(node);
      const origin = vectorProp(node, "origin") ?? [0, 0];
      layers.push({
        path: `Effect/ItemEff/${rel}`,
        x: eff.anchor[0] - origin[0],
        y: eff.anchor[1] - origin[1],
        z: eff.z,
      });
    });
    layers.sort((a, b) => b.z - a.z);
    out.push({ delay, layers, faceAnchor: null, showFace: false });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 合成主流程（avatar.rs:386-580）
// ---------------------------------------------------------------------------

/**
 * 合成一個動作的所有幀圖層。
 *
 * 對齊順序：body → head → face → hair → cap → 其餘固定順序。
 * 主幀數 = body 動作幀數，其他部位幀索引用 modulo 循環。
 * 臉（face）獨立輸出到 faceFrames（layers 相對於 brow 錨點）。
 * ItemEff 特效（Effect/ItemEff 有對應 id 的裝備）獨立輸出到 effectFrames（絕對座標）。
 */
export async function getAvatarFrames(
  parts: PartInput[],
  action: string,
  emotion: string,
  hairCover: boolean,
  hairShade: boolean,
): Promise<AvatarFrames> {
  const REST_ORDER = [
    "coat",
    "longcoat",
    "pants",
    "shoes",
    "glove",
    "cape",
    "shield",
    "weapon",
    "earrings",
    "faceAcc",
    "eyeAcc",
  ];
  const ordered: PartInput[] = [];
  for (const slot of ["body", "head", "face", "hair", "cap", ...REST_ORDER]) {
    const found = parts.find((p) => p.slot === slot);
    if (found) ordered.push(found);
  }
  // 有效遮髮 = 有戴帽 + 使用者勾選遮髮（HairCover 規則見 hairCanvasHidden）。
  const capVisible = parts.some((p) => p.slot === "cap" && p.visible);
  const effectiveHairCover = capVisible && hairCover;

  const resolved: ResolvedPart[] = [];
  for (const part of ordered) {
    if (!part.visible) continue;
    const rp = await resolvePart(part, action, emotion);
    if (rp) {
      resolved.push(rp);
    } else if (part.slot === "body" || part.slot === "head") {
      // body/head 是紙娃娃本體，缺了直接算錯；其餘部位缺資料就略過
      throw new Error(t("data.error.partNoAction", { slot: part.slot, id: part.id, action }));
    }
  }
  const body = resolved.find((p) => p.slot === "body");
  if (!body) throw new Error(t("data.error.missingBody"));
  const bodyFrameCount = body.frames.length;
  const bodyDelays = body.frames.map((rel) => {
    const node = findNode(body.tree, rel);
    return node ? frameDelay(node) : DEFAULT_DELAY;
  });

  // 幀間基準點：以第 0 幀 body canvas 的 origin 為整個動作的固定基準；
  // 每幀 shift = origin_0 - origin_i + move（無 body canvas 的幀不位移）。
  const bodyOrigins: ([number, number] | null)[] = body.frames.map((rel, index) => {
    const frameNode = findNode(body.tree, rel);
    if (!frameNode) return null;
    const bodyCanvas = body.canvases[index].find(
      (c) => c.node.name === "body",
    );
    return bodyCanvas ? vectorProp(bodyCanvas.node, "origin") : null;
  });
  const origin0 = bodyOrigins.find((o) => o != null) ?? [0, 0];
  const bodyShifts = body.frames.map((rel, i) => {
    const frameNode = findNode(body.tree, rel);
    const moveVec = frameNode ? vectorProp(frameNode, "move") : null;
    return frameShift(origin0, bodyOrigins[i], moveVec);
  });

  const frames: AvatarFrame[] = [];
  const anchorTables: Anchors[] = [];
  // 第 0 幀 head canvas 的頂緣 y（ItemEff pos=1 特效的錨點用）。
  let headTopY: number | null = null;

  for (let i = 0; i < bodyFrameCount; i += 1) {
    // 全域錨點絕對位置表（每幀重算：單幀靜態等價）
    const anchors: Anchors = new Map();
    const layers: AvatarLayer[] = [];
    let showFace = true;
    for (const part of resolved) {
      // 臉不參與主迴圈：改用 faceAnchor/showFace 讓前端繪製當下配對
      if (part.slot === "face") continue;
      const partFrameIndex = wrapIndex(i, part.frames.length);
      const rel = part.frames[partFrameIndex];
      const frameNode = findNode(part.tree, rel);
      if (!frameNode) continue;
      if (part.slot === "body") {
        showFace = frameFaceVisible(frameNode);
      }
      const canvases = [...part.canvases[partFrameIndex]];
      if (part.slot === "body") {
        // body canvas 必須最先放（它的錨點是全角色的對齊基準）
        canvases.sort((a, b) => (a.node.name === "body" ? 0 : 1) - (b.node.name === "body" ? 0 : 1));
      }
      // 帽子遮髮規則。不遮髮時若整個髮型會被藏光就不藏：有些髮型
      // （如 00030160）只有一張 z="hair" 的本體貼圖、沒有 hairOverHead
      // 變體，藏了會變光頭。
      const hidden = canvases.map(
        (c) => part.slot === "hair" && hairCanvasHidden(zStr(c.node), effectiveHairCover),
      );
      const keepAll =
        !effectiveHairCover && hidden.length > 0 && hidden.every((hide) => hide);
      canvases.forEach(({ node, rel: crel }, index) => {
        if (hidden[index] && !keepAll) return;
        // 「髮型陰影」開關：不勾時藏 hairShade 層（z 標記在內層 canvas 上）。
        if (!hairShade && zStr(node) === "hairShade") return;
        const rootPos = part.slot === "body" && node.name === "body" ? bodyShifts[i] : null;
        const pos = placeCanvas(rootPos, node, anchors);
        if (i === 0 && part.slot === "head") {
          headTopY = headTopY == null ? pos[1] : Math.min(headTopY, pos[1]);
        }
        const image = canvasImage(part, partFrameIndex, { node, rel: crel });
        if (!image) return;
        const imagePos = borrowedImagePosition(pos, node, image.node);
        layers.push({
          path: `${part.imgKey}/${image.rel}`,
          x: imagePos[0],
          y: imagePos[1],
          z: zIndex(node),
        });
      });
    }
    layers.sort((a, b) => b.z - a.z);
    // brow 錨點（head canvas 的 map 登錄）= 前端畫臉的基準點
    const brow = anchors.get("brow");
    frames.push({
      delay: bodyDelays[i],
      layers,
      faceAnchor: brow ? [brow[0], brow[1]] : null,
      showFace,
    });
    anchorTables.push(anchors);
  }

  // 表情幀：幀數獨立；layers 是相對於 brow 錨點的相對座標，
  // 配對（身體幀 i × 表情幀 j）延到前端繪製當下。
  const faceFrames: AvatarFrame[] = [];
  const face = resolved.find((p) => p.slot === "face");
  if (face) {
    face.frames.forEach((rel, j) => {
      const frameNode = findNode(face.tree, rel);
      const delay = frameNode ? frameDelay(frameNode) : DEFAULT_DELAY;
      const layers: AvatarLayer[] = [];
      if (frameNode) {
        for (const { node, rel: crel } of collectCanvases(face.tree, rel, frameNode)) {
          const relPos = faceRelativePos(node);
          // fallback：face canvas 的 map 沒有 brow 時，
          // 退回舊做法（body 幀 j % 主幀數 的錨點表絕對位置）
          const pos = relPos ?? alignToAnchors(node, anchorTables[wrapIndex(j, bodyFrameCount)]);
          layers.push({
            path: `${face.imgKey}/${crel}`,
            x: pos[0],
            y: pos[1],
            z: zIndex(node),
          });
        }
        layers.sort((a, b) => b.z - a.z);
      }
      faceFrames.push({ delay, layers, faceAnchor: null, showFace: true });
    });
  }

  // ItemEff 特效幀：幀數獨立（同 faceFrames 的設計），絕對座標。
  const effectFrames = await itemEffectFrames(resolved, action, origin0, headTopY);

  return { frames, faceFrames, effectFrames };
}
