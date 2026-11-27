//! tooltip 聚合驗證：對幾件代表裝備印出 ItemTooltip。
use msclassic::catalog::DataService;
use std::path::PathBuf;

const DEFAULT_DATA_DIR: &str =
    r"C:\Program Files\Gamania\maplestory_classic\Maplestory_Classic_Data\StreamingAssets\aa\w";

fn main() {
    let root = std::env::args()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(DEFAULT_DATA_DIR));
    let cache = std::env::temp_dir().join("msclassic_tt_probe.json");
    let (svc, _) = DataService::open(&root, &cache).expect("開啟失敗");
    for path in [
        "Character/Weapon/01302000",
        "Character/Coat/01040000/info/reqLevel",
        "Character/Accessory/01010000/info/iconRaw",
        "Character/Cap/01000000",
        "Character/Face/00020116/angry/0/face",
        "Map/Obj/login/0",
    ] {
        match svc.get_item_tooltip(path) {
            Ok(Some(tt)) => println!(
                "{path}\n  => id={} title={} gender={:?} cat={} weapon={:?} jobs={:?} attrs={:?} speed={:?} tuc={:?} stats={:?} icon={} desc={:?}\n",
                tt.item_id,
                tt.title,
                tt.req_gender,
                tt.category,
                tt.weapon_type,
                tt.required_jobs,
                tt.attributes,
                tt.attack_speed,
                tt.scroll_count,
                tt.stats.iter().map(|s| format!("{}={}", s.key, s.value)).collect::<Vec<_>>(),
                tt.icon_base64.map_or(0, |b| b.len()),
                tt.description,
            ),
            Ok(None) => println!("{path} => None\n"),
            Err(e) => println!("{path} => ERR {e}\n"),
        }
    }
}
