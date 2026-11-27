import { createDatasetCache } from "../locale";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import {
  getImage,
  getItemTooltipById,
  getMobDropIcon,
  getQuestBook,
  getQuestDetail,
  type ItemTooltip as ItemTooltipData,
  type MonsterSummary,
  type QuestDetail,
  type QuestDialogueStage,
  type QuestItemRef,
  type QuestSummary,
} from "../api";
import { getDropSources } from "../dropSources";
import { useI18n } from "../i18n";
import { loadClassicFrame } from "./classicFrame";
import { DropSourcesDialog, type DropSourceItem, type MobThumbCache } from "./DropSourcesDialog";
import { DropItemTooltip, ItemTooltip } from "./ItemTooltip";
import { parseMapleText, type TextSegment } from "./skillJobs";

// NPC 立繪走既有 get_image（Npc/<7 碼 id>/stand/0），整個 session 快取。
const npcPortraitCache = createDatasetCache<number, Promise<string | null>>();

function loadNpcPortrait(npcId: number): Promise<string | null> {
  let cached = npcPortraitCache.get(npcId);
  if (!cached) {
    cached = getImage(`Npc/${String(npcId).padStart(7, "0")}/stand/0`)
      .then((result) => (result ? `data:image/png;base64,${result.base64}` : null))
      .catch(() => null);
    npcPortraitCache.set(npcId, cached);
  }
  return cached;
}

function NpcPortrait({ npcId, name }: { npcId: number | null; name: string | null }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    setSrc(null);
    if (npcId == null) return;
    let active = true;
    void loadNpcPortrait(npcId).then((url) => {
      if (active) setSrc(url);
    });
    return () => {
      active = false;
    };
  }, [npcId]);
  if (npcId == null || !src) {
    return (
      <div className="quest-npc-portrait is-empty" aria-hidden="true">
        ?
      </div>
    );
  }
  return (
    <div className="quest-npc-portrait">
      <img src={src} alt={name ?? String(npcId)} draggable={false} />
    </div>
  );
}

/** 台詞內嵌的道具 icon（#t<id># / #i<id># 段）：懶載入 + hover tooltip。 */
function QuestInlineItem({
  id,
  onHover,
  onLeave,
}: {
  id: number;
  onHover?: (itemId: number, event: React.MouseEvent, name: string | null) => void;
  onLeave?: () => void;
}) {
  const [icon, setIcon] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void getMobDropIcon(id).then((base64) => {
      if (active && base64) setIcon(`data:image/png;base64,${base64}`);
    });
    return () => {
      active = false;
    };
  }, [id]);
  return (
    <span
      className="quest-inline-item"
      onMouseEnter={onHover ? (event) => onHover(id, event, null) : undefined}
      onMouseLeave={onLeave}
    >
      {icon ? <img src={icon} alt="" draggable={false} /> : <span>#{id}</span>}
    </span>
  );
}

/** 台詞內嵌的道具名稱（#t<id># 段）：名稱懶載入 + hover tooltip。 */
const inlineItemNameCache = createDatasetCache<number, Promise<string | null>>();

function loadInlineItemName(id: number): Promise<string | null> {
  let cached = inlineItemNameCache.get(id);
  if (!cached) {
    cached = getItemTooltipById(id)
      .then((tip) => tip?.title ?? null)
      .catch(() => null);
    inlineItemNameCache.set(id, cached);
  }
  return cached;
}

function QuestInlineItemName({
  id,
  onHover,
  onLeave,
}: {
  id: number;
  onHover?: (itemId: number, event: React.MouseEvent, name: string | null) => void;
  onLeave?: () => void;
}) {
  const [name, setName] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void loadInlineItemName(id).then((loaded) => {
      if (active) setName(loaded);
    });
    return () => {
      active = false;
    };
  }, [id]);
  return (
    <mark
      className="quest-inline-item-name"
      onMouseEnter={onHover ? (event) => onHover(id, event, name) : undefined}
      onMouseLeave={onLeave}
    >
      {name ?? `#${id}`}
    </mark>
  );
}

