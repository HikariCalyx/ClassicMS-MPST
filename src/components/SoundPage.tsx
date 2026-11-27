import { createDatasetCache } from "../locale";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import {
  Music,
  MapPin,
  Pause,
  Play,
  Repeat,
  Repeat1,
  Shuffle,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX,
} from "lucide-react";
import {
  getAudio,
  getImage,
  getMapBgmIndex,
  listChildren,
  type BgmMapRef,
  type ChildEntry,
} from "../api";
import { useI18n } from "../i18n";

// BGM 音樂播放器：左播放清單（Bgm* 分類）/ 中曲目表 / 右「使用地圖」欄 /
// 下固定播放列（Spotify 風格）。曲目清單用既有 listChildren，音訊用既有
// getAudio（Ogg Vorbis base64），地圖反查用 getMapBgmIndex。

interface BgmCategory {
  name: string;
  path: string;
}

interface BgmTrack {
  title: string;
  path: string;
  category: string;
}

type LoopMode = "all" | "one" | "off";

/** 曲目載入/播放錯誤：只存發生階段與原始訊息，顯示文字在渲染時依介面語言組成。 */
interface TrackError {
  stage: "load" | "play";
  message: string;
}

/** 側欄「全部 BGM」虛擬分類的 key。 */
const ALL_CATEGORY = "__all__";
/** Blob URL LRU 上限：BGM 最大約 4.7MB/首，聽很多首也不讓記憶體無限長。 */
const URL_CACHE_LIMIT = 8;

const STORAGE_VOLUME = "msclassic.sound.volume";
const STORAGE_LOOP = "msclassic.sound.loop";
const STORAGE_SHUFFLE = "msclassic.sound.shuffle";

function initialVolume(): number {
  const saved = Number(window.localStorage.getItem(STORAGE_VOLUME));
  return Number.isFinite(saved) && saved >= 0 && saved <= 1 ? saved : 0.5;
}

function initialLoop(): LoopMode {
  const saved = window.localStorage.getItem(STORAGE_LOOP);
  return saved === "one" || saved === "off" ? saved : "all";
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "--:--";
  const total = Math.floor(seconds);
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

/** 隨機取一個不是 current 的 index（佇列只有一首時維持 0）。 */
function randomNext(length: number, current: number): number {
  if (length <= 1) return 0;
  return (current + 1 + Math.floor(Math.random() * (length - 1))) % length;
}

/** 播放中列的動態等化器（純 CSS 動畫）；暫停時顯示靜態 Pause 圖示由外層決定。 */
function EqualizerBars() {
  return (
    <span className="sound-eq" aria-hidden="true">
      <span />
      <span />
      <span />
    </span>
  );
}

// 地圖 miniMap 縮圖走既有 get_image（<imgPath>/miniMap/canvas），整個 session 快取。
const miniMapCache = createDatasetCache<string, Promise<string | null>>();

function loadMiniMapThumb(imgPath: string): Promise<string | null> {
  let cached = miniMapCache.get(imgPath);
  if (!cached) {
    cached = getImage(`${imgPath}/miniMap/canvas`)
      .then((result) => (result ? `data:image/png;base64,${result.base64}` : null))
      .catch(() => null);
    miniMapCache.set(imgPath, cached);
  }
  return cached;
}

/** 右欄「使用此 BGM 的地圖」一列：miniMap 縮圖（缺圖用 MapPin 圖示）+ 名稱 + id。 */
function MapUsageRow({ map }: { map: BgmMapRef }) {
  const { t } = useI18n();
  const [thumb, setThumb] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void loadMiniMapThumb(map.imgPath).then((url) => {
      if (active) setThumb(url);
    });
    return () => {
      active = false;
    };
  }, [map.imgPath]);
  return (
    <div className="sound-map-row" title={map.imgPath}>
      {thumb ? (
        <img className="sound-map-thumb" src={thumb} alt="" draggable={false} />
      ) : (
        <span className="sound-map-thumb is-empty" aria-hidden="true">
          <MapPin size={14} />
        </span>
      )}
      <div className="sound-map-text">
        <span className="sound-map-name">{map.name ?? t("sound.maps.noName")}</span>
        <span className="sound-map-id">{String(map.mapId).padStart(9, "0")}</span>
      </div>
    </div>
  );
}

