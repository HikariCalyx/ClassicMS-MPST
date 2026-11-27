//! Tauri GUI 入口與 command 註冊。
//!
//! `AppState` 只在切換資料集時取得寫鎖；成功開啟後，各 command 共用
//! `Arc<DataService>`。耗時的索引、解碼與匯出工作都在 blocking worker 執行，
//! 不會長時間持有全域 service lock。

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};

use serde::Serialize;
use tauri::{Manager, State};

use crate::avatar::{self, AvatarFrames, AvatarMeta, EquipItem};
use crate::catalog::{ChildEntry, DataService, NodeDetail, OpenInfo};
use crate::commodity::CommodityItem;
use crate::export::{ExportStats, FileExportResult};
use crate::item_tooltip::ItemTooltip;
use crate::monster::{MobDetail, MonsterSummary};
use crate::pet::{self, PetEquipInfo, PetInfo};
use crate::quest::{QuestDetail, QuestSummary};
use crate::skill::{SkillDetail, SkillJobGroup};

#[derive(Clone)]
pub struct AppState {
    service: Arc<RwLock<Option<Arc<DataService>>>>,
    open_gate: Arc<Mutex<()>>,
    cache_dir: PathBuf,
}

#[derive(Serialize)]
struct ImagePreviewResult {
    base64: String,
    mode: &'static str,
    note: Option<String>,
}

#[derive(Serialize)]
struct AudioResult {
    base64: String,
}

/// `open_data_dir` 的錯誤。使用者選錯資料夾時帶代碼，由前端依介面語言組字；
/// 其餘錯誤只有原始訊息（`code` 為 None）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenDataDirError {
    code: Option<&'static str>,
    path: Option<String>,
    message: String,
}

impl From<String> for OpenDataDirError {
    fn from(message: String) -> Self {
        Self {
            code: None,
            path: None,
            message,
        }
    }
}

impl AppState {
    /// `root` 為 None 時取目前開著的資料集；否則開啟已解析好的資料根目錄。
    fn current_or_open(&self, root: Option<&Path>) -> Result<(Arc<DataService>, OpenInfo), String> {
        let Some(root) = root else {
            if let Some(service) = self
                .service
                .read()
                .map_err(|error| error.to_string())?
                .as_ref()
                .cloned()
            {
                return Ok((service.clone(), open_info_for(&service)));
            }
            return Err("尚未選擇遊戲資料目錄".into());
        };

        // 開檔不持有 service RwLock；gate 只防止多個 command 同時重建相同索引。
        let _gate = self.open_gate.lock().map_err(|error| error.to_string())?;

        if let Some(service) = self.current_matching(root)? {
            return Ok((service.clone(), open_info_for(&service)));
        }

        let cache_path = self.cache_path_for(root);
        let (service, info) =
            DataService::open(root, &cache_path).map_err(|error| error.to_string())?;
        let service = Arc::new(service);
        *self.service.write().map_err(|error| error.to_string())? = Some(service.clone());
        Ok((service, info))
    }

    fn current_matching(&self, requested: &Path) -> Result<Option<Arc<DataService>>, String> {
        let current = self.service.read().map_err(|error| error.to_string())?;
        let Some(service) = current.as_ref() else {
            return Ok(None);
        };

        let normalized =
            std::fs::canonicalize(requested).unwrap_or_else(|_| requested.to_path_buf());
        Ok((service.catalog.root == normalized).then(|| service.clone()))
    }

    fn cache_path_for(&self, root: &Path) -> PathBuf {
        let mut hash = 0xcbf2_9ce4_8422_2325_u64;
        for byte in root.to_string_lossy().as_bytes() {
            hash ^= u64::from(*byte);
            hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
        }
        self.cache_dir.join(format!("catalog-{hash:016x}.json"))
    }
}

