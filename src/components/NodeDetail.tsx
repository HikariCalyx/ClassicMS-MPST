import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  formatValue,
  getAudio,
  getImage,
  getItemTooltip,
  getNode,
  type ItemTooltip as ItemTooltipData,
  type NodeDetail as Detail,
  type Value,
} from "../api";
import { ImagePreview } from "./ImagePreview";
import { ItemTooltip } from "./ItemTooltip";
import { CommodityShop } from "./CommodityShop";
import { createDatasetCache, getActiveLocale, onDatasetChange } from "../locale";
import { useI18n } from "../i18n";

interface NodeDetailProps {
  path: string | null;
  emptyMode?: "selection" | "category";
}

type ImageState = "idle" | "loading" | "none" | "error";

interface SkillStringInfo {
  name: string | null;
  desc: string | null;
  levelDesc: string | null;
}

type SkillStringTable = Record<
  string,
  { Name?: string; Desc?: string; LevelDesc?: Record<string, string> }
>;

// String/<locale>/Skill 是大型 TextAsset JSON（技能 id → {Name, Desc, ...}），
// 解析一次後整個 session 共用；切換語系時作廢重載。
let skillStringsPromise: Promise<SkillStringTable> | null = null;
onDatasetChange(() => {
  skillStringsPromise = null;
});

function loadSkillStrings(): Promise<SkillStringTable> {
  if (!skillStringsPromise) {
    skillStringsPromise = getNode(`String/${getActiveLocale()}/Skill`).then((node) => {
      try {
        return JSON.parse((node.text_asset ?? "{}").trimStart()) as SkillStringTable;
      } catch {
        return {};
      }
    });
  }
  return skillStringsPromise;
}

// 僅在路徑剛好是技能代碼節點（Skill/<職業>/skill/<技能id>）時回傳技能 id。
function skillIdFromPath(path: string): string | null {
  const segments = path.split("/");
  if (
    segments.length === 4 &&
    segments[0] === "Skill" &&
    segments[2] === "skill" &&
    /^\d+$/.test(segments[3])
  ) {
    return segments[3];
  }
  return null;
}

// LevelDesc 是 {等級: 說明} 的物件，攤平成「Lv.1 …」逐行文字，等級由小到大排序。
function formatLevelDesc(
  levelDesc: Record<string, string> | undefined,
): string | null {
  if (!levelDesc) return null;
  const lines = Object.entries(levelDesc)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([level, text]) => `Lv.${level} ${text}`);
  return lines.length > 0 ? lines.join("\n") : null;
}

interface SkillDelayInfo {
  action: string;
  totalDelay: number | null; // null = Character/00002000 查無此動作
}

// 從節點值取字串（action 一般是 Str，少數是 Uol 連結）。
function stringValue(v: Value): string | null {
  return v.type === "Str" || v.type === "Uol" ? v.value : null;
}

// 從節點值取數字（delay 一般是 Int）。
function numericValue(v: Value): number | null {
  switch (v.type) {
    case "U8":
    case "U16":
    case "Int":
    case "Long":
    case "Double":
      return v.value;
    default:
      return null;
  }
}

// Character/00002000/<動作>/<影格>/delay 的 |delay| 加總；同一動作整個 session 只抓一次。
const actionDelayCache = createDatasetCache<string, Promise<number | null>>();

function loadActionDelay(action: string): Promise<number | null> {
  let cached = actionDelayCache.get(action);
  if (!cached) {
    cached = (async () => {
      try {
        const actionNode = await getNode(`Character/00002000/${action}`);
        const frames = actionNode.children
          .map(([name]) => name)
          .filter((name) => /^\d+$/.test(name));
        const delays = await Promise.all(
          frames.map((frame) =>
            getNode(`Character/00002000/${action}/${frame}/delay`)
              .then((node) => numericValue(node.value) ?? 0)
              .catch(() => 0),
          ),
        );
        return delays.reduce((sum, d) => sum + Math.abs(d), 0);
      } catch {
        return null;
      }
    })();
    actionDelayCache.set(action, cached);
  }
  return cached;
}

// 技能的 action 節點：可能是字串值，或是子節點（0/1/...）各指一個動作名；取第一個。
async function findSkillAction(skillPath: string): Promise<string | null> {
  const actionNode = await getNode(`${skillPath}/action`).catch(() => null);
  if (!actionNode) return null;
  const direct = stringValue(actionNode.value);
  if (direct) return direct;
  for (const [name] of actionNode.children) {
    const child = await getNode(`${skillPath}/action/${name}`).catch(() => null);
    const value = child ? stringValue(child.value) : null;
    if (value) return value;
  }
  return null;
}

// 唯讀 textarea，高度依內容自動撐開，不需要捲動或手動拖曳。
function AutoTextarea({ value }: { value: string }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);
  return <textarea ref={ref} readOnly spellCheck={false} value={value} />;
}

