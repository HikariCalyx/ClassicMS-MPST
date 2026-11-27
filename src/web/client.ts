// 主執行緒端的 Worker RPC client:對齊 worker.ts 的 { id, method, args } 協定,
// 並把 worker 的進度訊息轉發給訂閱者。

import type { ImportProgress } from "../api";
import { t } from "../i18n";
import type { WorkerErrorCode } from "./worker";

type ProgressListener = (progress: ImportProgress | null) => void;

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

/** Worker 回報的失敗；有 code 的錯誤在主執行緒依介面語言組字（Worker 拿不到使用者選的語言）。 */
interface FailedCall {
  id: number;
  ok: false;
  error: string;
  code?: WorkerErrorCode;
  params?: Record<string, string>;
}

function failureMessage(failure: FailedCall): string {
  switch (failure.code) {
    case "storageBusy":
      return t("data.error.storageBusy");
    case "storageFull":
      return t("data.error.storageFull", {
        needed: failure.params?.needed ?? "",
        available: failure.params?.available ?? "",
      });
    default:
      return failure.error;
  }
}

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, PendingCall>();
const progressListeners = new Set<ProgressListener>();

function emitProgress(progress: ImportProgress | null): void {
  for (const listener of progressListeners) listener(progress);
}

function getWorker(): Worker {
  if (worker) return worker;
  const instance = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  instance.onmessage = (event: MessageEvent) => {
    const data = event.data as
      | { type: "progress"; progress: ImportProgress }
      | { id: number; ok: true; result: unknown }
      | FailedCall;
    if ("type" in data && data.type === "progress") {
      emitProgress(data.progress);
      return;
    }
    if (!("id" in data)) return;
    const call = pending.get(data.id);
    if (!call) return;
    pending.delete(data.id);
    if (data.ok) call.resolve(data.result);
    else call.reject(new Error(failureMessage(data)));
  };
  instance.onerror = (event) => {
    const error = new Error(event.message || t("data.error.workerCrashed"));
    for (const call of pending.values()) call.reject(error);
    pending.clear();
  };
  worker = instance;
  return instance;
}

/** 送一次 RPC 給 Worker;Worker 尚未 init 完時會在 Worker 端排隊等待。 */
export function rpc<T>(method: string, ...args: unknown[]): Promise<T> {
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, {
      resolve: (value) => resolve(value as T),
      reject,
    });
    getWorker().postMessage({ id, method, args });
  });
}

/** 訂閱匯入/索引進度;回傳取消訂閱函式。progress 為 null 表示流程結束。 */
export function subscribeProgress(listener: ProgressListener): () => void {
  progressListeners.add(listener);
  return () => {
    progressListeners.delete(listener);
  };
}

/** 結束目前進度顯示(openDataDir 完成或失敗時呼叫)。 */
export function clearProgress(): void {
  emitProgress(null);
}