fn resolve_data_root(selected: &Path) -> Result<PathBuf, OpenDataDirError> {
    let candidates = [
        selected.to_path_buf(),
        selected.join("w"),
        selected.join("aa").join("w"),
        selected.join("StreamingAssets").join("aa").join("w"),
        selected
            .join("Maplestory_Classic_Data")
            .join("StreamingAssets")
            .join("aa")
            .join("w"),
    ];

    for candidate in candidates {
        if contains_bundle(&candidate) {
            return std::fs::canonicalize(&candidate).map_err(|error| {
                format!("資料目錄 {} 無法開啟: {error}", candidate.display()).into()
            });
        }
    }

    Err(OpenDataDirError {
        code: Some("noBundles"),
        path: Some(selected.display().to_string()),
        message: format!(
            "選取的目錄找不到 *.bundle。請選擇遊戲安裝目錄、Maplestory_Classic_Data，或 StreamingAssets\\aa\\w：{}",
            selected.display()
        ),
    })
}

fn contains_bundle(path: &Path) -> bool {
    std::fs::read_dir(path).is_ok_and(|entries| {
        entries.filter_map(Result::ok).any(|entry| {
            entry
                .path()
                .extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(|extension| extension.eq_ignore_ascii_case("bundle"))
        })
    })
}

fn open_info_for(service: &DataService) -> OpenInfo {
    OpenInfo {
        from_cache: true,
        elapsed_ms: 0,
        entry_count: service.catalog.entries.len(),
        bundle_count: service.catalog.bundles.len(),
        locale: service.locale().to_owned(),
        locales: service.locales.clone(),
    }
}

async fn blocking<T, F>(work: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|error| format!("背景工作失敗: {error}"))?
}

#[derive(Debug, Serialize)]
pub struct OpenResult {
    pub info: OpenInfo,
    pub top: Vec<ChildEntry>,
    pub data_dir: String,
}

#[tauri::command]
async fn open_data_dir(
    path: Option<String>,
    state: State<'_, AppState>,
) -> Result<OpenResult, OpenDataDirError> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<OpenResult, OpenDataDirError> {
        let root = path
            .as_deref()
            .map(|path| resolve_data_root(Path::new(path)))
            .transpose()?;
        let (service, info) = state.current_or_open(root.as_deref())?;
        let top = service
            .list_children("")
            .map_err(|error| error.to_string())?;
        Ok(OpenResult {
            info,
            top,
            data_dir: service.catalog.root.display().to_string(),
        })
    })
    .await
    .map_err(|error| OpenDataDirError::from(format!("背景工作失敗: {error}")))?
}

#[tauri::command]
async fn list_children(
    path: String,
    state: State<'_, AppState>,
) -> Result<Vec<ChildEntry>, String> {
    let state = state.inner().clone();
    blocking(move || {
        let (service, _) = state.current_or_open(None)?;
        service
            .list_children(&path)
            .map_err(|error| error.to_string())
    })
    .await
}

#[tauri::command]
async fn get_node(path: String, state: State<'_, AppState>) -> Result<NodeDetail, String> {
    let state = state.inner().clone();
    blocking(move || {
        let (service, _) = state.current_or_open(None)?;
        service.get_node(&path).map_err(|error| error.to_string())
    })
    .await
}

#[tauri::command]
async fn get_image(
    path: String,
    state: State<'_, AppState>,
) -> Result<Option<ImagePreviewResult>, String> {
    use base64::Engine;

    let state = state.inner().clone();
    blocking(move || {
        let (service, _) = state.current_or_open(None)?;
        match service.get_image(&path) {
            Ok(Some(bytes)) => Ok(Some(ImagePreviewResult {
                base64: base64::engine::general_purpose::STANDARD.encode(bytes),
                mode: "exact",
                note: None,
            })),
            Ok(None) => Ok(None),
            Err(error) => {
                let note = error.to_string();
                match service.get_canvas_atlas_fallback(&path) {
                    Ok(Some(bytes)) => Ok(Some(ImagePreviewResult {
                        base64: base64::engine::general_purpose::STANDARD.encode(bytes),
                        mode: "atlas",
                        note: Some(note),
                    })),
                    Ok(None) => Err(note),
                    Err(fallback_error) => {
                        Err(format!("{note}；atlas fallback 也失敗：{fallback_error}"))
                    }
                }
            }
        }
    })
    .await
}