/** 台詞文字段渲染（強調 / 道具 icon / 道具名稱）。 */
function renderSegment(
  segment: TextSegment,
  key: number,
  onItemHover?: (itemId: number, event: React.MouseEvent, name: string | null) => void,
  onItemLeave?: () => void,
) {
  if (segment.itemId != null) {
    return <QuestInlineItem key={key} id={segment.itemId} onHover={onItemHover} onLeave={onItemLeave} />;
  }
  if (segment.itemNameId != null) {
    return (
      <QuestInlineItemName key={key} id={segment.itemNameId} onHover={onItemHover} onLeave={onItemLeave} />
    );
  }
  return segment.accent ? (
    <mark key={key}>{segment.text}</mark>
  ) : (
    <span key={key}>{segment.text}</span>
  );
}

/** 楓之谷字串逐行渲染（#c…# / #b…#k 片段用強調色；道具段渲染 icon / 名稱）。
 *  dropTrackerLines：去掉整行只有道具引用與數量（/100 之類）的遊戲內追蹤行，
 *  給任務簡介用（需求/獎勵在結構化區塊已有，不重複顯示）。 */
function MapleText({
  raw,
  className,
  onItemHover,
  onItemLeave,
  dropTrackerLines = false,
}: {
  raw: string;
  className?: string;
  onItemHover?: (itemId: number, event: React.MouseEvent, name: string | null) => void;
  onItemLeave?: () => void;
  dropTrackerLines?: boolean;
}) {
  const lines = parseMapleText(raw).filter(
    (line) =>
      !dropTrackerLines ||
      line.segments.some(
        (segment) =>
          segment.itemId == null &&
          segment.itemNameId == null &&
          !/^[\s\d/:：]*$/.test(segment.text),
      ),
  );
  return (
    <div className={className}>
      {lines.map((line, index) => (
        <p key={index}>
          {line.segments.length > 0
            ? line.segments.map((segment, segmentIndex) =>
                renderSegment(segment, segmentIndex, onItemHover, onItemLeave),
              )
            : " "}
        </p>
      ))}
    </div>
  );
}

/** 對話舞台：台詞逐段顯示，播完有 ask 接 ask，再依 yes/no 顯示接受 / 婉拒。
 *  一段台詞內的每個換行各成一個泡泡；行首 #L<n># 是玩家台詞（不同底色、靠右）。 */
