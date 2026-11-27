// 技能瀏覽器（hosted 版）：對齊 src-tauri/src/skill.rs 的 get_skill_book / get_skill_detail。
// 資料來源：
//   features/skill_book.json      技能清單（pipeline 已組好，含分類）
//   tree/Skill/<job>.json         技能 img 樹（明細的節點資料）
//   strings/String/TW/Skill.json  名稱 / 說明 / 簡述 / 各等級說明（id 無補零）
//   features/action_delays.json   動作名 → 總延遲 ms（Character/00002000 影格 |delay| 加總）

import type { SkillDetail, SkillJobGroup, Value } from "../api.hosted";
import { DATA_ROOT, fetchChecked, loadTextAsset, loadTree } from "./core";
import type { TreeNode } from "./core";
import { t } from "../i18n";

/** 排除的非玩家 Skill img（對齊 Rust EXCLUDED_JOBS + Dragon/* 前綴）。 */
const EXCLUDED_JOBS = new Set([
  "Attacktype",
  "BFSkill",
  "ItemSkill",
  "MCGuardian",
  "MCSkill",
  "MobSkill",
]);

function isExcludedJob(job: string): boolean {
  return EXCLUDED_JOBS.has(job) || job === "Dragon" || job.startsWith("Dragon/");
}

// ---------------------------------------------------------------------------
// features JSON 快取（資料集依版本不可變，整個 session 快取）
// ---------------------------------------------------------------------------

let skillBookCache: Promise<SkillJobGroup[]> | null = null;
let actionDelaysCache: Promise<Record<string, number>> | null = null;

/** 技能清單：直接取 pipeline 組好的 features/skill_book.json（82 個 job 分組）。 */
export function getSkillBook(): Promise<SkillJobGroup[]> {
  if (!skillBookCache) {
    skillBookCache = fetchChecked(`${DATA_ROOT}/features/skill_book.json`).then(
      (response) => response.json() as Promise<SkillJobGroup[]>,
    );
    skillBookCache.catch(() => {
      skillBookCache = null;
    });
  }
  return skillBookCache;
}

function loadActionDelays(): Promise<Record<string, number>> {
  if (!actionDelaysCache) {
    actionDelaysCache = fetchChecked(`${DATA_ROOT}/features/action_delays.json`).then(
      (response) => response.json() as Promise<Record<string, number>>,
    );
    actionDelaysCache.catch(() => {
      actionDelaysCache = null;
    });
  }
  return actionDelaysCache;
}

// ---------------------------------------------------------------------------
// 技能字串表（對齊 Rust SkillStringTables / find_strings）
// ---------------------------------------------------------------------------

interface SkillStrings {
  name: string | null;
  desc: string | null;
  h: string | null;
  levelDesc: Record<string, string>;
}

let skillStringsCache: Promise<Map<string, SkillStrings>> | null = null;

/** 技能 id 正規化：去掉補零（全零視為 "0"），讓 `0001000` 與 `1000` 視為同一 id。 */
function normalizeId(id: string): string {
  const trimmed = id.replace(/^0+/, "");
  return trimmed === "" ? "0" : trimmed;
}

function sameSkillId(a: string, b: string): boolean {
  return a === b || normalizeId(a) === normalizeId(b);
}

/** 字串表查找：Skill img 的 id 有補零、字串表的鍵沒有 → 兩種都試。 */
function findStrings(table: Map<string, SkillStrings>, id: string): SkillStrings | undefined {
  return table.get(id) ?? table.get(normalizeId(id));
}

/** 部分 text_asset 帶 UTF-8 BOM，JSON.parse 不接受，先去掉。 */
function stripBom(text: string): string {
  return text.startsWith("﻿") ? text.slice(1) : text;
}

/** 懶載入並快取整份 String/TW/Skill（資料集缺字串表時視為空表）。 */
function loadSkillStrings(): Promise<Map<string, SkillStrings>> {
  if (!skillStringsCache) {
    skillStringsCache = loadTextAsset("String/TW/Skill")
      .then((text): Map<string, SkillStrings> => {
        const table = new Map<string, SkillStrings>();
        const raw: unknown = JSON.parse(stripBom(text));
        if (raw == null || typeof raw !== "object") return table;
        for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
          if (value == null || typeof value !== "object") continue;
          const entry = value as Record<string, unknown>;
          const getStr = (key: string): string | null =>
            typeof entry[key] === "string" ? (entry[key] as string) : null;
          const levelDesc: Record<string, string> = {};
          const rawLevelDesc = entry.LevelDesc;
          if (rawLevelDesc != null && typeof rawLevelDesc === "object") {
            for (const [level, desc] of Object.entries(
              rawLevelDesc as Record<string, unknown>,
            )) {
              if (typeof desc === "string") levelDesc[level] = desc;
            }
          }
          table.set(id, {
            name: getStr("Name"),
            desc: getStr("Desc"),
            h: getStr("H"),
            levelDesc,
          });
        }
        return table;
      })
      .catch(() => new Map<string, SkillStrings>());
  }
  return skillStringsCache;
}

