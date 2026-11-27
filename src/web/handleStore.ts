// 把 File System Access 的目錄控制代碼存進 IndexedDB(可 structured clone),
// 下次開啟時取回重新連線,不用重新選資料夾。僅 Chromium 系會有資料。

import { t } from "../i18n";

const DB_NAME = "msclassic-handles";
const STORE_NAME = "handles";
const HANDLE_KEY = "data-dir";

export interface StoredFolder {
  handle: FileSystemDirectoryHandle;
  label: string;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error(t("data.error.indexedDbOpen")));
  });
}

/** 儲存目錄控制代碼;失敗(私密模式等)不擋主流程。 */
export async function saveStoredFolder(
  handle: FileSystemDirectoryHandle,
  label: string,
): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).put({ handle, label } satisfies StoredFolder, HANDLE_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error(t("data.error.indexedDbWrite")));
    });
  } catch {
    // 忽略:記不住資料夾只是少了自動重連,功能不受影響。
  }
}

/** 取回上次儲存的目錄控制代碼;沒有或讀取失敗回 null。 */
export async function loadStoredFolder(): Promise<StoredFolder | null> {
  try {
    const db = await openDb();
    return await new Promise<StoredFolder | null>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const request = tx.objectStore(STORE_NAME).get(HANDLE_KEY);
      request.onsuccess = () => resolve((request.result as StoredFolder | undefined) ?? null);
      request.onerror = () => reject(request.error ?? new Error(t("data.error.indexedDbRead")));
    });
  } catch {
    return null;
  }
}
