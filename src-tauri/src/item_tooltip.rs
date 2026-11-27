//! 裝備 tooltip 聚合：給定節點路徑，彙整 info 屬性、icon 圖與
//! `String/TW/Item` 的名稱/說明，回傳前端 tooltip 卡片所需的一切。
//! 欄位解碼邏輯對齊 Harepacker-MPST 的 `wz/item_tooltip.rs`（gear 部分）。
//! 分類、職業、屬性與能力值只回代碼與原始數值，顯示文字由前端依介面語言決定
//! （src/i18n/messages/tooltip.ts）。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use base64::Engine;
use serde::Serialize;

use crate::catalog::{split_img_prefix, DataService, Result};
use crate::commodity::item_path_candidates;
use crate::wzjs::{Value, WzNode};

/// 對齊 MPST 的 GEAR_STAT_LABELS（順序即顯示順序）。
const GEAR_STAT_KEYS: &[&str] = &[
    "incSTR", "incDEX", "incINT", "incLUK", "incMHP", "incMMP", "incPAD", "incMAD", "incPDD",
    "incMDD", "incACC", "incEVA", "incSpeed", "incJump", "tuc",
];

const ALL_JOBS: &[&str] = &[
    "beginner", "warrior", "magician", "bowman", "thief", "pirate",
];
const JOB_MASKS: &[(i64, &str)] = &[
    (1, "warrior"),
    (2, "magician"),
    (4, "bowman"),
    (8, "thief"),
    (16, "pirate"),
];

/// `String/TW/Item` text_asset 解析後的名稱表：道具 id →（名稱, 說明）。
pub(crate) type ItemNameTable = HashMap<u32, (String, Option<String>)>;

/// 名稱表懶載入快取（1.2MB JSON 只需解析一次；跟隨 DataService 生命週期，
/// 更換資料集時自動重建）。
#[derive(Default)]
pub(crate) struct TooltipNameCache(Mutex<Option<Arc<ItemNameTable>>>);

/// 裝備能力值：`info` 的屬性名與原始數值（0 不列）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TooltipStat {
    pub key: &'static str,
    pub value: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemTooltip {
    pub item_id: String,
    /// 裝備 img 根路徑（例如 `Character/Weapon/01302000`）。
    pub img_path: String,
    /// 道具名稱；字串表沒有這個道具時為 item_id。
    pub title: String,
    pub description: Option<String>,
    /// `info/reqGender`：0 = 男、1 = 女；沒有限制時為 None。
    pub req_gender: Option<i64>,
    /// 裝備分類代碼（cap、coat、weapon、face…）。
    pub category: &'static str,
    /// 武器種類代碼（oneHandedSword、bow…）；不是已知武器時為 None。
    pub weapon_type: Option<&'static str>,
    /// 圖示的 PNG base64：`info/icon`，髮型/臉型則是預設外觀圖；取圖失敗時為 None。
    pub icon_base64: Option<String>,
    pub required_level: i64,
    pub required_str: i64,
    pub required_dex: i64,
    pub required_int: i64,
    pub required_luk: i64,
    /// 可裝備的職業代碼（beginner、warrior、magician、bowman、thief、pirate）。
    pub required_jobs: Vec<&'static str>,
    /// 道具屬性代碼（only、cash、timeLimited、tradeBlock、accountSharable、onlyEquip）。
    pub attributes: Vec<&'static str>,
    /// `info/attackSpeed` 原始值。
    pub attack_speed: Option<i64>,
    pub scroll_count: Option<i64>,
    pub stats: Vec<TooltipStat>,
}

impl DataService {
    /// 路徑指向裝備（Character 下 8 碼數字 img 或其內部節點）時回傳 tooltip；
    /// 非裝備路徑回 Ok(None)。
    pub fn get_item_tooltip(&self, path: &str) -> Result<Option<ItemTooltip>> {
        let Some((img_path, category_hint)) = self.gear_img_path(path) else {
            return Ok(None);
        };
        self.build_tooltip(img_path, category_hint)
    }