function DialogueView({
  stage,
  onItemHover,
  onItemLeave,
}: {
  stage: QuestDialogueStage;
  onItemHover?: (itemId: number, event: React.MouseEvent, name: string | null) => void;
  onItemLeave?: () => void;
}) {
  const { t } = useI18n();
  const script = useMemo(() => [...stage.lines, ...stage.ask], [stage]);
  const hasChoice = stage.yes.length > 0 || stage.no.length > 0;
  const [step, setStep] = useState(script.length > 0 ? 1 : 0);
  const [choice, setChoice] = useState<"yes" | "no" | null>(null);
  const [respStep, setRespStep] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  // 台詞推進時捲到最新一段（切章/切分段由外層 key 重建，狀態自動重置）。
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [step, respStep, choice]);

  const responseLines = choice === "yes" ? stage.yes : choice === "no" ? stage.no : [];
  const playing = step < script.length;
  const awaitingChoice = !playing && hasChoice && choice === null;
  const playingResponse = choice !== null && respStep < responseLines.length;

  const renderBubbles = (texts: string[], shown: number, keyPrefix: string) =>
    texts.slice(0, shown).flatMap((text, textIndex) =>
      parseMapleText(text)
        // \r\n 之類的連續換行會產生空行，不渲染成空泡泡。
        .filter(
          (line) =>
            line.segments.some(
              (s) => s.text.trim() !== "" || s.itemId != null || s.itemNameId != null,
            ),
        )
        .map((line, lineIndex) => (
          <div
            className={`quest-bubble${line.player ? " is-player" : ""}`}
            key={`${keyPrefix}${textIndex}-${lineIndex}`}
          >
            <div className="quest-bubble-text">
              <p>
                {line.segments.length > 0
                  ? line.segments.map((segment, segmentIndex) =>
                      renderSegment(segment, segmentIndex, onItemHover, onItemLeave),
                    )
                  : " "}
              </p>
            </div>
          </div>
        )),
    );

  return (
    <div className="quest-dialogue-inner">
      <div className="quest-bubble-scroll" ref={scrollRef}>
        {renderBubbles(script, step, "")}
        {choice !== null ? renderBubbles(responseLines, respStep, "r") : null}
        {script.length === 0 && !hasChoice ? (
          <p className="quest-dialogue-empty">{t("quest.dialogue.empty")}</p>
        ) : null}
      </div>
      <div className="quest-dialogue-controls">
        {playing ? (
          <button type="button" onClick={() => setStep((s) => Math.min(s + 1, script.length))}>
            {t("quest.dialogue.continue")}
          </button>
        ) : null}
        {awaitingChoice ? (
          <>
            {stage.yes.length > 0 ? (
              <button
                type="button"
                className="quest-choice-yes"
                onClick={() => {
                  setChoice("yes");
                  setRespStep(1);
                }}
              >
                {t("quest.dialogue.accept")}
              </button>
            ) : null}
            {stage.no.length > 0 ? (
              <button
                type="button"
                className="quest-choice-no"
                onClick={() => {
                  setChoice("no");
                  setRespStep(1);
                }}
              >
                {t("quest.dialogue.decline")}
              </button>
            ) : null}
          </>
        ) : null}
        {playingResponse ? (
          <button
            type="button"
            onClick={() => setRespStep((s) => Math.min(s + 1, responseLines.length))}
          >
            {t("quest.dialogue.continue")}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function numericId(id: string): number {
  const value = Number(id);
  return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
}

/** 章節排序：先用 nextQuestId 串鏈，串不起來的退回 id 數值排序接在後面。 */
function orderChapters(quests: QuestSummary[]): QuestSummary[] {
  const byId = new Map(quests.map((quest) => [quest.id, quest]));
  const pointed = new Set(
    quests.map((quest) => quest.nextQuestId).filter((id): id is string => id != null),
  );
  const result: QuestSummary[] = [];
  const seen = new Set<string>();
  const heads = quests
    .filter((quest) => !pointed.has(quest.id))
    .sort((a, b) => numericId(a.id) - numericId(b.id));
  for (const head of heads) {
    let current: QuestSummary | undefined = head;
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      result.push(current);
      current = current.nextQuestId ? byId.get(current.nextQuestId) : undefined;
    }
  }
  for (const quest of [...quests].sort((a, b) => numericId(a.id) - numericId(b.id))) {
    if (!seen.has(quest.id)) {
      seen.add(quest.id);
      result.push(quest);
    }
  }
  return result;
}

interface QuestGroup {
  parent: string | null;
  quests: QuestSummary[];
}

/** 等級範圍顯示：Lv.10+ / Lv.10~20 / 無資料時空字串。 */
function levelLabel(quest: { levelMin: number | null; levelMax: number | null }): string {
  if (quest.levelMin == null) return "";
  return quest.levelMax != null && quest.levelMax > quest.levelMin
    ? `Lv.${quest.levelMin}~${quest.levelMax}`
    : `Lv.${quest.levelMin}+`;
}

/** 道具 id 首位分組（對齊 MonsterBookPage）：1=裝備用完整 tooltip，其餘用簡版。 */
function isGear(itemId: number): boolean {
  return Math.floor(itemId / 1_000_000) === 1;
}

/** 需求/獎勵道具：icon 懶載入 + hover tooltip；chance 為抽取機率標籤；onClick 開啟掉落來源彈窗。 */
function QuestItemChip({
  item,
  chance,
  onHover,
  onLeave,
  onClick,
}: {
  item: QuestItemRef;
  chance?: string;
  onHover: (itemId: number, event: React.MouseEvent, name: string | null) => void;
  onLeave: () => void;
  onClick?: (item: QuestItemRef) => void;
}) {
  const { t } = useI18n();
  const [icon, setIcon] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void getMobDropIcon(item.id).then((base64) => {
      if (active && base64) setIcon(`data:image/png;base64,${base64}`);
    });
    return () => {
      active = false;
    };
  }, [item.id]);
  return (
    <span
      className={`quest-item-chip${onClick ? " is-clickable" : ""}`}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      title={onClick ? t("quest.item.viewSources") : undefined}
      onClick={onClick ? () => onClick(item) : undefined}
      onKeyDown={
        onClick
          ? (event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onClick(item);
              }
            }
          : undefined
      }
      onMouseEnter={(event) => onHover(item.id, event, item.name)}
      onMouseLeave={onLeave}
    >
      <span className="quest-item-icon">
        {icon ? <img src={icon} alt="" draggable={false} /> : null}
      </span>
      <span className="quest-item-name">{item.name ?? item.id}</span>
      <span className="quest-item-count">×{item.count}</span>
      {chance ? <span className="quest-item-chance">{chance}</span> : null}
    </span>
  );
}

