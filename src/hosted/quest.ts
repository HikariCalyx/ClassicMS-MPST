// 任務資料庫（hosted 版）：對齊 src-tauri/src/quest.rs 的 get_quest_book / get_quest_detail。
// 資料來源：
//   features/quest_book.json        任務清單（pipeline 已組好）
//   tree/Quest/Say.json             NPC 對話腳本（文字鍵，實文在 QuestData 字串表）
//   tree/Quest/Check.json           開始/完成條件（npc、道具、怪物、前置任務、等級）
//   tree/Quest/Act.json             獎勵（exp、楓幣、名聲、道具、下個任務）
//   tree/Quest/QuestInfo.json       故事文與地區（很多任務沒有，缺整棵樹也容忍）
//   strings/String/TW/QuestData.json 任務名 / 系列名 / 故事文 / 對話實文
//   strings/String/TW/Npc.json      NPC 名稱；道具/怪物名稱重用 Item / Mob 字串表

import type {
  QuestDetail,
  QuestDialogueStage,
  QuestItemRef,
  QuestMobRef,
  QuestRef,
  QuestSummary,
  Value,
} from "../api.hosted";
import { cmpNodeNames, DATA_ROOT, fetchChecked, loadTextAsset, loadTree } from "./core";
import type { TreeNode } from "./core";
import { t } from "../i18n";
import { loadItemNameTable } from "./tooltip";

// ---------------------------------------------------------------------------
// features 清單（fetch + 快取，比照 skill.ts）
// ---------------------------------------------------------------------------

let questBookCache: Promise<QuestSummary[]> | null = null;

/** 任務清單：直接取 pipeline 組好的 features/quest_book.json。 */
export function getQuestBook(): Promise<QuestSummary[]> {
  if (!questBookCache) {
    questBookCache = fetchChecked(`${DATA_ROOT}/features/quest_book.json`).then(
      (response) => response.json() as Promise<QuestSummary[]>,
    );
    questBookCache.catch(() => {
      questBookCache = null;
    });
  }
  return questBookCache;
}

// ---------------------------------------------------------------------------
// 字串表（懶載入 + 整份快取，對齊 monster.ts 的 loadNames）
// ---------------------------------------------------------------------------

interface QuestStrings {
  name: string | null;
  /** Info 子表的數字鍵（故事文階段）；parent / demandSummary / rewardSummary 不收。 */
  info: Record<string, string>;
  /** Info 子表的 parent（系列名）。 */
  parent: string | null;
  /** Say 子表：Say.img 樹的文字鍵 → 台詞實文。 */
  say: Record<string, string>;
}

/** 部分 text_asset 帶 UTF-8 BOM，JSON.parse 不接受，先去掉。 */
function stripBom(text: string): string {
  return text.startsWith("﻿") ? text.slice(1) : text;
}

let questDataCache: Promise<Map<string, QuestStrings>> | null = null;

/** 懶載入 String/TW/QuestData（`{qid: {name, Info: {...}, Say: {...}}}`）；缺表視為空表。 */
function loadQuestData(): Promise<Map<string, QuestStrings>> {
  if (!questDataCache) {
    questDataCache = loadTextAsset("String/TW/QuestData")
      .then((text): Map<string, QuestStrings> => {
        const table = new Map<string, QuestStrings>();
        const raw: unknown = JSON.parse(stripBom(text));
        if (raw == null || typeof raw !== "object") return table;
        for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
          if (value == null || typeof value !== "object") continue;
          const entry = value as Record<string, unknown>;
          const stringsOnly = (sub: unknown): Record<string, string> => {
            const out: Record<string, string> = {};
            if (sub != null && typeof sub === "object") {
              for (const [key, text] of Object.entries(sub as Record<string, unknown>)) {
                if (typeof text === "string") out[key] = text;
              }
            }
            return out;
          };
          const rawInfo = stringsOnly(entry.Info);
          // info 只收數字階段鍵；parent 另存，demandSummary / rewardSummary
          // 是遊戲內追蹤摘要（需求/獎勵在結構化區塊已有），不重複顯示。
          const info: Record<string, string> = {};
          for (const [key, text] of Object.entries(rawInfo)) {
            if (/^\d+$/.test(key)) info[key] = text;
          }
          table.set(id, {
            name: typeof entry.name === "string" ? entry.name : null,
            info,
            parent: rawInfo.parent ?? null,
            say: stringsOnly(entry.Say),
          });
        }
        return table;
      })
      .catch(() => new Map<string, QuestStrings>());
  }
  return questDataCache;
}

