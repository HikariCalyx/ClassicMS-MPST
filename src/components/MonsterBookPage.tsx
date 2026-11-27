import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  getDataSource,
  getItemTooltipById,
  getMobDetail,
  getMobDropIcon,
  supportsDataSourceSwitch,
  type ItemTooltip as ItemTooltipData,
  type MobDetail,
  type MobDropItem,
  type MobFrame,
  type MonsterSummary,
} from "../api";
import { compareDropSourceMobs, loadMonsterBookOnce } from "../dropSources";
import { useI18n, type TFunction } from "../i18n";
import { QUEST_ITEM_DROPS, questDropItemIdsForMob } from "../questDrops";
import { DropSourcesDialog, type DropSourceItem, type MobThumbCache } from "./DropSourcesDialog";
import { DropItemTooltip, ItemTooltip } from "./ItemTooltip";

const mobFrameImageCache = new WeakMap<MobFrame, Promise<HTMLImageElement>>();

function loadMobFrameImage(frame: MobFrame): Promise<HTMLImageElement> {
  let cached = mobFrameImageCache.get(frame);
  if (!cached) {
    cached = new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.decoding = "async";
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("幀圖載入失敗"));
      img.src = `data:image/png;base64,${frame.base64}`;
    });
    cached.catch(() => {
      mobFrameImageCache.delete(frame);
    });
    mobFrameImageCache.set(frame, cached);
  }
  return cached;
}

