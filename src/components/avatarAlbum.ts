import { t } from "../i18n";
import type { PartsState } from "./AvatarPage";

export interface AvatarLook {
  id: string;
  name: string;
  createdAt: number;
  thumbnail: string;
  skinBodyId: string;
  action: string;
  emotion: string;
  hairColor: number;
  faceColor: number;
  hairCover: boolean;
  hairShade: boolean;
  parts: PartsState;
}

const DATABASE_NAME = "msclassic-avatar-album";
const STORE_NAME = "looks";

function openAlbum(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_NAME, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error(t("avatar.albumDb.openFailed")));
    request.onblocked = () => reject(new Error(t("avatar.albumDb.blocked")));
  });
}

export async function listAvatarLooks(): Promise<AvatarLook[]> {
  const db = await openAlbum();
  try {
    return await new Promise<AvatarLook[]>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readonly");
      const request = transaction.objectStore(STORE_NAME).getAll();
      let looks: AvatarLook[] = [];
      request.onsuccess = () => {
        looks = request.result as AvatarLook[];
      };
      transaction.oncomplete = () => resolve(looks.sort((a, b) => b.createdAt - a.createdAt));
      transaction.onerror = () => reject(transaction.error ?? new Error(t("avatar.albumDb.readFailed")));
      transaction.onabort = () => reject(transaction.error ?? new Error(t("avatar.albumDb.readAborted")));
    });
  } finally {
    db.close();
  }
}

export async function saveAvatarLook(look: AvatarLook): Promise<void> {
  const db = await openAlbum();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readwrite");
      transaction.objectStore(STORE_NAME).put(look);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error(t("avatar.albumDb.saveFailed")));
      transaction.onabort = () => reject(transaction.error ?? new Error(t("avatar.albumDb.saveAborted")));
    });
  } finally {
    db.close();
  }
}

export async function deleteAvatarLook(id: string): Promise<void> {
  const db = await openAlbum();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readwrite");
      transaction.objectStore(STORE_NAME).delete(id);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error(t("avatar.albumDb.deleteFailed")));
      transaction.onabort = () => reject(transaction.error ?? new Error(t("avatar.albumDb.deleteAborted")));
    });
  } finally {
    db.close();
  }
}
