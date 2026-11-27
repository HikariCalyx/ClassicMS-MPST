import { createDatasetCache } from "../locale";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  getImage,
  getSkillBook,
  getSkillDetail,
  type SkillCategory,
  type SkillDetail,
  type SkillJobGroup,
} from "../api";
import { useI18n } from "../i18n";
import { loadClassicFrame } from "./classicFrame";
import {
  formatPropValue,
  HIDDEN_PROPS,
  jobLabel,
  jobMeta,
  jobSection,
  parseMapleText,
  propLabel,
  SECTION_ORDER,
  substituteProps,
  type PropValue,
} from "./skillJobs";

// 技能 icon 走既有的 get_image（Skill/<job>/skill/<id>/icon），整個 session 快取。
const iconCache = createDatasetCache<string, Promise<string | null>>();

function loadSkillIcon(job: string, id: string): Promise<string | null> {
  const key = `${job}/${id}`;
  let cached = iconCache.get(key);
  if (!cached) {
    cached = getImage(`Skill/${job}/skill/${id}/icon`)
      .then((result) => (result ? `data:image/png;base64,${result.base64}` : null))
      .catch(() => null);
    iconCache.set(key, cached);
  }
  return cached;
}

function SkillIcon({
  job,
  id,
  alt,
  className,
}: {
  job: string;
  id: string;
  alt: string;
  className?: string;
}) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void loadSkillIcon(job, id).then((url) => {
      if (active) setSrc(url);
    });
    return () => {
      active = false;
    };
  }, [job, id]);
  if (!src) return <span className={`skill-icon-empty${className ? ` ${className}` : ""}`} />;
  return <img className={className} src={src} alt={alt} draggable={false} />;
}

/** 等級快捷按鈕的候選值；超過最高等級的會被過濾。 */
const LEVEL_SHORTCUTS = [1, 10, 20, 30];

/**
 * 中欄技能視窗的分類區塊（順序即顯示順序）。區塊標題為 skill.category.<分類>，
 * 詳情面板的類別 chip 文字為 skill.categoryChip.<分類>。
 */
const CATEGORY_SECTIONS: SkillCategory[] = ["passive", "support", "active"];

/** 楓之谷字串逐行渲染（#c…# 片段用強調色）。 */
function MapleText({ raw, className }: { raw: string; className?: string }) {
  return (
    <div className={className}>
      {parseMapleText(raw).map((line, index) => (
        <p key={index}>
          {line.segments.length > 0
            ? line.segments.map((segment, segmentIndex) =>
                segment.accent ? (
                  <mark key={segmentIndex}>{segment.text}</mark>
                ) : (
                  <span key={segmentIndex}>{segment.text}</span>
                ),
              )
            : " "}
        </p>
      ))}
    </div>
  );
}

