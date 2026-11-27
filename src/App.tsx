import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import { Cloud, Folder, FolderSync, Languages, Moon, Sun } from "lucide-react";
import {
  getAudio,
  getDataSource,
  initialDataDir,
  initialPath,
  initialView,
  listChildren,
  onProgress,
  openDataDir,
  pickDataDirectory,
  reconnectDataDirectory,
  setDataSource,
  setRegion,
  setWindowTitle,
  storedFolderLabel,
  supportsDataSourceSwitch,
  typeLabel,
  type ChildEntry,
  type DataSource,
  type ImportProgress,
  type OpenInfo,
  type OpenResult,
} from "./api";
import { AvatarPage } from "./components/AvatarPage";
import { PetAvatarPage } from "./components/PetAvatarPage";
import { ExportMenu } from "./components/ExportMenu";
import { ChangelogDialog } from "./components/ChangelogDialog";
import { MonsterBookPage } from "./components/MonsterBookPage";
import { SkillBookPage } from "./components/SkillBookPage";
import { QuestPage } from "./components/QuestPage";
import { SoundPage } from "./components/SoundPage";
import { NodeDetail } from "./components/NodeDetail";
import { SearchBar } from "./components/SearchBar";
import { TreeView } from "./components/TreeView";
import { useTheme } from "./useTheme";
import { activateDatasetLocale } from "./locale";
import { LANGUAGES, isLanguage, setLanguage, t, useI18n, type TFunction } from "./i18n";
import { version as APP_VERSION } from "../package.json";

const MIN_TREE_WIDTH = 240;
const DEFAULT_TREE_WIDTH = 380;
const AVATAR_BGM_ON_KEY = "msclassic.avatarBgm.on";
const AVATAR_BGM_VOLUME_KEY = "msclassic.avatarBgm.volume";

// 資料來源切換（hosted 版限定）：true 時 header 顯示「雲端資料 / 本機資料夾」切換器。
const CAN_SWITCH_DATA_SOURCE = supportsDataSourceSwitch();
// 切到雲端時 loadDataDirectory 的 path 參數僅用於狀態列訊息（hosted openDataDir 會忽略）。
const cloudSourceLabel = () => t("app.source.cloud");

function initialTreeWidth(): number {
  const saved = Number(window.localStorage.getItem("msclassic.treePaneWidth"));
  return Number.isFinite(saved) && saved >= MIN_TREE_WIDTH ? saved : DEFAULT_TREE_WIDTH;
}

function initialAvatarBgmOn(): boolean {
  return window.localStorage.getItem(AVATAR_BGM_ON_KEY) !== "0";
}

function initialAvatarBgmVolume(): number {
  const saved = window.localStorage.getItem(AVATAR_BGM_VOLUME_KEY);
  if (saved === null) return 0.5;
  const volume = Number(saved);
  return Number.isFinite(volume) && volume >= 0 && volume <= 1 ? volume : 0.5;
}

function findLoadedEntry(childrenMap: Map<string, ChildEntry[]>, path: string): ChildEntry | null {
  for (const children of childrenMap.values()) {
    const entry = children.find((candidate) => candidate.path === path);
    if (entry) return entry;
  }
  return null;
}

function selectedTypeLabel(entry: ChildEntry | null): string {
  if (!entry) return "";
  if (entry.kind === "Category") return "Folder";
  if (entry.kind === "Node") return typeLabel(entry.type_tag);
  switch (entry.class_id) {
    case 49:
      return "TextAsset";
    case 83:
      return "AudioClip";
    case 114:
      return "MonoBehaviour";
    default:
      return entry.class_id > 0 ? `Unity Class ${entry.class_id}` : "Asset";
  }
}

function statusFor(result: OpenResult): string {
  const params = {
    dir: result.data_dir,
    assets: result.info.entry_count.toLocaleString(),
    bundles: result.info.bundle_count,
    ms: result.info.elapsed_ms,
  };
  if (result.info.elapsed_ms <= 0) return t("app.status.opened", params);
  return result.info.from_cache
    ? t("app.status.openedFromCache", params)
    : t("app.status.openedRebuilt", params);
}

/** web 版匯入進度（OPFS 複製 / 索引建立）的訊息文字。 */
function progressMessage(progress: ImportProgress, translate: TFunction): string {
  switch (progress.stage) {
    case "loadingIndex":
      return translate("data.progress.loadingIndex");
    case "unchanged":
      return translate("data.progress.unchanged");
    case "copying":
      return translate("data.progress.copying", {
        index: progress.fileIndex ?? 0,
        total: progress.fileCount ?? 0,
        file: progress.file ?? "",
      });
    case "buildingIndex":
      return translate("data.progress.buildingIndex");
  }
}

