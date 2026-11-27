import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  getAvatarEmotions,
  getAvatarEquipment,
  getAvatarFrames,
  getAvatarMeta,
  type AvatarFrames,
  type AvatarMeta,
  type EquipItem,
  type PartInput,
  type SkinInfo,
} from "../api";
import { useI18n } from "../i18n";
import { AvatarEquipPanel } from "./AvatarEquipPanel";
import { AvatarAlbumDialog } from "./AvatarAlbumDialog";
import { AvatarPreview, type AvatarPreviewHandle } from "./AvatarPreview";
import { AvatarShop } from "./AvatarShop";
import { joinColorId, resolveColorVariant, splitColorId } from "./avatarColor";
import { deleteAvatarLook, listAvatarLooks, saveAvatarLook, type AvatarLook } from "./avatarAlbum";

// 可穿的裝備部位（body/head 是膚色，不在此列）。
export type EquipSlot =
  | "cap"
  | "coat"
  | "longcoat"
  | "pants"
  | "shoes"
  | "glove"
  | "cape"
  | "shield"
  | "weapon"
  | "earrings"
  | "faceAcc"
  | "eyeAcc"
  | "hair"
  | "face";

export interface AvatarPartState {
  id: string;
  visible: boolean;
}

/** 已穿部位表；初始全空 = 裸身。 */
export type PartsState = Partial<Record<EquipSlot, AvatarPartState>>;

// 沒穿臉型時用的預設臉（決定表情清單與裸身表情貼圖）。
const DEFAULT_FACE_ID = "00020000";

// 相簿狀態列的訊息與錯誤：state 只存代碼與原始資料，渲染時才依介面語言組字。
type AlbumNotice = { kind: "saved" | "applied" | "appliedPartial"; name: string };
type AlbumError =
  | { kind: "previewNotReady" }
  | { kind: "readFailed" | "saveFailed" | "renameFailed" | "deleteFailed"; error: string };

