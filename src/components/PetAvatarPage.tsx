import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  getPetEquipList,
  getPetFrames,
  getPetList,
  type AvatarFrames,
  type PetEquipInfo,
  type PetInfo,
} from "../api";
import { useI18n } from "../i18n";
import { AvatarPreview } from "./AvatarPreview";
import { PetControlPanel } from "./PetControlPanel";
import { PetShop } from "./PetShop";

// 表情組動作（出現在左下「表情」下拉）；其餘（含未知）歸「動作」組。
const EMOTION_ACTIONS = new Set([
  "chat",
  "angry",
  "cry",
  "love",
  "smile",
  "hug",
  "melong",
  "no",
  "good",
  "stunned",
]);

// 預設動作；寵物沒有 stand0 時退用它清單的第一個動作。
const DEFAULT_ACTION = "stand0";

// 寵物紙娃娃頁：試穿狀態集中在這裡，預覽/控制區/商店都是受控元件（比照 AvatarPage 精簡版）。
export function PetAvatarPage({
  visible,
  onPickItem,
}: {
  visible: boolean;
  /** 點商店卡片時回報寵物/寵裝 img 路徑（給 App footer 麵包屑）。 */
  onPickItem?: (path: string) => void;
}) {
  const { t } = useI18n();
  const [pets, setPets] = useState<PetInfo[] | null>(null);
  const [equips, setEquips] = useState<PetEquipInfo[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [petId, setPetId] = useState<string | null>(null);
  const [action, setAction] = useState(DEFAULT_ACTION);
  const [playing, setPlaying] = useState(true);
  const [equipId, setEquipId] = useState<string | null>(null);
  const [frames, setFrames] = useState<AvatarFrames | null>(null);
  const [framesLoading, setFramesLoading] = useState(false);
  const [framesError, setFramesError] = useState<string | null>(null);
  const framesGenerationRef = useRef(0);

  const pet = useMemo(() => pets?.find((candidate) => candidate.id === petId) ?? null, [pets, petId]);
  const equip = useMemo(
    () => equips?.find((candidate) => candidate.id === equipId) ?? null,
    [equips, equipId],
  );

  // 動作/表情分組：表情組進「表情」下拉，其餘（含未知）進「動作」下拉。
  const { actions, emotions } = useMemo(() => {
    const nextActions: string[] = [];
    const nextEmotions: string[] = [];
    for (const name of pet?.actions ?? []) {
      (EMOTION_ACTIONS.has(name) ? nextEmotions : nextActions).push(name);
    }
    return { actions: nextActions, emotions: nextEmotions };
  }, [pet]);
  const isEmotion = EMOTION_ACTIONS.has(action);

  // 寵物 + 寵裝清單：第一次切到寵物頁（此元件掛載）才載入，之後保持。
  useEffect(() => {
    let active = true;
    Promise.all([getPetList(), getPetEquipList()])
      .then(([nextPets, nextEquips]) => {
        if (!active) return;
        setPets(nextPets);
        setEquips(nextEquips);
        if (nextPets.length > 0) {
          setPetId((previous) => previous ?? nextPets[0].id);
          // 後端動作清單若沒有 stand0，退用第一個動作。
          if (
            !nextPets[0].actions.includes(DEFAULT_ACTION) &&
            nextPets[0].actions.length > 0
          ) {
            setAction(nextPets[0].actions[0]);
          }
        }
      })
      .catch((nextError) => {
        if (active) setLoadError(String(nextError));
      });
    return () => {
      active = false;
    };
  }, []);

  // 換寵物：對不上的寵裝脫下；新寵物沒有當前動作時退回 stand0（沒有 stand0 退第一個動作）。
  const changePet = useCallback(
    (nextPetId: string) => {
      setPetId(nextPetId);
      const nextPet = pets?.find((candidate) => candidate.id === nextPetId);
      setEquipId((previous) => {
        if (previous == null) return previous;
        const worn = equips?.find((candidate) => candidate.id === previous);
        if (worn && !worn.petIds.includes(Number(nextPetId))) return null;
        return previous;
      });
      setAction((previous) => {
        if (!nextPet || nextPet.actions.includes(previous)) return previous;
        if (nextPet.actions.includes(DEFAULT_ACTION)) return DEFAULT_ACTION;
        return nextPet.actions[0] ?? DEFAULT_ACTION;
      });
    },
    [pets, equips],
  );

  // 任何 pet/action/equipId 變更 → 重取合成幀（generation guard 防舊回應覆蓋）。
  useEffect(() => {
    if (!pet) return;
    const generation = ++framesGenerationRef.current;
    setFramesLoading(true);
    setFramesError(null);
    getPetFrames(pet.id, equipId, action)
      .then((result) => {
        if (generation === framesGenerationRef.current) setFrames(result);
      })
      .catch((nextError) => {
        if (generation === framesGenerationRef.current) setFramesError(String(nextError));
      })
      .finally(() => {
        if (generation === framesGenerationRef.current) setFramesLoading(false);
      });
  }, [pet, action, equipId]);

  let content;
  if (loadError) {
    content = <p className="pet-page-status">{t("pet.page.loadFailed", { error: loadError })}</p>;
  } else if (!pets || !equips) {
    content = <p className="pet-page-status">{t("pet.page.loading")}</p>;
  } else if (!pet) {
    content = <p className="pet-page-status">{t("pet.page.noPet")}</p>;
  } else {
    content = (
      <>
        <aside className="pet-left">
          <div className="pet-left-preview">
            <AvatarPreview
              frames={frames}
              loading={framesLoading}
              error={framesError}
              playing={playing}
              active={visible}
              action={action}
            />
          </div>
          <div className="pet-left-controls">
            <PetControlPanel
              actions={actions}
              emotions={emotions}
              action={action}
              isEmotion={isEmotion}
              onActionChange={setAction}
              playing={playing}
              onTogglePlaying={() => setPlaying((previous) => !previous)}
              equip={equip}
              onRemoveEquip={() => setEquipId(null)}
            />
          </div>
        </aside>
        <section className="pet-right">
          <PetShop
            pets={pets}
            equips={equips}
            petId={pet.id}
            equipId={equipId}
            onSelectPet={changePet}
            onToggleEquip={setEquipId}
            onPickItem={onPickItem}
          />
        </section>
      </>
    );
  }

  return (
    <div className="pet-page" hidden={!visible}>
      {content}
    </div>
  );
}