/** 解析 `{id: {<key>: ...}}` 字串表成 id → 名稱；失敗時回空表（對齊 monster.ts）。
 *  地圖表的名稱鍵是 mapName，其餘（Npc/Mob/Pet）是 name。 */
async function loadNames(path: string, nameKey = "name"): Promise<Map<number, string>> {
  const table = new Map<number, string>();
  try {
    const raw = JSON.parse(stripBom(await loadTextAsset(path))) as Record<
      string,
      Record<string, unknown>
    >;
    for (const [key, value] of Object.entries(raw)) {
      const id = Number(key);
      const name = value?.[nameKey];
      if (!Number.isInteger(id) || typeof name !== "string") continue;
      table.set(id, name);
    }
  } catch {
    // 資料集缺字串表時視為空表。
  }
  return table;
}

interface QuestNameTables {
  npcs: Map<number, string>;
  mobs: Map<number, string>;
  /** 道具名稱（Item 為主，Pet 只補 Item 缺的 id，對齊 monster.ts）。 */
  items: Map<number, string>;
  /** 地圖名稱（String/TW/Map 的 mapName）。 */
  maps: Map<number, string>;
}

let nameTablesCache: Promise<QuestNameTables> | null = null;

function loadNameTables(): Promise<QuestNameTables> {
  if (!nameTablesCache) {
    nameTablesCache = (async () => {
      const [itemEntries, pets, mobs, npcs, maps] = await Promise.all([
        loadItemNameTable(),
        loadNames("String/TW/Pet"),
        loadNames("String/TW/Mob"),
        loadNames("String/TW/Npc"),
        loadNames("String/TW/Map", "mapName"),
      ]);
      const items = new Map<number, string>();
      for (const [id, entry] of itemEntries) items.set(id, entry.name);
      for (const [id, name] of pets) {
        if (!items.has(id)) items.set(id, name);
      }
      return { npcs, mobs, items, maps };
    })();
    nameTablesCache.catch(() => {
      nameTablesCache = null;
    });
  }
  return nameTablesCache;
}

// ---------------------------------------------------------------------------
// 節點工具（對齊 skill.ts / monster.ts）
// ---------------------------------------------------------------------------

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

function asStr(value: Value): string | null {
  return value.type === "Str" || value.type === "Uol" ? value.value : null;
}

function prop(node: TreeNode, name: string): TreeNode | null {
  return node.children?.find((child) => child.name === name) ?? null;
}

function propI64(node: TreeNode | null, name: string): number | null {
  const child = node ? prop(node, name) : null;
  return child ? valueAsI64(child.value) : null;
}

/** 任務 id 正規化：Quest 樹節點名可能補零（"0001000" vs "1000"）。 */
function normalizeId(id: string): string {
  const trimmed = id.replace(/^0+/, "");
  return trimmed === "" ? "0" : trimmed;
}

function findQuestNode(tree: TreeNode | null, questId: string): TreeNode | null {
  if (!tree) return null;
  return (
    (tree.children ?? []).find(
      (child) => child.name === questId || normalizeId(child.name) === normalizeId(questId),
    ) ?? null
  );
}

/** 子節點的數值清單：{idx: {id, count}} 或 {idx: int} 兩種型態都收。 */
function childEntries(node: TreeNode | null): TreeNode[] {
  if (!node) return [];
  return [...(node.children ?? [])].sort((a, b) => cmpNodeNames(a.name, b.name));
}

