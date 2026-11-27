import { useEffect, useMemo, useRef, useState } from "react";
import type { EquipItem, SkinInfo } from "../api";
import { useI18n } from "../i18n";
import type { EquipSlot, PartsState } from "./AvatarPage";
import { loadAvatarIcon, SLOT_TABS } from "./AvatarShop";
import { FACE_COLOR_NAMES, HAIR_COLOR_NAMES, type ColorName } from "./avatarColor";

const HAIR_COLORS = [0, 1, 2, 3, 4, 5, 6, 7];

function AvatarEquipRow({
  slot,
  part,
  item,
  onToggleVisible,
  onRemove,
}: {
  slot: EquipSlot;
  part: { id: string; visible: boolean };
  item: EquipItem | undefined;
  onToggleVisible: (slot: EquipSlot) => void;
  onRemove: (slot: EquipSlot) => void;
}) {
  const { t } = useI18n();
  const [icon, setIcon] = useState<string | null>(null);
  const iconPath = item?.iconPath;

  useEffect(() => {
    if (!iconPath) return;
    let active = true;
    loadAvatarIcon(iconPath).then((url) => {
      if (active && url) setIcon(url);
    });
    return () => {
      active = false;
    };
  }, [iconPath]);

  return (
    <div
      className={`avatar-equipped-row${part.visible ? "" : " is-hidden"}`}
      role="button"
      tabIndex={0}
      title={part.visible ? t("avatar.equip.clickToHide") : t("avatar.equip.clickToShow")}
      onClick={() => onToggleVisible(slot)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onToggleVisible(slot);
        }
      }}
    >
      <span className="avatar-equipped-icon">{icon ? <img src={icon} alt="" /> : null}</span>
      <span className="avatar-equipped-name">{item?.name ?? `#${part.id}`}</span>
      <span className="avatar-equipped-eye" aria-hidden="true">
        👁
      </span>
      <button
        type="button"
        className="avatar-equipped-remove"
        title={t("avatar.equip.remove")}
        aria-label={t("avatar.equip.removeItem", { name: item?.name ?? part.id })}
        onClick={(event) => {
          event.stopPropagation();
          onRemove(slot);
        }}
      >
        ×
      </button>
    </div>
  );
}

// 紙娃娃下拉選單用滾輪切換；原生 listener 才能阻止頁面跟著捲動。
function useWheelSelect<T extends string | number>(
  options: readonly T[],
  value: T,
  onChange: (next: T) => void,
) {
  const selectRef = useRef<HTMLSelectElement>(null);
  const currentValue = useRef(value);
  const changeRef = useRef(onChange);
  currentValue.current = value;
  changeRef.current = onChange;

  useEffect(() => {
    const select = selectRef.current;
    if (!select) return;
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY === 0) return;
      event.preventDefault();
      const index = options.indexOf(currentValue.current);
      const step = event.deltaY > 0 ? 1 : -1;
      const next = options[Math.min(options.length - 1, Math.max(0, index + step))];
      if (next !== undefined && next !== currentValue.current) {
        currentValue.current = next;
        changeRef.current(next);
      }
    };
    select.addEventListener("wheel", onWheel, { passive: false });
    return () => select.removeEventListener("wheel", onWheel);
  }, [options]);

  return selectRef;
}

function ColorSelect({
  id,
  label,
  value,
  options,
  names,
  onChange,
}: {
  id: string;
  label: string;
  value: number;
  /** 實際可選的顏色碼（依序顯示）。 */
  options: number[];
  /** 顏色碼 → 顏色代碼（顯示名稱在 avatar.color.*）。 */
  names: readonly ColorName[];
  onChange: (color: number) => void;
}) {
  const { t } = useI18n();
  const selectRef = useWheelSelect(options, value, onChange);

  // 選取的顏色不在可選清單時（例如換了沒有白色的臉型），顯示退回第一個選項。
  const displayValue = options.includes(value) ? value : options[0];

  return (
    <div className="avatar-color-field">
      <label htmlFor={id}>{label}</label>
      <select
        ref={selectRef}
        id={id}
        value={displayValue}
        onChange={(event) => onChange(Number(event.target.value))}
      >
        {options.map((color) => {
          const name: ColorName | undefined = names[color];
          return (
            <option key={color} value={color}>
              {name ? t(`avatar.color.${name}`) : color}
            </option>
          );
        })}
      </select>
    </div>
  );
}

interface AvatarEquipPanelProps {
  skins: SkinInfo[];
  skin: SkinInfo;
  onSkinChange: (skin: SkinInfo) => void;
  actions: string[];
  action: string;
  onActionChange: (action: string) => void;
  emotions: string[];
  emotion: string;
  onEmotionChange: (emotion: string) => void;
  hairColor: number;
  faceColor: number;
  /** 目前臉型實際可選的顏色碼（白色 8 只有該造型有才會出現）。 */
  faceColors: number[];
  onColorChange: (slot: "hair" | "face", color: number) => void;
  hairCover: boolean;
  onHairCoverChange: (hairCover: boolean) => void;
  hairShade: boolean;
  onHairShadeChange: (hairShade: boolean) => void;
  playing: boolean;
  onTogglePlaying: () => void;
  parts: PartsState;
  equipment: EquipItem[];
  onToggleVisible: (slot: EquipSlot) => void;
  onRemove: (slot: EquipSlot) => void;
}

