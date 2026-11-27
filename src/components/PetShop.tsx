import { createDatasetCache } from "../locale";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { getImage, type PetEquipInfo, type PetInfo } from "../api";
import { useI18n } from "../i18n";

// 卡片固定高 64px、grid 間距 7px，供列數估算（對齊 .avatar-shop-card / .avatar-shop-grid）。
const CARD_ROW_PX = 64 + 7;

// 模糊比對評分（越小越好）：名稱直接包含最優先，其次代碼包含，
// 最後是字元依序出現（如「楓盾」可中「楓葉盾」）；完全搭不上回 null。（比照 AvatarShop）
function fuzzyScore(query: string, name: string, id: string): number | null {
  const q = query.toLowerCase();
  const n = name.toLowerCase();
  const nameHit = n.indexOf(q);
  if (nameHit >= 0) return nameHit;
  const idHit = id.indexOf(q);
  if (idHit >= 0) return 1000 + idHit;
  let pos = 0;
  for (const ch of q) {
    const found = n.indexOf(ch, pos);
    if (found < 0) return null;
    pos = found + 1;
  }
  return 2000 + pos;
}

// icon dataURL 快取（module-level）：只抓看過的，看過就不再抓。
const iconCache = createDatasetCache<string, Promise<string | null>>();

// 依 iconPath 載入 icon；取不到時試 info/iconRaw 替代節點（比照 loadAvatarIcon 的 fallback）。
export function loadPetIcon(path: string): Promise<string | null> {
  let cached = iconCache.get(path);
  if (!cached) {
    cached = (async () => {
      const result = await getImage(path).catch(() => null);
      if (result) return `data:image/png;base64,${result.base64}`;
      const fallback = path.replace(/info\/icon$/, "info/iconRaw");
      if (fallback !== path) {
        const retry = await getImage(fallback).catch(() => null);
        if (retry) return `data:image/png;base64,${retry.base64}`;
      }
      return null;
    })();
    iconCache.set(path, cached);
  }
  return cached;
}

// 頁碼列：頁數多時只留首尾與現頁附近，其餘用省略號折起（同 AvatarShop）。
function pageNumbers(current: number, total: number): (number | "…")[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i);
  const keep = new Set(
    [0, total - 1, current - 1, current, current + 1].filter((p) => p >= 0 && p < total),
  );
  const out: (number | "…")[] = [];
  let prev = -1;
  for (const p of [...keep].sort((a, b) => a - b)) {
    if (prev !== -1 && p - prev > 1) out.push("…");
    out.push(p);
    prev = p;
  }
  return out;
}

// 卡片資料（寵物與寵裝共用欄位）。
interface PetShopEntry {
  id: string;
  name: string;
  iconPath: string;
}

function PetShopCard({
  item,
  worn,
  onToggle,
}: {
  item: PetShopEntry;
  worn: boolean;
  onToggle: () => void;
}) {
  const { t } = useI18n();
  const [icon, setIcon] = useState<string | null>(null);

  // icon 按頁 lazy：卡片只在當前頁渲染，掛載時才抓圖。
  useEffect(() => {
    let active = true;
    loadPetIcon(item.iconPath).then((url) => {
      if (active && url) setIcon(url);
    });
    return () => {
      active = false;
    };
  }, [item.iconPath]);

  return (
    <button
      type="button"
      className={`avatar-shop-card${worn ? " is-worn" : ""}`}
      title={t("pet.shop.cardTitle", { name: item.name, id: item.id })}
      onClick={onToggle}
    >
      <span className="avatar-shop-card-icon">{icon ? <img src={icon} alt="" /> : null}</span>
      <span className="avatar-shop-card-name">{item.name}</span>
    </button>
  );
}

type PetShopTab = "pet" | "equip";

interface PetShopProps {
  pets: PetInfo[];
  equips: PetEquipInfo[];
  /** 目前寵物 id（寵物 tab 標記用、寵裝 tab 過濾用）。 */
  petId: string;
  /** 目前穿著的寵裝 id（null = 未穿）。 */
  equipId: string | null;
  onSelectPet: (petId: string) => void;
  onToggleEquip: (equipId: string | null) => void;
  /** 點卡片時回報該寵物/寵裝的 img 路徑（給 footer 麵包屑）。 */
  onPickItem?: (path: string) => void;
}