function itemRefs(node: TreeNode | null, names: Map<number, string>): QuestItemRef[] {
  const refs: QuestItemRef[] = [];
  for (const child of childEntries(node)) {
    const id = propI64(child, "id");
    if (id == null) continue;
    refs.push({
      id,
      count: propI64(child, "count") ?? 1,
      name: names.get(id) ?? null,
      prop: propI64(child, "prop"),
    });
  }
  return refs;
}

function mobRefs(node: TreeNode | null, names: Map<number, string>): QuestMobRef[] {
  const refs: QuestMobRef[] = [];
  for (const child of childEntries(node)) {
    const id = propI64(child, "id");
    if (id == null) continue;
    refs.push({ id, count: propI64(child, "count") ?? 1, name: names.get(id) ?? null });
  }
  return refs;
}

function questRefs(node: TreeNode | null, questData: Map<string, QuestStrings>): QuestRef[] {
  const refs: QuestRef[] = [];
  for (const child of childEntries(node)) {
    const id = propI64(child, "id");
    if (id == null) continue;
    const key = String(id);
    refs.push({ id: key, name: questData.get(key)?.name ?? null });
  }
  return refs;
}

// ---------------------------------------------------------------------------
// Say.img 對話腳本
// ---------------------------------------------------------------------------

/** 子樹的台詞清單：數字名子節點的 Str 值是 QuestData.Say 的文字鍵，查無實文就略過。 */
function speechLines(node: TreeNode | null, say: Record<string, string>): string[] {
  const lines: string[] = [];
  for (const child of childEntries(node)) {
    const key = asStr(child.value);
    if (key == null) continue;
    const text = say[key];
    if (text != null && text !== "") lines.push(text);
  }
  return lines;
}

/** 台詞中的引用標記換成名字：#p<id># NPC、#o<id># 怪物、#m<id># 地圖
 *  （查不到保留原標記，前端會去掉）。 */
function substituteRefs(text: string, names: QuestNameTables): string {
  return text.replace(/#([pom])(\d+)#/g, (raw, kind: string, digits: string) => {
    const table = kind === "p" ? names.npcs : kind === "o" ? names.mobs : names.maps;
    return table.get(Number(digits)) ?? raw;
  });
}

/** stage 節點 → 對話腳本；stage 偶爾是葉子（無子節點），回全空腳本。
 *  台詞只取 stage 直屬的 Str 子節點（ask/yes/no/stop/lost 是子樹，asStr 為 null 自動略過）。 */
function buildStage(
  stageNode: TreeNode | null,
  npcId: number | null,
  names: QuestNameTables,
  say: Record<string, string>,
): QuestDialogueStage {
  const stop = stageNode ? prop(stageNode, "stop") : null;
  const sub = (lines: string[]) => lines.map((text) => substituteRefs(text, names));
  return {
    npcId,
    npcName: npcId != null ? (names.npcs.get(npcId) ?? null) : null,
    lines: sub(speechLines(stageNode, say)),
    ask: sub(speechLines(stageNode ? prop(stageNode, "ask") : null, say)),
    yes: sub(speechLines(stageNode ? prop(stageNode, "yes") : null, say)),
    no: sub(speechLines(stageNode ? prop(stageNode, "no") : null, say)),
    stopNpc: sub(speechLines(stop ? prop(stop, "npc") : null, say)),
    stopItem: sub(speechLines(stop ? prop(stop, "item") : null, say)),
    lost: sub(speechLines(stageNode ? prop(stageNode, "lost") : null, say)),
  };
}

// ---------------------------------------------------------------------------
// export 契約：單一任務明細
// ---------------------------------------------------------------------------

/**
 * 單一任務完整明細：對話腳本（Say）、條件（Check）、獎勵（Act）、
 * 故事文與地區（QuestInfo）即時聚合。Say/Check/Act 都找不到該任務時丟錯。
 */
