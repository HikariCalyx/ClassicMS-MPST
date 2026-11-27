// 資料夾選擇與路徑解析(複刻 src-tauri/src/gui.rs 的 resolve_data_root)。
//
// 兩種選擇管道:
// 1. File System Access(showDirectoryPicker,Chromium 限定):拿到可存入
//    IndexedDB 的目錄控制代碼,下次可重新連線不用重選;但 Chromium 有系統目錄
//    封鎖清單(AppData、Downloads、Program Files、磁碟根等會被原生對話框擋下
//    「包含系統檔案」),被擋時對話框內只能取消,程式端收到 AbortError。
// 2. <input type="file" webkitdirectory>(全瀏覽器):無封鎖清單,但 File 物件
//    無法跨 session 保存,關閉後只能重選。
// 支援 FSA 時優先走 1;取消或失敗時記一次性旗標,下一次點擊改走 2
// (不能在取消當下串聯開 2:transient user activation 可能已過期,
// input.click() 會被靜默擋下)。走 2 才選成功的位置視為被封鎖,
// 之後固定走 2(見 FSA_DISABLED_KEY)。

import { t } from "../i18n";
import { loadStoredFolder, saveStoredFolder } from "./handleStore";

export interface PickedFolder {
  /** 顯示用路徑(選到的根 + 候選子路徑)。 */
  label: string;
  /** 該層目錄下的 *.bundle 檔案(依檔名排序)。 */
  files: File[];
}

export interface PickFolderOptions {
  /** 直接使用不受 Chromium 系統目錄封鎖的 webkitdirectory 選擇器。 */
  preferCompatibility?: boolean;
}

// 候選層級,順序與 gui.rs resolve_data_root 一致。
const CANDIDATES = [
  "",
  "w",
  "aa/w",
  "StreamingAssets/aa/w",
  "Maplestory_Classic_Data/StreamingAssets/aa/w",
];

/** 選到的資料夾裡找不到 bundle(選錯層級);與使用者取消區分。 */
class NoBundleError extends Error {
  constructor(folderName: string) {
    super(t("data.error.noBundles", { path: folderName }));
  }
}

function isBundleName(name: string): boolean {
  return name.toLowerCase().endsWith(".bundle");
}