// 紙娃娃頁：所有試穿狀態集中在這裡，預覽/控制區/商店都是受控元件。
export function AvatarPage({
  visible,
  cashOnly,
  onPickItem,
}: {
  visible: boolean;
  cashOnly: boolean;
  /** 點商店卡片時回報裝備 img 路徑（給 App footer 麵包屑）。 */
  onPickItem?: (path: string) => void;
}) {
  const { t } = useI18n();
  const [meta, setMeta] = useState<AvatarMeta | null>(null);
  const [equipment, setEquipment] = useState<EquipItem[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [skin, setSkin] = useState<SkinInfo | null>(null);
  const [action, setAction] = useState("stand1");
  const [emotion, setEmotion] = useState("default");
  const [emotions, setEmotions] = useState<string[]>(["default"]);
  const [playing, setPlaying] = useState(true);
  const [parts, setParts] = useState<PartsState>({});
  // 髮色/臉色（0–7）：穿上或換色時套用，見 avatarColor.ts。
  const [hairColor, setHairColor] = useState(0);
  const [faceColor, setFaceColor] = useState(0);
  // 帽子遮髮（對齊 WzComparerR2 的 HairCover）：勾選且有戴帽 → 帽子蓋住髮型；
  // 不勾 → 髮型超出帽子。沒戴帽時無效果。
  const [hairCover, setHairCover] = useState(true);
  // 髮型陰影（hairShade 層）：預設關閉——有些髮型這層是很重的整片陰影，想看再勾選。
  const [hairShade, setHairShade] = useState(false);
  const [frames, setFrames] = useState<AvatarFrames | null>(null);
  const [framesLoading, setFramesLoading] = useState(false);
  const [framesError, setFramesError] = useState<string | null>(null);
  const framesGenerationRef = useRef(0);
  const previewRef = useRef<AvatarPreviewHandle>(null);
  const restoreEmotionRef = useRef<{ faceId: string; emotion: string } | null>(null);
  const [looks, setLooks] = useState<AvatarLook[]>([]);
  const [albumMode, setAlbumMode] = useState<"save" | "gallery" | null>(null);
  const [pendingThumbnail, setPendingThumbnail] = useState<string | null>(null);
  const [albumBusy, setAlbumBusy] = useState(false);
  const [albumLoading, setAlbumLoading] = useState(true);
  const [albumError, setAlbumError] = useState<AlbumError | null>(null);
  const [albumNotice, setAlbumNotice] = useState<AlbumNotice | null>(null);
  const albumRefreshRef = useRef(0);

  const refreshAlbum = useCallback(async () => {
    const generation = ++albumRefreshRef.current;
    setAlbumLoading(true);
    setAlbumError(null);
    try {
      const saved = await listAvatarLooks();
      if (generation === albumRefreshRef.current) setLooks(saved);
    } catch (error) {
      if (generation === albumRefreshRef.current) setAlbumError({ kind: "readFailed", error: String(error) });
    } finally {
      if (generation === albumRefreshRef.current) setAlbumLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshAlbum();
    return () => { albumRefreshRef.current += 1; };
  }, [refreshAlbum]);

  // 換色時查 variant 是否存在用（全裝備 id 集合）。
  const equipmentIds = useMemo(
    () => new Set((equipment ?? []).map((item) => item.id)),
    [equipment],
  );
  const idExists = useCallback((id: string) => equipmentIds.has(id), [equipmentIds]);

  // 沒穿臉型時用預設臉，但跟著臉色選擇換色（該色不存在時退回顏色 0）。
  const faceId = parts.face?.id ?? resolveColorVariant("face", DEFAULT_FACE_ID, faceColor, idExists);

  // 目前臉型（穿著的或預設臉）實際可選的顏色：0–7 恆列出，
  // 8（白色）只有該造型真的有這個 id 才列出。
  const faceColorOptions = useMemo(() => {
    const split = splitColorId("face", faceId);
    if (!split) return [0, 1, 2, 3, 4, 5, 6, 7];
    const options = [0, 1, 2, 3, 4, 5, 6, 7];
    if (idExists(joinColorId("face", split.base, 8))) options.push(8);
    return options;
  }, [faceId, idExists]);

  // meta + equipment：第一次切到紙娃娃（此元件掛載）才載入，之後保持。
  useEffect(() => {
    let active = true;
    Promise.all([getAvatarMeta(), getAvatarEquipment()])
      .then(([nextMeta, nextEquipment]) => {
        if (!active) return;
        setMeta(nextMeta);
        setEquipment(nextEquipment);
        setSkin(nextMeta.skins[0] ?? null);
        // 後端動作清單若沒有 stand1，退用第一個動作。
        if (!nextMeta.actions.includes("stand1") && nextMeta.actions.length > 0) {
          setAction(nextMeta.actions[0]);
        }
      })
      .catch((nextError) => {
        if (active) setLoadError(String(nextError));
      });
    return () => {
      active = false;
    };
  }, []);

  // 表情清單跟著臉型走；換臉型時 emotion 重設 default。
  useEffect(() => {
    let active = true;
    getAvatarEmotions(faceId)
      .then((list) => {
        if (!active) return;
        setEmotions(list.length > 0 ? list : ["default"]);
        const restored = restoreEmotionRef.current;
        setEmotion(restored?.faceId === faceId && list.includes(restored.emotion) ? restored.emotion : "default");
        restoreEmotionRef.current = null;
      })
      .catch(() => {
        if (!active) return;
        setEmotions(["default"]);
        setEmotion("default");
        restoreEmotionRef.current = null;
      });
    return () => {
      active = false;
    };
  }, [faceId]);

  // 任何 parts/skin/action/emotion/hairCover/hairShade 變更 → 重取合成幀（generation guard 防舊回應覆蓋）。
  // 只送 visible 的部位 + body/head：隱藏的部位（例如帽子）不能觸發後端遮髮，所以不送。
  useEffect(() => {
    if (!skin) return;
    const generation = ++framesGenerationRef.current;
    const partInputs: PartInput[] = [
      { slot: "body", id: skin.bodyId, visible: true },
      { slot: "head", id: skin.headId, visible: true },
    ];
    for (const [slot, part] of Object.entries(parts)) {
      if (part?.visible) partInputs.push({ slot, id: part.id, visible: true });
    }
    setFramesLoading(true);
    setFramesError(null);
    getAvatarFrames(partInputs, action, emotion, hairCover, hairShade)
      .then((result) => {
        if (generation === framesGenerationRef.current) setFrames(result);
      })
      .catch((nextError) => {
        if (generation === framesGenerationRef.current) setFramesError(String(nextError));
      })
      .finally(() => {
        if (generation === framesGenerationRef.current) setFramesLoading(false);
      });
  }, [skin, action, emotion, parts, hairCover, hairShade]);

  // 穿上（同 slot 取代），含 longcoat 互斥（移植自參考專案 WzComparerR2.Avatar）。
  const equip = useCallback((slot: EquipSlot, id: string) => {
    setParts((previous) => {
      const next: PartsState = { ...previous };
      if (slot === "longcoat") {
        // 穿套服時，若上衣或褲裙可見 → 套服自己先隱藏（保留裝備不脫）。
        const blocked = (previous.coat?.visible ?? false) || (previous.pants?.visible ?? false);
        next.longcoat = { id, visible: !blocked };
      } else if (slot === "coat" || slot === "pants") {
        // 穿上衣/褲裙時，若已穿套服 → 套服轉為隱藏。
        next[slot] = { id, visible: true };
        if (next.longcoat) next.longcoat = { ...next.longcoat, visible: false };
      } else {
        next[slot] = { id, visible: true };
      }
      return next;
    });
  }, []);

  const removePart = useCallback((slot: EquipSlot) => {
    setParts((previous) => {
      const next = { ...previous };
      delete next[slot];
      return next;
    });
  }, []);

  // 換髮色/臉色：記住選擇；已穿著的同 slot 部位立即換成同造型的新顏色
  // （該造型沒有此色時退回顏色 0）。
  const changeColor = useCallback(
    (slot: "hair" | "face", color: number) => {
      if (slot === "hair") setHairColor(color);
      else setFaceColor(color);
      setParts((previous) => {
        const part = previous[slot];
        if (!part) return previous;
        const nextId = resolveColorVariant(slot, part.id, color, idExists);
        if (nextId === part.id) return previous;
        return { ...previous, [slot]: { ...part, id: nextId } };
      });
    },
    [idExists],
  );

  const toggleVisible = useCallback((slot: EquipSlot) => {
    setParts((previous) => {
      const part = previous[slot];
      if (!part) return previous;
      return { ...previous, [slot]: { ...part, visible: !part.visible } };
    });
  }, []);

  const startSave = () => {
    setAlbumError(null);
    setAlbumNotice(null);
    const thumbnail = previewRef.current?.captureThumbnail() ?? null;
    if (!thumbnail) {
      setAlbumError({ kind: "previewNotReady" });
      return;
    }
    setPendingThumbnail(thumbnail);
    setAlbumMode("save");
  };

  const openGallery = () => {
    setAlbumNotice(null);
    setAlbumMode("gallery");
    void refreshAlbum();
  };

  const saveLook = async (name: string) => {
    if (!skin || !pendingThumbnail) return;
    const look: AvatarLook = {
      id: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      name,
      createdAt: Date.now(),
      thumbnail: pendingThumbnail,
      skinBodyId: skin.bodyId,
      action,
      emotion,
      hairColor,
      faceColor,
      hairCover,
      hairShade,
      parts: structuredClone(parts),
    };
    setAlbumBusy(true);
    setAlbumError(null);
    try {
      await saveAvatarLook(look);
      setLooks((previous) => [look, ...previous]);
      setPendingThumbnail(null);
      setAlbumMode("gallery");
      setAlbumNotice({ kind: "saved", name });
    } catch (error) {
      setAlbumError({ kind: "saveFailed", error: String(error) });
    } finally {
      setAlbumBusy(false);
    }
  };

  const applyLook = (look: AvatarLook) => {
    if (!meta || !equipment) return;
    const nextSkin = meta.skins.find((candidate) => candidate.bodyId === look.skinBodyId);
    const nextParts: PartsState = {};
    let missing = 0;
    for (const [slot, part] of Object.entries(look.parts)) {
      if (!part) continue;
      if (equipmentIds.has(part.id)) nextParts[slot as EquipSlot] = { ...part };
      else missing += 1;
    }
    const nextFaceId = nextParts.face?.id ?? resolveColorVariant("face", DEFAULT_FACE_ID, look.faceColor, idExists);
    restoreEmotionRef.current = nextFaceId === faceId ? null : { faceId: nextFaceId, emotion: look.emotion };
    setSkin(nextSkin ?? meta.skins[0] ?? null);
    setAction(meta.actions.includes(look.action) ? look.action : meta.actions[0] ?? "stand1");
    setParts(nextParts);
    setHairColor(look.hairColor);
    setFaceColor(look.faceColor);
    setHairCover(look.hairCover);
    setHairShade(look.hairShade);
    if (nextFaceId === faceId) setEmotion(emotions.includes(look.emotion) ? look.emotion : "default");
    setAlbumMode(null);
    setAlbumNotice({
      kind: missing > 0 || !nextSkin ? "appliedPartial" : "applied",
      name: look.name,
    });
  };

  const renameLook = async (look: AvatarLook, name: string) => {
    setAlbumBusy(true);
    setAlbumError(null);
    try {
      await saveAvatarLook({ ...look, name });
      setLooks((previous) => previous.map((item) => item.id === look.id ? { ...item, name } : item));
      return true;
    } catch (error) {
      setAlbumError({ kind: "renameFailed", error: String(error) });
      return false;
    } finally {
      setAlbumBusy(false);
    }
  };

  const removeLook = async (look: AvatarLook) => {
    setAlbumBusy(true);
    setAlbumError(null);
    try {
      await deleteAvatarLook(look.id);
      setLooks((previous) => previous.filter((item) => item.id !== look.id));
      return true;
    } catch (error) {
      setAlbumError({ kind: "deleteFailed", error: String(error) });
      return false;
    } finally {
      setAlbumBusy(false);
    }
  };

  const albumErrorText = albumError
    ? albumError.kind === "previewNotReady"
      ? t("avatar.album.previewNotReady")
      : t(`avatar.album.${albumError.kind}`, { error: albumError.error })
    : null;
  const albumNoticeText = albumNotice
    ? t(`avatar.album.${albumNotice.kind}`, { name: albumNotice.name })
    : null;

  let content;
  if (loadError) {
    content = <p className="avatar-page-status">{t("avatar.page.loadFailed", { error: loadError })}</p>;
  } else if (!meta || !equipment) {
    content = <p className="avatar-page-status">{t("avatar.page.loading")}</p>;
  } else if (!skin) {
    content = <p className="avatar-page-status">{t("avatar.page.noSkin")}</p>;
  } else {
    content = (
      <>
        <aside className="avatar-left">
          <div className="avatar-left-preview">
            <AvatarPreview
              ref={previewRef}
              frames={frames}
              loading={framesLoading}
              error={framesError}
              playing={playing}
              active={visible}
              action={action}
            />
          </div>
          <div className="avatar-album-entry">
            <button type="button" disabled={albumLoading} onClick={startSave}>{t("avatar.album.save")}</button>
            <button type="button" onClick={openGallery}>
              {t("avatar.album.myAlbum")} <span>{looks.length}</span>
            </button>
          </div>
          {albumNoticeText || albumErrorText ? (
            <p className={`avatar-album-status${albumErrorText ? " is-error" : ""}`} role="status">
              {albumErrorText ?? albumNoticeText}
            </p>
          ) : null}
          <div className="avatar-left-controls">
            <AvatarEquipPanel
              skins={meta.skins}
              skin={skin}
              onSkinChange={setSkin}
              actions={meta.actions}
              action={action}
              onActionChange={setAction}
              emotions={emotions}
              emotion={emotion}
              onEmotionChange={setEmotion}
              hairColor={hairColor}
              faceColor={faceColor}
              faceColors={faceColorOptions}
              onColorChange={changeColor}
              hairCover={hairCover}
              onHairCoverChange={setHairCover}
              hairShade={hairShade}
              onHairShadeChange={setHairShade}
              playing={playing}
              onTogglePlaying={() => setPlaying((previous) => !previous)}
              parts={parts}
              equipment={equipment}
              onToggleVisible={toggleVisible}
              onRemove={removePart}
            />
          </div>
        </aside>
        <section className="avatar-right">
          <AvatarShop
            equipment={equipment}
            parts={parts}
            cashOnly={cashOnly}
            hairColor={hairColor}
            faceColor={faceColor}
            onEquip={equip}
            onRemove={removePart}
            onPickItem={onPickItem}
          />
        </section>
      </>
    );
  }

  return (
    <div className="avatar-page" hidden={!visible}>
      {content}
      {albumMode ? (
        <AvatarAlbumDialog
          mode={albumMode}
          looks={looks}
          thumbnail={pendingThumbnail}
          defaultName={t("avatar.album.defaultName", { index: looks.length + 1 })}
          busy={albumBusy}
          loading={albumLoading}
          error={albumErrorText}
          onClose={() => { setAlbumMode(null); setAlbumError(null); }}
          onSave={(name) => void saveLook(name)}
          onApply={applyLook}
          onRename={renameLook}
          onDelete={removeLook}
          onStartSave={startSave}
        />
      ) : null}
    </div>
  );
}
