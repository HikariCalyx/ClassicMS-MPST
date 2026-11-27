// 技能瀏覽器的中繼資料：職業對照表、職業群分組、每級數值 prop 的標籤與單位、
// 以及楓之谷字串（\n 換行、#c…# 強調、#prop 佔位符）的解析工具。
// 遊戲字串表（String/TW/Skill）不含職業名稱，職業顯示名由此表提供；
// 表內只存代碼，顯示文字在 i18n/messages/skill.ts 依介面語言決定。

import type { MessageKey, TFunction } from "../i18n";

/** 職業群代碼：冒險家 / 皇家騎士團 / 英雄 / 其他。 */
export type JobGroup = "explorer" | "cygnus" | "hero" | "other";

/** 職業名稱代碼（顯示名為 skill.job.<代碼>）；同系列各轉同名時共用一個代碼。 */
type JobName =
  | "beginner"
  | "warrior"
  | "fighter"
  | "crusader"
  | "hero"
  | "page"
  | "whiteKnight"
  | "paladin"
  | "spearman"
  | "dragonKnight"
  | "darkKnight"
  | "magician"
  | "wizardFirePoison"
  | "mageFirePoison"
  | "archMageFirePoison"
  | "wizardIceLightning"
  | "mageIceLightning"
  | "archMageIceLightning"
  | "cleric"
  | "priest"
  | "bishop"
  | "bowman"
  | "hunter"
  | "ranger"
  | "bowmaster"
  | "crossbowman"
  | "sniper"
  | "marksman"
  | "thief"
  | "assassin"
  | "hermit"
  | "nightLord"
  | "bandit"
  | "chiefBandit"
  | "shadower"
  | "pirate"
  | "brawler"
  | "marauder"
  | "buccaneer"
  | "gunslinger"
  | "outlaw"
  | "corsair"
  | "noblesse"
  | "dawnWarrior"
  | "blazeWizard"
  | "windArcher"
  | "nightWalker"
  | "thunderBreaker"
  | "legend"
  | "aran"
  | "evan"
  | "mounts"
  | "gm";

/** 轉職階段：1 = 一轉 … 9 = 九轉（顯示名為 skill.tier.<階段>）。 */
type JobTier = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

/** 職業顯示資訊（依介面語言組好的文字）。 */
export interface JobMeta {
  name: string;
  /** 轉職階段（一轉/二轉…）；新手等不分階段的為 null。 */
  tier: string | null;
  group: JobGroup;
}

/** 對照表的一筆：只存代碼，顯示時才翻譯。 */
interface JobInfo {
  name: JobName;
  tier: JobTier | null;
  group: JobGroup;
}

/** (id, 名稱代碼, 轉職階段) 批次登記用。 */
type JobEntry = [id: string, name: JobName, tier?: JobTier];