    /// 以道具 id 取 tooltip（怪物圖鑑戰利品 hover 用）；支援所有類別
    /// （Character / Item 各分區），id 查無 img 時回 Ok(None)。
    pub fn get_item_tooltip_by_id(&self, item_id: u32) -> Result<Option<ItemTooltip>> {
        let id = format!("{item_id:08}");
        // Character 直屬 img（0002xxxx 臉型、0003~0005 髮型等）。
        let direct = format!("Character/{id}");
        if self.catalog.entries.contains_key(&direct) {
            return self.build_tooltip(direct, String::new());
        }
        // Character/<分類目錄>/<id>：只掃 Character 前綴區間。
        let prefix = "Character/";
        let found = self
            .catalog
            .entries
            .range(prefix.to_string()..)
            .take_while(|(key, _)| key.starts_with(prefix))
            .find_map(|(key, _)| {
                let rest = key.strip_prefix(prefix)?;
                let (category, last) = rest.split_once('/')?;
                if last == id && !last.contains('/') {
                    Some((key.clone(), category.to_string()))
                } else {
                    None
                }
            });
        if let Some((img_path, category_hint)) = found {
            return self.build_tooltip(img_path, category_hint);
        }
        // 非裝備（Item/Consume、Etc、Install、Cash、Pet、Special）：
        // 依 id 規則推候選路徑（對齊 commodity.rs），逐一嘗試。
        for candidate in
            item_path_candidates(item_id, |path| self.catalog.entries.contains_key(path))
        {
            let Some((img_key, inner)) = split_img_prefix(&self.catalog, &candidate) else {
                continue;
            };
            let Ok(tree) = self.tree_for(&img_key) else {
                continue;
            };
            let node = if inner.is_empty() {
                tree.as_ref()
            } else {
                match tree.find(&inner) {
                    Some(node) => node,
                    None => continue,
                }
            };
            if let Some(tooltip) = self.build_tooltip_from_node(candidate, node, String::new())? {
                return Ok(Some(tooltip));
            }
        }
        Ok(None)
    }

    /// 由裝備 img 根路徑聚合 tooltip 內容。
    fn build_tooltip(
        &self,
        img_path: String,
        category_hint: String,
    ) -> Result<Option<ItemTooltip>> {
        let tree = self.tree_for(&img_path)?;
        self.build_tooltip_from_node(img_path, &tree, category_hint)
    }

    /// 由道具根節點（Character img 根或 Item img 內的道具節點）聚合 tooltip 內容。
    fn build_tooltip_from_node(
        &self,
        root_path: String,
        root: &WzNode,
        category_hint: String,
    ) -> Result<Option<ItemTooltip>> {
        let Some(info) = root.find("info") else {
            return Ok(None);
        };
        let item_id = root_path.rsplit('/').next().unwrap_or_default().to_string();

        let numeric_id = item_id.parse::<u32>().unwrap_or(0);
        let names = self.item_names()?;
        let (title, description) = names
            .get(&numeric_id)
            .map(|(n, d)| (n.clone(), d.clone()))
            .unwrap_or_else(|| (item_id.clone(), None));
        let req_gender = prop_i64(info, "reqGender").filter(|gender| matches!(gender, 0 | 1));

        let icon_base64 = self.tooltip_icon(&root_path, &item_id, &category_hint)?;

        let category = gear_category(&item_id, &category_hint);
        let weapon_type = weapon_type(&item_id);
        let scroll_count = prop_i64(info, "tuc");

        Ok(Some(ItemTooltip {
            item_id,
            img_path: root_path,
            title,
            description: description.filter(|d| !d.trim().is_empty()),
            req_gender,
            category,
            weapon_type,
            icon_base64,
            required_level: prop_i64(info, "reqLevel").unwrap_or(0),
            required_str: prop_i64(info, "reqSTR").unwrap_or(0),
            required_dex: prop_i64(info, "reqDEX").unwrap_or(0),
            required_int: prop_i64(info, "reqINT").unwrap_or(0),
            required_luk: prop_i64(info, "reqLUK").unwrap_or(0),
            required_jobs: required_jobs(prop_i64(info, "reqJob")),
            attributes: gear_attributes(info),
            attack_speed: prop_i64(info, "attackSpeed"),
            scroll_count,
            stats: gear_stats(info),
        }))
    }