// TextAsset 檢視器：高度撐到 .app-right 可視區底部，並支援 Ctrl+F 在內容裡搜尋
// （Enter 下一筆、Shift+Enter 上一筆、Esc 關閉，命中筆會選取並捲到可視範圍）。
export function TextAssetCard({ text }: { text: string }) {
  const { t } = useI18n();
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const findInputRef = useRef<HTMLInputElement>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [matchIndex, setMatchIndex] = useState(0);

  // 讓 textarea 底端對齊 .app-right 可視區底部（扣掉 12px padding），視窗縮放時重算。
  useLayoutEffect(() => {
    const el = areaRef.current;
    const container = el?.closest(".app-right");
    if (!el || !container) return;
    const apply = () => {
      const cRect = container.getBoundingClientRect();
      const tRect = el.getBoundingClientRect();
      const docTop = tRect.top - cRect.top + container.scrollTop;
      const avail = container.clientHeight - docTop - 12;
      el.style.height = `${Math.max(300, avail)}px`;
    };
    apply();
    window.addEventListener("resize", apply);
    return () => window.removeEventListener("resize", apply);
  }, [text]);

  const matches = useMemo(() => {
    if (!query) return [] as number[];
    const haystack = text.toLowerCase();
    const needle = query.toLowerCase();
    const out: number[] = [];
    let i = haystack.indexOf(needle);
    while (i !== -1) {
      out.push(i);
      i = haystack.indexOf(needle, i + 1);
    }
    return out;
  }, [text, query]);

  const jumpTo = useCallback(
    (index: number, list: number[], focusArea: boolean) => {
      const el = areaRef.current;
      if (!el || list.length === 0) return;
      const n = ((index % list.length) + list.length) % list.length;
      setMatchIndex(n);
      const start = list[n];
      if (focusArea) el.focus();
      el.setSelectionRange(start, start + query.length);
      // 捲到命中位置：垂直依行號置中，水平依等寬字元寬推算。
      const style = getComputedStyle(el);
      const lineHeight = parseFloat(style.lineHeight) || 16;
      const before = text.slice(0, start);
      const line = (before.match(/\n/g) ?? []).length;
      el.scrollTop = Math.max(0, line * lineHeight - el.clientHeight / 3);
      const col = before.length - before.lastIndexOf("\n") - 1;
      const ctx = document.createElement("canvas").getContext("2d");
      if (ctx) {
        ctx.font = style.font;
        const charWidth = ctx.measureText("M").width;
        el.scrollLeft = Math.max(0, col * charWidth - el.clientWidth / 3);
      }
    },
    [text, query],
  );

  // 輸入關鍵字時跳到選取位置之後的第一筆（沒有就回第一筆）。
  useEffect(() => {
    if (!findOpen || matches.length === 0) {
      setMatchIndex(0);
      return;
    }
    const selStart = areaRef.current?.selectionStart ?? 0;
    const idx = matches.findIndex((m) => m >= selStart);
    jumpTo(idx === -1 ? 0 : idx, matches, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matches, findOpen]);

  const openFind = useCallback(() => {
    setFindOpen(true);
    requestAnimationFrame(() => {
      findInputRef.current?.focus();
      findInputRef.current?.select();
    });
  }, []);

  const closeFind = useCallback(() => {
    setFindOpen(false);
    areaRef.current?.focus();
  }, []);

  return (
    <section className="editor-card text-editor-card">
      <header className="editor-card-heading">
        <div>
          <strong>TextAsset</strong>
        </div>
        {findOpen ? (
          <div className="text-find-bar">
            <input
              ref={findInputRef}
              type="text"
              placeholder={t("browse.textFind.placeholder")}
              spellCheck={false}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  jumpTo(matchIndex + (e.shiftKey ? -1 : 1), matches, false);
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  closeFind();
                }
              }}
            />
            <span className="text-find-count">
              {query ? `${matches.length > 0 ? matchIndex + 1 : 0} / ${matches.length}` : ""}
            </span>
            <button
              type="button"
              title={t("browse.textFind.previous")}
              disabled={matches.length === 0}
              onClick={() => jumpTo(matchIndex - 1, matches, false)}
            >
              ↑
            </button>
            <button
              type="button"
              title={t("browse.textFind.next")}
              disabled={matches.length === 0}
              onClick={() => jumpTo(matchIndex + 1, matches, false)}
            >
              ↓
            </button>
            <button type="button" title={t("browse.textFind.close")} onClick={closeFind}>
              ✕
            </button>
          </div>
        ) : (
          <button type="button" className="find-hint" onClick={openFind}>
            {t("browse.textFind.open")}
          </button>
        )}
      </header>
      <textarea
        ref={areaRef}
        className="text-asset-editor"
        readOnly
        spellCheck={false}
        value={text}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
            e.preventDefault();
            openFind();
          }
        }}
      />
    </section>
  );
}