// ---------------------------------------------------------------------------
// 節點值工具（對齊 Rust value_as_i64 / as_str / node_to_json）
// ---------------------------------------------------------------------------

function valueAsI64(value: Value): number | null {
  switch (value.type) {
    case "U8":
    case "U16":
    case "Int":
    case "Long":
    case "Double":
      return value.value;
    case "Int2":
      return value.value[0];
    default:
      return null;
  }
}

function asStr(value: Value): string | null {
  return value.type === "Str" || value.type === "Uol" ? value.value : null;
}

function findChild(node: TreeNode, name: string): TreeNode | undefined {
  return node.children?.find((child) => child.name === name);
}

/** 技能的 action 清單：`action` 節點的字串值，或子節點 0/1/... 各一個字串。 */
function skillActions(skill: TreeNode): string[] {
  const actions: string[] = [];
  const actionNode = findChild(skill, "action");
  if (actionNode) {
    const own = asStr(actionNode.value);
    if (own != null) actions.push(own);
    for (const child of actionNode.children ?? []) {
      const s = asStr(child.value);
      if (s != null) actions.push(s);
    }
  }
  return actions;
}

type LevelJson = number | string | [number, number] | null | { [key: string]: LevelJson };

/** 節點 → JSON 葉值（數字保留數字、字串保留字串、vector 轉 [x,y]）；
 *  帶子節點的 prop 轉巢狀物件；canvas 葉略過。 */
function nodeToJson(node: TreeNode): LevelJson {
  const children = node.children ?? [];
  if (children.length === 0) {
    return leafJson(node.value);
  }
  const obj: { [key: string]: LevelJson } = {};
  for (const child of children.filter((c) => c.value.type !== "Canvas")) {
    obj[child.name] = nodeToJson(child);
  }
  return obj;
}

function leafJson(value: Value): LevelJson {
  switch (value.type) {
    case "SubTree":
    case "Canvas":
      return null;
    case "U8":
    case "U16":
    case "Int":
    case "Long":
    case "Double":
      return value.value;
    case "Float2":
    case "Vector":
    case "Int2":
      return value.value;
    case "Str":
    case "Uol":
      return value.value;
  }
}

// ---------------------------------------------------------------------------
// getSkillDetail（對齊 Rust get_skill_detail）
// ---------------------------------------------------------------------------

/** 單一技能完整明細：文字、動作與延遲、每級數值 props。找不到 img 或技能時丟錯。 */
export async function getSkillDetail(job: string, skillId: string): Promise<SkillDetail> {
  const imgKey = `Skill/${job}`;
  if (isExcludedJob(job)) {
    throw new Error(t("data.error.pathNotFound", { path: imgKey }));
  }
  const tree = await loadTree(imgKey);

  const skillRoot = findChild(tree, "skill");
  const skill = skillRoot?.children?.find((node) => sameSkillId(node.name, skillId));
  if (!skill) {
    throw new Error(t("data.error.pathNotFound", { path: `${imgKey}/skill/${skillId}` }));
  }

  const [strings, delays] = await Promise.all([loadSkillStrings(), loadActionDelays()]);
  const strinfo = findStrings(strings, skill.name);

  const actions = skillActions(skill);
  const actionDelays: Record<string, number> = {};
  for (const name of actions) {
    // 查無該動作則缺項（對齊 Rust）。
    if (Object.prototype.hasOwnProperty.call(delays, name)) {
      actionDelays[name] = delays[name];
    }
  }

  const levelNode = findChild(skill, "level");
  const levels: Record<string, Record<string, LevelJson>> = {};
  for (const lv of levelNode?.children ?? []) {
    const props: Record<string, LevelJson> = {};
    for (const prop of (lv.children ?? []).filter((p) => p.value.type !== "Canvas")) {
      props[prop.name] = nodeToJson(prop);
    }
    levels[lv.name] = props;
  }

  const skillTypeNode = findChild(skill, "skillType");

  return {
    id: skill.name,
    job,
    name: strinfo?.name ?? null,
    desc: strinfo?.desc ?? null,
    h: strinfo?.h ?? null,
    levelDesc: strinfo?.levelDesc ?? {},
    maxLevel: levelNode?.children?.length ?? 0,
    skillType: skillTypeNode ? valueAsI64(skillTypeNode.value) : null,
    actions,
    actionDelays,
    levels: levels as SkillDetail["levels"],
  };
}