// 技能瀏覽器：左職業清單 / 中技能視窗（遊戲風格）/ 右技能詳情；第一次切到此頁才載入。
export function SkillBookPage({
  visible,
  onPickSkill,
}: {
  visible: boolean;
  /** 選取技能時回報節點路徑（給 App footer 麵包屑）。 */
  onPickSkill?: (path: string) => void;
}) {
  const { language, t } = useI18n();
  const [book, setBook] = useState<SkillJobGroup[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selectedJob, setSelectedJob] = useState<string | null>(null);
  const [selectedSkill, setSelectedSkill] = useState<string | null>(null);
  const [detail, setDetail] = useState<SkillDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [level, setLevel] = useState(1);
  const [hoveredSkill, setHoveredSkill] = useState<string | null>(null);
  const [frameUrl, setFrameUrl] = useState<string | null>(null);
  // 中欄技能圖示縮放倍率（Ctrl+滾輪調整，1 = 原始大小）。
  const [zoom, setZoom] = useState(1);
  const detailGenerationRef = useRef(0);
  const windowRef = useRef<HTMLElement | null>(null);

  // 經典視窗邊框（整個 session 只組一次；失敗時退回素色卡片）。
  useEffect(() => {
    let active = true;
    void loadClassicFrame().then((url) => {
      if (active) setFrameUrl(url);
    });
    return () => {
      active = false;
    };
  }, []);

  // Ctrl+滾輪縮放中欄圖示。React 的 onWheel 是 passive listener 無法
  // preventDefault（會跟頁面捲動打架），所以用原生 listener 掛 non-passive。
  // 元件保持掛載但視窗在資料載入後才出現，依 book 重新綁定。
  useEffect(() => {
    const element = windowRef.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      const step = event.deltaY < 0 ? 0.1 : -0.1;
      setZoom((current) =>
        Math.min(2.5, Math.max(0.6, Math.round((current + step) * 10) / 10)),
      );
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [book]);

  // 清單只載入一次（此元件掛載後保持不卸載）。
  useEffect(() => {
    let active = true;
    getSkillBook()
      .then((groups) => {
        if (!active) return;
        setBook(groups);
        if (groups.length > 0) {
          setSelectedJob((job) => job ?? groups[0].job);
          setSelectedSkill((skill) => skill ?? groups[0].skills[0]?.id ?? null);
        }
      })
      .catch((error: unknown) => {
        if (active) setLoadError(String(error));
      });
    return () => {
      active = false;
    };
  }, []);

  // 目前職業的技能清單。
  const currentGroup = useMemo(
    () => book?.find((group) => group.job === selectedJob) ?? null,
    [book, selectedJob],
  );

  // 全域搜尋：技能名稱或 id；結果是跨職業的平面清單。
  const searchResults = useMemo(() => {
    if (!book) return [];
    const keyword = query.trim().toLowerCase();
    if (!keyword) return null;
    const hits: { job: string; id: string; name: string | null }[] = [];
    for (const group of book) {
      for (const skill of group.skills) {
        if (
          skill.name?.toLowerCase().includes(keyword) ||
          skill.id.toLowerCase().includes(keyword)
        ) {
          hits.push({ job: group.job, id: skill.id, name: skill.name });
        }
      }
    }
    return hits;
  }, [book, query]);

  // 選取技能 → 載入明細（generation guard 防止舊回應蓋掉新選擇）。
  useEffect(() => {
    if (!selectedJob || !selectedSkill) return;
    const generation = ++detailGenerationRef.current;
    setDetailLoading(true);
    setDetailError(null);
    getSkillDetail(selectedJob, selectedSkill)
      .then((next) => {
        if (detailGenerationRef.current !== generation) return;
        setDetail(next);
        setLevel(next.maxLevel > 0 ? next.maxLevel : 1);
        onPickSkill?.(`Skill/${next.job}/skill/${next.id}`);
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
  }, [selectedJob, selectedSkill]);

  const pickSkill = (job: string, skillId: string) => {
    setSelectedJob(job);
    setSelectedSkill(skillId);
  };

  // 中欄的分類區塊：被動 / Buff・功能 / 主動，空區塊不顯示。
  const categorySections = useMemo(() => {
    if (!currentGroup) return [];
    return CATEGORY_SECTIONS.map((key) => ({
      key,
      skills: currentGroup.skills.filter((skill) => skill.category === key),
    })).filter((section) => section.skills.length > 0);
  }, [currentGroup]);

  // 選取技能的分類（給詳情面板 chip 用；summary 已有，不必再抓 detail）。
  const selectedCategory = useMemo(
    () => currentGroup?.skills.find((skill) => skill.id === selectedSkill)?.category ?? null,
    [currentGroup, selectedSkill],
  );

  // 目前等級的數值 props（給效果說明代入與數值表用）。
  const levelProps: Record<string, PropValue> = useMemo(() => {
    if (!detail) return {};
    return detail.levels[String(level)] ?? {};
  }, [detail, level]);

  // 效果說明：優先字串表寫好的 LevelDesc，沒有才用 H 模板代入數值。
  const effectText = useMemo(() => {
    if (!detail) return null;
    return (
      detail.levelDesc[String(level)] ??
      (detail.h ? substituteProps(detail.h, levelProps) : null)
    );
  }, [detail, level, levelProps]);

  // 數值表列（排除內部用 key，依介面語言的標籤排序讓表格穩定）。
  const statRows = useMemo(() => {
    return Object.entries(levelProps)
      .filter(([key]) => !HIDDEN_PROPS.has(key))
      .map(([key, value]) => ({
        key,
        label: propLabel(key, t),
        text: formatPropValue(key, value, t),
      }))
      .sort((a, b) => a.label.localeCompare(b.label, language));
  }, [levelProps, language, t]);

  // 技能視窗底部的狀態列：游標停留的技能優先，否則顯示選取的技能。
  const statusSkill = useMemo(() => {
    if (!currentGroup) return null;
    return (
      currentGroup.skills.find((skill) => skill.id === hoveredSkill) ??
      currentGroup.skills.find((skill) => skill.id === selectedSkill) ??
      null
    );
  }, [currentGroup, hoveredSkill, selectedSkill]);

  const selectedJobLabel = selectedJob ? jobLabel(selectedJob, t) : null;

  let content;
  // 中欄分類區塊的進場序號計數器（渲染時跨區塊累加）。
  let stagger = 0;
  if (loadError) {
    content = <p className="skill-page-status">{t("skill.loadFailed", { error: loadError })}</p>;
  } else if (!book) {
    content = <p className="skill-page-status">{t("skill.loading")}</p>;
  } else {
    content = (
      <>
        <aside className="skill-jobs">
          <div className="skill-search">
            <input
              type="search"
              value={query}
              placeholder={t("skill.search.placeholder")}
              aria-label={t("skill.search.label")}
              onChange={(event) => setQuery(event.target.value)}
            />
            {searchResults ? (
              <span className="skill-search-count">{searchResults.length}</span>
            ) : null}
          </div>
          <div className="skill-job-list">
            {searchResults ? (
              <>
                {searchResults.map((hit) => {
                  const active = hit.job === selectedJob && hit.id === selectedSkill;
                  return (
                    <button
                      key={`${hit.job}/${hit.id}`}
                      type="button"
                      className={`skill-search-hit${active ? " is-active" : ""}`}
                      onClick={() => pickSkill(hit.job, hit.id)}
                    >
                      <SkillIcon job={hit.job} id={hit.id} alt="" className="skill-search-icon" />
                      <span className="skill-search-name">{hit.name ?? hit.id}</span>
                      <span className="skill-search-job">{jobLabel(hit.job, t)}</span>
                    </button>
                  );
                })}
                {searchResults.length === 0 ? (
                  <p className="skill-list-empty">{t("skill.search.noResults", { query })}</p>
                ) : null}
              </>
            ) : (
              SECTION_ORDER.map((section) => {
                const groups = book.filter((group) => jobSection(group.job) === section);
                if (groups.length === 0) return null;
                return (
                  <section key={section} className="skill-job-group">
                    <h3>{t(`skill.section.${section}`)}</h3>
                    {groups.map((group) => {
                      const meta = jobMeta(group.job, t);
                      const active = group.job === selectedJob;
                      return (
                        <button
                          key={group.job}
                          type="button"
                          className={`skill-job-item${active ? " is-active" : ""}`}
                          onClick={() => {
                            setSelectedJob(group.job);
                            setSelectedSkill(group.skills[0]?.id ?? null);
                          }}
                        >
                          <span className="skill-job-name">{meta.name}</span>
                          {meta.tier ? <span className="skill-job-tier">{meta.tier}</span> : null}
                          <span className="skill-job-count">{group.skills.length}</span>
                        </button>
                      );
                    })}
                  </section>
                );
              })
            )}
          </div>
        </aside>

        <section
          ref={windowRef}
          className={`skill-window${frameUrl ? " has-frame" : ""}`}
          style={
            {
              "--skill-zoom": zoom,
              ...(frameUrl ? { borderImageSource: `url(${frameUrl})` } : {}),
            } as CSSProperties
          }
        >
          <div className="skill-window-title">
            <span>{selectedJobLabel ?? t("skill.window.title")}</span>
            <span className="skill-window-count">
              <button
                type="button"
                className="skill-zoom-reset"
                title={t("skill.window.zoomHint")}
                onClick={() => setZoom(1)}
              >
                {Math.round(zoom * 100)}%
              </button>
              {currentGroup ? t("skill.window.count", { count: currentGroup.skills.length }) : ""}
            </span>
          </div>
          {currentGroup && currentGroup.skills.length > 0 ? (
            <div className="skill-grid-scroll" key={selectedJob}>
              {categorySections.map((section) => {
                // 跨區塊連續的進場序號，讓 stagger 動畫一路往下接。
                const start = stagger;
                stagger += section.skills.length;
                const label = t(`skill.category.${section.key}`);
                return (
                  <section className="skill-cat" key={section.key}>
                    <h4>
                      {label}
                      <span>{section.skills.length}</span>
                    </h4>
                    <div className="skill-grid" role="listbox" aria-label={label}>
                      {section.skills.map((skill, index) => (
                        <button
                          key={skill.id}
                          type="button"
                          role="option"
                          aria-selected={skill.id === selectedSkill}
                          className={`skill-cell${skill.id === selectedSkill ? " is-active" : ""}`}
                          style={{
                            animationDelay: `${Math.min(start + index, 24) * 16}ms`,
                          }}
                          title={
                            skill.name
                              ? t("skill.window.cellTitle", {
                                  name: skill.name,
                                  level: skill.maxLevel,
                                })
                              : skill.id
                          }
                          onClick={() => pickSkill(currentGroup.job, skill.id)}
                          onMouseEnter={() => setHoveredSkill(skill.id)}
                          onMouseLeave={() => setHoveredSkill(null)}
                          onFocus={() => setHoveredSkill(skill.id)}
                          onBlur={() => setHoveredSkill(null)}
                        >
                          <SkillIcon
                            job={currentGroup.job}
                            id={skill.id}
                            alt={skill.name ?? skill.id}
                          />
                          <span className="skill-cell-level">{skill.maxLevel}</span>
                        </button>
                      ))}
                    </div>
                  </section>
                );
              })}
            </div>
          ) : (
            <p className="skill-window-empty">{t("skill.window.empty")}</p>
          )}
          <div className="skill-window-status" aria-live="polite">
            {statusSkill ? (
              <>
                <span className="skill-status-name">{statusSkill.name ?? statusSkill.id}</span>
                <span className="skill-status-meta">
                  {t("skill.maxLevel", { level: statusSkill.maxLevel })}
                </span>
              </>
            ) : (
              <span className="skill-status-meta">{t("skill.window.selectPrompt")}</span>
            )}
          </div>
        </section>

        <section className="skill-detail">
          {detailError ? (
            <p className="skill-page-status">{t("skill.loadFailed", { error: detailError })}</p>
          ) : !detail ? (
            <p className="skill-page-status">
              {detailLoading ? t("skill.loading") : t("skill.detail.selectPrompt")}
            </p>
          ) : (
            <div className="skill-detail-scroll">
              <header className="skill-hero">
                <div className="skill-hero-icon">
                  <SkillIcon job={detail.job} id={detail.id} alt={detail.name ?? detail.id} />
                </div>
                <div className="skill-hero-text">
                  <h2>{detail.name ?? t("common.unnamed")}</h2>
                  <p className="skill-hero-id">{detail.id}</p>
                  <div className="skill-hero-chips">
                    <span className="skill-chip is-level">
                      {t("skill.maxLevel", { level: detail.maxLevel })}
                    </span>
                    {selectedCategory ? (
                      <span className="skill-chip">
                        {t(`skill.categoryChip.${selectedCategory}`)}
                      </span>
                    ) : null}
                    {selectedJobLabel ? (
                      <span className="skill-chip">{selectedJobLabel}</span>
                    ) : null}
                  </div>
                </div>
              </header>

              {detail.maxLevel > 1 ? (
                <div className="skill-level-control">
                  <div className="skill-level-readout">
                    <span className="skill-level-label">{t("skill.detail.level")}</span>
                    <span className="skill-level-num" key={level}>
                      {level}
                    </span>
                    <span className="skill-level-max">/ {detail.maxLevel}</span>
                  </div>
                  <input
                    type="range"
                    min={1}
                    max={detail.maxLevel}
                    value={Math.min(level, detail.maxLevel)}
                    aria-label={t("skill.detail.levelSlider")}
                    onChange={(event) => setLevel(Number(event.target.value))}
                  />
                  <div className="skill-level-quick">
                    {LEVEL_SHORTCUTS.filter((value) => value <= detail.maxLevel).map((value) => (
                      <button
                        key={value}
                        type="button"
                        className={level === value ? "is-active" : ""}
                        onClick={() => setLevel(value)}
                      >
                        {value}
                      </button>
                    ))}
                    <button
                      type="button"
                      className={level === detail.maxLevel ? "is-active" : ""}
                      onClick={() => setLevel(detail.maxLevel)}
                    >
                      MAX
                    </button>
                  </div>
                </div>
              ) : null}

              {effectText ? (
                <section className="skill-effect" key={`effect-${level}`}>
                  <MapleText raw={effectText} className="skill-effect-text" />
                </section>
              ) : null}

              {detail.desc ? (
                <section className="skill-section">
                  <h3>{t("skill.detail.description")}</h3>
                  <MapleText raw={detail.desc} className="skill-desc" />
                </section>
              ) : null}

              {statRows.length > 0 ? (
                <section className="skill-section">
                  <h3>{t("skill.detail.stats", { level })}</h3>
                  <dl className="skill-stats" key={`stats-${level}`}>
                    {statRows.map((row) => (
                      <div key={row.key} className="skill-stat">
                        <dt>{row.label}</dt>
                        <dd>{row.text}</dd>
                      </div>
                    ))}
                  </dl>
                </section>
              ) : null}

              {detail.actions.length > 0 ? (
                <section className="skill-section">
                  <h3>{t("skill.detail.actionDelays")}</h3>
                  <div className="skill-delays">
                    {detail.actions.map((action) => (
                      <span key={action} className="skill-chip" title={action}>
                        {detail.actionDelays[action] != null
                          ? t("skill.detail.actionDelay", {
                              action,
                              delay: detail.actionDelays[action],
                            })
                          : action}
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
    <div className="skill-page" hidden={!visible}>
      {content}
    </div>
  );
}
