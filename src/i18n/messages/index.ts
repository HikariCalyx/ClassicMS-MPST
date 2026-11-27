// 各 namespace 的訊息表彙整；新增 namespace 時兩處都要登記。
// key 一律以 namespace 名稱開頭（例如 "quest.loading"），避免彼此重複。

import app from "./app";
import avatar from "./avatar";
import browse from "./browse";
import common from "./common";
import data from "./data";
import monster from "./monster";
import pet from "./pet";
import quest from "./quest";
import shop from "./shop";
import skill from "./skill";
import sound from "./sound";
import tooltip from "./tooltip";

export const NAMESPACES = [
  app,
  avatar,
  browse,
  common,
  data,
  monster,
  pet,
  quest,
  shop,
  skill,
  sound,
  tooltip,
] as const;

/** 全部 key → 繁中原文的字面型別（t() 由此推出 key 與參數）。 */
export type Catalog = (typeof app)["zh-TW"] &
  (typeof avatar)["zh-TW"] &
  (typeof browse)["zh-TW"] &
  (typeof common)["zh-TW"] &
  (typeof data)["zh-TW"] &
  (typeof monster)["zh-TW"] &
  (typeof pet)["zh-TW"] &
  (typeof quest)["zh-TW"] &
  (typeof shop)["zh-TW"] &
  (typeof skill)["zh-TW"] &
  (typeof sound)["zh-TW"] &
  (typeof tooltip)["zh-TW"];