export async function getQuestDetail(questId: string): Promise<QuestDetail> {
  const [sayTree, checkTree, actTree, infoTree, questData, names] = await Promise.all([
    loadTree("Quest/Say").catch(() => null),
    loadTree("Quest/Check").catch(() => null),
    loadTree("Quest/Act").catch(() => null),
    // 很多資料集沒有 QuestInfo；缺整棵樹不報錯。
    loadTree("Quest/QuestInfo").catch(() => null),
    loadQuestData(),
    loadNameTables(),
  ]);

  const sayEntry = findQuestNode(sayTree, questId);
  const checkEntry = findQuestNode(checkTree, questId);
  const actEntry = findQuestNode(actTree, questId);
  if (!sayEntry && !checkEntry && !actEntry) {
    throw new Error(t("data.error.questNotFound", { id: questId }));
  }

  const strings = questData.get(normalizeId(questId)) ?? questData.get(questId) ?? null;
  const say = strings?.say ?? {};

  // Check stage "0"=開始條件、"1"=完成條件；npc 同時是對話舞台的立繪來源。
  const check0 = checkEntry ? prop(checkEntry, "0") : null;
  const check1 = checkEntry ? prop(checkEntry, "1") : null;
  const startNpcId = propI64(check0, "npc");
  const endNpcId = propI64(check1, "npc");

  const jobs: number[] = [];
  for (const child of childEntries(check0 ? prop(check0, "job") : null)) {
    const job = valueAsI64(child.value);
    if (job != null) jobs.push(job);
  }

  // Say stage "0"=接受任務對話、"1"=完成任務對話；stage 缺節點時該段為 null。
  const say0 = sayEntry ? prop(sayEntry, "0") : null;
  const say1 = sayEntry ? prop(sayEntry, "1") : null;
  const start = say0 || startNpcId != null ? buildStage(say0, startNpcId, names, say) : null;
  const end = say1 || endNpcId != null ? buildStage(say1, endNpcId, names, say) : null;

  // Act 只取 "0"/"1"；獎勵以完成階段（"1"）為準。
  const act1 = actEntry ? prop(actEntry, "1") : null;
  const nextQuestId = propI64(act1, "nextQuest");
  const nextQuest: QuestRef | null =
    nextQuestId != null && nextQuestId > 0
      ? {
          id: String(nextQuestId),
          name: questData.get(String(nextQuestId))?.name ?? null,
        }
      : null;

  // QuestInfo：數字名子節點的 Str 值是 QuestData.Info 的文字鍵（故事文）。
  const infoEntry = findQuestNode(infoTree, questId);
  const infoStrings = strings?.info ?? {};
  const info: Record<string, string> = {};
  for (const child of infoEntry?.children ?? []) {
    if (!/^\d+$/.test(child.name)) continue;
    const key = asStr(child.value);
    if (key == null) continue;
    const text = infoStrings[key];
    if (text != null && text !== "") info[child.name] = substituteRefs(text, names);
  }

  return {
    id: checkEntry?.name ?? sayEntry?.name ?? actEntry?.name ?? questId,
    name: strings?.name ?? null,
    parent: strings?.parent ?? null,
    area: propI64(infoEntry, "area"),
    levelMin: propI64(check0, "lvmin"),
    levelMax: propI64(check0, "lvmax"),
    jobs,
    info,
    start,
    end,
    startRequirements: {
      items: itemRefs(check0 ? prop(check0, "item") : null, names.items),
      preQuests: questRefs(check0 ? prop(check0, "quest") : null, questData),
    },
    requirements: {
      items: itemRefs(check1 ? prop(check1, "item") : null, names.items),
      mobs: mobRefs(check1 ? prop(check1, "mob") : null, names.mobs),
      preQuests: questRefs(check1 ? prop(check1, "quest") : null, questData),
    },
    rewards: {
      exp: propI64(act1, "exp"),
      mesos: propI64(act1, "money"),
      popularity: propI64(act1, "pop"),
      items: itemRefs(act1 ? prop(act1, "item") : null, names.items),
      nextQuest,
    },
    interval: propI64(check1, "interval") ?? propI64(check0, "interval"),
  };
}
