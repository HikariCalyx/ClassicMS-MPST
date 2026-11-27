// 「也掉落此道具的怪物」彈窗：從怪物圖鑑的戰利品點進來，
// 列出所有掉落該道具的怪物，點怪物可跳回該怪物的明細。

import { useEffect, useRef, useState } from "react";
import { getMobDetail, getMobDropIcon, type MonsterSummary } from "../api";
import { useI18n } from "../i18n";

export interface DropSourceItem {
  itemId: number;
  name: string | null;
}

/** 怪物縮圖快取：mobId → 靜態首幀 data URL（null 表示沒有動畫資料或載入失敗）。 */
export type MobThumbCache = Map<number, Promise<string | null>>;

function loadMobThumb(mobId: number, cache: MobThumbCache): Promise<string | null> {
  let cached = cache.get(mobId);
  if (!cached) {
    cached = getMobDetail(mobId)
      .then((detail) =>
        detail.frames.length > 0 ? `data:image/png;base64,${detail.frames[0].base64}` : null,
      )
      .catch(() => null);
    cache.set(mobId, cached);
  }
  return cached;
}

/** 怪物縮圖：滾進可視區才載入明細，只顯示靜態第 0 幀（不播動畫，避免大量 rAF 迴圈）。 */
function MobThumb({ mobId, cache }: { mobId: number; cache: MobThumbCache }) {
  const ref = useRef<HTMLSpanElement>(null);
  // undefined = 尚未載入；null = 已確認沒有圖。
  const [src, setSrc] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let active = true;
    const load = () => {
      void loadMobThumb(mobId, cache).then((value) => {
        if (active) setSrc(value);
      });
    };
    if (typeof IntersectionObserver === "undefined") {
      load();
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        observer.disconnect();
        load();
      }
    });
    observer.observe(el);
    return () => {
      active = false;
      observer.disconnect();
    };
  }, [mobId, cache]);

  return (
    <span ref={ref} className="drop-source-thumb">
      {src ? (
        <img alt="" decoding="async" draggable={false} src={src} />
      ) : src === null ? (
        mobId
      ) : null}
    </span>
  );
}

export function DropSourcesDialog({
  item,
  sources,
  currentMobId,
  thumbCache,
  onPick,
  onClose,
}: {
  item: DropSourceItem;
  /** 會掉落此道具的怪物（父層已排序）。 */
  sources: MonsterSummary[];
  /** 目前檢視中的怪物（標記「檢視中」並禁用點擊）。 */
  currentMobId: number | null;
  thumbCache: MobThumbCache;
  onPick: (mobId: number) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [itemIcon, setItemIcon] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void getMobDropIcon(item.itemId)
      .then((icon) => {
        if (active) setItemIcon(icon);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [item.itemId]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div
        className="drop-sources-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t("monster.sources.dialogLabel", { item: item.name ?? item.itemId })}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="drop-sources-header">
          <span className="drop-sources-item-icon">
            {itemIcon ? (
              <img alt="" decoding="async" draggable={false} src={`data:image/png;base64,${itemIcon}`} />
            ) : null}
          </span>
          <h2>{item.name ?? item.itemId}</h2>
          <span className="drop-sources-count">
            {t("monster.sources.count", { count: sources.length })}
          </span>
          <button className="icon-button" type="button" onClick={onClose} aria-label={t("common.close")}>
            ✕
          </button>
        </header>
        <div className="drop-sources-grid">
          {sources.length === 0 ? (
            <p className="drop-sources-empty">{t("monster.sources.empty")}</p>
          ) : null}
          {sources.map((mob) => {
            const current = mob.mobId === currentMobId;
            return (
              <button
                key={mob.mobId}
                type="button"
                className={`drop-source-item${current ? " is-current" : ""}`}
                disabled={current}
                title={String(mob.mobId)}
                onClick={() => onPick(mob.mobId)}
              >
                <MobThumb mobId={mob.mobId} cache={thumbCache} />
                <span className="drop-source-name">{mob.name ?? t("common.unnamed")}</span>
                <span className="drop-source-meta">
                  {mob.level !== null ? `Lv.${mob.level}` : "Lv.?"}
                  {current ? <em>{t("monster.sources.current")}</em> : null}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
