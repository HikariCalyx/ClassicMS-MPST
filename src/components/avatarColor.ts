import type { EquipItem } from "../api";
import type { EquipSlot } from "./AvatarPage";

// 髮型/臉型的顏色編碼（對遊戲資料驗證過）：
// - 髮型：末碼是顏色（0003XXX0–7），其餘位是造型。名稱依序：黑/紅/橙/黃/綠/藍/紫/褐。
// - 臉型：百位數是顏色（0002CXXSS，C = 顏色，即倒數第三碼），其餘位是造型。
//   顏色 0–8，名稱依序：黑/青/紅/綠/黃/藍/紫/粉/白（8 白色非每個造型都有）。
// 這裡只存顏色代碼；顯示名稱在 i18n 的 avatar.color.*，渲染時依介面語言翻譯。

/** 髮型顏色代碼（index = 末碼顏色碼 0–7）。 */
export const HAIR_COLOR_NAMES = [
  "black",
  "red",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
  "brown",
] as const;

/** 臉型專用顏色代碼（index = 百位數顏色碼 0–8）。 */
export const FACE_COLOR_NAMES = [
  "black",
  "cyan",
  "red",
  "green",
  "yellow",
  "blue",
  "purple",
  "pink",
  "white",
] as const;

export type ColorName = (typeof HAIR_COLOR_NAMES)[number] | (typeof FACE_COLOR_NAMES)[number];

/** 該 slot 的顏色位階（hair = 個位、face = 百位）；無顏色概念回 null。 */
function colorUnitOf(slot: EquipSlot): 1 | 100 | null {
  if (slot === "hair") return 1;
  if (slot === "face") return 100;
  return null;
}

/** 拆出造型基底（去掉顏色位）與顏色號；非髮/臉或 id 非數字回 null。 */
export function splitColorId(
  slot: EquipSlot,
  id: string,
): { base: number; color: number } | null {
  const unit = colorUnitOf(slot);
  const n = Number(id);
  if (!unit || !Number.isInteger(n)) return null;
  const color = Math.floor(n / unit) % 10;
  return { base: n - color * unit, color };
}

/** 造型基底 + 顏色號 → 完整 8 碼 id。 */
export function joinColorId(slot: EquipSlot, base: number, color: number): string {
  const unit = colorUnitOf(slot) ?? 1;
  return String(base + color * unit).padStart(8, "0");
}

/** 同造型只留一個代表（優先顏色 0，其次最小顏色）；順序維持原清單。 */
export function dedupeColorVariants(slot: EquipSlot, items: EquipItem[]): EquipItem[] {
  if (!colorUnitOf(slot)) return items;
  const byBase = new Map<number, EquipItem>();
  for (const item of items) {
    const split = splitColorId(slot, item.id);
    if (!split) continue;
    const prev = byBase.get(split.base);
    if (!prev) {
      byBase.set(split.base, item);
      continue;
    }
    const prevColor = splitColorId(slot, prev.id)?.color ?? 0;
    if (split.color === 0 || (prevColor !== 0 && split.color < prevColor)) {
      byBase.set(split.base, item);
    }
  }
  return [...byBase.values()];
}

/**
 * 造型（用它的任一 variant id 表示）+ 想要的顏色 → 實際存在的 id。
 * 該造型沒有此色時退回顏色 0，再不行回傳原 id。
 */
export function resolveColorVariant(
  slot: EquipSlot,
  id: string,
  color: number,
  exists: (id: string) => boolean,
): string {
  const split = splitColorId(slot, id);
  if (!split) return id;
  const wanted = joinColorId(slot, split.base, color);
  if (exists(wanted)) return wanted;
  const zero = joinColorId(slot, split.base, 0);
  if (exists(zero)) return zero;
  return id;
}

// 髮型/臉型名稱開頭的顏色詞（列表只留一色後，卡片顯示造型名即可）。
const COLOR_NAME_PREFIX = /^(?:黑色|青色|紅色|橙色|黃色|綠色|藍色|紫色|粉色|白色|褐色)/;

/** 去掉名稱開頭的顏色詞；去完會變空字串時回原名。 */
export function stripColorPrefix(name: string): string {
  return name.replace(COLOR_NAME_PREFIX, "") || name;
}
