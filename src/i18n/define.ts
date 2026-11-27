// 訊息表的型別工具：繁體中文是基準語言，決定 key 與 {參數} 名稱；
// 简体中文與 English 必須有完全相同的 key（缺少或多出都會編譯失敗）。

/** 非基準語言的訊息表：key 與基準相同，另可為英文複數提供 `<key>_one` 變體。 */
export type Translation<T> = { readonly [K in keyof T]: string } & {
  readonly [K in keyof T as `${K & string}_one`]?: string;
};

export interface NamespaceMessages<T extends Record<string, string>> {
  readonly "zh-TW": T;
  readonly "zh-CN": Translation<T>;
  readonly en: Translation<T>;
}

/**
 * 宣告一個 namespace 的三語訊息表。`const T` 保留繁中字面型別，
 * 讓 t() 能從 `{參數}` 推出必填參數；NoInfer 避免從其他語言反推 key。
 */
export function defineMessages<const T extends Record<string, string>>(messages: {
  readonly "zh-TW": T;
  readonly "zh-CN": NoInfer<Translation<T>>;
  readonly en: NoInfer<Translation<T>>;
}): NamespaceMessages<T> {
  return messages;
}
