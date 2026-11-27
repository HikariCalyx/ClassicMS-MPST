import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import type { ItemTooltip as ItemTooltipData } from "../api";
import { useI18n } from "../i18n";
import { exportDropItemTooltipPng, exportTooltipPng } from "./tooltipExport";
import { tooltipText, tooltipTitle } from "./tooltipText";

/** 呈現方式對齊 Harepacker-MPST 的 ItemTooltipCard（gear 版本）。 */

const ICON_SCALE = 2;
const ICON_MIN_SIZE = 34;
const ICON_MAX_SIZE = 68;

const numberFormatter = new Intl.NumberFormat();

function formatReq(value: number): string {
  return numberFormatter.format(value);
}

function reqTone(value: number, highlightLevel = false): string {
  if (value === 0) return "is-zero";
  return highlightLevel ? "is-level" : "is-active";
}

/** 描述正規化：資料裡的換行是字面 \n（對齊 monster.ts / skillJobs.ts）。 */
const normalizeDesc = (text: string): string => text.replace(/\\n/g, "\n");

/** 衝裝備卷軸：名稱含「卷軸＋%數」且描述有成功率。 */
const isUpgradeScroll = (title: string, desc: string): boolean =>
  title.includes("卷軸") && /\d+%/.test(title) && desc.includes("成功率");

/** tooltip 描述顯示用文字：先還原字面 \n 換行；
 *  衝裝備卷軸再把逗號／頓號分隔的屬性逐條換行，方便檢視（畫面與 PNG 匯出共用）。 */
export const formatItemDescription = (title: string, desc: string): string => {
  const normalized = normalizeDesc(desc);
  if (!isUpgradeScroll(title, normalized)) return normalized;
  return normalized.replace(/[，,、]/g, "\n");
};

/** 右鍵「儲存成 PNG」選單（裝備與非裝備 tooltip 共用）：
 *  選單開著時，點外面、Esc、視窗失焦或縮放就關掉。 */
function useSavePngMenu(saveAsPng: () => void) {
  const { t } = useI18n();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onPointerDown = (e: PointerEvent) => {
      if (menuRef.current && e.target instanceof Node && menuRef.current.contains(e.target)) {
        return;
      }
      close();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
    };
  }, [menu]);

  const openMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    // 預留選單大概尺寸，避免超出視窗右下緣。
    setMenu({
      x: Math.min(e.clientX, window.innerWidth - 150),
      y: Math.min(e.clientY, window.innerHeight - 48),
    });
  };

  const menuElement = menu
    ? createPortal(
        <div
          ref={menuRef}
          className="tooltip-context-menu"
          style={{ left: menu.x, top: menu.y }}
          role="menu"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMenu(null);
              saveAsPng();
            }}
          >
            {t("common.saveAsPng")}
          </button>
        </div>,
        document.body,
      )
    : null;

  return { openMenu, menuElement };
}

/** 非裝備戰利品 tooltip（消耗/其他）：左圖示、右側上名稱下描述，
 *  外觀與分隔線對齊裝備版；右鍵可儲存成圖片。 */
export function DropItemTooltip({ details }: { details: ItemTooltipData }) {
  const { t } = useI18n();
  const [iconSize, setIconSize] = useState<{ width: number; height: number } | null>(null);
  const { openMenu, menuElement } = useSavePngMenu(() => {
    exportDropItemTooltipPng(details).catch((err: unknown) => {
      window.alert(t("common.saveFailed", { error: String(err) }));
    });
  });

  const iconStyle: CSSProperties | undefined = iconSize
    ? {
        width: Math.min(
          Math.max(iconSize.width * ICON_SCALE, ICON_MIN_SIZE),
          ICON_MAX_SIZE,
        ),
        height: Math.min(
          Math.max(iconSize.height * ICON_SCALE, ICON_MIN_SIZE),
          ICON_MAX_SIZE,
        ),
      }
    : undefined;

  const description = details.description
    ? formatItemDescription(details.title, details.description)
    : null;

  return (
    <>
      <article
        className="item-tooltip drop-item-tooltip"
        aria-label={t("tooltip.itemAria")}
        title={t("tooltip.rightClickHint")}
        onContextMenu={openMenu}
      >
        <div className="item-tooltip-icon-frame">
          {details.iconBase64 ? (
            <img
              alt={details.title}
              draggable={false}
              src={`data:image/png;base64,${details.iconBase64}`}
              style={iconStyle}
              onLoad={(event) =>
                setIconSize({
                  width: event.currentTarget.naturalWidth,
                  height: event.currentTarget.naturalHeight,
                })
              }
            />
          ) : (
            <span className="item-tooltip-icon-fallback">{details.itemId}</span>
          )}
        </div>
        <div className="drop-item-tooltip-text">
          <h3 className="drop-item-tooltip-name">{tooltipTitle(details, t)}</h3>
          {description ? (
            <>
              <div className="item-tooltip-divider" aria-hidden="true" />
              <p className="drop-item-tooltip-desc">{description}</p>
            </>
          ) : null}
        </div>
      </article>
      {menuElement}
    </>
  );
}

