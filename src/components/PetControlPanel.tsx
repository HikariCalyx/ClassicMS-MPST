import { useEffect, useState } from "react";
import type { PetEquipInfo } from "../api";
import { useI18n } from "../i18n";
import { loadPetIcon } from "./PetShop";

// 已穿寵裝列：icon + 名稱 + × 脫下鈕（比照 AvatarEquipPanel 的 AvatarEquipRow；
// 寵裝只有一件，不需要點列切換顯示的功能）。
function PetEquipRow({ item, onRemove }: { item: PetEquipInfo; onRemove: () => void }) {
  const { t } = useI18n();
  const [icon, setIcon] = useState<string | null>(null);

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
    <div className="avatar-equipped-row">
      <span className="avatar-equipped-icon">{icon ? <img src={icon} alt="" /> : null}</span>
      <span className="avatar-equipped-name">{item.name}</span>
      <button
        type="button"
        className="avatar-equipped-remove"
        title={t("pet.equip.remove")}
        aria-label={t("pet.equip.removeItem", { name: item.name })}
        onClick={onRemove}
      >
        ×
      </button>
    </div>
  );
}

interface PetControlPanelProps {
  /** 動作組清單（不含表情組）。 */
  actions: string[];
  /** 表情組清單。 */
  emotions: string[];
  /** 目前動作名（可能屬於任一組）。 */
  action: string;
  /** 目前動作是否屬於表情組（決定哪個下拉顯示它、哪個顯示「—」）。 */
  isEmotion: boolean;
  onActionChange: (action: string) => void;
  playing: boolean;
  onTogglePlaying: () => void;
  /** 目前穿著的寵裝（null = 未穿）。 */
  equip: PetEquipInfo | null;
  onRemoveEquip: () => void;
}

// 左下控制區：動作/表情下拉 + 播放暫停 + 已穿寵裝（× 脫下）。
export function PetControlPanel({
  actions,
  emotions,
  action,
  isEmotion,
  onActionChange,
  playing,
  onTogglePlaying,
  equip,
  onRemoveEquip,
}: PetControlPanelProps) {
  const { t } = useI18n();
  return (
    <div className="avatar-controls">
      <div className="avatar-control-row">
        <label htmlFor="pet-action-select">{t("pet.controls.action")}</label>
        <div className="avatar-action-row">
          <select
            id="pet-action-select"
            value={isEmotion ? "" : action}
            onChange={(event) => {
              if (event.target.value) onActionChange(event.target.value);
            }}
          >
            {/* 目前動作屬於表情組時，這裡只顯示佔位「—」。 */}
            <option value="" disabled>
              —
            </option>
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

      <div className="avatar-control-row">
        <label htmlFor="pet-emotion-select">{t("pet.controls.emotion")}</label>
        <select
          id="pet-emotion-select"
          value={isEmotion ? action : ""}
          onChange={(event) => {
            if (event.target.value) onActionChange(event.target.value);
          }}
        >
          {/* 目前動作屬於動作組時，這裡只顯示佔位「—」。 */}
          <option value="" disabled>
            —
          </option>
          {emotions.map((candidate) => (
            <option key={candidate} value={candidate}>
              {candidate}
            </option>
          ))}
        </select>
      </div>

      {equip ? (
        <>
          <hr className="avatar-divider" />
          <p className="avatar-equipped-title">{t("pet.equip.title")}</p>
          <PetEquipRow item={equip} onRemove={onRemoveEquip} />
        </>
      ) : null}
    </div>
  );
}