/** 抽取機率標籤：整數不帶小數（50%），其餘一位小數（6.3%）。 */
function chanceLabel(prop: number, weightTotal: number): string {
  if (weightTotal <= 0) return "";
  const pct = (prop / weightTotal) * 100;
  return `${Number.isInteger(pct) ? pct : pct.toFixed(1)}%`;
}

// 任務資料庫：左書架（系列分組）/ 中 NPC 對話舞台 / 右任務日誌；第一次切到此頁才載入。
export function QuestPage({
  visible,
  onPickQuest,
  onOpenMob,
}: {
  visible: boolean;
  /** 選取任務時回報節點路徑（給 App footer 麵包屑）。 */
  onPickQuest?: (path: string) => void;
  /** 從掉落來源彈窗點怪物時，切到怪物圖鑑並選取該怪物。 */
  onOpenMob?: (mobId: number) => void;
}) {
  const { t } = useI18n();
  const [book, setBook] = useState<QuestSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<QuestDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [stageTab, setStageTab] = useState<"start" | "end" | "progress">("start");
  const [frameUrl, setFrameUrl] = useState<string | null>(null);
  const detailGenerationRef = useRef(0);

  // 道具 hover tooltip：結果按 itemId 快取（比照 MonsterBookPage 的精簡版）。
  const tooltipCacheRef = useRef(new Map<number, Promise<ItemTooltipData | null>>());
  const [tip, setTip] = useState<{
    tip: ItemTooltipData;
    gear: boolean;
    x: number;
    y: number;
  } | null>(null);
  const tipGenerationRef = useRef(0);

  // 經典任務視窗邊框（整個 session 只組一次；失敗時退回素色卡片）。
  useEffect(() => {
    let active = true;
    void loadClassicFrame().then((url) => {
      if (active) setFrameUrl(url);
    });
    return () => {
      active = false;
    };
  }, []);

  // 清單只載入一次（此元件掛載後保持不卸載）。
  useEffect(() => {
    let active = true;
    getQuestBook()
      .then((list) => {
        if (!active) return;
        setBook(list);
        if (list.length > 0) setSelectedId((id) => id ?? list[0].id);
      })
      .catch((error: unknown) => {
        if (active) setLoadError(String(error));
      });
    return () => {
      active = false;
    };
  }, []);

  // 選取任務 → 載入明細（generation guard 防止舊回應蓋掉新選擇）。
  useEffect(() => {
    if (selectedId === null) return;
    const generation = ++detailGenerationRef.current;
    setDetailLoading(true);
    setDetailError(null);
    getQuestDetail(selectedId)
      .then((next) => {
        if (detailGenerationRef.current !== generation) return;
        setDetail(next);
        setStageTab("start");
        onPickQuest?.(`Quest/Check/${next.id}`);
      })
      .catch((error: unknown) => {
        if (detailGenerationRef.current !== generation) return;
        setDetail(null);
        setDetailError(String(error));
      })
      .finally(() => {
        if (detailGenerationRef.current === generation) setDetailLoading(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  // 左欄分組：系列任務按 parent 分組（章節依 nextQuestId 串鏈排序），
  // 無 parent 的單發任務列一組；搜尋符合任務名 / 系列名 / NPC 名 / id。
  const groups = useMemo<QuestGroup[]>(() => {
    if (!book) return [];
    const keyword = query.trim().toLowerCase();
    const matched = keyword
      ? book.filter(
          (quest) =>
            quest.name?.toLowerCase().includes(keyword) ||
            quest.parent?.toLowerCase().includes(keyword) ||
            quest.startNpcName?.toLowerCase().includes(keyword) ||
            quest.id.toLowerCase().includes(keyword),
        )
      : book;
    const byParent = new Map<string | null, QuestSummary[]>();
    for (const quest of matched) {
      const list = byParent.get(quest.parent);
      if (list) list.push(quest);
      else byParent.set(quest.parent, [quest]);
    }
    const result: QuestGroup[] = [];
    for (const [parent, quests] of byParent) {
      result.push({ parent, quests: orderChapters(quests) });
    }
    // 系列在前（最低等級 + 系列名排序），單發任務固定最後。
    result.sort((a, b) => {
      if (a.parent === null) return 1;
      if (b.parent === null) return -1;
      const levelA = Math.min(...a.quests.map((quest) => quest.levelMin ?? 999));
      const levelB = Math.min(...b.quests.map((quest) => quest.levelMin ?? 999));
      return levelA - levelB || a.parent.localeCompare(b.parent, "zh-Hant");
    });
    return result;
  }, [book, query]);

  // 目前任務的系列章節鏈（同 parent 才算；單發任務只有自己）。
  const chapters = useMemo<QuestSummary[]>(() => {
    if (!book || !detail?.parent) return [];
    const siblings = book.filter((quest) => quest.parent === detail.parent);
    return siblings.length > 1 ? orderChapters(siblings) : [];
  }, [book, detail?.parent]);

  // 獎勵道具分組：負 count（交付）與需求重複不顯示；prop>0 隨機抽取
  // （值為權重，等值即平均分配）、prop=-1 自選一項、無 prop 固定給予。
  const rewardGroups = useMemo(() => {
    const items = (detail?.rewards.items ?? []).filter((item) => item.count > 0);
    const random = items.filter((item) => item.prop != null && item.prop > 0);
    const choice = items.filter((item) => item.prop === -1);
    const fixed = items.filter((item) => item.prop == null);
    const weightTotal = random.reduce((sum, item) => sum + (item.prop ?? 0), 0);
    return { random, choice, fixed, weightTotal, total: items.length };
  }, [detail]);

  const chapterIndex = chapters.findIndex((quest) => quest.id === selectedId);

  // 進行中對話（完成 NPC 的 stop/lost 台詞）；有內容才出現分段。
  const progressStage = useMemo<QuestDialogueStage | null>(() => {
    const end = detail?.end;
    if (!end) return null;
    const lines = [...end.stopNpc, ...end.stopItem, ...end.lost];
    if (lines.length === 0) return null;
    return { ...end, lines, ask: [], yes: [], no: [], stopNpc: [], stopItem: [], lost: [] };
  }, [detail]);

  const currentStage =
    stageTab === "start" ? detail?.start : stageTab === "end" ? detail?.end : progressStage;
  const stageNpcId = currentStage?.npcId ?? null;
  const stageNpcName = currentStage?.npcName ?? null;

  const showTip = (itemId: number, event: React.MouseEvent, name: string | null) => {
    const generation = ++tipGenerationRef.current;
    const x = Math.min(event.clientX + 16, Math.max(0, window.innerWidth - 360));
    const y = event.clientY - 8;
    let cached = tooltipCacheRef.current.get(itemId);
    if (!cached) {
      cached = getItemTooltipById(itemId).catch(() => null);
      tooltipCacheRef.current.set(itemId, cached);
    }
    void cached.then((result) => {
      if (tipGenerationRef.current !== generation || !result) return;
      // 字串表缺名時標題會是原始 id，改用清單的名稱。
      const titled = result.title === String(itemId) && name ? { ...result, title: name } : result;
      setTip({ tip: titled, gear: isGear(itemId), x, y });
    });
  };

  const hideTip = () => {
    tipGenerationRef.current += 1;
    setTip(null);
  };

  const pickQuest = (questId: string) => setSelectedId(questId);

  // 需求道具點擊後的「也掉落此道具的怪物」彈窗；null 表示未開啟。
  const [dropSources, setDropSources] = useState<DropSourceItem | null>(null);
  const [dropSourceMobs, setDropSourceMobs] = useState<MonsterSummary[]>([]);
  // 彈窗怪物縮圖快取：放這層，重開彈窗不重抓。
  const mobThumbCacheRef = useRef<MobThumbCache>(new Map());
  const dropSourcesGenerationRef = useRef(0);

  const openDropSources = (item: QuestItemRef) => {
    hideTip();
    setDropSources({ itemId: item.id, name: item.name });
  };

  // 彈窗開啟時載入掉落來源（圖鑑戰利品 ∪ 任務道具補充表，已排序）。
  useEffect(() => {
    if (!dropSources) return;
    const generation = ++dropSourcesGenerationRef.current;
    setDropSourceMobs([]);
    void getDropSources(dropSources.itemId)
      .then((mobs) => {
        if (dropSourcesGenerationRef.current === generation) setDropSourceMobs(mobs);
      })
      .catch(() => undefined);
  }, [dropSources]);

  let content;
  if (loadError) {
    content = <p className="quest-page-status">{t("quest.page.loadFailed", { error: loadError })}</p>;
  } else if (!book) {
    content = <p className="quest-page-status">{t("quest.page.loading")}</p>;
  } else {
    content = (
      <>
        <aside className="quest-shelf">
          <div className="quest-search">
            <input
              type="search"
              value={query}
              placeholder={t("quest.search.placeholder")}
              aria-label={t("quest.search.label")}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <div className="quest-shelf-scroll">
            {groups.map((group) =>
              group.parent !== null ? (
                <section key={group.parent} className="quest-book-card">
                  <h3>
                    <span className="quest-book-title">{group.parent}</span>
                    <span className="quest-book-count">
                      {t("quest.shelf.chapters", { count: group.quests.length })}
                    </span>
                  </h3>
                  {group.quests.map((quest, index) => (
                    <button
                      key={quest.id}
                      type="button"
                      className={`quest-shelf-item${quest.id === selectedId ? " is-active" : ""}`}
                      onClick={() => pickQuest(quest.id)}
                    >
                      <span className="quest-shelf-chapter">{index + 1}</span>
                      <span className="quest-shelf-name">{quest.name ?? t("common.unnamed")}</span>
                      <span className="quest-shelf-level">{levelLabel(quest)}</span>
                    </button>
                  ))}
                </section>
              ) : (
                <section key="__single__" className="quest-book-card is-single">
                  <h3>
                    <span className="quest-book-title">{t("quest.shelf.standalone")}</span>
                    <span className="quest-book-count">{group.quests.length}</span>
                  </h3>
                  {group.quests.map((quest) => (
                    <button
                      key={quest.id}
                      type="button"
                      className={`quest-shelf-item${quest.id === selectedId ? " is-active" : ""}`}
                      onClick={() => pickQuest(quest.id)}
                    >
                      <span className="quest-shelf-name">{quest.name ?? t("common.unnamed")}</span>
                      <span className="quest-shelf-level">{levelLabel(quest)}</span>
                    </button>
                  ))}
                </section>
              ),
            )}
            {groups.length === 0 ? (
              <p className="quest-list-empty">{t("quest.shelf.noMatch", { query })}</p>
            ) : null}
          </div>
        </aside>

        <section className="quest-stage" aria-busy={detailLoading}>
          <div className="quest-stage-tabs" role="tablist" aria-label={t("quest.stage.label")}>
            <button
              type="button"
              role="tab"
              aria-selected={stageTab === "start"}
              className={stageTab === "start" ? "is-active" : ""}
              onClick={() => setStageTab("start")}
            >
              {t("quest.stage.start")}
            </button>
            {progressStage ? (
              <button
                type="button"
                role="tab"
                aria-selected={stageTab === "progress"}
                className={stageTab === "progress" ? "is-active" : ""}
                onClick={() => setStageTab("progress")}
              >
                {t("quest.stage.progress")}
              </button>
            ) : null}
            <button
              type="button"
              role="tab"
              aria-selected={stageTab === "end"}
              className={stageTab === "end" ? "is-active" : ""}
              onClick={() => setStageTab("end")}
            >
              {t("quest.stage.end")}
            </button>
          </div>
          {detailError ? (
            <p className="quest-page-status">{t("quest.page.loadFailed", { error: detailError })}</p>
          ) : !detail ? (
            <p className="quest-page-status">
              {detailLoading ? t("quest.page.loading") : t("quest.page.selectPrompt")}
            </p>
          ) : (
            <>
              <div className="quest-npc">
                <NpcPortrait npcId={stageNpcId} name={stageNpcName} />
                <div className="quest-npc-plate">
                  {stageNpcName ?? (stageNpcId != null ? String(stageNpcId) : t("quest.npc.unknown"))}
                </div>
              </div>
              <div className="quest-dialogue" key={`${detail.id}:${stageTab}`}>
                {currentStage ? (
                  <DialogueView stage={currentStage} onItemHover={showTip} onItemLeave={hideTip} />
                ) : (
                  <p className="quest-dialogue-empty">{t("quest.dialogue.empty")}</p>
                )}
              </div>
              {chapters.length > 1 && chapterIndex >= 0 ? (
                <div className="quest-chapters">
                  <button
                    type="button"
                    disabled={chapterIndex <= 0}
                    aria-label={t("quest.chapter.prev")}
                    onClick={() => pickQuest(chapters[chapterIndex - 1].id)}
                  >
                    ◀
                  </button>
                  <span>
                    {t("quest.chapter.position", {
                      current: chapterIndex + 1,
                      total: chapters.length,
                    })}
                  </span>
                  <button
                    type="button"
                    disabled={chapterIndex >= chapters.length - 1}
                    aria-label={t("quest.chapter.next")}
                    onClick={() => pickQuest(chapters[chapterIndex + 1].id)}
                  >
                    ▶
                  </button>
                </div>
              ) : null}
            </>
          )}
        </section>

        <section
          className={`quest-log${frameUrl ? " has-frame" : ""}`}
          style={frameUrl ? ({ borderImageSource: `url(${frameUrl})` } as CSSProperties) : undefined}
        >
          {detailError ? (
            <p className="quest-page-status">{t("quest.page.loadFailed", { error: detailError })}</p>
          ) : !detail ? (
            <p className="quest-page-status">
              {detailLoading ? t("quest.page.loading") : t("quest.page.selectPrompt")}
            </p>
          ) : (
            <div className="quest-log-scroll">
              <header className="quest-log-header">
                <h2>{detail.name ?? t("common.unnamed")}</h2>
                {detail.parent ? <p className="quest-log-parent">{detail.parent}</p> : null}
                <div className="quest-log-chips">
                  {levelLabel(detail) ? (
                    <span className="quest-chip is-level">{levelLabel(detail)}</span>
                  ) : null}
                  {detail.interval != null && detail.interval > 0 ? (
                    <span className="quest-chip">{t("quest.log.repeatable")}</span>
                  ) : null}
                  <span className="quest-chip">{detail.id}</span>
                </div>
              </header>

              {Object.keys(detail.info).length > 0 ? (
                <section className="quest-log-section">
                  <h3>{t("quest.log.summary")}</h3>
                  {Object.entries(detail.info).map(([key, text]) => (
                    <MapleText
                      key={key}
                      raw={text}
                      className="quest-log-text"
                      onItemHover={showTip}
                      onItemLeave={hideTip}
                      dropTrackerLines
                    />
                  ))}
                </section>
              ) : null}

              <section className="quest-log-section">
                <h3>{t("quest.log.requirements")}</h3>
                {detail.startRequirements.preQuests.length > 0 ? (
                  <div className="quest-log-row">
                    <span className="quest-log-label">{t("quest.log.preQuests")}</span>
                    <div className="quest-log-values">
                      {detail.startRequirements.preQuests.map((ref) => (
                        <button
                          key={ref.id}
                          type="button"
                          className="quest-ref-link"
                          title={t("quest.log.questId", { id: ref.id })}
                          onClick={() => pickQuest(ref.id)}
                        >
                          {ref.name ?? ref.id}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}
                {detail.startRequirements.items.length > 0 ? (
                  <div className="quest-log-row">
                    <span className="quest-log-label">{t("quest.log.startItems")}</span>
                    <div className="quest-item-grid">
                      {detail.startRequirements.items.map((item, index) => (
                        <QuestItemChip
                          key={`s${item.id}-${index}`}
                          item={item}
                          onHover={showTip}
                          onLeave={hideTip}
                          onClick={openDropSources}
                        />
                      ))}
                    </div>
                  </div>
                ) : null}
                {detail.requirements.items.length > 0 ? (
                  <div className="quest-log-row">
                    <span className="quest-log-label">{t("quest.log.requiredItems")}</span>
                    <div className="quest-item-grid">
                      {detail.requirements.items.map((item, index) => (
                        <QuestItemChip
                          key={`r${item.id}-${index}`}
                          item={item}
                          onHover={showTip}
                          onLeave={hideTip}
                          onClick={openDropSources}
                        />
                      ))}
                    </div>
                  </div>
                ) : null}
                {detail.requirements.mobs.length > 0 ? (
                  <div className="quest-log-row">
                    <span className="quest-log-label">{t("quest.log.mobs")}</span>
                    <div className="quest-log-values">
                      {detail.requirements.mobs.map((mob, index) => (
                        <span key={`${mob.id}-${index}`} className="quest-chip">
                          {mob.name ?? mob.id} ×{mob.count}
                        </span>
                      ))}
                    </div>
                  </div>
                ) : null}
                {detail.startRequirements.preQuests.length === 0 &&
                detail.startRequirements.items.length === 0 &&
                detail.requirements.items.length === 0 &&
                detail.requirements.mobs.length === 0 ? (
                  <p className="quest-log-empty">{t("quest.log.noRequirements")}</p>
                ) : null}
              </section>

              <section className="quest-log-section">
                <h3>{t("quest.log.rewards")}</h3>
                <dl className="quest-rewards">
                  {detail.rewards.exp != null && detail.rewards.exp !== 0 ? (
                    <div className="quest-reward">
                      <dt>EXP</dt>
                      <dd>{detail.rewards.exp.toLocaleString()}</dd>
                    </div>
                  ) : null}
                  {detail.rewards.mesos != null && detail.rewards.mesos !== 0 ? (
                    <div className="quest-reward">
                      <dt>{t("quest.log.mesos")}</dt>
                      <dd>{detail.rewards.mesos.toLocaleString()}</dd>
                    </div>
                  ) : null}
                  {detail.rewards.popularity != null && detail.rewards.popularity !== 0 ? (
                    <div className="quest-reward">
                      <dt>{t("quest.log.fame")}</dt>
                      <dd>{detail.rewards.popularity.toLocaleString()}</dd>
                    </div>
                  ) : null}
                </dl>
                {rewardGroups.fixed.length > 0 ? (
                  <div className="quest-item-grid">
                    {rewardGroups.fixed.map((item, index) => (
                      <QuestItemChip
                        key={`a${item.id}-${index}`}
                        item={item}
                        onHover={showTip}
                        onLeave={hideTip}
                      />
                    ))}
                  </div>
                ) : null}
                {rewardGroups.random.length > 0 ? (
                  <div className="quest-log-row">
                    <span className="quest-log-label">{t("quest.log.randomRewards")}</span>
                    <div className="quest-item-grid">
                      {rewardGroups.random.map((item, index) => (
                        <QuestItemChip
                          key={`r${item.id}-${index}`}
                          item={item}
                          chance={chanceLabel(item.prop ?? 0, rewardGroups.weightTotal)}
                          onHover={showTip}
                          onLeave={hideTip}
                        />
                      ))}
                    </div>
                  </div>
                ) : null}
                {rewardGroups.choice.length > 0 ? (
                  <div className="quest-log-row">
                    <span className="quest-log-label">{t("quest.log.choiceRewards")}</span>
                    <div className="quest-item-grid">
                      {rewardGroups.choice.map((item, index) => (
                        <QuestItemChip
                          key={`c${item.id}-${index}`}
                          item={item}
                          onHover={showTip}
                          onLeave={hideTip}
                        />
                      ))}
                    </div>
                  </div>
                ) : null}
                {detail.rewards.nextQuest ? (
                  <div className="quest-log-row">
                    <span className="quest-log-label">{t("quest.log.nextQuest")}</span>
                    <div className="quest-log-values">
                      <button
                        type="button"
                        className="quest-ref-link"
                        title={t("quest.log.questId", { id: detail.rewards.nextQuest.id })}
                        onClick={() => pickQuest(detail.rewards.nextQuest!.id)}
                      >
                        {detail.rewards.nextQuest.name ?? detail.rewards.nextQuest.id}
                      </button>
                    </div>
                  </div>
                ) : null}
                {detail.rewards.exp == null &&
                detail.rewards.mesos == null &&
                detail.rewards.popularity == null &&
                rewardGroups.total === 0 &&
                !detail.rewards.nextQuest ? (
                  <p className="quest-log-empty">{t("quest.log.noRewards")}</p>
                ) : null}
              </section>
            </div>
          )}
        </section>
      </>
    );
  }

  return (
    <div className="quest-page" hidden={!visible}>
      {content}
      {tip
        ? createPortal(
            <div className="quest-item-tooltip" style={{ left: tip.x, top: tip.y }}>
              {tip.gear ? <ItemTooltip details={tip.tip} /> : <DropItemTooltip details={tip.tip} />}
            </div>,
            document.body,
          )
        : null}
      {dropSources ? (
        <DropSourcesDialog
          item={dropSources}
          sources={dropSourceMobs}
          currentMobId={null}
          thumbCache={mobThumbCacheRef.current}
          onPick={(mobId) => {
            setDropSources(null);
            onOpenMob?.(mobId);
          }}
          onClose={() => setDropSources(null)}
        />
      ) : null}
    </div>
  );
}