export default function App() {
  const { language, t } = useI18n();
  const { theme, toggleTheme } = useTheme();
  const [childrenMap, setChildrenMap] = useState<Map<string, ChildEntry[]>>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<ChildEntry | null>(null);
  const [openInfo, setOpenInfo] = useState<OpenInfo | null>(null);
  // 作用中語系代碼與遞增鍵：資料集含多個語系時，切換語系要讓各檢視重新載入。
  const [localeNonce, setLocaleNonce] = useState(0);
  // 資料來源（hosted 版才有切換器；偏好存 localStorage，預設本機資料夾）。
  const [dataSource, setDataSourceState] = useState<DataSource>(() => getDataSource());
  const [, setDataDir] = useState<string | null>(null);
  const [dataError, setDataError] = useState<string | null>(null);
  const [loadingData, setLoadingData] = useState(false);
  const [status, setStatus] = useState(() => t("app.status.chooseFolder"));
  const [toast, setToast] = useState<{ message: string; tone: "success" | "error" } | null>(null);
  const [importProgress, setImportProgress] = useState<ImportProgress | null>(null);
  const [treeWidth, setTreeWidth] = useState(initialTreeWidth);
  const [resizingTree, setResizingTree] = useState(false);
  const [showChangelog, setShowChangelog] = useState(false);
  // 頂部 view 切換：瀏覽（資產樹）/ 紙娃娃（角色試穿）/ 寵物（寵物試穿）/ 怪物圖鑑 / 技能 / 任務 / 音樂。
  const [view, setView] = useState<"tree" | "avatar" | "pet" | "monster" | "skill" | "quest" | "sound">(
    "tree",
  );
  // 紙娃娃第一次切過去才掛載（meta/equipment 此時才載入），之後保持掛載不重置狀態。
  const [avatarActivated, setAvatarActivated] = useState(false);
  // 寵物紙娃娃同樣 lazy-mount（第一次切過去才載入寵物/寵裝清單）。
  const [petAvatarActivated, setPetAvatarActivated] = useState(false);
  // 怪物圖鑑同樣 lazy-mount（第一次切過去才載入圖鑑清單）。
  const [monsterActivated, setMonsterActivated] = useState(false);
  // 技能瀏覽器同樣 lazy-mount（第一次切過去才載入技能書）。
  const [skillActivated, setSkillActivated] = useState(false);
  // 任務資料庫同樣 lazy-mount（第一次切過去才載入任務清單）。
  const [questActivated, setQuestActivated] = useState(false);
  // 音樂播放器同樣 lazy-mount；保持掛載讓切 tab 時音樂繼續播。
  const [soundActivated, setSoundActivated] = useState(false);
  // 紙娃娃商店的「點裝」開關：ON 時只列 cash 裝備（App 持有，切 view 不重置）。
  const [cashOnly, setCashOnly] = useState(false);
  // 紙娃娃 BGM：記住上次播放／暫停及音量；首次開啟維持原本的播放、50% 音量。
  const [bgmOn, setBgmOn] = useState(initialAvatarBgmOn);
  const [bgmVolume, setBgmVolume] = useState(initialAvatarBgmVolume);
  const bgmAudioRef = useRef<HTMLAudioElement | null>(null);
  const bgmUrlRef = useRef<string | null>(null);
  const bgmVolumeRef = useRef(bgmVolume);
  // 紙娃娃/寵物頁最後點選的裝備 img 路徑（footer 麵包屑用）。
  const [avatarPick, setAvatarPick] = useState<string | null>(null);
  // 怪物圖鑑最後選取的圖鑑路徑（footer 麵包屑用）。
  const [mobPick, setMobPick] = useState<string | null>(null);
  // 任務頁掉落來源彈窗點怪物時的跨頁跳轉請求（nonce 讓同 id 可重複觸發）。
  const [mobJump, setMobJump] = useState<{ mobId: number; nonce: number } | null>(null);
  // 技能瀏覽器最後選取的技能路徑（footer 麵包屑用）。
  const [skillPick, setSkillPick] = useState<string | null>(null);
  // 任務資料庫最後選取的任務路徑（footer 麵包屑用）。
  const [questPick, setQuestPick] = useState<string | null>(null);
  // 音樂播放器目前播放的曲目路徑（footer 麵包屑用）。
  const [soundPick, setSoundPick] = useState<string | null>(null);
  const treeWidthRef = useRef(treeWidth);
  const childrenMapRef = useRef(childrenMap);
  const childRequestsRef = useRef(new Map<string, Promise<void>>());
  const navigationGenerationRef = useRef(0);
  const datasetGenerationRef = useRef(0);
  const initialTargetRequestRef = useRef<Promise<string | null> | null>(null);

  const storeChildren = useCallback((path: string, children: ChildEntry[]) => {
    const next = new Map(childrenMapRef.current).set(path, children);
    childrenMapRef.current = next;
    setChildrenMap(next);
  }, []);

  // 切到怪物圖鑑並選取指定怪物（任務頁掉落來源彈窗的跳轉）。
  const openMobInBook = useCallback((mobId: number) => {
    setView("monster");
    setMonsterActivated(true);
    setMobJump({ mobId, nonce: Date.now() });
  }, []);

  const clearMobJump = useCallback(() => setMobJump(null), []);

  // 紙娃娃 BGM：view 切到 avatar 且未手動暫停時播放（單曲循環），離開或暫停時停下。
  // AudioClip 內容是 Ogg Vorbis；blob URL 與 <audio> 元素只做一次，暫停會保留播放位置。
  useEffect(() => {
    if (view !== "avatar" || !bgmOn) {
      bgmAudioRef.current?.pause();
      return;
    }
    let cancelled = false;
    const play = async () => {
      try {
        if (!bgmUrlRef.current) {
          const result = await getAudio("Sound/BgmUI/ShopBgm");
          const bytes = Uint8Array.from(atob(result.base64), (c) => c.charCodeAt(0));
          bgmUrlRef.current = URL.createObjectURL(new Blob([bytes], { type: "audio/ogg" }));
        }
        if (cancelled) return;
        if (!bgmAudioRef.current) {
          const audio = new Audio(bgmUrlRef.current);
          audio.loop = true;
          audio.volume = bgmVolumeRef.current;
          bgmAudioRef.current = audio;
        }
        await bgmAudioRef.current.play();
      } catch (error) {
        if (!cancelled) setStatus(t("app.bgm.playFailed", { error: String(error) }));
      }
    };
    void play();
    return () => {
      cancelled = true;
    };
    // t 只用在錯誤訊息，切換語言不必重播背景音樂。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, bgmOn]);

  useEffect(() => {
    window.localStorage.setItem(AVATAR_BGM_ON_KEY, bgmOn ? "1" : "0");
  }, [bgmOn]);

  // 音量拉桿即時套用到已建立的 <audio>；元素尚未建立時只更新 ref，建立時再讀取。
  useEffect(() => {
    bgmVolumeRef.current = bgmVolume;
    const audio = bgmAudioRef.current;
    if (audio) audio.volume = bgmVolume;
    window.localStorage.setItem(AVATAR_BGM_VOLUME_KEY, String(bgmVolume));
  }, [bgmVolume]);

  const loadDataDirectory = useCallback(async (path: string) => {
    const generation = ++datasetGenerationRef.current;
    navigationGenerationRef.current += 1;
    childRequestsRef.current.clear();
    setLoadingData(true);
    setDataError(null);
    setStatus(t("app.status.opening", { path }));

    try {
      const result = await openDataDir(path);
      if (generation !== datasetGenerationRef.current) return;
      const initialChildren = new Map([["", result.top]]);
      childrenMapRef.current = initialChildren;
      initialTargetRequestRef.current = null;
      setChildrenMap(initialChildren);
      setExpanded(new Set());
      setSelected(null);
      setOpenInfo(result.info);
      activateDatasetLocale(result.info.locale);
      setLocaleNonce((nonce) => nonce + 1);
      setDataDir(result.data_dir);
      setStatus(statusFor(result));
    } catch (error) {
      if (generation !== datasetGenerationRef.current) return;
      const message = String(error);
      setDataError(message);
      setStatus(t("app.status.openFailed", { error: message }));
    } finally {
      if (generation === datasetGenerationRef.current) setLoadingData(false);
    }
  }, []);

  const chooseDataDirectory = useCallback(async () => {
    try {
      const selectedPath = await pickDataDirectory();
      if (typeof selectedPath === "string") {
        await loadDataDirectory(selectedPath);
      }
    } catch (error) {
      const message = String(error);
      setDataError(message);
      setStatus(t("app.status.pickerFailed", { error: message }));
    }
  }, [loadDataDirectory]);

  // web 版「記住資料夾」：有記錄時歡迎頁提供一鍵重新連線（桌面版恆 null 不顯示）。
  const [reconnectLabel, setReconnectLabel] = useState<string | null>(null);

  const reconnectStoredFolder = useCallback(async () => {
    try {
      const label = await reconnectDataDirectory();
      if (typeof label === "string") {
        setReconnectLabel(label);
        await loadDataDirectory(label);
      }
    } catch (error) {
      const message = String(error);
      setDataError(message);
      setStatus(t("app.status.reconnectFailed", { error: message }));
    }
  }, [loadDataDirectory]);

  // 來源切換器（hosted 版）：切到雲端 = 重新載入託管資料集。
  const switchToCloud = useCallback(async () => {
    if (dataSource === "cloud" || loadingData) return;
    setDataSource("cloud");
    setDataSourceState("cloud");
    await loadDataDirectory(cloudSourceLabel());
  }, [dataSource, loadingData, loadDataDirectory]);

  // 來源切換器（hosted 版）：切到本機 = 有記住的資料夾則重連，否則跳選擇器；
  // 使用者取消選擇時回復雲端模式，避免切過去卻沒資料的空狀態。
  const switchToLocal = useCallback(async () => {
    if (dataSource === "local" || loadingData) return;
    // 先切模式，api 委派層才會把 reconnect/pick 打到本機後端。
    setDataSource("local");
    try {
      const label = (await reconnectDataDirectory()) ?? (await pickDataDirectory());
      if (!label) {
        setDataSource("cloud");
        return;
      }
      setDataSourceState("local");
      await loadDataDirectory(label);
    } catch (error) {
      setDataSource("cloud");
      const message = String(error);
      setDataError(message);
      setStatus(t("app.status.switchLocalFailed", { error: message }));
    }
  }, [dataSource, loadingData, loadDataDirectory]);

  // 語系切換（資料集含多個語系時）：切後端作用語系 → 更新前端共用語系 →
  // 遞增 localeNonce 讓資料檢視重新掛載、以新語系重載名稱／字串。
  const changeRegion = useCallback(
    async (code: string) => {
      if (loadingData || !openInfo || code === openInfo.locale) return;
      const generation = datasetGenerationRef.current;
      setLoadingData(true);
      try {
        await setRegion(code);
        if (generation !== datasetGenerationRef.current) return;
        setOpenInfo({ ...openInfo, locale: code });
        activateDatasetLocale(code);
        setLocaleNonce((nonce) => nonce + 1);
      } catch (error) {
        if (generation !== datasetGenerationRef.current) return;
        setStatus(t("app.status.regionFailed", { error: String(error) }));
      } finally {
        if (generation === datasetGenerationRef.current) setLoadingData(false);
      }
    },
    [loadingData, openInfo],
  );

  const childrenOf = useCallback((path: string) => childrenMap.get(path), [childrenMap]);

  const loadChildren = useCallback(
    (path: string) => {
      if (childrenMapRef.current.has(path)) return Promise.resolve();
      const pending = childRequestsRef.current.get(path);
      if (pending) return pending;
      const datasetGeneration = datasetGenerationRef.current;

      const request = listChildren(path)
        .then((children) => {
          if (datasetGeneration === datasetGenerationRef.current) {
            storeChildren(path, children);
          }
        })
        .finally(() => {
          childRequestsRef.current.delete(path);
        });
      childRequestsRef.current.set(path, request);
      return request;
    },
    [storeChildren],
  );

  const onToggle = useCallback(
    (path: string) => {
      setExpanded((previous) => {
        const next = new Set(previous);
        if (next.has(path)) next.delete(path);
        else next.add(path);
        return next;
      });
      void loadChildren(path).catch((error) => {
        setStatus(t("app.status.loadFailed", { path, error: String(error) }));
      });
    },
    [loadChildren],
  );

  const onPickSearchResult = useCallback(
    (path: string) => {
      const generation = ++navigationGenerationRef.current;
      const segments = path.split("/");
      const prefixes = segments
        .slice(0, -1)
        .map((_, index) => segments.slice(0, index + 1).join("/"));

      return prefixes
        .reduce((pending, prefix) => pending.then(() => loadChildren(prefix)), Promise.resolve())
        .then(() => {
          if (generation !== navigationGenerationRef.current) return;
          setExpanded((previous) => new Set([...previous, ...prefixes]));
          const entry = findLoadedEntry(childrenMapRef.current, path);
          if (entry) {
            setSelected(entry);
          } else {
            setStatus(t("app.status.targetNotFound", { path }));
          }
        })
        .catch((error) => {
          if (generation === navigationGenerationRef.current) {
            setStatus(t("app.status.navigateFailed", { path, error: String(error) }));
          }
        });
    },
    [loadChildren],
  );

  // 自動化測試用：設定 MSCLASSIC_DATA_DIR 時啟動即開啟該資料目錄。
  // web 版則由 initialDataDir 改回傳 OPFS 快取 / 記住的資料夾標籤，達成啟動自動載入。
  useEffect(() => {
    initialDataDir()
      .then((dir) => {
        if (dir) void loadDataDirectory(dir);
      })
      .catch(() => undefined);
    // web 版「記住資料夾」：有記錄時在歡迎頁顯示一鍵重新連線。
    storedFolderLabel()
      .then((label) => setReconnectLabel(label))
      .catch(() => undefined);
    // 自動化測試用：MSCLASSIC_INITIAL_VIEW 可指定啟動 view（tree/avatar/pet/monster/skill/quest/sound）。
    initialView()
      .then((target) => {
        if (target === "avatar") {
          setView("avatar");
          setAvatarActivated(true);
        } else if (target === "pet") {
          setView("pet");
          setPetAvatarActivated(true);
        } else if (target === "monster") {
          setView("monster");
          setMonsterActivated(true);
        } else if (target === "skill") {
          setView("skill");
          setSkillActivated(true);
        } else if (target === "quest") {
          setView("quest");
          setQuestActivated(true);
        } else if (target === "sound") {
          setView("sound");
          setSoundActivated(true);
        }
      })
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!openInfo) return;
    let active = true;
    if (!initialTargetRequestRef.current) {
      try {
        const hash = decodeURIComponent(window.location.hash.replace(/^#\/?/, ""));
        initialTargetRequestRef.current = hash ? Promise.resolve(hash) : initialPath();
      } catch {
        setStatus(t("app.status.initialPathInvalid"));
        return;
      }
    }
    initialTargetRequestRef.current
      .then((path) => {
        if (active && path) void onPickSearchResult(path);
      })
      .catch((error) => {
        if (active) setStatus(t("app.status.initialPathFailed", { error: String(error) }));
      });
    return () => {
      active = false;
    };
  }, [openInfo, onPickSearchResult]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 5000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  // web 版才有匯入進度(OPFS 複製 / 索引建立);桌面版 onProgress 不會觸發。
  useEffect(() => onProgress(setImportProgress), []);

  // 視窗標題跟隨介面語言（document.title 由 i18n 模組更新；桌面版另設原生視窗標題）。
  useEffect(() => {
    void setWindowTitle(t("app.title")).catch(() => undefined);
  }, [t]);

  const resizeTree = useCallback((clientX: number) => {
    const maxWidth = Math.max(MIN_TREE_WIDTH, window.innerWidth * 0.58);
    const nextWidth = Math.round(Math.min(maxWidth, Math.max(MIN_TREE_WIDTH, clientX)));
    treeWidthRef.current = nextWidth;
    setTreeWidth(nextWidth);
  }, []);

  const onResizeStart = (event: PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    setResizingTree(true);
    resizeTree(event.clientX);
  };

  const onResizeMove = (event: PointerEvent<HTMLDivElement>) => {
    if (resizingTree) resizeTree(event.clientX);
  };

  const finishResize = (event: PointerEvent<HTMLDivElement>) => {
    if (!resizingTree) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setResizingTree(false);
    window.localStorage.setItem("msclassic.treePaneWidth", String(treeWidthRef.current));
  };

  const onResizeKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const delta = event.key === "ArrowLeft" ? -16 : 16;
    const next = Math.min(
      Math.max(MIN_TREE_WIDTH, window.innerWidth * 0.58),
      Math.max(MIN_TREE_WIDTH, treeWidth + delta),
    );
    treeWidthRef.current = next;
    setTreeWidth(next);
    window.localStorage.setItem("msclassic.treePaneWidth", String(next));
  };

  const workspaceStyle = {
    "--tree-pane-width": `${treeWidth}px`,
  } as CSSProperties;

  const selectedIsCategory = selected?.kind === "Category";
  const detailPath = selected && !selectedIsCategory ? selected.path : null;

  return (
    <div className="app">
      <header className="app-header">
        <div className="view-tabs" role="tablist" aria-label={t("app.tabs.label")}>
          <button
            type="button"
            role="tab"
            aria-selected={view === "tree"}
            className={view === "tree" ? "is-active" : ""}
            onClick={() => setView("tree")}
          >
            {t("app.tabs.tree")}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === "avatar"}
            className={view === "avatar" ? "is-active" : ""}
            disabled={!openInfo}
            title={openInfo ? t("app.tabs.avatarTitle") : t("app.tabs.needFolder")}
            onClick={() => {
              setView("avatar");
              setAvatarActivated(true);
            }}
          >
            {t("app.tabs.avatar")}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === "pet"}
            className={view === "pet" ? "is-active" : ""}
            disabled={!openInfo}
            title={openInfo ? t("app.tabs.petTitle") : t("app.tabs.needFolder")}
            onClick={() => {
              setView("pet");
              setPetAvatarActivated(true);
            }}
          >
            {t("app.tabs.pet")}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === "monster"}
            className={view === "monster" ? "is-active" : ""}
            disabled={!openInfo}
            title={openInfo ? t("app.tabs.monsterTitle") : t("app.tabs.needFolder")}
            onClick={() => {
              setView("monster");
              setMonsterActivated(true);
            }}
          >
            {t("app.tabs.monster")}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === "skill"}
            className={view === "skill" ? "is-active" : ""}
            disabled={!openInfo}
            title={openInfo ? t("app.tabs.skillTitle") : t("app.tabs.needFolder")}
            onClick={() => {
              setView("skill");
              setSkillActivated(true);
            }}
          >
            {t("app.tabs.skill")}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === "quest"}
            className={view === "quest" ? "is-active" : ""}
            disabled={!openInfo}
            title={openInfo ? t("app.tabs.questTitle") : t("app.tabs.needFolder")}
            onClick={() => {
              setView("quest");
              setQuestActivated(true);
            }}
          >
            {t("app.tabs.quest")}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === "sound"}
            className={view === "sound" ? "is-active" : ""}
            disabled={!openInfo}
            title={openInfo ? t("app.tabs.soundTitle") : t("app.tabs.needFolder")}
            onClick={() => {
              setView("sound");
              setSoundActivated(true);
            }}
          >
            {t("app.tabs.sound")}
          </button>
        </div>
        <div className="header-divider" aria-hidden="true" />
        <ExportMenu
          canExportPng={
            selected?.kind === "Node" &&
            (selected.type_tag === 18 ||
              selected.type_tag === 19 ||
              selected.type_tag === 12)
          }
          nodeName={selected?.name ?? null}
          path={detailPath}
          onMessage={(message, tone = "success") => {
            setToast({ message, tone });
            setStatus(message);
          }}
          onShowChangelog={() => setShowChangelog(true)}
        />
        <div className="header-spacer" />
        {view === "avatar" ? (
          <>
            <button
              className="icon-button bgm-button"
              type="button"
              onClick={() => setBgmOn((on) => !on)}
              title={bgmOn ? t("app.bgm.pause") : t("app.bgm.play")}
              aria-label={bgmOn ? t("app.bgm.pause") : t("app.bgm.play")}
            >
              {bgmOn ? "⏸" : "▶"}
            </button>
            <input
              className="bgm-volume"
              type="range"
              min={0}
              max={100}
              value={Math.round(bgmVolume * 100)}
              onChange={(event) => setBgmVolume(Number(event.target.value) / 100)}
              title={t("app.bgm.volumeValue", { percent: Math.round(bgmVolume * 100) })}
              aria-label={t("app.bgm.volume")}
            />
            <label className="cash-switch" title={t("app.cashOnlyTitle")}>
              <input
                type="checkbox"
                checked={cashOnly}
                onChange={(event) => setCashOnly(event.target.checked)}
              />
              <span className="cash-switch-track" aria-hidden="true">
                <span className="cash-switch-thumb" />
              </span>
              {t("app.cashOnly")}
            </label>
          </>
        ) : null}
        {CAN_SWITCH_DATA_SOURCE ? (
          <>
            <div className="source-switch" role="tablist" aria-label={t("app.source.label")}>
              <button
                type="button"
                role="tab"
                aria-selected={dataSource === "cloud"}
                className={dataSource === "cloud" ? "is-active" : ""}
                disabled={loadingData}
                title={t("app.source.cloudTitle")}
                onClick={() => void switchToCloud()}
              >
                <Cloud aria-hidden="true" size={15} strokeWidth={2.25} />
                {t("app.source.cloud")}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={dataSource === "local"}
                className={dataSource === "local" ? "is-active" : ""}
                disabled={loadingData}
                title={t("app.source.localTitle")}
                onClick={() => void switchToLocal()}
              >
                <Folder aria-hidden="true" size={15} strokeWidth={2.25} />
                {t("app.source.local")}
              </button>
            </div>
            {dataSource === "local" ? (
              <button
                className="data-folder-button"
                type="button"
                disabled={loadingData}
                onClick={() => void chooseDataDirectory()}
              >
                {openInfo ? (
                  <FolderSync aria-hidden="true" size={15} strokeWidth={2.25} />
                ) : (
                  <Folder aria-hidden="true" size={15} strokeWidth={2.25} />
                )}
                {loadingData ? t("common.loading") : openInfo ? t("app.folder.change") : t("app.folder.choose")}
              </button>
            ) : null}
          </>
        ) : (
          <button
            className="data-folder-button"
            type="button"
            disabled={loadingData}
            onClick={() => void chooseDataDirectory()}
          >
            {openInfo ? (
              <FolderSync aria-hidden="true" size={15} strokeWidth={2.25} />
            ) : (
              <Folder aria-hidden="true" size={15} strokeWidth={2.25} />
            )}
            {loadingData ? t("common.loading") : openInfo ? t("app.folder.change") : t("app.folder.choose")}
          </button>
        )}
        {openInfo && openInfo.locales.length > 1 ? (
          <label className="region-select" title={t("app.region.title")}>
            <span className="region-select-label">{t("app.region.label")}</span>
            <select
              value={openInfo.locale}
              disabled={loadingData}
              onChange={(event) => void changeRegion(event.target.value)}
              aria-label={t("app.region.title")}
            >
              {openInfo.locales.map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <label className="region-select language-select" title={t("app.language.title")}>
          <Languages aria-hidden="true" size={15} strokeWidth={2.25} />
          <select
            value={language}
            onChange={(event) => {
              if (isLanguage(event.target.value)) setLanguage(event.target.value);
            }}
            aria-label={t("app.language.title")}
          >
            {LANGUAGES.map((option) => (
              <option key={option.code} value={option.code} lang={option.code}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <button
          className="icon-button"
          type="button"
          onClick={toggleTheme}
          title={theme === "dark" ? t("app.theme.toLight") : t("app.theme.toDark")}
          aria-label={t("app.theme.toggle")}
        >
                   {theme === "dark" ? (
            <Sun aria-hidden="true" size={15} strokeWidth={2.25} />
          ) : (
            <Moon aria-hidden="true" size={15} strokeWidth={2.25} />
          )}
        </button>
      </header>

      {importProgress ? (
        <div className="import-progress" role="status">
          <span className="import-progress-message">{progressMessage(importProgress, t)}</span>
          <div
            className="import-progress-track"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(importProgress.percent)}
          >
            <div
              className="import-progress-bar"
              style={{ width: `${Math.min(100, Math.max(0, importProgress.percent))}%` }}
            />
          </div>
          <span className="import-progress-percent">
            {Math.round(importProgress.percent)}%
          </span>
        </div>
      ) : null}

      {openInfo ? (
        <div
          key={localeNonce}
          className={`app-body${view === "avatar" ? " is-avatar" : ""}${view === "pet" ? " is-pet" : ""}${view === "monster" ? " is-monster" : ""}${view === "skill" ? " is-skill" : ""}${view === "quest" ? " is-quest" : ""}${view === "sound" ? " is-sound" : ""}`}
          style={workspaceStyle}
        >
          {view === "tree" ? (
            <>
              <aside className="app-left" aria-label={t("app.tree.label")}>
                <TreeView
                  childrenOf={childrenOf}
                  expanded={expanded}
                  selected={selected?.path ?? null}
                  onToggle={onToggle}
                  onSelect={setSelected}
                />
                <div className="tree-panel-heading">
                  <SearchBar
                    scope={selected?.path ?? null}
                    onClearScope={() => setSelected(null)}
                    onPick={onPickSearchResult}
                  />
                </div>
              </aside>
              <div
                className={`workspace-resizer${resizingTree ? " is-active" : ""}`}
                role="separator"
                tabIndex={0}
                aria-label={t("app.tree.resize")}
                aria-orientation="vertical"
                aria-valuemin={MIN_TREE_WIDTH}
                aria-valuemax={Math.round(window.innerWidth * 0.58)}
                aria-valuenow={treeWidth}
                onKeyDown={onResizeKeyDown}
                onPointerDown={onResizeStart}
                onPointerMove={onResizeMove}
                onPointerUp={finishResize}
                onPointerCancel={finishResize}
              >
                <span />
              </div>
            </>
          ) : null}
          <main className="app-right">
            {view === "tree" ? (
              <NodeDetail
                path={detailPath}
                emptyMode={selectedIsCategory ? "category" : "selection"}
              />
            ) : null}
            {avatarActivated || view === "avatar" ? (
              <AvatarPage
                visible={view === "avatar"}
                cashOnly={cashOnly}
                onPickItem={setAvatarPick}
              />
            ) : null}
            {petAvatarActivated || view === "pet" ? (
              <PetAvatarPage visible={view === "pet"} onPickItem={setAvatarPick} />
            ) : null}
            {monsterActivated || view === "monster" ? (
              <MonsterBookPage
                visible={view === "monster"}
                onPickMob={setMobPick}
                jumpToMob={mobJump}
                onJumpToMobHandled={clearMobJump}
              />
            ) : null}
            {skillActivated || view === "skill" ? (
              <SkillBookPage visible={view === "skill"} onPickSkill={setSkillPick} />
            ) : null}
            {questActivated || view === "quest" ? (
              <QuestPage
                visible={view === "quest"}
                onPickQuest={setQuestPick}
                onOpenMob={openMobInBook}
              />
            ) : null}
            {soundActivated || view === "sound" ? (
              <SoundPage visible={view === "sound"} onPickSound={setSoundPick} />
            ) : null}
          </main>
        </div>
      ) : (
        <main className="data-source-welcome">
          <section>
            {CAN_SWITCH_DATA_SOURCE && dataSource === "cloud" ? (
              <>
                <p className="welcome-eyebrow">{t("app.welcome.eyebrow")}</p>
                <h1>{t("app.welcome.cloudTitle")}</h1>
                <p className="welcome-description">{t("app.welcome.cloudDescription")}</p>
                <button
                  className="welcome-open-button"
                  type="button"
                  disabled={loadingData}
                  onClick={() => void loadDataDirectory(cloudSourceLabel())}
                >
                  {loadingData ? t("app.welcome.cloudConnecting") : t("app.welcome.cloudRetry")}
                </button>
                {dataError ? <p className="data-source-error" role="alert">{dataError}</p> : null}
              </>
            ) : (
              <>
                <p className="welcome-eyebrow">{t("app.welcome.eyebrow")}</p>
                <h1>{t("app.welcome.localTitle")}</h1>
                <p className="welcome-description">{t("app.welcome.localDescription")}</p>
                <button
                  className="welcome-open-button"
                  type="button"
                  disabled={loadingData}
                  onClick={() => void chooseDataDirectory()}
                >
                  {loadingData ? t("app.welcome.indexing") : t("app.folder.choose")}
                </button>
                {reconnectLabel ? (
                  <button
                    className="welcome-reconnect-button"
                    type="button"
                    disabled={loadingData}
                    onClick={() => void reconnectStoredFolder()}
                  >
                    {t("app.welcome.reconnect", { label: reconnectLabel })}
                  </button>
                ) : null}
                {dataError ? <p className="data-source-error" role="alert">{dataError}</p> : null}
                <p className="welcome-hint">{t("app.welcome.readOnly")}</p>
                {__WEB_BUILD__ ? (
                  <p className="welcome-hint">{t("app.welcome.uploadHint")}</p>
                ) : null}
                {__WEB_BUILD__ && !CAN_SWITCH_DATA_SOURCE ? (
                  <p className="welcome-hint">{t("app.welcome.systemFolderHint")}</p>
                ) : null}
              </>
            )}
          </section>
        </main>
      )}

      {toast ? (
        <div className={`app-toast is-${toast.tone}`} role="status">
          {toast.message}
        </div>
      ) : null}
      <div className="sr-only" role="status" aria-live="polite">{status}</div>
      <ChangelogDialog open={showChangelog} onClose={() => setShowChangelog(false)} />
      <footer
        className="app-footer"
        title={
          view === "avatar" || view === "pet"
            ? (avatarPick ?? undefined)
            : view === "monster"
              ? (mobPick ?? undefined)
              : view === "skill"
                ? (skillPick ?? undefined)
                : view === "quest"
                  ? (questPick ?? undefined)
                  : view === "sound"
                    ? (soundPick ?? undefined)
                    : (selected?.path ?? undefined)
        }
      >
        {view === "avatar" || view === "pet" ? (
          <>
            <span className="footer-node-type">{avatarPick ? t("common.typeLabel", { type: "img" }) : ""}</span>
            <span className="footer-node-path">{avatarPick ?? ""}</span>
          </>
        ) : view === "monster" ? (
          <>
            <span className="footer-node-type">{mobPick ? t("common.typeLabel", { type: "img" }) : ""}</span>
            <span className="footer-node-path">{mobPick ?? ""}</span>
          </>
        ) : view === "skill" ? (
          <>
            <span className="footer-node-type">{skillPick ? t("common.typeLabel", { type: "img" }) : ""}</span>
            <span className="footer-node-path">{skillPick ?? ""}</span>
          </>
        ) : view === "quest" ? (
          <>
            <span className="footer-node-type">{questPick ? t("common.typeLabel", { type: "img" }) : ""}</span>
            <span className="footer-node-path">{questPick ?? ""}</span>
          </>
        ) : view === "sound" ? (
          <>
            <span className="footer-node-type">{soundPick ? t("common.typeLabel", { type: "AudioClip" }) : ""}</span>
            <span className="footer-node-path">{soundPick ?? ""}</span>
          </>
        ) : (
          <>
            <span className="footer-node-type">
              {selected ? t("common.typeLabel", { type: selectedTypeLabel(selected) }) : ""}
            </span>
            <span className="footer-node-path">{selected?.path ?? ""}</span>
          </>
        )}
        <span className="footer-version">v{APP_VERSION}</span>
      </footer>
    </div>
  );
}