// 左下控制區：膚色/表情/動作選擇 + 播放暫停 + 目前裝備清單（點列切換顯示、× 脫下）。
export function AvatarEquipPanel({
  skins,
  skin,
  onSkinChange,
  actions,
  action,
  onActionChange,
  emotions,
  emotion,
  onEmotionChange,
  hairColor,
  faceColor,
  faceColors,
  onColorChange,
  hairCover,
  onHairCoverChange,
  hairShade,
  onHairShadeChange,
  playing,
  onTogglePlaying,
  parts,
  equipment,
  onToggleVisible,
  onRemove,
}: AvatarEquipPanelProps) {
  const { t } = useI18n();
  const equipById = useMemo(() => new Map(equipment.map((item) => [item.id, item])), [equipment]);
  const skinIds = useMemo(() => skins.map((candidate) => candidate.bodyId), [skins]);
  const skinRef = useWheelSelect(skinIds, skin.bodyId, (bodyId) => {
    const next = skins.find((candidate) => candidate.bodyId === bodyId);
    if (next) onSkinChange(next);
  });
  const emotionRef = useWheelSelect(emotions, emotion, onEmotionChange);
  const actionRef = useWheelSelect(actions, action, onActionChange);
  // 已穿部位（含 hair/face），依 SLOT_TABS 順序顯示。
  const wornSlots = SLOT_TABS.filter((slot) => parts[slot]);

  return (
    <div className="avatar-controls">
      <div className="avatar-control-row">
        <label htmlFor="avatar-skin-select">{t("avatar.controls.skin")}</label>
        <select
          ref={skinRef}
          id="avatar-skin-select"
          value={skin.bodyId}
          onChange={(event) => {
            // 換膚色 → bodyId/headId 一起換（SkinInfo 已配對好）。
            const next = skins.find((candidate) => candidate.bodyId === event.target.value);
            if (next) onSkinChange(next);
          }}
        >
          {skins.map((candidate) => (
            <option key={candidate.bodyId} value={candidate.bodyId}>
              {candidate.name}
            </option>
          ))}
        </select>
      </div>

      <div className="avatar-control-row">
        <label htmlFor="avatar-emotion-select">{t("avatar.controls.emotion")}</label>
        <select
          ref={emotionRef}
          id="avatar-emotion-select"
          value={emotion}
          onChange={(event) => onEmotionChange(event.target.value)}
        >
          {emotions.map((candidate) => (
            <option key={candidate} value={candidate}>
              {candidate}
            </option>
          ))}
        </select>
      </div>

      <div className="avatar-control-row">
        <label htmlFor="avatar-action-select">{t("avatar.controls.action")}</label>
        <div className="avatar-action-row">
          <select
            ref={actionRef}
            id="avatar-action-select"
            value={action}
            onChange={(event) => onActionChange(event.target.value)}
          >
            {actions.map((candidate) => (
              <option key={candidate} value={candidate}>
                {candidate}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="avatar-play-button"
            title={playing ? t("common.pause") : t("common.play")}
            aria-label={playing ? t("common.pause") : t("common.play")}
            onClick={onTogglePlaying}
          >
            {playing ? "⏸" : "▶"}
          </button>
        </div>
      </div>

      {/* 臉型顏色 / 髮型顏色：左右並排；臉色用專用名稱表（0–8），白色有資料才列出。 */}
      <div className="avatar-control-row">
        <div className="avatar-color-row">
          <ColorSelect
            id="avatar-face-color-select"
            label={t("avatar.controls.faceColor")}
            value={faceColor}
            options={faceColors}
            names={FACE_COLOR_NAMES}
            onChange={(color) => onColorChange("face", color)}
          />
          <ColorSelect
            id="avatar-hair-color-select"
            label={t("avatar.controls.hairColor")}
            value={hairColor}
            options={HAIR_COLORS}
            names={HAIR_COLOR_NAMES}
            onChange={(color) => onColorChange("hair", color)}
          />
        </div>
      </div>

      {/* 帽子遮髮（hairCover）：勾選時帽子蓋住髮型；不勾時髮型超出帽子。
          髮型陰影（hairShade）：不勾時藏掉髮型的 hairShade 陰影層。 */}
      <div className="avatar-control-row">
        <div className="avatar-checkbox-row">
          <label className="avatar-hair-cover" title={t("avatar.controls.hairCoverTitle")}>
            <input
              type="checkbox"
              checked={hairCover}
              onChange={(event) => onHairCoverChange(event.target.checked)}
            />
            {t("avatar.controls.hairCover")}
          </label>
          <label className="avatar-hair-cover" title={t("avatar.controls.hairShadeTitle")}>
            <input
              type="checkbox"
              checked={hairShade}
              onChange={(event) => onHairShadeChange(event.target.checked)}
            />
            {t("avatar.controls.hairShade")}
          </label>
        </div>
      </div>

      <hr className="avatar-divider" />

      <p className="avatar-equipped-title">{t("avatar.equip.title")}</p>
      {wornSlots.length === 0 ? (
        <p className="avatar-equipped-empty">{t("avatar.equip.empty")}</p>
      ) : (
        wornSlots.map((slot) => {
          const part = parts[slot]!;
          return (
            <AvatarEquipRow
              key={slot}
              slot={slot}
              part={part}
              item={equipById.get(part.id)}
              onToggleVisible={onToggleVisible}
              onRemove={onRemove}
            />
          );
        })
      )}
    </div>
  );
}