function buildJobTable(): Record<string, JobInfo> {
  const table: Record<string, JobInfo> = {};
  const register = (group: JobGroup, entries: JobEntry[]) => {
    for (const [id, name, tier] of entries) {
      table[id] = { name, tier: tier ?? null, group };
    }
  };
  register("explorer", [
    ["000", "beginner"],
    ["100", "warrior", 1],
    ["110", "fighter", 2],
    ["111", "crusader", 3],
    ["112", "hero", 4],
    ["120", "page", 2],
    ["121", "whiteKnight", 3],
    ["122", "paladin", 4],
    ["130", "spearman", 2],
    ["131", "dragonKnight", 3],
    ["132", "darkKnight", 4],
    ["200", "magician", 1],
    ["210", "wizardFirePoison", 2],
    ["211", "mageFirePoison", 3],
    ["212", "archMageFirePoison", 4],
    ["220", "wizardIceLightning", 2],
    ["221", "mageIceLightning", 3],
    ["222", "archMageIceLightning", 4],
    ["230", "cleric", 2],
    ["231", "priest", 3],
    ["232", "bishop", 4],
    ["300", "bowman", 1],
    ["310", "hunter", 2],
    ["311", "ranger", 3],
    ["312", "bowmaster", 4],
    ["320", "crossbowman", 2],
    ["321", "sniper", 3],
    ["322", "marksman", 4],
    ["400", "thief", 1],
    ["410", "assassin", 2],
    ["411", "hermit", 3],
    ["412", "nightLord", 4],
    ["420", "bandit", 2],
    ["421", "chiefBandit", 3],
    ["422", "shadower", 4],
    ["500", "pirate", 1],
    ["510", "brawler", 2],
    ["511", "marauder", 3],
    ["512", "buccaneer", 4],
    ["520", "gunslinger", 2],
    ["521", "outlaw", 3],
    ["522", "corsair", 4],
  ]);
  register("cygnus", [
    ["1000", "noblesse"],
    ["1100", "dawnWarrior", 1],
    ["1110", "dawnWarrior", 2],
    ["1111", "dawnWarrior", 3],
    ["1112", "dawnWarrior", 4],
    ["1200", "blazeWizard", 1],
    ["1210", "blazeWizard", 2],
    ["1211", "blazeWizard", 3],
    ["1212", "blazeWizard", 4],
    ["1300", "windArcher", 1],
    ["1310", "windArcher", 2],
    ["1311", "windArcher", 3],
    ["1312", "windArcher", 4],
    ["1400", "nightWalker", 1],
    ["1410", "nightWalker", 2],
    ["1411", "nightWalker", 3],
    ["1412", "nightWalker", 4],
    ["1500", "thunderBreaker", 1],
    ["1510", "thunderBreaker", 2],
    ["1511", "thunderBreaker", 3],
    ["1512", "thunderBreaker", 4],
  ]);
  register("hero", [
    ["2000", "legend"],
    ["2100", "aran", 1],
    ["2110", "aran", 2],
    ["2111", "aran", 3],
    ["2112", "aran", 4],
    ["2200", "evan"],
    ["2210", "evan", 1],
    ["2211", "evan", 2],
    ["2212", "evan", 3],
    ["2213", "evan", 4],
    ["2214", "evan", 5],
    ["2215", "evan", 6],
    ["2216", "evan", 7],
    ["2217", "evan", 8],
    ["2218", "evan", 9],
  ]);
  register("other", [
    ["800", "mounts"],
    ["900", "gm"],
  ]);
  return table;
}

const JOB_TABLE = buildJobTable();

/** 查職業顯示資訊（依介面語言）；對照表沒有的 id 歸到「其他」。 */
export function jobMeta(job: string, t: TFunction): JobMeta {
  const info: JobInfo | undefined = JOB_TABLE[job];
  if (!info) return { name: t("skill.job.unknown", { job }), tier: null, group: "other" };
  return {
    name: t(`skill.job.${info.name}`),
    tier: info.tier ? t(`skill.tier.${info.tier}`) : null,
    group: info.group,
  };
}

/** 職業名加轉職階段（如「狂戰士・二轉」）；不分階段的只有職業名。 */
export function jobLabel(job: string, t: TFunction): string {
  const { name, tier } = jobMeta(job, t);
  return tier ? t("skill.job.withTier", { name, tier }) : name;
}

/** 左欄分區代碼（標題為 skill.section.<代碼>）。 */
export type JobSection =
  | "beginner"
  | "warrior"
  | "magician"
  | "bowman"
  | "thief"
  | "pirate"
  | "cygnus"
  | "hero"
  | "other";

/**
 * 左欄的分區：冒險家細分成 新手/劍士/法師/弓箭手/盜賊/海盜（依職業 id 首位），
 * 皇家騎士團與英雄維持單一區塊；對照表沒有的 id 歸「其他」。
 */
export function jobSection(job: string): JobSection {
  const group = JOB_TABLE[job]?.group ?? "other";
  if (group !== "explorer") return group;
  if (job === "000") return "beginner";
  return JOB_FAMILY[job.charAt(0)] ?? "other";
}

/** 冒險家職業 id 首位 → 系譜（一轉職業）的分區代碼。 */
const JOB_FAMILY: Record<string, JobSection> = {
  "1": "warrior",
  "2": "magician",
  "3": "bowman",
  "4": "thief",
  "5": "pirate",
};

/** 左欄分區的顯示順序。 */
export const SECTION_ORDER: JobSection[] = [
  "beginner",
  "warrior",
  "magician",
  "bowman",
  "thief",
  "pirate",
  "cygnus",
  "hero",
  "other",
];