    /// 取 tooltip 圖示：一般裝備用 `info/icon`；髮型/臉型沒有 icon，
    /// 改用預設外觀圖（`default/hairOverHead` / `default/face`）。
    fn tooltip_icon(
        &self,
        img_path: &str,
        item_id: &str,
        category_hint: &str,
    ) -> Result<Option<String>> {
        let encode = |png: Vec<u8>| base64::engine::general_purpose::STANDARD.encode(png);
        if let Some(png) = self.get_image(&format!("{img_path}/info/icon"))? {
            return Ok(Some(encode(png)));
        }
        let inner = match category_hint.to_lowercase().as_str() {
            "hair" => Some("default/hairOverHead"),
            "face" => Some("default/face"),
            // Character 直屬的 0002xxxx（臉型）/0003~0005（髮型）。
            _ => match item_id.parse::<u32>().unwrap_or(0) / 10000 {
                2 => Some("default/face"),
                3..=5 => Some("default/hairOverHead"),
                _ => None,
            },
        };
        match inner {
            Some(inner) => Ok(self.get_image(&format!("{img_path}/{inner}"))?.map(encode)),
            None => Ok(None),
        }
    }

    /// 把任意路徑收斂成裝備 img 根路徑；順便回傳分類提示（目錄名）。
    fn gear_img_path(&self, path: &str) -> Option<(String, String)> {
        let segments: Vec<&str> = path.split('/').collect();
        if segments.first() != Some(&"Character") {
            return None;
        }
        let is_id = |s: &str| s.len() == 8 && s.bytes().all(|b| b.is_ascii_digit());
        let (img_path, hint) = if segments.len() >= 2 && is_id(segments[1]) {
            (format!("Character/{}", segments[1]), String::new())
        } else if segments.len() >= 3 && is_id(segments[2]) {
            (
                format!("Character/{}/{}", segments[1], segments[2]),
                segments[1].to_string(),
            )
        } else {
            return None;
        };
        if !self.catalog.entries.contains_key(&img_path) {
            return None;
        }
        Some((img_path, hint))
    }

    /// 懶載入 `String/TW/Item` 名稱表；資料集沒有此資產時視為空表。
    pub(crate) fn item_names(&self) -> Result<Arc<ItemNameTable>> {
        let mut guard = self
            .tooltip_name_cache
            .0
            .lock()
            .map_err(|error| crate::catalog::CatalogError::CacheInvalid(error.to_string()))?;
        if let Some(table) = guard.as_ref() {
            return Ok(table.clone());
        }
        let table = Arc::new(self.load_item_names()?);
        *guard = Some(table.clone());
        Ok(table)
    }

    fn load_item_names(&self) -> Result<ItemNameTable> {
        let mut table = ItemNameTable::new();
        let Ok(node) = self.get_node(&self.string_path("Item")) else {
            return Ok(table);
        };
        let Some(text) = node.text_asset else {
            return Ok(table);
        };
        let Ok(serde_json::Value::Object(map)) = serde_json::from_str(&text) else {
            return Ok(table);
        };
        for (key, value) in map {
            let Ok(id) = key.parse::<u32>() else {
                continue;
            };
            let Some(name) = value.get("name").and_then(|v| v.as_str()) else {
                continue;
            };
            let desc = value
                .get("desc")
                .and_then(|v| v.as_str())
                .map(str::to_string);
            table.insert(id, (name.to_string(), desc));
        }
        Ok(table)
    }
}

fn prop<'a>(info: &'a WzNode, name: &str) -> Option<&'a WzNode> {
    info.children
        .iter()
        .find(|child| child.name.eq_ignore_ascii_case(name))
}

fn prop_i64(info: &WzNode, name: &str) -> Option<i64> {
    prop(info, name).and_then(|node| value_as_i64(&node.value))
}

fn prop_bool(info: &WzNode, name: &str) -> bool {
    prop_i64(info, name).is_some_and(|value| value != 0)
}

fn value_as_i64(value: &Value) -> Option<i64> {
    match value {
        Value::U8(v) => Some(i64::from(*v)),
        Value::U16(v) => Some(i64::from(*v)),
        Value::Int(v) => Some(i64::from(*v)),
        Value::Long(v) => Some(*v),
        Value::Int2(a, _) => Some(i64::from(*a)),
        Value::Double(v) => Some(*v as i64),
        _ => None,
    }
}

fn gear_attributes(info: &WzNode) -> Vec<&'static str> {
    let mut attributes = Vec::new();
    if prop_bool(info, "only") {
        attributes.push("only");
    }
    if prop_bool(info, "cash") {
        attributes.push("cash");
    }
    if prop_bool(info, "timeLimited") {
        attributes.push("timeLimited");
    }
    if prop_bool(info, "tradeBlock") {
        attributes.push("tradeBlock");
    } else if prop_bool(info, "accountSharable") {
        attributes.push("accountSharable");
    }
    if prop_bool(info, "onlyEquip") {
        attributes.push("onlyEquip");
    }
    attributes
}