function sortByName(files: File[]): File[] {
  return files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

// Chromium 的 showDirectoryPicker 有系統目錄封鎖清單(Downloads、Program Files、
// 磁碟根等),遊戲資料夾很常落在這些位置;被封鎖時錯誤只顯示在原生對話框內,
// 使用者只能取消,程式端收到的仍是 AbortError,無法與主動取消區分。
// 注意:不能在取消後立刻 input.click() 串聯開相容選擇器——檔案選擇器需要
// transient user activation,使用者在 FSA 對話框停留太久效期就過了,
// click() 會被瀏覽器靜默擋下。因此取消時改記一次性旗標(fsaRetryWithInput),
// 下次點擊(新的使用者手勢)直接走 webkitdirectory;若那次選成功,代表該位置
// 很可能在封鎖清單上,之後固定走 webkitdirectory(FSA_DISABLED_KEY)。
const FSA_DISABLED_KEY = "msclassic-fsa-disabled";

// FSA 對話框被取消/失敗時設定,下一次點擊改用 webkitdirectory(一次性)。
let fsaRetryWithInput = false;

/** 主入口:回傳 null 表示使用者取消。支援 FSA 時預設優先走 showDirectoryPicker。 */
export async function pickFolder(
  options: PickFolderOptions = {},
): Promise<PickedFolder | null> {
  const fsaAvailable =
    !options.preferCompatibility &&
    typeof window.showDirectoryPicker === "function" &&
    !localStorage.getItem(FSA_DISABLED_KEY) &&
    !fsaRetryWithInput;
  if (fsaAvailable) {
    try {
      const handle = await window.showDirectoryPicker({ id: "msclassic-data", mode: "read" });
      const picked = await fromDirectoryHandle(handle);
      // 記住控制代碼,下次可重新連線;寫入失敗不影響本次開啟。
      void saveStoredFolder(handle, picked.label);
      return picked;
    } catch (error) {
      // 找不到 bundle 是選錯資料夾,直接報錯;其餘(含 AbortError)記旗標後返回,
      // 由使用者的下一次點擊走相容選擇器。
      if (error instanceof NoBundleError) throw error;
      fsaRetryWithInput = true;
      return null;
    }
  }
  const picked = await pickViaInput();
  if (picked) {
    fsaRetryWithInput = false;
    if (
      !options.preferCompatibility &&
      typeof window.showDirectoryPicker === "function" &&
      !localStorage.getItem(FSA_DISABLED_KEY)
    ) {
      // 用相容選擇器才選成功:該位置很可能在封鎖清單上,之後固定走相容選擇器
      // (清除網站資料可重置)。
      localStorage.setItem(FSA_DISABLED_KEY, "1");
    }
  }
  return picked;
}

/** 重新連線上次用 showDirectoryPicker 選過的資料夾;沒記錄或未獲授權回 null。 */
export async function reconnectStoredFolder(): Promise<PickedFolder | null> {
  const stored = await loadStoredFolder();
  if (!stored) return null;
  const { handle } = stored;
  if ((await handle.queryPermission({ mode: "read" })) !== "granted") {
    // requestPermission 需要使用者手勢,呼叫端需由點擊觸發。
    if ((await handle.requestPermission({ mode: "read" })) !== "granted") return null;
  }
  return fromDirectoryHandle(handle);
}

/** 查詢是否有記住的資料夾,以及權限是否還在(granted 時可免手勢自動重連)。 */
export async function storedFolderState(): Promise<{ label: string; granted: boolean } | null> {
  const stored = await loadStoredFolder();
  if (!stored) return null;
  try {
    const granted = (await stored.handle.queryPermission({ mode: "read" })) === "granted";
    return { label: stored.label, granted };
  } catch {
    return { label: stored.label, granted: false };
  }
}

/** webkitdirectory 管道:全瀏覽器可用,無封鎖清單。 */
function pickViaInput(): Promise<PickedFolder | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.webkitdirectory = true;
    input.addEventListener("change", () => {
      try {
        resolve(fromFileList(Array.from(input.files ?? [])));
      } catch (error) {
        reject(error);
      }
    });
    // Chromium 110+ / Safari 16.4+ 有 cancel 事件;舊瀏覽器取消時無事件,只能放著。
    input.addEventListener("cancel", () => resolve(null));
    input.click();
  });
}

/** 依候選層級往下鑽,任一層不存在回 null。 */
async function navigateCandidate(
  root: FileSystemDirectoryHandle,
  candidate: string,
): Promise<FileSystemDirectoryHandle | null> {
  let dir = root;
  for (const segment of candidate.split("/")) {
    if (!segment) continue;
    try {
      dir = await dir.getDirectoryHandle(segment);
    } catch {
      return null;
    }
  }
  return dir;
}

/** File System Access 管道:走同一組候選層級找 *.bundle。 */
async function fromDirectoryHandle(root: FileSystemDirectoryHandle): Promise<PickedFolder> {
  for (const candidate of CANDIDATES) {
    const dir = await navigateCandidate(root, candidate);
    if (!dir) continue;
    const files: File[] = [];
    for await (const entry of dir.values()) {
      if (entry.kind === "file" && isBundleName(entry.name)) {
        files.push(await (entry as FileSystemFileHandle).getFile());
      }
    }
    if (files.length > 0) {
      return {
        label: candidate ? `${root.name}/${candidate}` : root.name,
        files: sortByName(files),
      };
    }
  }
  throw new NoBundleError(root.name);
}

/** 從 file.webkitRelativePath 判斷層級。 */
function fromFileList(files: File[]): PickedFolder | null {
  if (files.length === 0) return null;
  // webkitRelativePath = "<選到的根>/<...子路徑>/<檔名>"
  const rootName = files[0].webkitRelativePath.split("/")[0] ?? "";
  for (const candidate of CANDIDATES) {
    const matches = files.filter((file) => {
      if (!isBundleName(file.name)) return false;
      const segments = file.webkitRelativePath.split("/");
      const dirPart = segments.slice(1, -1).join("/");
      return dirPart === candidate;
    });
    if (matches.length > 0) {
      return {
        label: candidate ? `${rootName}/${candidate}` : rootName,
        files: sortByName(matches),
      };
    }
  }
  throw new NoBundleError(rootName);
}