/** prop 標籤的訊息 key（skill.prop.*）。 */
type PropLabelKey = Extract<MessageKey, `skill.prop.${string}`>;

/** 每級數值 prop 的標籤（訊息 key）與單位；查不到的 key 原樣顯示。 */
const PROP_META: Record<string, { label: PropLabelKey; unit?: "%" | "seconds" }> = {
  mpCon: { label: "skill.prop.mpCon" },
  hpCon: { label: "skill.prop.hpCon" },
  damage: { label: "skill.prop.damage", unit: "%" },
  prop: { label: "skill.prop.prop", unit: "%" },
  attackCount: { label: "skill.prop.attackCount" },
  mobCount: { label: "skill.prop.mobCount" },
  targetPlus: { label: "skill.prop.targetPlus" },
  time: { label: "skill.prop.time", unit: "seconds" },
  cooldown: { label: "skill.prop.cooldown", unit: "seconds" },
  interval: { label: "skill.prop.interval", unit: "seconds" },
  range: { label: "skill.prop.range" },
  pad: { label: "skill.prop.pad" },
  pdd: { label: "skill.prop.pdd" },
  mad: { label: "skill.prop.mad" },
  mdd: { label: "skill.prop.mdd" },
  acc: { label: "skill.prop.acc" },
  eva: { label: "skill.prop.eva" },
  speed: { label: "skill.prop.speed" },
  jump: { label: "skill.prop.jump" },
  mastery: { label: "skill.prop.mastery", unit: "%" },
  ter: { label: "skill.prop.ter", unit: "%" },
  asr: { label: "skill.prop.asr", unit: "%" },
  cr: { label: "skill.prop.cr", unit: "%" },
  bulletCount: { label: "skill.prop.bulletCount" },
  bulletCon: { label: "skill.prop.bulletCon" },
  moneyCon: { label: "skill.prop.moneyCon" },
  itemCon: { label: "skill.prop.itemCon" },
  morph: { label: "skill.prop.morph" },
  hp: { label: "skill.prop.hp" },
  mp: { label: "skill.prop.mp" },
  x: { label: "skill.prop.x" },
  y: { label: "skill.prop.y" },
  z: { label: "skill.prop.z" },
  expPerReduce: { label: "skill.prop.expPerReduce", unit: "%" },
  lt: { label: "skill.prop.lt" },
  rb: { label: "skill.prop.rb" },
};

export type PropValue = number | string | [number, number];

export function propLabel(key: string, t: TFunction): string {
  const label = PROP_META[key]?.label;
  return label ? t(label) : key;
}

export function formatPropValue(key: string, value: PropValue, t: TFunction): string {
  if (Array.isArray(value)) return `(${value[0]}, ${value[1]})`;
  if (typeof value === "number") {
    const unit = PROP_META[key]?.unit;
    if (unit === "seconds") return t("skill.unit.seconds", { value });
    return unit ? `${value}${unit}` : value.toLocaleString();
  }
  return value;
}

/** 不顯示在數值表的 prop（hs 是內部字串參照，對使用者無意義）。 */
export const HIDDEN_PROPS = new Set(["hs"]);

export interface TextSegment {
  text: string;
  accent: boolean;
  /** 道具 icon 段（`#i4031003#`）：text 為空，由呼叫端渲染 icon。 */
  itemId?: number;
  /** 道具名稱段（`#t2022000#`）：text 為空，由呼叫端渲染名稱。 */
  itemNameId?: number;
}

export interface MapleLine {
  segments: TextSegment[];
  /** 玩家台詞（`#L0#` 等標記，可跨 `#b` 等樣式碼、以 `#l` 收尾）；缺省為 NPC 台詞。 */
  player?: boolean;
}

