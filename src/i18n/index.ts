// 介面語言（UI i18n）：繁體中文、简体中文、English。
//
// 與 src/locale.ts 的「資料語系」是兩回事：這裡只管程式自己顯示的文字；
// 遊戲資料裡的名稱、說明與台詞一律照資料原文顯示，不隨介面語言轉換。
//
// 預設語言：使用者在介面上選過的語言（localStorage）優先；沒選過就跟隨
// 作業系統／瀏覽器語言（navigator.language / languages，桌面版的 WebView2
// 由 wry 設成 Windows 顯示語言）；都不是中文或英文時用 English。
//
// 訊息表在 messages/<namespace>.ts，每檔三種語言並列。t("ns.key", { 參數 })
// 會依目前語言組字；`{count}` 是數字且該語言有 `<key>_one` 時，count 為 1 用單數。
// React 元件用 useI18n() 取得 t，語言切換時會重新渲染；非元件模組直接 import t。

import { useMemo, useSyncExternalStore } from "react";
import { NAMESPACES, type Catalog } from "./messages";

export type Language = "zh-TW" | "zh-CN" | "en";

/** 語言選單的選項；名稱用各語言自己的寫法，切到看不懂的語言也找得回來。 */
export const LANGUAGES: readonly { code: Language; label: string }[] = [
  { code: "zh-TW", label: "繁體中文" },
  { code: "zh-CN", label: "简体中文" },
  { code: "en", label: "English" },
];

const STORAGE_KEY = "msclassic.uiLanguage";
const FALLBACK_LANGUAGE: Language = "en";
/** `<html lang>`：讓瀏覽器為中文挑對應字形（繁中與簡中字形不同）。 */
const HTML_LANG: Record<Language, string> = { "zh-TW": "zh-Hant", "zh-CN": "zh-Hans", en: "en" };

export type MessageKey = keyof Catalog & string;
type ParamValue = string | number;
type Placeholders<S> = S extends `${string}{${infer Name}}${infer Rest}`
  ? Name | Placeholders<Rest>
  : never;
export type MessageParams<K extends MessageKey> = Record<Placeholders<Catalog[K]>, ParamValue>;
type TArgs<K extends MessageKey> = [Placeholders<Catalog[K]>] extends [never]
  ? []
  : [params: MessageParams<K>];
export type TFunction = <K extends MessageKey>(key: K, ...args: TArgs<K>) => string;

type Dictionary = Readonly<Record<string, string>>;

function mergeNamespaces(language: Language): Dictionary {
  return Object.assign({}, ...NAMESPACES.map((namespace) => namespace[language]));
}

const DICTIONARIES: Record<Language, Dictionary> = {
  "zh-TW": mergeNamespaces("zh-TW"),
  "zh-CN": mergeNamespaces("zh-CN"),
  en: mergeNamespaces("en"),
};

export function isLanguage(value: unknown): value is Language {
  return value === "zh-TW" || value === "zh-CN" || value === "en";
}

/** BCP 47 語言標籤 → 支援的介面語言；不支援的語言回 null。 */
export function matchLanguage(tag: string): Language | null {
  const subtags = tag.toLowerCase().replace(/_/g, "-").split("-");
  if (subtags[0] === "en") return "en";
  if (subtags[0] !== "zh") return null;
  if (subtags.includes("hans")) return "zh-CN";
  if (subtags.includes("hant")) return "zh-TW";
  return subtags.some((subtag) => subtag === "tw" || subtag === "hk" || subtag === "mo")
    ? "zh-TW"
    : "zh-CN";
}

/** 依偏好順序取第一個支援的語言；都不支援時用 English。 */
export function detectSystemLanguage(): Language {
  if (typeof navigator === "undefined") return FALLBACK_LANGUAGE;
  for (const tag of [navigator.language, ...(navigator.languages ?? [])]) {
    const language = tag ? matchLanguage(tag) : null;
    if (language) return language;
  }
  return FALLBACK_LANGUAGE;
}

function readStoredLanguage(): Language | null {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return isLanguage(stored) ? stored : null;
  } catch {
    return null;
  }
}

let current: Language = readStoredLanguage() ?? detectSystemLanguage();
const listeners = new Set<() => void>();
const pluralRules = new Map<Language, Intl.PluralRules>();

function pluralCategory(language: Language, count: number): string {
  let rules = pluralRules.get(language);
  if (!rules) {
    rules = new Intl.PluralRules(language);
    pluralRules.set(language, rules);
  }
  return rules.select(count);
}

function translate(language: Language, key: string, params?: Record<string, ParamValue>): string {
  const dictionary = DICTIONARIES[language];
  let template: string | undefined;
  const count = params?.count;
  if (typeof count === "number") {
    const category = pluralCategory(language, count);
    if (category !== "other") template = dictionary[`${key}_${category}`];
  }
  template ??= dictionary[key] ?? DICTIONARIES["zh-TW"][key] ?? key;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match,
  );
}

function createTranslator(): TFunction {
  return ((key: string, params?: Record<string, ParamValue>) =>
    translate(current, key, params)) as TFunction;
}

/** 以目前介面語言翻譯（非 React 模組用；每次呼叫都讀最新語言）。 */
export const t: TFunction = createTranslator();

export function getLanguage(): Language {
  return current;
}

function applyDocumentLanguage(): void {
  if (typeof document === "undefined") return;
  document.documentElement.lang = HTML_LANG[current];
  document.title = t("app.title");
}

/** 切換介面語言並記住選擇（之後不再跟隨系統語言）。 */
export function setLanguage(language: Language): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, language);
  } catch {
    // 無法寫入時只影響「記住選擇」，本次切換照常生效。
  }
  if (language === current) return;
  current = language;
  applyDocumentLanguage();
  for (const listener of listeners) listener();
}

export function subscribeLanguage(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * React 元件取得目前語言與 t；語言切換時元件會重新渲染。
 * t 每個語言換一個函式參照（放進 useMemo/useCallback 依賴即可隨語言重算），
 * 但呼叫時一律讀目前語言，callback 的舊閉包也不會留在切換前的語言。
 */
export function useI18n(): { language: Language; t: TFunction } {
  const language = useSyncExternalStore(subscribeLanguage, getLanguage, getLanguage);
  return useMemo(() => ({ language, t: createTranslator() }), [language]);
}

applyDocumentLanguage();

// 開發時檢查：namespace 之間 key 重複、各語言的 {參數} 與繁中不一致。
if (import.meta.env.DEV) {
  const placeholders = (text: string) =>
    [...text.matchAll(/\{(\w+)\}/g)]
      .map((match) => match[1])
      .sort()
      .join(",");
  const seen = new Set<string>();
  for (const namespace of NAMESPACES) {
    for (const key of Object.keys(namespace["zh-TW"])) {
      if (seen.has(key)) console.warn(`[i18n] key 重複：${key}`);
      seen.add(key);
    }
  }
  const base = DICTIONARIES["zh-TW"];
  for (const language of ["zh-CN", "en"] as const) {
    for (const [key, text] of Object.entries(DICTIONARIES[language])) {
      const baseKey = key.endsWith("_one") ? key.slice(0, -"_one".length) : key;
      if (placeholders(text) !== placeholders(base[baseKey] ?? "")) {
        console.warn(`[i18n] ${language} 的 ${key} 參數與繁中不一致`);
      }
    }
  }
}