export function SoundPage({
  visible,
  onPickSound,
}: {
  visible: boolean;
  /** 選取/播放曲目時回報節點路徑（給 App footer 麵包屑）。 */
  onPickSound?: (path: string) => void;
}) {
  const { t } = useI18n();
  const [categories, setCategories] = useState<BgmCategory[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedCategory, setSelectedCategory] = useState<string>(ALL_CATEGORY);
  const [query, setQuery] = useState("");
  const [tracksMap, setTracksMap] = useState<Map<string, BgmTrack[]>>(new Map());
  const [loadingTracks, setLoadingTracks] = useState(false);

  const [queue, setQueue] = useState<BgmTrack[]>([]);
  const [currentIndex, setCurrentIndex] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [loopMode, setLoopMode] = useState<LoopMode>(initialLoop);
  const [shuffle, setShuffle] = useState(
    () => window.localStorage.getItem(STORAGE_SHUFFLE) === "1",
  );
  const [volume, setVolume] = useState(initialVolume);
  const [muted, setMuted] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [durations, setDurations] = useState<Map<string, number>>(new Map());
  const [trackError, setTrackError] = useState<TrackError | null>(null);
  // 「bgm 值（如 Bgm00/FloralLife）→ 使用地圖清單」；null = 尚未載入完成。
  const [bgmIndex, setBgmIndex] = useState<Map<string, BgmMapRef[]> | null>(null);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const tracksRef = useRef(tracksMap);
  const requestsRef = useRef(new Map<string, Promise<void>>());
  const urlCacheRef = useRef(new Map<string, string>());
  const playGenerationRef = useRef(0);
  const queueRef = useRef(queue);
  const indexRef = useRef(currentIndex);
  const loopRef = useRef(loopMode);
  const shuffleRef = useRef(shuffle);
  const onPickRef = useRef(onPickSound);

  queueRef.current = queue;
  indexRef.current = currentIndex;
  loopRef.current = loopMode;
  shuffleRef.current = shuffle;
  onPickRef.current = onPickSound;

  /** Blob URL LRU：命中時移到最新；超過上限 revoke 最舊的。 */
  const loadTrackUrl = useCallback(async (path: string): Promise<string> => {
    const cache = urlCacheRef.current;
    const hit = cache.get(path);
    if (hit) {
      cache.delete(path);
      cache.set(path, hit);
      return hit;
    }
    const result = await getAudio(path);
    const bytes = Uint8Array.from(atob(result.base64), (c) => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: "audio/ogg" }));
    cache.set(path, url);
    while (cache.size > URL_CACHE_LIMIT) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined || oldest === path) break;
      URL.revokeObjectURL(cache.get(oldest)!);
      cache.delete(oldest);
    }
    return url;
  }, []);

  /** 切歌核心：設定佇列與 index，非同步載入音訊（generation 防 race）。 */
  const playTrackAt = useCallback(
    (tracks: BgmTrack[], index: number) => {
      const track = tracks[index];
      const audio = audioRef.current;
      if (!track || !audio) return;
      const generation = ++playGenerationRef.current;
      setQueue(tracks);
      setCurrentIndex(index);
      setTrackError(null);
      setCurrentTime(0);
      onPickRef.current?.(track.path);
      audio.pause();
      loadTrackUrl(track.path)
        .then((url) => {
          if (generation !== playGenerationRef.current || !audioRef.current) return;
          audio.src = url;
          audio.play().catch((error: unknown) => {
            if (generation === playGenerationRef.current) {
              setTrackError({ stage: "play", message: String(error) });
            }
          });
        })
        .catch((error: unknown) => {
          if (generation === playGenerationRef.current) {
            setTrackError({ stage: "load", message: String(error) });
          }
        });
    },
    [loadTrackUrl],
  );

  const playTrackAtRef = useRef(playTrackAt);
  playTrackAtRef.current = playTrackAt;

  // 單一 <audio> 元素：事件只綁一次，內部一律走 ref 取最新狀態。
  useEffect(() => {
    const audio = new Audio();
    audio.preload = "auto";
    const onTime = () => setCurrentTime(audio.currentTime);
    const onMeta = () => {
      if (!Number.isFinite(audio.duration)) return;
      const track = queueRef.current[indexRef.current ?? -1];
      if (!track) return;
      setDurations((previous) => {
        if (previous.get(track.path) === audio.duration) return previous;
        return new Map(previous).set(track.path, audio.duration);
      });
    };
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onEnded = () => {
      const list = queueRef.current;
      const index = indexRef.current;
      if (index == null || list.length === 0) return;
      if (loopRef.current === "one") {
        audio.currentTime = 0;
        void audio.play().catch(() => undefined);
        return;
      }
      const isLast = index >= list.length - 1;
      if (!shuffleRef.current && loopRef.current === "off" && isLast) return;
      const next = shuffleRef.current ? randomNext(list.length, index) : (index + 1) % list.length;
      playTrackAtRef.current(list, next);
    };
    audio.addEventListener("timeupdate", onTime);
    audio.addEventListener("loadedmetadata", onMeta);
    audio.addEventListener("play", onPlay);
    audio.addEventListener("pause", onPause);
    audio.addEventListener("ended", onEnded);
    audioRef.current = audio;
    return () => {
      audio.pause();
      audio.removeEventListener("timeupdate", onTime);
      audio.removeEventListener("loadedmetadata", onMeta);
      audio.removeEventListener("play", onPlay);
      audio.removeEventListener("pause", onPause);
      audio.removeEventListener("ended", onEnded);
      audioRef.current = null;
      for (const url of urlCacheRef.current.values()) URL.revokeObjectURL(url);
      urlCacheRef.current.clear();
    };
  }, []);

  /** 載入某分類的曲目（同分類只打一次 listChildren）。 */
  const ensureCategory = useCallback((name: string): Promise<void> => {
    if (tracksRef.current.has(name)) return Promise.resolve();
    const pending = requestsRef.current.get(name);
    if (pending) return pending;
    const request = listChildren(`Sound/${name}`)
      .then((children) => {
        // 每首 BGM 是 catalog 層的獨立資產（AudioClip），不是 WZJS tree 節點。
        const tracks = children
          .filter(
            (entry): entry is Extract<ChildEntry, { kind: "Img" }> =>
              entry.kind === "Img" && entry.class_id === 83,
          )
          .map((entry) => ({ title: entry.name, path: entry.path, category: name }));
        const next = new Map(tracksRef.current).set(name, tracks);
        tracksRef.current = next;
        setTracksMap(next);
      })
      .finally(() => {
        requestsRef.current.delete(name);
      });
    requestsRef.current.set(name, request);
    return request;
  }, []);

  // 掛載時載入分類清單；「全部 BGM」是預設檢視，順便把各分類曲目都載回來（側欄才有曲目數）。
  useEffect(() => {
    let active = true;
    setLoadingTracks(true);
    listChildren("Sound")
      .then(async (children) => {
        const cats = children
          .filter(
            (entry): entry is Extract<ChildEntry, { kind: "Category" }> =>
              entry.kind === "Category" && entry.name.startsWith("Bgm"),
          )
          .map((entry) => ({ name: entry.name, path: entry.path }));
        if (!active) return;
        setCategories(cats);
        await Promise.all(cats.map((cat) => ensureCategory(cat.name)));
      })
      .catch((error: unknown) => {
        if (active) setLoadError(String(error));
      })
      .finally(() => {
        if (active) setLoadingTracks(false);
      });
    return () => {
      active = false;
    };
  }, [ensureCategory]);

  // 掛載時順帶載入「BGM → 使用地圖」索引；失敗靜默（右欄只少這塊資訊，不影響播放）。
  useEffect(() => {
    let active = true;
    getMapBgmIndex()
      .then((groups) => {
        if (!active) return;
        setBgmIndex(new Map(groups.map((group) => [group.bgm, group.maps])));
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  // 音量 / 靜音即時套用到 <audio>。
  useEffect(() => {
    const audio = audioRef.current;
    if (audio) audio.volume = muted ? 0 : volume;
    window.localStorage.setItem(STORAGE_VOLUME, String(volume));
  }, [volume, muted]);

  useEffect(() => {
    window.localStorage.setItem(STORAGE_LOOP, loopMode);
  }, [loopMode]);

  useEffect(() => {
    window.localStorage.setItem(STORAGE_SHUFFLE, shuffle ? "1" : "0");
  }, [shuffle]);

  /** 已載入的全部曲目（依分類順序展開）。 */
  const allTracks = useMemo(() => {
    if (!categories) return [];
    return categories.flatMap((cat) => tracksMap.get(cat.name) ?? []);
  }, [categories, tracksMap]);

  /** 主區實際顯示的曲目：有搜尋字串時跨分類過濾（含依地圖名稱反查），否則看選取分類。 */
  const displayedTracks = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (keyword) {
      return allTracks.filter(
        (track) =>
          track.title.toLowerCase().includes(keyword) ||
          track.category.toLowerCase().includes(keyword) ||
          (bgmIndex?.get(track.path.slice("Sound/".length)) ?? []).some((map) =>
            map.name?.toLowerCase().includes(keyword),
          ),
      );
    }
    if (selectedCategory === ALL_CATEGORY) return allTracks;
    return tracksMap.get(selectedCategory) ?? [];
  }, [query, allTracks, selectedCategory, tracksMap, bgmIndex]);

  const currentTrack = currentIndex != null ? (queue[currentIndex] ?? null) : null;
  const currentDuration = currentTrack ? durations.get(currentTrack.path) : undefined;
  /** 目前曲目對應的使用地圖（bgm 值 = 路徑去掉 "Sound/" 前綴）。 */
  const currentMaps = currentTrack
    ? (bgmIndex?.get(currentTrack.path.slice("Sound/".length)) ?? null)
    : null;

  /** 點曲目列：已是目前曲目就切換播放/暫停，否則以目前顯示清單為佇列播放。 */
  const onTrackClick = useCallback(
    (track: BgmTrack, index: number) => {
      if (currentTrack?.path === track.path) {
        const audio = audioRef.current;
        if (!audio) return;
        if (audio.paused) void audio.play().catch(() => undefined);
        else audio.pause();
        return;
      }
      playTrackAt(displayedTracks, index);
    },
    [currentTrack, displayedTracks, playTrackAt],
  );

  const onTrackKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>, track: BgmTrack, index: number) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      onTrackClick(track, index);
    },
    [onTrackClick],
  );

  const stepTrack = useCallback(
    (direction: 1 | -1) => {
      const list = queueRef.current;
      const index = indexRef.current;
      if (list.length === 0) {
        if (displayedTracks.length > 0) playTrackAt(displayedTracks, 0);
        return;
      }
      const current = index ?? 0;
      const next =
        direction === 1 && shuffleRef.current
          ? randomNext(list.length, current)
          : (current + direction + list.length) % list.length;
      playTrackAt(list, next);
    },
    [displayedTracks, playTrackAt],
  );

  const togglePlay = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (!currentTrack) {
      if (displayedTracks.length > 0) playTrackAt(displayedTracks, 0);
      return;
    }
    if (audio.paused) void audio.play().catch(() => undefined);
    else audio.pause();
  }, [currentTrack, displayedTracks, playTrackAt]);

  const cycleLoop = useCallback(() => {
    setLoopMode((mode) => (mode === "all" ? "one" : mode === "one" ? "off" : "all"));
  }, []);

  const onSeek = useCallback((value: number) => {
    const audio = audioRef.current;
    if (!audio || !Number.isFinite(audio.duration)) return;
    audio.currentTime = value;
    setCurrentTime(value);
  }, []);

  if (loadError) {
    return (
      <div className="sound-page" hidden={!visible}>
        <p className="sound-page-status">{t("sound.loadFailed", { error: loadError })}</p>
      </div>
    );
  }
  if (!categories) {
    return (
      <div className="sound-page" hidden={!visible}>
        <p className="sound-page-status">{t("sound.loading")}</p>
      </div>
    );
  }

  const mainTitle = query.trim()
    ? t("sound.search.results")
    : selectedCategory === ALL_CATEGORY
      ? t("sound.sidebar.all")
      : selectedCategory;
  const trackErrorText = trackError
    ? trackError.stage === "play"
      ? t("sound.player.playFailed", { error: trackError.message })
      : t("sound.player.loadFailed", { error: trackError.message })
    : null;

  return (
    <div className="sound-page" hidden={!visible}>
      <aside className="sound-sidebar" aria-label={t("sound.sidebar.label")}>
        <div className="sound-search">
          <input
            type="search"
            value={query}
            placeholder={t("sound.search.placeholder")}
            aria-label={t("sound.search.label")}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <div className="sound-playlist-scroll">
          <button
            type="button"
            className={`sound-playlist-item${selectedCategory === ALL_CATEGORY && !query.trim() ? " is-active" : ""}`}
            onClick={() => {
              setSelectedCategory(ALL_CATEGORY);
              setQuery("");
            }}
          >
            <Music aria-hidden="true" size={14} strokeWidth={2.25} />
            <span className="sound-playlist-name">{t("sound.sidebar.all")}</span>
            <span className="sound-playlist-count">{allTracks.length}</span>
          </button>
          {categories.map((cat) => (
            <button
              key={cat.name}
              type="button"
              className={`sound-playlist-item${selectedCategory === cat.name && !query.trim() ? " is-active" : ""}`}
              onClick={() => {
                setSelectedCategory(cat.name);
                setQuery("");
              }}
            >
              <Music aria-hidden="true" size={14} strokeWidth={2.25} />
              <span className="sound-playlist-name">{cat.name}</span>
              <span className="sound-playlist-count">
                {tracksMap.get(cat.name)?.length ?? "…"}
              </span>
            </button>
          ))}
        </div>
      </aside>

      <section className="sound-main" aria-label={t("sound.tracks.label")}>
        <header className="sound-main-header">
          <h2>{mainTitle}</h2>
          <span className="sound-main-count">
            {loadingTracks
              ? t("common.loading")
              : t("sound.tracks.count", { count: displayedTracks.length })}
          </span>
        </header>
        <div className="sound-tracklist" role="list">
          <div className="sound-track-row is-head" aria-hidden="true">
            <span className="sound-track-index">#</span>
            <span className="sound-track-title">{t("sound.tracks.title")}</span>
            <span className="sound-track-category">{t("sound.tracks.category")}</span>
            <span className="sound-track-duration">{t("sound.tracks.duration")}</span>
          </div>
          {displayedTracks.map((track, index) => {
            const isCurrent = currentTrack?.path === track.path;
            const duration = durations.get(track.path);
            return (
              <div
                key={track.path}
                role="listitem"
                tabIndex={0}
                className={`sound-track-row${isCurrent ? " is-current" : ""}`}
                onClick={() => onTrackClick(track, index)}
                onKeyDown={(event) => onTrackKeyDown(event, track, index)}
              >
                <span className="sound-track-index">
                  {isCurrent ? (
                    playing ? (
                      <EqualizerBars />
                    ) : (
                      <Pause aria-hidden="true" size={13} />
                    )
                  ) : (
                    <>
                      <span className="sound-track-number">{index + 1}</span>
                      <Play className="sound-track-hover-play" aria-hidden="true" size={13} />
                    </>
                  )}
                </span>
                <span className="sound-track-title">{track.title}</span>
                <span className="sound-track-category">{track.category}</span>
                <span className="sound-track-duration">
                  {duration != null ? formatTime(duration) : "--:--"}
                </span>
              </div>
            );
          })}
          {!loadingTracks && displayedTracks.length === 0 ? (
            <p className="sound-track-empty">{t("sound.tracks.empty")}</p>
          ) : null}
        </div>
      </section>

      <aside className="sound-nowplaying" aria-label={t("sound.maps.title")}>
        <header className="sound-nowplaying-header">
          <h3>{t("sound.maps.title")}</h3>
          {currentTrack ? (
            <span className="sound-nowplaying-track">
              {currentTrack.title}
              <span className="sound-nowplaying-category">{currentTrack.category}</span>
            </span>
          ) : null}
        </header>
        <div className="sound-nowplaying-body">
          {!currentTrack ? (
            <p className="sound-nowplaying-empty">{t("sound.maps.prompt")}</p>
          ) : currentMaps == null ? (
            <p className="sound-nowplaying-empty">
              {bgmIndex == null ? t("sound.maps.indexLoading") : t("sound.maps.none")}
            </p>
          ) : (
            currentMaps.map((map) => <MapUsageRow key={map.mapId} map={map} />)
          )}
        </div>
      </aside>

      <footer className="sound-playerbar" aria-label={t("sound.player.label")}>
        <div className="sound-player-info">
          <span className="sound-player-cover" aria-hidden="true">
            <Music size={18} strokeWidth={2} />
          </span>
          <div className="sound-player-text">
            <span className="sound-player-title">
              {currentTrack ? currentTrack.title : t("sound.player.idle")}
            </span>
            <span className="sound-player-category">
              {trackErrorText ??
                (currentTrack ? currentTrack.category : t("sound.player.prompt"))}
            </span>
          </div>
        </div>
        <div className="sound-player-controls">
          <div className="sound-player-buttons">
            <button
              type="button"
              className={`sound-player-button${shuffle ? " is-active" : ""}`}
              title={shuffle ? t("sound.player.shuffleOff") : t("sound.player.shuffle")}
              aria-label={shuffle ? t("sound.player.shuffleOff") : t("sound.player.shuffle")}
              aria-pressed={shuffle}
              onClick={() => setShuffle((on) => !on)}
            >
              <Shuffle aria-hidden="true" size={15} />
            </button>
            <button
              type="button"
              className="sound-player-button"
              title={t("sound.player.previous")}
              aria-label={t("sound.player.previous")}
              onClick={() => stepTrack(-1)}
            >
              <SkipBack aria-hidden="true" size={16} />
            </button>
            <button
              type="button"
              className="sound-player-button is-primary"
              title={playing ? t("common.pause") : t("common.play")}
              aria-label={playing ? t("common.pause") : t("common.play")}
              onClick={togglePlay}
            >
              {playing ? (
                <Pause aria-hidden="true" size={17} />
              ) : (
                <Play aria-hidden="true" size={17} />
              )}
            </button>
            <button
              type="button"
              className="sound-player-button"
              title={t("sound.player.next")}
              aria-label={t("sound.player.next")}
              onClick={() => stepTrack(1)}
            >
              <SkipForward aria-hidden="true" size={16} />
            </button>
            <button
              type="button"
              className={`sound-player-button${loopMode !== "off" ? " is-active" : ""}`}
              title={t(`sound.loop.${loopMode}`)}
              aria-label={t("sound.player.loopMode")}
              onClick={cycleLoop}
            >
              {loopMode === "one" ? (
                <Repeat1 aria-hidden="true" size={15} />
              ) : (
                <Repeat aria-hidden="true" size={15} />
              )}
            </button>
          </div>
          <div className="sound-player-progress">
            <span className="sound-player-time">{formatTime(currentTime)}</span>
            <input
              type="range"
              className="sound-player-seek"
              min={0}
              max={currentDuration ?? 0}
              step={0.1}
              value={Math.min(currentTime, currentDuration ?? 0)}
              disabled={!currentTrack || currentDuration == null}
              aria-label={t("sound.player.seek")}
              style={{
                background: `linear-gradient(to right, var(--accent) ${
                  currentDuration ? (Math.min(currentTime, currentDuration) / currentDuration) * 100 : 0
                }%, var(--border) ${
                  currentDuration ? (Math.min(currentTime, currentDuration) / currentDuration) * 100 : 0
                }%)`,
              }}
              onChange={(event) => onSeek(Number(event.target.value))}
            />
            <span className="sound-player-time">{formatTime(currentDuration ?? NaN)}</span>
          </div>
        </div>
        <div className="sound-player-volume">
          <button
            type="button"
            className="sound-player-button"
            title={muted ? t("sound.player.unmute") : t("sound.player.mute")}
            aria-label={muted ? t("sound.player.unmute") : t("sound.player.mute")}
            onClick={() => setMuted((on) => !on)}
          >
            {muted || volume === 0 ? (
              <VolumeX aria-hidden="true" size={15} />
            ) : (
              <Volume2 aria-hidden="true" size={15} />
            )}
          </button>
          <input
            type="range"
            className="sound-volume"
            min={0}
            max={100}
            value={muted ? 0 : Math.round(volume * 100)}
            aria-label={t("sound.player.volume")}
            title={t("sound.player.volumeValue", {
              percent: muted ? 0 : Math.round(volume * 100),
            })}
            onChange={(event) => {
              setMuted(false);
              setVolume(Number(event.target.value) / 100);
            }}
          />
        </div>
      </footer>
    </div>
  );
}