/**
 * 解析楓之谷字串：換行是字面 `\n` / `\r` 兩字元（偶爾夾帶真正的 CR 字元）。
 * 標記處理：`#c…#` 自足強調（純數字 `#c4000015#` 是遊戲的「目前持有數」
 * 小工具，靜態檢視無意義，直接去掉）、`#b…#k` / `#e…#n` / `#r…#k` 區間強調、
 * `#L<n>#…#l` 玩家台詞（去掉標記、整行標 player）、
 * `#i<id>#` 道具 icon 段、`#t<id>#` 道具名稱段（由呼叫端渲染）、
 * `#p2101#` / `#o…#` / `#m…#` 引用標記不查表直接去掉（後端已代換名字）；
 * 其他 #token（如 #prop）原樣保留。
 */
export function parseMapleText(raw: string): MapleLine[] {
  // 換行標記是字面 `\n` / `\r` 兩字元（偶爾夾帶真正的 CR 字元，一併視為換行）；
  // 轉義的 \# 先換成 NUL 佔位，避免被當成標記起點，最後再還原。
  const normalized = raw.replace(/\\[nr]|\r/g, "\n").replace(/\\#/g, "\0");
  return normalized.split("\n").map((line) => {
    // 玩家台詞標記 #L<n>#：可能在行首，也可能前面夾 #b 之類的樣式碼。
    const playerMark = /^(?:#[bkre])*#L\d+#/.exec(line);
    const segments = parseMapleLine(playerMark ? line.slice(playerMark[0].length) : line);
    return playerMark ? { segments, player: true } : { segments };
  });
}

function parseMapleLine(line: string): TextSegment[] {
  const segments: TextSegment[] = [];
  let accent = false;
  let buffer = "";
  const flush = () => {
    if (buffer) {
      segments.push({ text: buffer.replace(/\0/g, "#"), accent });
      buffer = "";
    }
  };
  let i = 0;
  while (i < line.length) {
    // 區間強調標記（不自閉合，文字直接接在後面）：#b…#k、#e…#n、#r…#k。
    if (line.startsWith("#b", i) || line.startsWith("#e", i) || line.startsWith("#r", i)) {
      flush();
      accent = true;
      i += 2;
      continue;
    }
    if (line.startsWith("#k", i) || line.startsWith("#n", i)) {
      flush();
      accent = false;
      i += 2;
      continue;
    }
    // #l 是 #L<n># 玩家台詞的收尾標記，無顯示意義。
    if (line.startsWith("#l", i)) {
      i += 2;
      continue;
    }
    // 道具 icon（#i<id>#）與道具名稱（#t<id>#）：結尾偶爾是冒號，轉對應段。
    const item = /^#([it])(\d+)[:#]/.exec(line.slice(i));
    if (item) {
      flush();
      if (item[1] === "i") segments.push({ text: "", accent, itemId: Number(item[2]) });
      else segments.push({ text: "", accent, itemNameId: Number(item[2]) });
      i += item[0].length;
      continue;
    }
    // 引用標記（NPC/怪物/地圖）：後端已代換名字；殘留的不查表直接去掉。
    const ref = /^#[pom]\d+#/.exec(line.slice(i));
    if (ref) {
      i += ref[0].length;
      continue;
    }
    if (line[i] === "#") {
      const end = line.indexOf("#", i + 1);
      if (end > i + 1) {
        const token = line.slice(i + 1, end);
        // 自足強調標記 #c…#；純數字（#c4000015#）是遊戲的持有數小工具，去掉。
        if (token.startsWith("c")) {
          flush();
          if (token.length > 1 && !/^c\d+$/.test(token)) {
            segments.push({ text: token.slice(1), accent: true });
          }
          i = end + 1;
          continue;
        }
      }
      // 未知或未閉合標記：# 視為一般字元。
      buffer += "#";
      i += 1;
      continue;
    }
    buffer += line[i];
    i += 1;
  }
  flush();
  return segments;
}

/**
 * 把技能 H 模板（如「出現概率#prop%，發揮#damage%的最終攻擊」）的
 * #key 佔位符換成指定等級的數值；查不到的 key 原樣保留。
 */
export function substituteProps(
  template: string,
  props: Record<string, PropValue>,
): string {
  return template.replace(/#([A-Za-z][A-Za-z0-9]*)/g, (match, key: string) => {
    if (key === "c") return match; // 強調標記，交給 parseMapleText 處理
    const value = props[key];
    if (typeof value === "number") return String(value);
    if (typeof value === "string") return value;
    return match;
  });
}