/** Mob 動畫：逐幀播放，各幀以 origin 對齊（取全幀 bounding box）避免跳動。 */
function MobSprite({ frames, playing }: { frames: MobFrame[]; playing: boolean }) {
  const { t } = useI18n();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [images, setImages] = useState<HTMLImageElement[] | null>(null);
  const [box, setBox] = useState<{ left: number; top: number; width: number; height: number } | null>(
    null,
  );

  // 載入所有幀圖，並計算 origin 對齊的聯集 bounding box。
  useEffect(() => {
    let cancelled = false;
    if (frames.length === 0) {
      setImages(null);
      setBox(null);
      return;
    }
    Promise.all(frames.map(loadMobFrameImage))
      .then((loaded) => {
        if (cancelled) return;
        let left = 0;
        let top = 0;
        let right = 0;
        let bottom = 0;
        frames.forEach((frame) => {
          left = Math.max(left, frame.origin[0]);
          top = Math.max(top, frame.origin[1]);
          right = Math.max(right, frame.width - frame.origin[0]);
          bottom = Math.max(bottom, frame.height - frame.origin[1]);
        });
        setImages(loaded);
        setBox({ left, top, width: left + right, height: top + bottom });
      })
      .catch(() => {
        if (!cancelled) {
          setImages(null);
          setBox(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [frames]);

  // 播放迴圈：依每幀 delay 推進；暫停或只剩一幀時停在第 0 幀。
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !images || !box) return;
    canvas.width = box.width;
    canvas.height = box.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    let index = 0;
    let timer = 0;
    const draw = () => {
      const frame = frames[index];
      ctx.clearRect(0, 0, box.width, box.height);
      ctx.drawImage(images[index], box.left - frame.origin[0], box.top - frame.origin[1]);
    };
    draw();
    if (playing && frames.length > 1) {
      const step = () => {
        index = (index + 1) % frames.length;
        draw();
        timer = window.setTimeout(step, Math.max(30, frames[index].delay));
      };
      timer = window.setTimeout(step, Math.max(30, frames[0].delay));
    }
    return () => window.clearTimeout(timer);
  }, [images, box, frames, playing]);

  if (frames.length === 0 || !box) {
    return <div className="monster-sprite-empty">{t("monster.sprite.noAnimation")}</div>;
  }
  // 像素圖整數倍放大（對齊紙娃娃 2x 預覽）；太大才縮小放進框裡。
  const scale = Math.min(4, Math.max(1, Math.floor(160 / Math.max(box.width, box.height))));
  return (
    <canvas
      ref={canvasRef}
      className="monster-sprite-canvas"
      style={{
        aspectRatio: `${box.width} / ${box.height}`,
        width: box.width * scale,
      }}
    />
  );
}

function MobDropIcon({
  drop,
  loadIcon,
  onMissing,
}: {
  drop: MobDropItem;
  loadIcon: (itemId: number) => Promise<string | null>;
  onMissing: (itemId: number) => void;
}) {
  const [base64, setBase64] = useState<string | null | undefined>(drop.iconBase64);

  useEffect(() => {
    setBase64(drop.iconBase64);
    if (drop.iconBase64 !== undefined) return;
    let active = true;
    void loadIcon(drop.itemId)
      .then((icon) => {
        if (!active) return;
        setBase64(icon);
        if (icon == null && drop.name == null) onMissing(drop.itemId);
      })
      .catch(() => {
        if (active) setBase64(null);
      });
    return () => {
      active = false;
    };
  }, [drop.iconBase64, drop.itemId, drop.name, loadIcon, onMissing]);

  if (base64) {
    return (
      <img
        alt={drop.name ?? String(drop.itemId)}
        decoding="async"
        draggable={false}
        src={`data:image/png;base64,${base64}`}
      />
    );
  }
  return (
    <span className="monster-drop-fallback">
      {drop.itemId}
    </span>
  );
}

const MonsterList = memo(function MonsterList({
  entries,
  query,
  selectedId,
  onSelect,
  onPrime,
  onSchedulePrefetch,
  onCancelPrefetch,
}: {
  entries: MonsterSummary[];
  query: string;
  selectedId: number | null;
  onSelect: (mobId: number) => void;
  onPrime: (mobId: number) => void;
  onSchedulePrefetch: (mobId: number) => void;
  onCancelPrefetch: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="monster-list" role="listbox" aria-label={t("monster.list.label")}>
      {entries.map((entry) => (
        <button
          key={entry.mobId}
          type="button"
          role="option"
          aria-selected={entry.mobId === selectedId}
          className={`monster-list-item${entry.mobId === selectedId ? " is-active" : ""}`}
          onClick={() => onSelect(entry.mobId)}
          onFocus={() => onPrime(entry.mobId)}
          onPointerDown={() => onPrime(entry.mobId)}
          onPointerEnter={() => onSchedulePrefetch(entry.mobId)}
          onPointerLeave={onCancelPrefetch}
        >
          <span className="monster-list-name">{entry.name ?? t("common.unnamed")}</span>
          <span className="monster-list-meta">
            {entry.level !== null ? `Lv.${entry.level}` : "Lv.?"}
          </span>
          <span className="monster-list-id">{entry.mobId}</span>
        </button>
      ))}
      {entries.length === 0 ? (
        <p className="monster-list-empty">{t("monster.list.noMatch", { query })}</p>
      ) : null}
    </div>
  );
});

/** 戰利品分組：依道具 id 首位分 裝備(1) / 消耗(2) / 其他（3~5、9 等）。
 *  分組用代碼，標籤在渲染時依介面語言翻譯（monster.dropGroup.*）。 */
const DROP_GROUP_ORDER = ["equip", "use", "etc"] as const;

type DropGroup = (typeof DROP_GROUP_ORDER)[number];

function dropGroup(itemId: number): DropGroup {
  const prefix = Math.floor(itemId / 1_000_000);
  if (prefix === 1) return "equip";
  if (prefix === 2) return "use";
  return "etc";
}

/** 能力值列（渲染時呼叫）：HP / MP / EXP 照原樣顯示，其餘標籤依介面語言翻譯。 */
function statRows(detail: MobDetail, t: TFunction): [string, string][] {
  const rows: [string, string][] = [];
  const push = (label: string, value: number) => {
    if (value !== 0) rows.push([label, value.toLocaleString()]);
  };
  push("HP", detail.maxHp);
  push("MP", detail.maxMp);
  push("EXP", detail.exp);
  push(t("monster.stats.pad"), detail.pad);
  push(t("monster.stats.pdd"), detail.pdd);
  push(t("monster.stats.mad"), detail.mad);
  push(t("monster.stats.mdd"), detail.mdd);
  push(t("monster.stats.acc"), detail.acc);
  push(t("monster.stats.eva"), detail.eva);
  push(t("monster.stats.speed"), detail.speed);
  push(t("monster.stats.pushed"), detail.pushed);
  return rows;
}

// 怪物圖鑑頁：左欄清單 + 搜尋，右欄明細；第一次切到此頁才載入資料。
export function MonsterBookPage({
  visible,
  onPickMob,
  jumpToMob,
  onJumpToMobHandled,
}: {
  visible: boolean;
  /** 選取怪物時回報圖鑑路徑（給 App footer 麵包屑）。 */
  onPickMob?: (path: string) => void;
  /** 其他頁面要求跳轉到指定怪物（nonce 讓同 id 可重複觸發）。 */
  jumpToMob?: { mobId: number; nonce: number } | null;
  onJumpToMobHandled?: () => void;
}) {
  const { t } = useI18n();
  const [book, setBook] = useState<MonsterSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<MobDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [missingDrops, setMissingDrops] = useState<{
    mobId: number | null;
    itemIds: Set<number>;
  }>({ mobId: null, itemIds: new Set() });
  const detailGenerationRef = useRef(0);

  // 任務道具補充表的名稱（itemId → 名稱）：不在圖鑑清單內，清單載入後另外補齊。
  const [questDropNames, setQuestDropNames] = useState<Record<number, string | null> | null>(null);

  // 戰利品點擊後的「也掉落此道具的怪物」彈窗；null 表示未開啟。
  const [dropSources, setDropSources] = useState<DropSourceItem | null>(null);
  // 彈窗怪物縮圖快取：放父層，重開彈窗不重抓。
  const mobThumbCacheRef = useRef<MobThumbCache>(new Map());
  const listRef = useRef<HTMLElement>(null);

  // 戰利品 hover tooltip：結果按 itemId 快取，淡入淡出由 is-visible 控制。
  const tooltipCacheRef = useRef(new Map<number, Promise<ItemTooltipData | null>>());
  const [dropTip, setDropTip] = useState<{
    tip: ItemTooltipData;
    gear: boolean;
    x: number;
    y: number;
  } | null>(null);
  const [dropTipVisible, setDropTipVisible] = useState(false);
  const dropTipGenerationRef = useRef(0);
  const dropTipHideTimerRef = useRef(0);
  const prefetchTimerRef = useRef(0);

  const loadItemTooltip = useCallback((itemId: number): Promise<ItemTooltipData | null> => {
    let cached = tooltipCacheRef.current.get(itemId);
    if (!cached) {
      cached = getItemTooltipById(itemId).catch(() => null);
      tooltipCacheRef.current.set(itemId, cached);
    }
    return cached;
  }, []);

  const loadDropIcon = useCallback((itemId: number) => getMobDropIcon(itemId), []);

  const hideMissingDrop = useCallback((itemId: number) => {
    const mobId = detail?.mobId ?? null;
    setMissingDrops((current) => {
      if (current.mobId === mobId && current.itemIds.has(itemId)) return current;
      const itemIds = current.mobId === mobId ? new Set(current.itemIds) : new Set<number>();
      itemIds.add(itemId);
      return { mobId, itemIds };
    });
  }, [detail?.mobId]);

  const showDropTip = (itemId: number, event: React.MouseEvent, name: string | null) => {
    window.clearTimeout(dropTipHideTimerRef.current);
    const generation = ++dropTipGenerationRef.current;
    // 預留 tooltip 大概寬度，避免超出視窗右緣；y 為游標位置，
    // tooltip 以左下角為原點向上長（CSS translateY(-100%)）。
    const x = Math.min(event.clientX + 16, Math.max(0, window.innerWidth - 360));
    const y = event.clientY - 8;
    const gear = dropGroup(itemId) === "equip";
    const present = (tip: ItemTooltipData) => {
      // 字串表缺名時（如寵物）標題會是原始 id，改用戰利品清單的名稱。
      const titled =
        tip.title === String(itemId) && name ? { ...tip, title: name } : tip;
      setDropTip({ tip: titled, gear, x, y });
      // 掛載後下一幀才加 is-visible，才會有淡入過場。
      requestAnimationFrame(() => setDropTipVisible(true));
    };
    void loadItemTooltip(itemId).then((tip) => {
      if (dropTipGenerationRef.current === generation && tip) present(tip);
    });
  };

  const hideDropTip = () => {
    dropTipGenerationRef.current += 1;
    setDropTipVisible(false);
    window.clearTimeout(dropTipHideTimerRef.current);
    // 等淡出動畫播完再卸載。
    dropTipHideTimerRef.current = window.setTimeout(() => setDropTip(null), 160);
  };

  // 滑到 tooltip 本體上時保持顯示：取消淡出計時器並恢復不透明。
  const keepDropTip = () => {
    window.clearTimeout(dropTipHideTimerRef.current);
    setDropTipVisible(true);
  };

  // 卸載時清掉淡出與預載計時器。
  useEffect(
    () => () => {
      window.clearTimeout(dropTipHideTimerRef.current);
      window.clearTimeout(prefetchTimerRef.current);
    },
    [],
  );

  const primeMobDetail = useCallback((mobId: number) => {
    // 正式 hosted 雲端版才預載；本機資料避免游標滑過時觸發昂貴的 WASM 解析。
    if (!supportsDataSourceSwitch() || getDataSource() !== "cloud") return;
    void getMobDetail(mobId).catch(() => undefined);
  }, []);

  const scheduleMobDetailPrefetch = useCallback((mobId: number) => {
    window.clearTimeout(prefetchTimerRef.current);
    prefetchTimerRef.current = window.setTimeout(() => primeMobDetail(mobId), 120);
  }, [primeMobDetail]);

  const cancelMobDetailPrefetch = useCallback(() => {
    window.clearTimeout(prefetchTimerRef.current);
  }, []);

  const selectMob = useCallback((mobId: number) => setSelectedId(mobId), []);

  // 清單只載入一次（此元件掛載後保持不卸載）。
  useEffect(() => {
    let active = true;
    loadMonsterBookOnce()
      .then((list) => {
        if (!active) return;
        setBook(list);
        if (list.length > 0) setSelectedId((id) => id ?? list[0].mobId);
      })
      .catch((error: unknown) => {
        if (active) setLoadError(String(error));
      });
    // 任務道具補充表的名稱不在圖鑑清單裡，從道具字串表補齊（走 tooltip 快取）。
    void Promise.all(
      Object.keys(QUEST_ITEM_DROPS).map(async (itemKey) => {
        const itemId = Number(itemKey);
        const tip = await loadItemTooltip(itemId);
        // 字串表缺名時 title 會是原始 id，視同無名稱。
        const name = tip && tip.title !== String(itemId) ? tip.title : null;
        return [itemId, name] as const;
      }),
    ).then((entries) => {
      if (active) setQuestDropNames(Object.fromEntries(entries));
    });
    return () => {
      active = false;
    };
  }, [loadItemTooltip]);

  // 其他頁面（如任務頁的掉落來源彈窗）要求跳轉到指定怪物；等清單載入後選取。
  useEffect(() => {
    if (!jumpToMob || !book) return;
    setSelectedId(jumpToMob.mobId);
    onJumpToMobHandled?.();
  }, [jumpToMob, book, onJumpToMobHandled]);

  // 搜尋：符合怪物名稱、怪物 id、任一掉落物名稱、或任一任務道具名稱（補充表）。
  const filtered = useMemo(() => {
    if (!book) return [];
    const keyword = query.trim().toLowerCase();
    if (!keyword) return book;
    return book.filter(
      (entry) =>
        entry.name?.toLowerCase().includes(keyword) ||
        String(entry.mobId).includes(keyword) ||
        entry.drops.some((drop) => drop.name?.toLowerCase().includes(keyword)) ||
        questDropItemIdsForMob(entry.mobId).some((itemId) =>
          questDropNames?.[itemId]?.toLowerCase().includes(keyword),
        ),
    );
  }, [book, query, questDropNames]);

  const visibleDrops = useMemo(
    () =>
      detail?.drops.filter(
        (drop) => missingDrops.mobId !== detail.mobId || !missingDrops.itemIds.has(drop.itemId),
      ) ?? [],
    [detail, missingDrops],
  );

  // 反向索引：itemId → 掉落它的怪物（清單已內嵌完整 drops，直接前端建表；
  // 任務道具補充表也併入，點擊任務道具一樣能反查掉落來源）。
  const dropSourcesIndex = useMemo(() => {
    const index = new Map<number, MonsterSummary[]>();
    for (const entry of book ?? []) {
      for (const drop of entry.drops) {
        const list = index.get(drop.itemId);
        if (list) list.push(entry);
        else index.set(drop.itemId, [entry]);
      }
    }
    for (const [itemKey, mobIds] of Object.entries(QUEST_ITEM_DROPS)) {
      const itemId = Number(itemKey);
      const list = index.get(itemId) ?? [];
      for (const mobId of mobIds) {
        if (list.some((entry) => entry.mobId === mobId)) continue;
        // 怪物不在圖鑑清單時補一筆最小資料，讓補充表的來源仍可顯示與跳轉。
        const entry = (book ?? []).find((mob) => mob.mobId === mobId) ?? {
          mobId,
          name: null,
          level: null,
          drops: [],
        };
        list.push(entry);
      }
      index.set(itemId, list);
    }
    return index;
  }, [book]);

  // 彈窗顯示的怪物清單：等級升冪（未知排最後），再等級同名稱排序。
  const dropSourceMobs = useMemo(() => {
    if (!dropSources) return [];
    const mobs = dropSourcesIndex.get(dropSources.itemId) ?? [];
    return [...mobs].sort(compareDropSourceMobs);
  }, [dropSources, dropSourcesIndex]);

  // 任務道具掉落（補充表）：圖鑑戰利品之外的獨立區塊，名稱由 questDropNames 補齊。
  const questDrops = useMemo<MobDropItem[]>(() => {
    if (!detail) return [];
    return questDropItemIdsForMob(detail.mobId).map((itemId) => ({
      itemId,
      name: questDropNames?.[itemId] ?? null,
    }));
  }, [detail, questDropNames]);

  const openDropSources = (itemId: number, name: string | null) => {
    hideDropTip();
    setDropSources({ itemId, name });
  };

  const pickDropSource = useCallback((mobId: number) => {
    setDropSources(null);
    setSelectedId(mobId);
  }, []);

  // 選取變更時（含從掉落來源彈窗跳轉），左欄捲到選取列；被搜尋過濾掉就略過。
  useEffect(() => {
    if (selectedId === null) return;
    listRef.current
      ?.querySelector(".monster-list-item.is-active")
      ?.scrollIntoView({ block: "nearest" });
  }, [selectedId]);

  // 選取怪物 → 載入明細（generation guard 防止舊回應蓋掉新選擇）。
  useEffect(() => {
    if (selectedId === null) return;
    const generation = ++detailGenerationRef.current;
    setDetailLoading(true);
    setDetailError(null);
    getMobDetail(selectedId)
      .then((next) => {
        if (detailGenerationRef.current !== generation) return;
        setDetail(next);
        onPickMob?.(`MonsterBook/${next.mobId}`);
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

  let content;
  if (loadError) {
    content = (
      <p className="monster-page-status">{t("monster.page.loadFailed", { error: loadError })}</p>
    );
  } else if (!book) {
    content = <p className="monster-page-status">{t("monster.page.loading")}</p>;
  } else {
    content = (
      <>
        <aside className="monster-left" ref={listRef}>
          <div className="monster-search">
            <input
              type="search"
              value={query}
              placeholder={t("monster.search.placeholder")}
              aria-label={t("monster.search.label")}
              onChange={(event) => setQuery(event.target.value)}
            />
            <span className="monster-search-count">
              {filtered.length} / {book.length}
            </span>
          </div>
          <MonsterList
            entries={filtered}
            query={query}
            selectedId={selectedId}
            onSelect={selectMob}
            onPrime={primeMobDetail}
            onSchedulePrefetch={scheduleMobDetailPrefetch}
            onCancelPrefetch={cancelMobDetailPrefetch}
          />
        </aside>
        <section className="monster-detail" aria-busy={detailLoading}>
          {detailLoading && detail ? (
            <span className="monster-detail-loading" role="status">
              {t("monster.detail.switching")}
            </span>
          ) : null}
          {detailError ? (
            <p className="monster-page-status">
              {t("monster.detail.loadFailed", { error: detailError })}
            </p>
          ) : !detail ? (
            <p className="monster-page-status">
              {detailLoading ? t("monster.detail.loading") : t("monster.detail.selectPrompt")}
            </p>
          ) : (
            <div className="monster-detail-scroll">
              <header className="monster-hero">
                <div className="monster-sprite">
                  <MobSprite frames={detail.frames} playing={visible} />
                </div>
                <div className="monster-hero-text">
                  <h2>{detail.name ?? t("common.unnamed")}</h2>
                  <p className="monster-hero-id">{detail.mobId}</p>
                  <div className="monster-hero-chips">
                    {detail.level !== null ? (
                      <span className="monster-chip">Lv.{detail.level}</span>
                    ) : null}
                    {detail.category ? (
                      <span className="monster-chip">
                        {t("monster.hero.category", { category: detail.category })}
                      </span>
                    ) : null}
                    {detail.bodyAttack ? (
                      <span className="monster-chip">{t("monster.hero.bodyAttack")}</span>
                    ) : null}
                    {detail.undead ? (
                      <span className="monster-chip">{t("monster.hero.undead")}</span>
                    ) : null}
                  </div>
                  {detail.description ? (
                    <p className="monster-description">{detail.description}</p>
                  ) : null}
                </div>
              </header>

              {statRows(detail, t).length > 0 ? (
                <section className="monster-section">
                  <h3>{t("monster.stats.title")}</h3>
                  <dl className="monster-stats">
                    {statRows(detail, t).map(([label, value]) => (
                      <div key={label} className="monster-stat">
                        <dt>{label}</dt>
                        <dd>{value}</dd>
                      </div>
                    ))}
                  </dl>
                </section>
              ) : null}

              <section className="monster-section">
                <h3>
                  {t("monster.drops.title", { count: visibleDrops.length })}
                  {visibleDrops.length > 0 ? (
                    <span className="monster-section-hint">{t("monster.drops.hint")}</span>
                  ) : null}
                </h3>
                {visibleDrops.length > 0 ? (
                  DROP_GROUP_ORDER.map((group) => {
                    const items = visibleDrops.filter(
                      (drop) => dropGroup(drop.itemId) === group,
                    );
                    if (items.length === 0) return null;
                    return (
                      <div key={group} className="monster-drop-group">
                        <h4>
                          {t("monster.drops.group", {
                            group: t(`monster.dropGroup.${group}`),
                            count: items.length,
                          })}
                        </h4>
                        <div className="monster-drops">
                          {items.map((drop) => (
                            <button
                              key={drop.itemId}
                              type="button"
                              className="monster-drop"
                              title={t("monster.drops.viewSources")}
                              onClick={() => openDropSources(drop.itemId, drop.name)}
                              onMouseEnter={(event) => showDropTip(drop.itemId, event, drop.name)}
                              onMouseLeave={hideDropTip}
                            >
                              <div className="monster-drop-icon">
                                <MobDropIcon
                                  drop={drop}
                                  loadIcon={loadDropIcon}
                                  onMissing={hideMissingDrop}
                                />
                              </div>
                              <span className="monster-drop-name">{drop.name ?? drop.itemId}</span>
                            </button>
                          ))}
                        </div>
                      </div>
                    );
                  })
                ) : (
                  <p className="monster-section-empty">{t("monster.drops.empty")}</p>
                )}
              </section>

              {questDrops.length > 0 ? (
                <section className="monster-section">
                  <h3>
                    {t("monster.questDrops.title", { count: questDrops.length })}
                    <span className="monster-section-hint">{t("monster.drops.hint")}</span>
                  </h3>
                  <div className="monster-drops">
                    {questDrops.map((drop) => (
                      <button
                        key={drop.itemId}
                        type="button"
                        className="monster-drop"
                        title={t("monster.drops.viewSources")}
                        onClick={() => openDropSources(drop.itemId, drop.name)}
                        onMouseEnter={(event) => showDropTip(drop.itemId, event, drop.name)}
                        onMouseLeave={hideDropTip}
                      >
                        <div className="monster-drop-icon">
                          <MobDropIcon
                            drop={drop}
                            loadIcon={loadDropIcon}
                            onMissing={hideMissingDrop}
                          />
                        </div>
                        <span className="monster-drop-name">{drop.name ?? drop.itemId}</span>
                      </button>
                    ))}
                  </div>
                </section>
              ) : null}

              {detail.maps.length > 0 ? (
                <section className="monster-section">
                  <h3>{t("monster.maps.title", { count: detail.maps.length })}</h3>
                  <div className="monster-maps">
                    {detail.maps.map((map) => (
                      <span key={map.mapId} className="monster-chip" title={String(map.mapId)}>
                        {map.name ?? map.mapId}
                      </span>
                    ))}
                  </div>
                </section>
              ) : null}
            </div>
          )}
        </section>
      </>
    );
  }

  return (
    <div className="monster-page" hidden={!visible}>
      {content}
      {dropTip
        ? createPortal(
            <div
              className={`monster-drop-tooltip${dropTipVisible ? " is-visible" : ""}`}
              style={{ left: dropTip.x, top: dropTip.y }}
              onMouseEnter={keepDropTip}
              onMouseLeave={hideDropTip}
            >
              {dropTip.gear ? (
                <ItemTooltip details={dropTip.tip} />
              ) : (
                <DropItemTooltip details={dropTip.tip} />
              )}
            </div>,
            document.body,
          )
        : null}
      {dropSources ? (
        <DropSourcesDialog
          item={dropSources}
          sources={dropSourceMobs}
          currentMobId={selectedId}
          thumbCache={mobThumbCacheRef.current}
          onPick={pickDropSource}
          onClose={() => setDropSources(null)}
        />
      ) : null}
    </div>
  );
}