/// 取聲音：回 Ogg Vorbis 的 base64（與 get_image 同模式）。
#[tauri::command]
async fn get_audio(path: String, state: State<'_, AppState>) -> Result<AudioResult, String> {
    use base64::Engine;

    let state = state.inner().clone();
    blocking(move || {
        let (service, _) = state.current_or_open(None)?;
        let bytes = service
            .get_audio(&path)
            .map_err(|error| error.to_string())?;
        Ok(AudioResult {
            base64: base64::engine::general_purpose::STANDARD.encode(bytes),
        })
    })
    .await
}

#[tauri::command]
async fn get_item_tooltip(
    path: String,
    state: State<'_, AppState>,
) -> Result<Option<ItemTooltip>, String> {
    let state = state.inner().clone();
    blocking(move || {
        let (service, _) = state.current_or_open(None)?;
        service
            .get_item_tooltip(&path)
            .map_err(|error| error.to_string())
    })
    .await
}

/// 以道具 id 取裝備 tooltip：怪物圖鑑戰利品 hover 用，資料集缺此裝備時回 None。
#[tauri::command]
async fn get_item_tooltip_by_id(
    item_id: u32,
    state: State<'_, AppState>,
) -> Result<Option<ItemTooltip>, String> {
    let state = state.inner().clone();
    blocking(move || {
        let (service, _) = state.current_or_open(None)?;
        service
            .get_item_tooltip_by_id(item_id)
            .map_err(|error| error.to_string())
    })
    .await
}

/// 商城商品清單（Etc/TW/Commodity）：名稱與 icon 由後端聚合，一次拿完。
#[tauri::command]
async fn get_commodity_items(state: State<'_, AppState>) -> Result<Vec<CommodityItem>, String> {
    let state = state.inner().clone();
    blocking(move || {
        let (service, _) = state.current_or_open(None)?;
        service
            .get_commodity_items()
            .map_err(|error| error.to_string())
    })
    .await
}

/// 紙娃娃基本資料：body 動作清單 + 膚色清單。
#[tauri::command]
async fn get_avatar_meta(state: State<'_, AppState>) -> Result<AvatarMeta, String> {
    let state = state.inner().clone();
    blocking(move || {
        let (service, _) = state.current_or_open(None)?;
        avatar::avatar_meta(&service).map_err(|error| error.to_string())
    })
    .await
}

