// 道具 tooltip 的顯示文字：後端（item_tooltip.rs / hosted/tooltip.ts）只回代碼與原始數值，
// 這裡依介面語言組成標題、分類行、職業列與能力值（畫面與 PNG 匯出共用）。

import type { ItemTooltip } from "../api";
import type { TFunction } from "../i18n";

/** 職業列的固定順序（對齊 item_tooltip.rs 的 ALL_JOBS）。 */
const JOBS = ["beginner", "warrior", "magician", "bowman", "thief", "pirate"] as const;

const ATTRIBUTES = [
  "only",
  "cash",
  "timeLimited",
  "tradeBlock",
  "accountSharable",
  "onlyEquip",
] as const;

const CATEGORIES = [
  "cap",
  "faceAccessory",
  "eyeAccessory",
  "earrings",
  "coat",
  "longcoat",
  "pants",
  "shoes",
  "glove",
  "shield",
  "cape",
  "ring",
  "pendant",
  "belt",
  "medal",
  "shoulder",
  "weapon",
  "accessory",
  "petEquip",
  "tamingMob",
  "face",
  "hair",
  "equip",
] as const;

const WEAPON_TYPES = [
  "oneHandedSword",
  "oneHandedAxe",
  "oneHandedBlunt",
  "dagger",
  "katara",
  "cane",
  "wand",
  "staff",
  "twoHandedSword",
  "twoHandedAxe",
  "twoHandedBlunt",
  "spear",
  "polearm",
  "bow",
  "crossbow",
  "claw",
  "knuckle",
  "gun",
] as const;

const STAT_KEYS = [
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
] as const;

function isOneOf<T extends string>(list: readonly T[], value: string | null): value is T {
  return value !== null && (list as readonly string[]).includes(value);
}

export interface TooltipLine {
  label: string;
  value: string;
}

export interface TooltipText {
  /** 名稱（有性別限制時附上性別）。 */
  title: string;
  /** 道具屬性（專屬道具、不可交易…）以逗號串起；沒有時為空字串。 */
  attributes: string;
  req: { level: string; str: string; dex: string; int: string; luk: string };
  jobs: { code: string; label: string; enabled: boolean }[];
  /** 「武器分類 : 單手劍」或「裝備分類 : 帽子」。 */
  categoryLine: string;
  /** 攻擊速度（沒有此屬性時為 null）。 */
  attackSpeed: TooltipLine | null;
  stats: TooltipLine[];
  /** 可使用卷軸次數（沒有此屬性時為 null）。 */
  scrollCount: TooltipLine | null;
}

function attackSpeedLabel(value: number, t: TFunction): string {
  if (value < 2) return t("tooltip.speed.veryFast");
  switch (value) {
    case 2:
    case 3:
      return t("tooltip.speed.faster");
    case 4:
    case 5:
      return t("tooltip.speed.fast");
    case 6:
      return t("tooltip.speed.normal");
    case 7:
    case 8:
      return t("tooltip.speed.slow");
    case 9:
      return t("tooltip.speed.slower");
    default:
      return t("tooltip.speed.verySlow");
  }
}

function categoryLine(details: ItemTooltip, t: TFunction): string {
  const weaponType = details.weaponType;
  if (isOneOf(WEAPON_TYPES, weaponType)) {
    return `${t("tooltip.weaponType")} : ${t(`tooltip.weapon.${weaponType}`)}`;
  }
  const category = isOneOf(CATEGORIES, details.category)
    ? t(`tooltip.category.${details.category}`)
    : details.category;
  return `${t("tooltip.equipType")} : ${category}`;
}

/** 名稱加上性別限制（字串表缺名時名稱是道具 id）。 */
export function tooltipTitle(details: ItemTooltip, t: TFunction): string {
  if (details.reqGender === 0) return `${details.title} ${t("tooltip.gender.male")}`;
  if (details.reqGender === 1) return `${details.title} ${t("tooltip.gender.female")}`;
  return details.title;
}

export function tooltipText(details: ItemTooltip, t: TFunction): TooltipText {
  return {
    title: tooltipTitle(details, t),
    attributes: details.attributes
      .map((code) => (isOneOf(ATTRIBUTES, code) ? t(`tooltip.attr.${code}`) : code))
      .join(", "),
    req: {
      level: t("tooltip.req.level"),
      str: t("tooltip.req.str"),
      dex: t("tooltip.req.dex"),
      int: t("tooltip.req.int"),
      luk: t("tooltip.req.luk"),
    },
    jobs: JOBS.map((code) => ({
      code,
      label: t(`tooltip.job.${code}`),
      enabled: details.requiredJobs.includes(code),
    })),
    categoryLine: categoryLine(details, t),
    attackSpeed:
      details.attackSpeed === null
        ? null
        : { label: t("tooltip.attackSpeed"), value: attackSpeedLabel(details.attackSpeed, t) },
    stats: details.stats.map(({ key, value }) => ({
      label: isOneOf(STAT_KEYS, key) ? t(`tooltip.stat.${key}`) : key,
      value: value > 0 ? `+${value}` : String(value),
    })),
    scrollCount:
      details.scrollCount === null
        ? null
        : { label: t("tooltip.scrollCount"), value: String(details.scrollCount) },
  };
}