export function ItemTooltip({ details }: { details: ItemTooltipData }) {
  const { t } = useI18n();
  const text = useMemo(() => tooltipText(details, t), [details, t]);
  const [iconSize, setIconSize] = useState<{ width: number; height: number } | null>(null);
  const { openMenu, menuElement } = useSavePngMenu(() => {
    exportTooltipPng(details).catch((err: unknown) => {
      window.alert(t("common.saveFailed", { error: String(err) }));
    });
  });

  const iconStyle: CSSProperties | undefined = iconSize
    ? {
        width: Math.min(
          Math.max(iconSize.width * ICON_SCALE, ICON_MIN_SIZE),
          ICON_MAX_SIZE,
        ),
        height: Math.min(
          Math.max(iconSize.height * ICON_SCALE, ICON_MIN_SIZE),
          ICON_MAX_SIZE,
        ),
      }
    : undefined;

  const description = details.description
    ? formatItemDescription(details.title, details.description)
    : null;

  return (
    <>
      <article
        className="item-tooltip"
        aria-label={t("tooltip.gearAria")}
        title={t("tooltip.rightClickHint")}
        onContextMenu={openMenu}
      >
      <header className="item-tooltip-header">
        <span className="item-tooltip-id">{details.itemId}</span>
        <h3>{text.title}</h3>
        {text.attributes ? <p className="item-tooltip-attributes">{text.attributes}</p> : null}
      </header>

      <section className="item-tooltip-summary">
        <div className="item-tooltip-icon-frame">
          {details.iconBase64 ? (
            <img
              alt={details.title}
              draggable={false}
              src={`data:image/png;base64,${details.iconBase64}`}
              style={iconStyle}
              onLoad={(event) =>
                setIconSize({
                  width: event.currentTarget.naturalWidth,
                  height: event.currentTarget.naturalHeight,
                })
              }
            />
          ) : (
            <span className="item-tooltip-icon-fallback">{details.itemId}</span>
          )}
        </div>
        <dl className="item-tooltip-reqs">
          <div className="item-tooltip-req-row">
            <div className={`item-tooltip-req is-wide ${reqTone(details.requiredLevel, true)}`}>
              <dt>{text.req.level}</dt>
              <dd>{formatReq(details.requiredLevel)}</dd>
            </div>
          </div>
          <div className="item-tooltip-req-row">
            <div className={`item-tooltip-req ${reqTone(details.requiredStr)}`}>
              <dt>{text.req.str}</dt>
              <dd>{formatReq(details.requiredStr)}</dd>
            </div>
            <div className={`item-tooltip-req ${reqTone(details.requiredLuk)}`}>
              <dt>{text.req.luk}</dt>
              <dd>{formatReq(details.requiredLuk)}</dd>
            </div>
          </div>
          <div className="item-tooltip-req-row">
            <div className={`item-tooltip-req ${reqTone(details.requiredDex)}`}>
              <dt>{text.req.dex}</dt>
              <dd>{formatReq(details.requiredDex)}</dd>
            </div>
            <div className={`item-tooltip-req ${reqTone(details.requiredInt)}`}>
              <dt>{text.req.int}</dt>
              <dd>{formatReq(details.requiredInt)}</dd>
            </div>
          </div>
        </dl>
      </section>

      <div className="item-tooltip-jobs">
        {text.jobs.map((job) => (
          <span key={job.code} className={job.enabled ? "is-enabled" : "is-disabled"}>
            {job.label}
          </span>
        ))}
      </div>

      <div className="item-tooltip-divider" aria-hidden="true" />

      <section className="item-tooltip-details">
        <p className="item-tooltip-line is-full">{text.categoryLine}</p>
        {text.attackSpeed ? (
          <p className="item-tooltip-line">
            <span className="item-tooltip-label">{`${text.attackSpeed.label} : `}</span>
            <span className="item-tooltip-value">{text.attackSpeed.value}</span>
          </p>
        ) : null}
        {text.stats.map((line) => (
          <p className="item-tooltip-line" key={`${line.label}:${line.value}`}>
            <span className="item-tooltip-label">{`${line.label} : `}</span>
            <span className="item-tooltip-value">{line.value}</span>
          </p>
        ))}
        {text.scrollCount ? (
          <p className="item-tooltip-line is-accent">
            <span className="item-tooltip-label">{`${text.scrollCount.label} : `}</span>
            <span className="item-tooltip-value">{text.scrollCount.value}</span>
          </p>
        ) : null}
      </section>

      {description ? (
        <>
          <div className="item-tooltip-divider" aria-hidden="true" />
          <section className="item-tooltip-flavor">
            <p>{description}</p>
          </section>
        </>
      ) : null}
      </article>
      {menuElement}
    </>
  );
}