/// 指定臉型的表情清單。
#[tauri::command]
async fn get_avatar_emotions(
    face_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<String>, String> {
    let state = state.inner().clone();
    blocking(move || {
        let (service, _) = state.current_or_open(None)?;
        avatar::avatar_emotions(&service, &face_id).map_err(|error| error.to_string())
    })
    .await
}

/// 全裝備清單（id / 名稱 / slot / icon 路徑）。
#[tauri::command]
async fn get_avatar_equipment(state: State<'_, AppState>) -> Result<Vec<EquipItem>, String> {
    let state = state.inner().clone();
    blocking(move || {
        let (service, _) = state.current_or_open(None)?;
        avatar::avatar_equipment(&service).map_err(|error| error.to_string())
    })
    .await
}

/// 合成紙娃娃一個動作的幀圖層（身體幀 + 表情幀）。
/// `hair_cover` = 「帽子遮髮」核取方塊（有戴帽才生效）。
/// `hair_shade` = 「髮型陰影」核取方塊（不勾 → 藏 hairShade 層）。
#[tauri::command]
async fn get_avatar_frames(
    parts: Vec<avatar::PartInput>,
    action: String,
    emotion: String,
    hair_cover: bool,
    hair_shade: bool,
    state: State<'_, AppState>,
) -> Result<AvatarFrames, String> {
    let state = state.inner().clone();
    blocking(move || {
        let (service, _) = state.current_or_open(None)?;
        avatar::avatar_frames(&service, parts, &action, &emotion, hair_cover, hair_shade)
            .map_err(|error| error.to_string())
    })
    .await
}

/// 寵物清單（Item/Pet）：名稱、icon 路徑與動作清單由後端聚合，一次拿完。
#[tauri::command]
async fn get_pet_list(state: State<'_, AppState>) -> Result<Vec<PetInfo>, String> {
    let state = state.inner().clone();
    blocking(move || {
        let (service, _) = state.current_or_open(None)?;
        pet::pet_list(&service).map_err(|error| error.to_string())
    })
    .await
}

/// 寵物裝備清單（Character/PetEquip）：名稱、icon 路徑與支援寵物 id。
#[tauri::command]
async fn get_pet_equip_list(state: State<'_, AppState>) -> Result<Vec<PetEquipInfo>, String> {
    let state = state.inner().clone();
    blocking(move || {
        let (service, _) = state.current_or_open(None)?;
        pet::pet_equip_list(&service).map_err(|error| error.to_string())
    })
    .await
}

/// 合成寵物一個動作的幀圖層（寵物幀 + 寵裝幀，`equip_id` 為 None 表示不穿寵裝）。
#[tauri::command]
async fn get_pet_frames(
    pet_id: String,
    equip_id: Option<String>,
    action: String,
    state: State<'_, AppState>,
) -> Result<AvatarFrames, String> {
    let state = state.inner().clone();
    blocking(move || {
        let (service, _) = state.current_or_open(None)?;
        pet::pet_frames(&service, &pet_id, equip_id.as_deref(), &action)
            .map_err(|error| error.to_string())
    })
    .await
}

/// 怪物圖鑑清單（MonsterBook）：名稱、等級與掉落物 id/名稱由後端聚合，一次拿完。
#[tauri::command]
async fn get_monster_book(state: State<'_, AppState>) -> Result<Vec<MonsterSummary>, String> {
    let state = state.inner().clone();
    blocking(move || {
        let (service, _) = state.current_or_open(None)?;
        service
            .get_monster_book()
            .map(|book| (*book).clone())
            .map_err(|error| error.to_string())
    })
    .await
}

/// 單一怪物明細：能力值、動畫幀、掉落物 icon、出沒地圖與圖鑑文字。
#[tauri::command]
async fn get_mob_detail(mob_id: u32, state: State<'_, AppState>) -> Result<MobDetail, String> {
    let state = state.inner().clone();
    blocking(move || {
        let (service, _) = state.current_or_open(None)?;
        service
            .get_mob_detail(mob_id)
            .map_err(|error| error.to_string())
    })
    .await
}

/// 技能瀏覽器清單（Skill/*）：各職業的技能 id/名稱/最高等級由後端聚合，一次拿完。
#[tauri::command]
async fn get_skill_book(state: State<'_, AppState>) -> Result<Vec<SkillJobGroup>, String> {
    let state = state.inner().clone();
    blocking(move || {
        let (service, _) = state.current_or_open(None)?;
        service
            .get_skill_book()
            .map(|book| (*book).clone())
            .map_err(|error| error.to_string())
    })
    .await
}

/// 單一技能明細：名稱/說明、動作與延遲、每級數值 props。
#[tauri::command]
async fn get_skill_detail(
    job: String,
    skill_id: String,
    state: State<'_, AppState>,
) -> Result<SkillDetail, String> {
    let state = state.inner().clone();
    blocking(move || {
        let (service, _) = state.current_or_open(None)?;
        service
            .get_skill_detail(&job, &skill_id)
            .map_err(|error| error.to_string())
    })
    .await
}

/// 任務清單（QuestData）：名稱/系列/地區/等級範圍/起始 NPC/後續任務由後端聚合，一次拿完。
#[tauri::command]
async fn get_quest_book(state: State<'_, AppState>) -> Result<Vec<QuestSummary>, String> {
    let state = state.inner().clone();
    blocking(move || {
        let (service, _) = state.current_or_open(None)?;
        service
            .get_quest_book()
            .map(|book| (*book).clone())
            .map_err(|error| error.to_string())
    })
    .await
}

/// 單一任務明細：對話腳本、需求與獎勵。
#[tauri::command]
async fn get_quest_detail(
    quest_id: String,
    state: State<'_, AppState>,
) -> Result<QuestDetail, String> {
    let state = state.inner().clone();
    blocking(move || {
        let (service, _) = state.current_or_open(None)?;
        service
            .get_quest_detail(&quest_id)
            .map_err(|error| error.to_string())
    })
    .await
}

/// BGM → 地圖反查索引（音樂播放器頁）：每首 BGM 對應使用它的地圖清單。
#[tauri::command]
async fn get_map_bgm_index(
    state: State<'_, AppState>,
) -> Result<Vec<crate::sound::BgmMapGroup>, String> {
    let state = state.inner().clone();
    blocking(move || {
        let (service, _) = state.current_or_open(None)?;
        service
            .get_map_bgm_index()
            .map(|index| (*index).clone())
            .map_err(|error| error.to_string())
    })
    .await
}

#[tauri::command]
async fn search_nodes(
    query: String,
    scope: Option<String>,
    limit: Option<usize>,
    state: State<'_, AppState>,
) -> Result<Vec<crate::search::SearchHit>, String> {
    let state = state.inner().clone();
    blocking(move || {
        let (service, _) = state.current_or_open(None)?;
        Ok(service.search_hits(&query, scope.as_deref(), limit.unwrap_or(200).min(2_000)))
    })
    .await
}

#[tauri::command]
async fn export_subtree(path: String, state: State<'_, AppState>) -> Result<ExportStats, String> {
    let state = state.inner().clone();
    blocking(move || {
        let (service, _) = state.current_or_open(None)?;
        let out_root = state.cache_dir.join("exports");
        service
            .export_subtree(&path, &out_root)
            .map_err(|error| error.to_string())
    })
    .await
}

#[tauri::command]
async fn export_file(
    path: String,
    format: String,
    output_path: String,
    state: State<'_, AppState>,
) -> Result<FileExportResult, String> {
    let state = state.inner().clone();
    blocking(move || {
        let (service, _) = state.current_or_open(None)?;
        service
            .export_file(&path, Path::new(&output_path), &format)
            .map_err(|error| error.to_string())
    })
    .await
}

/// 切換作用中的語系代碼（資料集含多個語系時，前端下拉選單用）。
#[tauri::command]
async fn set_region(code: String, state: State<'_, AppState>) -> Result<(), String> {
    let state = state.inner().clone();
    blocking(move || {
        let mut current = state.service.write().map_err(|error| error.to_string())?;
        let service = current.as_ref().ok_or("尚未選擇遊戲資料目錄")?;
        if service.locale() != code {
            *current = Some(Arc::new(
                service
                    .with_locale(&code)
                    .map_err(|error| error.to_string())?,
            ));
        }
        Ok(())
    })
    .await
}

#[tauri::command]
fn initial_path() -> Option<String> {
    std::env::var("MSCLASSIC_INITIAL_PATH")
        .ok()
        .filter(|path| !path.is_empty())
}

/// 自動化測試用：啟動時直接切到的 view（tree / avatar / monster）。
#[tauri::command]
fn initial_view() -> Option<String> {
    std::env::var("MSCLASSIC_INITIAL_VIEW")
        .ok()
        .filter(|view| !view.is_empty())
}

/// 自動化測試用：啟動時直接開啟的資料目錄（略過資料夾選擇器）。
#[tauri::command]
fn initial_data_dir() -> Option<String> {
    std::env::var("MSCLASSIC_DATA_DIR")
        .ok()
        .filter(|path| !path.is_empty())
}

/// 前端 canvas 產生的圖檔（base64）寫到使用者從另存對話框選的路徑。
#[tauri::command]
async fn write_binary_file(output_path: String, base64: String) -> Result<(), String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(base64)
        .map_err(|error| error.to_string())?;
    blocking(move || std::fs::write(&output_path, &bytes).map_err(|error| error.to_string())).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let cache_dir = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| std::env::temp_dir().join("msclassic"));
            app.manage(AppState {
                service: Arc::new(RwLock::new(None)),
                open_gate: Arc::new(Mutex::new(())),
                cache_dir,
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            open_data_dir,
            list_children,
            get_node,
            get_image,
            get_audio,
            get_item_tooltip,
            get_item_tooltip_by_id,
            get_commodity_items,
            get_avatar_meta,
            get_avatar_emotions,
            get_avatar_equipment,
            get_avatar_frames,
            get_pet_list,
            get_pet_equip_list,
            get_pet_frames,
            get_monster_book,
            get_mob_detail,
            get_skill_book,
            get_skill_detail,
            get_quest_book,
            get_quest_detail,
            get_map_bgm_index,
            search_nodes,
            set_region,
            export_subtree,
            export_file,
            initial_path,
            initial_view,
            initial_data_dir,
            write_binary_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