fn gear_stats(info: &WzNode) -> Vec<TooltipStat> {
    GEAR_STAT_KEYS
        .iter()
        .filter_map(|&key| {
            let value = prop_i64(info, key)?;
            (value != 0).then_some(TooltipStat { key, value })
        })
        .collect()
}

fn required_jobs(req_job: Option<i64>) -> Vec<&'static str> {
    match req_job {
        None | Some(0) => ALL_JOBS.to_vec(),
        Some(job) => {
            let jobs: Vec<&'static str> = JOB_MASKS
                .iter()
                .filter(|(mask, _)| job & mask != 0)
                .map(|&(_, code)| code)
                .collect();
            if jobs.is_empty() {
                ALL_JOBS.to_vec()
            } else {
                jobs
            }
        }
    }
}

/// 8 碼裝備 id 的前 3 位分類碼（id 開頭必為 0，例如 01302000 → 130）。
fn id_prefix3(item_id: &str) -> u32 {
    item_id.parse::<u32>().unwrap_or(0) / 10000
}

/// 裝備分類代碼：先看 id 分類碼，再看所在目錄名。
fn gear_category(item_id: &str, category_hint: &str) -> &'static str {
    match id_prefix3(item_id) {
        100 => "cap",
        101 => "faceAccessory",
        102 => "eyeAccessory",
        103 => "earrings",
        104 => "coat",
        105 => "longcoat",
        106 => "pants",
        107 => "shoes",
        108 => "glove",
        109 => "shield",
        110 => "cape",
        111 => "ring",
        112 => "pendant",
        113 => "belt",
        114 => "medal",
        115 => "shoulder",
        121..=159 => "weapon",
        _ => match category_hint.to_lowercase().as_str() {
            "accessory" => "accessory",
            "cap" => "cap",
            "coat" => "coat",
            "longcoat" => "longcoat",
            "pants" => "pants",
            "shoes" => "shoes",
            "glove" => "glove",
            "shield" => "shield",
            "cape" => "cape",
            "weapon" => "weapon",
            "ring" => "ring",
            "petequip" => "petEquip",
            "tamingmob" => "tamingMob",
            "face" => "face",
            "hair" => "hair",
            _ => {
                // Character 直屬的 0002xxxx（臉型）/0003~0005（髮型）。
                match item_id.parse::<u32>().unwrap_or(0) / 10000 {
                    2 => "face",
                    3..=5 => "hair",
                    _ => "equip",
                }
            }
        },
    }
}

/// 武器種類代碼；前端有此代碼時顯示「武器分類」，否則顯示「裝備分類」。
fn weapon_type(item_id: &str) -> Option<&'static str> {
    match id_prefix3(item_id) {
        130 => Some("oneHandedSword"),
        131 => Some("oneHandedAxe"),
        132 => Some("oneHandedBlunt"),
        133 => Some("dagger"),
        134 => Some("katara"),
        136 => Some("cane"),
        137 => Some("wand"),
        138 => Some("staff"),
        140 => Some("twoHandedSword"),
        141 => Some("twoHandedAxe"),
        142 => Some("twoHandedBlunt"),
        143 => Some("spear"),
        144 => Some("polearm"),
        145 => Some("bow"),
        146 => Some("crossbow"),
        147 => Some("claw"),
        148 => Some("knuckle"),
        149 => Some("gun"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn required_jobs_map_masks_and_fall_back_to_all() {
        assert_eq!(required_jobs(None), ALL_JOBS);
        assert_eq!(required_jobs(Some(0)), ALL_JOBS);
        assert_eq!(required_jobs(Some(1 | 8)), ["warrior", "thief"]);
        // 只有未知位元時視同無限制。
        assert_eq!(required_jobs(Some(64)), ALL_JOBS);
    }

    #[test]
    fn category_prefers_id_prefix_then_directory() {
        assert_eq!(gear_category("01302000", "Weapon"), "weapon");
        assert_eq!(weapon_type("01302000"), Some("oneHandedSword"));
        assert_eq!(gear_category("01002000", ""), "cap");
        assert_eq!(gear_category("01802000", "PetEquip"), "petEquip");
        assert_eq!(gear_category("00030000", ""), "hair");
        assert_eq!(weapon_type("01352000"), None);
    }
}