// 右側寵物商店：寵物/寵物裝備 tab + 卡片 grid + 動態分頁（欄×列由 ResizeObserver 量出）。
export function PetShop({
  pets,
  equips,
  petId,
  equipId,
  onSelectPet,
  onToggleEquip,
  onPickItem,
}: PetShopProps) {
  const { t } = useI18n();
  const [activeTab, setActiveTab] = useState<PetShopTab>("pet");
  const [page, setPage] = useState(0);
  // 搜尋關鍵字；非空時在目前 tab 的清單內模糊搜尋。
  const [query, setQuery] = useState("");
  // 初次渲染、尚未量測前的暫用每頁數；之後由可用高度 × 欄數動態決定。
  const [pageSize, setPageSize] = useState(24);
  const gridWrapRef = useRef<HTMLDivElement | null>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);

  // 依 grid 容器可用空間調整每頁筆數：欄數讀 computed style、列數用高度 ÷ 卡片高。
  useLayoutEffect(() => {
    const wrap = gridWrapRef.current;
    if (!wrap) return;
    const measure = () => {
      const grid = gridRef.current;
      if (!grid) return;
      const cols = Math.max(
        1,
        getComputedStyle(grid).gridTemplateColumns.split(" ").filter(Boolean).length,
      );
      // 16 = grid wrap 的上下 padding 各 8px。
      const rows = Math.max(1, Math.floor((wrap.clientHeight - 16) / CARD_ROW_PX));
      const next = cols * rows;
      setPageSize((previous) => (previous === next ? previous : next));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(wrap);
    return () => observer.disconnect();
  }, []);

  // 換 tab 或換寵物（寵裝清單跟著變）時回到第一頁。
  useEffect(() => {
    setPage(0);
  }, [activeTab, petId]);

  // 目前寵物可穿的寵裝（petIds 含當前寵物 id）。
  const usableEquips = useMemo(
    () => equips.filter((equip) => equip.petIds.includes(Number(petId))),
    [equips, petId],
  );

  const pool: PetShopEntry[] = activeTab === "pet" ? pets : usableEquips;

  // 搜尋模式：在目前 tab 的清單內依模糊分數排序。
  const shown = useMemo(() => {
    const q = query.trim();
    if (!q) return pool;
    const scored: { item: PetShopEntry; score: number }[] = [];
    for (const item of pool) {
      const score = fuzzyScore(q, item.name, item.id);
      if (score != null) scored.push({ item, score });
    }
    scored.sort((a, b) => a.score - b.score);
    return scored.map((entry) => entry.item);
  }, [pool, query]);

  const totalPages = Math.max(1, Math.ceil(shown.length / pageSize));
  const currentPage = Math.min(page, totalPages - 1);
  const pageItems = shown.slice(currentPage * pageSize, currentPage * pageSize + pageSize);

  // 滾輪換頁：滾下=下一頁、滾上=上一頁（到頂/到底不動）。
  // React 的 onWheel 是 passive listener，無法 preventDefault，所以改綁原生 wheel 事件。
  useEffect(() => {
    const wrap = gridWrapRef.current;
    if (!wrap) return;
    const onWheel = (event: WheelEvent) => {
      if (totalPages <= 1) return;
      event.preventDefault();
      const step = event.deltaY > 0 ? 1 : -1;
      setPage((previous) =>
        Math.min(totalPages - 1, Math.max(0, Math.min(previous, totalPages - 1) + step)),
      );
    };
    wrap.addEventListener("wheel", onWheel, { passive: false });
    return () => wrap.removeEventListener("wheel", onWheel);
  }, [totalPages]);

  return (
    <section className="avatar-shop" aria-label={t("pet.shop.label")}>
      <div className="avatar-shop-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "pet"}
          className={activeTab === "pet" ? "is-active" : ""}
          onClick={() => setActiveTab("pet")}
        >
          {t("pet.shop.tabPets")}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "equip"}
          className={activeTab === "equip" ? "is-active" : ""}
          onClick={() => setActiveTab("equip")}
        >
          {t("pet.shop.tabEquips")}
        </button>
      </div>

      <div className="avatar-shop-search">
        <input
          type="search"
          value={query}
          placeholder={t("pet.shop.searchPlaceholder")}
          onChange={(event) => {
            setQuery(event.target.value);
            setPage(0);
          }}
        />
        {query.trim() ? (
          <>
            <span className="avatar-shop-search-count">
              {t("pet.shop.count", { count: shown.length })}
            </span>
            <button
              type="button"
              className="avatar-shop-search-clear"
              aria-label={t("common.clearSearch")}
              onClick={() => {
                setQuery("");
                setPage(0);
              }}
            >
              ×
            </button>
          </>
        ) : null}
      </div>

      <div className="avatar-shop-grid-wrap" ref={gridWrapRef}>
        {pageItems.length === 0 ? (
          <p className="avatar-shop-status">
            {query.trim()
              ? t("pet.shop.noMatch")
              : activeTab === "equip"
                ? t("pet.shop.noEquips")
                : t("pet.shop.noPets")}
          </p>
        ) : (
          <div className="avatar-shop-grid" ref={gridRef}>
            {pageItems.map((item) => {
              const worn = activeTab === "pet" ? item.id === petId : item.id === equipId;
              return (
                <PetShopCard
                  key={item.id}
                  item={item}
                  worn={worn}
                  onToggle={() => {
                    // 寵物 tab：點卡片切換寵物；寵裝 tab：點已穿的卡片脫下，否則穿上。
                    // 麵包屑跟著顯示該項目的 img 路徑。
                    if (activeTab === "pet") {
                      onSelectPet(item.id);
                      onPickItem?.(`Item/Pet/${item.id}`);
                    } else {
                      onToggleEquip(worn ? null : item.id);
                      onPickItem?.(`Character/PetEquip/${item.id}`);
                    }
                  }}
                />
              );
            })}
          </div>
        )}
      </div>

      {totalPages > 1 ? (
        <nav className="avatar-shop-pager" aria-label={t("pet.shop.pagination")}>
          <button
            type="button"
            disabled={currentPage === 0}
            onClick={() => setPage(currentPage - 1)}
          >
            &lt;
          </button>
          {pageNumbers(currentPage, totalPages).map((p, i) =>
            p === "…" ? (
              <span key={`ellipsis-${i}`} className="avatar-shop-pager-ellipsis">
                …
              </span>
            ) : (
              <button
                key={p}
                type="button"
                className={p === currentPage ? "is-active" : ""}
                onClick={() => setPage(p)}
              >
                {p + 1}
              </button>
            ),
          )}
          <button
            type="button"
            disabled={currentPage >= totalPages - 1}
            onClick={() => setPage(currentPage + 1)}
          >
            &gt;
          </button>
        </nav>
      ) : null}
    </section>
  );
}