// AudioClip（type 83）：點開才向後端取 Ogg Vorbis，轉 blob URL 播放，卸載時釋放。
function AudioPlayer({ path }: { path: string }) {
  const { t } = useI18n();
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    let objectUrl: string | null = null;
    setLoading(true);
    setError(null);
    setUrl(null);
    getAudio(path)
      .then((result) => {
        if (!active) return;
        const bytes = Uint8Array.from(atob(result.base64), (c) => c.charCodeAt(0));
        objectUrl = URL.createObjectURL(new Blob([bytes], { type: "audio/ogg" }));
        setUrl(objectUrl);
      })
      .catch((nextError) => {
        if (active) setError(String(nextError));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [path]);

  if (loading) return <p>{t("browse.audio.loading")}</p>;
  if (error) return <p className="error">{error}</p>;
  if (!url) return null;
  return <audio controls preload="auto" src={url} style={{ width: "100%" }} />;
}

export function NodeDetail({
  path,
  emptyMode = "selection",
}: NodeDetailProps) {
  const { t } = useI18n();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [imgUrl, setImgUrl] = useState<string | null>(null);
  const [imgState, setImgState] = useState<ImageState>("idle");
  const [imgMode, setImgMode] = useState<"exact" | "atlas">("exact");
  const [imgNote, setImgNote] = useState<string | null>(null);
  const [tooltip, setTooltip] = useState<ItemTooltipData | null>(null);
  const [skillInfo, setSkillInfo] = useState<SkillStringInfo | null>(null);
  const [skillDelay, setSkillDelay] = useState<SkillDelayInfo | null>(null);

  // 技能延遲：技能代碼節點的 action → Character/00002000 對應動作的影格 delay 加總。
  useEffect(() => {
    const skillId = path ? skillIdFromPath(path) : null;
    if (!path || !skillId) {
      setSkillDelay(null);
      return;
    }
    let active = true;
    findSkillAction(path)
      .then(async (action) => {
        if (!action) {
          if (active) setSkillDelay(null);
          return;
        }
        const totalDelay = await loadActionDelay(action);
        if (active) setSkillDelay({ action, totalDelay });
      })
      .catch(() => {
        if (active) setSkillDelay(null);
      });
    return () => {
      active = false;
    };
  }, [path]);

  // 技能名稱/描述：路徑剛好是技能代碼節點時，查目前語系的技能名稱表。
  useEffect(() => {
    const skillId = path ? skillIdFromPath(path) : null;
    if (!skillId) {
      setSkillInfo(null);
      return;
    }
    let active = true;
    loadSkillStrings()
      .then((table) => {
        if (!active) return;
        // Skill img 的 id 可能補零（如 10000012），字串表的鍵沒有 → 兩種都試
        const stripped = skillId.replace(/^0+/, "");
        const entry = table[skillId] ?? (stripped ? table[stripped] : undefined);
        setSkillInfo(
          entry
            ? {
                name: entry.Name ?? null,
                desc: entry.Desc ?? null,
                levelDesc: formatLevelDesc(entry.LevelDesc),
              }
            : null,
        );
      })
      .catch(() => {
        if (active) setSkillInfo(null);
      });
    return () => {
      active = false;
    };
  }, [path]);

  // 裝備 tooltip：路徑落在 Character 裝備 img 內時由後端聚合回傳，否則為 null。
  useEffect(() => {
    if (!path) {
      setTooltip(null);
      return;
    }
    let active = true;
    getItemTooltip(path)
      .then((details) => {
        if (active) setTooltip(details);
      })
      .catch(() => {
        if (active) setTooltip(null);
      });
    return () => {
      active = false;
    };
  }, [path]);

  useEffect(() => {
    if (!path) {
      setDetail(null);
      setError(null);
      setLoading(false);
      return;
    }

    let active = true;
    setLoading(true);
    setError(null);
    setDetail(null);
    getNode(path)
      .then((nextDetail) => {
        if (active) setDetail(nextDetail);
      })
      .catch((nextError) => {
        if (!active) return;
        setDetail(null);
        setError(String(nextError));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [path]);

  useEffect(() => {
    if (
      !path ||
      !detail ||
      detail.path !== path ||
      (detail.value.type !== "Canvas" && detail.value.type !== "Uol")
    ) {
      setImgUrl(null);
      setImgState("idle");
      setImgMode("exact");
      setImgNote(null);
      return;
    }

    let active = true;
    setImgUrl(null);
    setImgState("loading");
    setImgMode("exact");
    setImgNote(null);
    getImage(path)
      .then((preview) => {
        if (!active) return;
        if (preview) {
          setImgUrl(`data:image/png;base64,${preview.base64}`);
          setImgMode(preview.mode);
          setImgNote(preview.note ?? null);
          setImgState("idle");
        } else {
          setImgState("none");
        }
      })
      .catch((nextError) => {
        if (!active) return;
        setImgUrl(null);
        setImgNote(String(nextError));
        setImgState("error");
      });
    return () => {
      active = false;
    };
  }, [detail, path]);

  if (!path) {
    if (emptyMode === "category") {
      return (
        <div className="detail-empty is-category">
          <span className="detail-empty-icon" aria-hidden="true">▣</span>
          <strong>{t("browse.detail.categoryTitle")}</strong>
          <p>{t("browse.detail.categoryHint")}</p>
        </div>
      );
    }
    return (
      <div className="detail-empty">
        <span className="detail-empty-icon" aria-hidden="true">◇</span>
        <strong>{t("browse.detail.emptyTitle")}</strong>
        <p>{t("browse.detail.emptyHint")}</p>
      </div>
    );
  }
  if (loading && !detail) return <div className="detail-empty">{t("browse.detail.loading")}</div>;
  if (error) return <div className="detail-empty error">{error}</div>;
  if (!detail) return null;

  const isImageCapable = detail.value.type === "Canvas" || detail.value.type === "Uol";
  const showPreview = Boolean(imgUrl) || isImageCapable;
  // SubTree 只有子節點、Canvas 由圖片預覽呈現，其餘型別在標題下顯示節點值。
  const showValue = detail.value.type !== "SubTree" && detail.value.type !== "Canvas";

  return (
    <article className="node-detail-panel">
      <header className="detail-header">
        <div className="detail-heading">
          <p>{t("browse.detail.heading")}</p>
          <input readOnly value={detail.name} title={detail.name} />
        </div>
        <div className="detail-actions">
          <span className="readonly-badge">{t("browse.detail.readOnly")}</span>
        </div>
      </header>

      {showValue ? (
        <div className="detail-heading">
          <p>{t("browse.detail.value")}</p>
          <input readOnly value={formatValue(detail.value)} title={formatValue(detail.value)} />
        </div>
      ) : null}

      <div className={`detail-workspace${showPreview ? " has-preview" : ""}`}>
        {showPreview ? (
          <ImagePreview
            alt={detail.name}
            errorMessage={imgState === "error" ? imgNote : null}
            imageUrl={imgUrl}
            loading={imgState === "loading"}
            mode={imgMode}
            note={imgNote}
          />
        ) : null}

        <div className="detail-editor-stack">
          {tooltip ? <ItemTooltip details={tooltip} /> : null}

          {skillDelay ? (
            <section className="editor-card skill-delay-card">
              <header className="editor-card-heading">
                <div>
                  <strong>{t("browse.skillDelay.title")}</strong>
                </div>
              </header>
              <div className="node-editor-form">
                <label>
                  <span>{t("browse.skillDelay.action")}</span>
                  <input readOnly value={skillDelay.action} />
                </label>
                <label>
                  <span>{t("browse.skillDelay.total")}</span>
                  <input
                    readOnly
                    value={
                      skillDelay.totalDelay != null
                        ? `${skillDelay.totalDelay} ms`
                        : t("browse.skillDelay.noAction")
                    }
                  />
                </label>
              </div>
            </section>
          ) : null}

          {skillInfo ? (
            <section className="editor-card skill-info-card">
              <header className="editor-card-heading">
                <div>
                  <strong>{t("browse.skillInfo.title")}</strong>
                </div>
              </header>
              <div className="node-editor-form">
                <label className="is-wide">
                  <span>{t("browse.skillInfo.name")}</span>
                  <input readOnly value={skillInfo.name ?? t("browse.skillInfo.noName")} />
                </label>
                <label className="is-wide">
                  <span>{t("browse.skillInfo.desc")}</span>
                  <AutoTextarea value={skillInfo.desc ?? t("browse.skillInfo.noDesc")} />
                </label>
                {skillInfo.levelDesc ? (
                  <label className="is-wide">
                    <span>{t("browse.skillInfo.levelDesc")}</span>
                    <AutoTextarea value={skillInfo.levelDesc} />
                  </label>
                ) : null}
              </div>
            </section>
          ) : null}

          {detail.type_tag === 83 ? (
            <section className="editor-card audio-player-card">
              <header className="editor-card-heading">
                <div>
                  <strong>{t("browse.audio.title")}</strong>
                </div>
              </header>
              <AudioPlayer path={detail.path} />
            </section>
          ) : null}

          {detail.text_asset != null ? (
            detail.path === `Etc/${getActiveLocale()}/Commodity` ? (
              <CommodityShop key={detail.path} text={detail.text_asset} />
            ) : (
              <TextAssetCard key={detail.path} text={detail.text_asset} />
            )
          ) : null}

        </div>
      </div>
    </article>
  );
}
